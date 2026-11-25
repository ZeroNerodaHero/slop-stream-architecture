use std::any::Any;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::track::track_local::{TrackLocal, TrackLocalContext, TrackLocalWriter};

use tokio::sync::Notify;

use crate::resend::Resend;
use crate::simulcast::{rewrite_payload, start_level, Codec, Frame, LayerView, Rewrite, LEVELS, NO_LEVEL};
use crate::view::View;

const LIVE_WITHIN: Duration = Duration::from_millis(1000);
const METER_WINDOW: Duration = Duration::from_millis(500);
const CACHED_PAYLOADS: usize = 4;
const EARLY_PACKETS: usize = 600;
const EARLY_BYTES: usize = 768 * 1024;

#[derive(Default)]
pub struct Layer {
    ssrc: AtomicU32,
    last_ms: AtomicU64,
    bps: AtomicU64,
    height: AtomicU32,
    pub keyframes: AtomicU64,
}

pub struct Feed {
    epoch: Instant,
    codec: Codec,
    offered: u8,
    layers: [Layer; LEVELS],
    viewers: RwLock<Arc<[Arc<Viewer>]>>,
}

pub struct Meter {
    since: Instant,
    bytes: u64,
}

impl Meter {
    pub fn new(now: Instant) -> Self {
        Self { since: now, bytes: 0 }
    }
}

impl Feed {
    pub fn new(codec: Codec, offered: u8) -> Self {
        Self { epoch: Instant::now(), codec, offered, layers: Default::default(), viewers: RwLock::new(Arc::from(Vec::new())) }
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }

    pub fn has_full_viewers(&self) -> bool {
        self.viewers.read().unwrap_or_else(|e| e.into_inner()).iter().any(|v| !v.preview && v.view() == View::Full)
    }

    pub fn offered(&self) -> u8 {
        self.offered
    }

    pub fn layer(&self, level: u8) -> &Layer {
        &self.layers[level as usize]
    }

    pub fn ssrc(&self, level: u8) -> Option<u32> {
        Some(self.layers.get(level as usize)?.ssrc.load(Ordering::Relaxed)).filter(|s| *s != 0)
    }

    pub fn bind(&self, level: u8, ssrc: u32) {
        let layer = &self.layers[level as usize];
        layer.ssrc.store(ssrc, Ordering::Relaxed);
        layer.last_ms.store(0, Ordering::Relaxed);
        layer.bps.store(0, Ordering::Relaxed);
    }

    fn ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.epoch).as_millis() as u64 + 1
    }

    pub fn views(&self, now: Instant) -> [LayerView; LEVELS] {
        let now_ms = self.ms(now);
        std::array::from_fn(|i| {
            let layer = &self.layers[i];
            let last = layer.last_ms.load(Ordering::Relaxed);
            LayerView {
                live: layer.ssrc.load(Ordering::Relaxed) != 0 && last != 0 && now_ms.saturating_sub(last) <= LIVE_WITHIN.as_millis() as u64,
                bps: layer.bps.load(Ordering::Relaxed),
                height: layer.height.load(Ordering::Relaxed),
            }
        })
    }

    pub fn start_level(&self, pinned: bool) -> u8 {
        start_level(&self.views(Instant::now()), self.offered, pinned)
    }

    pub fn arrived(&self, level: u8, size: usize, frame: &Frame, meter: &mut Meter, now: Instant) {
        let layer = &self.layers[level as usize];
        layer.last_ms.store(self.ms(now), Ordering::Relaxed);
        if frame.keyframe {
            layer.keyframes.fetch_add(1, Ordering::Relaxed);
            if let Some((_, height)) = frame.size {
                layer.height.store(u32::from(height), Ordering::Relaxed);
            }
        }
        meter.bytes += size as u64;
        let span = now.saturating_duration_since(meter.since);
        if span >= METER_WINDOW {
            let sample = meter.bytes * 8_000 / (span.as_millis() as u64).max(1);
            let old = layer.bps.load(Ordering::Relaxed);
            let next = if old == 0 { sample } else { (old * 3 + sample) / 4 };
            layer.bps.store(next, Ordering::Relaxed);
            *meter = Meter::new(now);
        }
    }

    pub fn switched_after(&self, viewer: &Viewer, since: Instant) -> Duration {
        Duration::from_millis(viewer.switched_ms.load(Ordering::Relaxed).saturating_sub(self.ms(since)))
    }

    pub fn join(&self, viewer: Arc<Viewer>) {
        let mut viewers = self.viewers.write().unwrap_or_else(|e| e.into_inner());
        let mut next: Vec<Arc<Viewer>> = viewers.iter().cloned().collect();
        next.push(viewer);
        *viewers = next.into();
    }

    pub fn leave(&self, viewer: &Arc<Viewer>) {
        let mut viewers = self.viewers.write().unwrap_or_else(|e| e.into_inner());
        let next: Vec<Arc<Viewer>> = viewers.iter().filter(|v| !Arc::ptr_eq(v, viewer)).cloned().collect();
        *viewers = next.into();
    }

    pub async fn forward(&self, level: u8, packet: &Packet, frame: &Frame, now: Instant) -> usize {
        let viewers = Arc::clone(&self.viewers.read().unwrap_or_else(|e| e.into_inner()));
        if viewers.is_empty() {
            return 0;
        }
        let h = &packet.header;
        let header = Header { version: h.version, padding: h.padding, marker: h.marker, payload_type: h.payload_type, sequence_number: h.sequence_number, timestamp: h.timestamp, ssrc: h.ssrc, ..Header::default() };
        let mut out = Packet { header, payload: packet.payload.clone() };
        let mut cache: [Option<(u16, u8, bytes::Bytes)>; CACHED_PAYLOADS] = Default::default();
        let mut written = 0;
        for viewer in viewers.iter() {
            let target = viewer.target.load(Ordering::Relaxed);
            let admit = {
                let mut rewrite = viewer.rewrite.lock().unwrap_or_else(|e| e.into_inner());
                let admit = rewrite.admit(level, target, packet.header.sequence_number, packet.header.timestamp, frame, now);
                if admit.is_some_and(|a| a.switched) {
                    viewer.current.store(level, Ordering::Relaxed);
                    viewer.switched_ms.store(self.ms(now), Ordering::Relaxed);
                }
                admit
            };
            let Some(admit) = admit else { continue };
            out.header.sequence_number = admit.seq;
            out.header.timestamp = admit.ts;
            out.payload = if admit.pid_off == 0 && admit.tl0_off == 0 {
                packet.payload.clone()
            } else {
                cached(&mut cache, &packet.payload, frame, admit.pid_off, admit.tl0_off)
            };
            let n = viewer.track.write(&mut out, admit.switched).await;
            if n > 0 {
                viewer.sent.fetch_add(1, Ordering::Relaxed);
                written += n;
            }
        }
        written
    }
}

fn cached(cache: &mut [Option<(u16, u8, bytes::Bytes)>; CACHED_PAYLOADS], payload: &bytes::Bytes, frame: &Frame, pid_off: u16, tl0_off: u8) -> bytes::Bytes {
    if let Some((_, _, bytes)) = cache.iter().flatten().find(|(p, t, _)| *p == pid_off && *t == tl0_off) {
        return bytes.clone();
    }
    let bytes = rewrite_payload(payload, frame, pid_off, tl0_off);
    if let Some(free) = cache.iter_mut().find(|c| c.is_none()) {
        *free = Some((pid_off, tl0_off, bytes.clone()));
    }
    bytes
}

pub struct Viewer {
    pub track: Arc<ViewerTrack>,
    preview: bool,
    target: AtomicU8,
    current: AtomicU8,
    sent: AtomicU64,
    switched_ms: AtomicU64,
    rewrite: Mutex<Rewrite>,
    view: AtomicU8,
    woken: Notify,
}

impl Viewer {
    pub fn new(track: Arc<ViewerTrack>, start: u8, preview: bool) -> Self {
        Self {
            track,
            preview,
            target: AtomicU8::new(start),
            current: AtomicU8::new(NO_LEVEL),
            sent: AtomicU64::new(0),
            switched_ms: AtomicU64::new(0),
            rewrite: Mutex::new(Rewrite::default()),
            view: AtomicU8::new(View::Full.code()),
            woken: Notify::new(),
        }
    }

    pub fn want_view(&self, view: View) {
        self.view.store(view.code(), Ordering::Relaxed);
        self.woken.notify_one();
    }

    pub fn view(&self) -> View {
        View::from_code(self.view.load(Ordering::Relaxed))
    }

    pub async fn view_changed(&self) {
        self.woken.notified().await
    }

    pub fn pause(&self) {
        let mut rewrite = self.rewrite.lock().unwrap_or_else(|e| e.into_inner());
        rewrite.pause();
        self.current.store(NO_LEVEL, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.rewrite.lock().unwrap_or_else(|e| e.into_inner()).resume();
    }

    pub fn target(&self) -> u8 {
        self.target.load(Ordering::Relaxed)
    }

    pub fn set_target(&self, level: u8) {
        self.target.store(level, Ordering::Relaxed);
    }

    pub fn current(&self) -> Option<u8> {
        Some(self.current.load(Ordering::Relaxed)).filter(|l| *l != NO_LEVEL)
    }

    pub fn sent(&self) -> u64 {
        self.sent.load(Ordering::Relaxed)
    }
}

struct Bound {
    ssrc: u32,
    payload_type: u8,
    writer: Arc<dyn TrackLocalWriter + Send + Sync>,
}

#[derive(Default)]
struct Early {
    held: Vec<Packet>,
    bytes: usize,
    spilled: bool,
}

pub struct ViewerTrack {
    id: String,
    stream_id: String,
    codec: RTCRtpCodecCapability,
    bound: Mutex<Option<Bound>>,
    resend: Arc<Resend>,
    floor: AtomicU32,
    ready: AtomicBool,
    early: Mutex<Early>,
}

impl ViewerTrack {
    pub fn new(codec: RTCRtpCodecCapability, id: String, stream_id: String, resend: Arc<Resend>) -> Self {
        Self { id, stream_id, codec, bound: Mutex::new(None), resend, floor: AtomicU32::new(u32::MAX), ready: AtomicBool::new(false), early: Mutex::new(Early::default()) }
    }

    pub fn holds_picture(&self) -> bool {
        self.ready.load(Ordering::Relaxed) || !self.early.lock().unwrap_or_else(|e| e.into_inner()).held.is_empty()
    }

    fn hold(&self, packet: &Packet) {
        let mut early = self.early.lock().unwrap_or_else(|e| e.into_inner());
        if early.spilled {
            return;
        }
        early.bytes += packet.payload.len();
        if early.held.len() >= EARLY_PACKETS || early.bytes > EARLY_BYTES {
            *early = Early { spilled: true, ..Early::default() };
            return;
        }
        early.held.push(packet.clone());
    }

    async fn deliver(&self, writer: &Arc<dyn TrackLocalWriter + Send + Sync>, packet: &Packet) -> usize {
        if self.ready.load(Ordering::Relaxed) {
            return writer.write_rtp(packet).await.unwrap_or(0);
        }
        let held = std::mem::take(&mut self.early.lock().unwrap_or_else(|e| e.into_inner()).held);
        let Some(first) = held.first() else {
            let n = writer.write_rtp(packet).await.unwrap_or(0);
            if n > 0 {
                self.ready.store(true, Ordering::Relaxed);
            } else {
                self.hold(packet);
            }
            return n;
        };
        let n = writer.write_rtp(first).await.unwrap_or(0);
        if n == 0 {
            let mut early = self.early.lock().unwrap_or_else(|e| e.into_inner());
            let later = std::mem::replace(&mut early.held, held);
            early.held.extend(later);
            drop(early);
            self.hold(packet);
            return 0;
        }
        self.ready.store(true, Ordering::Relaxed);
        let mut written = n;
        for held in &held[1..] {
            written += writer.write_rtp(held).await.unwrap_or(0);
        }
        written + writer.write_rtp(packet).await.unwrap_or(0)
    }

    pub fn codec(&self) -> &RTCRtpCodecCapability {
        &self.codec
    }

    pub fn floor(&self) -> Option<u16> {
        u16::try_from(self.floor.load(Ordering::Relaxed)).ok()
    }

    pub fn ssrc(&self) -> Option<u32> {
        self.bound.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|b| b.ssrc)
    }

    async fn write(&self, packet: &mut Packet, switched: bool) -> usize {
        let writer = {
            let bound = self.bound.lock().unwrap_or_else(|e| e.into_inner());
            match bound.as_ref() {
                Some(b) => {
                    packet.header.ssrc = b.ssrc;
                    packet.header.payload_type = b.payload_type;
                    Arc::clone(&b.writer)
                }
                _ => return 0,
            }
        };
        if switched {
            self.floor.store(u32::from(packet.header.sequence_number), Ordering::Relaxed);
            self.resend.floor(packet.header.ssrc, packet.header.sequence_number);
            if !self.ready.load(Ordering::Relaxed) {
                *self.early.lock().unwrap_or_else(|e| e.into_inner()) = Early::default();
            }
        }
        self.deliver(&writer, packet).await
    }
}

#[async_trait]
impl TrackLocal for ViewerTrack {
    async fn bind(&self, t: &TrackLocalContext) -> webrtc::error::Result<RTCRtpCodecParameters> {
        let codec = t
            .codec_parameters()
            .iter()
            .find(|c| c.capability.mime_type.eq_ignore_ascii_case(&self.codec.mime_type))
            .cloned()
            .ok_or(webrtc::Error::ErrUnsupportedCodec)?;
        *self.bound.lock().unwrap_or_else(|e| e.into_inner()) = Some(Bound { ssrc: t.ssrc(), payload_type: codec.payload_type, writer: t.write_stream() });
        Ok(codec)
    }

    async fn unbind(&self, _: &TrackLocalContext) -> webrtc::error::Result<()> {
        *self.bound.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    fn id(&self) -> &str {
        &self.id
    }

    fn rid(&self) -> Option<&str> {
        None
    }

    fn stream_id(&self) -> &str {
        &self.stream_id
    }

    fn kind(&self) -> RTPCodecType {
        RTPCodecType::Video
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webrtc::interceptor::Attributes;

    #[derive(Debug, Default)]
    struct Gate {
        open: AtomicBool,
        got: Mutex<Vec<u16>>,
    }

    #[async_trait]
    impl TrackLocalWriter for Gate {
        async fn write_rtp_with_attributes(&self, pkt: &Packet, _: &Attributes) -> webrtc::error::Result<usize> {
            if !self.open.load(Ordering::Relaxed) {
                return Ok(0);
            }
            self.got.lock().unwrap().push(pkt.header.sequence_number);
            Ok(pkt.payload.len() + 12)
        }

        async fn write(&self, _: &[u8]) -> webrtc::error::Result<usize> {
            Ok(0)
        }
    }

    fn bound_track(gate: &Arc<Gate>) -> ViewerTrack {
        let track = ViewerTrack::new(crate::media::vp8_capability(), "v".to_owned(), "s".to_owned(), Arc::new(Resend::default()));
        *track.bound.lock().unwrap() = Some(Bound { ssrc: 7, payload_type: 96, writer: Arc::clone(gate) as _ });
        track
    }

    fn packet(seq: u16, bytes: usize) -> Packet {
        Packet { header: Header { sequence_number: seq, ..Header::default() }, payload: bytes::Bytes::from(vec![0u8; bytes]) }
    }

    #[tokio::test]
    async fn packets_before_srtp_is_up_are_held_and_flushed_in_order() {
        let gate = Arc::new(Gate::default());
        let track = bound_track(&gate);
        assert!(!track.holds_picture());
        assert_eq!(track.write(&mut packet(10, 100), true).await, 0);
        assert_eq!(track.write(&mut packet(11, 100), false).await, 0);
        assert!(track.holds_picture());
        gate.open.store(true, Ordering::Relaxed);
        assert_eq!(track.write(&mut packet(12, 100), false).await, 3 * 112);
        assert_eq!(track.write(&mut packet(13, 100), false).await, 112);
        assert_eq!(*gate.got.lock().unwrap(), vec![10, 11, 12, 13]);
        assert!(track.holds_picture());
    }

    #[tokio::test]
    async fn a_new_keyframe_before_srtp_replaces_what_was_held() {
        let gate = Arc::new(Gate::default());
        let track = bound_track(&gate);
        track.write(&mut packet(10, 100), true).await;
        track.write(&mut packet(11, 100), false).await;
        track.write(&mut packet(500, 100), true).await;
        gate.open.store(true, Ordering::Relaxed);
        track.write(&mut packet(501, 100), false).await;
        assert_eq!(*gate.got.lock().unwrap(), vec![500, 501]);
    }

    #[tokio::test]
    async fn too_much_before_srtp_is_dropped_and_then_holds_nothing() {
        let gate = Arc::new(Gate::default());
        let track = bound_track(&gate);
        track.write(&mut packet(0, 1200), true).await;
        for seq in 1..=EARLY_PACKETS as u16 {
            track.write(&mut packet(seq, 1200), false).await;
        }
        assert!(!track.holds_picture());
        gate.open.store(true, Ordering::Relaxed);
        track.write(&mut packet(9000, 100), false).await;
        assert_eq!(*gate.got.lock().unwrap(), vec![9000]);
    }

    #[tokio::test]
    async fn an_unbound_track_holds_nothing() {
        let track = ViewerTrack::new(crate::media::vp8_capability(), "v".to_owned(), "s".to_owned(), Arc::new(Resend::default()));
        assert_eq!(track.write(&mut packet(1, 100), true).await, 0);
        assert!(!track.holds_picture());
    }
}
