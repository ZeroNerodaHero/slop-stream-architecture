use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SUB_BITS: usize = 3;
const SUB: usize = 1 << SUB_BITS;
const BUCKETS: usize = 240;
const MAX_KEYS: usize = 200;
pub const PORT: u16 = 9300;
const KEEP_FAULTS: usize = 100;
const MAX_NOTE: usize = 300;

fn bucket(us: u64) -> usize {
    if us < SUB as u64 {
        return us as usize;
    }
    let k = 63 - us.leading_zeros() as usize;
    (SUB * (k - SUB_BITS + 1) + ((us >> (k - SUB_BITS)) as usize & (SUB - 1))).min(BUCKETS - 1)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dir {
    Out,
    Inter,
}

impl Dir {
    fn as_str(self) -> &'static str {
        match self {
            Dir::Out => "out",
            Dir::Inter => "inter",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
struct Fault {
    at: i64,
    code: String,
    msg: String,
    ms: f64,
}

#[derive(Default)]
struct Faults {
    err: VecDeque<Fault>,
    e4: VecDeque<Fault>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn redact(word: &str) -> Option<&'static str> {
    let core = word.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | '"' | '\'' | '`'));
    let core = core.trim_end_matches(['.', ':']);
    if let Some((user, domain)) = core.split_once('@') {
        if !user.is_empty() && domain.contains('.') {
            return Some("<email>");
        }
    }
    let bare = core.split_once("://").map_or(core, |(_, rest)| rest);
    let host = bare.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(bare, |(h, _)| h);
    if host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok() {
        return Some("<ip>");
    }
    let secretish = core.len() >= 24
        && !core.starts_with('/')
        && core.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '='))
        && core.chars().any(|c| c.is_ascii_digit())
        && core.chars().any(|c| c.is_ascii_alphabetic());
    secretish.then_some("<secret>")
}

fn scrub(text: &str) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        match (redact(word), word.split_once('?')) {
            (Some(tag), _) => out.push_str(tag),
            (None, Some((path, _))) if word.contains("://") => {
                out.push_str(path);
                out.push_str("?…");
            }
            _ => out.push_str(word),
        }
        if out.len() > MAX_NOTE * 4 {
            break;
        }
    }
    if out.chars().count() > MAX_NOTE {
        out = out.chars().take(MAX_NOTE - 1).collect::<String>();
        out.push('…');
    }
    out
}

fn status_why(status: u16) -> (String, String) {
    let reason = axum::http::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("");
    (status.to_string(), reason.to_owned())
}

fn reqwest_why(res: &reqwest::Result<reqwest::Response>) -> (String, String) {
    match res {
        Ok(r) => status_why(r.status().as_u16()),
        Err(e) => {
            let code = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else if e.is_body() || e.is_decode() {
                "body"
            } else {
                "failed"
            };
            let mut msg = vec![];
            let mut cause = std::error::Error::source(e);
            while let Some(c) = cause {
                msg.push(c.to_string());
                cause = c.source();
            }
            (code.to_owned(), if msg.is_empty() { code.to_owned() } else { msg.join(": ") })
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Outcome {
    Ok,
    Client,
    Server,
    Failed,
}

fn outcome(status: u16) -> Outcome {
    match status {
        500.. => Outcome::Server,
        400.. => Outcome::Client,
        _ => Outcome::Ok,
    }
}

struct Entry {
    kind: &'static str,
    method: String,
    name: String,
    dir: Dir,
    n: AtomicU64,
    e4: AtomicU64,
    e5: AtomicU64,
    err: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
    msgs: AtomicU64,
    bytes: AtomicU64,
    open: AtomicI64,
    b: [AtomicU64; BUCKETS],
    faults: Mutex<Faults>,
}

#[derive(Serialize)]
struct Row {
    kind: &'static str,
    method: String,
    name: String,
    dir: &'static str,
    n: u64,
    e4: u64,
    e5: u64,
    err: u64,
    sum_us: u64,
    max_us: u64,
    msgs: u64,
    bytes: u64,
    open: u64,
    b: Vec<(u16, u64)>,
}

impl Entry {
    fn new(kind: &'static str, method: &str, name: &str, dir: Dir) -> Entry {
        let z = || AtomicU64::new(0);
        Entry {
            kind,
            method: method.to_owned(),
            name: name.to_owned(),
            dir,
            n: z(),
            e4: z(),
            e5: z(),
            err: z(),
            sum_us: z(),
            max_us: z(),
            msgs: z(),
            bytes: z(),
            open: AtomicI64::new(0),
            b: std::array::from_fn(|_| z()),
            faults: Mutex::new(Faults::default()),
        }
    }

    fn add_noted(&self, took: Duration, outcome: Outcome, why: impl FnOnce() -> (String, String)) {
        self.add(took, outcome);
        if outcome != Outcome::Ok {
            let (code, msg) = why();
            self.note(took, outcome, code, &msg);
        }
    }

    fn note(&self, took: Duration, outcome: Outcome, code: String, msg: &str) {
        let fault = Fault { at: now_ms(), code, msg: scrub(msg), ms: (took.as_micros() as f64 / 1000.0 * 1000.0).round() / 1000.0 };
        let mut f = self.faults.lock().unwrap_or_else(|e| e.into_inner());
        let ring = if outcome == Outcome::Client { &mut f.e4 } else { &mut f.err };
        if ring.len() >= KEEP_FAULTS {
            ring.pop_front();
        }
        ring.push_back(fault);
    }

    fn faults(&self) -> Vec<Fault> {
        let f = self.faults.lock().unwrap_or_else(|e| e.into_inner());
        let mut all: Vec<Fault> = f.err.iter().chain(f.e4.iter()).cloned().collect();
        all.sort_by_key(|x| std::cmp::Reverse(x.at));
        all
    }

    fn add(&self, took: Duration, outcome: Outcome) {
        let us = took.as_micros().min(u64::MAX as u128) as u64;
        self.n.fetch_add(1, Relaxed);
        self.sum_us.fetch_add(us, Relaxed);
        self.max_us.fetch_max(us, Relaxed);
        self.b[bucket(us)].fetch_add(1, Relaxed);
        match outcome {
            Outcome::Ok => {}
            Outcome::Client => {
                self.e4.fetch_add(1, Relaxed);
            }
            Outcome::Server => {
                self.e5.fetch_add(1, Relaxed);
                self.err.fetch_add(1, Relaxed);
            }
            Outcome::Failed => {
                self.err.fetch_add(1, Relaxed);
            }
        }
    }

    fn read(&self) -> Row {
        Row {
            kind: self.kind,
            method: self.method.clone(),
            name: self.name.clone(),
            dir: self.dir.as_str(),
            n: self.n.load(Relaxed),
            e4: self.e4.load(Relaxed),
            e5: self.e5.load(Relaxed),
            err: self.err.load(Relaxed),
            sum_us: self.sum_us.load(Relaxed),
            max_us: self.max_us.swap(0, Relaxed),
            msgs: self.msgs.load(Relaxed),
            bytes: self.bytes.load(Relaxed),
            open: self.open.load(Relaxed).max(0) as u64,
            b: self.b.iter().enumerate().filter_map(|(i, c)| Some((i as u16, c.load(Relaxed))).filter(|(_, c)| *c > 0)).collect(),
        }
    }
}

struct Registry {
    started: i64,
    map: RwLock<HashMap<String, Arc<Entry>>>,
}

static REG: LazyLock<Registry> = LazyLock::new(|| Registry { started: now_ms(), map: RwLock::new(HashMap::new()) });

fn line_key(kind: &str, method: &str, name: &str, dir: &str) -> String {
    format!("{kind}\u{1f}{method}\u{1f}{name}\u{1f}{dir}")
}

fn line(kind: &'static str, method: &str, name: &str, dir: Dir) -> Arc<Entry> {
    let key = line_key(kind, method, name, dir.as_str());
    if let Some(e) = REG.map.read().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return e.clone();
    }
    let mut map = REG.map.write().unwrap_or_else(|e| e.into_inner());
    if map.len() >= MAX_KEYS && !map.contains_key(&key) {
        let other = line_key(kind, "", "(other)", dir.as_str());
        return map.entry(other).or_insert_with(|| Arc::new(Entry::new(kind, "", "(other)", dir))).clone();
    }
    map.entry(key).or_insert_with(|| Arc::new(Entry::new(kind, method, name, dir))).clone()
}

pub fn open_pushes() -> u64 {
    REG.map.read().unwrap_or_else(|e| e.into_inner()).values().filter(|e| e.kind == "session").map(|e| e.open.load(Relaxed).max(0) as u64).sum()
}

pub struct Push {
    entry: Arc<Entry>,
    out: Arc<Entry>,
    started: Instant,
    why: Mutex<Option<String>>,
}

impl Push {
    pub fn open(platform: &str) -> Push {
        let entry = line("session", "rtmp", platform, Dir::Inter);
        let out = line("session", "rtmp", platform, Dir::Out);
        entry.open.fetch_add(1, Relaxed);
        Push { entry, out, started: Instant::now(), why: Mutex::new(None) }
    }

    pub fn sent(&self, bytes: u64) {
        if bytes > 0 {
            self.out.bytes.fetch_add(bytes, Relaxed);
        }
    }

    pub fn fail(&self, why: &str) {
        *self.why.lock().unwrap_or_else(|e| e.into_inner()) = Some(why.to_owned());
    }
}

impl Drop for Push {
    fn drop(&mut self) {
        self.entry.open.fetch_sub(1, Relaxed);
        let why = self.why.lock().unwrap_or_else(|e| e.into_inner()).take();
        let outcome = if why.is_some() { Outcome::Failed } else { Outcome::Ok };
        self.entry.add_noted(self.started.elapsed(), outcome, || ("dropped".into(), why.unwrap_or_default()));
    }
}

pub async fn call(method: &'static str, name: &'static str, req: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
    let started = Instant::now();
    let res = req.send().await;
    let out = match &res {
        Ok(r) => outcome(r.status().as_u16()),
        Err(_) => Outcome::Failed,
    };
    line("api", method, name, Dir::Inter).add_noted(started.elapsed(), out, || reqwest_why(&res));
    res
}

#[derive(Deserialize)]
struct FaultQuery {
    kind: String,
    #[serde(default)]
    method: String,
    name: String,
    #[serde(default)]
    dir: String,
}

fn faults_of(q: &FaultQuery) -> Value {
    let dir = match (q.dir.as_str(), q.kind.as_str()) {
        ("in" | "out" | "inter", _) => q.dir.as_str(),
        (_, "http" | "ws" | "session" | "setup") => "in",
        _ => "inter",
    };
    let found = REG.map.read().unwrap_or_else(|e| e.into_inner()).get(&line_key(&q.kind, &q.method, &q.name, dir)).cloned();
    json!({ "started": REG.started, "kept": KEEP_FAULTS, "rows": found.map(|e| e.faults()).unwrap_or_default() })
}

fn snapshot() -> Value {
    let rows: Vec<Row> = REG.map.read().unwrap_or_else(|e| e.into_inner()).values().map(|e| e.read()).filter(|r| r.n > 0 || r.msgs > 0 || r.bytes > 0 || r.open > 0).collect();
    json!({ "started": REG.started, "rows": rows })
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/timings", get(|| async { Json(snapshot()) }))
        .route("/timings/errors", get(|axum::extract::Query(q): axum::extract::Query<FaultQuery>| async move { Json(faults_of(&q)) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_match_the_api_s() {
        let pinned = [(0u64, 0usize), (7, 7), (8, 8), (15, 15), (16, 16), (1000, 63), (1_500_000, 147), (60_000_000, 190), (u64::MAX, 239)];
        for (us, i) in pinned {
            assert_eq!(bucket(us), i, "{us}us");
        }
    }

    #[test]
    fn a_push_is_a_session_between_services_with_its_drop_noted() {
        {
            let p = Push::open("test-twitch");
            p.sent(4000);
            p.sent(0);
            assert!(open_pushes() >= 1);
            let rows = snapshot()["rows"].as_array().unwrap().clone();
            let r = rows.iter().find(|r| r["name"] == "test-twitch" && r["dir"] == "inter").unwrap();
            assert_eq!((r["kind"].as_str(), r["method"].as_str()), (Some("session"), Some("rtmp")));
            assert_eq!((r["open"].as_u64(), r["n"].as_u64()), (Some(1), Some(0)));
            let o = rows.iter().find(|r| r["name"] == "test-twitch" && r["dir"] == "out").unwrap();
            assert_eq!((o["kind"].as_str(), o["method"].as_str(), o["bytes"].as_u64(), o["open"].as_u64()), (Some("session"), Some("rtmp"), Some(4000), Some(0)));
            p.fail("Connection to tcp://203.0.113.9:1935 failed: Connection refused");
        }
        {
            let _clean = Push::open("test-twitch");
        }
        let rows = snapshot()["rows"].as_array().unwrap().clone();
        let r = rows.iter().find(|r| r["name"] == "test-twitch" && r["dir"] == "inter").unwrap();
        assert_eq!((r["open"].as_u64(), r["n"].as_u64(), r["err"].as_u64()), (Some(0), Some(2), Some(1)));
        let q = FaultQuery { kind: "session".into(), method: "rtmp".into(), name: "test-twitch".into(), dir: "inter".into() };
        let notes = faults_of(&q)["rows"].as_array().unwrap().clone();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["code"], "dropped");
        assert!(notes[0]["msg"].as_str().unwrap().contains("<ip>"), "{}", notes[0]["msg"]);
        let unaddressed = FaultQuery { kind: "session".into(), method: "rtmp".into(), name: "test-twitch".into(), dir: String::new() };
        assert_eq!(faults_of(&unaddressed)["rows"].as_array().unwrap().len(), 0);
    }
}
