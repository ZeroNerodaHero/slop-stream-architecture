use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{self, Me};
use crate::oauth::random_hex;
use crate::{ApiError, ApiResult, AppState, Owner};

const SESSION_SECS: u64 = 12 * 3600;
const TOKEN_SECS: u64 = 600;
const STATUS_SECS: u64 = 40;
const MESSAGE_MAX: usize = 200;
const STATES: [&str; 4] = ["connecting", "live", "error", "off"];
const SECRET_MIN: usize = 16;

pub(crate) struct Config {
    url: Option<String>,
    secret: Option<String>,
}

impl Config {
    pub(crate) fn from_env() -> Self {
        let cfg = Self::from_vars(|k| std::env::var(k).ok());
        if cfg.on() {
            log::info!("relay: on, publishing to {}", cfg.url.as_deref().unwrap_or_default());
        } else {
            log::info!("relay: off (needs RELAY_URL and RELAY_SECRET, 16 characters or more)");
        }
        cfg
    }

    pub(crate) fn from_vars(get: impl Fn(&str) -> Option<String>) -> Self {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let url = val("RELAY_URL").and_then(|raw| {
            let u = url::Url::parse(&raw).ok()?;
            matches!(u.scheme(), "https" | "http").then(|| raw.trim_end_matches('/').to_owned())
        });
        let secret = val("RELAY_SECRET").filter(|s| s.len() >= SECRET_MIN);
        Config { url, secret }
    }

    pub(crate) fn on(&self) -> bool {
        self.url.is_some() && self.secret.is_some()
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Session {
    user: Uuid,
    name: String,
    live: i64,
}

fn session_key(id: &str) -> String {
    format!("relay:session:{id}")
}

fn token_key(token: &str) -> String {
    let hash: String = Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!("relay:token:{hash}")
}

fn mine_key(user: Uuid) -> String {
    format!("relay:mine:{user}")
}

fn status_key(id: &str) -> String {
    format!("relay:status:{id}")
}

fn note_key(id: &str) -> String {
    format!("relay:note:{id}")
}

pub(crate) fn valid_session_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn same(a: &str, b: &str) -> bool {
    let (a, b) = (Sha256::digest(a), Sha256::digest(b));
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn gate(s: &AppState) -> Result<(&Config, &crate::destinations::Config), ApiError> {
    let relay = s.relay.as_ref();
    let dest = s.destinations.as_ref();
    if relay.on() && dest.on() {
        Ok((relay, dest))
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "not found"))
    }
}

fn inside(s: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let (relay, _) = gate(s)?;
    let given = headers.get("x-relay-secret").and_then(|v| v.to_str().ok()).unwrap_or_default();
    match relay.secret.as_deref() {
        Some(secret) if !given.is_empty() && same(given, secret) => Ok(()),
        _ => Err(ApiError::new(StatusCode::FORBIDDEN, "forbidden")),
    }
}

async fn session_of(s: &AppState, id: &str) -> Result<Option<Session>, ApiError> {
    if !valid_session_id(id) {
        return Ok(None);
    }
    let raw: Option<String> = redis::cmd("GET").arg(session_key(id)).query_async(&mut s.redis.clone()).await?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
}

async fn drop_session(s: &AppState, id: &str, user: Uuid) -> Result<(), ApiError> {
    let _: () = redis::cmd("DEL").arg(session_key(id)).arg(status_key(id)).arg(note_key(id)).query_async(&mut s.redis.clone()).await?;
    let _: i64 = redis::cmd("EVAL")
        .arg("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end")
        .arg(1)
        .arg(mine_key(user))
        .arg(id)
        .query_async(&mut s.redis.clone())
        .await?;
    Ok(())
}

pub(crate) async fn statuses(s: &AppState, user: Uuid) -> HashMap<Uuid, Value> {
    let mut out = HashMap::new();
    if !s.relay.on() {
        return out;
    }
    let mut r = s.redis.clone();
    let Ok(Some(id)) = redis::cmd("GET").arg(mine_key(user)).query_async::<Option<String>>(&mut r).await else {
        return out;
    };
    let states: HashMap<String, String> = redis::cmd("HGETALL").arg(status_key(&id)).query_async(&mut r).await.unwrap_or_default();
    let notes: HashMap<String, String> = redis::cmd("HGETALL").arg(note_key(&id)).query_async(&mut r).await.unwrap_or_default();
    for (dest, raw) in &states {
        let (Ok(dest), Ok(mut v)) = (dest.parse::<Uuid>(), serde_json::from_str::<Value>(raw)) else { continue };
        if let Some(note) = notes.get(&dest.to_string()) {
            if v["state"] != "error" {
                v["note"] = json!(note);
            }
        }
        out.insert(dest, v);
    }
    for (dest, note) in &notes {
        let Ok(dest) = dest.parse::<Uuid>() else { continue };
        out.entry(dest).or_insert_with(|| json!({ "state": "error", "message": note }));
    }
    out
}

#[derive(Deserialize)]
struct StartBody {
    name: String,
    session: i64,
    token: i64,
    #[serde(default)]
    title: Option<String>,
}

async fn start(State(s): State<AppState>, Me(me): Me, body: Result<Json<StartBody>, JsonRejection>) -> ApiResult {
    let (relay, dest) = gate(&s)?;
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let Json(body) = body?;
    if body.name != me.name || !crate::owns_session(&s.db, &body.name, &Owner { session: body.session, token: body.token }).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "that live session is not yours"));
    }
    let row: Option<(bool, Option<Uuid>)> = sqlx::query_as("SELECT verified, user_id FROM sessions WHERE id = $1").bind(body.session).fetch_optional(&s.db).await?;
    if !matches!(row, Some((true, Some(u))) if u == me.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only a logged-in streamer can send their stream on"));
    }
    auth::limit(&s, &format!("relay:start:{}", me.id), 60, 10, "slow down").await?;
    if crate::destinations::usable_count(dest, &s.db, me.id).await? == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "no destination is on"));
    }
    let mut r = s.redis.clone();
    let before: Option<String> = redis::cmd("GET").arg(mine_key(me.id)).query_async(&mut r).await?;
    if let Some(old) = before {
        drop_session(&s, &old, me.id).await?;
    }
    let id = random_hex()[..32].to_owned();
    let token = random_hex();
    let session = Session { user: me.id, name: me.name.clone(), live: body.session };
    let raw = serde_json::to_string(&session).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not start"))?;
    let _: () = redis::pipe()
        .cmd("SET").arg(session_key(&id)).arg(raw).arg("EX").arg(SESSION_SECS).ignore()
        .cmd("SET").arg(token_key(&token)).arg(&id).arg("EX").arg(TOKEN_SECS).ignore()
        .cmd("SET").arg(mine_key(me.id)).arg(&id).arg("EX").arg(SESSION_SECS).ignore()
        .query_async(&mut r)
        .await?;
    let title = body.title.as_deref().and_then(crate::destinations::clean_title).unwrap_or_else(|| me.name.clone());
    let task = s.clone();
    let user = me.id;
    let sid = id.clone();
    tokio::spawn(async move {
        let results = match crate::destinations::announce(&task.destinations, &task.db, user, &title, None, "unlisted").await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("relay: announce: postgres: {e}");
                return;
            }
        };
        let mut r = task.redis.clone();
        for res in results.iter().filter(|v| v["ok"] == false) {
            let (Some(dest), Some(words)) = (res["id"].as_str(), res["error"].as_str()) else { continue };
            let _: Result<(), _> = redis::pipe()
                .cmd("HSET").arg(note_key(&sid)).arg(dest).arg(words).ignore()
                .cmd("EXPIRE").arg(note_key(&sid)).arg(SESSION_SECS).ignore()
                .query_async(&mut r)
                .await;
        }
    });
    log::info!("{}: relay session started for live session {}", me.name, body.session);
    let whip = format!("{}/{id}/whip", relay.url.as_deref().unwrap_or_default());
    Ok(Json(json!({ "session": id, "token": token, "whip": whip })))
}

async fn stop(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    gate(&s)?;
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let id: Option<String> = redis::cmd("GET").arg(mine_key(me.id)).query_async(&mut s.redis.clone()).await?;
    let Some(id) = id else {
        return Ok(Json(json!({ "ok": true, "stopped": false })));
    };
    drop_session(&s, &id, me.id).await?;
    let task = s.clone();
    let user = me.id;
    tokio::spawn(async move {
        if let Err(e) = crate::destinations::stop_youtube(&task.destinations, &task.db, user).await {
            log::warn!("relay: youtube stop: postgres: {e}");
        }
    });
    log::info!("{}: relay session stopped", me.name);
    Ok(Json(json!({ "ok": true, "stopped": true })))
}

#[derive(Deserialize)]
struct AuthBody {
    session: String,
    token: String,
}

async fn check(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<AuthBody>, JsonRejection>) -> ApiResult {
    inside(&s, &headers)?;
    let Json(body) = body?;
    let refused = || ApiError::new(StatusCode::FORBIDDEN, "no such relay session");
    if body.token.is_empty() || body.token.len() > 128 || session_of(&s, &body.session).await?.is_none() {
        return Err(refused());
    }
    let held: Option<String> = redis::cmd("GET").arg(token_key(&body.token)).query_async(&mut s.redis.clone()).await?;
    if held.as_deref() != Some(body.session.as_str()) {
        return Err(refused());
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TargetsQuery {
    session: String,
    #[serde(default)]
    refresh: Option<Uuid>,
}

async fn targets(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<TargetsQuery>) -> ApiResult {
    inside(&s, &headers)?;
    let Some(session) = session_of(&s, &q.session).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such relay session"));
    };
    let (found, notes) = crate::destinations::targets(&s.destinations, &s.db, session.user, q.refresh).await?;
    let mut r = s.redis.clone();
    for (dest, words) in &notes {
        let _: () = redis::pipe()
            .cmd("HSET").arg(note_key(&q.session)).arg(dest.to_string()).arg(words).ignore()
            .cmd("EXPIRE").arg(note_key(&q.session)).arg(SESSION_SECS).ignore()
            .query_async(&mut r)
            .await?;
    }
    let list: Vec<Value> = found.iter().map(|t| json!({ "id": t.id, "platform": t.platform, "url": t.url, "key": t.key })).collect();
    Ok(Json(json!({ "name": session.name, "targets": list })))
}

#[derive(Deserialize)]
struct StatusBody {
    session: String,
    id: Uuid,
    state: String,
    #[serde(default)]
    message: Option<String>,
}

async fn status(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<StatusBody>, JsonRejection>) -> ApiResult {
    inside(&s, &headers)?;
    let Json(body) = body?;
    if !STATES.contains(&body.state.as_str()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "state is connecting, live, error or off"));
    }
    if session_of(&s, &body.session).await?.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such relay session"));
    }
    let message: Option<String> = body.message.map(|m| m.chars().filter(|c| !c.is_control()).take(MESSAGE_MAX).collect::<String>()).filter(|m| !m.trim().is_empty());
    let v = json!({ "state": body.state, "message": message, "at": chrono::Utc::now().timestamp_millis() });
    let _: () = redis::pipe()
        .cmd("HSET").arg(status_key(&body.session)).arg(body.id.to_string()).arg(v.to_string()).ignore()
        .cmd("EXPIRE").arg(status_key(&body.session)).arg(STATUS_SECS).ignore()
        .query_async(&mut s.redis.clone())
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/relay/start", post(start))
        .route("/api/relay/stop", post(stop))
        .route("/internal/relay/auth", post(check))
        .route("/internal/relay/targets", get(targets))
        .route("/internal/relay/status", post(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_vars(|k| map.get(k).cloned())
    }

    #[test]
    fn it_stays_off_until_both_are_set() {
        assert!(!vars(&[]).on());
        assert!(!vars(&[("RELAY_URL", "https://relay.nodentity.xyz")]).on());
        assert!(!vars(&[("RELAY_SECRET", "0123456789abcdef0123")]).on());
        assert!(!vars(&[("RELAY_URL", "https://relay.nodentity.xyz"), ("RELAY_SECRET", "short")]).on(), "a short secret keeps it off");
        assert!(!vars(&[("RELAY_URL", "ftp://relay"), ("RELAY_SECRET", "0123456789abcdef0123")]).on());
        let on = vars(&[("RELAY_URL", "https://relay.nodentity.xyz/"), ("RELAY_SECRET", "0123456789abcdef0123")]);
        assert!(on.on());
        assert_eq!(on.url.as_deref(), Some("https://relay.nodentity.xyz"));
    }

    #[test]
    fn session_ids_are_32_lowercase_hex() {
        assert!(valid_session_id(&random_hex()[..32]));
        assert!(!valid_session_id(&random_hex()));
        assert!(!valid_session_id("../../../etc/passwd/aaaaaaaaaaaaaa"));
        assert!(!valid_session_id(&"A".repeat(32)));
        assert_ne!(token_key("a"), token_key("b"));
        assert!(!token_key("secret-token").contains("secret-token"));
    }
}
