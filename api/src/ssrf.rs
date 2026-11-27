use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use url::{Host, Url};

pub(crate) const MAX_URL_LEN: usize = 2048;
pub(crate) const MAX_REDIRECTS: usize = 3;
pub(crate) const USER_AGENT: &str = "slop-unfurl/1.0 (+https://nodentity.xyz)";
const TOTAL: Duration = Duration::from_secs(5);
const CONNECT: Duration = Duration::from_secs(2);
const PORTS: [u16; 2] = [80, 443];
const BLOCKED_SUFFIXES: [&str; 7] = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".localdomain"];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    TooLong,
    NotAUrl,
    Scheme,
    Port,
    UserInfo,
    Host,
    Private,
    NoAddress,
    Redirects,
    Status(u16),
    Type,
    TooBig,
    Fetch(String),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Guard {
    any_port: bool,
    loopback: bool,
}

impl Guard {
    pub(crate) const STRICT: Guard = Guard { any_port: false, loopback: false };

    #[cfg(test)]
    pub(crate) const fn lab() -> Guard {
        Guard { any_port: true, loopback: true }
    }

    fn allows_ip(self, ip: IpAddr) -> bool {
        is_public(ip) || (self.loopback && ip.is_loopback())
    }
}

pub(crate) fn check_url(raw: &str) -> Result<Url, Refused> {
    check_url_with(Guard::STRICT, raw)
}

pub(crate) fn check_url_with(guard: Guard, raw: &str) -> Result<Url, Refused> {
    if raw.len() > MAX_URL_LEN {
        return Err(Refused::TooLong);
    }
    let url = Url::parse(raw).map_err(|_| Refused::NotAUrl)?;
    check_parsed(guard, url)
}

fn check_parsed(guard: Guard, mut url: Url) -> Result<Url, Refused> {
    if url.as_str().len() > MAX_URL_LEN {
        return Err(Refused::TooLong);
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(Refused::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Refused::UserInfo);
    }
    let port = url.port_or_known_default().ok_or(Refused::Port)?;
    if !guard.any_port && !PORTS.contains(&port) {
        return Err(Refused::Port);
    }
    match url.host() {
        None => return Err(Refused::Host),
        Some(Host::Ipv4(ip)) => {
            if !guard.allows_ip(IpAddr::V4(ip)) {
                return Err(Refused::Private);
            }
        }
        Some(Host::Ipv6(ip)) => {
            if !guard.allows_ip(IpAddr::V6(ip)) {
                return Err(Refused::Private);
            }
        }
        Some(Host::Domain(name)) => {
            if !host_name_ok(name) {
                return Err(Refused::Host);
            }
        }
    }
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn host_name_ok(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || name.len() > 253 || !name.contains('.') {
        return false;
    }
    if name == "localhost" || BLOCKED_SUFFIXES.iter().any(|s| name.ends_with(s)) {
        return false;
    }
    if name.parse::<IpAddr>().is_ok() {
        return false;
    }
    name.split('.').all(|label| !label.is_empty() && label.len() <= 63 && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

pub(crate) fn next_hop(guard: Guard, from: &Url, location: &str) -> Result<Url, Refused> {
    if location.len() > MAX_URL_LEN {
        return Err(Refused::TooLong);
    }
    let next = from.join(location.trim()).map_err(|_| Refused::NotAUrl)?;
    check_parsed(guard, next)
}

pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn in_v4(ip: Ipv4Addr, net: [u8; 4], bits: u32) -> bool {
    let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
    (u32::from(ip) & mask) == (u32::from(Ipv4Addr::from(net)) & mask)
}

pub(crate) fn public_v4(ip: Ipv4Addr) -> bool {
    const BLOCKED: [([u8; 4], u32); 16] = [
        ([0, 0, 0, 0], 8),
        ([10, 0, 0, 0], 8),
        ([100, 64, 0, 0], 10),
        ([127, 0, 0, 0], 8),
        ([169, 254, 0, 0], 16),
        ([172, 16, 0, 0], 12),
        ([192, 0, 0, 0], 24),
        ([192, 0, 2, 0], 24),
        ([192, 31, 196, 0], 24),
        ([192, 52, 193, 0], 24),
        ([192, 88, 99, 0], 24),
        ([192, 168, 0, 0], 16),
        ([198, 18, 0, 0], 15),
        ([198, 51, 100, 0], 24),
        ([203, 0, 113, 0], 24),
        ([224, 0, 0, 0], 3),
    ];
    !BLOCKED.iter().any(|(net, bits)| in_v4(ip, *net, *bits))
}

fn in_v6(ip: Ipv6Addr, net: [u16; 8], bits: u32) -> bool {
    let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
    (u128::from(ip) & mask) == (u128::from(Ipv6Addr::from(net)) & mask)
}

fn v4_at(ip: Ipv6Addr, shift: u32) -> Ipv4Addr {
    Ipv4Addr::from(((u128::from(ip) >> shift) & 0xffff_ffff) as u32)
}

pub(crate) fn public_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    if in_v6(ip, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96) || in_v6(ip, [0, 0, 0, 0, 0, 0, 0, 0], 96) {
        return public_v4(v4_at(ip, 0));
    }
    if in_v6(ip, [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96) {
        return public_v4(v4_at(ip, 0));
    }
    if in_v6(ip, [0x2002, 0, 0, 0, 0, 0, 0, 0], 16) {
        return public_v4(v4_at(ip, 80));
    }
    if !in_v6(ip, [0x2000, 0, 0, 0, 0, 0, 0, 0], 3) {
        return false;
    }
    const BLOCKED: [([u16; 8], u32); 3] = [([0x2001, 0, 0, 0, 0, 0, 0, 0], 23), ([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32), ([0x3fff, 0, 0, 0, 0, 0, 0, 0], 20)];
    !BLOCKED.iter().any(|(net, bits)| in_v6(ip, *net, *bits))
}

pub(crate) fn vet(guard: Guard, addrs: &[SocketAddr]) -> Result<(), Refused> {
    if addrs.is_empty() {
        return Err(Refused::NoAddress);
    }
    if addrs.iter().all(|a| guard.allows_ip(a.ip())) {
        Ok(())
    } else {
        Err(Refused::Private)
    }
}

struct Pinned(Guard);

impl Resolve for Pinned {
    fn resolve(&self, name: Name) -> Resolving {
        let guard = self.0;
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            vet(guard, &found).map_err(|why| format!("{host}: {why:?}"))?;
            let addrs: Addrs = Box::new(found.into_iter());
            Ok(addrs)
        })
    }
}

pub(crate) fn client_for(guard: Guard) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(Pinned(guard)))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(TOTAL)
        .connect_timeout(CONNECT)
        .user_agent(USER_AGENT)
        .build()
}

fn strict_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| match client_for(Guard::STRICT) {
            Ok(client) => Some(client),
            Err(e) => {
                log::warn!("unfurl client: {e}");
                None
            }
        })
        .as_ref()
}

pub(crate) struct Capped {
    buf: Vec<u8>,
    cap: usize,
    over: bool,
}

impl Capped {
    pub(crate) fn new(cap: usize) -> Capped {
        Capped { buf: Vec::new(), cap, over: false }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> bool {
        let room = self.cap - self.buf.len();
        if chunk.len() > room {
            self.buf.extend_from_slice(&chunk[..room]);
            self.over = true;
            return false;
        }
        self.buf.extend_from_slice(chunk);
        self.buf.len() < self.cap
    }

    pub(crate) fn over(&self) -> bool {
        self.over
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Overflow {
    Truncate,
    Refuse,
}

pub(crate) struct Want<'a> {
    pub(crate) types: &'a [&'a str],
    pub(crate) accept: &'static str,
    pub(crate) cap: usize,
    pub(crate) overflow: Overflow,
}

pub(crate) struct Fetched {
    pub(crate) url: Url,
    pub(crate) body: Vec<u8>,
}

pub(crate) fn mime_of(value: Option<&HeaderValue>) -> String {
    value.and_then(|v| v.to_str().ok()).and_then(|v| v.split(';').next()).map(|v| v.trim().to_ascii_lowercase()).unwrap_or_default()
}

pub(crate) async fn fetch(url: Url, want: &Want<'_>) -> Result<Fetched, Refused> {
    let client = strict_client().ok_or_else(|| Refused::Fetch("no client".into()))?;
    fetch_with(client, Guard::STRICT, url, want).await
}

pub(crate) async fn fetch_with(client: &reqwest::Client, guard: Guard, url: Url, want: &Want<'_>) -> Result<Fetched, Refused> {
    match tokio::time::timeout(TOTAL, hops(client, guard, url, want)).await {
        Ok(done) => done,
        Err(_) => Err(Refused::Fetch("timed out".into())),
    }
}

async fn hops(client: &reqwest::Client, guard: Guard, url: Url, want: &Want<'_>) -> Result<Fetched, Refused> {
    let mut url = check_parsed(guard, url)?;
    let mut hop = 0;
    loop {
        let res = client.get(url.clone()).header(reqwest::header::ACCEPT, want.accept).send().await.map_err(|e| Refused::Fetch(e.without_url().to_string()))?;
        let status = res.status();
        if status.is_redirection() {
            hop += 1;
            if hop > MAX_REDIRECTS {
                return Err(Refused::Redirects);
            }
            let location = res.headers().get(LOCATION).and_then(|v| v.to_str().ok()).ok_or(Refused::Status(status.as_u16()))?;
            url = next_hop(guard, &url, location)?;
            continue;
        }
        if !status.is_success() {
            return Err(Refused::Status(status.as_u16()));
        }
        let mime = mime_of(res.headers().get(CONTENT_TYPE));
        if !want.types.contains(&mime.as_str()) {
            return Err(Refused::Type);
        }
        let told: Option<usize> = res.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
        if want.overflow == Overflow::Refuse && told.is_some_and(|n| n > want.cap) {
            return Err(Refused::TooBig);
        }
        let body = read_capped(res, want.cap).await?;
        if body.over() && want.overflow == Overflow::Refuse {
            return Err(Refused::TooBig);
        }
        return Ok(Fetched { url, body: body.into_bytes() });
    }
}

async fn read_capped(mut res: reqwest::Response, cap: usize) -> Result<Capped, Refused> {
    let mut body = Capped::new(cap);
    while let Some(chunk) = res.chunk().await.map_err(|e| Refused::Fetch(e.without_url().to_string()))? {
        if !body.push(&chunk) {
            break;
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn v4(s: &str) -> bool {
        public_v4(s.parse().unwrap())
    }

    fn v6(s: &str) -> bool {
        public_v6(s.parse().unwrap())
    }

    #[test]
    fn private_and_special_v4_are_refused() {
        for ip in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "0.1.2.3",
            "255.255.255.255",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "198.18.0.1",
            "198.19.255.255",
            "192.0.2.10",
            "198.51.100.7",
            "203.0.113.9",
            "192.0.0.8",
            "192.88.99.1",
        ] {
            assert!(!v4(ip), "{ip} should be refused");
        }
    }

    #[test]
    fn public_v4_is_allowed() {
        for ip in ["8.8.8.8", "1.1.1.1", "208.80.154.224", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "11.0.0.1"] {
            assert!(v4(ip), "{ip} should be allowed");
        }
    }

    #[test]
    fn private_and_special_v6_are_refused() {
        for ip in [
            "::1",
            "::",
            "fc00::1",
            "fd12:3456:789a::1",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "ff02::1",
            "ff0e::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:192.168.0.1",
            "::127.0.0.1",
            "::10.1.2.3",
            "64:ff9b::7f00:1",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::1",
            "2002:7f00:1::1",
            "2002:a00:1::",
            "2002:c0a8:101::1",
            "2001:db8::1",
            "2001::1",
            "2001:10::1",
            "100::1",
            "3fff::1",
        ] {
            assert!(!v6(ip), "{ip} should be refused");
        }
    }

    #[test]
    fn public_v6_is_allowed() {
        for ip in ["2606:4700:4700::1111", "2a00:1450:4001:80e::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2620:0:862:ed1a::1"] {
            assert!(v6(ip), "{ip} should be allowed");
        }
    }

    #[test]
    fn only_http_and_https_are_fetched() {
        for raw in ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "javascript:alert(1)", "data:text/html,hi", "ws://example.com/", "mailto:a@example.com"] {
            assert_eq!(check_url(raw).unwrap_err(), Refused::Scheme, "{raw}");
        }
        assert!(check_url("https://en.wikipedia.org/wiki/Anime").is_ok());
        assert!(check_url("http://example.com/").is_ok());
    }

    #[test]
    fn only_ports_80_and_443() {
        assert!(check_url("https://example.com:443/").is_ok());
        assert!(check_url("http://example.com:80/").is_ok());
        assert!(check_url("http://example.com:443/").is_ok());
        for raw in ["http://example.com:8080/", "https://example.com:22/", "http://example.com:6379/", "https://example.com:0/", "http://example.com:5432/"] {
            assert_eq!(check_url(raw).unwrap_err(), Refused::Port, "{raw}");
        }
    }

    #[test]
    fn userinfo_and_long_urls_are_refused() {
        assert_eq!(check_url("https://user:pw@example.com/").unwrap_err(), Refused::UserInfo);
        assert_eq!(check_url("https://user@example.com/").unwrap_err(), Refused::UserInfo);
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(check_url(&long).unwrap_err(), Refused::TooLong);
        assert_eq!(check_url("not a url").unwrap_err(), Refused::NotAUrl);
    }

    #[test]
    fn local_names_and_odd_ip_literals_are_refused() {
        for raw in ["http://localhost/", "http://LOCALHOST./", "http://foo.localhost/", "http://printer.local/", "http://redis/", "http://database/", "http://metadata.google.internal/", "http://router.home.arpa/"] {
            assert_eq!(check_url(raw).unwrap_err(), Refused::Host, "{raw}");
        }
        for raw in [
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://127.1/",
            "http://0/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:a9fe:a9fe]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://100.64.1.1/",
        ] {
            assert_eq!(check_url(raw).unwrap_err(), Refused::Private, "{raw}");
        }
        assert!(check_url("http://93.184.215.14/").is_ok());
    }

    #[test]
    fn a_redirect_hop_is_checked_like_the_first_url() {
        let from = check_url("https://example.com/a/b").unwrap();
        assert_eq!(next_hop(Guard::STRICT, &from, "/c").unwrap().as_str(), "https://example.com/c");
        assert_eq!(next_hop(Guard::STRICT, &from, "https://other.example.org/x#frag").unwrap().as_str(), "https://other.example.org/x");
        assert_eq!(next_hop(Guard::STRICT, &from, "http://10.0.0.5/").unwrap_err(), Refused::Private);
        assert_eq!(next_hop(Guard::STRICT, &from, "http://169.254.169.254/latest/meta-data/").unwrap_err(), Refused::Private);
        assert_eq!(next_hop(Guard::STRICT, &from, "http://[::1]/").unwrap_err(), Refused::Private);
        assert_eq!(next_hop(Guard::STRICT, &from, "http://localhost/").unwrap_err(), Refused::Host);
        assert_eq!(next_hop(Guard::STRICT, &from, "file:///etc/passwd").unwrap_err(), Refused::Scheme);
        assert_eq!(next_hop(Guard::STRICT, &from, "http://example.com:8080/").unwrap_err(), Refused::Port);
        assert_eq!(next_hop(Guard::STRICT, &from, "//user:pw@example.com/").unwrap_err(), Refused::UserInfo);
    }

    #[test]
    fn any_private_address_in_an_answer_refuses_the_lot() {
        let public: SocketAddr = "93.184.215.14:443".parse().unwrap();
        let private: SocketAddr = "10.0.0.1:443".parse().unwrap();
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:443".parse().unwrap();
        assert_eq!(vet(Guard::STRICT, &[public]), Ok(()));
        assert_eq!(vet(Guard::STRICT, &[public, private]), Err(Refused::Private));
        assert_eq!(vet(Guard::STRICT, &[mapped]), Err(Refused::Private));
        assert_eq!(vet(Guard::STRICT, &[]), Err(Refused::NoAddress));
    }

    #[tokio::test]
    async fn the_resolver_refuses_names_that_land_on_loopback() {
        let name: Name = "localhost".parse().unwrap();
        let answer = Pinned(Guard::STRICT).resolve(name).await;
        assert!(answer.is_err());
    }

    #[test]
    fn the_body_cap_stops_reading() {
        let mut body = Capped::new(10);
        assert!(body.push(b"hello"));
        assert!(!body.push(b"world and more"));
        assert!(body.over());
        assert_eq!(body.into_bytes(), b"helloworld");
        let mut exact = Capped::new(4);
        assert!(!exact.push(b"abcd"));
        assert!(!exact.over());
    }

    async fn serve(answers: Vec<Vec<u8>>) -> (u16, tokio::task::JoinHandle<usize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let mut served = 0;
            for answer in answers {
                let Ok(Ok((mut sock, _))) = tokio::time::timeout(Duration::from_secs(3), listener.accept()).await else { break };
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(&answer).await;
                let _ = sock.shutdown().await;
                served += 1;
            }
            served
        });
        (port, task)
    }

    fn html_want(cap: usize) -> Want<'static> {
        Want { types: &["text/html"], accept: "text/html", cap, overflow: Overflow::Truncate }
    }

    #[tokio::test]
    async fn loopback_is_refused_before_any_connection() {
        let (port, task) = serve(vec![b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 2\r\n\r\nhi".to_vec()]).await;
        let client = client_for(Guard::STRICT).unwrap();
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let strict_any_port = Guard { any_port: true, loopback: false };
        assert_eq!(fetch_with(&client, strict_any_port, url, &html_want(1024)).await.err(), Some(Refused::Private));
        let named = Url::parse(&format!("http://localhost:{port}/")).unwrap();
        assert_eq!(fetch_with(&client, strict_any_port, named, &html_want(1024)).await.err(), Some(Refused::Host));
        task.abort();
        assert!(task.await.is_err(), "the listener never served anything");
    }

    #[tokio::test]
    async fn a_redirect_to_a_private_address_is_not_followed() {
        let (port, task) = serve(vec![b"HTTP/1.1 302 Found\r\nlocation: http://10.0.0.1/\r\ncontent-length: 0\r\n\r\n".to_vec()]).await;
        let client = client_for(Guard::lab()).unwrap();
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(fetch_with(&client, Guard::lab(), url, &html_want(1024)).await.err(), Some(Refused::Private));
        assert_eq!(task.await.unwrap(), 1);
    }

    #[tokio::test]
    async fn redirects_stop_after_three_hops() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hop = format!("HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:{port}/again\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").into_bytes();
        let task = tokio::spawn(async move {
            let mut served = 0;
            while let Ok(Ok((mut sock, _))) = tokio::time::timeout(Duration::from_secs(2), listener.accept()).await {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(&hop).await;
                let _ = sock.shutdown().await;
                served += 1;
            }
            served
        });
        let client = client_for(Guard::lab()).unwrap();
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(fetch_with(&client, Guard::lab(), url, &html_want(1024)).await.err(), Some(Refused::Redirects));
        assert_eq!(task.await.unwrap(), MAX_REDIRECTS + 1);
    }

    #[tokio::test]
    async fn a_big_body_is_cut_at_the_cap_or_refused() {
        let big = vec![b'x'; 300_000];
        let mut answer = b"HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\n\r\n".to_vec();
        answer.extend_from_slice(&big);
        let (port, task) = serve(vec![answer.clone(), answer]).await;
        let client = client_for(Guard::lab()).unwrap();
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let got = fetch_with(&client, Guard::lab(), url.clone(), &html_want(4096)).await.unwrap();
        assert_eq!(got.body.len(), 4096);
        let refuse = Want { types: &["text/html"], accept: "text/html", cap: 4096, overflow: Overflow::Refuse };
        assert_eq!(fetch_with(&client, Guard::lab(), url, &refuse).await.err(), Some(Refused::TooBig));
        task.abort();
    }

    #[tokio::test]
    async fn the_wrong_content_type_is_not_read() {
        let (port, task) = serve(vec![b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}".to_vec()]).await;
        let client = client_for(Guard::lab()).unwrap();
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(fetch_with(&client, Guard::lab(), url, &html_want(1024)).await.err(), Some(Refused::Type));
        task.abort();
    }
}
