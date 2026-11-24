use std::collections::{HashMap, VecDeque};
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::task::JoinSet;

const DOCKER_TIMEOUT: Duration = Duration::from_secs(5);
const DOCKER_MAX_BYTES: u64 = 8 << 20;
const MIN_TOKEN_CHARS: usize = 16;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Sample {
    pub(crate) at: DateTime<Utc>,
    pub(crate) host: Host,
    pub(crate) containers: Vec<Container>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) problems: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) timings: Vec<crate::timings::Timing>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Host {
    pub(crate) hostname: Option<String>,
    pub(crate) cpus: Option<u32>,
    pub(crate) up_secs: Option<u64>,
    pub(crate) cpu_pct: Option<f64>,
    pub(crate) steal_pct: Option<f64>,
    pub(crate) iowait_pct: Option<f64>,
    pub(crate) load1: Option<f64>,
    pub(crate) load5: Option<f64>,
    pub(crate) load15: Option<f64>,
    pub(crate) mem_used: Option<u64>,
    pub(crate) mem_total: Option<u64>,
    pub(crate) swap_used: Option<u64>,
    pub(crate) swap_total: Option<u64>,
    pub(crate) disk: Vec<Disk>,
    pub(crate) net: Option<Net>,
    pub(crate) pressure: Pressure,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct Disk {
    pub(crate) mount: String,
    pub(crate) used: u64,
    pub(crate) total: u64,
    pub(crate) avail: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct Net {
    pub(crate) iface: String,
    pub(crate) rx_bps: Option<f64>,
    pub(crate) tx_bps: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Pressure {
    pub(crate) cpu: Option<f64>,
    pub(crate) memory: Option<f64>,
    pub(crate) io: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Container {
    pub(crate) name: String,
    pub(crate) service: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) image: String,
    pub(crate) state: String,
    pub(crate) health: Option<String>,
    pub(crate) up_since: Option<DateTime<Utc>>,
    pub(crate) restarts: Option<u64>,
    pub(crate) cpu_pct: Option<f64>,
    pub(crate) mem_bytes: Option<u64>,
    pub(crate) mem_limit: Option<u64>,
    pub(crate) rx_bps: Option<f64>,
    pub(crate) tx_bps: Option<f64>,
    pub(crate) read_bps: Option<f64>,
    pub(crate) write_bps: Option<f64>,
    pub(crate) pids: Option<u64>,
    pub(crate) exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) networks: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) ports: Vec<Port>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) depends_on: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[serde(default)]
pub(crate) struct Port {
    pub(crate) port: u16,
    pub(crate) proto: String,
    pub(crate) published: Option<u16>,
    pub(crate) loopback: bool,
}

fn parse_ports(summary: &Value) -> Vec<Port> {
    let mut seen: Vec<(Port, bool)> = vec![];
    for p in summary.get("Ports").and_then(Value::as_array).into_iter().flatten() {
        let Some(port) = p.get("PrivatePort").and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok()) else { continue };
        let proto = p.get("Type").and_then(Value::as_str).unwrap_or("tcp").to_owned();
        let published = p.get("PublicPort").and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok());
        let local = p.get("IP").and_then(Value::as_str).is_some_and(|ip| ip.parse::<std::net::IpAddr>().is_ok_and(|a| a.is_loopback()));
        let key = Port { port, proto, published, loopback: false };
        match seen.iter_mut().find(|(k, _)| *k == key) {
            Some((_, all_local)) => *all_local &= local,
            None => seen.push((key, local)),
        }
    }
    let mut out: Vec<Port> = seen.into_iter().map(|(p, local)| Port { loopback: p.published.is_some() && local, ..p }).collect();
    out.sort();
    out
}

fn parse_networks(summary: &Value) -> Vec<String> {
    let mut out: Vec<String> = summary.pointer("/NetworkSettings/Networks").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
    out.sort();
    out
}

fn parse_depends_on(label: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = label.unwrap_or("").split(',').filter_map(|d| d.split(':').next()).map(str::trim).filter(|d| !d.is_empty()).map(str::to_owned).collect();
    out.sort();
    out.dedup();
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CpuTimes {
    total: u64,
    busy: u64,
    steal: u64,
    iowait: u64,
}

#[derive(Clone)]
struct HostRaw {
    at: Instant,
    cpu: Option<CpuTimes>,
    net: Option<(String, u64, u64)>,
    psi: [Option<u64>; 3],
}

#[derive(Clone, Copy)]
struct ContainerRaw {
    read: DateTime<Utc>,
    cpu_ns: u64,
    rx: Option<u64>,
    tx: Option<u64>,
    rd: u64,
    wr: u64,
}

#[derive(Clone, Default)]
struct DockerInfo {
    name: Option<String>,
    root: Option<String>,
}

struct Config {
    port: u16,
    every: Duration,
    keep: usize,
    proc_dir: PathBuf,
    socket: String,
    disk_path: Option<PathBuf>,
    iface: Option<String>,
    token: Option<String>,
    build: String,
}

#[derive(Clone)]
struct App {
    cfg: Arc<Config>,
    ring: Arc<Mutex<VecDeque<Sample>>>,
    started: Instant,
}

fn rate(prev: u64, cur: u64, secs: f64) -> Option<f64> {
    (cur >= prev && secs > 0.0).then(|| round((cur - prev) as f64 / secs, 0))
}

pub(crate) fn round(v: f64, dp: i32) -> f64 {
    let m = 10f64.powi(dp);
    (v * m).round() / m
}

fn pct(part: u64, whole: u64) -> Option<f64> {
    (whole > 0).then(|| round(100.0 * part as f64 / whole as f64, 2))
}

fn parse_cpu(stat: &str) -> Option<CpuTimes> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    let get = |i: usize| v.get(i).copied().unwrap_or(0);
    let (idle, iowait, steal) = (get(3), get(4), get(7));
    let total: u64 = v.iter().take(8).sum();
    Some(CpuTimes { total, busy: total.saturating_sub(idle + iowait), steal, iowait })
}

fn count_cpus(stat: &str) -> u32 {
    stat.lines().filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(u8::is_ascii_digit)).count() as u32
}

fn cpu_shares(prev: CpuTimes, cur: CpuTimes) -> Option<(f64, f64, f64)> {
    let total = cur.total.checked_sub(prev.total).filter(|t| *t > 0)?;
    let d = |a: u64, b: u64| b.saturating_sub(a);
    Some((pct(d(prev.busy, cur.busy), total)?, pct(d(prev.steal, cur.steal), total)?, pct(d(prev.iowait, cur.iowait), total)?))
}

fn parse_meminfo(s: &str) -> HashMap<&str, u64> {
    s.lines()
        .filter_map(|l| {
            let (k, rest) = l.split_once(':')?;
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            Some((k.trim(), kb * 1024))
        })
        .collect()
}

fn parse_loadavg(s: &str) -> Option<(f64, f64, f64)> {
    let mut it = s.split_whitespace().map(|x| x.parse::<f64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

fn parse_psi_total(s: &str) -> Option<u64> {
    s.lines().find(|l| l.starts_with("some "))?.split_whitespace().find_map(|kv| kv.strip_prefix("total="))?.parse().ok()
}

fn parse_net_dev(s: &str, iface: &str) -> Option<(u64, u64)> {
    s.lines().find_map(|l| {
        let (name, rest) = l.split_once(':')?;
        if name.trim() != iface {
            return None;
        }
        let v: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        Some((*v.first()?, *v.get(8)?))
    })
}

fn default_iface(route: &str) -> Option<String> {
    route
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let metric: u64 = f.get(6)?.parse().ok()?;
            (f.get(1) == Some(&"00000000") && f.get(7) == Some(&"00000000")).then(|| (metric, f[0].to_owned()))
        })
        .min()
        .map(|(_, iface)| iface)
}

fn parse_uptime(s: &str) -> Option<u64> {
    s.split_whitespace().next()?.parse::<f64>().ok().map(|f| f as u64)
}

#[cfg(target_os = "linux")]
fn disk_usage(path: &std::path::Path) -> Option<(u64, u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let f = s.f_frsize as u64;
    let (blocks, free, avail) = (s.f_blocks as u64, s.f_bfree as u64, s.f_bavail as u64);
    Some((blocks.saturating_sub(free) * f, blocks * f, avail * f))
}

#[cfg(not(target_os = "linux"))]
fn disk_usage(_: &std::path::Path) -> Option<(u64, u64, u64)> {
    None
}

fn read_host(cfg: &Config, info: &DockerInfo, prev: Option<&HostRaw>, problems: &mut Vec<String>) -> (Host, HostRaw) {
    let now = Instant::now();
    let read = |rel: &str| std::fs::read_to_string(cfg.proc_dir.join(rel)).ok();
    let mut h = Host { hostname: info.name.clone(), ..Default::default() };
    let secs = prev.map(|p| now.duration_since(p.at).as_secs_f64()).unwrap_or(0.0);

    let stat = read("stat");
    let cpu = stat.as_deref().and_then(parse_cpu);
    if cpu.is_none() {
        problems.push(format!("cannot read {}", cfg.proc_dir.join("stat").display()));
    }
    h.cpus = stat.as_deref().map(count_cpus).filter(|n| *n > 0);
    if let (Some(p), Some(c)) = (prev.and_then(|p| p.cpu), cpu) {
        if let Some((busy, steal, iowait)) = cpu_shares(p, c) {
            (h.cpu_pct, h.steal_pct, h.iowait_pct) = (Some(busy), Some(steal), Some(iowait));
        }
    }

    if let Some((a, b, c)) = read("loadavg").as_deref().and_then(parse_loadavg) {
        (h.load1, h.load5, h.load15) = (Some(a), Some(b), Some(c));
    }
    h.up_secs = read("uptime").as_deref().and_then(parse_uptime);

    if let Some(mi) = read("meminfo") {
        let m = parse_meminfo(&mi);
        h.mem_total = m.get("MemTotal").copied();
        h.mem_used = match (m.get("MemTotal"), m.get("MemAvailable")) {
            (Some(t), Some(a)) => Some(t.saturating_sub(*a)),
            _ => None,
        };
        h.swap_total = m.get("SwapTotal").copied();
        h.swap_used = match (m.get("SwapTotal"), m.get("SwapFree")) {
            (Some(t), Some(f)) => Some(t.saturating_sub(*f)),
            _ => None,
        };
    }

    if let Some(path) = &cfg.disk_path {
        match disk_usage(path) {
            Some((used, total, avail)) => {
                let mount = match info.root.clone() {
                    Some(root) if path.as_os_str() != "/" => root,
                    _ => path.display().to_string(),
                };
                h.disk.push(Disk { mount, used, total, avail });
            }
            None => problems.push(format!("cannot statvfs {}", path.display())),
        }
    }

    let iface = cfg.iface.clone().or_else(|| read("1/net/route").as_deref().and_then(default_iface));
    let net = iface.and_then(|i| {
        let dev = read("1/net/dev")?;
        parse_net_dev(&dev, &i).map(|(rx, tx)| (i, rx, tx))
    });
    if let Some((iface, rx, tx)) = &net {
        let (rx_bps, tx_bps) = match prev.and_then(|p| p.net.as_ref()) {
            Some((pi, prx, ptx)) if pi == iface => (rate(*prx, *rx, secs).map(|b| b * 8.0), rate(*ptx, *tx, secs).map(|b| b * 8.0)),
            _ => (None, None),
        };
        h.net = Some(Net { iface: iface.clone(), rx_bps, tx_bps });
    }

    let psi = ["pressure/cpu", "pressure/memory", "pressure/io"].map(|f| read(f).as_deref().and_then(parse_psi_total));
    let stall = |i: usize| match (prev.and_then(|p| p.psi[i]), psi[i]) {
        (Some(a), Some(b)) if b >= a && secs > 0.0 => Some(round(((b - a) as f64 / (secs * 1e6) * 100.0).min(100.0), 2)),
        _ => None,
    };
    h.pressure = Pressure { cpu: stall(0), memory: stall(1), io: stall(2) };

    (h, HostRaw { at: now, cpu, net, psi })
}

fn dechunk(mut body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(body.len());
    loop {
        let eol = body.windows(2).position(|w| w == b"\r\n").ok_or("docker: bad chunked body")?;
        let size_hex = std::str::from_utf8(&body[..eol]).map_err(|_| "docker: bad chunk size")?;
        let size = usize::from_str_radix(size_hex.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "docker: bad chunk size")?;
        body = &body[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size {
            return Err("docker: short chunk".into());
        }
        out.extend_from_slice(&body[..size]);
        body = body.get(size + 2..).unwrap_or(&[]);
    }
}

fn parse_http(buf: &[u8]) -> Result<Value, String> {
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("docker: no http answer")?;
    let head = std::str::from_utf8(&buf[..split]).map_err(|_| "docker: bad header")?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).ok_or("docker: bad status line")?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let raw = &buf[split + 4..];
    let body = if chunked { dechunk(raw)? } else { raw.to_vec() };
    if status != 200 {
        let text: String = String::from_utf8_lossy(&body).trim().chars().take(200).collect();
        return Err(format!("docker answered {status}: {text}"));
    }
    serde_json::from_slice(&body).map_err(|e| format!("docker: bad json: {e}"))
}

async fn docker_get(socket: &str, path: &str) -> Result<Value, String> {
    let talk = async {
        let mut s = tokio::net::UnixStream::connect(socket).await.map_err(|e| format!("{socket}: {e}"))?;
        s.write_all(format!("GET {path} HTTP/1.0\r\nHost: docker\r\n\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        (&mut s).take(DOCKER_MAX_BYTES).read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        Ok::<_, String>(buf)
    };
    let buf = tokio::time::timeout(DOCKER_TIMEOUT, talk).await.map_err(|_| format!("no answer from docker in {}s", DOCKER_TIMEOUT.as_secs()))??;
    parse_http(&buf)
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

fn u64_at(v: &Value, path: &[&str]) -> Option<u64> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_u64()
}

fn time_at(v: &Value, path: &[&str]) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(str_at(v, path)?).ok().map(|t| t.with_timezone(&Utc)).filter(|t| t.timestamp() > 0)
}

fn stats_raw(stats: &Value) -> Option<ContainerRaw> {
    let read = time_at(stats, &["read"])?;
    let cpu_ns = u64_at(stats, &["cpu_stats", "cpu_usage", "total_usage"])?;
    let nets = stats.get("networks").and_then(Value::as_object);
    let sum = |k: &str| nets.map(|n| n.values().filter_map(|i| i.get(k).and_then(Value::as_u64)).sum::<u64>());
    let (mut rd, mut wr) = (0, 0);
    for e in stats.pointer("/blkio_stats/io_service_bytes_recursive").and_then(Value::as_array).into_iter().flatten() {
        let v = e.get("value").and_then(Value::as_u64).unwrap_or(0);
        match e.get("op").and_then(Value::as_str).map(str::to_ascii_lowercase).as_deref() {
            Some("read") => rd += v,
            Some("write") => wr += v,
            _ => {}
        }
    }
    Some(ContainerRaw { read, cpu_ns, rx: sum("rx_bytes"), tx: sum("tx_bytes"), rd, wr })
}

fn mem_in_use(stats: &Value) -> Option<u64> {
    let usage = u64_at(stats, &["memory_stats", "usage"])?;
    let cache = u64_at(stats, &["memory_stats", "stats", "inactive_file"]).or_else(|| u64_at(stats, &["memory_stats", "stats", "total_inactive_file"])).unwrap_or(0);
    Some(if cache < usage { usage - cache } else { usage })
}

fn container_rates(c: &mut Container, prev: Option<&ContainerRaw>, cur: &ContainerRaw) {
    let Some(p) = prev else { return };
    let secs = (cur.read - p.read).num_microseconds().unwrap_or(0) as f64 / 1e6;
    if secs <= 0.0 {
        return;
    }
    c.cpu_pct = (cur.cpu_ns >= p.cpu_ns).then(|| round((cur.cpu_ns - p.cpu_ns) as f64 / (secs * 1e9) * 100.0, 2));
    c.rx_bps = p.rx.zip(cur.rx).and_then(|(a, b)| rate(a, b, secs)).map(|b| b * 8.0);
    c.tx_bps = p.tx.zip(cur.tx).and_then(|(a, b)| rate(a, b, secs)).map(|b| b * 8.0);
    c.read_bps = rate(p.rd, cur.rd, secs);
    c.write_bps = rate(p.wr, cur.wr, secs);
}

async fn one_container(socket: String, summary: Value) -> Option<(String, Container, Option<ContainerRaw>)> {
    let id = summary.get("Id")?.as_str()?.to_owned();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let name = summary.get("Names").and_then(Value::as_array).and_then(|n| n.first()).and_then(Value::as_str).unwrap_or(&id).trim_start_matches('/').to_owned();
    let label = |k: &str| summary.get("Labels").and_then(|l| l.get(k)).and_then(Value::as_str).map(str::to_owned);
    let state = summary.get("State").and_then(Value::as_str).unwrap_or("unknown").to_owned();
    let mut c = Container {
        name,
        service: label("com.docker.compose.service"),
        project: label("com.docker.compose.project"),
        image: summary.get("Image").and_then(Value::as_str).unwrap_or("").to_owned(),
        state: state.clone(),
        networks: parse_networks(&summary),
        ports: parse_ports(&summary),
        depends_on: parse_depends_on(label("com.docker.compose.depends_on").as_deref()),
        ..Default::default()
    };
    if let Ok(inspect) = docker_get(&socket, &format!("/containers/{id}/json")).await {
        c.restarts = u64_at(&inspect, &["RestartCount"]);
        c.health = str_at(&inspect, &["State", "Health", "Status"]).map(str::to_owned);
        if state == "running" {
            c.up_since = time_at(&inspect, &["State", "StartedAt"]);
        } else {
            c.exit_code = inspect.pointer("/State/ExitCode").and_then(Value::as_i64);
        }
    }
    if state != "running" {
        return Some((id, c, None));
    }
    let raw = match docker_get(&socket, &format!("/containers/{id}/stats?stream=false&one-shot=true")).await {
        Ok(stats) => {
            c.mem_bytes = mem_in_use(&stats);
            c.mem_limit = u64_at(&stats, &["memory_stats", "limit"]);
            c.pids = u64_at(&stats, &["pids_stats", "current"]);
            stats_raw(&stats)
        }
        Err(e) => {
            log::debug!("{}: stats: {e}", c.name);
            None
        }
    };
    Some((id, c, raw))
}

async fn read_containers(cfg: &Config, prev: &HashMap<String, ContainerRaw>, mem_total: Option<u64>) -> Result<(Vec<Container>, HashMap<String, ContainerRaw>), String> {
    let list = docker_get(&cfg.socket, "/containers/json?all=1").await?;
    let mut set = JoinSet::new();
    for summary in list.as_array().cloned().unwrap_or_default() {
        set.spawn(one_container(cfg.socket.clone(), summary));
    }
    let (mut out, mut raws) = (vec![], HashMap::new());
    while let Some(res) = set.join_next().await {
        let Ok(Some((id, mut c, raw))) = res else { continue };
        if let Some(raw) = raw {
            container_rates(&mut c, prev.get(&id), &raw);
            raws.insert(id, raw);
        }
        if c.mem_limit.is_some_and(|l| mem_total.is_some_and(|t| l >= t)) {
            c.mem_limit = None;
        }
        out.push(c);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((out, raws))
}

async fn docker_info(socket: &str) -> Option<DockerInfo> {
    let v = docker_get(socket, "/info").await.ok()?;
    Some(DockerInfo { name: str_at(&v, &["Name"]).map(str::to_owned), root: str_at(&v, &["DockerRootDir"]).map(str::to_owned) })
}

async fn sample_loop(app: App) {
    let mut tick = tokio::time::interval(app.cfg.every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let (mut host_prev, mut cont_prev): (Option<HostRaw>, HashMap<String, ContainerRaw>) = (None, HashMap::new());
    let mut info: Option<DockerInfo> = None;
    let mut last_problems: Vec<String> = vec![];
    let mut collector = crate::timings::Collector::from_env();
    loop {
        tick.tick().await;
        let at = Utc::now();
        if info.is_none() {
            info = docker_info(&app.cfg.socket).await;
        }
        let mut problems = vec![];
        let (host, raw) = read_host(&app.cfg, &info.clone().unwrap_or_default(), host_prev.as_ref(), &mut problems);
        host_prev = Some(raw);
        let containers = match read_containers(&app.cfg, &cont_prev, host.mem_total).await {
            Ok((list, raws)) => {
                cont_prev = raws;
                list
            }
            Err(e) => {
                problems.push(format!("docker: {e}"));
                vec![]
            }
        };
        let timings = collector.collect(&mut problems).await;
        if problems != last_problems {
            for p in problems.iter().filter(|p| !last_problems.contains(p)) {
                log::warn!("{p}");
            }
            last_problems = problems.clone();
        }
        let mut ring = app.ring.lock().await;
        ring.push_back(Sample { at, host, containers, problems, timings });
        while ring.len() > app.cfg.keep {
            ring.pop_front();
        }
    }
}

fn token_ok(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .is_some_and(|g| Sha256::digest(g) == Sha256::digest(token))
}

fn refuse(code: StatusCode, text: &str) -> Response {
    (code, Json(json!({ "error": text }))).into_response()
}

#[derive(Deserialize)]
struct MetricsQuery {
    since: Option<String>,
}

async fn metrics(State(app): State<App>, headers: HeaderMap, Query(q): Query<MetricsQuery>) -> Response {
    let Some(token) = &app.cfg.token else {
        return refuse(StatusCode::NOT_FOUND, "no OPS_TOKEN on this box, so /api/metrics is off");
    };
    if !token_ok(&headers, token) {
        return refuse(StatusCode::UNAUTHORIZED, "token refused");
    }
    let since = match q.since.as_deref().filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(t) => Some(t.with_timezone(&Utc)),
            Err(_) => return refuse(StatusCode::BAD_REQUEST, "since: rfc3339, like 2026-10-24T01:00:00Z"),
        },
    };
    let ring = app.ring.lock().await;
    let samples: Vec<&Sample> = match since {
        Some(t) => ring.iter().filter(|s| s.at > t).collect(),
        None => ring.back().into_iter().collect(),
    };
    Json(json!({
        "agent": {
            "build": app.cfg.build,
            "up_secs": app.started.elapsed().as_secs(),
            "every_secs": app.cfg.every.as_secs(),
            "keep": app.cfg.keep,
        },
        "samples": samples,
    }))
    .into_response()
}

async fn agent_health(State(app): State<App>) -> Json<Value> {
    let ring = app.ring.lock().await;
    Json(json!({ "ok": true, "up_secs": app.started.elapsed().as_secs(), "build": app.cfg.build, "samples": ring.len() }))
}

pub(crate) async fn no_store(mut res: Response) -> Response {
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    res
}

fn env_num<T: std::str::FromStr + PartialOrd + Default>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.trim().parse().ok()).filter(|n| *n > T::default()).unwrap_or(default)
}

fn ops_token() -> Option<String> {
    let token = env::var("OPS_TOKEN").ok().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty())?;
    if token.len() < MIN_TOKEN_CHARS {
        log::warn!("OPS_TOKEN is shorter than {MIN_TOKEN_CHARS} characters, ignoring it. openssl rand -hex 32 makes a good one");
        return None;
    }
    Some(token)
}

fn config() -> Config {
    let proc_dir = env::var("HOST_PROC").ok().filter(|p| !p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| {
        let host = PathBuf::from("/host/proc");
        if host.join("stat").exists() { host } else { PathBuf::from("/proc") }
    });
    Config {
        port: env_num("PORT", 4300),
        every: Duration::from_secs(env_num("SAMPLE_EVERY_SECS", 15)),
        keep: env_num("KEEP_SAMPLES", 240),
        proc_dir,
        socket: env::var("DOCKER_SOCKET").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/var/run/docker.sock".into()),
        disk_path: Some(env::var("DISK_PATH").ok().filter(|p| !p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))),
        iface: env::var("NET_IFACE").ok().map(|i| i.trim().to_owned()).filter(|i| !i.is_empty()),
        token: ops_token(),
        build: env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into()),
    }
}

pub async fn run() -> anyhow::Result<()> {
    let cfg = Arc::new(config());
    log::info!(
        "agent: every {}s, keeping {} samples, host files from {}, docker at {} (GET only)",
        cfg.every.as_secs(),
        cfg.keep,
        cfg.proc_dir.display(),
        cfg.socket
    );
    let sources = crate::timings::Collector::from_env().sources();
    if sources.is_empty() {
        log::info!("agent: no TIMINGS_FROM, so no endpoint timings from this box");
    } else {
        log::info!("agent: endpoint timings from {}", sources.join(", "));
    }
    if cfg.token.is_none() {
        log::warn!("no OPS_TOKEN: GET /api/metrics answers 404 to everyone. set OPS_TOKEN in .env");
    }
    let app = App { cfg: cfg.clone(), ring: Arc::new(Mutex::new(VecDeque::with_capacity(cfg.keep + 1))), started: Instant::now() };
    tokio::spawn(sample_loop(app.clone()));
    let router = Router::new()
        .route("/health", get(agent_health))
        .route("/api/metrics", get(metrics))
        .route_layer(axum::middleware::from_fn_with_state(crate::ratelimit::Local::default(), crate::ratelimit::local))
        .layer(axum::middleware::map_response(no_store))
        .with_state(app);
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    log::info!("agent on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(crate::wait_for_signal()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: &str = "cpu  100 0 50 800 20 0 10 20 0 0\ncpu0 50 0 25 400 10 0 5 10 0 0\ncpu1 50 0 25 400 10 0 5 10 0 0\nintr 1\n";

    #[test]
    fn cpu_and_steal_from_two_stat_reads() {
        let a = parse_cpu(STAT).unwrap();
        assert_eq!(a, CpuTimes { total: 1000, busy: 180, steal: 20, iowait: 20 });
        assert_eq!(count_cpus(STAT), 2);
        let b = parse_cpu("cpu  160 0 70 860 40 0 10 60 5 0\n").unwrap();
        let (busy, steal, iowait) = cpu_shares(a, b).unwrap();
        assert_eq!((busy, steal, iowait), (60.0, 20.0, 10.0));
        assert!(cpu_shares(b, a).is_none());
    }

    #[test]
    fn meminfo_load_uptime_psi() {
        let m = parse_meminfo("MemTotal:        4000 kB\nMemAvailable:    1000 kB\nSwapTotal: 0 kB\n");
        assert_eq!((m["MemTotal"], m["MemAvailable"], m["SwapTotal"]), (4_096_000, 1_024_000, 0));
        assert_eq!(parse_loadavg("0.52 0.41 0.30 1/234 5678\n"), Some((0.52, 0.41, 0.30)));
        assert_eq!(parse_uptime("12345.67 999.0\n"), Some(12345));
        assert_eq!(parse_psi_total("some avg10=0.00 avg60=0.10 avg300=0.00 total=555576\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), Some(555_576));
        assert_eq!(parse_psi_total("garbage"), None);
    }

    #[test]
    fn net_dev_and_default_route() {
        let dev = "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n    lo:  100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  ens4: 326609363 25232 0 0 0 0 0 0 1376665 13074 0 0 0 0 0 0\n";
        assert_eq!(parse_net_dev(dev, "ens4"), Some((326_609_363, 1_376_665)));
        assert_eq!(parse_net_dev(dev, "eth9"), None);
        let route = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\ndocker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\nens5\t00000000\t01001EAC\t0003\t0\t0\t200\t00000000\t0\t0\t0\nens4\t00000000\t01001EAC\t0003\t0\t0\t100\t00000000\t0\t0\t0\n";
        assert_eq!(default_iface(route).as_deref(), Some("ens4"));
    }

    #[test]
    fn http_answers_plain_and_chunked() {
        let plain = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n[1,2]";
        assert_eq!(parse_http(plain).unwrap(), json!([1, 2]));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n";
        assert_eq!(parse_http(chunked).unwrap(), json!({ "a": 1 }));
        let err = parse_http(b"HTTP/1.1 404 Not Found\r\n\r\n{\"message\":\"no such container\"}").unwrap_err();
        assert!(err.starts_with("docker answered 404"), "{err}");
    }

    #[test]
    fn container_numbers_from_two_stats() {
        let s = |read: &str, cpu: u64, rx: u64, wr: u64| {
            json!({
                "read": read,
                "cpu_stats": { "cpu_usage": { "total_usage": cpu } },
                "memory_stats": { "usage": 100_000_000u64, "stats": { "inactive_file": 40_000_000u64 }, "limit": 8_000_000_000u64 },
                "networks": { "eth0": { "rx_bytes": rx, "tx_bytes": 10 }, "eth1": { "rx_bytes": 5, "tx_bytes": 10 } },
                "blkio_stats": { "io_service_bytes_recursive": [{ "op": "read", "value": 7 }, { "op": "Write", "value": wr }] },
                "pids_stats": { "current": 9 }
            })
        };
        let a = s("2026-11-24T08:00:00Z", 1_000_000_000, 1000, 0);
        let b = s("2026-11-24T08:00:10Z", 3_500_000_000, 11_000, 20_000);
        assert_eq!(mem_in_use(&a), Some(60_000_000));
        let (ra, rb) = (stats_raw(&a).unwrap(), stats_raw(&b).unwrap());
        assert_eq!((ra.rx, ra.tx, ra.rd), (Some(1005), Some(20), 7));
        let mut c = Container::default();
        container_rates(&mut c, Some(&ra), &rb);
        assert_eq!(c.cpu_pct, Some(25.0));
        assert_eq!(c.rx_bps, Some(8000.0));
        assert_eq!(c.tx_bps, Some(0.0));
        assert_eq!((c.read_bps, c.write_bps), (Some(0.0), Some(2000.0)));
        let mut restarted = Container::default();
        container_rates(&mut restarted, Some(&rb), &ra);
        assert_eq!((restarted.cpu_pct, restarted.rx_bps), (None, None));
    }

    #[test]
    fn networks_ports_and_depends_on_from_the_list() {
        let summary = json!({
            "Ports": [
                { "IP": "0.0.0.0", "PrivatePort": 443, "PublicPort": 443, "Type": "tcp" },
                { "IP": "::", "PrivatePort": 443, "PublicPort": 443, "Type": "tcp" },
                { "IP": "127.0.0.1", "PrivatePort": 3002, "PublicPort": 3002, "Type": "tcp" },
                { "PrivatePort": 4000, "Type": "tcp" },
                { "IP": "0.0.0.0", "PrivatePort": 7882, "PublicPort": 7882, "Type": "udp" }
            ],
            "NetworkSettings": { "Networks": { "stream_stats": { "IPAddress": "172.18.0.4" }, "stream_default": { "IPAddress": "172.19.0.2" } } }
        });
        let ports = parse_ports(&summary);
        let p = |port: u16, proto: &str, published: Option<u16>, loopback: bool| Port { port, proto: proto.into(), published, loopback };
        assert_eq!(ports, vec![p(443, "tcp", Some(443), false), p(3002, "tcp", Some(3002), true), p(4000, "tcp", None, false), p(7882, "udp", Some(7882), false)]);
        assert_eq!(parse_networks(&summary), vec!["stream_default", "stream_stats"]);
        assert!(!serde_json::to_string(&ports).unwrap().contains("127.0.0.1"));
        assert_eq!(parse_depends_on(Some("redis:service_healthy:false,database:service_healthy:true")), vec!["database", "redis"]);
        assert!(parse_depends_on(None).is_empty());
    }

    #[test]
    fn the_token_is_checked() {
        let mut h = HeaderMap::new();
        assert!(!token_ok(&h, "0123456789abcdef"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer 0123456789abcdef"));
        assert!(token_ok(&h, "0123456789abcdef"));
        assert!(!token_ok(&h, "0123456789abcdeX"));
    }

    #[test]
    fn a_sample_reads_back() {
        let s = Sample { at: DateTime::from_timestamp(1_800_000_000, 0).unwrap(), host: Host { cpu_pct: Some(1.5), ..Default::default() }, containers: vec![], problems: vec![], timings: vec![] };
        let back: Sample = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }
}
