//! Thumbnails, made here on the video machine for every publisher.
//!
//! When a publisher's video track comes up, an ffmpeg is started next to it and
//! fed a copy of the VP8 packets over localhost (plain RTP, described by a tiny
//! SDP file). ffmpeg decodes, scales to 320px and writes one jpeg every few
//! seconds, atomically, to /tmp. `GET /thumb/<name>.jpg` serves that file while
//! the stream is live. Nothing is stored anywhere else; the file goes with the room.
//!
//! Cost: decoding every frame, about 5-10% of a core per 720p stream. Viewers
//! pay nothing: no extra keyframes are requested. (The cheaper way, decoding
//! only keyframes and asking the publisher for one every few seconds, would
//! make every viewer download those keyframes too.)

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use webrtc::util::Marshal;

/// A running ffmpeg for one stream, and the socket that feeds it.
pub struct ThumbTap {
    name: String,
    socket: UdpSocket,
    ffmpeg: Child,
    /// Set once ffmpeg is found dead, so the keyframe loop stops asking for it.
    dead: Arc<AtomicBool>,
    checked: Instant,
    /// The sequence number last fed. The peer has srtp replay protection off, so a packet
    /// the publisher re-sent after all (a nack answered when the first had arrived) comes
    /// through twice back to back, and to ffmpeg's vp8 depacketizer a repeat is a break.
    last_seq: Option<u16>,
    sdp: PathBuf,
    jpeg: PathBuf,
}

/// Where the files go. One directory for all of them, so a start can sweep what a crash left.
const DIR: &str = "/tmp";
const PREFIX: &str = "thumb-";

/// How long ffmpeg waits for packets before giving up on the stream. Its default is 10s,
/// which a publisher on wifi can outlast while ice still holds the peer (ice gives up 20s
/// after the last packet: 5s to disconnected, 15 more to failed): the picture would then
/// be gone for the rest of the stream. 0 is never. The room's end kills ffmpeg anyway.
const LISTEN_TIMEOUT_SECS: &str = "0";
/// How long ffmpeg holds a packet back for an earlier one that has not come, in
/// microseconds. Its default is 100ms, and a packet the sfu got back by nack arrives
/// 100-300ms late and is fed in arrival order: to ffmpeg that was a lost packet, and its
/// vp8 depacketizer then drops every frame until the next keyframe.
const MAX_DELAY_MICROS: &str = "500000";

pub fn jpeg_path(name: &str) -> PathBuf {
    PathBuf::from(format!("{DIR}/{PREFIX}{name}.jpg"))
}

pub fn every_secs() -> u64 {
    std::env::var("THUMB_EVERY_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|s| *s > 0)
        .unwrap_or(5)
}

/// A picture older than this is past due: ffmpeg is waiting for a keyframe (a lost frame
/// breaks its vp8 depacketizer until one comes, and a browser sends one only when asked),
/// so the keyframe minder asks.
pub fn due_after() -> Duration {
    Duration::from_secs(every_secs() * 2)
}

/// Older than this, a picture is not "a few seconds old" any more and /thumb says 404
/// instead: ffmpeg died, or the publisher's video stopped while its connection held.
pub fn stale_after() -> Duration {
    Duration::from_secs(every_secs() * 6)
}

/// How old the stream's picture is. None: there is none (not made yet, taken down, or a
/// clock that stepped so far that the file is from the future).
pub async fn picture_age(name: &str) -> Option<Duration> {
    let modified = tokio::fs::metadata(jpeg_path(name)).await.ok()?.modified().ok()?;
    modified.elapsed().ok()
}

/// The files of a run that did not get to clean up (an oom kill, `docker kill`). Every
/// room's files go with the room; at start there are no rooms, so anything here is stale,
/// and would otherwise be served as live the moment that name went live again.
pub async fn sweep_stale() {
    let Ok(mut entries) = tokio::fs::read_dir(DIR).await else { return };
    let mut swept = 0;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let is_ours = name.to_str().is_some_and(|n| n.starts_with(PREFIX) && (n.ends_with(".jpg") || n.ends_with(".sdp") || n.ends_with(".jpg.tmp")));
        if is_ours && tokio::fs::remove_file(entry.path()).await.is_ok() {
            swept += 1;
        }
    }
    if swept > 0 {
        log::info!("thumbs: removed {swept} files left by an earlier run");
    }
}

pub fn enabled() -> bool {
    !matches!(std::env::var("THUMBS").as_deref(), Ok("0") | Ok("off") | Ok("false"))
}

/// Is there an ffmpeg to run? Checked once at startup.
pub async fn ffmpeg_present() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok()
}

impl ThumbTap {
    pub async fn start(name: &str, payload_type: u8) -> anyhow::Result<ThumbTap> {
        // find a free localhost port for ffmpeg, then let ffmpeg bind it. its rtp
        // demuxer also binds port+1 for rtcp and gives up if it cannot, so look
        // for a pair. (nothing holds them in between; a loser shows up as
        // "ffmpeg exited" below.)
        let port = {
            let mut port = 0;
            for _ in 0..8 {
                let probe = UdpSocket::bind("127.0.0.1:0").await?;
                port = probe.local_addr()?.port();
                if port < u16::MAX && UdpSocket::bind(("127.0.0.1", port + 1)).await.is_ok() {
                    break;
                }
            }
            port
        };
        let sdp = PathBuf::from(format!("{DIR}/{PREFIX}{name}.sdp"));
        let jpeg = jpeg_path(name);
        let _ = tokio::fs::remove_file(&jpeg).await;
        tokio::fs::write(
            &sdp,
            format!(
                "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=thumb\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n\
                 m=video {port} RTP/AVP {payload_type}\r\na=rtpmap:{payload_type} VP8/90000\r\n"
            ),
        )
        .await?;

        let every = every_secs();
        // `select` passes the very first decoded frame, then one every `every`
        // seconds. (`fps=1/N` would hold the first picture back a whole period.)
        let pick = format!("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{every})',scale=320:-2");
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1"])
            // the default is to study the stream for 5s before the first frame comes out
            .args(["-analyzeduration", "1500000", "-probesize", "1000000"])
            // `c=IN IP4 127.0.0.1` in the sdp does not make ffmpeg bind loopback: without
            // `-localaddr` the rtp and rtcp sockets listen on every interface, the compose
            // network included, and any container on it could feed this stream's picture
            .args(["-protocol_whitelist", "file,udp,rtp", "-localaddr", "127.0.0.1"])
            .args(["-listen_timeout", LISTEN_TIMEOUT_SECS, "-max_delay", MAX_DELAY_MICROS, "-i"])
            .arg(&sdp)
            // `-threads 1` before the input only reaches the decoder. the mjpeg
            // encoder would otherwise frame-thread (one thread per core) and hold
            // every picture back until the next one is submitted: with a frame
            // every `every` seconds that is a whole period late. (measured against
            // a local rtp source: first jpeg at 0.9s instead of 4.6s.)
            .args(["-threads", "1"])
            .args(["-an", "-vf", &pick, "-fps_mode", "vfr", "-c:v", "mjpeg", "-q:v", "6"])
            .args(["-update", "1", "-atomic_writing", "1", "-f", "image2"])
            .arg(&jpeg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let ffmpeg = cmd.spawn()?;

        // ffmpeg needs a moment to bind before packets mean anything
        tokio::time::sleep(Duration::from_millis(300)).await;
        let socket = UdpSocket::bind("127.0.0.1:0").await?;
        socket.connect(("127.0.0.1", port)).await?;
        Ok(ThumbTap {
            name: name.to_owned(),
            socket,
            ffmpeg,
            dead: Arc::new(AtomicBool::new(false)),
            checked: Instant::now(),
            last_seq: None,
            sdp,
            jpeg,
        })
    }

    /// True once ffmpeg has been found dead, or the tap is gone with its room. Shared so
    /// the keyframe minder knows when to stop.
    pub fn dead_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.dead)
    }

    /// A copy of one packet for ffmpeg. Fire and forget; a lost one is a lost frame.
    /// Once a second, also notice an ffmpeg that died (a bind that lost, a decode
    /// abort, the oom killer): say so once, stop feeding it, and take its last
    /// picture down, so /thumb says 404 rather than serve a frozen frame as live.
    pub fn feed(&mut self, packet: &webrtc::rtp::packet::Packet) {
        if self.dead.load(Ordering::Relaxed) {
            return;
        }
        if self.checked.elapsed() > Duration::from_secs(1) {
            self.checked = Instant::now();
            if let Ok(Some(status)) = self.ffmpeg.try_wait() {
                log::warn!("thumb {}: ffmpeg exited ({status}). no more pictures for this stream", self.name);
                self.dead.store(true, Ordering::Relaxed);
                let _ = std::fs::remove_file(&self.jpeg);
                let _ = std::fs::remove_file(self.jpeg.with_extension("jpg.tmp"));
                return;
            }
        }
        let seq = packet.header.sequence_number;
        if self.last_seq == Some(seq) {
            return;
        }
        self.last_seq = Some(seq);
        if let Ok(bytes) = packet.marshal() {
            let _ = self.socket.try_send(&bytes);
        }
    }
}

impl Drop for ThumbTap {
    fn drop(&mut self) {
        // ffmpeg first (kill_on_drop would too, but only after the fields below, and a
        // picture renamed in between would outlive this); then the files, including the
        // half-written one `-atomic_writing` renames from if the kill lands mid-picture
        let _ = self.ffmpeg.start_kill();
        self.dead.store(true, Ordering::Relaxed);
        let _ = std::fs::remove_file(&self.sdp);
        let _ = std::fs::remove_file(&self.jpeg);
        let _ = std::fs::remove_file(self.jpeg.with_extension("jpg.tmp"));
    }
}
