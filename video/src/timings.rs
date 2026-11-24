use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};

const SUB_BITS: usize = 3;
const SUB: usize = 1 << SUB_BITS;
const BUCKETS: usize = 240;
const MAX_KEYS: usize = 200;
const PORT: u16 = 9300;

fn bucket(us: u64) -> usize {
    if us < SUB as u64 {
        return us as usize;
    }
    let k = 63 - us.leading_zeros() as usize;
    (SUB * (k - SUB_BITS + 1) + ((us >> (k - SUB_BITS)) as usize & (SUB - 1))).min(BUCKETS - 1)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dir {
    In,
    Out,
    Inter,
}

impl Dir {
    fn as_str(self) -> &'static str {
        match self {
            Dir::In => "in",
            Dir::Out => "out",
            Dir::Inter => "inter",
        }
    }
}

#[derive(Clone, Copy)]
pub enum Outcome {
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

pub struct Entry {
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
        }
    }

    pub fn add(&self, took: Duration, outcome: Outcome) {
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

    pub fn count(&self, msgs: u64, bytes: u64) {
        self.msgs.fetch_add(msgs, Relaxed);
        self.bytes.fetch_add(bytes, Relaxed);
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

static REG: LazyLock<Registry> = LazyLock::new(|| Registry {
    started: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0),
    map: RwLock::new(HashMap::new()),
});

pub fn line(kind: &'static str, method: &str, name: &str, dir: Dir) -> Arc<Entry> {
    let key = format!("{kind}\u{1f}{method}\u{1f}{name}\u{1f}{}", dir.as_str());
    if let Some(e) = REG.map.read().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return e.clone();
    }
    let mut map = REG.map.write().unwrap_or_else(|e| e.into_inner());
    if map.len() >= MAX_KEYS && !map.contains_key(&key) {
        let other = format!("{kind}\u{1f}\u{1f}(other)\u{1f}{}", dir.as_str());
        return map.entry(other).or_insert_with(|| Arc::new(Entry::new(kind, "", "(other)", dir))).clone();
    }
    map.entry(key).or_insert_with(|| Arc::new(Entry::new(kind, method, name, dir))).clone()
}

pub struct Session {
    inbound: Arc<Entry>,
    started: Instant,
    failed: AtomicBool,
}

impl Session {
    pub fn open(proto: &'static str, name: &str) -> Session {
        let inbound = line("session", proto, name, Dir::In);
        inbound.open.fetch_add(1, Relaxed);
        Session { inbound, started: Instant::now(), failed: AtomicBool::new(false) }
    }

    pub fn fail(&self) {
        self.failed.store(true, Relaxed);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.inbound.open.fetch_sub(1, Relaxed);
        self.inbound.add(self.started.elapsed(), if self.failed.load(Relaxed) { Outcome::Failed } else { Outcome::Ok });
    }
}

pub struct Setup {
    entry: Arc<Entry>,
    started: Instant,
    settled: AtomicBool,
}

impl Setup {
    pub fn start(proto: &'static str, name: &str) -> Setup {
        Setup { entry: line("setup", proto, name, Dir::In), started: Instant::now(), settled: AtomicBool::new(false) }
    }

    pub fn done(&self, ok: bool) {
        if !self.settled.swap(true, Relaxed) {
            self.entry.add(self.started.elapsed(), if ok { Outcome::Ok } else { Outcome::Failed });
        }
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        self.done(false);
    }
}

pub fn packet_bytes(payload: usize) -> u64 {
    payload as u64 + 12
}

pub fn delivered(out: &Entry, written: usize, one: u64) {
    if written > 0 && one > 0 {
        out.count((written as u64).div_ceil(one), written as u64);
    }
}

fn snapshot() -> Value {
    let rows: Vec<Row> = REG
        .map
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|e| e.read())
        .filter(|r| r.n > 0 || r.msgs > 0 || r.bytes > 0 || r.open > 0)
        .collect();
    json!({ "started": REG.started, "rows": rows })
}

fn method_name(m: &axum::http::Method) -> &'static str {
    match m.as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

pub async fn http(req: Request, next: Next) -> Response {
    let method = method_name(req.method());
    let path = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned());
    let dir = if req.headers().contains_key("x-forwarded-for") { Dir::In } else { Dir::Inter };
    let started = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16();
    let kind = if status == 101 { "ws" } else { "http" };
    line(kind, method, path.as_deref().unwrap_or("(no route)"), dir).add(started.elapsed(), outcome(status));
    res
}

pub async fn call(method: &'static str, name: &str, req: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
    let started = Instant::now();
    let res = req.send().await;
    line("api", method, name, Dir::Inter).add(
        started.elapsed(),
        match &res {
            Ok(r) => outcome(r.status().as_u16()),
            Err(_) => Outcome::Failed,
        },
    );
    res
}

pub fn serve() {
    let port = std::env::var("TIMINGS_PORT").ok().and_then(|p| p.trim().parse::<u16>().ok()).unwrap_or(PORT);
    if port == 0 {
        return;
    }
    tokio::spawn(async move {
        let router = Router::new().route("/timings", get(|| async { Json(snapshot()) }));
        match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(listener) => {
                log::info!("timings on 0.0.0.0:{port}/timings, for the agent");
                if let Err(e) = axum::serve(listener, router).await {
                    log::warn!("timings server stopped: {e}");
                }
            }
            Err(e) => log::warn!("timings: cannot listen on {port} ({e}), so the agent gets none from this process"),
        }
    });
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
    fn a_session_and_its_setup_read_back() {
        let out = line("session", "webrtc", "test-watch", Dir::Out);
        {
            let s = Session::open("webrtc", "test-watch");
            let setup = Setup::start("webrtc", "test-watch");
            setup.done(true);
            setup.done(false);
            delivered(&out, 2400, packet_bytes(1188));
            s.fail();
            let rows = snapshot()["rows"].as_array().unwrap().clone();
            let open = rows.iter().find(|r| r["kind"] == "session" && r["name"] == "test-watch" && r["dir"] == "in").unwrap();
            assert_eq!((open["open"].as_u64(), open["n"].as_u64()), (Some(1), Some(0)));
        }
        let rows = snapshot()["rows"].as_array().unwrap().clone();
        let find = |kind: &str, dir: &str| rows.iter().find(|r| r["kind"] == kind && r["name"] == "test-watch" && r["dir"] == dir).unwrap().clone();
        let s = find("session", "in");
        assert_eq!((s["open"].as_u64(), s["n"].as_u64(), s["err"].as_u64()), (Some(0), Some(1), Some(1)));
        let o = find("session", "out");
        assert_eq!((o["msgs"].as_u64(), o["bytes"].as_u64()), (Some(2), Some(2400)));
        let st = find("setup", "in");
        assert_eq!((st["n"].as_u64(), st["err"].as_u64()), (Some(1), Some(0)), "one setup, settled once");
        drop(Setup::start("webrtc", "test-never"));
        let rows = snapshot()["rows"].as_array().unwrap().clone();
        let never = rows.iter().find(|r| r["kind"] == "setup" && r["name"] == "test-never").unwrap();
        assert_eq!(never["err"], 1, "a setup that never connected is a failed one");
    }
}
