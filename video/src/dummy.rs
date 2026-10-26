//! `video dummy`: fake streams for styling and debugging.
//!
//! Each stream is a few gifs bouncing around a dark frame like the old dvd logo,
//! the stream's name on top, a clock at the bottom, plus a quiet tone. ffmpeg
//! draws and encodes (VP8 + Opus) to RTP on localhost; we forward those packets
//! into the video server the way a browser would: go-live at the api, then the
//! same websocket and offer/answer with the session and token it got, plus the
//! dummy password.
//!
//! Env: DUMMY_STREAMS (how many, 0 = idle), DUMMY_PASSWORD (must match the
//! server), DUMMY_NAMES (optional comma list), VIDEO_WS_URL, API_URL, DUMMY_FONT,
//! DUMMY_GIFS (a folder of .gif files; none there and a coloured box bounces instead).

use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
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
use webrtc::peer_connection::RTCPeerConnection;
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

/// How many gifs bounce around one stream. The frame is 480×270 and they are 90 to 120 tall.
const GIFS_PER_STREAM: usize = 3;
/// Where a stream's gifs start, in turn: top left, bottom right, top right, bottom left.
/// `(from the right, from the bottom)`.
const CORNERS: [(bool, bool); 4] = [(false, false), (true, true), (true, false), (false, true)];
/// Heights the gifs are shown at, in turn. Even, so the chroma of the yuv420 frame lines up.
const HEIGHTS: [u32; 3] = [120, 90, 104];
/// drawtext's `%{pts}` as `HH:MM:SS` (the time of day of `pts` seconds past the epoch). The
/// colons inside `%{}` are escaped once for drawtext and, the `\\\:` ones, once more for the
/// filter option parser that runs first.
const CLOCK: &str = r"%{pts\:gmtime\:0\:%H\\\:%M\\\:%S}";

#[derive(Clone)]
struct Config {
    names: Vec<String>,
    password: Option<String>,
    video_ws_url: String,
    api_url: Option<String>,
    /// e.g. ws://chat:4100. None turns the pretend chatter off.
    chat_ws_url: Option<String>,
    font: String,
    /// The deck: every gif in DUMMY_GIFS, shuffled once at start. Stream `i` is dealt the
    /// `GIFS_PER_STREAM` after stream `i-1`'s, round and round. Empty: a box bounces instead.
    gifs: Vec<PathBuf>,
}

/// One thing bouncing around a stream's frame.
enum Sprite<'a> {
    Gif(&'a Path),
    /// No gifs on this machine: the coloured box the dummy always had.
    Box(&'static str),
}

const VIEWER_NICKS: [&str; 6] = ["pixelfan", "firstviewer", "lurker_42", "night-owl", "sam", "bitrate_bob"];
const LINES: [&str; 14] = [
    "hi chat",
    "is this live?",
    "the gifs are winning",
    "W stream",
    "corner hit incoming",
    "sound on, nice",
    "how long have you been live",
    "this is a test message that is a bit longer so the panel has to wrap it onto a second line, which is useful for styling",
    "lol",
    "brb",
    "can you make the gifs faster",
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
        log::info!("DUMMY_STREAMS=0, nothing to do. set it in .env and run: ./scripts/deploy.sh dummy");
        return wait_for_signal().await;
    }
    if password.is_none() {
        log::error!("DUMMY_PASSWORD is empty. set any word in .env (video and api read it too) and run: ./scripts/deploy.sh dummy");
        return wait_for_signal().await;
    }
    if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().await.is_err() {
        return Err(anyhow!("ffmpeg not found"));
    }

    let prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    // the same name rule as everywhere. it also keeps the drawtext expression
    // below safe: no quotes, colons or commas can get in
    let mut names: Vec<String> = std::env::var("DUMMY_NAMES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .filter(|s| {
            let ok = crate::valid_name(s);
            if !ok {
                log::warn!("DUMMY_NAMES: skipping {s:?}. use a-z 0-9 _ - (1 to 32)");
            }
            ok
        })
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
        gifs: load_gifs(&std::env::var("DUMMY_GIFS").unwrap_or_else(|_| "/usr/share/dummy-gifs".into())),
    };
    if cfg.api_url.is_none() {
        // video refuses a publish without the api's session and token, so without
        // the api there is nothing to do
        log::error!("API_URL is empty. video needs the api's go-live grant for every publish");
        return wait_for_signal().await;
    }
    log::info!("{} dummy stream(s): {}", cfg.names.len(), cfg.names.join(", "));
    for (i, name) in cfg.names.iter().enumerate() {
        let hand: Vec<String> = sprites(&cfg, i)
            .iter()
            .map(|s| match s {
                Sprite::Gif(path) => path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                Sprite::Box(color) => format!("a {color} box"),
            })
            .collect();
        log::info!("{name}: {}", hand.join(", "));
    }

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
        // a bio so the cards have text, but only for a name that has none: one put there by hand
        // (`./scripts/seed.sh --dummies`, so the fake streams read like people) must not be written over
        // at every start. a reserved name's bio wants the password like its go-live
        let has_bio = match http.get(format!("{api}/api/streamers/{name}")).send().await {
            Ok(res) => res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("bio")?.as_str().map(|b| !b.trim().is_empty()))
                .unwrap_or(false),
            Err(_) => false,
        };
        if !has_bio {
            let bio = format!("fake stream {} for styling and debugging. gifs bounce around. not a real person.", i + 1);
            let _ = http
                .put(format!("{api}/api/streamers/{name}"))
                .query(&[("password", cfg.password.as_deref().unwrap_or(""))])
                .json(&serde_json::json!({ "bio": bio }))
                .send()
                .await;
        }
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
    // seconds, and the streamer (marked) now and then. Both say `bot: true`, so their
    // lines wear the BOT badge and the panel's "hide bots" can take them off the screen.
    let chatters: Vec<tokio::task::JoinHandle<()>> = match &cfg.chat_ws_url {
        Some(chat) => vec![
            tokio::spawn(chatter(format!("{chat}/chat/{name}"), serde_json::json!({ "type": "hello", "nick": VIEWER_NICKS[i % VIEWER_NICKS.len()], "bot": true }), i, 6 + (i % 4) as u64)),
            tokio::spawn(chatter(
                format!("{chat}/chat/{name}"),
                serde_json::json!({ "type": "hello", "nick": name, "session": owner.as_ref().map(|g| g.session), "token": owner.as_ref().map(|g| g.token), "bot": true }),
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
    // close on every way out, not just the happy one: a dropped peer connection
    // keeps its ice sockets and the rtcp reader tasks, and the retry loop would
    // make a new set every 5s for as long as video is down
    let result = publish_on(&pc, i, name, cfg, http, owner).await;
    let _ = pc.close().await;
    result
}

async fn publish_on(pc: &RTCPeerConnection, i: usize, name: &str, cfg: &Config, http: &reqwest::Client, owner: Option<&Grant>) -> anyhow::Result<()> {
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

    // The same handshake a browser does: the go-live grant proves the name is ours.
    let (mut ws, _) = tokio_tungstenite::connect_async(&cfg.video_ws_url)
        .await
        .context("connect to video websocket")?;
    let hello = serde_json::json!({
        "role": "publish",
        "name": name,
        "sdp": sdp,
        "session": owner.map(|g| g.session),
        "token": owner.map(|g| g.token),
        "password": cfg.password,
    });
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
    let mut ffmpeg = spawn_ffmpeg(name, i, video_socket.local_addr()?.port(), audio_socket.local_addr()?.port(), cfg)?;
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
    result
}

/// One pretend chatter: join the room, say a line every `every` seconds, come back
/// after 5s if the chat server drops us. `seed` picks the lines so rooms differ.
/// A refused hello (someone signed up as this nick) is said once and the chatter
/// gives up, instead of reconnecting forever in silence.
async fn chatter(url: String, hello: serde_json::Value, seed: usize, every: u64) {
    let mut n = seed;
    loop {
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await {
            let _ = ws.send(Message::Text(hello.to_string().into())).await;
            // the chat answers the hello with the history, or with an error and a close
            if let Ok(Some(Ok(Message::Text(reply)))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
                if let Some(error) = serde_json::from_str::<Reply>(&reply).ok().and_then(|r| r.error) {
                    log::warn!("chat {url} refused {}: {error}. no chatter for this stream", hello["nick"]);
                    return;
                }
            }
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

/// Every `.gif` in `dir`, shuffled, so each start deals the names different gifs. Empty when
/// the folder is missing or holds none; a warning says so, and the streams get a box.
fn load_gifs(dir: &str) -> Vec<PathBuf> {
    let mut gifs: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("gif")))
            .collect(),
        Err(e) => {
            log::warn!("DUMMY_GIFS={dir}: {e}. a coloured box bounces instead of gifs");
            return Vec::new();
        }
    };
    if gifs.is_empty() {
        log::warn!("no .gif files in DUMMY_GIFS={dir}. a coloured box bounces instead");
        return gifs;
    }
    gifs.sort();
    shuffle(&mut gifs);
    log::info!("{} gif(s) in {dir}", gifs.len());
    gifs
}

/// Fisher-Yates on xorshift64*, seeded from the process's random hasher: no crate for one shuffle.
fn shuffle<T>(items: &mut [T]) {
    let mut state = std::collections::hash_map::RandomState::new().build_hasher().finish() | 1;
    for i in (1..items.len()).rev() {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let roll = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        items.swap(i, (roll % (i as u64 + 1)) as usize);
    }
}

/// Stream `i`'s hand: the next few gifs of the deck after stream `i-1`'s (fewer when the deck is
/// short; one gif is still one), or the box when there are none.
fn sprites(cfg: &Config, i: usize) -> Vec<Sprite<'_>> {
    let deck = cfg.gifs.len();
    if deck == 0 {
        return vec![Sprite::Box(COLORS[i % COLORS.len()])];
    }
    (0..GIFS_PER_STREAM.min(deck)).map(|j| Sprite::Gif(&cfg.gifs[(i * GIFS_PER_STREAM + j) % deck])).collect()
}

/// The dvd logo's path along one axis, for the overlay filter, where `t` is the time in seconds:
/// a triangle wave over `span` (`W-w` or `H-h`, how far the sprite can go) at `speed` pixels a
/// second. It starts at the far end, or at zero (half a period in) when `from_far` is false.
fn bounce(speed: usize, from_far: bool, span: &str) -> String {
    let phase = if from_far { String::new() } else { format!("+({span})") };
    format!("abs(mod(t*{speed}{phase}\\,2*({span}))-({span}))")
}

/// A dark frame, a few gifs bouncing around it like the old dvd logo, the name on top, a running
/// clock at the bottom. Each gif starts in its own corner at its own speed and height, and the
/// deal differs per stream, so you can tell them apart at a glance. Audio is a quiet tone, pitch
/// per stream. Small and 15 fps on purpose: each stream costs a slice of a core to encode.
///
/// The gifs are inputs of their own, looped forever, and `overlay` moves them: its `x`/`y` are
/// evaluated per frame with `t` the time. (`drawbox`, which the box used to be, evaluates once,
/// and its `t` is the thickness: it never moved.) The image shrank the gifs to the size and rate
/// they are shown at, see Dockerfile.dummy; the originals cost more to decode than the stream
/// costs to encode.
fn spawn_ffmpeg(name: &str, i: usize, video_port: u16, audio_port: u16, cfg: &Config) -> anyhow::Result<Child> {
    // The frame and the tone in one lavfi graph with ONE `-re`. Two separate `-re` lavfi
    // inputs make ffmpeg spin at a full core each. The gif inputs have no `-re`: the overlay
    // takes their frames as the paced frame needs them.
    let base = format!(
        "color=c=0x0f1115:s=480x270:r=15[out0];sine=frequency={freq}:sample_rate=48000,volume=0.15[out1]",
        freq = 220 + 55 * (i % 8)
    );
    let sprites = sprites(cfg, i);

    let mut graph = String::new();
    let mut last = "[0:v]".to_owned();
    for (j, sprite) in sprites.iter().enumerate() {
        match sprite {
            Sprite::Gif(_) => graph.push_str(&format!("[{}:v]scale=-2:{}[s{j}];", j + 1, HEIGHTS[(i + j) % HEIGHTS.len()])),
            Sprite::Box(color) => graph.push_str(&format!("color=c={color}:s=110x60:r=15[s{j}];")),
        }
        let (from_right, from_bottom) = CORNERS[(i + j) % CORNERS.len()];
        let x = bounce(50 + 15 * ((i + 2 * j) % 5), from_right, "W-w");
        let y = bounce(35 + 12 * ((2 * i + 3 * j) % 5), from_bottom, "H-h");
        graph.push_str(&format!("{last}[s{j}]overlay=x='{x}':y='{y}'[v{j}];"));
        last = format!("[v{j}]");
    }
    // the name and the clock last, on top of the gifs, each on a dark box so they stay readable
    graph.push_str(&format!(
        "{last}drawtext=fontfile={font}:text='{name}':fontcolor=white:fontsize=28:x=16:y=14:box=1:boxcolor=black@0.55:boxborderw=8,\
         drawtext=fontfile={font}:text='{CLOCK}':fontcolor=0x9aa3b2:fontsize=22:x=16:y=h-36:box=1:boxcolor=black@0.55:boxborderw=6[vout]",
        font = cfg.font
    ));

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "warning", "-nostdin"]).args(["-re", "-f", "lavfi", "-i", &base]);
    for sprite in &sprites {
        if let Sprite::Gif(path) = sprite {
            cmd.args(["-stream_loop", "-1", "-i"]).arg(path);
        }
    }
    // `-threads 1` must come AFTER the inputs to reach the encoder. Before them, it only
    // limits the lavfi source, and libvpx spins one thread per core instead. Without
    // `-filter_complex_threads 1` every scale and overlay gets a pool of one thread per core.
    cmd.args(["-filter_threads", "1", "-filter_complex_threads", "1", "-threads", "1"])
        .args(["-filter_complex", &graph])
        .args(["-map", "[vout]", "-c:v", "libvpx", "-b:v", "500k", "-deadline", "realtime", "-cpu-used", "8"])
        .args(["-g", "30", "-keyint_min", "15", "-pix_fmt", "yuv420p"])
        // no rtcp: the muxer would send sender reports to port+1, and the two sockets below
        // are whatever the kernel handed out, so port+1 can be the other one (or another
        // stream's); a report read as rtp is a garbage packet rewritten into a track
        .args(["-f", "rtp", "-rtpflags", "skip_rtcp", &format!("rtp://127.0.0.1:{video_port}?pkt_size=1200")])
        .args(["-map", "0:1", "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "2"])
        .args(["-f", "rtp", "-rtpflags", "skip_rtcp", &format!("rtp://127.0.0.1:{audio_port}?pkt_size=1200")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    cmd.spawn().context("start ffmpeg")
}
