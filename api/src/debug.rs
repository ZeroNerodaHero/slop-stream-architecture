use std::time::Duration;

use axum::extract::rejection::QueryRejection;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Executor;
use uuid::Uuid;

use crate::auth::Account;
use crate::{auth, ApiError, ApiResult, AppState};

const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_MESSAGE_CHARS: usize = 500;
const MAX_STACK_CHARS: usize = 8000;
const MAX_FIELD_CHARS: usize = 300;
const MAX_EXTRA_BYTES: usize = 2048;
const KINDS: [&str; 5] = ["crash", "error", "rejection", "soft", "api"];
const KEEP_DAYS: i32 = 14;
const KEEP_ROWS: i64 = 20_000;
const HOUSEKEEPING_FIRST: Duration = Duration::from_secs(60);
const HOUSEKEEPING_EVERY: Duration = Duration::from_secs(3600);
const PER_IP: i64 = 60;
const TOTAL: i64 = 2000;
const WINDOW_SECS: i64 = 600;
const DROPPED_KEY: &str = "rl:errors:dropped";
const DEFAULT_LIST: i64 = 100;
const MAX_LIST: i64 = 500;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS client_errors (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    env text NOT NULL,
    build text,
    kind text NOT NULL,
    page text NOT NULL,
    stream text,
    phase text,
    me text,
    ip text,
    ua text,
    message text NOT NULL,
    stack text,
    extra jsonb
);
CREATE INDEX IF NOT EXISTS client_errors_at_idx ON client_errors (at DESC);
";

pub(crate) async fn connect(main: &PgPool, url: &str) -> Option<PgPool> {
    if url.trim().is_empty() {
        log::info!("no DEBUG_DATABASE_URL: error reports go to the log only");
        return None;
    }
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(1))
        .connect_lazy(url)
        .map_err(|e| log::warn!("bad DEBUG_DATABASE_URL: {e}"))
        .ok()?;
    match ensure_schema(main, &pool, url).await {
        Ok(()) => log::info!("debug database ready for error reports"),
        Err(e) => log::warn!("debug database not usable ({e}): error reports go to the log only until it is"),
    }
    Some(pool)
}

async fn ensure_schema(main: &PgPool, pool: &PgPool, url: &str) -> Result<(), sqlx::Error> {
    match pool.execute(SCHEMA).await {
        Err(e) if is_missing_database(&e) => {
            match create_database(main, url).await {
                Ok(name) => log::info!("made the {name} database for error reports"),
                Err(e) => log::warn!("could not make the debug database: {e}"),
            }
            pool.execute(SCHEMA).await?;
        }
        other => {
            other?;
        }
    }
    Ok(())
}

fn is_missing_database(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("3D000"))
}

fn database_name(url: &str) -> Option<&str> {
    let name = url.rsplit('/').next()?.split('?').next()?;
    let plain = (1..=63).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    plain.then_some(name)
}

async fn create_database(main: &PgPool, url: &str) -> anyhow::Result<String> {
    let name = database_name(url)
        .ok_or_else(|| anyhow::anyhow!("DEBUG_DATABASE_URL must end in a plain database name (a-z 0-9 _)"))?;
    main.execute(format!("CREATE DATABASE \"{name}\"").as_str()).await?;
    Ok(name.to_string())
}

pub(crate) fn housekeeping(main: PgPool, pool: PgPool, url: String) {
    tokio::spawn(async move {
        let mut wait = HOUSEKEEPING_FIRST;
        loop {
            tokio::time::sleep(wait).await;
            wait = HOUSEKEEPING_EVERY;
            if let Err(e) = trim(&pool).await {
                log::warn!("debug database: {e}");
                if let Err(e) = ensure_schema(&main, &pool, &url).await {
                    log::warn!("debug database not usable ({e}): error reports go to the log only until it is");
                }
            }
        }
    });
}

async fn trim(pool: &PgPool) -> Result<(), sqlx::Error> {
    let old = sqlx::query("DELETE FROM client_errors WHERE at < now() - make_interval(days => $1)")
        .bind(KEEP_DAYS)
        .execute(pool)
        .await?
        .rows_affected();
    if old > 0 {
        log::info!("dropped {old} error reports older than {KEEP_DAYS} days");
    }
    let over = sqlx::query(
        "DELETE FROM client_errors
         WHERE id <= (SELECT id FROM client_errors ORDER BY id DESC OFFSET $1 LIMIT 1)",
    )
    .bind(KEEP_ROWS)
    .execute(pool)
    .await?
    .rows_affected();
    if over > 0 {
        log::info!("dropped {over} error reports past the newest {KEEP_ROWS}");
    }
    Ok(())
}

pub(crate) async fn dropped(s: &AppState) -> i64 {
    let n: Option<i64> = s.redis.clone().get(DROPPED_KEY).await.ok().flatten();
    n.unwrap_or(0)
}

pub(crate) async fn admins_with_accounts(db: &PgPool, names: Vec<String>) -> Result<Vec<Account>, sqlx::Error> {
    sqlx::query(
        "INSERT INTO admin_pins (name, user_id)
         SELECT name, id FROM streamers WHERE name = ANY($1) AND password_hash IS NOT NULL
         ON CONFLICT (name) DO NOTHING",
    )
    .bind(&names)
    .execute(db)
    .await?;
    let pinned: Vec<(String, Uuid, String)> = sqlx::query_as(
        "SELECT p.name, s.id, s.name FROM admin_pins p JOIN streamers s ON s.id = p.user_id WHERE p.name = ANY($1)",
    )
    .bind(&names)
    .fetch_all(db)
    .await?;
    let mut admins: Vec<Account> = Vec::new();
    for name in &names {
        match pinned.iter().find(|(pin, _, _)| pin == name) {
            None => log::error!(
                "ADMIN_NAMES: {name} has no account, so it is not an admin. sign up as it, or: docker compose exec api api passwd {name}. then ./scripts/deploy.sh api"
            ),
            Some((_, id, now)) => {
                if now != name {
                    log::warn!("ADMIN_NAMES: {name} is pinned to the account now called {now}; that account is the admin, not whoever is called {name} now");
                }
                if !admins.iter().any(|a| a.id == *id) {
                    admins.push(Account { id: *id, name: now.clone() });
                }
            }
        }
    }
    Ok(admins)
}

#[derive(Deserialize)]
struct Report {
    kind: String,
    message: String,
    #[serde(default)]
    stack: Option<String>,
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    stream: Option<String>,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    build: Option<String>,
    #[serde(default)]
    ua: Option<String>,
    #[serde(default)]
    extra: Option<Value>,
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(max).collect()
}

fn clip_opt(s: &Option<String>, max: usize) -> Option<String> {
    s.as_deref().map(|s| clip(s, max)).filter(|s| !s.is_empty())
}

fn clip_stack(s: &Option<String>) -> Option<String> {
    let keep = |c: &char| !c.is_control() || matches!(c, '\n' | '\t');
    s.as_deref()
        .map(|s| s.trim().chars().filter(keep).take(MAX_STACK_CHARS).collect::<String>())
        .filter(|s| !s.is_empty())
}

fn scrub(v: Value) -> Value {
    let clean = |s: String| s.chars().filter(|c| !c.is_control()).collect::<String>();
    match v {
        Value::String(s) => Value::String(clean(s)),
        Value::Array(a) => Value::Array(a.into_iter().map(scrub).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (clean(k), scrub(v))).collect()),
        other => other,
    }
}

fn clip_extra(v: Option<Value>) -> Option<Value> {
    let v = scrub(v.filter(Value::is_object)?);
    Some(if v.to_string().len() > MAX_EXTRA_BYTES { json!({ "clipped": true }) } else { v })
}

enum Lane {
    Store,
    Drop,
    LogOnly,
}

async fn lane(s: &AppState, ip: &str) -> Lane {
    let over = match auth::bump(s, &format!("rl:errors:ip:{ip}"), WINDOW_SECS).await {
        Err(_) => return Lane::LogOnly,
        Ok(n) if n > PER_IP => true,
        Ok(_) => match auth::bump(s, "rl:errors:all", WINDOW_SECS).await {
            Err(_) => return Lane::LogOnly,
            Ok(t) => t > TOTAL,
        },
    };
    if !over {
        return Lane::Store;
    }
    let _ = auth::bump(s, DROPPED_KEY, WINDOW_SECS).await;
    Lane::Drop
}

async fn post_error(State(s): State<AppState>, headers: HeaderMap, body: String) -> Result<StatusCode, ApiError> {
    let Ok(r) = serde_json::from_str::<Report>(&body) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad report"));
    };
    let kind = r.kind.trim();
    let message = clip(&r.message, MAX_MESSAGE_CHARS);
    if !KINDS.contains(&kind) || message.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad report"));
    }
    let ip = auth::client_ip(&headers);
    let lane = lane(&s, &ip).await;
    if matches!(lane, Lane::Drop) {
        return Ok(StatusCode::NO_CONTENT);
    }
    let page = clip_opt(&r.page, MAX_FIELD_CHARS).unwrap_or_else(|| "?".into());
    let me = tokio::time::timeout(Duration::from_millis(500), auth::whoami_readonly(&s.db, &headers))
        .await
        .ok()
        .and_then(|me| me.ok())
        .flatten()
        .map(|a| a.name);
    log::warn!(
        "client error [{}] {page} {kind} ({ip}{}): {message}",
        s.env_name,
        me.as_deref().map(|m| format!(", {m}")).unwrap_or_default(),
    );
    let Some(db) = s.debug.as_ref().filter(|_| matches!(lane, Lane::Store)) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let written = sqlx::query(
        "INSERT INTO client_errors (env, build, kind, page, stream, phase, me, ip, ua, message, stack, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    .bind(&s.env_name)
    .bind(clip_opt(&r.build, 64))
    .bind(kind)
    .bind(&page)
    .bind(clip_opt(&r.stream, 32))
    .bind(clip_opt(&r.phase, 32))
    .bind(&me)
    .bind(&ip)
    .bind(clip_opt(&r.ua, MAX_FIELD_CHARS))
    .bind(&message)
    .bind(clip_stack(&r.stack))
    .bind(clip_extra(r.extra))
    .execute(db)
    .await;
    if let Err(e) = written {
        log::warn!("debug database: {e}");
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct ListQuery {
    limit: Option<i64>,
    since: Option<DateTime<Utc>>,
    kind: Option<String>,
    page: Option<String>,
}

#[derive(Serialize)]
struct ErrorRow {
    id: i64,
    at: DateTime<Utc>,
    env: String,
    build: Option<String>,
    kind: String,
    page: String,
    stream: Option<String>,
    phase: Option<String>,
    me: Option<String>,
    ip: Option<String>,
    ua: Option<String>,
    message: String,
    stack: Option<String>,
    extra: Option<Value>,
}

type ErrorTuple = (
    i64,
    DateTime<Utc>,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<Value>,
);

impl From<ErrorTuple> for ErrorRow {
    fn from((id, at, env, build, kind, page, stream, phase, me, ip, ua, message, stack, extra): ErrorTuple) -> Self {
        Self { id, at, env, build, kind, page, stream, phase, me, ip, ua, message, stack, extra }
    }
}

async fn is_admin(s: &AppState, headers: &HeaderMap) -> Result<bool, ApiError> {
    if let Some(token) = &s.ops_token {
        let given = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim);
        if given.is_some_and(|g| Sha256::digest(g) == Sha256::digest(token)) {
            return Ok(true);
        }
    }
    if s.admins.is_empty() {
        return Ok(false);
    }
    let me = auth::whoami(&s.db, headers).await?;
    Ok(me.is_some_and(|m| s.admins.iter().any(|a| a.id == m.id)))
}

fn list_filter(raw: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw.filter(|f| !f.is_empty()) else { return Ok(None) };
    if raw.chars().count() > MAX_FIELD_CHARS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("filter: {MAX_FIELD_CHARS} characters at most")));
    }
    if raw.chars().any(char::is_control) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad filter"));
    }
    Ok(Some(raw))
}

async fn list_errors(State(s): State<AppState>, headers: HeaderMap, q: Result<Query<ListQuery>, QueryRejection>) -> ApiResult<Vec<ErrorRow>> {
    if s.admins.is_empty() && s.ops_token.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such route"));
    }
    if !is_admin(&s, &headers).await? {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "admins only"));
    }
    let Query(q) = q?;
    let Some(db) = &s.debug else {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "no debug database"));
    };
    let limit = q.limit.unwrap_or(DEFAULT_LIST).clamp(1, MAX_LIST);
    let rows: Vec<ErrorTuple> = sqlx::query_as(
        "SELECT id, at, env, build, kind, page, stream, phase, me, ip, ua, message, stack, extra
         FROM client_errors
         WHERE ($1::timestamptz IS NULL OR at > $1)
           AND ($2::text IS NULL OR kind = $2)
           AND ($3::text IS NULL OR page = $3)
         ORDER BY at DESC, id DESC
         LIMIT $4",
    )
    .bind(q.since)
    .bind(list_filter(q.kind)?)
    .bind(list_filter(q.page)?)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(Json(rows.into_iter().map(ErrorRow::from).collect()))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/errors", post(post_error).get(list_errors))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_filter_is_none_when_empty_and_refused_when_it_could_match_nothing() {
        assert_eq!(list_filter(None).unwrap(), None);
        assert_eq!(list_filter(Some(String::new())).unwrap(), None);
        assert_eq!(list_filter(Some("/watch/bob".into())).unwrap().as_deref(), Some("/watch/bob"));
        assert!(list_filter(Some("é".repeat(MAX_FIELD_CHARS))).is_ok());
        let long = list_filter(Some("x".repeat(MAX_FIELD_CHARS + 1))).unwrap_err();
        assert_eq!((long.0, long.1.as_str()), (StatusCode::BAD_REQUEST, "filter: 300 characters at most"));
        assert_eq!(list_filter(Some("a\u{0}".into())).unwrap_err().1, "bad filter");
    }
}
