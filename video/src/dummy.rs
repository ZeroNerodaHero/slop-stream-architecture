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
const FPS: u32 = 15;
const RETRY: Duration = Duration::from_secs(5);
const REFUSED_RETRY: Duration = Duration::from_secs(60);
const SECRET_HEADER: &str = "X-Dummy-Password";
const AVATAR_SIDE: u32 = 256;
const GIF_FRAMES: u32 = 20 * FPS;

const GIFS_PER_STREAM: usize = 3;
const CORNERS: [(bool, bool); 4] = [(false, false), (true, true), (true, false), (false, true)];
const HEIGHTS: [u32; 3] = [106, 80, 92];
const BACKDROP_ROWS: u32 = 12;
const BACKDROP_TEXT: &str = "this is 240p";
const CLOCK: &str = r"%{pts\:gmtime\:0\:%H\\\:%M\\\:%S}";

#[derive(Clone)]
struct Config {
    names: Vec<String>,
    prefix: String,
    password: Option<String>,
    video_ws_url: String,
    api_url: Option<String>,
    chat_ws_url: Option<String>,
    font: String,
    gifs: Vec<PathBuf>,
    chat: bool,
    chat_every: Duration,
}

enum Sprite<'a> {
    Gif(&'a Path),
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
const OWNER_LINES: [&str; 34] = [
    "hi chat",
    "ok we are live",
    "is the sound too loud?",
    "how does the chat look on your end?",
    "brb, getting water",
    "back",
    "gg",
    "lol",
    "W",
    "ok",
    "hmm",
    "...anyway",
    "😂",
    "🔥🔥🔥",
    "emoji check: 🎮 🎧 🍕 ✨ 💯",
    "that gif almost hit the corner 👀",
    "@pixelfan lol",
    "@lurker_42 welcome in",
    "thanks for the follow @night-owl 🙏",
    "{me} here, testing the chat panel",
    "welcome to {me}, the most fake stream on the site",
    "uptime check: 42 minutes",
    "1 2 3 testing",
    "2 + 2 = 4, quick maths",
    "notes for this stream are at https://example.com/notes",
    "should I make the gifs bigger?",
    "what should the next gif be?",
    "ALL CAPS FOR NO REASON",
    "first line\nsecond line",
    "a word too long to fit: supercalifragilisticexpialidociousandthensomemoretomakeitwrapsomewhere",
    "a medium length line so the panel shows something between a word and a paragraph",
    "this one is longer on purpose: it should wrap onto two or three lines in a narrow column, so whoever is styling the chat can see how the spacing, the name and the time sit against more than one row of words.",
    "this is a long line on purpose, close to the five hundred character limit, so the chat panel has to show a real wall of words: the name, the badges and the time should stay where they are while the words wrap and wrap again under them. if the column is narrow this takes most of the panel, which is the point, because somebody will paste a paragraph into chat one day and it should still look fine. nothing here means anything, it is just filler that keeps going for a while, and then it stops.",
    "round 3 of the corner watch",
];
const OWNER_ANSWERS: [&str; 6] = [
    "answering myself: yes",
    "nobody answered so: no",
    "@{me} good question tbh",
    "chat says yes (chat is me)",
    "I'll take that as a yes",
    "replying to myself again, classic",
];
const CHAT_MAX_CHARS: usize = 500;
const CHAT_EVERY: Duration = Duration::from_millis(1000);
const CHAT_EVERY_MIN: Duration = Duration::from_millis(250);
const CHAT_EVERY_MAX: Duration = Duration::from_millis(60_000);

const ABOUT_OPENERS: [&str; 4] = [
    "this is a fake stream. nobody is behind it: a test box plays it so the site has something live to style and debug against.",
    "not a real person. this stream is a test the site runs on itself, for styling and debugging.",
    "a fake test stream. the picture is a few gifs bouncing on a dark backdrop, made by a machine, not by anyone streaming.",
    "you found one of the site's test streams. it is fake, it runs all day, and no one is watching the chat from the other side.",
];
const ABOUT_MIDDLES: [&str; 3] = [
    "the gifs bounce off the edges, the clock in the corner keeps time, and a tone plays so the sound has something to carry.",
    "the chat lines here come from a script too. they are there so the panel has words to wrap.",
    "it goes live by itself, ends by itself, and starts again a few seconds later.",
];

#[derive(Debug)]
struct Refused(String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "api go-live refused: {}", self.0)
    }
}

impl std::error::Error for Refused {}

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
    let count = stream_count(std::env::var("DUMMY_STREAMS").ok().as_deref());
    let password = std::env::var("DUMMY_PASSWORD").ok().filter(|p| !p.trim().is_empty());

    if count == 0 {
        log::info!("DUMMY_STREAMS=0, nothing to do. set it in .env and run: ./scripts/deploy.sh dummy");
        return wait_for_signal().await;
    }
    if password.is_none() {
        log::error!("DUMMY_PASSWORD is empty. set any word in .env (video and api read it too) and run: ./scripts/deploy.sh dummy");
        return wait_for_signal().await;
    }
    let found = Command::new("nice")
        .args(["-n", "19", "ffmpeg", "-version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success());
    if !found {
        return Err(anyhow!("ffmpeg (or nice) not found"));
    }

    let prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let names = stream_names(count, &prefix, &std::env::var("DUMMY_NAMES").unwrap_or_default());

    let cfg = Config {
        names,
        prefix,
        password,
        video_ws_url: std::env::var("VIDEO_WS_URL").unwrap_or_else(|_| "ws://video:7880/ws".into()),
        api_url: std::env::var("API_URL").ok().filter(|u| !u.is_empty()).map(|u| u.trim_end_matches('/').to_owned()),
        chat_ws_url: std::env::var("CHAT_WS_URL").ok().filter(|u| !u.is_empty()).map(|u| u.trim_end_matches('/').to_owned()),
        font: std::env::var("DUMMY_FONT").unwrap_or_else(|_| "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf".into()),
        gifs: load_gifs(&std::env::var("DUMMY_GIFS").unwrap_or_else(|_| "/usr/share/dummy-gifs".into())),
        chat: chat_on(std::env::var("DUMMY_CHAT").ok().as_deref()),
        chat_every: chat_every(std::env::var("DUMMY_CHAT_INTERVAL_MS").ok().as_deref()),
    };
    if cfg.api_url.is_none() {
        log::error!("API_URL is empty. video needs the api's go-live grant for every publish");
        return wait_for_signal().await;
    }
    log::info!("{} dummy stream(s): {}", cfg.names.len(), cfg.names.join(", "));
    match (cfg.chat, &cfg.chat_ws_url) {
        (false, _) => log::info!("DUMMY_CHAT is off: the streams run without chatter"),
        (true, None) => log::info!("CHAT_WS_URL is empty: the streams run without chatter"),
        (true, Some(_)) => log::info!("dummy chat on: each stream says a line every {}ms", cfg.chat_every.as_millis()),
    }
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
            tokio::time::sleep(Duration::from_millis(400 * i as u64)).await;
            loop {
                let wait = match publish_once(i, &name, &cfg, &http).await {
                    Ok(()) => {
                        log::info!("{name}: ended, starting again in {}s", RETRY.as_secs());
                        RETRY
                    }
                    Err(e) => {
                        let wait = if e.is::<Refused>() { REFUSED_RETRY } else { RETRY };
                        log::warn!("{name}: {e:#}. retrying in {}s", wait.as_secs());
                        wait
                    }
                };
                tokio::time::sleep(wait).await;
            }
        });
    }
    wait_for_signal().await
}

fn stream_count(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

fn stream_names(count: usize, prefix: &str, raw: &str) -> Vec<String> {
    let mut names: Vec<String> = raw
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
    names
}

fn chat_on(raw: Option<&str>) -> bool {
    !raw.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "off" | "false"))
}

fn chat_every(raw: Option<&str>) -> Duration {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .map_or(CHAT_EVERY, |ms| Duration::from_millis(ms).clamp(CHAT_EVERY_MIN, CHAT_EVERY_MAX))
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
    let mut owner: Option<Grant> = None;
    if let Some(api) = &cfg.api_url {
        let secret = cfg.password.as_deref().unwrap_or("");
        dress(i, name, cfg, http, api, secret).await;
        let res = http
            .post(format!("{api}/api/streams/{name}/go-live"))
            .header(SECRET_HEADER, secret)
            .send()
            .await
            .context("api go-live")?;
        if res.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(Refused(format!("{} {}", res.status(), res.text().await.unwrap_or_default())).into());
        }
        if !res.status().is_success() {
            return Err(anyhow!("api go-live: {} {}", res.status(), res.text().await.unwrap_or_default()));
        }
        owner = Some(res.json().await.context("api go-live reply")?);
    }

    let chatters: Vec<tokio::task::JoinHandle<()>> = match cfg.chat_ws_url.as_ref().filter(|_| cfg.chat) {
        Some(chat) => vec![
            tokio::spawn(chatter(
                format!("{chat}/chat/{name}"),
                serde_json::json!({ "type": "hello", "nick": VIEWER_NICKS[i % VIEWER_NICKS.len()], "bot": true }),
                Script::new(&LINES, &[], name, i),
                Duration::from_secs(30 + 3 * (i % 4) as u64),
            )),
            tokio::spawn(chatter(
                format!("{chat}/chat/{name}"),
                serde_json::json!({ "type": "hello", "nick": name, "session": owner.as_ref().map(|g| g.session), "token": owner.as_ref().map(|g| g.token), "bot": true }),
                Script::new(&OWNER_LINES, &OWNER_ANSWERS, name, i + 7),
                cfg.chat_every,
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

async fn dress(i: usize, name: &str, cfg: &Config, http: &reqwest::Client, api: &str, secret: &str) {
    let profile: Option<serde_json::Value> = match http.get(format!("{api}/api/streamers/{name}")).send().await {
        Ok(res) if res.status().is_success() => res.json().await.ok(),
        _ => None,
    };
    let has_bio = profile.as_ref().and_then(|v| v.get("bio")?.as_str().map(|b| !b.trim().is_empty())).unwrap_or(false);
    if !has_bio {
        let bio = format!("fake stream {} for styling and debugging. gifs bounce around. not a real person.", i + 1);
        let _ = http
            .put(format!("{api}/api/streamers/{name}"))
            .header(SECRET_HEADER, secret)
            .json(&serde_json::json!({ "bio": bio }))
            .send()
            .await;
    }
    if profile.as_ref().is_some_and(|v| v.get("avatar").is_some_and(serde_json::Value::is_null)) {
        if let Err(e) = put_avatar(i, name, cfg, http, api, secret).await {
            log::warn!("{name}: avatar: {e:#}");
        }
    }
    match about_page_empty(http, api, name).await {
        Ok(true) => {
            if let Err(e) = put_about_page(i, name, http, api, secret).await {
                log::warn!("{name}: about page: {e:#}");
            }
        }
        Ok(false) => {}
        Err(e) => log::warn!("{name}: about page: {e:#}"),
    }
}

fn about_html(i: usize, name: &str) -> String {
    let opener = ABOUT_OPENERS[i % ABOUT_OPENERS.len()];
    let middle = ABOUT_MIDDLES[(i / ABOUT_OPENERS.len() + i) % ABOUT_MIDDLES.len()];
    format!("<p>{opener}</p><p>{middle}</p><p>{name} is test stream {}. if you are looking for a real person, try another stream.</p>", i + 1)
}

async fn about_page_empty(http: &reqwest::Client, api: &str, name: &str) -> anyhow::Result<bool> {
    let res = http.get(format!("{api}/api/streamers/{name}/about-page")).send().await?.error_for_status()?;
    let page: serde_json::Value = res.json().await?;
    Ok(page.get("blocks").and_then(serde_json::Value::as_array).is_none_or(Vec::is_empty))
}

async fn put_about_page(i: usize, name: &str, http: &reqwest::Client, api: &str, secret: &str) -> anyhow::Result<()> {
    let page = serde_json::json!({
        "blocks": [{ "type": "text", "x": 24, "y": 24, "z": 1, "w": 520, "h": 220, "html": about_html(i, name) }]
    });
    let res = http.put(format!("{api}/api/streamers/{name}/about-page")).header(SECRET_HEADER, secret).json(&page).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("{} {}", res.status(), res.text().await.unwrap_or_default()));
    }
    log::info!("{name}: about page written");
    Ok(())
}

fn avatar_letter(name: &str, prefix: &str) -> char {
    let word = name.strip_prefix(prefix).filter(|w| !w.is_empty()).unwrap_or(name);
    word.chars().find(char::is_ascii_alphanumeric).map_or('x', |c| c.to_ascii_uppercase())
}

async fn avatar_jpeg(i: usize, name: &str, cfg: &Config) -> anyhow::Result<Vec<u8>> {
    let filter = format!(
        "drawtext=fontfile={font}:text='{letter}':fontcolor=white:fontsize=150:x=(w-text_w)/2:y=(h-text_h)/2,format=yuvj420p",
        font = cfg.font,
        letter = avatar_letter(name, &cfg.prefix)
    );
    let out = Command::new("nice")
        .args(["-n", "19", "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(["-f", "lavfi", "-i", &format!("color=c={}:s={AVATAR_SIDE}x{AVATAR_SIDE}", COLORS[i % COLORS.len()])])
        .args(["-vf", &filter, "-frames:v", "1", "-q:v", "3", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .context("start ffmpeg")?;
    if !out.status.success() || !out.stdout.starts_with(&[0xff, 0xd8]) {
        return Err(anyhow!("ffmpeg made no jpeg ({}): {}", out.status, String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

async fn put_avatar(i: usize, name: &str, cfg: &Config, http: &reqwest::Client, api: &str, secret: &str) -> anyhow::Result<()> {
    let jpeg = avatar_jpeg(i, name, cfg).await?;
    let res = http
        .put(format!("{api}/api/streamers/{name}/avatar"))
        .header(SECRET_HEADER, secret)
        .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
        .body(jpeg)
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow!("{} {}", res.status(), res.text().await.unwrap_or_default()));
    }
    log::info!("{name}: avatar written");
    Ok(())
}

async fn stream(i: usize, name: &str, cfg: &Config, http: &reqwest::Client, owner: Option<&Grant>) -> anyhow::Result<()> {
    let (media, registry) = media_setup(false, None)?;
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
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

struct Script {
    lines: &'static [&'static str],
    answers: &'static [&'static str],
    name: String,
    state: u64,
    last: Option<usize>,
    asked: bool,
}

impl Script {
    fn new(lines: &'static [&'static str], answers: &'static [&'static str], name: &str, seed: usize) -> Script {
        let state = std::collections::hash_map::RandomState::new().build_hasher().finish();
        Script::seeded(lines, answers, name, state ^ (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
    }

    fn seeded(lines: &'static [&'static str], answers: &'static [&'static str], name: &str, state: u64) -> Script {
        Script { lines, answers, name: name.to_owned(), state: state | 1, last: None, asked: false }
    }

    fn roll(&mut self) -> u64 {
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        self.state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 16
    }

    fn next(&mut self) -> String {
        let roll = self.roll();
        if self.asked && !self.answers.is_empty() && roll % 2 == 0 {
            self.asked = false;
            return self.said(self.answers[(roll / 2 % self.answers.len() as u64) as usize]);
        }
        let mut k = (roll % self.lines.len() as u64) as usize;
        if self.last == Some(k) {
            k = (k + 1) % self.lines.len();
        }
        self.last = Some(k);
        self.asked = self.lines[k].ends_with('?');
        self.said(self.lines[k])
    }

    fn said(&self, line: &str) -> String {
        line.replace("{me}", &self.name).chars().take(CHAT_MAX_CHARS).collect()
    }
}

fn wait_of(frame: &str) -> Option<Duration> {
    let v: serde_json::Value = serde_json::from_str(frame).ok()?;
    if v.get("type")?.as_str()? != "error" {
        return None;
    }
    v.get("wait")?.as_u64().map(Duration::from_millis)
}

async fn chatter(url: String, hello: serde_json::Value, mut script: Script, every: Duration) {
    loop {
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await {
            let _ = ws.send(Message::Text(hello.to_string().into())).await;
            if let Ok(Some(Ok(Message::Text(reply)))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
                if let Some(error) = serde_json::from_str::<Reply>(&reply).ok().and_then(|r| r.error) {
                    log::warn!("chat {url} refused {}: {error}. no chatter for this stream", hello["nick"]);
                    return;
                }
            }
            let mut next = tokio::time::Instant::now() + every;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(next) => {
                        let say = serde_json::json!({ "type": "say", "text": script.next() }).to_string();
                        if ws.send(Message::Text(say.into())).await.is_err() {
                            break;
                        }
                        next = tokio::time::Instant::now() + every;
                    }
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Some(wait) = wait_of(&text) {
                                next = next.max(tokio::time::Instant::now() + wait);
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    },
                }
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

fn sprites(cfg: &Config, i: usize) -> Vec<Sprite<'_>> {
    let deck = cfg.gifs.len();
    if deck == 0 {
        return vec![Sprite::Box(COLORS[i % COLORS.len()])];
    }
    (0..GIFS_PER_STREAM.min(deck)).map(|j| Sprite::Gif(&cfg.gifs[(i * GIFS_PER_STREAM + j) % deck])).collect()
}

fn bounce(speed: usize, from_far: bool, span: &str) -> String {
    let phase = if from_far { String::new() } else { format!("+({span})") };
    format!("abs(mod(t*{speed}{phase}\\,2*({span}))-({span}))")
}

fn backdrop(font: &str) -> String {
    let row = [BACKDROP_TEXT; 5].join("      ");
    (0..BACKDROP_ROWS)
        .map(|r| {
            let x = if r % 2 == 0 { 6 } else { -48 };
            format!(",drawtext=fontfile={font}:text='{row}':fontcolor=0x2b313b:fontsize=12:x={x}:y={}", 4 + 20 * r)
        })
        .collect()
}

fn spawn_ffmpeg(name: &str, i: usize, video_port: u16, audio_port: u16, cfg: &Config) -> anyhow::Result<Child> {
    let base = format!(
        "color=c=0x0f1115:s=426x240:r={FPS},trim=end_frame=1{backdrop},loop=loop=-1:size=1[out0];sine=frequency={freq}:sample_rate=48000,volume=0.15[out1]",
        backdrop = backdrop(&cfg.font),
        freq = 220 + 55 * (i % 8)
    );
    let sprites = sprites(cfg, i);

    let mut graph = String::new();
    let mut last = "[0:v]".to_owned();
    for (j, sprite) in sprites.iter().enumerate() {
        match sprite {
            Sprite::Gif(_) => graph.push_str(&format!(
                "[{}:v]scale=-2:{},format=yuva420p,loop=loop=-1:size={GIF_FRAMES},setpts=N/{FPS}/TB[s{j}];",
                j + 1,
                HEIGHTS[(i + j) % HEIGHTS.len()]
            )),
            Sprite::Box(color) => graph.push_str(&format!("color=c={color}:s=98x54:r={FPS}[s{j}];")),
        }
        let (from_right, from_bottom) = CORNERS[(i + j) % CORNERS.len()];
        let x = bounce(50 + 15 * ((i + 2 * j) % 5), from_right, "W-w");
        let y = bounce(35 + 12 * ((2 * i + 3 * j) % 5), from_bottom, "H-h");
        graph.push_str(&format!("{last}[s{j}]overlay=x='{x}':y='{y}'[v{j}];"));
        last = format!("[v{j}]");
    }
    graph.push_str(&format!(
        "{last}drawtext=fontfile={font}:text='{name}':fontcolor=white:fontsize=25:x=14:y=12:box=1:boxcolor=black@0.55:boxborderw=7,\
         drawtext=fontfile={font}:text='{CLOCK}':fontcolor=0x9aa3b2:fontsize=20:x=14:y=h-32:box=1:boxcolor=black@0.55:boxborderw=5[vout]",
        font = cfg.font
    ));

    let mut cmd = Command::new("nice");
    cmd.args(["-n", "19", "ffmpeg"]).args(["-hide_banner", "-loglevel", "warning", "-nostdin"]).args(["-re", "-f", "lavfi", "-i", &base]);
    for sprite in &sprites {
        if let Sprite::Gif(path) = sprite {
            cmd.arg("-i").arg(path);
        }
    }
    cmd.args(["-filter_threads", "1", "-filter_complex_threads", "1", "-threads", "1"])
        .args(["-filter_complex", &graph])
        .args(["-map", "[vout]", "-c:v", "libvpx", "-b:v", "180k", "-deadline", "realtime", "-cpu-used", "16"])
        .args(["-g", &FPS.to_string(), "-keyint_min", &FPS.to_string(), "-pix_fmt", "yuv420p"])
        .args(["-f", "rtp", "-rtpflags", "skip_rtcp", &format!("rtp://127.0.0.1:{video_port}?pkt_size=1200")])
        .args(["-map", "0:1", "-c:a", "libopus", "-compression_level", "0", "-b:a", "48k", "-ar", "48000", "-ac", "2"])
        .args(["-f", "rtp", "-rtpflags", "skip_rtcp", &format!("rtp://127.0.0.1:{audio_port}?pkt_size=1200")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    cmd.spawn().context("start ffmpeg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_avatar_letter_is_the_words_first() {
        assert_eq!(avatar_letter("dummy-mango", "dummy-"), 'M');
        assert_eq!(avatar_letter("dummy-_zephyr2", "dummy-"), 'Z');
        assert_eq!(avatar_letter("tester", "dummy-"), 'T');
        assert_eq!(avatar_letter("dummy-", "dummy-"), 'D');
        assert_eq!(avatar_letter("__", "dummy-"), 'x');
    }

    #[test]
    fn the_about_page_says_it_is_fake_and_varies() {
        let pages: Vec<String> = (0..6).map(|i| about_html(i, "dummy-mango")).collect();
        for page in &pages {
            assert!(page.contains("fake") || page.contains("not a real person"), "{page}");
            assert!(page.starts_with("<p>") && page.ends_with("</p>"));
        }
        let distinct: std::collections::HashSet<&String> = pages.iter().collect();
        assert_eq!(distinct.len(), pages.len());
    }

    #[test]
    fn no_streams_means_no_names() {
        assert_eq!(stream_count(None), 0);
        assert_eq!(stream_count(Some("")), 0);
        assert_eq!(stream_count(Some("0")), 0);
        assert_eq!(stream_count(Some("nope")), 0);
        assert_eq!(stream_count(Some(" 4 ")), 4);
        assert!(stream_names(0, "dummy-", "").is_empty());
        assert!(stream_names(0, "dummy-", "alpha,beta").is_empty());
        assert_eq!(stream_names(2, "dummy-", ""), ["dummy-mango", "dummy-pixel"]);
        assert_eq!(stream_names(2, "dummy-", "Alpha, bad name!"), ["alpha", "dummy-pixel"]);
    }

    #[test]
    fn dummy_chat_is_on_unless_turned_off() {
        assert!(chat_on(None));
        assert!(chat_on(Some("")));
        assert!(chat_on(Some("1")));
        assert!(chat_on(Some("on")));
        assert!(!chat_on(Some("0")));
        assert!(!chat_on(Some(" OFF ")));
        assert!(!chat_on(Some("false")));
    }

    #[test]
    fn the_chat_interval_defaults_to_a_second_and_is_clamped() {
        assert_eq!(chat_every(None), Duration::from_millis(1000));
        assert_eq!(chat_every(Some("")), Duration::from_millis(1000));
        assert_eq!(chat_every(Some("soon")), Duration::from_millis(1000));
        assert_eq!(chat_every(Some("2500")), Duration::from_millis(2500));
        assert_eq!(chat_every(Some("10")), Duration::from_millis(250));
        assert_eq!(chat_every(Some("0")), Duration::from_millis(250));
        assert_eq!(chat_every(Some("999999")), Duration::from_millis(60_000));
    }

    #[test]
    fn the_viewers_are_plain_guest_nicks() {
        for nick in VIEWER_NICKS {
            assert!(!nick.starts_with("dummy-"), "{nick}");
            assert!(crate::valid_name(nick), "{nick}");
        }
    }

    #[test]
    fn the_stream_talks_to_itself_without_repeating() {
        for seed in 0..20u64 {
            let mut script = Script::seeded(&OWNER_LINES, &OWNER_ANSWERS, "dummy-mango", seed);
            let mut last = String::new();
            let mut answered = false;
            for _ in 0..500 {
                let line = script.next();
                assert_ne!(line, last);
                assert!(!line.is_empty() && line.chars().count() <= CHAT_MAX_CHARS, "{line}");
                assert!(!line.contains("{me}"), "{line}");
                answered |= OWNER_ANSWERS.iter().any(|a| a.replace("{me}", "dummy-mango") == line);
                last = line;
            }
            assert!(answered);
        }
        let all: Vec<&str> = OWNER_LINES.iter().chain(OWNER_ANSWERS.iter()).copied().collect();
        assert!(all.iter().any(|l| l.chars().count() > 400));
        assert!(all.iter().any(|l| l.ends_with('?')));
        assert!(all.iter().any(|l| l.contains("{me}")));
        assert!(all.iter().any(|l| l.starts_with('@')));
    }

    #[test]
    fn a_slow_down_says_how_long_to_wait() {
        assert_eq!(wait_of(r#"{"type":"error","error":"slow down","wait":1235}"#), Some(Duration::from_millis(1235)));
        assert_eq!(wait_of(r#"{"type":"error","error":"bad nick"}"#), None);
        assert_eq!(wait_of(r#"{"type":"message","wait":5}"#), None);
        assert_eq!(wait_of("nope"), None);
    }
}
