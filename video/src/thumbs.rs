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
use std::time::Duration;

use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use webrtc::util::Marshal;

/// A running ffmpeg for one stream, and the socket that feeds it.
pub struct ThumbTap {
    socket: UdpSocket,
    _ffmpeg: Child,
    sdp: PathBuf,
    jpeg: PathBuf,
}

pub fn jpeg_path(name: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/thumb-{name}.jpg"))
}

pub fn every_secs() -> u64 {
    std::env::var("THUMB_EVERY_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|s| *s > 0)
        .unwrap_or(5)
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
        // find a free localhost port for ffmpeg, then let ffmpeg bind it
        let port = UdpSocket::bind("127.0.0.1:0").await?.local_addr()?.port();
        let sdp = PathBuf::from(format!("/tmp/thumb-{name}.sdp"));
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
            .args(["-protocol_whitelist", "file,udp,rtp", "-i"])
            .arg(&sdp)
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
            socket,
            _ffmpeg: ffmpeg,
            sdp,
            jpeg,
        })
    }

    /// A copy of one packet for ffmpeg. Fire and forget; a lost one is a lost frame.
    pub fn feed(&self, packet: &webrtc::rtp::packet::Packet) {
        if let Ok(bytes) = packet.marshal() {
            let _ = self.socket.try_send(&bytes);
        }
    }
}

impl Drop for ThumbTap {
    fn drop(&mut self) {
        // kill_on_drop stops ffmpeg; the files go too
        let _ = std::fs::remove_file(&self.sdp);
        let _ = std::fs::remove_file(&self.jpeg);
    }
}
