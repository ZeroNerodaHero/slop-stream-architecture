//! `video dummy`: fake streams for styling and debugging.
//!
//! Each stream is a box bouncing around a dark frame with the stream's name on
//! it, plus a quiet tone. ffmpeg draws and encodes (VP8 + Opus) to RTP on
//! localhost; we forward those packets into the video server the way a browser
//! would: same websocket, same offer/answer, plus the dummy password.
//!
//! Env: DUMMY_STREAMS (how many, 0 = idle), DUMMY_PASSWORD (must match the
//! server), DUMMY_NAMES (optional comma list), VIDEO_WS_URL, API_URL, DUMMY_FONT.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::Message;
use webrtc::api::APIBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::util::Unmarshal;

use crate::media::{media_setup, opus_capability, vp8_capability};

const WORDS: [&str; 12] = [
    "mango", "pixel", "disco", "lemon", "orbit", "velvet", "comet", "noodle", "tango", "quartz", "bagel", "zephyr",
];
const COLORS: [&str; 8] = [
    "0x4f8bff", "0xf85149", "0x3fb950", "0xf2cc60", "0xbc8cff", "0xff9f43", "0x39d2c0", "0xff6bcb",
];
const HEARTBEAT: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Config {
    names: Vec<String>,
    password: Option<String>,
    video_ws_url: String,
    api_url: Option<String>,
    /// e.g. ws://chat:4100. None turns the pretend chatter off.
    chat_ws_url: Option<String>,
    font: String,
}

const VIEWER_NICKS: [&str; 6] = ["pixelfan", "firstviewer", "lurker_42", "night-owl", "sam", "bitrate_bob"];
const LINES: [&str; 14] = [
    "hi chat",
    "is this live?",
    "the box is winning",
    "W stream",
    "corner hit incoming",
    "sound on, nice",
    "how long have you been live",
    "this is a test message that is a bit longer so the panel has to wrap it onto a second line, which is useful for styling",
    "lol",
    "brb",
    "can you make the box faster",
    "first time here",
    "that was close to the corner",
    "gg",
];

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

pub async fn run() -> anyhow::Result<()> {
    let count: usize = std::env::var("DUMMY_STREAMS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    let password = std::env::var("DUMMY_PASSWORD").ok().filter(|p| !p.trim().is_empty());

    if count == 0 {
        log::info!("DUMMY_STREAMS=0, nothing to do. set it in .env and run: ./deploy.sh dummy");
        return wait_for_signal().await;
    }
    if password.is_none() {
        log::error!("DUMMY_PASSWORD is empty. set any word in .env (video and api read it too) and run: ./deploy.sh dummy");
        return wait_for_signal().await;
    }
    if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().await.is_err() {
        return Err(anyhow!("ffmpeg not found"));
    }

    let prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let mut names: Vec<String> = std::env::var("DUMMY_NAMES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    for i in names.len()..count {
        names.push(format!("{prefix}{}{}", WORDS[i % WORDS.len()], if i >= WORDS.len() { (i / WORDS.len()).to_string() } else { String::new() }));
    }
    names.truncate(count);

    let cfg = Config {
        names,
        password,
        video_ws_url: std::env::var("VIDEO_WS_URL").unwrap_or_else(|_| "ws://video:7880/ws".into()),
        api_url: std::env::var("API_URL").ok().filter(|u| !u.is_empty()).map(|u| u.trim_end_matches('/').to_owned()),
        chat_ws_url: std::env::var("CHAT_WS_URL").ok().filter(|u| !u.is_empty()).map(|u| u.trim_end_matches('/').to_owned()),
        font: std::env::var("DUMMY_FONT").unwrap_or_else(|_| "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf".into()),
    };
    log::info!("{} dummy stream(s): {}", cfg.names.len(), cfg.names.join(", "));

    let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build()?;
    for (i, name) in cfg.names.iter().cloned().enumerate() {
        let cfg = cfg.clone();
        let http = http.clone();
        tokio::spawn(async move {
            // stagger a little so the logs and keyframes don't all land at once
            tokio::time::sleep(Duration::from_millis(400 * i as u64)).await;
            loop {
                match publish_once(i, &name, &cfg, &http).await {
                    Ok(()) => log::info!("{name}: ended, starting again in {}s", RETRY.as_secs()),
                    Err(e) => log::warn!("{name}: {e:#}. retrying in {}s", RETRY.as_secs()),
                }
                tokio::time::sleep(RETRY).await;
            }
        });
    }
    wait_for_signal().await
}

async fn wait_for_signal() -> anyhow::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
    log::info!("shutting down");
    Ok(())
}

async fn publish_once(i: usize, name: &str, cfg: &Config, http: &reqwest::Client) -> anyhow::Result<()> {
    // The api part: a bio so the cards have text, and a session so home shows "since".
    let mut owner: Option<Grant> = None;
    if let Some(api) = &cfg.api_url {
        let bio = format!("fake stream {} for styling and debugging. a box bounces. not a real person.", i + 1);
        let _ = http
            .put(format!("{api}/api/streamers/{name}"))
            .json(&serde_json::json!({ "bio": bio }))
            .send()
            .await;
        let res = http
            .post(format!("{api}/api/streams/{name}/go-live"))
            .query(&[("password", cfg.password.as_deref().unwrap_or(""))])
            .send()
            .await
            .context("api go-live")?;
        if !res.status().is_success() {
            return Err(anyhow!("api go-live: {} {}", res.status(), res.text().await.unwrap_or_default()));
        }
        owner = Some(res.json().await.context("api go-live reply")?);
    }

    // Chat too, so the panel has something to show: a pretend viewer every few
    // seconds, and the streamer (marked) now and then.
    let chatters: Vec<tokio::task::JoinHandle<()>> = match &cfg.chat_ws_url {
        Some(chat) => vec![
            tokio::spawn(chatter(format!("{chat}/chat/{name}"), serde_json::json!({ "type": "hello", "nick": VIEWER_NICKS[i % VIEWER_NICKS.len()] }), i, 6 + (i % 4) as u64)),
            tokio::spawn(chatter(
                format!("{chat}/chat/{name}"),
                serde_json::json!({ "type": "hello", "nick": name, "session": owner.as_ref().map(|g| g.session), "token": owner.as_ref().map(|g| g.token) }),
                i + 7,
                23,
            )),
        ],
        None => Vec::new(),
    };

    let result = stream(i, name, cfg, http, owner.as_ref()).await;

    for task in chatters {
        task.abort();
    }
    if let (Some(api), Some(grant)) = (&cfg.api_url, owner) {
        let _ = http
            .post(format!("{api}/api/streams/{name}/stop?session={}&token={}", grant.session, grant.token))
            .send()
            .await;
    }
    result
}

async fn stream(i: usize, name: &str, cfg: &Config, http: &reqwest::Client, owner: Option<&Grant>) -> anyhow::Result<()> {
    let (media, registry) = media_setup(false)?;
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);

    let video = Arc::new(TrackLocalStaticRTP::new(vp8_capability(), "video".to_owned(), name.to_owned()));
    let audio = Arc::new(TrackLocalStaticRTP::new(opus_capability(), "audio".to_owned(), name.to_owned()));
    for track in [Arc::clone(&video), Arc::clone(&audio)] {
        let sender = pc.add_track(track as Arc<dyn TrackLocal + Send + Sync>).await?;
        tokio::spawn(async move { while sender.read_rtcp().await.is_ok() {} });
    }

    let offer = pc.create_offer(None).await?;
    let mut gathered = pc.gathering_complete_promise().await;
    pc.set_local_description(offer).await?;
    let _ = gathered.recv().await;
    let sdp = pc
        .local_description()
        .await
        .ok_or_else(|| anyhow!("no local description"))?
        .sdp;

    // The same handshake a browser does.
    let (mut ws, _) = tokio_tungstenite::connect_async(&cfg.video_ws_url)
        .await
        .context("connect to video websocket")?;
    let hello = serde_json::json!({ "role": "publish", "name": name, "sdp": sdp, "password": cfg.password });
    ws.send(Message::Text(hello.to_string().into())).await?;
    let reply = tokio::time::timeout(Duration::from_secs(15), ws.next())
        .await
        .map_err(|_| anyhow!("video did not answer"))?
        .ok_or_else(|| anyhow!("video closed the socket"))??;
    let Message::Text(text) = reply else {
        return Err(anyhow!("unexpected reply from video"));
    };
    let reply: Reply = serde_json::from_str(&text)?;
    if let Some(error) = reply.error {
        return Err(anyhow!("video refused: {error}"));
    }
    let answer = RTCSessionDescription::answer(reply.sdp.ok_or_else(|| anyhow!("no sdp in reply"))?)?;
    pc.set_remote_description(answer).await?;

    // ffmpeg → rtp on localhost → the two tracks
    let video_socket = UdpSocket::bind("127.0.0.1:0").await?;
    let audio_socket = UdpSocket::bind("127.0.0.1:0").await?;
    let mut ffmpeg = spawn_ffmpeg(name, i, video_socket.local_addr()?.port(), audio_socket.local_addr()?.port(), &cfg.font)?;
    let video_task = tokio::spawn(forward(video_socket, video));
    let audio_task = tokio::spawn(forward(audio_socket, audio));
    log::info!("{name}: live");

    let mut beat = tokio::time::interval(HEARTBEAT);
    beat.tick().await;
    let result = loop {
        tokio::select! {
            msg = ws.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break Ok(()),
                _ => {}
            },
            status = ffmpeg.wait() => break Err(anyhow!("ffmpeg exited: {status:?}")),
            _ = beat.tick() => {
                if let (Some(api), Some(grant)) = (&cfg.api_url, owner) {
                    let url = format!("{api}/api/streams/{name}/heartbeat?session={}&token={}", grant.session, grant.token);
                    if let Ok(res) = http.post(url).send().await {
                        if matches!(res.status().as_u16(), 403 | 404 | 409) {
                            break Err(anyhow!("api says this session is over ({})", res.status()));
                        }
                    }
                }
            }
        }
    };

    let _ = ffmpeg.kill().await;
    video_task.abort();
    audio_task.abort();
    let _ = ws.close(None).await;
    let _ = pc.close().await;
    result
}

/// One pretend chatter: join the room, say a line every `every` seconds, come back
/// after 5s if the chat server drops us. `seed` picks the lines so rooms differ.
async fn chatter(url: String, hello: serde_json::Value, seed: usize, every: u64) {
    let mut n = seed;
    loop {
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await {
            let _ = ws.send(Message::Text(hello.to_string().into())).await;
            loop {
                tokio::time::sleep(Duration::from_secs(every)).await;
                n += 1;
                // 5 and 14 share no factor, so this walks every line before repeating
                let line = LINES[(n * 5 + seed) % LINES.len()];
                let say = serde_json::json!({ "type": "say", "text": line }).to_string();
                if ws.send(Message::Text(say.into())).await.is_err() {
                    break;
                }
                // drain whatever came in so the socket does not back up
                while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(10), ws.next()).await {}
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn forward(socket: UdpSocket, track: Arc<TrackLocalStaticRTP>) {
    let mut buf = vec![0u8; 1600];
    while let Ok(n) = socket.recv(&mut buf).await {
        let mut bytes = &buf[..n];
        if let Ok(packet) = Packet::unmarshal(&mut bytes) {
            let _ = track.write_rtp(&packet).await;
        }
    }
}

/// A dark frame, one coloured box bouncing like the old dvd logo, the name in the
/// corner, a running clock at the bottom. Speed and colour differ per stream so
/// you can tell them apart at a glance. Audio is a quiet tone, pitch per stream.
/// Small and 15 fps on purpose: each stream costs a slice of a core to encode.
fn spawn_ffmpeg(name: &str, i: usize, video_port: u16, audio_port: u16, font: &str) -> anyhow::Result<Child> {
    let color = COLORS[i % COLORS.len()];
    let speed_x = 60 + (i % 4) * 25;
    let speed_y = 40 + (i % 3) * 20;
    // One lavfi graph with both outputs and ONE `-re`. Two separate `-re` lavfi
    // inputs make ffmpeg spin at a full core each; this way a stream costs ~25%.
    let graph = format!(
        "color=c=0x0f1115:s=480x270:r=15,\
         drawbox=x='abs(mod(t*{speed_x}\\,2*(iw-110))-(iw-110))':y='abs(mod(t*{speed_y}\\,2*(ih-60))-(ih-60))':w=110:h=60:color={color}@1:t=fill,\
         drawtext=fontfile={font}:text='{name}':fontcolor=white:fontsize=28:x=16:y=14,\
         drawtext=fontfile={font}:text='%{{pts\\:hms}}':fontcolor=0x9aa3b2:fontsize=22:x=16:y=h-36[out0];\
         sine=frequency={freq}:sample_rate=48000,volume=0.15[out1]",
        freq = 220 + 55 * (i % 8)
    );

    // `-threads 1` must come AFTER the input to reach the encoder. Before it, it only
    // limits the lavfi source, and libvpx spins one thread per core instead.
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "warning", "-nostdin"])
        .args(["-re", "-f", "lavfi", "-i", &graph])
        .args(["-filter_threads", "1", "-threads", "1"])
        .args(["-map", "0:0", "-c:v", "libvpx", "-b:v", "500k", "-deadline", "realtime", "-cpu-used", "8"])
        .args(["-g", "30", "-keyint_min", "15", "-pix_fmt", "yuv420p"])
        .args(["-f", "rtp", &format!("rtp://127.0.0.1:{video_port}?pkt_size=1200")])
        .args(["-map", "0:1", "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "2"])
        .args(["-f", "rtp", &format!("rtp://127.0.0.1:{audio_port}?pkt_size=1200")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    cmd.spawn().context("start ffmpeg")
}
