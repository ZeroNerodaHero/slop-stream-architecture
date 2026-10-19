//! The pages' error reports, and the debug database they land in. See docs/debugging.md.
//!
//! A page that breaks posts one json line to `POST /api/errors` (sendBeacon, so
//! the body arrives as text/plain). It is written to a second postgres database,
//! `debug`, made here when missing, through a lazy pool the api never waits for.
//! Nothing in this file can stop the api: a dead debug database means the report
//! is a warn line in the log and the browser still gets its 204.
//!
//! `GET /api/errors` reads them back, for a login in ADMIN_NAMES (the /admin
//! page) or a machine holding OPS_TOKEN.

use std::time::Duration;

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

use crate::{auth, ApiError, ApiResult, AppState};

const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_MESSAGE_CHARS: usize = 500;
const MAX_STACK_CHARS: usize = 8000;
const MAX_FIELD_CHARS: usize = 300;
/// `extra` as json, bytes. Bigger is replaced by {"clipped": true}: the message and stack are the report.
const MAX_EXTRA_BYTES: usize = 2048;
/// The five things a page reports. See frontend/src/infra/report.ts.
const KINDS: [&str; 5] = ["crash", "error", "rejection", "soft", "api"];
/// Rows go after this many days, and the table never holds more than this many rows.
const KEEP_DAYS: i32 = 14;
const KEEP_ROWS: i64 = 20_000;
/// Housekeeping runs soon after boot (a box that was flooded while down gets trimmed), then hourly.
const HOUSEKEEPING_FIRST: Duration = Duration::from_secs(60);
const HOUSEKEEPING_EVERY: Duration = Duration::from_secs(3600);
/// Reports per ip, and in total, per window. Over it they are dropped, quietly,
/// counted in DROPPED_KEY for /api/health.
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

// ---- the debug database ----------------------------------------------------------

/// A lazy pool on `url`, with the database and its table made when missing.
/// `None` only for an empty url or one that does not parse. A server that is
/// down costs a few seconds here at boot (the pool's 1s, the main pool's 5s) and
/// nothing after: a report just goes to the log, and housekeeping tries the
/// database and the table again every hour.
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

/// The table, and first the database when the server says there is none (3D000).
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

/// postgres 3D000, invalid_catalog_name: the database in the url does not exist.
fn is_missing_database(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("3D000"))
}

/// The database name at the end of a postgres url, if it is a plain identifier.
fn database_name(url: &str) -> Option<&str> {
    let name = url.rsplit('/').next()?.split('?').next()?;
    let plain = (1..=63).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    plain.then_some(name)
}

/// `CREATE DATABASE` through the main pool. Works when both urls point at the
/// same server, which is the compose setup. Elsewhere, make it by hand.
async fn create_database(main: &PgPool, url: &str) -> anyhow::Result<String> {
    let name = database_name(url)
        .ok_or_else(|| anyhow::anyhow!("DEBUG_DATABASE_URL must end in a plain database name (a-z 0-9 _)"))?;
    // no bind parameters in CREATE DATABASE. the name was checked to be a plain identifier.
    main.execute(format!("CREATE DATABASE \"{name}\"").as_str()).await?;
    Ok(name.to_string())
}

/// A minute after boot, then once an hour: drop rows older than KEEP_DAYS and
/// everything past the newest KEEP_ROWS. When that fails the database or the
/// table may not be there yet (it came up late, or was wiped), so make them.
pub(crate) fn housekeeping(main: PgPool, pool: PgPool, url: String) {
    tokio::spawn(async move {
        let mut wait = HOUSEKEEPING_FIRST;
        loop {
            tokio::time::sleep(wait).await;
            wait = HOUSEKEEPING_EVERY;
            // the schema only when the trim failed: on a table that exists it is two NOTICE lines in the log
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

/// Reports the limits dropped in the current window, for /api/health. 0 when none, or redis is not answering.
pub(crate) async fn dropped(s: &AppState) -> i64 {
    let n: Option<i64> = s.redis.clone().get(DROPPED_KEY).await.ok().flatten();
    n.unwrap_or(0)
}

/// Of `names`, the ones with an account. A name nobody has signed up as goes to
/// whoever signs up as it first (auth.rs), so it must not be an admin until then.
pub(crate) async fn admins_with_accounts(db: &PgPool, names: Vec<String>) -> Result<Vec<String>, sqlx::Error> {
    let claimed: Vec<String> =
        sqlx::query_scalar("SELECT name FROM streamers WHERE name = ANY($1) AND password_hash IS NOT NULL")
            .bind(&names)
            .fetch_all(db)
            .await?;
    for name in names.iter().filter(|n| !claimed.contains(n)) {
        log::error!(
            "ADMIN_NAMES: {name} has no account, so it is not an admin. sign up as it, or: docker compose exec api api passwd {name}. then ./deploy.sh api"
        );
    }
    Ok(names.into_iter().filter(|n| claimed.contains(n)).collect())
}

// ---- POST /api/errors ---------------------------------------------------------------

/// What a page sends. Everything but kind and message is optional; see frontend/src/infra/report.ts.
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

/// Trimmed, at most `max` chars, and no control characters: none belongs in an
/// error text, a \r or an escape code would forge or wipe lines in the log, and
/// postgres refuses \u0000. The stack is the one field that keeps its \n and \t.
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

/// Control characters out of every string and key in it: postgres jsonb refuses \u0000.
fn scrub(v: Value) -> Value {
    let clean = |s: String| s.chars().filter(|c| !c.is_control()).collect::<String>();
    match v {
        Value::String(s) => Value::String(clean(s)),
        Value::Array(a) => Value::Array(a.into_iter().map(scrub).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (clean(k), scrub(v))).collect()),
        other => other,
    }
}

/// `extra` as stored: an object, scrubbed, and {"clipped": true} in place of one bigger than MAX_EXTRA_BYTES.
fn clip_extra(v: Option<Value>) -> Option<Value> {
    let v = scrub(v.filter(Value::is_object)?);
    Some(if v.to_string().len() > MAX_EXTRA_BYTES { json!({ "clipped": true }) } else { v })
}

/// Where a report goes. Over a limit it is dropped and counted in DROPPED_KEY.
/// With redis not answering nothing can be counted, so it goes to the log only:
/// the log can take a flood, the table should not.
enum Lane {
    Store,
    Drop,
    LogOnly,
}

async fn lane(s: &AppState, ip: &str) -> Lane {
    // the ip's own count first, the shared one only when that passes: one noisy
    // ip must not use up everyone's share of the window
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

/// The body is read raw: sendBeacon sends text/plain, and the Json extractor would refuse it.
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
    // not the Me extractor, and no last_seen write: a main database that is down or
    // slow must not turn a report into a 500 or hold it up. half a second, then nobody
    let me = tokio::time::timeout(Duration::from_millis(500), auth::whoami_readonly(&s.db, &headers))
        .await
        .ok()
        .and_then(|me| me.ok())
        .flatten();
    // one line: clip() left no control character in page or message, and kind is from KINDS
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

// ---- GET /api/errors -----------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ListQuery {
    limit: Option<i64>,
    /// Only rows after this instant (rfc3339).
    since: Option<DateTime<Utc>>,
    kind: Option<String>,
    page: Option<String>,
}

/// One stored report, as /api/errors returns it. Read as a tuple: the sqlx derive is not on.
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

/// A login in ADMIN_NAMES, or `Authorization: Bearer <OPS_TOKEN>`. The bearer is
/// compared as two sha256 digests, so the comparison time says nothing about the
/// token. The cookie is looked up by its sha256 in auth.rs, like every login.
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
    if s.admin_names.is_empty() {
        return Ok(false);
    }
    let me = auth::whoami(&s.db, headers).await?;
    Ok(me.is_some_and(|m| s.admin_names.contains(&m)))
}

async fn list_errors(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<ListQuery>) -> ApiResult<Vec<ErrorRow>> {
    // nobody is an admin here, so for everyone the route does not exist
    if s.admin_names.is_empty() && s.ops_token.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such route"));
    }
    if !is_admin(&s, &headers).await? {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "admins only"));
    }
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
    .bind(q.kind.filter(|k| !k.is_empty()))
    .bind(q.page.filter(|p| !p.is_empty()))
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
