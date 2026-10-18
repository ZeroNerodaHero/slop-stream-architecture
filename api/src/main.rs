//! The json api. Bios live in postgres. Who is live lives in redis, and the
//! video server is asked to confirm it is really connected.
//!
//! When the video server answers, it is the truth for "live right now": the
//! list and the watch page come from it, and a redis key with no connected
//! publisher behind it is treated as stale. When it does not answer, redis is
//! used alone (list and watch), and go-live refuses rather than guess.
//!
//! go-live hands out a session id plus a random token. Heartbeat and stop
//! must present them, so a stranger cannot end someone else's stream.

use std::collections::HashSet;
use std::env;
use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::{AsyncCommands, ExistenceCheck, SetExpiry, SetOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Executor;
use tokio::time::sleep;

/// A live key dies this long after the last heartbeat. The page beats every 15s.
const LIVE_TTL_SECS: i64 = 90;
const WS_PATH: &str = "/ws";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS streamers (
    name text PRIMARY KEY,
    bio text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS
    token bigint NOT NULL DEFAULT (floor(random() * 9007199254740991))::bigint;
CREATE INDEX IF NOT EXISTS sessions_name_started_idx ON sessions (name, started_at DESC);
";

#[derive(Clone)]
struct AppState {
    db: PgPool,
    redis: ConnectionManager,
    http: reqwest::Client,
    video_url: String,
    /// Names starting with this are the fake streams of `video dummy`.
    dummy_prefix: String,
    dummy_password: Option<String>,
}

struct ApiError(StatusCode, String);

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
    }
    fn already_live() -> Self {
        Self::new(StatusCode::CONFLICT, "someone is already live")
    }
    fn not_yours() -> Self {
        Self::new(StatusCode::FORBIDDEN, "not your session")
    }
    fn video_down() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "video server unreachable")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        log::error!("postgres: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "database error")
    }
}

impl From<redis::RedisError> for ApiError {
    fn from(e: redis::RedisError) -> Self {
        log::error!("redis: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "redis error")
    }
}

impl From<JsonRejection> for ApiError {
    fn from(_: JsonRejection) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad json body")
    }
}

type ApiResult<T = Value> = Result<Json<T>, ApiError>;

/// A stream name from the path. Lowercase a-z 0-9 _ -, 1 to 32 chars.
struct Name(String);

impl<S: Send + Sync> FromRequestParts<S> for Name {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        let Path(raw) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad name"))?;
        let name = raw.trim().to_lowercase();
        let valid = (1..=32).contains(&name.len())
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
        if !valid {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "bad name. use a-z 0-9 _ - (1 to 32)",
            ));
        }
        Ok(Name(name))
    }
}

#[derive(Deserialize)]
struct BioBody {
    bio: String,
}

/// Proof that you are the one who went live. From the query string, so the
/// page can also send it with `sendBeacon` when the tab closes.
#[derive(Deserialize)]
struct Owner {
    session: i64,
    token: i64,
}

#[derive(Deserialize, Default)]
struct GoLiveQuery {
    /// Only needed for a reserved (dummy) name.
    password: Option<String>,
}

fn live_key(name: &str) -> String {
    format!("live:{name}")
}

fn nx_ex() -> SetOptions {
    SetOptions::default()
        .conditional_set(ExistenceCheck::NX)
        .with_expiration(SetExpiry::EX(LIVE_TTL_SECS as u64))
}

async fn load_bio(db: &PgPool, name: &str) -> Result<String, sqlx::Error> {
    let bio: Option<String> = sqlx::query_scalar("SELECT bio FROM streamers WHERE name = $1")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(bio.unwrap_or_default())
}

/// Names the video server says are connected right now. None if it cannot be reached.
async fn video_live(s: &AppState) -> Option<HashSet<String>> {
    let res = s
        .http
        .get(format!("{}/live", s.video_url))
        .send()
        .await
        .map_err(|e| log::warn!("video unreachable: {e}"))
        .ok()?;
    let names: Vec<String> = res.json().await.ok()?;
    Some(names.into_iter().collect())
}

/// Names with a live key in redis.
async fn redis_live(s: &AppState) -> Result<Vec<String>, redis::RedisError> {
    let mut r = s.redis.clone();
    let mut names = HashSet::new();
    let mut iter: redis::AsyncIter<String> = r.scan_match("live:*").await?;
    while let Some(key) = iter.next_item().await {
        names.insert(key?.trim_start_matches("live:").to_string());
    }
    Ok(names.into_iter().collect())
}

/// Does this session own the live key for the name, and is it still open?
async fn owns_session(db: &PgPool, name: &str, owner: &Owner) -> Result<bool, sqlx::Error> {
    let open: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM sessions WHERE id = $1 AND token = $2 AND name = $3 AND ended_at IS NULL",
    )
    .bind(owner.session)
    .bind(owner.token)
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(open.is_some())
}

async fn health(State(s): State<AppState>) -> ApiResult {
    let down = |what: &str| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{what} down"));
    sqlx::query("SELECT 1")
        .execute(&s.db)
        .await
        .map_err(|_| down("postgres"))?;
    let mut r = s.redis.clone();
    redis::cmd("PING")
        .query_async::<String>(&mut r)
        .await
        .map_err(|_| down("redis"))?;
    Ok(Json(json!({ "ok": true })))
}

async fn put_streamer(
    State(s): State<AppState>,
    Name(name): Name,
    body: Result<Json<BioBody>, JsonRejection>,
) -> ApiResult {
    let Json(body) = body?;
    let bio = body.bio.trim().chars().take(500).collect::<String>();
    let bio: String = sqlx::query_scalar(
        "INSERT INTO streamers (name, bio) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET bio = EXCLUDED.bio, updated_at = now()
         RETURNING bio",
    )
    .bind(&name)
    .bind(&bio)
    .fetch_one(&s.db)
    .await?;
    Ok(Json(json!({ "name": name, "bio": bio })))
}

async fn get_streamer(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let bio = load_bio(&s.db, &name).await?;
    Ok(Json(json!({ "name": name, "bio": bio })))
}

async fn list_sessions(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let rows: Vec<(i64, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, started_at, ended_at FROM sessions
         WHERE name = $1 ORDER BY started_at DESC LIMIT 20",
    )
    .bind(&name)
    .fetch_all(&s.db)
    .await?;
    let out = rows.into_iter().map(|(id, started_at, ended_at)| {
        json!({ "id": id, "name": name, "started_at": started_at, "ended_at": ended_at })
    });
    Ok(Json(Value::Array(out.collect())))
}

async fn list_streams(State(s): State<AppState>) -> ApiResult {
    let names: Vec<String> = match video_live(&s).await {
        Some(connected) => connected.into_iter().collect(),
        None => redis_live(&s).await?,
    };
    if names.is_empty() {
        return Ok(Json(json!([])));
    }

    let rows: Vec<(String, String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT n.name, COALESCE(st.bio, '') AS bio, s.started_at
         FROM unnest($1::text[]) AS n(name)
         LEFT JOIN streamers st ON st.name = n.name
         LEFT JOIN LATERAL (
             SELECT started_at FROM sessions
             WHERE name = n.name AND ended_at IS NULL
             ORDER BY started_at DESC LIMIT 1
         ) s ON true
         ORDER BY s.started_at DESC NULLS LAST, n.name",
    )
    .bind(&names)
    .fetch_all(&s.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|(name, bio, since)| json!({ "name": name, "bio": bio, "since": since }));
    Ok(Json(Value::Array(out.collect())))
}

async fn go_live(State(s): State<AppState>, Name(name): Name, Query(q): Query<GoLiveQuery>) -> ApiResult {
    if name.starts_with(&s.dummy_prefix) {
        let allowed = matches!((&s.dummy_password, &q.password), (Some(p), Some(given)) if p == given);
        if !allowed {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
        }
    }

    let key = live_key(&name);
    let mut r = s.redis.clone();

    let connected = video_live(&s).await;
    if connected.as_ref().is_some_and(|set| set.contains(&name)) {
        return Err(ApiError::already_live());
    }
    if r.exists::<_, bool>(&key).await? {
        // The key is there but nobody is connected under that name. A crashed
        // tab left it. Let the name go live again instead of waiting for the ttl.
        if connected.is_none() {
            return Err(ApiError::video_down());
        }
        log::info!("{name}: clearing stale live key");
        let _: () = r.del(&key).await?;
    }

    let (id, token): (i64, i64) =
        sqlx::query_as("INSERT INTO sessions (name) VALUES ($1) RETURNING id, token")
            .bind(&name)
            .fetch_one(&s.db)
            .await?;

    let claimed: Option<String> = r.set_options(&key, id, nx_ex()).await?;
    if claimed.is_none() {
        sqlx::query("UPDATE sessions SET ended_at = now() WHERE id = $1")
            .bind(id)
            .execute(&s.db)
            .await?;
        return Err(ApiError::already_live());
    }
    // We own the name now. Anything older that still looks open is over.
    sqlx::query(
        "UPDATE sessions SET ended_at = now() WHERE name = $1 AND ended_at IS NULL AND id <> $2",
    )
    .bind(&name)
    .bind(id)
    .execute(&s.db)
    .await?;

    log::info!("{name}: go live, session {id}");
    Ok(Json(
        json!({ "url": WS_PATH, "session": id, "token": token }),
    ))
}

async fn heartbeat(
    State(s): State<AppState>,
    Name(name): Name,
    Query(owner): Query<Owner>,
) -> ApiResult {
    // Session ids are guessable. The token is not. Check both every time.
    if !owns_session(&s.db, &name, &owner).await? {
        return Err(ApiError::not_yours());
    }

    let key = live_key(&name);
    let mut r = s.redis.clone();

    match r.get::<_, Option<i64>>(&key).await? {
        Some(holder) if holder == owner.session => {
            let _: bool = r.expire(&key, LIVE_TTL_SECS).await?;
            Ok(Json(json!({ "ok": true })))
        }
        Some(_) => Err(ApiError::already_live()),
        None => {
            // The key lapsed (sleeping laptop, throttled tab). Take it back.
            let claimed: Option<String> = r.set_options(&key, owner.session, nx_ex()).await?;
            if claimed.is_none() {
                return Err(ApiError::already_live());
            }
            Ok(Json(json!({ "ok": true, "reclaimed": true })))
        }
    }
}

async fn stop(
    State(s): State<AppState>,
    Name(name): Name,
    Query(owner): Query<Owner>,
) -> ApiResult {
    let done = sqlx::query(
        "UPDATE sessions SET ended_at = now()
         WHERE id = $1 AND token = $2 AND name = $3 AND ended_at IS NULL",
    )
    .bind(owner.session)
    .bind(owner.token)
    .bind(&name)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_yours());
    }

    let key = live_key(&name);
    let mut r = s.redis.clone();
    if r.get::<_, Option<i64>>(&key).await? == Some(owner.session) {
        let _: () = r.del(&key).await?;
    }
    log::info!("{name}: stop, session {}", owner.session);
    Ok(Json(json!({ "ok": true })))
}

async fn watch(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let live = match video_live(&s).await {
        Some(connected) => connected.contains(&name),
        None => {
            let mut r = s.redis.clone();
            r.exists(live_key(&name)).await?
        }
    };
    let bio = load_bio(&s.db, &name).await?;
    Ok(Json(json!({ "url": WS_PATH, "bio": bio, "live": live })))
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/streams", get(list_streams))
        .route("/api/streamers/{name}", get(get_streamer).put(put_streamer))
        .route("/api/streamers/{name}/sessions", get(list_sessions))
        .route("/api/streams/{name}/go-live", post(go_live))
        .route("/api/streams/{name}/heartbeat", post(heartbeat))
        .route("/api/streams/{name}/stop", post(stop))
        .route("/api/streams/{name}/watch", post(watch))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "no such route") })
        .with_state(state)
}

async fn connect_postgres(url: &str) -> PgPool {
    let options = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5));
    loop {
        match options.clone().connect(url).await {
            Ok(pool) => return pool,
            Err(e) => log::warn!("postgres not ready: {e}"),
        }
        sleep(Duration::from_secs(2)).await;
    }
}

async fn connect_redis(url: &str) -> ConnectionManager {
    let client = redis::Client::open(url).expect("bad REDIS_URL");
    let config = ConnectionManagerConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(Duration::from_secs(5)));
    loop {
        match ConnectionManager::new_with_config(client.clone(), config.clone()).await {
            Ok(con) => return con,
            Err(e) => log::warn!("redis not ready: {e}"),
        }
        sleep(Duration::from_secs(2)).await;
    }
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
    let mut int = signal(SignalKind::interrupt()).expect("sigint handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
    log::info!("shutting down");
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://stream:stream@database:5432/stream".into());
    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://redis:6379/0".into());
    let video_url = env::var("VIDEO_URL").unwrap_or_else(|_| "http://video:7880".into());
    let port = env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4000);

    let db = connect_postgres(&database_url).await;
    db.execute(SCHEMA).await.expect("create tables");
    let redis = connect_redis(&redis_url).await;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("http client");

    let state = AppState {
        db,
        redis,
        http,
        video_url,
        dummy_prefix: env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into()),
        dummy_password: env::var("DUMMY_PASSWORD").ok().filter(|p| !p.trim().is_empty()),
    };

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    log::info!("api on 0.0.0.0:{port}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(wait_for_signal())
        .await
        .expect("server");
}
