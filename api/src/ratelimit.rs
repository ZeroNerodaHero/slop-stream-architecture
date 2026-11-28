use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, MatchedPath, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::timings::Redis;
use serde_json::json;

use crate::{auth, test_streamers, AppState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Key {
    Who,
    Ip,
    NameIp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rule {
    pub(crate) tier: &'static str,
    pub(crate) max: i64,
    pub(crate) window_secs: i64,
    pub(crate) key: Key,
}

const fn rule(tier: &'static str, max: i64, window_secs: i64, key: Key) -> Rule {
    Rule { tier, max, window_secs, key }
}

pub(crate) const HEALTH: Rule = rule("health", 60, 60, Key::Ip);
pub(crate) const PAGE: Rule = rule("page", 120, 60, Key::Ip);
pub(crate) const READ: Rule = rule("read", 600, 60, Key::Who);
pub(crate) const SEARCH: Rule = rule("search", 60, 60, Key::Who);
pub(crate) const WRITE: Rule = rule("write", 120, 60, Key::Who);
pub(crate) const AUTH: Rule = rule("auth", 30, 60, Key::Ip);
pub(crate) const OAUTH: Rule = rule("oauth", 30, 60, Key::Ip);
pub(crate) const MODERATE: Rule = rule("moderate", 120, 600, Key::Who);
pub(crate) const UPLOAD: Rule = rule("upload", 60, 3600, Key::Who);
pub(crate) const VIDEO_UPLOAD: Rule = rule("video-upload", 12, 3600, Key::Who);
pub(crate) const GO_LIVE: Rule = rule("go-live", 10, 600, Key::Who);
pub(crate) const STREAM: Rule = rule("stream", 120, 60, Key::NameIp);
pub(crate) const REPORT: Rule = rule("report", 120, 60, Key::Ip);
pub(crate) const NEW_NAMES: Rule = rule("new-names", 20, 3600, Key::Who);

pub(crate) const CHAT_SOCKET: Rule = rule("chat-socket", 60, 60, Key::Ip);
pub(crate) const HISTORY: Rule = rule("history", 300, 60, Key::Ip);
pub(crate) const EVENTS_SOCKET: Rule = rule("events-socket", 60, 60, Key::Ip);
pub(crate) const RT_SOCKET: Rule = rule("rt-socket", 60, 60, Key::Ip);
pub(crate) const RT_TICKET: Rule = rule("rt-ticket", 30, 60, Key::Ip);
pub(crate) const HOME: Rule = rule("home", 300, 60, Key::Ip);
pub(crate) const PING: Rule = rule("ping", 600, 60, Key::Ip);
pub(crate) const HOOK: Rule = rule("hook", 6000, 60, Key::Ip);

pub(crate) fn api_rule(method: &Method, path: &str) -> Rule {
    let read = method == Method::GET || method == Method::HEAD;
    match path {
        "/api/health" => HEALTH,
        "/watch/" | "/watch/{*rest}" => PAGE,
        "/api/streams/{name}/go-live" => GO_LIVE,
        "/api/streams/{name}/attached" | "/api/streams/{name}/viewers" | "/api/streams/{name}/heartbeat" | "/api/streams/{name}/stop" => STREAM,
        "/api/signup" | "/api/login" | "/api/logout" | "/api/logout-all" | "/api/password" | "/api/name" if !read => AUTH,
        "/api/errors" if !read => REPORT,
        "/api/hooks/kick" => HOOK,
        "/api/oauth/{provider}/start" | "/api/oauth/{provider}/callback" | "/api/oauth/{provider}/unlink" => OAUTH,
        "/api/auth/{platform}/start" | "/api/auth/{platform}/callback" => OAUTH,
        "/api/oauth/signup" if !read => OAUTH,
        p if read && p != "/api/search" && p.ends_with("/search") => SEARCH,
        _ if read => READ,
        "/api/chat-videos" => VIDEO_UPLOAD,
        p if is_upload(method, p) => UPLOAD,
        p if is_moderation(method, p) => MODERATE,
        _ => WRITE,
    }
}

fn is_upload(method: &Method, path: &str) -> bool {
    let put_file = method == Method::PUT
        && matches!(
            path,
            "/api/streamers/{name}/avatar"
                | "/api/streamers/{name}/thumbs"
                | "/api/streamers/{name}/offline"
                | "/api/streamers/{name}/assets"
                | "/api/streamers/{name}/about-page"
                | "/api/streamers/{name}/about-file"
                | "/api/groups/{group}/icon"
                | "/api/groups/{group}/banner"
        );
    let post_file = method == Method::POST && matches!(path, "/api/chat-images" | "/api/chat-audio" | "/api/groups/{group}/emotes");
    put_file || post_file
}

fn is_moderation(method: &Method, path: &str) -> bool {
    if method == Method::DELETE && matches!(path, "/api/chat-images/{id}" | "/api/chat-videos/{id}" | "/api/chat-audio/{id}") {
        return true;
    }
    if path.starts_with("/api/jannies") {
        return true;
    }
    if let Some(rest) = path.strip_prefix("/api/streams/{name}/") {
        return rest.starts_with("chat/") || rest.starts_with("bans") || rest.starts_with("timeouts") || rest.starts_with("jannies");
    }
    let Some(rest) = path.strip_prefix("/api/groups/{group}") else { return false };
    match rest {
        "" => method == Method::DELETE,
        "/join" | "/leave" => false,
        r if r.ends_with("/read") || r.ends_with("/mute") => false,
        r if r.starts_with("/voice/") => false,
        _ => true,
    }
}

fn may_make_name(method: &Method, path: &str) -> bool {
    if method == Method::GET || method == Method::HEAD {
        return false;
    }
    match path {
        "/api/streams/{name}/go-live" => true,
        "/api/streamers/{name}/follow" | "/api/streamers/{name}/unfollow" => false,
        p => p == "/api/streamers/{name}" || p.starts_with("/api/streamers/{name}/"),
    }
}

pub(crate) fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        let on = !std::env::var("RATE_LIMITS").is_ok_and(|v| v.trim().eq_ignore_ascii_case("off"));
        if !on {
            log::warn!("RATE_LIMITS=off: the per-route limits are off");
        }
        on
    })
}

pub(crate) fn forwarded_ip(headers: &HeaderMap) -> Option<String> {
    headers.get("x-forwarded-for")?.to_str().ok()?.split(',').next().map(|ip| ip.trim().to_owned()).filter(|ip| !ip.is_empty())
}

fn path_name(path: &str) -> String {
    path.split('/').nth(3).unwrap_or("").trim().to_lowercase()
}

fn query_password(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|kv| kv.strip_prefix("password=")).map(|p| p.replace('+', " ")).map(|p| percent_decode(&p))
}

fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) async fn hit(redis: &Redis, key: &str, window_secs: i64) -> redis::RedisResult<(i64, i64)> {
    let (n, ttl): (i64, i64) = redis::pipe()
        .atomic()
        .incr(key, 1)
        .cmd("EXPIRE").arg(key).arg(window_secs).arg("NX").ignore()
        .cmd("TTL").arg(key)
        .query_async(&mut redis.clone())
        .await?;
    Ok((n, ttl))
}

async fn note_name(redis: &Redis, key: &str, name: &str, max: i64, window_secs: i64) -> redis::RedisResult<Result<(), i64>> {
    let (added, count, ttl): (i64, i64, i64) = redis::pipe()
        .atomic()
        .sadd(key, name)
        .cmd("EXPIRE").arg(key).arg(window_secs).arg("NX").ignore()
        .scard(key)
        .cmd("TTL").arg(key)
        .query_async(&mut redis.clone())
        .await?;
    if added == 1 && count > max {
        let _: i64 = redis::cmd("SREM").arg(key).arg(name).query_async(&mut redis.clone()).await?;
        return Ok(Err(ttl));
    }
    Ok(Ok(()))
}

pub(crate) fn too_many(retry_after: i64, message: &str) -> Response {
    let secs = retry_after.max(1);
    let mut res = (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": message, "retry_after": secs }))).into_response();
    res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(secs));
    res
}

fn slow_down(rule: Rule, ttl: i64) -> Response {
    let ttl = if ttl > 0 { ttl } else { rule.window_secs };
    too_many(ttl, &format!("too many requests. try again in {ttl}s"))
}

async fn check(redis: &Redis, rule: Rule, subject: &str) -> Option<Response> {
    let key = format!("rl:route:{}:{subject}", rule.tier);
    match hit(redis, &key, rule.window_secs).await {
        Ok((n, ttl)) if n > rule.max => Some(slow_down(rule, ttl)),
        Ok(_) => None,
        Err(e) => {
            log::warn!("rate limit {}: redis: {e}. letting it through", rule.tier);
            None
        }
    }
}

pub(crate) async fn api(State(s): State<AppState>, mut req: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(req).await;
    }
    let Some(ip) = forwarded_ip(req.headers()) else { return next.run(req).await };
    let Some(path) = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned()) else { return next.run(req).await };
    let method = req.method().clone();
    let rule = api_rule(&method, &path);

    let given = test_streamers::given_secret(req.headers(), query_password(req.uri().query()));
    if test_streamers::skips_limits(&s.dummy_prefix, s.dummy_password.as_deref(), &path, &path_name(req.uri().path()), given.as_deref()) {
        return next.run(req).await;
    }

    let mut account = None;
    if (matches!(rule.key, Key::Who) || may_make_name(&method, &path)) && auth::cookie_token(req.headers()).is_some() {
        match auth::whoami(&s.db, req.headers()).await {
            Ok(me) => {
                account = me.as_ref().map(|a| a.id);
                req.extensions_mut().insert(auth::Seen(me));
            }
            Err(e) => log::warn!("rate limit: whoami: {e}. counting by address"),
        }
    }
    let who = match account {
        Some(id) => format!("acct:{id}"),
        None => format!("ip:{ip}"),
    };
    let subject = match rule.key {
        Key::Who => who.clone(),
        Key::Ip => format!("ip:{ip}"),
        Key::NameIp => format!("name:{}:ip:{ip}", path_name(req.uri().path())),
    };
    if let Some(over) = check(&s.redis, rule, &subject).await {
        return over;
    }

    if may_make_name(&method, &path) {
        let name = path_name(req.uri().path());
        let key = format!("rl:route:{}:{who}", NEW_NAMES.tier);
        match note_name(&s.redis, &key, &name, NEW_NAMES.max, NEW_NAMES.window_secs).await {
            Ok(Ok(())) => {}
            Ok(Err(ttl)) => {
                let ttl = if ttl > 0 { ttl } else { NEW_NAMES.window_secs };
                return too_many(ttl, &format!("too many new names from here. try again in {}m", (ttl + 59) / 60));
            }
            Err(e) => log::warn!("rate limit new names: redis: {e}. letting it through"),
        }
    }
    next.run(req).await
}

#[derive(Clone)]
pub(crate) struct ByIp {
    pub(crate) redis: Redis,
    pub(crate) rule: fn(&Method, &str) -> Rule,
}

pub(crate) async fn by_ip(State(l): State<ByIp>, req: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(req).await;
    }
    let Some(ip) = forwarded_ip(req.headers()) else { return next.run(req).await };
    let Some(path) = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned()) else { return next.run(req).await };
    let rule = (l.rule)(req.method(), &path);
    if let Some(over) = check(&l.redis, rule, &format!("ip:{ip}")).await {
        return over;
    }
    next.run(req).await
}

pub(crate) fn chat_rule(_: &Method, path: &str) -> Rule {
    match path {
        "/health" => PING,
        "/chat/{name}" | "/chat/{server}/{channel}" => CHAT_SOCKET,
        "/rt" => RT_SOCKET,
        "/rt/ticket" => RT_TICKET,
        p if p.ends_with("/search") => Rule { key: Key::Ip, ..SEARCH },
        _ => HISTORY,
    }
}

pub(crate) fn events_rule(_: &Method, path: &str) -> Rule {
    match path {
        "/events" => EVENTS_SOCKET,
        _ => PING,
    }
}

pub(crate) fn home_rule(_: &Method, path: &str) -> Rule {
    match path {
        "/api/streams" => HOME,
        _ => PING,
    }
}

#[derive(Clone, Default)]
pub(crate) struct Local(Arc<Mutex<HashMap<String, (Instant, i64)>>>);

impl Local {
    pub(crate) fn hit(&self, key: &str, max: i64, window: Duration, now: Instant) -> Result<(), i64> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 10_000 {
            m.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = m.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        if entry.1 > max {
            let left = window.saturating_sub(now.duration_since(entry.0));
            return Err(left.as_secs().max(1) as i64);
        }
        Ok(())
    }
}

pub(crate) const MONITOR: Rule = rule("monitor", 120, 60, Key::Ip);

pub(crate) async fn local(State(l): State<Local>, req: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(req).await;
    }
    let ip = forwarded_ip(req.headers())
        .or_else(|| req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().to_string()))
        .unwrap_or_else(|| "?".into());
    if let Err(left) = l.hit(&ip, MONITOR.max, Duration::from_secs(MONITOR.window_secs as u64), Instant::now()) {
        return too_many(left, &format!("too many requests. try again in {left}s"));
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_api_route_has_a_sensible_tier() {
        let get = Method::GET;
        let put = Method::PUT;
        let post = Method::POST;
        let del = Method::DELETE;
        assert_eq!(api_rule(&get, "/api/health"), HEALTH);
        assert_eq!(api_rule(&get, "/watch/{*rest}"), PAGE);
        assert_eq!(api_rule(&post, "/api/streams/{name}/go-live"), GO_LIVE);
        assert_eq!(api_rule(&post, "/api/streams/{name}/heartbeat"), STREAM);
        assert_eq!(api_rule(&post, "/api/streams/{name}/watching"), WRITE);
        assert_eq!(api_rule(&get, "/api/stats"), READ);
        assert_eq!(api_rule(&get, "/api/stats/streams/{id}"), READ);
        assert_eq!(api_rule(&post, "/api/login"), AUTH);
        assert_eq!(api_rule(&get, "/api/me"), READ);
        assert_eq!(api_rule(&get, "/api/oauth/{provider}/start"), OAUTH);
        assert_eq!(api_rule(&get, "/api/oauth/{provider}/callback"), OAUTH);
        assert_eq!(api_rule(&get, "/api/auth/{platform}/callback"), OAUTH);
        assert_eq!(api_rule(&post, "/api/oauth/{provider}/unlink"), OAUTH);
        assert_eq!(api_rule(&post, "/api/oauth/signup"), OAUTH);
        assert_eq!(api_rule(&get, "/api/oauth/signup"), READ);
        assert_eq!(api_rule(&get, "/api/oauth/providers"), READ);
        assert_eq!(api_rule(&get, "/api/oauth/identities"), READ);
        assert_eq!(api_rule(&post, "/api/errors"), REPORT);
        assert_eq!(api_rule(&get, "/api/errors"), READ);
        assert_eq!(api_rule(&get, "/api/dm/{name}/search"), SEARCH);
        assert_eq!(api_rule(&get, "/api/search"), READ);
        assert_eq!(api_rule(&put, "/api/streamers/{name}/avatar"), UPLOAD);
        assert_eq!(api_rule(&del, "/api/streamers/{name}/avatar"), WRITE);
        assert_eq!(api_rule(&put, "/api/streamers/{name}/about-file"), UPLOAD);
        assert_eq!(api_rule(&put, "/api/groups/{group}/icon"), UPLOAD);
        assert_eq!(api_rule(&post, "/api/chat-images"), UPLOAD);
        assert_eq!(api_rule(&post, "/api/chat-videos"), VIDEO_UPLOAD);
        assert_eq!(api_rule(&get, "/api/chat-videos/{id}"), READ);
        assert_eq!(api_rule(&get, "/api/chat-images/{id}"), READ);
        assert_eq!(api_rule(&del, "/api/chat-videos/{id}"), MODERATE);
        assert_eq!(api_rule(&del, "/api/chat-images/{id}"), MODERATE);
        assert_eq!(api_rule(&post, "/api/chat-audio"), UPLOAD);
        assert_eq!(api_rule(&get, "/api/chat-audio/{id}"), READ);
        assert_eq!(api_rule(&del, "/api/chat-audio/{id}"), MODERATE);
        assert!(VIDEO_UPLOAD.max < UPLOAD.max && VIDEO_UPLOAD.window_secs >= UPLOAD.window_secs, "videos are counted tighter than pictures");
        assert_eq!(api_rule(&post, "/api/groups/{group}/emotes"), UPLOAD);
        assert_eq!(api_rule(&Method::PATCH, "/api/groups/{group}/emotes/{id}"), MODERATE);
        assert_eq!(api_rule(&del, "/api/groups/{group}/emotes/{id}"), MODERATE);
        assert_eq!(api_rule(&get, "/api/groups/{group}/emotes"), READ);
        assert_eq!(api_rule(&get, "/api/emotes/mine"), READ);
        assert_eq!(api_rule(&get, "/api/emotes/{id}"), READ);
        assert_eq!(api_rule(&post, "/api/groups/{group}/ban"), MODERATE);
        assert_eq!(api_rule(&del, "/api/groups/{group}/channels/{channel}/messages/{id}"), MODERATE);
        assert_eq!(api_rule(&post, "/api/groups/{group}/voice-mute"), MODERATE);
        assert_eq!(api_rule(&post, "/api/groups/{group}/voice-disconnect"), MODERATE);
        assert_eq!(api_rule(&Method::GET, "/api/groups/{group}/members/{name}/messages"), READ);
        assert_eq!(api_rule(&del, "/api/streams/{name}/chat/{id}"), MODERATE);
        assert_eq!(api_rule(&post, "/api/streams/{name}/bans"), MODERATE);
        assert_eq!(api_rule(&del, "/api/streams/{name}/timeouts/{user}"), MODERATE);
        assert_eq!(api_rule(&post, "/api/streams/{name}/jannies"), MODERATE);
        assert_eq!(api_rule(&post, "/api/jannies"), MODERATE);
        assert_eq!(api_rule(&get, "/api/streams/{name}/mod-log"), READ);
        assert_eq!(api_rule(&post, "/api/streams/{name}/heartbeat"), STREAM);
        assert_eq!(api_rule(&del, "/api/groups/{group}/roles/{id}/members/{name}"), MODERATE);
        assert_eq!(api_rule(&put, "/api/groups/{group}/channels/{channel}/cooldown"), MODERATE);
        assert_eq!(api_rule(&del, "/api/groups/{group}"), MODERATE);
        assert_eq!(api_rule(&post, "/api/groups/{group}/channels/{channel}/pins/{message}"), MODERATE);
        assert_eq!(api_rule(&del, "/api/groups/{group}/channels/{channel}/pins/{message}"), MODERATE);
        assert_eq!(api_rule(&get, "/api/groups/{group}/channels/{channel}/pins"), READ);
        assert_eq!(api_rule(&post, "/api/groups/{group}/join"), WRITE);
        assert_eq!(api_rule(&put, "/api/groups/{group}/channels/{channel}/read"), WRITE);
        assert_eq!(api_rule(&put, "/api/groups/{group}/channels/{channel}/mute"), WRITE);
        assert_eq!(api_rule(&post, "/api/dm/{name}"), WRITE);
        assert_eq!(api_rule(&put, "/api/streamers/{name}"), WRITE);
        assert_eq!(api_rule(&post, "/api/groups/{group}/voice/{channel}/join"), WRITE);
        assert_eq!(api_rule(&post, "/api/voice/redeem"), WRITE);
    }

    #[test]
    fn names_a_write_can_make() {
        assert!(may_make_name(&Method::PUT, "/api/streamers/{name}"));
        assert!(may_make_name(&Method::PUT, "/api/streamers/{name}/presence"));
        assert!(may_make_name(&Method::PUT, "/api/streamers/{name}/avatar"));
        assert!(may_make_name(&Method::POST, "/api/streams/{name}/go-live"));
        assert!(!may_make_name(&Method::POST, "/api/streamers/{name}/follow"));
        assert!(!may_make_name(&Method::GET, "/api/streamers/{name}"));
        assert!(!may_make_name(&Method::POST, "/api/streams/{name}/heartbeat"));
        assert!(!may_make_name(&Method::POST, "/api/dm/{name}"));
    }

    #[test]
    fn the_other_processes() {
        assert_eq!(chat_rule(&Method::GET, "/chat/{name}"), CHAT_SOCKET);
        assert_eq!(chat_rule(&Method::GET, "/chat/{name}/before").tier, "history");
        assert_eq!(chat_rule(&Method::GET, "/chat/{server}/{channel}/search").key, Key::Ip);
        assert_eq!(events_rule(&Method::GET, "/events"), EVENTS_SOCKET);
        assert_eq!(chat_rule(&Method::GET, "/rt"), RT_SOCKET);
        assert_eq!(chat_rule(&Method::POST, "/rt/ticket"), RT_TICKET);
        assert_eq!(home_rule(&Method::GET, "/api/streams"), HOME);
        assert_eq!(home_rule(&Method::GET, "/health"), PING);
    }

    #[test]
    fn the_path_name_and_the_password() {
        assert_eq!(path_name("/api/streams/Billy/heartbeat"), "billy");
        assert_eq!(path_name("/api/streamers/a_b"), "a_b");
        assert_eq!(query_password(Some("session=1&password=s%40cret+x")).as_deref(), Some("s@cret x"));
        assert_eq!(query_password(Some("session=1&token=2")), None);
        assert_eq!(query_password(None), None);
    }

    #[test]
    fn the_secret_skips_the_limits_only_on_a_dummy_names_own_routes() {
        let skip = |matched: &str, path: &str, given: Option<&str>| {
            test_streamers::skips_limits("dummy-", Some("s3cret"), matched, &path_name(path), given)
        };
        assert!(skip("/api/streams/{name}/go-live", "/api/streams/dummy-mango/go-live", Some("s3cret")));
        assert!(skip("/api/streamers/{name}", "/api/streamers/Dummy-Mango", Some("s3cret")));
        assert!(skip("/api/streamers/{name}/avatar", "/api/streamers/dummy-mango/avatar", Some("s3cret")));
        assert!(!skip("/api/streams/{name}/go-live", "/api/streams/billy/go-live", Some("s3cret")));
        assert!(!skip("/api/streamers/{name}/avatar", "/api/streamers/billy/avatar", Some("s3cret")));
        assert!(!skip("/api/streams/{name}/go-live", "/api/streams/dummy-mango/go-live", Some("nope")));
        assert!(!skip("/api/streams/{name}/go-live", "/api/streams/dummy-mango/go-live", None));
        assert!(!skip("/api/login", "/api/login", Some("s3cret")));
        assert!(!skip("/api/groups/{group}/join", "/api/groups/dummy-mango/join", Some("s3cret")));
        assert!(!skip("/api/dm/{name}", "/api/dm/dummy-mango", Some("s3cret")));
        let mut h = HeaderMap::new();
        h.insert("x-dummy-password", HeaderValue::from_static("s3cret"));
        let given = test_streamers::given_secret(&h, query_password(Some("session=1")));
        assert!(skip("/api/streams/{name}/go-live", "/api/streams/dummy-mango/go-live", given.as_deref()));
        let given = test_streamers::given_secret(&HeaderMap::new(), query_password(Some("password=s3cret")));
        assert!(skip("/api/streams/{name}/go-live", "/api/streams/dummy-mango/go-live", given.as_deref()));
    }

    #[test]
    fn only_caddy_traffic_is_counted() {
        let mut h = HeaderMap::new();
        assert_eq!(forwarded_ip(&h), None);
        h.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9, 10.0.0.2"));
        assert_eq!(forwarded_ip(&h).as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn local_window_refuses_past_the_count_then_resets() {
        let l = Local::default();
        let now = Instant::now();
        let w = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(l.hit("ip", 3, w, now).is_ok());
        }
        let left = l.hit("ip", 3, w, now + Duration::from_secs(20)).unwrap_err();
        assert_eq!(left, 40);
        assert!(l.hit("other", 3, w, now).is_ok());
        assert!(l.hit("ip", 3, w, now + w).is_ok());
    }

    fn tiny(_: &Method, _: &str) -> Rule {
        rule("test-tiny", 3, 60, Key::Ip)
    }

    #[tokio::test]
    #[ignore]
    async fn a_route_answers_429_with_retry_after_past_its_count() {
        let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/15".into());
        let redis = crate::connect_redis(&url).await;
        let ip = format!("198.51.100.{}", std::process::id() % 250);
        let _: () = redis::cmd("DEL").arg(format!("rl:route:test-tiny:ip:{ip}")).query_async(&mut redis.clone()).await.unwrap();
        let app = axum::Router::new()
            .route("/x", axum::routing::get(|| async { "ok" }))
            .route_layer(axum::middleware::from_fn_with_state(ByIp { redis, rule: tiny }, by_ip));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::new();
        let url = format!("http://{addr}/x");
        for _ in 0..3 {
            let res = http.get(&url).header("x-forwarded-for", &ip).send().await.unwrap();
            assert_eq!(res.status(), 200);
        }
        let res = http.get(&url).header("x-forwarded-for", &ip).send().await.unwrap();
        assert_eq!(res.status(), 429);
        let wait: i64 = res.headers()["retry-after"].to_str().unwrap().parse().unwrap();
        assert!((1..=60).contains(&wait), "{wait}");
        assert_eq!(http.get(&url).header("x-forwarded-for", "192.0.2.1").send().await.unwrap().status(), 200);
        for _ in 0..5 {
            assert_eq!(http.get(&url).send().await.unwrap().status(), 200);
        }
    }

    #[test]
    fn too_many_says_when() {
        let res = too_many(42, "slow");
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers()[header::RETRY_AFTER], "42");
        assert_eq!(too_many(0, "x").headers()[header::RETRY_AFTER], "1");
    }
}
