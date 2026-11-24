use std::collections::{BTreeMap, HashMap, VecDeque};
use std::env;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};

use axum::extract::ws::Message;
use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SUB_BITS: usize = 3;
const SUB: usize = 1 << SUB_BITS;
pub(crate) const BUCKETS: usize = 240;
const MAX_KEYS: usize = 500;
const MAX_NAME: usize = 200;
const MAX_LINES: usize = 400;
const PORT: u16 = 9300;
pub(crate) const TIERS: [(&str, i64, usize); 3] = [("1h", 60, 60), ("24h", 900, 96), ("7d", 3600, 168)];

pub(crate) fn bucket(us: u64) -> usize {
    if us < SUB as u64 {
        return us as usize;
    }
    let k = 63 - us.leading_zeros() as usize;
    (SUB * (k - SUB_BITS + 1) + ((us >> (k - SUB_BITS)) as usize & (SUB - 1))).min(BUCKETS - 1)
}

pub(crate) fn bucket_us(i: usize) -> f64 {
    if i < SUB {
        return i as f64 + 0.5;
    }
    let k = i / SUB + SUB_BITS - 1;
    let width = 1u64 << (k - SUB_BITS);
    ((SUB + i % SUB) as u64 * width) as f64 + width as f64 / 2.0
}

fn bucket_bounds_us(i: usize) -> (u64, u64) {
    if i < SUB {
        return (i as u64, i as u64 + 1);
    }
    let k = i / SUB + SUB_BITS - 1;
    let width = 1u64 << (k - SUB_BITS);
    let lo = (SUB + i % SUB) as u64 * width;
    (lo, lo + width)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Timing {
    pub(crate) kind: String,
    pub(crate) method: String,
    pub(crate) name: String,
    pub(crate) src: String,
    pub(crate) n: u64,
    pub(crate) e4: u64,
    pub(crate) e5: u64,
    pub(crate) err: u64,
    pub(crate) sum_us: u64,
    pub(crate) max_us: u64,
    pub(crate) b: Vec<(u16, u64)>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) dir: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub(crate) msgs: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub(crate) bytes: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub(crate) open: u64,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Dir {
    In,
    Out,
    Inter,
}

impl Dir {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Dir::In => "in",
            Dir::Out => "out",
            Dir::Inter => "inter",
        }
    }
}

fn default_dir(kind: &str) -> Dir {
    match kind {
        "http" | "ws" | "session" | "setup" => Dir::In,
        _ => Dir::Inter,
    }
}

pub(crate) fn dir_of(kind: &str, dir: &str) -> &'static str {
    match dir {
        "in" => "in",
        "out" => "out",
        "inter" => "inter",
        _ => default_dir(kind).as_str(),
    }
}

fn line_key(kind: &str, method: &str, name: &str, dir: &str) -> String {
    let dir = dir_of(kind, dir);
    if dir == default_dir(kind).as_str() {
        format!("{kind}\u{1f}{method}\u{1f}{name}")
    } else {
        format!("{kind}\u{1f}{method}\u{1f}{name}\u{1f}{dir}")
    }
}

impl Timing {
    fn local_key(&self) -> String {
        line_key(&self.kind, &self.method, &self.name, &self.dir)
    }

    pub(crate) fn active(&self) -> bool {
        self.n > 0 || self.msgs > 0 || self.bytes > 0 || self.open > 0
    }

    pub(crate) fn key(&self) -> String {
        format!("{}\u{1f}{}", self.src, self.local_key())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Outcome {
    Ok,
    Client,
    Server,
    Failed,
}

pub(crate) fn outcome(status: u16) -> Outcome {
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
    msgs: AtomicU64,
    bytes: AtomicU64,
    open: AtomicI64,
    n: AtomicU64,
    e4: AtomicU64,
    e5: AtomicU64,
    err: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
    b: [AtomicU64; BUCKETS],
}

impl Entry {
    fn new(kind: &'static str, method: &str, name: &str, dir: Dir) -> Entry {
        let z = || AtomicU64::new(0);
        Entry {
            kind,
            method: method.to_owned(),
            name: name.to_owned(),
            dir,
            msgs: z(),
            bytes: z(),
            open: AtomicI64::new(0),
            n: z(),
            e4: z(),
            e5: z(),
            err: z(),
            sum_us: z(),
            max_us: z(),
            b: std::array::from_fn(|_| z()),
        }
    }

    fn count(&self, bytes: usize) {
        self.msgs.fetch_add(1, Relaxed);
        self.bytes.fetch_add(bytes as u64, Relaxed);
    }

    fn add(&self, us: u64, outcome: Outcome) {
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

    fn read(&self) -> Timing {
        Timing {
            kind: self.kind.to_owned(),
            method: self.method.clone(),
            name: self.name.clone(),
            src: String::new(),
            n: self.n.load(Relaxed),
            e4: self.e4.load(Relaxed),
            e5: self.e5.load(Relaxed),
            err: self.err.load(Relaxed),
            sum_us: self.sum_us.load(Relaxed),
            max_us: self.max_us.swap(0, Relaxed),
            b: self.b.iter().enumerate().filter_map(|(i, c)| Some((i as u16, c.load(Relaxed))).filter(|(_, c)| *c > 0)).collect(),
            dir: self.dir.as_str().to_owned(),
            msgs: self.msgs.load(Relaxed),
            bytes: self.bytes.load(Relaxed),
            open: self.open.load(Relaxed).max(0) as u64,
        }
    }
}

struct Registry {
    started: i64,
    map: RwLock<HashMap<String, Arc<Entry>>>,
}

static REG: LazyLock<Registry> = LazyLock::new(|| Registry { started: Utc::now().timestamp_millis(), map: RwLock::new(HashMap::new()) });

fn entry(kind: &'static str, method: &str, name: &str, dir: Dir) -> Arc<Entry> {
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

fn micros(d: Duration) -> u64 {
    d.as_micros().min(u64::MAX as u128) as u64
}

pub(crate) fn record(kind: &'static str, method: &str, name: &str, took: Duration, outcome: Outcome) {
    record_dir(kind, method, name, default_dir(kind), took, outcome);
}

pub(crate) fn record_dir(kind: &'static str, method: &str, name: &str, dir: Dir, took: Duration, outcome: Outcome) {
    entry(kind, method, name, dir).add(micros(took), outcome);
}

pub(crate) struct Session {
    inbound: Arc<Entry>,
    outbound: Arc<Entry>,
    started: Instant,
    failed: AtomicBool,
}

impl Session {
    pub(crate) fn open(proto: &'static str, name: &str) -> Session {
        let inbound = entry("session", proto, name, Dir::In);
        inbound.open.fetch_add(1, Relaxed);
        Session { inbound, outbound: entry("session", proto, name, Dir::Out), started: Instant::now(), failed: AtomicBool::new(false) }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.inbound.open.fetch_sub(1, Relaxed);
        self.inbound.add(micros(self.started.elapsed()), if self.failed.load(Relaxed) { Outcome::Failed } else { Outcome::Ok });
    }
}

tokio::task_local! {
    static SESSION: Session;
}

pub(crate) async fn session<F: std::future::Future>(proto: &'static str, name: &str, f: F) -> F::Output {
    SESSION.scope(Session::open(proto, name), f).await
}

pub(crate) fn sent(bytes: usize) {
    let _ = SESSION.try_with(|s| s.outbound.count(bytes));
}

pub(crate) fn heard(incoming: &Option<Result<Message, axum::Error>>) {
    let bytes = match incoming {
        Some(Ok(Message::Text(t))) => t.len(),
        Some(Ok(Message::Binary(b))) => b.len(),
        Some(Err(_)) => {
            let _ = SESSION.try_with(|s| s.failed.store(true, Relaxed));
            return;
        }
        _ => return,
    };
    let _ = SESSION.try_with(|s| s.inbound.count(bytes));
}

pub(crate) fn snapshot() -> Value {
    let rows: Vec<Timing> = REG.map.read().unwrap_or_else(|e| e.into_inner()).values().map(|e| e.read()).filter(Timing::active).collect();
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

pub(crate) async fn http(req: Request, next: Next) -> Response {
    let method = method_name(req.method());
    let path = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned());
    let dir = if req.headers().contains_key("x-forwarded-for") { Dir::In } else { Dir::Inter };
    let started = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16();
    let kind = if status == 101 { "ws" } else { "http" };
    record_dir(kind, method, path.as_deref().unwrap_or("(no route)"), dir, started.elapsed(), outcome(status));
    res
}

pub(crate) async fn call(kind: &'static str, method: &'static str, name: &'static str, req: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
    let started = Instant::now();
    let res = req.send().await;
    record(kind, method, name, started.elapsed(), match &res {
        Ok(r) => outcome(r.status().as_u16()),
        Err(_) => Outcome::Failed,
    });
    res
}

pub(crate) fn serve() {
    let port = env::var("TIMINGS_PORT").ok().and_then(|p| p.trim().parse::<u16>().ok()).unwrap_or(PORT);
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

#[derive(Clone)]
pub(crate) struct Redis(redis::aio::ConnectionManager);

impl Redis {
    pub(crate) fn new(inner: redis::aio::ConnectionManager) -> Redis {
        Redis(inner)
    }
}

fn arg_word(arg: redis::Arg<&[u8]>) -> Option<String> {
    match arg {
        redis::Arg::Simple(b) if b.len() <= 24 => Some(String::from_utf8_lossy(b).to_ascii_uppercase()),
        _ => None,
    }
}

fn redis_name(cmd: &redis::Cmd) -> String {
    let mut args = cmd.args_iter();
    let Some(word) = args.next().and_then(arg_word) else { return "?".into() };
    if (word == "XREAD" || word == "XREADGROUP") && args.any(|a| arg_word(a).as_deref() == Some("BLOCK")) {
        return format!("{word} BLOCK");
    }
    word
}

fn pipeline_name(p: &redis::Pipeline) -> String {
    let mut words: Vec<String> = vec![];
    for c in p.cmd_iter() {
        let w = redis_name(c);
        if !words.contains(&w) {
            words.push(w);
        }
    }
    let shown = words.iter().take(4).cloned().collect::<Vec<_>>().join(" ");
    format!("{} {}{}", if p.is_transaction() { "MULTI" } else { "PIPELINE" }, shown, if words.len() > 4 { " …" } else { "" })
}

impl redis::aio::ConnectionLike for Redis {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a redis::Cmd) -> redis::RedisFuture<'a, redis::Value> {
        Box::pin(async move {
            let started = Instant::now();
            let out = self.0.req_packed_command(cmd).await;
            record("redis", "", &redis_name(cmd), started.elapsed(), if out.is_err() { Outcome::Failed } else { Outcome::Ok });
            out
        })
    }

    fn req_packed_commands<'a>(&'a mut self, pipeline: &'a redis::Pipeline, offset: usize, count: usize) -> redis::RedisFuture<'a, Vec<redis::Value>> {
        Box::pin(async move {
            let started = Instant::now();
            let out = self.0.req_packed_commands(pipeline, offset, count).await;
            record("redis", "", &pipeline_name(pipeline), started.elapsed(), if out.is_err() { Outcome::Failed } else { Outcome::Ok });
            out
        })
    }

    fn get_db(&self) -> i64 {
        self.0.get_db()
    }
}

struct Logger {
    inner: env_logger::Logger,
}

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.target() == "sqlx::query" || self.inner.enabled(m)
    }

    fn log(&self, r: &log::Record) {
        if r.target() == "sqlx::query" {
            if let Some((sql, took)) = sqlx_event(&r.args().to_string()) {
                record("db", "", &sql_name(&sql), took, Outcome::Ok);
            }
            if r.level() > log::Level::Warn {
                return;
            }
        }
        if self.inner.enabled(r.metadata()) {
            self.inner.log(r);
        }
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

pub(crate) fn init_logging() {
    let inner = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).build();
    let max = inner.filter().max(log::LevelFilter::Info);
    if log::set_boxed_logger(Box::new(Logger { inner })).is_ok() {
        log::set_max_level(max);
    }
}

fn debug_str(s: &str) -> Option<(String, &str)> {
    let mut chars = s.strip_prefix('"')?.char_indices();
    let mut out = String::new();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((out, &s[i + 2..])),
            '\\' => match chars.next()?.1 {
                'n' | 't' | 'r' => out.push(' '),
                'u' => {
                    let mut hex = String::new();
                    for (_, h) in chars.by_ref() {
                        match h {
                            '{' => {}
                            '}' => break,
                            h => hex.push(h),
                        }
                    }
                    out.push(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32).unwrap_or(' '));
                }
                other => out.push(other),
            },
            c => out.push(c),
        }
    }
    None
}

fn field_str(text: &str, name: &str) -> Option<String> {
    let at = text.find(&format!("{name}=\""))?;
    debug_str(&text[at + name.len() + 1..]).map(|(s, _)| s)
}

fn sqlx_event(text: &str) -> Option<(String, Duration)> {
    let at = text.find("elapsed_secs=")? + "elapsed_secs=".len();
    let secs: f64 = text[at..].split(|c: char| c.is_whitespace()).next()?.parse().ok()?;
    let statement = field_str(text, "db.statement").filter(|s| !s.trim().is_empty());
    let sql = match statement {
        Some(s) => s,
        None => field_str(text, "summary")?,
    };
    Some((sql, Duration::from_secs_f64(secs.max(0.0))))
}

pub(crate) fn sql_name(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len().min(MAX_NAME + 8));
    let mut chars = sql.trim().trim_end_matches('…').trim().chars().peekable();
    let mut space = false;
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        match c {
            '\'' => {
                for d in chars.by_ref() {
                    if d == '\'' {
                        break;
                    }
                }
                out.push('?');
            }
            '$' if chars.peek().is_some_and(char::is_ascii_digit) => {
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    chars.next();
                }
                if !(out.ends_with("$, ") || out.ends_with("$,")) {
                    out.push('$');
                } else {
                    while out.ends_with(' ') || out.ends_with(',') {
                        out.pop();
                    }
                }
            }
            d if d.is_ascii_digit() && !out.chars().last().is_some_and(|p| p.is_alphanumeric() || p == '_') => {
                while chars.peek().is_some_and(|x| x.is_ascii_digit() || *x == '.') {
                    chars.next();
                }
                out.push('?');
            }
            c => out.push(c),
        }
        if out.len() > MAX_NAME {
            let mut cut = MAX_NAME;
            while !out.is_char_boundary(cut) {
                cut -= 1;
            }
            out.truncate(cut);
            out.push('…');
            break;
        }
    }
    out
}

#[derive(Deserialize)]
struct Snapshot {
    started: i64,
    rows: Vec<Timing>,
}

fn diff_buckets(cur: &[(u16, u64)], prev: &[(u16, u64)]) -> Vec<(u16, u64)> {
    let before: HashMap<u16, u64> = prev.iter().copied().collect();
    cur.iter().filter_map(|&(i, c)| Some((i, c.saturating_sub(*before.get(&i).unwrap_or(&0)))).filter(|(_, d)| *d > 0)).collect()
}

fn delta(cur: &Timing, prev: Option<&Timing>) -> Option<Timing> {
    let Some(p) = prev.filter(|p| p.n <= cur.n && p.msgs <= cur.msgs && p.bytes <= cur.bytes) else { return Some(cur.clone()).filter(Timing::active) };
    let d = Timing {
        n: cur.n - p.n,
        e4: cur.e4.saturating_sub(p.e4),
        e5: cur.e5.saturating_sub(p.e5),
        err: cur.err.saturating_sub(p.err),
        sum_us: cur.sum_us.saturating_sub(p.sum_us),
        b: diff_buckets(&cur.b, &p.b),
        msgs: cur.msgs - p.msgs,
        bytes: cur.bytes - p.bytes,
        ..cur.clone()
    };
    d.active().then_some(d)
}

pub(crate) struct Collector {
    client: reqwest::Client,
    from: Vec<(String, String)>,
    prev: HashMap<String, (i64, HashMap<String, Timing>)>,
}

impl Collector {
    pub(crate) fn from_env() -> Collector {
        let from = env::var("TIMINGS_FROM")
            .unwrap_or_default()
            .split(',')
            .filter_map(|e| e.trim().split_once('='))
            .map(|(k, v)| (k.trim().to_owned(), v.trim().trim_end_matches('/').to_owned()))
            .filter(|(k, v)| !k.is_empty() && !v.is_empty())
            .collect();
        Collector { client: reqwest::Client::builder().timeout(Duration::from_secs(3)).build().expect("http client"), from, prev: HashMap::new() }
    }

    pub(crate) fn sources(&self) -> Vec<String> {
        self.from.iter().map(|(k, v)| format!("{k}={v}")).collect()
    }

    pub(crate) async fn collect(&mut self, problems: &mut Vec<String>, running: Option<&[&str]>) -> Vec<Timing> {
        let mut set = tokio::task::JoinSet::new();
        for (src, url) in self.from.iter().filter(|(src, _)| running.is_none_or(|r| r.contains(&src.as_str()))) {
            let (client, src, url) = (self.client.clone(), src.clone(), format!("{url}/timings"));
            set.spawn(async move {
                let got = async {
                    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
                    if !res.status().is_success() {
                        return Err(format!("{} answered {}", url, res.status()));
                    }
                    res.json::<Snapshot>().await.map_err(|e| e.to_string())
                };
                (src, got.await)
            });
        }
        let mut out = vec![];
        while let Some(Ok((src, got))) = set.join_next().await {
            match got {
                Ok(snap) => out.extend(self.take(&src, snap)),
                Err(e) => problems.push(format!("timings from {src}: {e}")),
            }
        }
        out
    }

    fn take(&mut self, src: &str, snap: Snapshot) -> Vec<Timing> {
        let cur: HashMap<String, Timing> = snap.rows.into_iter().map(|t| (t.local_key(), t)).collect();
        let out = match self.prev.get(src) {
            None => vec![],
            Some((started, _)) if *started != snap.started => cur.values().filter(|t| t.active()).cloned().collect(),
            Some((_, prev)) => cur.iter().filter_map(|(k, t)| delta(t, prev.get(k))).collect(),
        };
        self.prev.insert(src.to_owned(), (snap.started, cur));
        out.into_iter().map(|t| Timing { src: src.to_owned(), ..t }).collect()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Agg {
    n: u64,
    e4: u64,
    e5: u64,
    err: u64,
    sum_us: u64,
    max_us: u64,
    b: Vec<(u16, u64)>,
    msgs: u64,
    bytes: u64,
    open: u64,
}

impl Agg {
    fn of(t: &Timing) -> Agg {
        let mut b = t.b.clone();
        b.sort_unstable();
        Agg { n: t.n, e4: t.e4, e5: t.e5, err: t.err, sum_us: t.sum_us, max_us: t.max_us, b, msgs: t.msgs, bytes: t.bytes, open: t.open }
    }

    fn active(&self) -> bool {
        self.n > 0 || self.msgs > 0 || self.bytes > 0 || self.open > 0
    }

    fn merge(&mut self, o: &Agg) {
        self.msgs += o.msgs;
        self.bytes += o.bytes;
        self.open = self.open.max(o.open);
        self.n += o.n;
        self.e4 += o.e4;
        self.e5 += o.e5;
        self.err += o.err;
        self.sum_us += o.sum_us;
        self.max_us = self.max_us.max(o.max_us);
        let mut out = Vec::with_capacity(self.b.len() + o.b.len());
        let (mut i, mut j) = (0, 0);
        while i < self.b.len() || j < o.b.len() {
            match (self.b.get(i), o.b.get(j)) {
                (Some(&(a, x)), Some(&(b, y))) if a == b => {
                    out.push((a, x + y));
                    i += 1;
                    j += 1;
                }
                (Some(&(a, x)), Some(&(b, _))) if a < b => {
                    out.push((a, x));
                    i += 1;
                }
                (Some(&(a, x)), None) => {
                    out.push((a, x));
                    i += 1;
                }
                (_, Some(&(b, y))) => {
                    out.push((b, y));
                    j += 1;
                }
                (None, None) => break,
            }
        }
        self.b = out;
    }

    fn quantile(&self, q: f64) -> Option<f64> {
        let total: u64 = self.b.iter().map(|(_, c)| c).sum();
        if total == 0 {
            return None;
        }
        let rank = ((q * total as f64).ceil() as u64).clamp(1, total);
        let mut seen = 0;
        for &(i, c) in &self.b {
            seen += c;
            if seen >= rank {
                let us = bucket_us(i as usize);
                return Some(ms(if self.max_us > 0 { us.min(self.max_us as f64) } else { us }));
            }
        }
        None
    }

    fn row(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("n".into(), json!(self.n));
        m.insert("e4".into(), json!(self.e4));
        m.insert("e5".into(), json!(self.e5));
        m.insert("err".into(), json!(self.err));
        m.insert("sum_ms".into(), json!(crate::agent::round(self.sum_us as f64 / 1000.0, 3)));
        m.insert("mean".into(), json!((self.n > 0).then(|| ms(self.sum_us as f64 / self.n as f64))));
        m.insert("p50".into(), json!(self.quantile(0.5)));
        m.insert("p95".into(), json!(self.quantile(0.95)));
        m.insert("p99".into(), json!(self.quantile(0.99)));
        m.insert("max".into(), json!((self.max_us > 0).then(|| ms(self.max_us as f64))));
        m.insert("msgs".into(), json!(self.msgs));
        m.insert("bytes".into(), json!(self.bytes));
        m.insert("open_peak".into(), json!(self.open));
        m
    }

    fn hist(&self) -> Vec<(f64, f64, u64)> {
        self.b
            .iter()
            .map(|&(i, c)| {
                let (lo, hi) = bucket_bounds_us(i as usize);
                (lo as f64 / 1000.0, hi as f64 / 1000.0, c)
            })
            .collect()
    }
}

fn blocking(name: &str) -> bool {
    name.ends_with(" BLOCK")
}

#[derive(Default, Debug, Clone)]
struct Total {
    agg: Agg,
    rate: f64,
    msgs_rate: f64,
    bytes_rate: f64,
    open: u64,
}

#[derive(Default, Debug)]
pub(crate) struct Totals {
    kinds: BTreeMap<(String, String), Total>,
}

impl Totals {
    fn add(&mut self, dir: &str, kind: &str, t: &Total) {
        let s = self.kinds.entry((dir.to_owned(), kind.to_owned())).or_default();
        s.agg.merge(&t.agg);
        s.rate += t.rate;
        s.msgs_rate += t.msgs_rate;
        s.bytes_rate += t.bytes_rate;
        s.open += t.open;
    }

    pub(crate) fn merge(&mut self, o: &Totals) {
        for ((dir, kind), t) in &o.kinds {
            self.add(dir, kind, t);
        }
    }

    pub(crate) fn rows(&self, target: Option<&str>) -> Vec<Value> {
        self.kinds
            .iter()
            .map(|((dir, kind), t)| {
                let mut row = t.agg.row();
                row.insert("target".into(), json!(target));
                row.insert("kind".into(), json!(kind));
                row.insert("dir".into(), json!(dir));
                row.insert("rate".into(), json!(crate::agent::round(t.rate, 3)));
                row.insert("msgs_rate".into(), json!(crate::agent::round(t.msgs_rate, 3)));
                row.insert("bytes_rate".into(), json!(crate::agent::round(t.bytes_rate, 1)));
                row.insert("open".into(), json!(t.open));
                Value::Object(row)
            })
            .collect()
    }
}

fn ms(us: f64) -> f64 {
    let v = us / 1000.0;
    if v == 0.0 {
        return 0.0;
    }
    let digits = 3 - v.abs().log10().floor() as i32 - 1;
    let f = 10f64.powi(digits.max(0));
    (v * f).round() / f
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
struct Line {
    kind: String,
    method: String,
    name: String,
    src: String,
    dir: String,
    tiers: Vec<VecDeque<(i64, Agg)>>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub(crate) struct History {
    lines: BTreeMap<String, Line>,
    since: Option<i64>,
    dropped: u64,
}

impl History {
    pub(crate) fn add(&mut self, at: i64, rows: &[Timing]) {
        self.since.get_or_insert(at);
        for r in rows.iter().filter(|r| r.active()) {
            let key = r.key();
            if !self.lines.contains_key(&key) && self.lines.len() >= MAX_LINES {
                self.dropped += 1;
                continue;
            }
            let line = self.lines.entry(key).or_insert_with(|| Line { kind: r.kind.clone(), method: r.method.clone(), name: r.name.clone(), src: r.src.clone(), dir: dir_of(&r.kind, &r.dir).to_owned(), tiers: vec![] });
            line.tiers.resize_with(TIERS.len(), VecDeque::new);
            let agg = Agg::of(r);
            for (tier, (_, width, keep)) in line.tiers.iter_mut().zip(TIERS) {
                let start = at - at.rem_euclid(width);
                match tier.back_mut() {
                    Some((t, a)) if *t == start => a.merge(&agg),
                    Some((t, _)) if *t > start => {}
                    _ => {
                        tier.push_back((start, agg.clone()));
                        if tier.len() > keep {
                            tier.pop_front();
                        }
                    }
                }
            }
        }
        for line in self.lines.values_mut() {
            for (tier, (_, width, keep)) in line.tiers.iter_mut().zip(TIERS) {
                let oldest = at - width * keep as i64;
                while tier.front().is_some_and(|(t, _)| *t <= oldest) {
                    tier.pop_front();
                }
            }
        }
        self.lines.retain(|_, l| l.tiers.iter().any(|t| !t.is_empty()));
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.dropped
    }

    pub(crate) fn table(&self, tier: usize, now: i64, target: &str) -> (Vec<Value>, Totals) {
        let (_, width, keep) = TIERS[tier];
        let range = width * keep as i64;
        let from = now - range;
        let span = (now - self.since.unwrap_or(from).max(from)).max(width) as f64;
        let mut out = vec![];
        let mut totals = Totals::default();
        for (key, line) in &self.lines {
            let Some(pts) = line.tiers.get(tier) else { continue };
            let mut total = Agg::default();
            for (_, a) in pts.iter().filter(|(t, _)| *t + width > from) {
                total.merge(a);
            }
            if !total.active() {
                continue;
            }
            let open = pts.back().filter(|(t, _)| *t + 2 * width > now).map_or(0, |(_, a)| a.open);
            let dir = dir_of(&line.kind, &line.dir);
            let sums = Total { agg: total.clone(), rate: total.n as f64 / span, msgs_rate: total.msgs as f64 / span, bytes_rate: total.bytes as f64 / span, open };
            let mut row = total.row();
            row.insert("dir".into(), json!(dir));
            row.insert("open".into(), json!(open));
            row.insert("msgs_rate".into(), json!(crate::agent::round(sums.msgs_rate, 3)));
            row.insert("bytes_rate".into(), json!(crate::agent::round(sums.bytes_rate, 1)));
            row.insert("target".into(), json!(target));
            row.insert("key".into(), json!(key));
            row.insert("kind".into(), json!(line.kind));
            row.insert("method".into(), json!(line.method));
            row.insert("name".into(), json!(line.name));
            row.insert("src".into(), json!(line.src));
            row.insert("rate".into(), json!(crate::agent::round(total.n as f64 / span, 3)));
            out.push(Value::Object(row));
            if !blocking(&line.name) {
                totals.add(dir, &line.kind, &sums);
            }
        }
        (out, totals)
    }

    pub(crate) fn detail(&self, key: &str, tier: usize, now: i64) -> Option<Value> {
        let line = self.lines.get(key)?;
        let pts = line.tiers.get(tier)?;
        let (_, width, keep) = TIERS[tier];
        let from = now - width * keep as i64;
        let mut total = Agg::default();
        for (_, a) in pts.iter().filter(|(t, _)| *t + width > from) {
            total.merge(a);
        }
        let col = |f: &dyn Fn(&Agg) -> Value| pts.iter().map(|(_, a)| f(a)).collect::<Vec<_>>();
        Some(json!({
            "key": key, "kind": line.kind, "method": line.method, "name": line.name, "src": line.src, "dir": dir_of(&line.kind, &line.dir),
            "bucket_secs": TIERS[tier].1,
            "t": pts.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
            "n": col(&|a| json!(a.n)),
            "e4": col(&|a| json!(a.e4)),
            "e5": col(&|a| json!(a.e5)),
            "err": col(&|a| json!(a.err)),
            "p50": col(&|a| json!(a.quantile(0.5))),
            "p95": col(&|a| json!(a.quantile(0.95))),
            "p99": col(&|a| json!(a.quantile(0.99))),
            "max": col(&|a| json!((a.max_us > 0).then(|| ms(a.max_us as f64)))),
            "sum": col(&|a| json!(crate::agent::round(a.sum_us as f64 / 1000.0, 3))),
            "msgs": col(&|a| json!(a.msgs)),
            "bytes": col(&|a| json!(a.bytes)),
            "open": col(&|a| json!(a.open)),
            "hist": total.hist(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_log_linear_and_cover_their_values() {
        for us in [0u64, 1, 3, 4, 7, 8, 15, 16, 999, 1000, 1_500_000, 60_000_000] {
            let i = bucket(us);
            let mid = bucket_us(i);
            assert!((mid - us as f64).abs() <= (us as f64 * 0.07).max(0.5), "{us}us in bucket {i} reads {mid}");
        }
        assert_eq!(bucket(u64::MAX), BUCKETS - 1);
        assert_eq!(bucket((1 << 32) - 1), BUCKETS - 1);
        assert!((1..BUCKETS).all(|i| bucket_us(i) > bucket_us(i - 1)));
    }

    #[test]
    fn buckets_match_the_video_s() {
        let pinned = [(0u64, 0usize), (7, 7), (8, 8), (15, 15), (16, 16), (1000, 63), (1_500_000, 147), (60_000_000, 190), (u64::MAX, 239)];
        for (us, i) in pinned {
            assert_eq!(bucket(us), i, "{us}us");
        }
    }

    #[test]
    fn quantiles_from_a_histogram() {
        let mut t = Timing { n: 100, max_us: 50_000, ..Default::default() };
        let mut b = HashMap::new();
        for k in 0..90 {
            *b.entry(bucket(1000 + k)).or_insert(0u64) += 1;
        }
        for k in 0..9 {
            *b.entry(bucket(20_000 + k)).or_insert(0u64) += 1;
        }
        *b.entry(bucket(50_000)).or_insert(0u64) += 1;
        t.b = b.into_iter().map(|(i, c)| (i as u16, c)).collect();
        let a = Agg::of(&t);
        let p50 = a.quantile(0.5).unwrap();
        let p95 = a.quantile(0.95).unwrap();
        let p99 = a.quantile(0.99).unwrap();
        assert!((0.95..1.12).contains(&p50), "p50 {p50}");
        assert!((18.0..23.0).contains(&p95), "p95 {p95}");
        assert!((18.0..23.0).contains(&p99), "p99 {p99}");
        assert_eq!(a.quantile(1.0), Some(50.0));
    }

    #[test]
    fn merging_adds_bucket_by_bucket() {
        let mut a = Agg { n: 2, max_us: 5, b: vec![(1, 1), (5, 1)], ..Default::default() };
        a.merge(&Agg { n: 3, max_us: 9, b: vec![(0, 1), (5, 1), (9, 1)], ..Default::default() });
        assert_eq!(a.b, vec![(0, 1), (1, 1), (5, 2), (9, 1)]);
        assert_eq!((a.n, a.max_us), (5, 9));
    }

    #[test]
    fn the_registry_counts_and_classifies() {
        record("http", "GET", "/api/test-registry/{x}", Duration::from_millis(3), Outcome::Ok);
        record("http", "GET", "/api/test-registry/{x}", Duration::from_millis(7), Outcome::Server);
        record("http", "GET", "/api/test-registry/{x}", Duration::from_millis(1), Outcome::Client);
        let snap: Snapshot = serde_json::from_value(snapshot()).unwrap();
        let row = snap.rows.iter().find(|r| r.name == "/api/test-registry/{x}").unwrap();
        assert_eq!((row.n, row.e4, row.e5, row.err), (3, 1, 1, 1));
        assert_eq!(row.max_us, 7000);
        assert_eq!(row.b.iter().map(|(_, c)| c).sum::<u64>(), 3);
        let again: Snapshot = serde_json::from_value(snapshot()).unwrap();
        assert_eq!(again.rows.iter().find(|r| r.name == "/api/test-registry/{x}").unwrap().max_us, 0);
    }

    #[test]
    fn the_collector_sends_deltas_and_survives_a_restart() {
        let mut c = Collector { client: reqwest::Client::new(), from: vec![], prev: HashMap::new() };
        let row = |n: u64, b: Vec<(u16, u64)>| Timing { kind: "http".into(), method: "GET".into(), name: "/x".into(), n, sum_us: n * 10, max_us: 9, b, ..Default::default() };
        assert!(c.take("api", Snapshot { started: 1, rows: vec![row(5, vec![(3, 5)])] }).is_empty());
        let d = c.take("api", Snapshot { started: 1, rows: vec![row(8, vec![(3, 6), (4, 2)])] });
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].n, d[0].sum_us, d[0].src.as_str()), (3, 30, "api"));
        assert_eq!(d[0].b, vec![(3, 1), (4, 2)]);
        assert!(c.take("api", Snapshot { started: 1, rows: vec![row(8, vec![(3, 6), (4, 2)])] }).is_empty());
        let r = c.take("api", Snapshot { started: 2, rows: vec![row(2, vec![(3, 2)])] });
        assert_eq!(r[0].n, 2);
    }

    #[test]
    fn sql_is_named_without_values() {
        assert_eq!(sql_name("SELECT id\n  FROM streamers WHERE name = $1 AND n > 10"), "SELECT id FROM streamers WHERE name = $ AND n > ?");
        assert_eq!(sql_name("SELECT * FROM t WHERE id IN ($1, $2, $3) AND x = 'abc'"), "SELECT * FROM t WHERE id IN ($) AND x = ?");
        assert_eq!(sql_name("UPDATE t2 SET v = v + 1"), "UPDATE t2 SET v = v + ?");
        assert!(sql_name(&"SELECT a ".repeat(100)).ends_with('…'));
    }

    #[test]
    fn a_sqlx_event_reads_back() {
        let text = r#"summary="SELECT id, name FROM …" db.statement="\n\nSELECT id, name FROM streamers\nWHERE name = $1\n" rows_affected=0 rows_returned=1 elapsed=1.25ms elapsed_secs=0.00125 "#;
        let (sql, took) = sqlx_event(text).unwrap();
        assert_eq!(sql_name(&sql), "SELECT id, name FROM streamers WHERE name = $");
        assert_eq!(took.as_micros(), 1250);
        let short = r#"summary="BEGIN" db.statement="" rows_affected=0 rows_returned=0 elapsed=40µs elapsed_secs=4e-5"#;
        let (sql, took) = sqlx_event(short).unwrap();
        assert_eq!((sql.as_str(), took.as_micros()), ("BEGIN", 40));
    }

    #[test]
    fn history_folds_and_summarises_a_range() {
        let mut h = History::default();
        let t = |n: u64, us: u64| Timing { kind: "http".into(), method: "GET".into(), name: "/a".into(), src: "api".into(), n, e5: 1, err: 1, sum_us: n * us, max_us: us, b: vec![(bucket(us) as u16, n)], ..Default::default() };
        h.add(1_000_020, &[t(10, 2000)]);
        h.add(1_000_080, &[t(30, 4000)]);
        let (rows, _) = h.table(0, 1_000_090, "box");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["n"], 40);
        assert_eq!(rows[0]["e5"], 2);
        assert_eq!(rows[0]["max"], 4.0);
        assert_eq!(rows[0]["sum_ms"], 140.0);
        assert!(rows[0]["p50"].as_f64().unwrap() > 3.0);
        let d = h.detail(rows[0]["key"].as_str().unwrap(), 0, 1_000_090).unwrap();
        assert_eq!(d["n"], json!([10, 30]));
        assert_eq!(d["sum"], json!([20.0, 120.0]));
        h.add(1_000_000 + 8 * 86400, &[]);
        assert!(h.lines.is_empty());
    }

    #[test]
    fn totals_merge_lines_and_boxes_per_kind() {
        let t = |kind: &str, name: &str, n: u64, us: u64| Timing { kind: kind.into(), name: name.into(), src: "api".into(), n, sum_us: n * us, max_us: us, b: vec![(bucket(us) as u16, n)], ..Default::default() };
        let mut h = History::default();
        h.add(1_000_020, &[t("db", "SELECT ?", 90, 1000), t("db", "UPDATE t", 10, 50_000), t("redis", "GET", 5, 100), t("redis", "XREAD BLOCK", 3, 5_000_000)]);
        let (rows, totals) = h.table(0, 1_000_030, "a");
        let db = totals.rows(Some("a")).into_iter().find(|r| r["kind"] == "db").unwrap();
        assert_eq!((db["target"].as_str(), db["n"].as_u64(), db["sum_ms"].as_f64()), (Some("a"), Some(100), Some(590.0)));
        assert!(db["p50"].as_f64().unwrap() < 1.1 && db["p99"].as_f64().unwrap() > 45.0);
        assert_eq!(db["max"], 50.0);
        let mut all = Totals::default();
        all.merge(&totals);
        all.merge(&totals);
        let both = all.rows(None);
        assert_eq!(both.len(), 2);
        assert_eq!(both.iter().find(|r| r["kind"] == "redis").unwrap()["n"], 10, "a blocking read is waiting, not work, and stays out of the total");
        assert_eq!(rows.len(), 4);
        assert!(both.iter().all(|r| r["target"].is_null()));
        let key = rows.iter().find(|r| r["name"] == "UPDATE t").unwrap()["key"].as_str().unwrap().to_owned();
        let hist = h.detail(&key, 0, 1_000_030).unwrap()["hist"].clone();
        let bars = hist.as_array().unwrap();
        assert_eq!(bars.len(), 1);
        let (lo, hi, c) = (bars[0][0].as_f64().unwrap(), bars[0][1].as_f64().unwrap(), bars[0][2].as_u64().unwrap());
        assert!(lo <= 50.0 && 50.0 < hi && c == 10, "{bars:?}");
    }

    #[tokio::test]
    async fn a_session_counts_open_time_messages_and_bytes_each_way() {
        let name = "/test-session";
        let row = |dir: &str| -> Option<Timing> {
            let snap: Snapshot = serde_json::from_value(snapshot()).unwrap();
            snap.rows.into_iter().find(|r| r.kind == "session" && r.name == name && r.dir == dir)
        };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(session("ws", name, async move {
            sent(100);
            sent(20);
            heard(&Some(Ok(Message::Text("hello".into()))));
            heard(&Some(Ok(Message::Ping(Default::default()))));
            let _ = rx.await;
        }));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let open = row("in").unwrap();
        assert_eq!((open.open, open.n, open.msgs, open.bytes), (1, 0, 1, 5));
        let out = row("out").unwrap();
        assert_eq!((out.msgs, out.bytes, out.open), (2, 120, 0));
        tx.send(()).unwrap();
        task.await.unwrap();
        let closed = row("in").unwrap();
        assert_eq!((closed.open, closed.n, closed.err), (0, 1, 0));
        assert!(closed.sum_us >= 15_000, "the session lasted {}us", closed.sum_us);
        sent(7);
        assert_eq!(row("out").unwrap().bytes, 120, "a send outside a session counts nowhere");
    }

    #[test]
    fn the_collector_keeps_an_open_gauge_with_no_new_calls() {
        let mut c = Collector { client: reqwest::Client::new(), from: vec![], prev: HashMap::new() };
        let row = |n: u64, msgs: u64, open: u64| Timing { kind: "session".into(), method: "ws".into(), name: "/rt".into(), dir: "in".into(), n, msgs, bytes: msgs * 10, open, ..Default::default() };
        assert!(c.take("chat", Snapshot { started: 1, rows: vec![row(0, 5, 3)] }).is_empty());
        let d = c.take("chat", Snapshot { started: 1, rows: vec![row(0, 9, 3)] });
        assert_eq!((d[0].n, d[0].msgs, d[0].bytes, d[0].open), (0, 4, 40, 3));
        let idle = c.take("chat", Snapshot { started: 1, rows: vec![row(0, 9, 2)] });
        assert_eq!((idle[0].msgs, idle[0].open), (0, 2), "two still open, nothing said");
        assert!(c.take("chat", Snapshot { started: 1, rows: vec![row(0, 9, 0)] }).is_empty());
    }

    #[test]
    fn history_keeps_open_sessions_and_rates_and_totals_by_direction() {
        let mut h = History::default();
        let s = |dir: &str, n: u64, msgs: u64, open: u64| Timing { kind: "session".into(), method: "webrtc".into(), name: "watch".into(), src: "video".into(), dir: dir.into(), n, msgs, bytes: msgs * 1000, open, ..Default::default() };
        h.add(1_000_020, &[s("in", 0, 0, 4), s("out", 0, 600, 0)]);
        h.add(1_000_035, &[s("in", 0, 0, 5), s("out", 0, 600, 0)]);
        let (rows, totals) = h.table(0, 1_000_040, "box");
        assert_eq!(rows.len(), 2);
        let inbound = rows.iter().find(|r| r["dir"] == "in").unwrap();
        assert_eq!((inbound["open"].as_u64(), inbound["open_peak"].as_u64(), inbound["n"].as_u64()), (Some(5), Some(5), Some(0)));
        let out = rows.iter().find(|r| r["dir"] == "out").unwrap();
        assert_eq!(out["msgs"], 1200);
        assert!(out["bytes_rate"].as_f64().unwrap() > 0.0);
        assert_ne!(inbound["key"], out["key"]);
        let t = totals.rows(None);
        assert_eq!(t.iter().filter(|r| r["kind"] == "session").count(), 2);
        assert_eq!(t.iter().find(|r| r["dir"] == "in").unwrap()["open"], 5);
        let (later, _) = h.table(0, 1_000_000 + 240, "box");
        assert_eq!(later.iter().find(|r| r["dir"] == "in").unwrap()["open"], 0, "no word from the line for minutes is no longer open");
    }

    #[test]
    fn a_direction_keeps_the_old_key_when_it_is_the_kinds_own() {
        assert_eq!(line_key("http", "GET", "/a", "in"), line_key("http", "GET", "/a", ""));
        assert_ne!(line_key("http", "GET", "/a", "inter"), line_key("http", "GET", "/a", "in"));
        assert_eq!(line_key("db", "", "SELECT ?", "inter"), "db\u{1f}\u{1f}SELECT ?");
        assert_eq!(dir_of("redis", ""), "inter");
        assert_eq!(dir_of("http", "sideways"), "in");
    }

    #[test]
    fn bucket_bounds_hold_their_values() {
        for us in [0u64, 5, 8, 9, 100, 1234, 999_999, 3_000_000_000] {
            let (lo, hi) = bucket_bounds_us(bucket(us));
            assert!(lo <= us && us < hi, "{us} in [{lo}, {hi})");
        }
    }

    #[tokio::test]
    async fn the_http_layer_names_the_route_template() {
        let app: Router = Router::new()
            .route("/api/things-test/{id}", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(http));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let res = reqwest::get(format!("http://{addr}/api/things-test/42")).await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(reqwest::get(format!("http://{addr}/nope-test")).await.unwrap().status(), 404);
        let snap: Snapshot = serde_json::from_value(snapshot()).unwrap();
        assert!(snap.rows.iter().any(|r| r.kind == "http" && r.name == "/api/things-test/{id}" && r.method == "GET"));
        assert!(!snap.rows.iter().any(|r| r.name.contains("42")));
    }
}
