use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, DurationRound, SecondsFormat, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::task::JoinSet;

use crate::agent::{round, Container, Sample};
use crate::timings;

const PAGE: &str = include_str!("monitor.html");
const ICON_32: &[u8] = include_bytes!("stats-icon-32.png");
const ICON_180: &[u8] = include_bytes!("stats-icon-180.png");
const STORE_FILE: &str = "monitor.json";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const KEEP_HOURS: usize = 24 * 7;
const KEEP_EVENTS: usize = 200;
const KEEP_ERRORS: usize = 100;
const ERRORS_PULL: usize = 50;
const METRICS_FILE: &str = "metrics.json";
const METRICS_SAVE_EVERY: Duration = Duration::from_secs(300);
const TIERS: [(&str, i64, usize); 3] = [("1h", 15, 240), ("24h", 120, 720), ("7d", 900, 672)];
const HOST_SERIES: [&str; 12] = ["cpu_pct", "steal_pct", "iowait_pct", "load1", "mem_used", "swap_used", "disk_used", "rx_bps", "tx_bps", "psi_cpu", "psi_memory", "psi_io"];
const CONTAINER_SERIES: [&str; 7] = ["cpu_pct", "mem_bytes", "rx_bps", "tx_bps", "read_bps", "write_bps", "pids"];

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
    metrics_every: Duration,
    down_after: u32,
    data_dir: PathBuf,
    port: u16,
    build: String,
    public: bool,
}

#[derive(Clone)]
struct App {
    cfg: Arc<Config>,
    store: Arc<Mutex<Store>>,
    metrics: Arc<Mutex<HashMap<String, History>>>,
    started: Instant,
    boxes: reqwest::Client,
    hooks: reqwest::Client,
}

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
    since: Option<DateTime<Utc>>,
    failures: u32,
    failing_since: Option<DateTime<Utc>>,
    checked_at: Option<DateTime<Utc>>,
    latency_ms: Option<u64>,
    http_status: Option<u16>,
    reason: Option<String>,
    health: Option<Value>,
    hours: VecDeque<Hour>,
    events: VecDeque<Event>,
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
    kind: String,
    text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Point {
    t: i64,
    n: u32,
    h: Vec<Option<f64>>,
    c: BTreeMap<String, Vec<Option<f64>>>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct History {
    latest: Option<Sample>,
    tiers: Vec<VecDeque<Point>>,
    status: Option<String>,
    checked_at: Option<DateTime<Utc>>,
    agent: Option<Value>,
    timings: timings::History,
    agent_failures: u32,
    agent_down: bool,
}

fn agent_check(h: &mut History, name: &str, result: Result<(), &str>, down_after: u32) -> Option<(&'static str, String)> {
    match result {
        Ok(()) => {
            h.agent_failures = 0;
            if !h.agent_down {
                return None;
            }
            h.agent_down = false;
            Some(("agent-up", format!("{name} agent UP")))
        }
        Err(why) => {
            h.agent_failures += 1;
            if h.agent_down || h.agent_failures < down_after {
                return None;
            }
            h.agent_down = true;
            Some(("agent-down", format!("{name} agent DOWN: {why}")))
        }
    }
}

fn host_values(s: &Sample) -> Vec<Option<f64>> {
    let h = &s.host;
    let b = |v: Option<u64>| v.map(|x| x as f64);
    let net = h.net.as_ref();
    vec![
        h.cpu_pct,
        h.steal_pct,
        h.iowait_pct,
        h.load1,
        b(h.mem_used),
        b(h.swap_used),
        h.disk.first().map(|d| d.used as f64),
        net.and_then(|n| n.rx_bps),
        net.and_then(|n| n.tx_bps),
        h.pressure.cpu,
        h.pressure.memory,
        h.pressure.io,
    ]
}

fn container_values(c: &Container) -> Vec<Option<f64>> {
    let b = |v: Option<u64>| v.map(|x| x as f64);
    vec![c.cpu_pct, b(c.mem_bytes), c.rx_bps, c.tx_bps, c.read_bps, c.write_bps, b(c.pids)]
}

fn compact(v: f64) -> f64 {
    round(v, if v.abs() >= 1000.0 { 0 } else { 2 })
}

fn mix(into: &mut [Option<f64>], new: &[Option<f64>], n: u32) {
    for (a, b) in into.iter_mut().zip(new) {
        *a = match (*a, *b) {
            (Some(x), Some(y)) => Some(compact((x * n as f64 + y) / (n as f64 + 1.0))),
            (None, y) => y,
            (x, None) => x,
        };
    }
}

fn fold(tier: &mut VecDeque<Point>, width: i64, keep: usize, t: i64, h: &[Option<f64>], c: &BTreeMap<String, Vec<Option<f64>>>) {
    let start = t - t.rem_euclid(width);
    match tier.back_mut() {
        Some(p) if p.t == start => {
            mix(&mut p.h, h, p.n);
            for (name, vals) in c {
                match p.c.get_mut(name) {
                    Some(old) => mix(old, vals, p.n),
                    None => {
                        p.c.insert(name.clone(), vals.clone());
                    }
                }
            }
            p.n += 1;
        }
        Some(p) if p.t > start => {}
        _ => tier.push_back(Point { t: start, n: 1, h: h.to_vec(), c: c.clone() }),
    }
    let oldest = start - width * keep as i64;
    while tier.len() > keep || tier.front().is_some_and(|p| p.t <= oldest) {
        tier.pop_front();
    }
}

impl History {
    fn add(&mut self, mut s: Sample) {
        if self.latest.as_ref().is_some_and(|l| l.at >= s.at) {
            return;
        }
        let rows = std::mem::take(&mut s.timings);
        self.timings.add(s.at.timestamp(), &rows);
        self.tiers.resize_with(TIERS.len(), VecDeque::new);
        let h: Vec<Option<f64>> = host_values(&s).into_iter().map(|v| v.map(compact)).collect();
        let c: BTreeMap<String, Vec<Option<f64>>> = s
            .containers
            .iter()
            .filter(|c| c.state == "running")
            .map(|c| (c.name.clone(), container_values(c).into_iter().map(|v| v.map(compact)).collect()))
            .collect();
        for (tier, (_, width, keep)) in self.tiers.iter_mut().zip(TIERS) {
            fold(tier, width, keep, s.at.timestamp(), &h, &c);
        }
        self.latest = Some(s);
    }

    fn series(&self, tier: usize) -> Value {
        let empty = VecDeque::new();
        let pts = self.tiers.get(tier).unwrap_or(&empty);
        let host: serde_json::Map<String, Value> =
            HOST_SERIES.iter().enumerate().map(|(i, name)| (name.to_string(), json!(pts.iter().map(|p| p.h.get(i).copied().flatten()).collect::<Vec<_>>()))).collect();
        let names: BTreeSet<&String> = pts.iter().flat_map(|p| p.c.keys()).collect();
        let containers: serde_json::Map<String, Value> = names
            .into_iter()
            .map(|name| {
                let per: serde_json::Map<String, Value> = CONTAINER_SERIES
                    .iter()
                    .enumerate()
                    .map(|(i, s)| (s.to_string(), json!(pts.iter().map(|p| p.c.get(name).and_then(|v| v.get(i).copied().flatten())).collect::<Vec<_>>())))
                    .collect();
                (name.clone(), Value::Object(per))
            })
            .collect();
        json!({
            "t": pts.iter().map(|p| p.t).collect::<Vec<_>>(),
            "host": host,
            "containers": containers,
        })
    }

    fn summary(&self) -> Value {
        let latest = self.latest.as_ref();
        json!({
            "status": self.status,
            "checked_at": self.checked_at,
            "at": latest.map(|s| s.at),
            "host": latest.map(|s| &s.host),
            "containers": latest.map(|s| s.containers.iter().filter(|c| c.state == "running").count()),
            "problems": latest.map(|s| &s.problems),
        })
    }
}

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

fn apply(t: &mut TargetState, p: Probe, now: DateTime<Utc>, down_after: u32) -> Vec<String> {
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

    let mut changes: Vec<(&str, String)> = vec![];
    if let (Some(prev), Some(cur)) = (t.health.as_ref(), p.body.as_ref()) {
        for (field, what) in [("up_secs", "api"), ("video_up_secs", "video")] {
            if let (Some(a), Some(b)) = (prev.get(field).and_then(Value::as_u64), cur.get(field).and_then(Value::as_u64)) {
                if b < a {
                    changes.push(("restart", format!("{what} restarted (had been up {})", human(a))));
                }
            }
        }
        for (field, what) in [("build", "api build"), ("video_build", "video build"), ("version", "release")] {
            if let (Some(a), Some(b)) = (prev.get(field).and_then(Value::as_str), cur.get(field).and_then(Value::as_str)) {
                if a != b {
                    changes.push(("build", format!("{what} {a} → {b}")));
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

fn human(secs: u64) -> String {
    let (d, h, m, s) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60, secs % 60);
    match (d, h, m) {
        (0, 0, 0) => format!("{s}s"),
        (0, 0, _) => format!("{m}m {s:02}s"),
        (0, _, _) => format!("{h}h {m:02}m"),
        _ => format!("{d}d {h}h"),
    }
}

fn uptime(hours: &VecDeque<Hour>, last: usize) -> Option<f64> {
    let (checks, failed) = hours.iter().rev().take(last).fold((0u64, 0u64), |(c, f), h| (c + h.checks as u64, f + h.failed as u64));
    (checks > 0).then(|| 100.0 * (checks - failed) as f64 / checks as f64)
}

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

#[derive(Deserialize)]
struct MetricsAnswer {
    #[serde(default)]
    agent: Option<Value>,
    #[serde(default)]
    samples: Vec<Sample>,
}

async fn pull_metrics(client: &reqwest::Client, t: &Target, since: Option<DateTime<Utc>>) -> Result<MetricsAnswer, String> {
    let Some(token) = &t.token else { return Err("no OPS_TOKEN for this box".into()) };
    let since = since.unwrap_or(DateTime::UNIX_EPOCH).to_rfc3339_opts(SecondsFormat::Micros, true);
    let res = client.get(format!("{}/api/metrics", t.url)).query(&[("since", since)]).bearer_auth(token).send().await.map_err(|e| error_text(&e))?;
    match res.status().as_u16() {
        200 => res.json::<MetricsAnswer>().await.map_err(|e| format!("bad json: {e}")),
        401 => Err("401: token refused. OPS_TOKENS here and OPS_TOKEN in that box's .env must match".into()),
        404 => Err("404: that box has no OPS_TOKEN for its agent, or its Caddyfile predates /api/metrics".into()),
        code @ (502 | 503 | 504) => Err(format!("{code}: caddy answers, the agent behind it does not")),
        code => Err(format!("{code}")),
    }
}

fn merge_errors(t: &mut TargetState, rows: Vec<Value>) {
    let known: HashSet<i64> = t.errors.iter().filter_map(|r| r.get("id").and_then(Value::as_i64)).collect();
    t.errors.extend(rows.into_iter().filter(|r| r.get("id").and_then(Value::as_i64).is_some_and(|id| !known.contains(&id))));
    t.errors.sort_by_key(|r| std::cmp::Reverse(r.get("id").and_then(Value::as_i64).unwrap_or(0)));
    t.errors.truncate(KEEP_ERRORS);
}

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

async fn load_metrics(dir: &Path, targets: &[Target]) -> HashMap<String, History> {
    let path = dir.join(METRICS_FILE);
    let mut stored: HashMap<String, History> = match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("{} is not readable ({e}); metrics history starts over", path.display());
            HashMap::new()
        }),
        Err(_) => HashMap::new(),
    };
    targets.iter().map(|t| (t.name.clone(), stored.remove(&t.name).unwrap_or_default())).collect()
}

async fn save_metrics(app: &App) {
    let bytes = {
        let m = app.metrics.lock().await;
        serde_json::to_vec(&*m)
    };
    let dir = &app.cfg.data_dir;
    let tmp = dir.join(format!("{METRICS_FILE}.tmp"));
    let result = match bytes {
        Ok(b) => match tokio::fs::write(&tmp, b).await {
            Ok(()) => tokio::fs::rename(&tmp, dir.join(METRICS_FILE)).await.map_err(anyhow::Error::from),
            Err(e) => Err(e.into()),
        },
        Err(e) => Err(e.into()),
    };
    if let Err(e) = result {
        log::error!("could not write {}: {e}", dir.join(METRICS_FILE).display());
    }
}

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

async fn check_loop(app: App) {
    let mut tick = tokio::time::interval(app.cfg.check_every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let now = Utc::now();
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

async fn metrics_loop(app: App) {
    let mut tick = tokio::time::interval(app.cfg.metrics_every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut saved = Instant::now();
    loop {
        tick.tick().await;
        let since: Vec<Option<DateTime<Utc>>> = {
            let m = app.metrics.lock().await;
            app.cfg.targets.iter().map(|t| m.get(&t.name).and_then(|h| h.latest.as_ref()).map(|s| s.at)).collect()
        };
        let mut set = JoinSet::new();
        for (i, t) in app.cfg.targets.iter().enumerate() {
            let (client, t, since) = (app.boxes.clone(), t.clone(), since[i]);
            set.spawn(async move { (t.name.clone(), pull_metrics(&client, &t, since).await) });
        }
        let mut results = vec![];
        while let Some(Ok(r)) = set.join_next().await {
            results.push(r);
        }
        let now = Utc::now();
        let mut changes = vec![];
        {
            let mut m = app.metrics.lock().await;
            for (name, result) in results {
                let has_token = app.cfg.targets.iter().any(|t| t.name == name && t.token.is_some());
                let h = m.entry(name.clone()).or_default();
                h.checked_at = Some(now);
                if has_token {
                    if let Some(change) = agent_check(h, &name, result.as_ref().map(|_| ()).map_err(String::as_str), app.cfg.down_after) {
                        changes.push((name, change));
                    }
                }
                match result {
                    Ok(answer) => {
                        let mut samples = answer.samples;
                        samples.sort_by_key(|s| s.at);
                        for s in samples {
                            h.add(s);
                        }
                        h.agent = answer.agent;
                        h.status = None;
                    }
                    Err(why) => h.status = Some(why),
                }
            }
        }
        let mut alerts = vec![];
        if !changes.is_empty() {
            let mut store = app.store.lock().await;
            for (name, (kind, text)) in changes {
                let Some(t) = store.targets.iter_mut().find(|t| t.name == name) else { continue };
                push_event(t, now, kind, text.clone());
                if t.status != Status::Down {
                    alerts.push(text);
                }
            }
        }
        for text in alerts {
            log::warn!("{text}");
            alert(&app, &text).await;
        }
        if saved.elapsed() >= METRICS_SAVE_EVERY {
            save_metrics(&app).await;
            saved = Instant::now();
        }
    }
}

async fn alert(app: &App, text: &str) {
    let Some(url) = &app.cfg.webhook else { return };
    match app.hooks.post(url).json(&json!({ "content": text, "text": text })).send().await {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => log::warn!("the webhook answered {}", res.status()),
        Err(e) => log::warn!("the webhook: {}", error_text(&e)),
    }
}

async fn page() -> Html<&'static str> {
    Html(PAGE)
}

async fn icon_small() -> impl IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/png")], ICON_32)
}

async fn icon_large() -> impl IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/png")], ICON_180)
}

async fn monitor_health(State(app): State<App>) -> Json<Value> {
    Json(json!({ "ok": true, "up_secs": app.started.elapsed().as_secs(), "targets": app.cfg.targets.len(), "build": app.cfg.build }))
}

async fn state(State(app): State<App>) -> Json<Value> {
    let store = app.store.lock().await;
    let metrics = app.metrics.lock().await;
    let targets: Vec<Value> = store
        .targets
        .iter()
        .map(|t| {
            let mut v = view(t, app.cfg.public);
            v["metrics"] = metrics.get(&t.name).map(History::summary).unwrap_or(Value::Null);
            v
        })
        .collect();
    Json(json!({
        "now": Utc::now(),
        "monitor": {
            "build": app.cfg.build,
            "up_secs": app.started.elapsed().as_secs(),
            "check_every_secs": app.cfg.check_every.as_secs(),
            "errors_every_secs": app.cfg.errors_every.as_secs(),
            "metrics_every_secs": app.cfg.metrics_every.as_secs(),
            "down_after": app.cfg.down_after,
            "webhook": app.cfg.webhook.is_some(),
            "public": app.cfg.public,
        },
        "targets": targets,
    }))
}

#[derive(Deserialize)]
struct SeriesQuery {
    target: String,
    range: Option<String>,
}

async fn series(State(app): State<App>, Query(q): Query<SeriesQuery>) -> Response {
    let range = q.range.unwrap_or_else(|| "1h".into());
    let Some(tier) = TIERS.iter().position(|(name, _, _)| *name == range) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "range: 1h, 24h or 7d" }))).into_response();
    };
    let m = app.metrics.lock().await;
    let Some(h) = m.get(&q.target) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "no such box" }))).into_response();
    };
    let mut out = h.series(tier);
    out["target"] = json!(q.target);
    out["range"] = json!(range);
    out["bucket_secs"] = json!(TIERS[tier].1);
    out["now"] = json!(Utc::now());
    out["latest"] = json!(h.latest);
    out["status"] = json!(h.status);
    out["checked_at"] = json!(h.checked_at);
    out["agent"] = json!(h.agent);
    Json(out).into_response()
}

#[derive(Deserialize)]
struct TargetQuery {
    target: String,
}

async fn architecture(State(app): State<App>, Query(q): Query<TargetQuery>) -> Response {
    let m = app.metrics.lock().await;
    let Some(h) = m.get(&q.target) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "no such box" }))).into_response();
    };
    let mut out = match &h.latest {
        Some(s) => crate::architecture::graph(s),
        None => json!({ "at": null, "nodes": [], "edges": [], "networks": [] }),
    };
    out["target"] = json!(q.target);
    out["status"] = json!(h.status);
    out["now"] = json!(Utc::now());
    Json(out).into_response()
}

#[derive(Deserialize)]
struct TimingQuery {
    target: Option<String>,
    key: Option<String>,
    range: Option<String>,
}

fn timing_tier(range: &Option<String>) -> Result<(usize, &'static str), Response> {
    let range = range.as_deref().unwrap_or("1h");
    timings::TIERS
        .iter()
        .position(|(name, _, _)| *name == range)
        .map(|i| (i, timings::TIERS[i].0))
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({ "error": "range: 1h, 24h or 7d" }))).into_response())
}

async fn timing_table(State(app): State<App>, Query(q): Query<TimingQuery>) -> Response {
    let (tier, range) = match timing_tier(&q.range) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let now = Utc::now().timestamp();
    let m = app.metrics.lock().await;
    let mut rows = vec![];
    let mut totals = vec![];
    let mut all = timings::Totals::default();
    let mut dropped = serde_json::Map::new();
    for t in app.cfg.targets.iter().filter(|t| q.target.as_ref().is_none_or(|want| *want == t.name)) {
        if let Some(h) = m.get(&t.name) {
            let (r, kinds) = h.timings.table(tier, now, &t.name);
            rows.extend(r);
            totals.extend(kinds.rows(Some(&t.name)));
            all.merge(&kinds);
            if h.timings.dropped() > 0 {
                dropped.insert(t.name.clone(), json!(h.timings.dropped()));
            }
        }
    }
    totals.extend(all.rows(None));
    Json(json!({
        "range": range,
        "bucket_secs": timings::TIERS[tier].1,
        "now": Utc::now(),
        "targets": app.cfg.targets.iter().map(|t| &t.name).collect::<Vec<_>>(),
        "dropped": dropped,
        "rows": rows,
        "totals": totals,
    }))
    .into_response()
}

async fn timing_series(State(app): State<App>, Query(q): Query<TimingQuery>) -> Response {
    let (tier, range) = match timing_tier(&q.range) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let now = Utc::now().timestamp();
    let m = app.metrics.lock().await;
    let found = q.target.as_ref().and_then(|t| m.get(t)).zip(q.key.as_ref()).and_then(|(h, key)| h.timings.detail(key, tier, now));
    match found {
        Some(mut v) => {
            v["target"] = json!(q.target);
            v["range"] = json!(range);
            v["now"] = json!(Utc::now());
            Json(v).into_response()
        }
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "no such box or line" }))).into_response(),
    }
}

fn view(t: &TargetState, public: bool) -> Value {
    let (errors, errors_status) = if public {
        (Vec::new(), Some(format!("{} stored, hidden: this page is public (STATS_PUBLIC), and a report names the visitor's ip and login", t.errors.len())))
    } else {
        (t.errors.iter().take(ERRORS_PULL).collect::<Vec<_>>(), t.errors_status.clone())
    };
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
        "errors": errors,
        "errors_status": errors_status,
        "errors_at": t.errors_at,
    })
}

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
        metrics_every: env_secs("METRICS_EVERY_SECS", 15),
        down_after: env::var("DOWN_AFTER").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(3),
        data_dir: PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into())),
        port: env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3002),
        build: env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into()),
        public: env::var("PUBLIC").is_ok_and(|p| p.trim() == "true"),
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
    if cfg.public {
        log::warn!("PUBLIC=true: this page has no password in front of it, so error reports are left out of /api/monitor");
    }
    if cfg.webhook.is_none() {
        log::info!("no ALERT_WEBHOOK: down and up are logged here and shown on the page, nothing is posted");
    }

    tokio::fs::create_dir_all(&cfg.data_dir).await?;
    let store = reconcile(load(&cfg.data_dir).await, &cfg.targets);
    save(&store, &cfg.data_dir).await?;
    let metrics = load_metrics(&cfg.data_dir, &cfg.targets).await;

    let app = App {
        cfg: cfg.clone(),
        store: Arc::new(Mutex::new(store)),
        metrics: Arc::new(Mutex::new(metrics)),
        started: Instant::now(),
        boxes: reqwest::Client::builder().timeout(PROBE_TIMEOUT).danger_accept_invalid_certs(true).build()?,
        hooks: reqwest::Client::builder().timeout(PROBE_TIMEOUT).build()?,
    };
    tokio::spawn(check_loop(app.clone()));
    tokio::spawn(errors_loop(app.clone()));
    tokio::spawn(metrics_loop(app.clone()));

    let router = Router::new()
        .route("/", get(page))
        .route("/favicon.ico", get(icon_small))
        .route("/icon-32.png", get(icon_small))
        .route("/icon.png", get(icon_large))
        .route("/health", get(monitor_health))
        .route("/api/monitor", get(state))
        .route("/api/monitor/metrics", get(series))
        .route("/api/monitor/timings", get(timing_table))
        .route("/api/monitor/timings/series", get(timing_series))
        .route("/api/monitor/architecture", get(architecture))
        .route_layer(axum::middleware::from_fn_with_state(crate::ratelimit::Local::default(), crate::ratelimit::local))
        .layer(axum::middleware::map_response(crate::agent::no_store))
        .with_state(app.clone());
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    log::info!("monitor on {addr}, store {}", cfg.data_dir.join(STORE_FILE).display());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(crate::wait_for_signal()).await?;
    save_metrics(&app).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_icons_are_pngs_the_page_links() {
        for (icon, side) in [(ICON_32, 32u32), (ICON_180, 180)] {
            assert_eq!(&icon[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(u32::from_be_bytes(icon[16..20].try_into().unwrap()), side);
            assert_eq!(u32::from_be_bytes(icon[20..24].try_into().unwrap()), side);
        }
        for href in ["href=\"/icon-32.png\"", "href=\"/icon.png\"", "src=\"/icon.png\""] {
            assert!(PAGE.contains(href), "the page has no {href}");
        }
    }

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
        assert!(apply(&mut t, ok(100, "aaa"), at(0), 3).is_empty());
        assert_eq!(t.status, Status::Up);
        assert_eq!(t.events.back().unwrap().kind, "up");
        assert!(apply(&mut t, dead(), at(15), 3).is_empty());
        assert!(apply(&mut t, dead(), at(30), 3).is_empty());
        assert_eq!((t.status, t.failures), (Status::Up, 2));
        let alerts = apply(&mut t, dead(), at(45), 3);
        assert_eq!(alerts, vec!["prod DOWN: no answer in 5s"]);
        assert_eq!((t.status, t.since), (Status::Down, Some(at(15))));
        let alerts = apply(&mut t, ok(5, "aaa"), at(300), 3);
        assert_eq!(alerts, vec!["prod UP after 4m 45s"]);
        assert_eq!((t.status, t.since, t.failures), (Status::Up, Some(at(300)), 0));
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
    fn a_new_release_is_an_event() {
        let mut t = TargetState::default();
        let (mut a, mut b) = (ok(10, "aaa"), ok(20, "aaa"));
        a.body.as_mut().unwrap()["version"] = json!("v12");
        b.body.as_mut().unwrap()["version"] = json!("v13");
        apply(&mut t, a, at(0), 3);
        apply(&mut t, b, at(15), 3);
        let builds: Vec<&str> = t.events.iter().filter(|e| e.kind == "build").map(|e| e.text.as_str()).collect();
        assert_eq!(builds, vec!["release v12 → v13"]);
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
    fn a_public_page_shows_no_error_reports() {
        let mut t = TargetState::default();
        merge_errors(&mut t, vec![json!({ "id": 1, "ip": "203.0.113.9", "name": "billy" })]);
        assert_eq!(view(&t, false)["errors"][0]["ip"], "203.0.113.9");
        let public = view(&t, true);
        assert_eq!(public["errors"], json!([]));
        assert!(public["errors_status"].as_str().unwrap().starts_with("1 stored, hidden"));
        assert!(!public.to_string().contains("203.0.113.9"));
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
    fn agent_down_after_misses_and_up_once() {
        let mut h = History::default();
        assert_eq!(agent_check(&mut h, "prod", Ok(()), 3), None);
        assert_eq!(agent_check(&mut h, "prod", Err("no answer in 5s"), 3), None);
        assert_eq!(agent_check(&mut h, "prod", Err("no answer in 5s"), 3), None);
        assert_eq!(agent_check(&mut h, "prod", Err("502: caddy answers, the agent behind it does not"), 3), Some(("agent-down", "prod agent DOWN: 502: caddy answers, the agent behind it does not".into())));
        assert_eq!(agent_check(&mut h, "prod", Err("no answer in 5s"), 3), None);
        assert_eq!(agent_check(&mut h, "prod", Ok(()), 3), Some(("agent-up", "prod agent UP".into())));
        assert_eq!(agent_check(&mut h, "prod", Ok(()), 3), None);
        assert_eq!(agent_check(&mut h, "prod", Err("x"), 3), None);
        assert_eq!(h.agent_failures, 1);
    }

    fn sample(secs: i64, cpu: f64, containers: &[(&str, f64)]) -> Sample {
        let mut s = Sample { at: at(secs), ..Default::default() };
        s.host.cpu_pct = Some(cpu);
        s.host.mem_used = Some(1_000_000);
        s.containers = containers
            .iter()
            .map(|(name, cpu)| Container { name: name.to_string(), state: "running".into(), cpu_pct: Some(*cpu), ..Default::default() })
            .collect();
        s.containers.push(Container { name: "stopped".into(), state: "exited".into(), ..Default::default() });
        s
    }

    #[test]
    fn samples_fold_into_the_three_ranges() {
        let mut h = History::default();
        for i in 0..8 {
            h.add(sample(i * 15, (i * 10) as f64, &[("api", 1.0 + i as f64)]));
        }
        assert_eq!(h.tiers[0].len(), 8);
        assert_eq!(h.tiers[1].len(), 1);
        assert_eq!(h.tiers[1][0].n, 8);
        assert_eq!(h.tiers[1][0].h[0], Some(35.0));
        assert_eq!(h.tiers[1][0].c["api"][0], Some(4.5));
        assert!(!h.tiers[1][0].c.contains_key("stopped"));
        h.add(sample(120, 99.0, &[("api", 1.0), ("video", 50.0)]));
        assert_eq!(h.tiers[1].len(), 2);
        assert_eq!(h.tiers[1][1].c["video"][0], Some(50.0));
        h.add(sample(60, 1.0, &[]));
        assert_eq!(h.tiers[0].len(), 9, "an older sample than the newest is ignored");
    }

    #[test]
    fn a_range_keeps_its_window() {
        let mut tier = VecDeque::new();
        for i in 0..300 {
            fold(&mut tier, 15, 240, i * 15, &[Some(1.0)], &BTreeMap::new());
        }
        assert_eq!(tier.len(), 240);
        fold(&mut tier, 15, 240, 300 * 15 + 3600 * 2, &[Some(1.0)], &BTreeMap::new());
        assert_eq!(tier.len(), 1, "after a long gap the old points are past the window");
    }

    #[test]
    fn series_are_columns_with_gaps() {
        let mut h = History::default();
        h.add(sample(0, 10.0, &[("api", 1.0)]));
        h.add(sample(15, 20.0, &[("api", 2.0), ("video", 9.0)]));
        let s = h.series(0);
        assert_eq!(s["t"], json!([at(0).timestamp(), at(15).timestamp()]));
        assert_eq!(s["host"]["cpu_pct"], json!([10.0, 20.0]));
        assert_eq!(s["host"]["mem_used"], json!([1_000_000.0, 1_000_000.0]));
        assert_eq!(s["containers"]["video"]["cpu_pct"], json!([null, 9.0]));
        assert_eq!(s["containers"]["api"]["cpu_pct"], json!([1.0, 2.0]));
        assert_eq!(h.summary()["containers"], json!(2));
        let back: HashMap<String, History> = serde_json::from_slice(&serde_json::to_vec(&HashMap::from([("prod".to_string(), h)])).unwrap()).unwrap();
        assert_eq!(back["prod"].tiers[0].len(), 2);
    }

    #[test]
    fn durations_read_well() {
        assert_eq!(human(42), "42s");
        assert_eq!(human(125), "2m 05s");
        assert_eq!(human(3600 * 4 + 60 * 12), "4h 12m");
        assert_eq!(human(86400 * 3 + 3600 * 4), "3d 4h");
    }
}
