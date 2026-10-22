//! `api monitor`: watches the other boxes from a box of its own. See docs/debugging.md.
//!
//! Every CHECK_EVERY_SECS it asks each target's /api/health and keeps what came
//! back: up or down and since when, the build, the uptimes (they go backwards after
//! a restart), an hourly tally for the uptime percentages, and a log of events
//! (down, up, restart, new build). Every ERRORS_EVERY_SECS it pulls the newest rows
//! from /api/errors with that box's OPS_TOKEN, so the page shows what broke in
//! someone's browser without logging in to each box.
//!
//! One file is the whole store, DATA_DIR/monitor.json, rewritten after every round
//! (temp file, then rename: a crash mid-write leaves the old one). No database, no
//! redis. One page, built into the binary (monitor.html), polls GET /api/monitor
//! every 10s.
//!
//! The targets' certificates are self-signed (an ip, no domain), so they are not
//! checked. Health is public anyway and the media is encrypted on its own; what a
//! man in the middle could read is OPS_TOKEN on the error pulls. The alert webhook
//! is checked normally.
//!
//! Env: TARGETS=prod=https://1.2.3.4,dev=https://… (nothing to watch without it),
//! OPS_TOKENS=prod=…,dev=… (or one OPS_TOKEN for all), ALERT_WEBHOOK (a url that
//! takes json with "content", like discord; "text" is sent too), PORT (3002),
//! DATA_DIR (/data), CHECK_EVERY_SECS (15), ERRORS_EVERY_SECS (60), DOWN_AFTER (3:
//! failed rounds in a row before "down" and the alert).

use std::collections::{HashSet, VecDeque};
use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::response::Html;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, DurationRound, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::task::JoinSet;

const PAGE: &str = include_str!("monitor.html");
const STORE_FILE: &str = "monitor.json";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Hours of tally kept: the 7-day uptime figure.
const KEEP_HOURS: usize = 24 * 7;
const KEEP_EVENTS: usize = 200;
/// Error reports kept per target, and how many one pull asks for.
const KEEP_ERRORS: usize = 100;
const ERRORS_PULL: usize = 50;

#[derive(Clone)]
struct Target {
    name: String,
    url: String,
    token: Option<String>,
}

struct Config {
    targets: Vec<Target>,
    webhook: Option<String>,
    check_every: Duration,
    errors_every: Duration,
    down_after: u32,
    data_dir: PathBuf,
    port: u16,
    build: String,
}

#[derive(Clone)]
struct App {
    cfg: Arc<Config>,
    store: Arc<Mutex<Store>>,
    started: Instant,
    /// For the targets: self-signed certificates accepted.
    boxes: reqwest::Client,
    /// For the webhook: certificates checked.
    hooks: reqwest::Client,
}

// ---- what is kept -------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct Store {
    targets: Vec<TargetState>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
enum Status {
    #[default]
    Unknown,
    Up,
    Down,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct TargetState {
    name: String,
    url: String,
    status: Status,
    /// When the current status began.
    since: Option<DateTime<Utc>>,
    /// Failed rounds in a row, and when the first of them was.
    failures: u32,
    failing_since: Option<DateTime<Utc>>,
    checked_at: Option<DateTime<Utc>>,
    latency_ms: Option<u64>,
    http_status: Option<u16>,
    /// Why the last round failed. None when it passed.
    reason: Option<String>,
    /// The last /api/health body that arrived, kept while the box is down.
    health: Option<Value>,
    hours: VecDeque<Hour>,
    events: VecDeque<Event>,
    /// From /api/errors, newest first.
    errors: Vec<Value>,
    errors_status: Option<String>,
    errors_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Hour {
    start: DateTime<Utc>,
    checks: u32,
    failed: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct Event {
    at: DateTime<Utc>,
    /// down, up, restart, build
    kind: String,
    text: String,
}

// ---- one round ----------------------------------------------------------------------

struct Probe {
    ok: bool,
    status: Option<u16>,
    latency_ms: u64,
    body: Option<Value>,
    reason: Option<String>,
}

async fn probe(client: &reqwest::Client, url: &str) -> Probe {
    let t0 = Instant::now();
    let res = client.get(format!("{url}/api/health")).send().await;
    let latency_ms = t0.elapsed().as_millis() as u64;
    match res {
        Err(e) => Probe { ok: false, status: None, latency_ms, body: None, reason: Some(error_text(&e)) },
        Ok(res) => {
            let status = res.status().as_u16();
            let body: Option<Value> = res.json().await.ok();
            let ok = status == 200;
            let reason = (!ok).then(|| describe_failure(status, body.as_ref()));
            Probe { ok, status: Some(status), latency_ms, body, reason }
        }
    }
}

fn error_text(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("no answer in {}s", PROBE_TIMEOUT.as_secs());
    }
    // the cause, not the wrappers: "error sending request: client error (Connect): tcp connect
    // error: Connection refused (os error 111): Connection refused (os error 111)" is one fact
    let mut parts: Vec<String> = vec![];
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        let s = err.to_string();
        let wrapper = s.starts_with("error sending request") || s.starts_with("client error") || s.starts_with("error trying to connect");
        let repeat = parts.last().is_some_and(|p| p.contains(&s));
        if !wrapper && !repeat {
            parts.push(s);
        }
        cur = err.source();
    }
    if parts.is_empty() {
        parts.push(e.to_string());
    }
    let text = parts.join(": ");
    // reqwest puts the url in; the page already shows it
    let text = match e.url() {
        Some(u) => text.replace(&format!(" for url ({u})"), ""),
        None => text,
    };
    text.chars().take(200).collect()
}

fn describe_failure(status: u16, body: Option<&Value>) -> String {
    if let Some(err) = body.and_then(|b| b.get("error")).and_then(Value::as_str) {
        return format!("{status}: {err}");
    }
    let down: Vec<&str> = ["postgres", "redis"]
        .into_iter()
        .filter(|k| body.and_then(|b| b.get(*k)).and_then(Value::as_bool) == Some(false))
        .collect();
    match (status, down.is_empty()) {
        (_, false) => format!("{status}: {} down", down.join(" and ")),
        (502 | 503 | 504, true) if body.is_none() => format!("{status}: caddy answers, the api behind it does not"),
        _ => format!("{status}"),
    }
}

/// Fold a round into the target. Returns the alerts to post (down, and up again).
fn apply(t: &mut TargetState, p: Probe, now: DateTime<Utc>, down_after: u32) -> Vec<String> {
    // the hourly tally
    let hour = now.duration_trunc(TimeDelta::hours(1)).unwrap_or(now);
    match t.hours.back_mut() {
        Some(h) if h.start == hour => {
            h.checks += 1;
            h.failed += (!p.ok) as u32;
        }
        _ => t.hours.push_back(Hour { start: hour, checks: 1, failed: (!p.ok) as u32 }),
    }
    while t.hours.len() > KEEP_HOURS {
        t.hours.pop_front();
    }

    // a restart shows as an uptime going backwards, a deploy as a new build
    let mut changes: Vec<(&str, String)> = vec![];
    if let (Some(prev), Some(cur)) = (t.health.as_ref(), p.body.as_ref()) {
        for (field, what) in [("up_secs", "api"), ("video_up_secs", "video")] {
            if let (Some(a), Some(b)) = (prev.get(field).and_then(Value::as_u64), cur.get(field).and_then(Value::as_u64)) {
                if b < a {
                    changes.push(("restart", format!("{what} restarted (had been up {})", human(a))));
                }
            }
        }
        for (field, what) in [("build", "api"), ("video_build", "video")] {
            if let (Some(a), Some(b)) = (prev.get(field).and_then(Value::as_str), cur.get(field).and_then(Value::as_str)) {
                if a != b {
                    changes.push(("build", format!("{what} build {a} → {b}")));
                }
            }
        }
    }
    for (kind, text) in changes {
        push_event(t, now, kind, text);
    }

    let mut alerts = vec![];
    if p.ok {
        let was = t.status;
        t.failures = 0;
        t.failing_since = None;
        if was != Status::Up {
            let text = match (was, t.since) {
                (Status::Down, Some(since)) => format!("{} UP after {}", t.name, human((now - since).num_seconds().max(0) as u64)),
                _ => format!("{} UP", t.name),
            };
            push_event(t, now, "up", text.clone());
            if was == Status::Down {
                alerts.push(text);
            }
            t.status = Status::Up;
            t.since = Some(now);
        }
    } else {
        t.failures += 1;
        if t.failing_since.is_none() {
            t.failing_since = Some(now);
        }
        if t.status != Status::Down && t.failures >= down_after {
            let text = format!("{} DOWN: {}", t.name, p.reason.clone().unwrap_or_else(|| "no answer".into()));
            push_event(t, now, "down", text.clone());
            alerts.push(text);
            t.status = Status::Down;
            t.since = t.failing_since;
        }
    }

    t.checked_at = Some(now);
    t.latency_ms = Some(p.latency_ms);
    t.http_status = p.status;
    t.reason = p.reason;
    if p.body.is_some() {
        t.health = p.body;
    }
    alerts
}

fn push_event(t: &mut TargetState, at: DateTime<Utc>, kind: &str, text: String) {
    t.events.push_back(Event { at, kind: kind.into(), text });
    while t.events.len() > KEEP_EVENTS {
        t.events.pop_front();
    }
}

/// "3d 4h", "4h 12m", "12m 05s", "42s"
fn human(secs: u64) -> String {
    let (d, h, m, s) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60, secs % 60);
    match (d, h, m) {
        (0, 0, 0) => format!("{s}s"),
        (0, 0, _) => format!("{m}m {s:02}s"),
        (0, _, _) => format!("{h}h {m:02}m"),
        _ => format!("{d}d {h}h"),
    }
}

/// Percent of rounds that passed over the newest `hours` entries. None before the first round.
fn uptime(hours: &VecDeque<Hour>, last: usize) -> Option<f64> {
    let (checks, failed) = hours.iter().rev().take(last).fold((0u64, 0u64), |(c, f), h| (c + h.checks as u64, f + h.failed as u64));
    (checks > 0).then(|| 100.0 * (checks - failed) as f64 / checks as f64)
}

// ---- the error reports ---------------------------------------------------------------

/// The newest rows from a target's /api/errors, or what it answered instead.
async fn pull_errors(client: &reqwest::Client, t: &Target) -> Result<Vec<Value>, String> {
    let Some(token) = &t.token else { return Err("no OPS_TOKEN for this box".into()) };
    let res = client
        .get(format!("{}/api/errors?limit={ERRORS_PULL}", t.url))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| error_text(&e))?;
    match res.status().as_u16() {
        200 => res.json::<Vec<Value>>().await.map_err(|e| format!("bad json: {e}")),
        401 => Err("401: token refused. OPS_TOKENS here and OPS_TOKEN in that box's .env must match".into()),
        404 => Err("404: that box has no ADMIN_NAMES and no OPS_TOKEN, so the route is off".into()),
        503 => Err("503: that api has no debug database".into()),
        code => Err(format!("{code}")),
    }
}

fn merge_errors(t: &mut TargetState, rows: Vec<Value>) {
    let known: HashSet<i64> = t.errors.iter().filter_map(|r| r.get("id").and_then(Value::as_i64)).collect();
    t.errors.extend(rows.into_iter().filter(|r| r.get("id").and_then(Value::as_i64).is_some_and(|id| !known.contains(&id))));
    // ids are a bigserial on that box, so newest first is highest first
    t.errors.sort_by_key(|r| std::cmp::Reverse(r.get("id").and_then(Value::as_i64).unwrap_or(0)));
    t.errors.truncate(KEEP_ERRORS);
}

// ---- the file -------------------------------------------------------------------------

async fn load(dir: &Path) -> Store {
    let path = dir.join(STORE_FILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(store) => store,
            Err(e) => {
                let bad = dir.join(format!("{STORE_FILE}.bad"));
                log::warn!("{} is not readable ({e}); starting over, the old one is at {}", path.display(), bad.display());
                let _ = tokio::fs::rename(&path, &bad).await;
                Store::default()
            }
        },
        Err(_) => Store::default(),
    }
}

async fn save(store: &Store, dir: &Path) -> anyhow::Result<()> {
    let tmp = dir.join(format!("{STORE_FILE}.tmp"));
    tokio::fs::write(&tmp, serde_json::to_vec(store)?).await?;
    tokio::fs::rename(&tmp, dir.join(STORE_FILE)).await?;
    Ok(())
}

/// The stored targets lined up with TARGETS: same name keeps its history (and takes the
/// new url), a new name starts empty, a name no longer listed is dropped.
fn reconcile(mut stored: Store, targets: &[Target]) -> Store {
    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        let mut s = match stored.targets.iter().position(|s| s.name == t.name) {
            Some(i) => stored.targets.swap_remove(i),
            None => TargetState { name: t.name.clone(), ..Default::default() },
        };
        s.url = t.url.clone();
        if t.token.is_none() {
            s.errors_status = Some("no OPS_TOKEN for this box".into());
        }
        out.push(s);
    }
    for gone in &stored.targets {
        log::info!("{}: not in TARGETS any more, its history goes", gone.name);
    }
    Store { targets: out }
}

// ---- the loops ------------------------------------------------------------------------

async fn check_loop(app: App) {
    let mut tick = tokio::time::interval(app.cfg.check_every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let now = Utc::now();
        // all boxes at once: a round takes as long as the slowest, not the sum
        let mut set = JoinSet::new();
        for (i, t) in app.cfg.targets.iter().enumerate() {
            let (client, url) = (app.boxes.clone(), t.url.clone());
            set.spawn(async move { (i, probe(&client, &url).await) });
        }
        let mut alerts = vec![];
        {
            let mut store = app.store.lock().await;
            while let Some(Ok((i, p))) = set.join_next().await {
                alerts.extend(apply(&mut store.targets[i], p, now, app.cfg.down_after));
            }
            if let Err(e) = save(&store, &app.cfg.data_dir).await {
                log::error!("could not write {}: {e}", app.cfg.data_dir.join(STORE_FILE).display());
            }
        }
        for text in alerts {
            log::warn!("{text}");
            alert(&app, &text).await;
        }
    }
}

async fn errors_loop(app: App) {
    let mut tick = tokio::time::interval(app.cfg.errors_every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let mut set = JoinSet::new();
        for (i, t) in app.cfg.targets.iter().enumerate().filter(|(_, t)| t.token.is_some()) {
            let (client, t) = (app.boxes.clone(), t.clone());
            set.spawn(async move { (i, pull_errors(&client, &t).await) });
        }
        let now = Utc::now();
        let mut store = app.store.lock().await;
        while let Some(Ok((i, result))) = set.join_next().await {
            let t = &mut store.targets[i];
            t.errors_at = Some(now);
            match result {
                Ok(rows) => {
                    merge_errors(t, rows);
                    t.errors_status = None;
                }
                Err(why) => t.errors_status = Some(why),
            }
        }
    }
}

async fn alert(app: &App, text: &str) {
    let Some(url) = &app.cfg.webhook else { return };
    // "content" is what discord reads, "text" what slack and most others do
    match app.hooks.post(url).json(&json!({ "content": text, "text": text })).send().await {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => log::warn!("the webhook answered {}", res.status()),
        Err(e) => log::warn!("the webhook: {}", error_text(&e)),
    }
}

// ---- the page and its json ------------------------------------------------------------

async fn page() -> Html<&'static str> {
    Html(PAGE)
}

async fn monitor_health(State(app): State<App>) -> Json<Value> {
    Json(json!({ "ok": true, "up_secs": app.started.elapsed().as_secs(), "targets": app.cfg.targets.len(), "build": app.cfg.build }))
}

async fn state(State(app): State<App>) -> Json<Value> {
    let store = app.store.lock().await;
    let targets: Vec<Value> = store.targets.iter().map(view).collect();
    Json(json!({
        "now": Utc::now(),
        "monitor": {
            "build": app.cfg.build,
            "up_secs": app.started.elapsed().as_secs(),
            "check_every_secs": app.cfg.check_every.as_secs(),
            "errors_every_secs": app.cfg.errors_every.as_secs(),
            "down_after": app.cfg.down_after,
            "webhook": app.cfg.webhook.is_some(),
        },
        "targets": targets,
    }))
}

fn view(t: &TargetState) -> Value {
    json!({
        "name": t.name,
        "url": t.url,
        "status": t.status,
        "since": t.since,
        "failures": t.failures,
        "checked_at": t.checked_at,
        "latency_ms": t.latency_ms,
        "http_status": t.http_status,
        "reason": t.reason,
        "health": t.health,
        "uptime_24h": uptime(&t.hours, 24),
        "uptime_7d": uptime(&t.hours, KEEP_HOURS),
        "hours": t.hours.iter().rev().take(24).collect::<Vec<_>>(),
        "events": t.events.iter().rev().take(30).collect::<Vec<_>>(),
        "errors": t.errors.iter().take(ERRORS_PULL).collect::<Vec<_>>(),
        "errors_status": t.errors_status,
        "errors_at": t.errors_at,
    })
}

// ---- boot -------------------------------------------------------------------------------

/// "a=1,b=2" → [(a, 1), (b, 2)]. Blank entries skipped, a bad one logged and skipped.
fn parse_pairs(what: &str, s: &str) -> Vec<(String, String)> {
    s.split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .filter_map(|e| match e.split_once('=') {
            Some((k, v)) if !k.trim().is_empty() && !v.trim().is_empty() => Some((k.trim().to_owned(), v.trim().to_owned())),
            _ => {
                log::warn!("{what}: cannot read {e:?}, want name=value");
                None
            }
        })
        .collect()
}

fn env_secs(key: &str, default: u64) -> Duration {
    Duration::from_secs(env::var(key).ok().and_then(|v| v.parse().ok()).filter(|s| *s > 0).unwrap_or(default))
}

fn config() -> Config {
    let one_token = env::var("OPS_TOKEN").ok().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    let tokens = parse_pairs("OPS_TOKENS", &env::var("OPS_TOKENS").unwrap_or_default());
    let targets = parse_pairs("TARGETS", &env::var("TARGETS").unwrap_or_default())
        .into_iter()
        .filter_map(|(name, url)| {
            let url = url.trim_end_matches('/').to_owned();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                log::warn!("TARGETS: {name}={url} is not a url, skipped");
                return None;
            }
            let token = tokens.iter().find(|(n, _)| *n == name).map(|(_, t)| t.clone()).or_else(|| one_token.clone());
            Some(Target { name, url, token })
        })
        .collect();
    Config {
        targets,
        webhook: env::var("ALERT_WEBHOOK").ok().map(|w| w.trim().to_owned()).filter(|w| !w.is_empty()),
        check_every: env_secs("CHECK_EVERY_SECS", 15),
        errors_every: env_secs("ERRORS_EVERY_SECS", 60),
        down_after: env::var("DOWN_AFTER").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(3),
        data_dir: PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into())),
        port: env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3002),
        build: env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into()),
    }
}

pub async fn run() -> anyhow::Result<()> {
    let cfg = Arc::new(config());
    match cfg.targets.len() {
        0 => log::warn!("TARGETS is empty: nothing to watch. prod=https://1.2.3.4,dev=https://… in .env, then docker compose up -d"),
        n => log::info!("watching {n} box(es) every {}s: {}", cfg.check_every.as_secs(), cfg.targets.iter().map(|t| format!("{}={}", t.name, t.url)).collect::<Vec<_>>().join(", ")),
    }
    for t in cfg.targets.iter().filter(|t| t.token.is_none()) {
        log::info!("{}: no OPS_TOKEN, so no error reports from it", t.name);
    }
    if cfg.webhook.is_none() {
        log::info!("no ALERT_WEBHOOK: down and up are logged here and shown on the page, nothing is posted");
    }

    tokio::fs::create_dir_all(&cfg.data_dir).await?;
    let store = reconcile(load(&cfg.data_dir).await, &cfg.targets);
    save(&store, &cfg.data_dir).await?;

    let app = App {
        cfg: cfg.clone(),
        store: Arc::new(Mutex::new(store)),
        started: Instant::now(),
        boxes: reqwest::Client::builder().timeout(PROBE_TIMEOUT).danger_accept_invalid_certs(true).build()?,
        hooks: reqwest::Client::builder().timeout(PROBE_TIMEOUT).build()?,
    };
    tokio::spawn(check_loop(app.clone()));
    tokio::spawn(errors_loop(app.clone()));

    let router = Router::new()
        .route("/", get(page))
        .route("/health", get(monitor_health))
        .route("/api/monitor", get(state))
        .with_state(app);
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    log::info!("monitor on {addr}, store {}", cfg.data_dir.join(STORE_FILE).display());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).with_graceful_shutdown(crate::wait_for_signal()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(up_secs: u64, build: &str) -> Probe {
        let body = json!({ "ok": true, "up_secs": up_secs, "build": build, "video_up_secs": up_secs, "video_build": build });
        Probe { ok: true, status: Some(200), latency_ms: 10, body: Some(body), reason: None }
    }
    fn dead() -> Probe {
        Probe { ok: false, status: None, latency_ms: 5000, body: None, reason: Some("no answer in 5s".into()) }
    }
    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + secs, 0).unwrap()
    }

    #[test]
    fn pairs() {
        assert_eq!(parse_pairs("x", " prod = https://a , dev=https://b/,,"), vec![("prod".to_owned(), "https://a".to_owned()), ("dev".to_owned(), "https://b/".to_owned())]);
        assert!(parse_pairs("x", "nonsense").is_empty());
        assert!(parse_pairs("x", "").is_empty());
    }

    #[test]
    fn up_down_up() {
        let mut t = TargetState { name: "prod".into(), ..Default::default() };
        // first sight: up, an event, no alert
        assert!(apply(&mut t, ok(100, "aaa"), at(0), 3).is_empty());
        assert_eq!(t.status, Status::Up);
        assert_eq!(t.events.back().unwrap().kind, "up");
        // two misses are not down yet
        assert!(apply(&mut t, dead(), at(15), 3).is_empty());
        assert!(apply(&mut t, dead(), at(30), 3).is_empty());
        assert_eq!((t.status, t.failures), (Status::Up, 2));
        // the third is, since the first miss, with the reason, and it alerts
        let alerts = apply(&mut t, dead(), at(45), 3);
        assert_eq!(alerts, vec!["prod DOWN: no answer in 5s"]);
        assert_eq!((t.status, t.since), (Status::Down, Some(at(15))));
        // back, with the downtime
        let alerts = apply(&mut t, ok(5, "aaa"), at(300), 3);
        assert_eq!(alerts, vec!["prod UP after 4m 45s"]);
        assert_eq!((t.status, t.since, t.failures), (Status::Up, Some(at(300)), 0));
        // and the uptime that reset on the way says it restarted
        assert!(t.events.iter().any(|e| e.kind == "restart" && e.text.starts_with("api restarted")));
        let (c, f) = t.hours.iter().fold((0, 0), |(c, f), h| (c + h.checks, f + h.failed));
        assert_eq!((c, f), (5, 3));
        assert_eq!(uptime(&t.hours, 24), Some(40.0));
    }

    #[test]
    fn a_new_build_is_an_event() {
        let mut t = TargetState::default();
        apply(&mut t, ok(10, "aaa"), at(0), 3);
        apply(&mut t, ok(20, "bbb"), at(15), 3);
        let builds: Vec<&str> = t.events.iter().filter(|e| e.kind == "build").map(|e| e.text.as_str()).collect();
        assert_eq!(builds, vec!["api build aaa → bbb", "video build aaa → bbb"]);
    }

    #[test]
    fn errors_merge_newest_first_without_repeats() {
        let mut t = TargetState::default();
        merge_errors(&mut t, vec![json!({ "id": 2 }), json!({ "id": 1 })]);
        merge_errors(&mut t, vec![json!({ "id": 3 }), json!({ "id": 2 })]);
        let ids: Vec<i64> = t.errors.iter().map(|r| r["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![3, 2, 1]);
    }

    #[test]
    fn reconcile_keeps_history_by_name() {
        let stored = Store { targets: vec![TargetState { name: "prod".into(), url: "https://old".into(), failures: 2, ..Default::default() }] };
        let targets = vec![
            Target { name: "dev".into(), url: "https://d".into(), token: None },
            Target { name: "prod".into(), url: "https://new".into(), token: Some("t".into()) },
        ];
        let out = reconcile(stored, &targets);
        assert_eq!(out.targets.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["dev", "prod"]);
        assert_eq!((out.targets[1].url.as_str(), out.targets[1].failures), ("https://new", 2));
        assert_eq!(out.targets[0].errors_status.as_deref(), Some("no OPS_TOKEN for this box"));
    }

    #[test]
    fn durations_read_well() {
        assert_eq!(human(42), "42s");
        assert_eq!(human(125), "2m 05s");
        assert_eq!(human(3600 * 4 + 60 * 12), "4h 12m");
        assert_eq!(human(86400 * 3 + 3600 * 4), "3d 4h");
    }
}
