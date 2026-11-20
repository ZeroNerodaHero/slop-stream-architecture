//! Requests per address per minute, in memory (this process has no redis). Only what came
//! through caddy is counted: it sets X-Forwarded-For; the api and home asking `/live` and
//! `/viewers` from inside the compose network do not. 429 with `Retry-After` past the count.
//! The peer caps (`MAX_WATCHERS_PER_IP*`, `MAX_PREVIEWS_PER_IP`) still bound what an open
//! socket may hold; this bounds how fast sockets and thumbnails are asked for.
//! `RATE_LIMITS=off` turns it off, like the api's.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{MatchedPath, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

const WINDOW: Duration = Duration::from_secs(60);

/// The count a minute for a route, by the path as written in the router.
pub(crate) fn per_minute(path: &str) -> u32 {
    match path {
        // one per watch page, publish page and reconnect
        "/ws" => 60,
        // every home card asks every 5s: 50 live streams on screen is 600 a minute
        "/thumb/{file}" => 3000,
        _ => 600,
    }
}

/// (address, route) to (window start, count)
type Counts = HashMap<(String, &'static str), (Instant, u32)>;

#[derive(Clone, Default)]
pub(crate) struct Limits(Arc<Mutex<Counts>>);

impl Limits {
    /// One more for `ip` on `route`: Err(seconds left) past `max` this window.
    pub(crate) fn hit(&self, ip: &str, route: &'static str, max: u32, now: Instant) -> Result<(), u64> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 10_000 {
            m.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        }
        let e = m.entry((ip.to_owned(), route)).or_insert((now, 0));
        if now.duration_since(e.0) >= WINDOW {
            *e = (now, 0);
        }
        e.1 += 1;
        if e.1 > max {
            return Err(WINDOW.saturating_sub(now.duration_since(e.0)).as_secs().max(1));
        }
        Ok(())
    }
}

fn forwarded_ip(headers: &HeaderMap) -> Option<String> {
    headers.get("x-forwarded-for")?.to_str().ok()?.split(',').next().map(|ip| ip.trim().to_owned()).filter(|ip| !ip.is_empty())
}

fn route_of(path: &str) -> &'static str {
    match path {
        "/ws" => "/ws",
        "/thumb/{file}" => "/thumb/{file}",
        "/live" => "/live",
        "/viewers" => "/viewers",
        _ => "/health",
    }
}

fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| !std::env::var("RATE_LIMITS").is_ok_and(|v| v.trim().eq_ignore_ascii_case("off")))
}

pub(crate) async fn layer(State(l): State<Limits>, req: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(req).await;
    }
    let Some(ip) = forwarded_ip(req.headers()) else { return next.run(req).await };
    let route = route_of(req.extensions().get::<MatchedPath>().map(|p| p.as_str()).unwrap_or(""));
    if let Err(left) = l.hit(&ip, route, per_minute(route), Instant::now()) {
        let mut res = (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "error": format!("too many requests. try again in {left}s") }))).into_response();
        res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(left));
        return res;
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn past_the_count_waits_out_the_minute() {
        let l = Limits::default();
        let now = Instant::now();
        for _ in 0..60 {
            assert!(l.hit("1.2.3.4", "/ws", 60, now).is_ok());
        }
        assert_eq!(l.hit("1.2.3.4", "/ws", 60, now + Duration::from_secs(15)), Err(45));
        // another route and another address have their own counts
        assert!(l.hit("1.2.3.4", "/thumb/{file}", 3000, now).is_ok());
        assert!(l.hit("5.6.7.8", "/ws", 60, now).is_ok());
        assert!(l.hit("1.2.3.4", "/ws", 60, now + WINDOW).is_ok());
    }

    #[test]
    fn the_counts() {
        assert_eq!(per_minute("/ws"), 60);
        assert_eq!(per_minute("/thumb/{file}"), 3000);
        assert_eq!(per_minute("/health"), 600);
    }
}
