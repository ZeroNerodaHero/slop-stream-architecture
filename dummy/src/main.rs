//! Dummy streams for styling and debugging: bouncing blocks and a name, like the
//! dvd logo, each with its own colours, speeds and a quiet tone. ffmpeg draws and
//! encodes them; this program publishes them to the video server exactly the way a
//! browser does (api go-live, /ws offer and answer, WebRTC), so every real path is
//! exercised. Names start with `dummy-` and the api only accepts those with the
//! dummy password.
//!
//! Env: DUMMY_STREAMS (how many, 0 = off), DUMMY_PASSWORD, API_URL, VIDEO_WS_URL,
//! VIDEO_MEDIA_HOST (hostname whose ip replaces the public ip in the answer, so
//! media stays inside the docker network).

use std::net::IpAddr;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS, MIME_TYPE_VP8};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::network_type::NetworkType;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

const HEARTBEAT: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(5);
const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
const FPS: u32 = 24;
const FONT: &str = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const WORDS: &[&str] = &[
    "dvd", "neon", "pixel", "blob", "bounce", "glitch", "static", "retro", "arcade", "crt", "vhs", "mosaic", "laser", "prism", "orbit", "echo",
];

#[derive(Clone)]
struct Config {
    api_url: String,
    ws_url: String,
    media_host: Option<String>,
    password: String,
}

#[derive(Deserialize)]
struct Grant {
    session: i64,
    token: i64,
}

#[derive(Deserialize)]
struct Reply {
    sdp: Option<String>,
    error: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn,dummy=info")).init();

    let count: usize = std::env::var("DUMMY_STREAMS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let config = Config {
        api_url: std::env::var("API_URL").unwrap_or_else(|_| "http://api:4000".into()),
        ws_url: std::env::var("VIDEO_WS_URL").unwrap_or_else(|_| "ws://video:7880/ws".into()),
        media_host: std::env::var("VIDEO_MEDIA_HOST").ok().filter(|h| !h.is_empty()),
        password: std::env::var("DUMMY_PASSWORD").unwrap_or_default(),
    };

    if count == 0 {
        log::info!("DUMMY_STREAMS=0, nothing to do. set it in .env and run ./deploy.sh api dummy");
        wait_for_signal().await;
        return Ok(());
    }
    if config.password.is_empty() {
        log::error!("DUMMY_STREAMS={count} but DUMMY_PASSWORD is empty. the api will refuse. set both in .env");
        wait_for_signal().await;
        return Ok(());
    }

    let stop = Arc::new(Notify::new());
    let mut tasks = Vec::new();
    for index in 0..count {
        let name = stream_name(index);
        let config = config.clone();
        let stop = stop.clone();
        tasks.push(tokio::spawn(async move { run_forever(index, name, config, stop).await }));
    }
    log::info!("{count} dummy stream(s) starting");

    wait_for_signal().await;
    log::info!("shutting down");
    stop.notify_waiters();
    for task in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    }
    Ok(())
}

fn stream_name(index: usize) -> String {
    match WORDS.get(index) {
        Some(word) => format!("dummy-{word}"),
        None => format!("dummy-{}", index + 1),
    }
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
    let mut int = signal(SignalKind::interrupt()).expect("sigint handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

/// Keep one named stream on the air. Whatever ends it, come back after a pause.
async fn run_forever(index: usize, name: String, config: Config, stop: Arc<Notify>) {
    loop {
        let session = tokio::select! {
            result = run_once(index, &name, &config) => result,
            _ = stop.notified() => return,
        };
        match session {
            Ok(()) => log::info!("{name}: ended"),
            Err(e) => log::warn!("{name}: {e}"),
        }
        tokio::select! {
            _ = tokio::time::sleep(RETRY) => {}
            _ = stop.notified() => return,
        }
    }
}

async fn run_once(index: usize, name: &str, config: &Config) -> anyhow::Result<()> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build()?;
    let owner = go_live(&http, config, name).await?;
    let result = publish(index, name, config, &http, &owner).await;
    let _ = http
        .post(format!("{}/api/streams/{name}/stop?session={}&token={}", config.api_url, owner.session, owner.token))
        .send()
        .await;
    result
}

async fn go_live(http: &reqwest::Client, config: &Config, name: &str) -> anyhow::Result<Grant> {
    let bio = format!("test stream {}. bouncing blocks, a quiet tone, no real person. for styling and debugging.", name.trim_start_matches("dummy-"));
    let _ = http
        .put(format!("{}/api/streamers/{name}?password={}", config.api_url, config.password))
        .json(&json!({ "bio": bio }))
        .send()
        .await;

    let res = http
        .post(format!("{}/api/streams/{name}/go-live?password={}", config.api_url, config.password))
        .send()
        .await?;
    if !res.status().is_success() {
        anyhow::bail!("go-live {}: {}", res.status(), res.text().await.unwrap_or_default());
    }
    Ok(res.json().await?)
}

async fn publish(index: usize, name: &str, config: &Config, http: &reqwest::Client, owner: &Grant) -> anyhow::Result<()> {
    let dead = Arc::new(Notify::new());
    let peer = Arc::new(new_peer(name, dead.clone()).await?);

    let video_track = Arc::new(TrackLocalStaticRTP::new(vp8(), "video".to_owned(), name.to_owned()));
    let audio_track = Arc::new(TrackLocalStaticRTP::new(opus(), "audio".to_owned(), name.to_owned()));
    for track in [&video_track, &audio_track] {
        let sender = peer.add_track(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>).await?;
        // Interceptors need the RTCP drained (NACKs are answered from history).
        tokio::spawn(async move { while sender.read_rtcp().await.is_ok() {} });
    }

    let offer = peer.create_offer(None).await?;
    let mut gathered = peer.gathering_complete_promise().await;
    peer.set_local_description(offer).await?;
    let _ = gathered.recv().await;
    let sdp = peer.local_description().await.ok_or_else(|| anyhow::anyhow!("no offer"))?.sdp;

    // The same single-shot handshake the page does.
    let (mut ws, _) = tokio_tungstenite::connect_async(&config.ws_url).await?;
    ws.send(Message::Text(json!({ "role": "publish", "name": name, "sdp": sdp }).to_string().into())).await?;
    let reply = match tokio::time::timeout(Duration::from_secs(15), ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Reply>(&text)?,
        Ok(Some(Ok(other))) => anyhow::bail!("unexpected reply {other:?}"),
        Ok(Some(Err(e))) => return Err(e.into()),
        Ok(None) => anyhow::bail!("socket closed before the answer"),
        Err(_) => anyhow::bail!("no answer in 15s"),
    };
    if let Some(error) = reply.error {
        anyhow::bail!("video server said: {error}");
    }
    let mut answer = reply.sdp.ok_or_else(|| anyhow::anyhow!("reply had no sdp"))?;
    if let Some(host) = &config.media_host {
        answer = point_media_at(answer, host).await?;
    }
    peer.set_remote_description(RTCSessionDescription::answer(answer)?).await?;

    // Bind first, then start ffmpeg, so nothing is lost.
    let video_port = 20000 + (index as u16) * 4;
    let audio_port = video_port + 2;
    let video_socket = UdpSocket::bind(("127.0.0.1", video_port)).await?;
    let audio_socket = UdpSocket::bind(("127.0.0.1", audio_port)).await?;
    let mut ffmpeg = spawn_ffmpeg(index, name, video_port, audio_port)?;
    let pump_video = tokio::spawn(pump(video_socket, video_track));
    let pump_audio = tokio::spawn(pump(audio_socket, audio_track));
    log::info!("{name}: publishing");

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let outcome: anyhow::Result<()> = loop {
        tokio::select! {
            msg = ws.next() => match msg {
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Err(e)) => break Err(e.into()),
                _ => {}
            },
            _ = dead.notified() => break Err(anyhow::anyhow!("peer connection failed")),
            status = ffmpeg.wait() => break Err(anyhow::anyhow!("ffmpeg exited: {status:?}")),
            _ = heartbeat.tick() => {
                let res = http
                    .post(format!("{}/api/streams/{name}/heartbeat?session={}&token={}", config.api_url, owner.session, owner.token))
                    .send()
                    .await;
                if let Ok(res) = res {
                    if matches!(res.status().as_u16(), 403 | 404 | 409) {
                        break Err(anyhow::anyhow!("heartbeat refused with {}", res.status()));
                    }
                }
            }
        }
    };

    pump_video.abort();
    pump_audio.abort();
    let _ = ffmpeg.start_kill();
    let _ = ffmpeg.wait().await;
    let _ = ws.close(None).await;
    let _ = peer.close().await;
    outcome
}

/// Copy RTP from ffmpeg into a track. The track rewrites ssrc and payload type.
async fn pump(socket: UdpSocket, track: Arc<TrackLocalStaticRTP>) {
    let mut buf = vec![0u8; 1600];
    while let Ok(n) = socket.recv(&mut buf).await {
        let _ = track.write(&buf[..n]).await;
    }
}

/// Inside docker the public ip is the wrong way to reach the video server, so
/// swap the ip in the answer's candidate lines for the ip of `host`.
async fn point_media_at(answer: String, host: &str) -> anyhow::Result<String> {
    let ip: IpAddr = tokio::net::lookup_host((host, 7882))
        .await?
        .map(|a| a.ip())
        .find(|ip| ip.is_ipv4())
        .ok_or_else(|| anyhow::anyhow!("cannot resolve {host}"))?;
    let out = answer
        .lines()
        .map(|line| {
            if let Some(rest) = line.strip_prefix("a=candidate:") {
                let mut parts: Vec<&str> = rest.split(' ').collect();
                let ip_text = ip.to_string();
                if parts.len() > 4 {
                    parts[4] = &ip_text;
                    return format!("a=candidate:{}", parts.join(" "));
                }
            }
            line.to_owned()
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    Ok(out + "\r\n")
}

fn spawn_ffmpeg(index: usize, name: &str, video_port: u16, audio_port: u16) -> anyhow::Result<Child> {
    let hue = (index as f64 * 47.0) % 360.0;
    let background = hsl(hue, 0.35, 0.10);
    let block_a = hsl(hue, 0.9, 0.55);
    let block_b = hsl((hue + 120.0) % 360.0, 0.9, 0.55);
    let block_c = hsl((hue + 240.0) % 360.0, 0.9, 0.55);
    let speed = 110.0 + index as f64 * 23.0;
    let label = name.trim_start_matches("dummy-").to_uppercase();
    let tone = 220.0 * 2f64.powf(index as f64 / 12.0);

    // The dvd bounce: a triangle wave of time, one per axis, different speeds per block.
    let bounce = |speed_x: f64, speed_y: f64, w: u32, h: u32| {
        format!(
            "x='abs(mod(t*{speed_x},2*(iw-{w}))-(iw-{w}))':y='abs(mod(t*{speed_y},2*(ih-{h}))-(ih-{h}))':w={w}:h={h}",
        )
    };
    let video = format!(
        "color=c={background}:s={WIDTH}x{HEIGHT}:r={FPS},\
         drawbox={}:c={block_a}:t=fill,\
         drawbox={}:c={block_b}:t=fill,\
         drawbox={}:c={block_c}:t=fill,\
         drawtext=fontfile={FONT}:text='{label}':fontsize=44:fontcolor=white:\
         x='abs(mod(t*{speed},2*(W-tw))-(W-tw))':y='abs(mod(t*{},2*(H-th))-(H-th))'",
        bounce(speed, speed * 0.72, 140, 80),
        bounce(speed * 0.55, speed * 1.1, 60, 60),
        bounce(speed * 1.3, speed * 0.4, 36, 120),
        speed * 0.8,
    );
    let audio = format!("sine=frequency={tone:.0}:sample_rate=48000,volume=0.04");

    let child = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-re"])
        .args(["-f", "lavfi", "-i", &video])
        .args(["-f", "lavfi", "-i", &audio])
        .args(["-map", "0:v", "-c:v", "libvpx", "-b:v", "900k", "-deadline", "realtime", "-cpu-used", "8"])
        .args(["-g", &FPS.to_string(), "-keyint_min", &FPS.to_string(), "-pix_fmt", "yuv420p"])
        .args(["-f", "rtp", &format!("rtp://127.0.0.1:{video_port}")])
        .args(["-map", "1:a", "-c:a", "libopus", "-b:a", "32k", "-application", "lowdelay", "-frame_duration", "20"])
        .args(["-f", "rtp", &format!("rtp://127.0.0.1:{audio_port}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    Ok(child)
}

fn hsl(h: f64, s: f64, l: f64) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h as u32 {
        0..=59 => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to = |v: f64| ((v + m) * 255.0).round() as u8;
    format!("0x{:02x}{:02x}{:02x}", to(r), to(g), to(b))
}

fn feedback(typ: &str, parameter: &str) -> RTCPFeedback {
    RTCPFeedback {
        typ: typ.to_owned(),
        parameter: parameter.to_owned(),
    }
}

fn vp8() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_VP8.to_owned(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: String::new(),
        rtcp_feedback: vec![feedback("goog-remb", ""), feedback("ccm", "fir"), feedback("nack", ""), feedback("nack", "pli")],
    }
}

fn opus() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
        rtcp_feedback: vec![],
    }
}

async fn new_peer(name: &str, dead: Arc<Notify>) -> anyhow::Result<RTCPeerConnection> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            capability: opus(),
            payload_type: 111,
            ..Default::default()
        },
        RTPCodecType::Audio,
    )?;
    media.register_codec(
        RTCRtpCodecParameters {
            capability: vp8(),
            payload_type: 96,
            ..Default::default()
        },
        RTPCodecType::Video,
    )?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)?;

    let mut setting = SettingEngine::default();
    setting.set_network_types(vec![NetworkType::Udp4]);
    setting.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);

    let api = APIBuilder::new()
        .with_setting_engine(setting)
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let peer = api.new_peer_connection(RTCConfiguration::default()).await?;

    let tag = name.to_owned();
    peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        log::info!("{tag}: peer {state}");
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            dead.notify_one();
        }
        Box::pin(async {})
    }));
    Ok(peer)
}
