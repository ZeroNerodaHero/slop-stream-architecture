use std::any::Any;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::track::track_local::{TrackLocal, TrackLocalContext, TrackLocalWriter};

use tokio::sync::Notify;

use crate::resend::Resend;
use crate::simulcast::{rewrite_payload, start_level, LayerView, Rewrite, Vp8, LEVELS, NO_LEVEL};
use crate::view::View;

const LIVE_WITHIN: Duration = Duration::from_millis(1000);
const METER_WINDOW: Duration = Duration::from_millis(500);
const CACHED_PAYLOADS: usize = 4;

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
    pub fn new(offered: u8) -> Self {
        Self { epoch: Instant::now(), offered, layers: Default::default(), viewers: RwLock::new(Arc::from(Vec::new())) }
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

    pub fn arrived(&self, level: u8, size: usize, vp8: &Vp8, meter: &mut Meter, now: Instant) {
        let layer = &self.layers[level as usize];
        layer.last_ms.store(self.ms(now), Ordering::Relaxed);
        if vp8.keyframe {
            layer.keyframes.fetch_add(1, Ordering::Relaxed);
            if let Some((_, height)) = vp8.size {
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

    pub async fn forward(&self, level: u8, packet: &Packet, vp8: &Vp8, now: Instant) -> usize {
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
                let admit = rewrite.admit(level, target, packet.header.sequence_number, packet.header.timestamp, vp8, now);
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
                cached(&mut cache, &packet.payload, vp8, admit.pid_off, admit.tl0_off)
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

fn cached(cache: &mut [Option<(u16, u8, bytes::Bytes)>; CACHED_PAYLOADS], payload: &bytes::Bytes, vp8: &Vp8, pid_off: u16, tl0_off: u8) -> bytes::Bytes {
    if let Some((_, _, bytes)) = cache.iter().flatten().find(|(p, t, _)| *p == pid_off && *t == tl0_off) {
        return bytes.clone();
    }
    let bytes = rewrite_payload(payload, vp8, pid_off, tl0_off);
    if let Some(free) = cache.iter_mut().find(|c| c.is_none()) {
        *free = Some((pid_off, tl0_off, bytes.clone()));
    }
    bytes
}

pub struct Viewer {
    pub track: Arc<ViewerTrack>,
    target: AtomicU8,
    current: AtomicU8,
    sent: AtomicU64,
    switched_ms: AtomicU64,
    rewrite: Mutex<Rewrite>,
    view: AtomicU8,
    woken: Notify,
}

impl Viewer {
    pub fn new(track: Arc<ViewerTrack>, start: u8) -> Self {
        Self {
            track,
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

pub struct ViewerTrack {
    id: String,
    stream_id: String,
    codec: RTCRtpCodecCapability,
    bound: Mutex<Option<Bound>>,
    resend: Arc<Resend>,
    floor: AtomicU32,
}

impl ViewerTrack {
    pub fn new(codec: RTCRtpCodecCapability, id: String, stream_id: String, resend: Arc<Resend>) -> Self {
        Self { id, stream_id, codec, bound: Mutex::new(None), resend, floor: AtomicU32::new(u32::MAX) }
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
        }
        writer.write_rtp(packet).await.unwrap_or(0)
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
