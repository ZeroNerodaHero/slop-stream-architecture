use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch};

const QUEUE: usize = 1024;
const OUT_CHUNK: usize = 4096;
const CONNECT_WAIT: Duration = Duration::from_secs(10);
const REPLY_WAIT: Duration = Duration::from_secs(15);
const WRITE_WAIT: Duration = Duration::from_secs(10);
const CONFIG_WAIT: Duration = Duration::from_secs(10);
const HEALTHY: Duration = Duration::from_secs(60);
const BACKOFF_MAX: u64 = 30;
const MESSAGE_MAX: usize = 180;
const WINDOW: u32 = 2_500_000;

#[derive(Deserialize, Clone)]
pub struct Target {
    pub id: String,
    pub platform: String,
    pub url: String,
    pub key: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target")
            .field("id", &self.id)
            .field("platform", &self.platform)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Shape {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Status {
    pub id: String,
    pub state: &'static str,
    pub message: Option<String>,
}

#[derive(Clone)]
enum Packet {
    Video { ts: u32, key: bool, data: Arc<[u8]> },
    Audio { ts: u32, data: Arc<[u8]> },
}

struct Shared {
    shape: Shape,
    tx: broadcast::Sender<Packet>,
    video_config: Mutex<Option<Arc<[u8]>>>,
    audio_config: Mutex<Option<Arc<[u8]>>>,
    statuses: Mutex<HashMap<String, Status>>,
    stop: watch::Sender<bool>,
}

impl Shared {
    fn set(&self, t: &Target, state: &'static str, message: Option<String>) {
        if let Ok(mut all) = self.statuses.lock() {
            all.insert(
                t.id.clone(),
                Status {
                    id: t.id.clone(),
                    state,
                    message,
                },
            );
        }
    }
}

pub struct Restream {
    shared: Arc<Shared>,
}

impl Restream {
    pub fn start(targets: Vec<Target>, shape: Shape) -> Self {
        let (tx, _) = broadcast::channel(QUEUE);
        let (stop, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            shape,
            tx,
            video_config: Mutex::new(None),
            audio_config: Mutex::new(None),
            statuses: Mutex::new(HashMap::new()),
            stop,
        });
        for t in targets {
            shared.set(&t, "connecting", None);
            tokio::spawn(egress(Arc::clone(&shared), t));
        }
        Restream { shared }
    }

    pub fn push(&self, raw: &[u8]) -> Result<(), String> {
        if raw.len() < 6 {
            return Err("that packet is too short".into());
        }
        let ts = u32::from_be_bytes([raw[2], raw[3], raw[4], raw[5]]);
        if raw.len() == 6 {
            return Ok(());
        }
        let data: Arc<[u8]> = raw[6..].into();
        let slot = |m: &Mutex<Option<Arc<[u8]>>>| {
            m.lock()
                .map(|mut c| *c = Some(Arc::clone(&data)))
                .map_err(|_| "busy".to_string())
        };
        match raw[0] {
            0 => slot(&self.shared.video_config)?,
            1 => {
                let _ = self.shared.tx.send(Packet::Video {
                    ts,
                    key: raw[1] & 1 == 1,
                    data,
                });
            }
            2 => slot(&self.shared.audio_config)?,
            3 => {
                let _ = self.shared.tx.send(Packet::Audio { ts, data });
            }
            k => return Err(format!("no packet kind {k}")),
        }
        Ok(())
    }

    pub fn statuses(&self) -> Vec<Status> {
        let mut out: Vec<Status> = self
            .shared
            .statuses
            .lock()
            .map(|s| s.values().cloned().collect())
            .unwrap_or_default();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn stop(&self) {
        let _ = self.shared.stop.send(true);
    }
}

impl Drop for Restream {
    fn drop(&mut self) {
        self.stop();
    }
}

fn backoff(fails: u32) -> u64 {
    (1u64 << fails.saturating_sub(1).min(5)).min(BACKOFF_MAX)
}

pub fn scrub(line: &str, t: &Target) -> String {
    let mut out = line.to_owned();
    if !t.key.is_empty() {
        out = out.replace(&t.key, "<key>");
    }
    let clean: String = out.chars().filter(|c| !c.is_control()).collect();
    clean.trim().chars().take(MESSAGE_MAX).collect()
}

async fn egress(shared: Arc<Shared>, t: Target) {
    let mut stop = shared.stop.subscribe();
    let mut fails = 0u32;
    loop {
        if *stop.borrow() {
            break;
        }
        shared.set(&t, "connecting", None);
        let began = Instant::now();
        let rx = shared.tx.subscribe();
        let why = tokio::select! {
            r = publish(&shared, &t, rx) => match r {
                Ok(()) => "the server ended the stream".to_string(),
                Err(e) => e,
            },
            _ = stop.wait_for(|s| *s) => break,
        };
        if began.elapsed() >= HEALTHY {
            fails = 0;
        }
        fails += 1;
        let wait = backoff(fails);
        shared.set(
            &t,
            "error",
            Some(scrub(&format!("{why}. trying again in {wait}s"), &t)),
        );
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
            _ = stop.wait_for(|s| *s) => break,
        }
    }
    shared.set(&t, "off", None);
}

#[derive(Debug, PartialEq)]
pub struct Endpoint {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub app: String,
    pub tc_url: String,
    pub stream: String,
}

pub fn endpoint(url: &str, key: &str) -> Result<Endpoint, String> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("rtmps://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("rtmp://") {
        (false, r)
    } else {
        return Err("the address is not rtmp or rtmps".into());
    };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') || h.ends_with(']') => (
            h.to_owned(),
            p.parse::<u16>()
                .map_err(|_| "the port is not a number".to_string())?,
        ),
        _ => (authority.to_owned(), if tls { 443 } else { 1935 }),
    };
    if host.is_empty() {
        return Err("the address has no host".into());
    }
    let path = path.trim_matches('/');
    let (app, stream) = if key.is_empty() {
        match path.split_once('/') {
            Some((a, s)) => (a.to_owned(), s.to_owned()),
            None => (path.to_owned(), String::new()),
        }
    } else {
        (path.to_owned(), key.to_owned())
    };
    if stream.is_empty() {
        return Err("there is no stream key".into());
    }
    let scheme = if tls { "rtmps" } else { "rtmp" };
    let tc_url = format!("{scheme}://{authority}/{app}");
    Ok(Endpoint {
        tls,
        host,
        port,
        app,
        tc_url,
        stream,
    })
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

async fn open(ep: &Endpoint) -> Result<Box<dyn Io>, String> {
    let tcp = tokio::time::timeout(
        CONNECT_WAIT,
        TcpStream::connect((ep.host.as_str(), ep.port)),
    )
    .await
    .map_err(|_| format!("{} did not answer", ep.host))?
    .map_err(|e| format!("could not reach {} ({})", ep.host, e.kind()))?;
    let _ = tcp.set_nodelay(true);
    if !ep.tls {
        return Ok(Box::new(tcp));
    }
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("tls: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(ep.host.clone())
        .map_err(|_| format!("{} is not a host name", ep.host))?;
    let tls = tokio::time::timeout(
        CONNECT_WAIT,
        tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp),
    )
    .await
    .map_err(|_| format!("{} did not finish tls", ep.host))?
    .map_err(|e| format!("tls with {}: {e}", ep.host))?;
    Ok(Box::new(tls))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Amf {
    Num(f64),
    Bool(bool),
    Str(String),
    Obj(Vec<(String, Amf)>),
    Ecma(Vec<(String, Amf)>),
    Null,
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    out.extend_from_slice(&(b.len().min(u16::MAX as usize) as u16).to_be_bytes());
    out.extend_from_slice(&b[..b.len().min(u16::MAX as usize)]);
}

fn put_props(out: &mut Vec<u8>, props: &[(String, Amf)]) {
    for (k, v) in props {
        put_str(out, k);
        put_amf(out, v);
    }
    out.extend_from_slice(&[0, 0, 9]);
}

pub fn put_amf(out: &mut Vec<u8>, v: &Amf) {
    match v {
        Amf::Num(n) => {
            out.push(0);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Amf::Bool(b) => out.extend_from_slice(&[1, u8::from(*b)]),
        Amf::Str(s) => {
            out.push(2);
            put_str(out, s);
        }
        Amf::Obj(props) => {
            out.push(3);
            put_props(out, props);
        }
        Amf::Ecma(props) => {
            out.push(8);
            out.extend_from_slice(&(props.len() as u32).to_be_bytes());
            put_props(out, props);
        }
        Amf::Null => out.push(5),
    }
}

fn amf_all(values: &[Amf]) -> Vec<u8> {
    let mut out = Vec::new();
    for v in values {
        put_amf(&mut out, v);
    }
    out
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.i..self.i + n)?;
        self.i += n;
        Some(s)
    }

    fn string(&mut self) -> Option<String> {
        let n = self.take(2)?;
        let n = u16::from_be_bytes([n[0], n[1]]) as usize;
        Some(String::from_utf8_lossy(self.take(n)?).into_owned())
    }

    fn props(&mut self) -> Option<Vec<(String, Amf)>> {
        let mut out = Vec::new();
        loop {
            let k = self.string()?;
            if k.is_empty() {
                if self.take(1)? == [9] {
                    return Some(out);
                }
                return None;
            }
            out.push((k, self.value()?));
        }
    }

    fn value(&mut self) -> Option<Amf> {
        match self.take(1)?[0] {
            0 => {
                let b = self.take(8)?;
                Some(Amf::Num(f64::from_be_bytes(b.try_into().ok()?)))
            }
            1 => Some(Amf::Bool(self.take(1)?[0] != 0)),
            2 => Some(Amf::Str(self.string()?)),
            3 => Some(Amf::Obj(self.props()?)),
            5 | 6 => Some(Amf::Null),
            8 => {
                self.take(4)?;
                Some(Amf::Ecma(self.props()?))
            }
            _ => None,
        }
    }
}

pub fn read_amf(b: &[u8]) -> Vec<Amf> {
    let mut c = Cursor { b, i: 0 };
    let mut out = Vec::new();
    while c.i < b.len() {
        match c.value() {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}

fn field<'a>(v: &'a Amf, name: &str) -> Option<&'a Amf> {
    match v {
        Amf::Obj(p) | Amf::Ecma(p) => p.iter().find(|(k, _)| k == name).map(|(_, v)| v),
        _ => None,
    }
}

fn text(v: Option<&Amf>) -> Option<&str> {
    match v {
        Some(Amf::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

struct InMsg {
    ts: u32,
    delta: u32,
    len: usize,
    kind: u8,
    ext: bool,
    buf: Vec<u8>,
}

struct Reader<R> {
    r: R,
    chunk: usize,
    streams: HashMap<u32, InMsg>,
}

impl<R: AsyncRead + Unpin> Reader<R> {
    async fn u8(&mut self) -> io::Result<u8> {
        self.r.read_u8().await
    }

    async fn be(&mut self, n: usize) -> io::Result<u32> {
        let mut b = [0u8; 4];
        self.r.read_exact(&mut b[4 - n..]).await?;
        Ok(u32::from_be_bytes(b))
    }

    async fn next(&mut self) -> io::Result<(u8, Vec<u8>)> {
        loop {
            let b0 = self.u8().await?;
            let fmt = b0 >> 6;
            let csid = match u32::from(b0 & 0x3f) {
                0 => 64 + u32::from(self.u8().await?),
                1 => {
                    let lo = u32::from(self.u8().await?);
                    let hi = u32::from(self.u8().await?);
                    64 + lo + hi * 256
                }
                c => c,
            };
            let mut head = [0u32; 3];
            let mut stamp = None;
            if fmt <= 2 {
                stamp = Some(self.be(3).await?);
            }
            if fmt <= 1 {
                head[0] = self.be(3).await?;
                head[1] = u32::from(self.u8().await?);
            }
            if fmt == 0 {
                let mut sid = [0u8; 4];
                self.r.read_exact(&mut sid).await?;
                head[2] = u32::from_le_bytes(sid);
            }
            let st = self.streams.entry(csid).or_insert(InMsg {
                ts: 0,
                delta: 0,
                len: 0,
                kind: 0,
                ext: false,
                buf: Vec::new(),
            });
            if let Some(s) = stamp {
                st.ext = s == 0xFF_FFFF;
            }
            let ext = st.ext;
            if ext {
                let mut b = [0u8; 4];
                self.r.read_exact(&mut b).await?;
                if stamp.is_some() {
                    stamp = Some(u32::from_be_bytes(b));
                }
            }
            let st = self
                .streams
                .get_mut(&csid)
                .ok_or_else(|| io::Error::other("lost chunk stream"))?;
            if fmt <= 1 {
                st.len = head[0] as usize;
                st.kind = head[1] as u8;
            }
            if st.buf.is_empty() {
                match (fmt, stamp) {
                    (0, Some(s)) => {
                        st.ts = s;
                        st.delta = 0;
                    }
                    (_, Some(d)) => {
                        st.delta = d;
                        st.ts = st.ts.wrapping_add(d);
                    }
                    _ => st.ts = st.ts.wrapping_add(st.delta),
                }
            }
            if st.len > 16 * 1024 * 1024 {
                return Err(io::Error::other(
                    "the server sent a message that is too big",
                ));
            }
            let want = (st.len - st.buf.len()).min(self.chunk);
            let at = st.buf.len();
            st.buf.resize(at + want, 0);
            self.r.read_exact(&mut st.buf[at..]).await?;
            if st.buf.len() < st.len {
                continue;
            }
            let kind = st.kind;
            let body = std::mem::take(&mut st.buf);
            if kind == 1 && body.len() >= 4 {
                self.chunk = (u32::from_be_bytes([body[0], body[1], body[2], body[3]])
                    & 0x7fff_ffff)
                    .max(1) as usize;
                continue;
            }
            return Ok((kind, body));
        }
    }
}

struct Writer<W> {
    w: W,
    chunk: usize,
    buf: Vec<u8>,
}

impl<W: AsyncWrite + Unpin> Writer<W> {
    async fn send(
        &mut self,
        csid: u8,
        kind: u8,
        sid: u32,
        ts: u32,
        payload: &[u8],
    ) -> Result<(), String> {
        self.buf.clear();
        let ext = ts >= 0xFF_FFFF;
        let stamp = if ext { 0xFF_FFFF } else { ts };
        self.buf.push(csid & 0x3f);
        self.buf.extend_from_slice(&stamp.to_be_bytes()[1..]);
        self.buf
            .extend_from_slice(&(payload.len() as u32).to_be_bytes()[1..]);
        self.buf.push(kind);
        self.buf.extend_from_slice(&sid.to_le_bytes());
        if ext {
            self.buf.extend_from_slice(&ts.to_be_bytes());
        }
        for (i, part) in payload.chunks(self.chunk).enumerate() {
            if i > 0 {
                self.buf.push(0xC0 | (csid & 0x3f));
                if ext {
                    self.buf.extend_from_slice(&ts.to_be_bytes());
                }
            }
            self.buf.extend_from_slice(part);
        }
        tokio::time::timeout(WRITE_WAIT, self.w.write_all(&self.buf))
            .await
            .map_err(|_| "the server stopped taking data".to_string())?
            .map_err(|e| format!("the connection dropped ({})", e.kind()))
    }

    async fn command(&mut self, sid: u32, values: &[Amf]) -> Result<(), String> {
        self.send(3, 20, sid, 0, &amf_all(values)).await
    }
}

async fn handshake(io: &mut Box<dyn Io>) -> Result<(), String> {
    let lost = |e: io::Error| format!("the handshake failed ({})", e.kind());
    let mut c1 = vec![0u8; 1537];
    c1[0] = 3;
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(7)
        ^ std::process::id();
    let mut x = seed | 1;
    for b in c1[9..].iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    io.write_all(&c1).await.map_err(lost)?;
    let mut s0s1 = vec![0u8; 1537];
    tokio::time::timeout(REPLY_WAIT, io.read_exact(&mut s0s1))
        .await
        .map_err(|_| "the server did not shake hands".to_string())?
        .map_err(lost)?;
    if s0s1[0] != 3 {
        return Err(format!("the server speaks rtmp version {}", s0s1[0]));
    }
    io.write_all(&s0s1[1..]).await.map_err(lost)?;
    let mut s2 = vec![0u8; 1536];
    tokio::time::timeout(REPLY_WAIT, io.read_exact(&mut s2))
        .await
        .map_err(|_| "the server did not finish the handshake".to_string())?
        .map_err(lost)?;
    Ok(())
}

enum Heard {
    Ping(u32),
    Gone(String),
}

async fn answer<W: AsyncWrite + Unpin>(
    w: &mut Writer<W>,
    kind: u8,
    body: &[u8],
) -> Result<(), String> {
    match kind {
        4 if body.len() >= 6 && body[0..2] == [0, 6] => {
            let mut pong = vec![0, 7];
            pong.extend_from_slice(&body[2..6]);
            w.send(2, 4, 0, 0, &pong).await
        }
        6 => w.send(2, 5, 0, 0, &WINDOW.to_be_bytes()).await,
        _ => Ok(()),
    }
}

async fn reply<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    r: &mut Reader<R>,
    w: &mut Writer<W>,
    txn: f64,
) -> Result<Vec<Amf>, String> {
    let deadline = Instant::now() + REPLY_WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let (kind, body) = tokio::time::timeout(left, r.next())
            .await
            .map_err(|_| "the server did not answer".to_string())?
            .map_err(|e| format!("the connection dropped ({})", e.kind()))?;
        if kind != 20 && kind != 17 {
            answer(w, kind, &body).await?;
            continue;
        }
        let body = if kind == 17 {
            &body[1.min(body.len())..]
        } else {
            &body[..]
        };
        let values = read_amf(body);
        let name = match values.first() {
            Some(Amf::Str(s)) => s.as_str(),
            _ => continue,
        };
        let id = match values.get(1) {
            Some(Amf::Num(n)) => *n,
            _ => -1.0,
        };
        if id != txn {
            continue;
        }
        if name == "_error" {
            let why = values
                .iter()
                .find_map(|v| text(field(v, "description")).or_else(|| text(field(v, "code"))))
                .unwrap_or("it refused");
            return Err(format!("the server said no: {why}"));
        }
        return Ok(values);
    }
}

async fn published<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    r: &mut Reader<R>,
    w: &mut Writer<W>,
) -> Result<(), String> {
    let deadline = Instant::now() + REPLY_WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let (kind, body) = tokio::time::timeout(left, r.next())
            .await
            .map_err(|_| "the server did not start the stream".to_string())?
            .map_err(|e| format!("the connection dropped ({})", e.kind()))?;
        if kind != 20 && kind != 17 {
            answer(w, kind, &body).await?;
            continue;
        }
        let body = if kind == 17 {
            &body[1.min(body.len())..]
        } else {
            &body[..]
        };
        let values = read_amf(body);
        if !matches!(values.first(), Some(Amf::Str(s)) if s == "onStatus") {
            continue;
        }
        let info = values.iter().find(|v| field(v, "code").is_some());
        let code = info
            .and_then(|v| text(field(v, "code")))
            .unwrap_or_default();
        if code == "NetStream.Publish.Start" {
            return Ok(());
        }
        let level = info
            .and_then(|v| text(field(v, "level")))
            .unwrap_or_default();
        if level == "error"
            || code.contains("Failed")
            || code.contains("BadName")
            || code.contains("Rejected")
        {
            let why = info
                .and_then(|v| text(field(v, "description")))
                .filter(|d| !d.is_empty())
                .unwrap_or(code);
            return Err(format!("the server refused the stream: {why}"));
        }
    }
}

fn metadata(shape: &Shape, audio: bool) -> Vec<u8> {
    let mut props = vec![
        ("duration".to_string(), Amf::Num(0.0)),
        ("width".to_string(), Amf::Num(f64::from(shape.width))),
        ("height".to_string(), Amf::Num(f64::from(shape.height))),
        (
            "videodatarate".to_string(),
            Amf::Num(f64::from(shape.video_kbps)),
        ),
        ("framerate".to_string(), Amf::Num(f64::from(shape.fps))),
        ("videocodecid".to_string(), Amf::Num(7.0)),
    ];
    if audio {
        props.extend([
            (
                "audiodatarate".to_string(),
                Amf::Num(f64::from(shape.audio_kbps)),
            ),
            ("audiosamplerate".to_string(), Amf::Num(48000.0)),
            ("audiosamplesize".to_string(), Amf::Num(16.0)),
            ("stereo".to_string(), Amf::Bool(true)),
            ("audiocodecid".to_string(), Amf::Num(10.0)),
        ]);
    }
    props.push(("encoder".to_string(), Amf::Str("nodentity".into())));
    amf_all(&[
        Amf::Str("@setDataFrame".into()),
        Amf::Str("onMetaData".into()),
        Amf::Ecma(props),
    ])
}

pub fn video_tag(key: bool, config: bool, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 5);
    out.push(if key || config { 0x17 } else { 0x27 });
    out.push(if config { 0 } else { 1 });
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(data);
    out
}

pub fn audio_tag(config: bool, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 2);
    out.push(0xAF);
    out.push(if config { 0 } else { 1 });
    out.extend_from_slice(data);
    out
}

async fn listen<R: AsyncRead + Unpin + Send + 'static>(mut r: Reader<R>, tx: mpsc::Sender<Heard>) {
    loop {
        match r.next().await {
            Ok((4, body)) if body.len() >= 6 && body[0..2] == [0, 6] => {
                let _ = tx
                    .send(Heard::Ping(u32::from_be_bytes([
                        body[2], body[3], body[4], body[5],
                    ])))
                    .await;
            }
            Ok((20, body)) => {
                let values = read_amf(&body);
                let info = values.iter().find(|v| field(v, "code").is_some());
                let level = info
                    .and_then(|v| text(field(v, "level")))
                    .unwrap_or_default();
                if level == "error" {
                    let why = info
                        .and_then(|v| {
                            text(field(v, "description")).or_else(|| text(field(v, "code")))
                        })
                        .unwrap_or("it stopped");
                    let _ = tx
                        .send(Heard::Gone(format!("the server stopped the stream: {why}")))
                        .await;
                    return;
                }
            }
            Ok(_) => {}
            Err(e) => {
                let why = if e.kind() == io::ErrorKind::UnexpectedEof {
                    "the server closed the connection".to_string()
                } else {
                    format!("the connection dropped ({})", e.kind())
                };
                let _ = tx.send(Heard::Gone(why)).await;
                return;
            }
        }
    }
}

async fn config_of(m: &Mutex<Option<Arc<[u8]>>>, wait: Duration) -> Option<Arc<[u8]>> {
    let until = Instant::now() + wait;
    loop {
        if let Some(c) = m.lock().ok().and_then(|c| c.clone()) {
            return Some(c);
        }
        if Instant::now() >= until {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn publish(
    shared: &Shared,
    t: &Target,
    mut rx: broadcast::Receiver<Packet>,
) -> Result<(), String> {
    let ep = endpoint(&t.url, &t.key)?;
    let mut io = open(&ep).await?;
    handshake(&mut io).await?;
    let (rh, wh) = tokio::io::split(io);
    let mut r = Reader {
        r: rh,
        chunk: 128,
        streams: HashMap::new(),
    };
    let mut w = Writer {
        w: wh,
        chunk: 128,
        buf: Vec::new(),
    };
    w.send(2, 1, 0, 0, &(OUT_CHUNK as u32).to_be_bytes())
        .await?;
    w.chunk = OUT_CHUNK;
    w.command(
        0,
        &[
            Amf::Str("connect".into()),
            Amf::Num(1.0),
            Amf::Obj(vec![
                ("app".into(), Amf::Str(ep.app.clone())),
                ("type".into(), Amf::Str("nonprivate".into())),
                (
                    "flashVer".into(),
                    Amf::Str("FMLE/3.0 (compatible; FMSc/1.0)".into()),
                ),
                ("tcUrl".into(), Amf::Str(ep.tc_url.clone())),
            ]),
        ],
    )
    .await?;
    reply(&mut r, &mut w, 1.0).await?;
    w.send(2, 5, 0, 0, &WINDOW.to_be_bytes()).await?;
    w.command(
        0,
        &[
            Amf::Str("releaseStream".into()),
            Amf::Num(2.0),
            Amf::Null,
            Amf::Str(ep.stream.clone()),
        ],
    )
    .await?;
    w.command(
        0,
        &[
            Amf::Str("FCPublish".into()),
            Amf::Num(3.0),
            Amf::Null,
            Amf::Str(ep.stream.clone()),
        ],
    )
    .await?;
    w.command(
        0,
        &[Amf::Str("createStream".into()), Amf::Num(4.0), Amf::Null],
    )
    .await?;
    let made = reply(&mut r, &mut w, 4.0).await?;
    let sid = made
        .iter()
        .skip(2)
        .find_map(|v| {
            if let Amf::Num(n) = v {
                Some(*n as u32)
            } else {
                None
            }
        })
        .unwrap_or(1);
    w.command(
        sid,
        &[
            Amf::Str("publish".into()),
            Amf::Num(5.0),
            Amf::Null,
            Amf::Str(ep.stream.clone()),
            Amf::Str("live".into()),
        ],
    )
    .await?;
    published(&mut r, &mut w).await?;
    let Some(video_config) = config_of(&shared.video_config, CONFIG_WAIT).await else {
        return Err("the app has not started its video encoder".into());
    };
    let mut audio_config = config_of(&shared.audio_config, Duration::from_millis(500)).await;
    w.send(
        5,
        18,
        sid,
        0,
        &metadata(&shared.shape, audio_config.is_some()),
    )
    .await?;
    w.send(6, 9, sid, 0, &video_tag(true, true, &video_config))
        .await?;
    if let Some(c) = &audio_config {
        w.send(4, 8, sid, 0, &audio_tag(true, c)).await?;
    }
    let (heard_tx, mut heard) = mpsc::channel(8);
    let listener = tokio::spawn(listen(r, heard_tx));
    let _stop_listening = AbortOnDrop(listener);
    let mut base: Option<u32> = None;
    let mut live = false;
    loop {
        tokio::select! {
            h = heard.recv() => match h {
                Some(Heard::Ping(at)) => {
                    let mut pong = vec![0, 7];
                    pong.extend_from_slice(&at.to_be_bytes());
                    w.send(2, 4, 0, 0, &pong).await?;
                }
                Some(Heard::Gone(why)) => return Err(why),
                None => return Err("the connection dropped".into()),
            },
            p = rx.recv() => match p {
                Ok(Packet::Video { ts, key, data }) => {
                    if base.is_none() {
                        if !key {
                            continue;
                        }
                        base = Some(ts);
                    }
                    let at = ts.saturating_sub(base.unwrap_or(ts));
                    w.send(6, 9, sid, at, &video_tag(key, false, &data)).await?;
                    if !live {
                        live = true;
                        shared.set(t, "live", None);
                    }
                }
                Ok(Packet::Audio { ts, data }) => {
                    let Some(b) = base else { continue };
                    if ts < b {
                        continue;
                    }
                    if audio_config.is_none() {
                        audio_config = shared.audio_config.lock().ok().and_then(|c| c.clone());
                        match &audio_config {
                            Some(c) => w.send(4, 8, sid, ts - b, &audio_tag(true, c)).await?,
                            None => continue,
                        }
                    }
                    w.send(4, 8, sid, ts - b, &audio_tag(false, &data)).await?;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    return Err("this connection could not keep up".into());
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(key: &str) -> Target {
        Target {
            id: "a".into(),
            platform: "twitch".into(),
            url: "rtmps://live.twitch.tv/app".into(),
            key: key.into(),
        }
    }

    #[test]
    fn addresses_split_into_app_and_stream() {
        let ep = endpoint("rtmps://live.twitch.tv/app", "live_1_x").unwrap();
        assert_eq!(
            ep,
            Endpoint {
                tls: true,
                host: "live.twitch.tv".into(),
                port: 443,
                app: "app".into(),
                tc_url: "rtmps://live.twitch.tv/app".into(),
                stream: "live_1_x".into()
            }
        );
        let ep = endpoint("rtmp://127.0.0.1:19350/live/", "k").unwrap();
        assert_eq!(
            (ep.tls, ep.port, ep.app.as_str(), ep.tc_url.as_str()),
            (false, 19350, "live", "rtmp://127.0.0.1:19350/live")
        );
        let ep = endpoint("rtmp://host/app/inner", "").unwrap();
        assert_eq!((ep.app.as_str(), ep.stream.as_str()), ("app", "inner"));
        assert!(endpoint("https://x/app", "k").is_err());
        assert!(endpoint("rtmp://host/app", "").is_err());
        assert!(endpoint("rtmp://host:nope/app", "k").is_err());
    }

    #[test]
    fn amf_round_trips() {
        let values = vec![
            Amf::Str("connect".into()),
            Amf::Num(1.0),
            Amf::Null,
            Amf::Obj(vec![
                ("code".into(), Amf::Str("NetStream.Publish.Start".into())),
                ("ok".into(), Amf::Bool(true)),
            ]),
            Amf::Ecma(vec![("w".into(), Amf::Num(1920.0))]),
        ];
        assert_eq!(read_amf(&amf_all(&values)), values);
        assert_eq!(
            text(field(&values[3], "code")),
            Some("NetStream.Publish.Start")
        );
    }

    #[test]
    fn keys_never_reach_a_message() {
        assert_eq!(
            scrub(
                "refused live_123_abc on live_123_abc\n",
                &target("live_123_abc")
            ),
            "refused <key> on <key>"
        );
        assert!(scrub(&"x".repeat(400), &target("k")).len() <= MESSAGE_MAX);
        assert!(!format!("{:?}", target("live_123_abc")).contains("live_123_abc"));
    }

    #[test]
    fn flv_tags_carry_their_headers() {
        assert_eq!(video_tag(true, true, &[1, 2]), vec![0x17, 0, 0, 0, 0, 1, 2]);
        assert_eq!(video_tag(false, false, &[9]), vec![0x27, 1, 0, 0, 0, 9]);
        assert_eq!(audio_tag(true, &[0x11, 0x90]), vec![0xAF, 0, 0x11, 0x90]);
        assert_eq!(backoff(1), 1);
        assert_eq!(backoff(6), 30);
        assert_eq!(backoff(40), 30);
    }

    #[tokio::test]
    async fn long_messages_split_into_chunks_and_read_back_whole() {
        let (a, b) = tokio::io::duplex(1 << 20);
        let mut w = Writer {
            w: a,
            chunk: 128,
            buf: Vec::new(),
        };
        let mut r = Reader {
            r: b,
            chunk: 128,
            streams: HashMap::new(),
        };
        let payload: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        w.send(6, 9, 1, 0x0100_0000, &payload).await.unwrap();
        w.send(2, 1, 0, 0, &4096u32.to_be_bytes()).await.unwrap();
        w.chunk = 4096;
        w.send(4, 8, 1, 5, &payload).await.unwrap();
        assert_eq!(r.next().await.unwrap(), (9, payload.clone()));
        assert_eq!(r.next().await.unwrap(), (8, payload));
        assert_eq!(r.chunk, 4096);
    }
}
