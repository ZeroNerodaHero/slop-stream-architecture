use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

mod timings;

const POLL: Duration = Duration::from_secs(1);
const TARGETS_EVERY: Duration = Duration::from_secs(15);
const STATUS_EVERY: Duration = Duration::from_secs(15);
const HEALTHY: Duration = Duration::from_secs(60);
const BACKOFF_MAX: u64 = 30;
const REFRESH_AFTER: u32 = 3;
const MESSAGE_MAX: usize = 180;

#[derive(Clone)]
struct Env {
    api: String,
    secret: String,
    ffmpeg: String,
    mediamtx: String,
    config: String,
    rtsp_port: u16,
    api_port: u16,
    auth_port: u16,
    http_port: u16,
    udp_port: u16,
    public_ip: Option<String>,
    allow_origin: String,
    audio_bitrate: String,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn port(k: &str, or: u16) -> u16 {
    var(k).and_then(|v| v.parse().ok()).unwrap_or(or)
}

impl Env {
    fn read() -> Result<Self, String> {
        let secret = var("RELAY_SECRET").filter(|s| s.len() >= 16).ok_or("RELAY_SECRET is not set (16 characters or more)")?;
        Ok(Env {
            api: var("API_URL").unwrap_or_else(|| "http://api:4000".into()).trim_end_matches('/').to_owned(),
            secret,
            ffmpeg: var("FFMPEG").unwrap_or_else(|| "ffmpeg".into()),
            mediamtx: var("MEDIAMTX").unwrap_or_else(|| "mediamtx".into()),
            config: var("MEDIAMTX_CONFIG").unwrap_or_else(|| "/tmp/mediamtx.yml".into()),
            rtsp_port: port("RTSP_PORT", 8554),
            api_port: port("MEDIAMTX_API_PORT", 9997),
            auth_port: port("AUTH_PORT", 9998),
            http_port: port("WHIP_PORT", 8889),
            udp_port: port("WEBRTC_UDP_PORT", 8189),
            public_ip: var("PUBLIC_IP"),
            allow_origin: var("ALLOW_ORIGIN").unwrap_or_else(|| "*".into()),
            audio_bitrate: var("AUDIO_BITRATE").unwrap_or_else(|| "160k".into()),
        })
    }

    fn mediamtx_config(&self) -> String {
        let quote = |s: &str| serde_json::to_string(s).unwrap_or_default();
        let hosts = self.public_ip.as_deref().map(|ip| format!("[{}]", quote(ip))).unwrap_or_else(|| "[]".into());
        format!(
            "logLevel: info
logDestinations: [stdout]
authMethod: http
authHTTPAddress: http://127.0.0.1:{auth}/auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof
api: true
apiAddress: 127.0.0.1:{api}
metrics: false
pprof: false
playback: false
rtsp: true
rtspTransports: [tcp]
rtspEncryption: \"no\"
rtspAddress: 127.0.0.1:{rtsp}
rtmp: false
hls: false
srt: false
moq: false
webrtc: true
webrtcAddress: :{http}
webrtcAllowOrigins: [{origin}]
webrtcLocalUDPAddress: :{udp}
webrtcAdditionalHosts: {hosts}
paths:
  \"~^[0-9a-f]{{32}}$\": {{}}
",
            auth = self.auth_port,
            api = self.api_port,
            rtsp = self.rtsp_port,
            http = self.http_port,
            origin = quote(&self.allow_origin),
            udp = self.udp_port,
        )
    }
}

#[derive(Clone)]
struct Relay {
    env: Arc<Env>,
    http: reqwest::Client,
    up: Arc<AtomicBool>,
    started: Instant,
    build: Arc<str>,
}

#[derive(Deserialize, Clone, PartialEq)]
struct Target {
    id: Uuid,
    platform: String,
    url: String,
    key: String,
}

impl Target {
    fn destination(&self) -> String {
        format!("{}/{}", self.url.trim_end_matches('/'), self.key)
    }

    fn fingerprint(&self) -> String {
        Sha256::digest(self.destination().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
    }
}

fn valid_session(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn line_name(platform: &str) -> String {
    let ok = !platform.is_empty() && platform.len() <= 32 && platform.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok { platform.to_owned() } else { "other".into() }
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

fn scrub(line: &str, t: &Target) -> String {
    let mut out = line.replace(&t.destination(), &format!("<{}>", t.platform));
    if !t.key.is_empty() {
        out = out.replace(&t.key, "<key>");
        let encoded: String = url_encoded(&t.key);
        if encoded != t.key {
            out = out.replace(&encoded, "<key>");
        }
    }
    let clean: String = out.chars().filter(|c| !c.is_control()).collect();
    let clean = clean.trim();
    let clean = match clean.strip_prefix('[').and_then(|rest| rest.split_once("] ")) {
        Some((tag, rest)) if tag.contains(" @ 0x") => rest.trim(),
        _ => clean,
    };
    clean.chars().take(MESSAGE_MAX).collect()
}

fn url_encoded(raw: &str) -> String {
    raw.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn backoff(fails: u32) -> u64 {
    (1u64 << fails.saturating_sub(1).min(5)).min(BACKOFF_MAX)
}

fn ffmpeg_args(env: &Env, session: &str, t: &Target) -> Vec<String> {
    [
        "-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1",
        "-rtsp_transport", "tcp", "-i",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([format!("rtsp://127.0.0.1:{}/{session}", env.rtsp_port)])
    .chain(
        ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", env.audio_bitrate.as_str(), "-ar", "48000", "-ac", "2", "-f", "flv", "-flvflags", "no_duration_filesize"]
            .iter()
            .map(|s| s.to_string()),
    )
    .chain([t.destination()])
    .collect()
}

impl Relay {
    async fn status(&self, session: &str, id: Uuid, state: &str, message: Option<&str>) {
        let req = self
            .http
            .post(format!("{}/internal/relay/status", self.env.api))
            .header("x-relay-secret", &self.env.secret)
            .json(&json!({ "session": session, "id": id, "state": state, "message": message }));
        let res = timings::call("POST", "/internal/relay/status", req).await;
        if let Err(e) = res {
            log::debug!("{}: status: {}", short(session), e.without_url());
        }
    }

    async fn targets(&self, session: &str, refresh: Option<Uuid>) -> Result<Option<Vec<Target>>, String> {
        let mut q = vec![("session", session.to_owned())];
        if let Some(id) = refresh {
            q.push(("refresh", id.to_string()));
        }
        let req = self.http.get(format!("{}/internal/relay/targets", self.env.api)).header("x-relay-secret", &self.env.secret).query(&q);
        let res = timings::call("GET", "/internal/relay/targets", req).await.map_err(|e| e.without_url().to_string())?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(format!("http {}", res.status()));
        }
        #[derive(Deserialize)]
        struct Answer {
            targets: Vec<Target>,
        }
        let answer: Answer = res.json().await.map_err(|e| e.without_url().to_string())?;
        Ok(Some(answer.targets))
    }

    async fn allowed(&self, session: &str, token: &str) -> bool {
        let req = self.http.post(format!("{}/internal/relay/auth", self.env.api)).header("x-relay-secret", &self.env.secret).json(&json!({ "session": session, "token": token }));
        let res = timings::call("POST", "/internal/relay/auth", req).await;
        matches!(res, Ok(r) if r.status().is_success())
    }

    async fn ready_paths(&self) -> Result<HashSet<String>, String> {
        let res = self
            .http
            .get(format!("http://127.0.0.1:{}/v3/paths/list?itemsPerPage=1000", self.env.api_port))
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let v: Value = res.json().await.map_err(|e| e.without_url().to_string())?;
        Ok(v["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|p| p["ready"] == true)
                    .filter_map(|p| p["name"].as_str())
                    .filter(|n| valid_session(n))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }
}

async fn run_ffmpeg(relay: &Relay, session: &str, t: &Target) -> String {
    let mut child = match Command::new(&relay.env.ffmpeg)
        .args(ffmpeg_args(&relay.env, session, t))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let why = format!("could not start ffmpeg: {e}");
            timings::Push::open(&line_name(&t.platform)).fail(&why);
            return why;
        }
    };
    let push = timings::Push::open(&line_name(&t.platform));
    let last = Arc::new(Mutex::new(String::new()));
    let stderr = child.stderr.take().map(|err| {
        let last = Arc::clone(&last);
        let t = t.clone();
        let tag = format!("{} {}", short(session), t.platform);
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = scrub(&line, &t);
                if clean.is_empty() {
                    continue;
                }
                log::info!("{tag}: ffmpeg: {clean}");
                *last.lock().await = clean;
            }
        })
    });
    let mut live: Option<Instant> = None;
    let mut total = 0u64;
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(size) = line.strip_prefix("total_size=").and_then(|n| n.trim().parse::<u64>().ok()).filter(|n| *n > 0) else {
                continue;
            };
            push.sent(size.saturating_sub(total));
            total = total.max(size);
            match live {
                None => log::info!("{} {}: live", short(session), t.platform),
                Some(at) if at.elapsed() < STATUS_EVERY => continue,
                Some(_) => {}
            }
            live = Some(Instant::now());
            relay.status(session, t.id, "live", None).await;
        }
    }
    let exit = child.wait().await;
    if let Some(h) = stderr {
        let _ = h.await;
    }
    let said = last.lock().await.clone();
    let why = match (said.is_empty(), exit) {
        (false, _) => said,
        (true, Ok(code)) => format!("ffmpeg stopped ({code})"),
        (true, Err(e)) => format!("ffmpeg stopped ({e})"),
    };
    push.fail(&why);
    why
}

async fn egress(relay: Relay, session: String, mut t: Target) {
    let mut fails = 0u32;
    loop {
        relay.status(&session, t.id, "connecting", None).await;
        let began = Instant::now();
        let why = run_ffmpeg(&relay, &session, &t).await;
        if began.elapsed() >= HEALTHY {
            fails = 0;
        }
        fails += 1;
        let wait = backoff(fails);
        log::warn!("{} {}: stopped ({why}), again in {wait}s", short(&session), t.platform);
        relay.status(&session, t.id, "error", Some(&format!("{why}. trying again in {wait}s"))).await;
        if fails % REFRESH_AFTER == 0 {
            match relay.targets(&session, Some(t.id)).await {
                Ok(Some(list)) => match list.into_iter().find(|n| n.id == t.id) {
                    Some(fresh) => t = fresh,
                    None => {
                        relay.status(&session, t.id, "off", None).await;
                        return;
                    }
                },
                Ok(None) => return,
                Err(e) => log::warn!("{} {}: fresh key: {e}", short(&session), t.platform),
            }
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

struct Egresses(HashMap<Uuid, (String, JoinHandle<()>)>);

impl Drop for Egresses {
    fn drop(&mut self) {
        for (_, h) in self.0.values() {
            h.abort();
        }
    }
}

async fn session(relay: Relay, sid: String, ids: Arc<Mutex<HashSet<Uuid>>>) {
    let mut running = Egresses(HashMap::new());
    log::info!("{}: publisher is in", short(&sid));
    loop {
        match relay.targets(&sid, None).await {
            Ok(Some(list)) => {
                let seen: HashSet<Uuid> = list.iter().map(|t| t.id).collect();
                let gone: Vec<Uuid> = running.0.keys().filter(|id| !seen.contains(id)).copied().collect();
                for id in gone {
                    if let Some((_, h)) = running.0.remove(&id) {
                        h.abort();
                    }
                    relay.status(&sid, id, "off", None).await;
                }
                for t in list {
                    let fp = t.fingerprint();
                    if matches!(running.0.get(&t.id), Some((f, h)) if *f == fp && !h.is_finished()) {
                        continue;
                    }
                    if let Some((_, h)) = running.0.remove(&t.id) {
                        h.abort();
                    }
                    log::info!("{}: sending to {}", short(&sid), t.platform);
                    let id = t.id;
                    let h = tokio::spawn(egress(relay.clone(), sid.clone(), t));
                    running.0.insert(id, (fp, h));
                }
                *ids.lock().await = running.0.keys().copied().collect();
            }
            Ok(None) => {
                log::info!("{}: the api ended this session", short(&sid));
                for id in running.0.keys() {
                    relay.status(&sid, *id, "off", None).await;
                }
                return;
            }
            Err(e) => log::warn!("{}: targets: {e}", short(&sid)),
        }
        tokio::time::sleep(TARGETS_EVERY).await;
    }
}

async fn watch(relay: Relay) {
    let mut live: HashMap<String, (JoinHandle<()>, Arc<Mutex<HashSet<Uuid>>>)> = HashMap::new();
    loop {
        tokio::time::sleep(POLL).await;
        let ready = match relay.ready_paths().await {
            Ok(r) => r,
            Err(e) => {
                log::debug!("mediamtx api: {e}");
                continue;
            }
        };
        let ended: Vec<String> = live.keys().filter(|k| !ready.contains(*k)).cloned().collect();
        for sid in ended {
            if let Some((h, ids)) = live.remove(&sid) {
                h.abort();
                log::info!("{}: publisher left", short(&sid));
                let ids: Vec<Uuid> = ids.lock().await.iter().copied().collect();
                for id in ids {
                    relay.status(&sid, id, "off", None).await;
                }
            }
        }
        for sid in ready {
            if live.contains_key(&sid) {
                continue;
            }
            let ids = Arc::new(Mutex::new(HashSet::new()));
            let h = tokio::spawn(session(relay.clone(), sid.clone(), Arc::clone(&ids)));
            live.insert(sid, (h, ids));
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct AuthAsk {
    password: String,
    token: String,
    ip: String,
    action: String,
    path: String,
    protocol: String,
    query: String,
}

fn query_token(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| pair.strip_prefix("token=").map(str::to_owned)).filter(|t| !t.is_empty())
}

async fn auth(State(relay): State<Relay>, Json(ask): Json<AuthAsk>) -> StatusCode {
    let local = ask.ip == "127.0.0.1" || ask.ip == "::1";
    let ok = match ask.action.as_str() {
        "read" => local && ask.protocol == "rtsp",
        "api" | "metrics" | "pprof" => local,
        "publish" if ask.protocol == "webrtc" && valid_session(&ask.path) => {
            let token = [ask.token.clone(), ask.password.clone()].into_iter().find(|t| !t.is_empty()).or_else(|| query_token(&ask.query));
            match token {
                Some(token) if token.len() <= 128 => relay.allowed(&ask.path, &token).await,
                _ => false,
            }
        }
        _ => false,
    };
    if !ok && ask.action == "publish" {
        log::info!("refused a publish to {}", short(&ask.path));
    }
    if ok {
        StatusCode::OK
    } else {
        StatusCode::UNAUTHORIZED
    }
}

async fn health(State(relay): State<Relay>) -> (StatusCode, Json<Value>) {
    let up = relay.up.load(Ordering::Relaxed);
    let body = json!({
        "ok": up,
        "up_secs": relay.started.elapsed().as_secs(),
        "build": &*relay.build,
        "mediamtx": up,
        "pushes": timings::open_pushes(),
    });
    (if up { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, Json(body))
}

async fn serve_ops(relay: Relay) {
    let port = var("TIMINGS_PORT").and_then(|p| p.parse::<u16>().ok()).unwrap_or(timings::PORT);
    if port == 0 {
        return;
    }
    let router = timings::router().route("/health", get(health)).with_state(relay);
    match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => {
            log::info!("relay: health and timings on 0.0.0.0:{port}, for the agent");
            tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, router).await {
                    log::warn!("relay: timings server stopped: {e}");
                }
            });
        }
        Err(e) => log::warn!("relay: cannot listen on {port} ({e}), so the agent gets no health or timings from the relay"),
    }
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let env = match Env::read() {
        Ok(e) => e,
        Err(e) => {
            log::error!("relay: {e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = std::fs::write(&env.config, env.mediamtx_config()) {
        log::error!("relay: could not write {}: {e}", env.config);
        std::process::exit(2);
    }
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client");
    let build: Arc<str> = var("BUILD").unwrap_or_else(|| "dev".into()).into();
    let relay = Relay { env: Arc::new(env), http, up: Arc::new(AtomicBool::new(false)), started: Instant::now(), build };
    serve_ops(relay.clone()).await;
    let app = Router::new().route("/auth", post(auth)).with_state(relay.clone());
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", relay.env.auth_port)).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("relay: auth port {}: {e}", relay.env.auth_port);
            std::process::exit(2);
        }
    };
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("relay: auth server: {e}");
            std::process::exit(1);
        }
    });
    let mut mtx = match Command::new(&relay.env.mediamtx).arg(&relay.env.config).kill_on_drop(true).spawn() {
        Ok(c) => c,
        Err(e) => {
            log::error!("relay: could not start mediamtx: {e}");
            std::process::exit(2);
        }
    };
    relay.up.store(true, Ordering::Relaxed);
    log::info!("relay: whip on :{}, media on udp :{}, api at {}", relay.env.http_port, relay.env.udp_port, relay.env.api);
    tokio::spawn(watch(relay.clone()));
    tokio::select! {
        status = mtx.wait() => {
            relay.up.store(false, Ordering::Relaxed);
            log::error!("relay: mediamtx stopped ({status:?})");
            std::process::exit(1);
        }
        _ = tokio::signal::ctrl_c() => {
            log::info!("relay: stopping");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target { id: Uuid::nil(), platform: "twitch".into(), url: "rtmps://live.twitch.tv:443/app/".into(), key: "live_123_s3cr+t/x".into() }
    }

    #[test]
    fn keys_never_leave_in_a_line() {
        let t = target();
        assert_eq!(t.destination(), "rtmps://live.twitch.tv:443/app/live_123_s3cr+t/x");
        let line = format!("[tls] Error opening output {}: I/O error", t.destination());
        assert_eq!(scrub(&line, &t), "[tls] Error opening output <twitch>: I/O error");
        assert_eq!(scrub("key live_123_s3cr+t/x and live_123_s3cr%2Bt%2Fx", &t), "key <key> and <key>");
        assert!(scrub(&"x".repeat(400), &t).len() <= MESSAGE_MAX);
        assert_eq!(scrub("[out#0/flv @ 0x7f1d65a52d80] Error closing file: Operation not permitted", &t), "Error closing file: Operation not permitted");
        assert!(!ffmpeg_args(&test_env(), &"a".repeat(32), &t).iter().any(|a| a.contains("s3cr") && !a.starts_with("rtmps://")));
    }

    #[test]
    fn a_push_is_named_by_its_platform_only() {
        assert_eq!(line_name("twitch"), "twitch");
        assert_eq!(line_name("youtube"), "youtube");
        assert_eq!(line_name("rtmp://a.example/live/key"), "other");
        assert_eq!(line_name(""), "other");
    }

    #[test]
    fn backoff_doubles_up_to_thirty_seconds() {
        let waits: Vec<u64> = (1..=8).map(backoff).collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn only_session_paths_and_tokens_count() {
        assert!(valid_session(&"0a".repeat(16)));
        assert!(!valid_session("live"));
        assert!(!valid_session(&"0A".repeat(16)));
        assert_eq!(query_token("a=1&token=abc").as_deref(), Some("abc"));
        assert_eq!(query_token("token="), None);
    }

    fn test_env() -> Env {
        Env {
            api: "http://api:4000".into(),
            secret: "0123456789abcdef".into(),
            ffmpeg: "ffmpeg".into(),
            mediamtx: "mediamtx".into(),
            config: "/tmp/x.yml".into(),
            rtsp_port: 8554,
            api_port: 9997,
            auth_port: 9998,
            http_port: 8889,
            udp_port: 8189,
            public_ip: Some("203.0.113.7".into()),
            allow_origin: "https://nodentity.xyz".into(),
            audio_bitrate: "160k".into(),
        }
    }

    #[test]
    fn the_mediamtx_config_keeps_reads_and_the_api_local() {
        let c = test_env().mediamtx_config();
        assert!(c.contains("rtspAddress: 127.0.0.1:8554"));
        assert!(c.contains("apiAddress: 127.0.0.1:9997"));
        assert!(c.contains("authHTTPAddress: http://127.0.0.1:9998/auth"));
        assert!(c.contains("webrtcAdditionalHosts: [\"203.0.113.7\"]"));
        assert!(c.contains("webrtcAllowOrigins: [\"https://nodentity.xyz\"]"));
        assert!(c.contains("\"~^[0-9a-f]{32}$\": {}"));
        assert!(c.contains("rtmp: false"));
    }
}
