use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use webrtc::util::Marshal;

pub struct ThumbTap {
    name: String,
    socket: UdpSocket,
    ffmpeg: Child,
    dead: Arc<AtomicBool>,
    checked: Instant,
    last_seq: Option<u16>,
    sdp: PathBuf,
    jpeg: PathBuf,
}

const DIR: &str = "/tmp";
const PREFIX: &str = "thumb-";

const LISTEN_TIMEOUT_SECS: &str = "0";
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

pub fn ask_after() -> Duration {
    Duration::from_millis(every_secs() * 900)
}

pub fn due_after() -> Duration {
    Duration::from_secs(every_secs() * 2)
}

pub fn stale_after() -> Duration {
    Duration::from_secs(every_secs() * 6)
}

pub async fn picture_age(name: &str) -> Option<Duration> {
    let modified = tokio::fs::metadata(jpeg_path(name)).await.ok()?.modified().ok()?;
    modified.elapsed().ok()
}

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

        let gap = every_secs() as f64 * 0.8;
        let pick = format!("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{gap})',scale=320:-2");
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1"])
            .args(["-analyzeduration", "1500000", "-probesize", "1000000"])
            .args(["-protocol_whitelist", "file,udp,rtp", "-localaddr", "127.0.0.1"])
            .args(["-listen_timeout", LISTEN_TIMEOUT_SECS, "-max_delay", MAX_DELAY_MICROS])
            .args(["-skip_frame", "nokey", "-i"])
            .arg(&sdp)
            .args(["-threads", "1"])
            .args(["-an", "-vf", &pick, "-fps_mode", "vfr", "-c:v", "mjpeg", "-q:v", "6"])
            .args(["-update", "1", "-atomic_writing", "1", "-f", "image2"])
            .arg(&jpeg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let ffmpeg = cmd.spawn()?;

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

    pub fn dead_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.dead)
    }

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
        let _ = self.ffmpeg.start_kill();
        self.dead.store(true, Ordering::Relaxed);
        let _ = std::fs::remove_file(&self.sdp);
        let _ = std::fs::remove_file(&self.jpeg);
        let _ = std::fs::remove_file(self.jpeg.with_extension("jpg.tmp"));
    }
}
