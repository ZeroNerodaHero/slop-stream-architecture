mod about_page;
mod analytics;
mod auth;
mod cf_purge;
mod chat;
mod chat_images;
mod chat_videos;
mod debug;
mod dms;
mod emotes;
mod events;
mod follows;
mod group_mod;
mod groups;
mod history;
mod home;
mod janny;
mod media;
mod schema;
mod models;
mod moderate;
mod monitor;
mod notify;
mod oauth;
mod pins;
mod presence;
mod profile;
mod ratelimit;
mod reactions;
mod release;
mod s3;
mod socket;
mod test_streamers;
mod turnstile;
mod voice;

use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use auth::Me;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{FromRef, FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::{AsyncCommands, ExistenceCheck, SetExpiry, SetOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};
use test_streamers::DummySecret;
use tokio::time::sleep;

const LIVE_TTL_SECS: i64 = 90;
const GO_LIVE_GRACE_SECS: i64 = 20;
const ZOMBIE_AFTER_SECS: i64 = 180;
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const LIVE_SET_FRESH: Duration = Duration::from_secs(1);
const WS_PATH: &str = "/ws";

type LiveCache = Arc<Mutex<Option<(Instant, Arc<HashSet<String>>)>>>;
type RecentCache = Arc<Mutex<Option<(Instant, Value)>>>;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) db: PgPool,
    pub(crate) debug: Option<PgPool>,
    pub(crate) redis: ConnectionManager,
    pub(crate) http: reqwest::Client,
    video_url: String,
    pub(crate) dummy_prefix: String,
    pub(crate) dummy_password: Option<String>,
    pub(crate) hide_test: bool,
    pub(crate) env_name: String,
    build: String,
    started: Instant,
    pub(crate) admins: Vec<auth::Account>,
    pub(crate) ops_token: Option<String>,
    s3: s3::Store,
    pub(crate) groups_per_owner: i64,
    live_cache: LiveCache,
    recent_cache: RecentCache,
    pub(crate) oauth: Arc<oauth::Config>,
    pub(crate) turnstile: Arc<turnstile::Config>,
}

impl FromRef<AppState> for PgPool {
    fn from_ref(s: &AppState) -> PgPool {
        s.db.clone()
    }
}

impl FromRef<AppState> for s3::Store {
    fn from_ref(s: &AppState) -> s3::Store {
        s.s3.clone()
    }
}

#[derive(Debug)]
pub(crate) struct ApiError(StatusCode, String, Option<i64>);

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into(), None)
    }
    pub(crate) fn retry_after(mut self, secs: i64) -> Self {
        self.2 = Some(secs.max(1));
        self
    }
    pub(crate) fn message(&self) -> &str {
        &self.1
    }
    pub(crate) fn bad_name() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad name. use a-z 0-9 _ - (1 to 32)")
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
        match self.2 {
            Some(secs) => ratelimit::too_many(secs, &self.1),
            None => (self.0, Json(json!({ "error": self.1 }))).into_response(),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        log::error!("postgres: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "database error")
    }
}

pub(crate) fn unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error().and_then(|e| e.code()).is_some_and(|code| code == "23505")
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

impl From<QueryRejection> for ApiError {
    fn from(_: QueryRejection) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad query string")
    }
}

pub(crate) type ApiResult<T = Value> = Result<Json<T>, ApiError>;

pub(crate) fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

pub(crate) struct Name(pub(crate) String);

impl<S: Send + Sync> FromRequestParts<S> for Name {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        let Path(raw) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad name"))?;
        let name = raw.trim().to_lowercase();
        if !valid_name(&name) {
            return Err(ApiError::bad_name());
        }
        Ok(Name(name))
    }
}

#[derive(Deserialize)]
struct BioBody {
    bio: String,
}

#[derive(Deserialize)]
pub(crate) struct Owner {
    pub(crate) session: i64,
    pub(crate) token: i64,
}

#[derive(Deserialize, Default)]
pub(crate) struct PasswordQuery {
    pub(crate) password: Option<String>,
}

pub(crate) async fn may_write(s: &AppState, name: &str, me: Option<&str>, password: Option<&str>) -> Result<(), ApiError> {
    if name.starts_with(&s.dummy_prefix) {
        if !test_streamers::secret_ok(s.dummy_password.as_deref(), password) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
        }
        test_streamers::mark(&s.db, name).await?;
        return Ok(());
    }
    auth::may_act_as(&s.db, name, me).await
}

pub(crate) fn live_key(name: &str) -> String {
    format!("live:{name}")
}

fn nx_ex() -> SetOptions {
    SetOptions::default()
        .conditional_set(ExistenceCheck::NX)
        .with_expiration(SetExpiry::EX(LIVE_TTL_SECS as u64))
}

pub(crate) async fn video_live(s: &AppState) -> Option<HashSet<String>> {
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

pub(crate) async fn live_set(s: &AppState) -> Result<Arc<HashSet<String>>, ApiError> {
    if let Some((at, set)) = s.live_cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < LIVE_SET_FRESH {
            return Ok(set.clone());
        }
    }
    let set: Arc<HashSet<String>> = Arc::new(match video_live(s).await {
        Some(connected) => connected,
        None => redis_live(s).await?.into_iter().collect(),
    });
    *s.live_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), set.clone()));
    Ok(set)
}

pub(crate) async fn video_viewers(http: &reqwest::Client, video_url: &str) -> Option<HashMap<String, usize>> {
    let res = http
        .get(format!("{video_url}/viewers"))
        .send()
        .await
        .map_err(|e| log::warn!("video unreachable: {e}"))
        .ok()?;
    res.json().await.ok()
}

pub(crate) async fn is_live(s: &AppState, name: &str) -> Result<bool, ApiError> {
    Ok(match video_live(s).await {
        Some(connected) => connected.contains(name),
        None => {
            let mut r = s.redis.clone();
            r.exists(live_key(name)).await?
        }
    })
}

pub(crate) async fn thumb_exists(s: &AppState, name: &str) -> bool {
    s.http
        .head(format!("{}/thumb/{name}.jpg", s.video_url))
        .send()
        .await
        .is_ok_and(|res| res.status().is_success())
}

pub(crate) async fn redis_live(s: &AppState) -> Result<Vec<String>, redis::RedisError> {
    let mut r = s.redis.clone();
    let mut names = HashSet::new();
    let mut iter: redis::AsyncIter<String> = r.scan_match("live:*").await?;
    while let Some(key) = iter.next_item().await {
        names.insert(key?.trim_start_matches("live:").to_string());
    }
    Ok(names.into_iter().collect())
}

async fn held_sessions(s: &AppState) -> Result<Vec<i64>, redis::RedisError> {
    let mut r = s.redis.clone();
    let mut keys = Vec::new();
    {
        let mut iter: redis::AsyncIter<String> = r.scan_match("live:*").await?;
        while let Some(key) = iter.next_item().await {
            keys.push(key?);
        }
    }
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let values: Vec<Option<i64>> = r.mget(&keys).await?;
    Ok(values.into_iter().flatten().collect())
}

async fn sweep_sessions(s: AppState) {
    let start = tokio::time::Instant::now() + SWEEP_EVERY;
    let mut tick = tokio::time::interval_at(start, SWEEP_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        match sweep_once(&s).await {
            Ok(0) => {}
            Ok(n) => log::debug!("sweep: ended {n} open sessions nobody holds"),
            Err(e) => log::warn!("sweep: {e}"),
        }
    }
}

async fn sweep_once(s: &AppState) -> anyhow::Result<u64> {
    let Some(connected) = video_live(s).await else {
        log::info!("sweep: video unreachable, nothing ended");
        return Ok(0);
    };
    let connected: Vec<String> = connected.into_iter().collect();
    let held = held_sessions(s).await?;
    let ended: Vec<(String, i64)> = sqlx::query_as(
        "UPDATE sessions SET ended_at = COALESCE(last_beat_at, started_at), ended_by = 'sweep'
         WHERE ended_at IS NULL AND started_at < now() - make_interval(secs => $1)
           AND id <> ALL($2) AND name <> ALL($3)
         RETURNING name, id",
    )
    .bind(ZOMBIE_AFTER_SECS as f64)
    .bind(&held)
    .bind(&connected)
    .fetch_all(&s.db)
    .await?;
    let mut r = s.redis.clone();
    for (name, id) in &ended {
        presence::publish_ended(&mut r, name, Some(*id), "sweep").await;
    }
    Ok(ended.len() as u64)
}

fn new_session_token() -> i64 {
    (OsRng.next_u64() >> 11) as i64
}

const DEL_IF_HELD_BY: &str = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

async fn session_verified(db: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    let verified: Option<bool> = sqlx::query_scalar(
        "SELECT verified FROM sessions WHERE name = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(verified.unwrap_or(false))
}

pub(crate) async fn owns_session(db: &PgPool, name: &str, owner: &Owner) -> Result<bool, sqlx::Error> {
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

#[derive(Deserialize, Default)]
struct VideoHealth {
    up_secs: Option<u64>,
    live: Option<usize>,
    build: Option<String>,
}

async fn video_health(s: &AppState) -> Option<VideoHealth> {
    let res = s.http.get(format!("{}/health", s.video_url)).send().await.ok()?.error_for_status().ok()?;
    Some(res.json().await.unwrap_or_default())
}

pub(crate) const OPTIONAL_PROBE: Duration = Duration::from_millis(1500);

async fn health(State(s): State<AppState>) -> Response {
    let (deploy, redis, debug_db, video, errors_dropped, s3_ok) = tokio::join!(
        release::current(&s.db),
        async { redis::cmd("PING").query_async::<String>(&mut s.redis.clone()).await.is_ok() },
        async {
            match &s.debug {
                Some(db) => tokio::time::timeout(OPTIONAL_PROBE, sqlx::query("SELECT 1").execute(db)).await.is_ok_and(|r| r.is_ok()),
                None => false,
            }
        },
        async { tokio::time::timeout(OPTIONAL_PROBE, video_health(&s)).await.ok().flatten() },
        debug::dropped(&s),
        async { tokio::time::timeout(OPTIONAL_PROBE, s3::ready(&s.s3)).await.unwrap_or(false) },
    );
    let postgres = deploy.is_ok();
    let deploy = deploy.ok().flatten();
    let ok = postgres && redis;
    let body = json!({
        "ok": ok,
        "env": s.env_name,
        "version": deploy.as_ref().map(|d| d.0.as_str()),
        "deployed_at": deploy.as_ref().map(|d| d.1),
        "build": s.build,
        "up_secs": s.started.elapsed().as_secs(),
        "postgres": postgres,
        "redis": redis,
        "debug_db": debug_db,
        "video": video.is_some(),
        "video_up_secs": video.as_ref().and_then(|v| v.up_secs),
        "video_build": video.as_ref().and_then(|v| v.build.clone()),
        "live": video.as_ref().and_then(|v| v.live),
        "s3": s3_ok,
        "s3_bucket": s.s3.bucket,
        "s3_endpoint": s.s3.endpoint,
        "errors_dropped": errors_dropped,
    });
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(body)).into_response()
}

const MAX_BIO_CHARS: usize = 200;

fn clean_bio(raw: &str) -> Result<String, ApiError> {
    let bio = chat::clean_text(raw).split_whitespace().collect::<Vec<_>>().join(" ");
    if bio.chars().count() > MAX_BIO_CHARS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("status: {MAX_BIO_CHARS} characters at most")));
    }
    Ok(bio)
}

async fn put_streamer(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    secret: DummySecret,
    body: Result<Json<BioBody>, JsonRejection>,
) -> ApiResult {
    let Json(body) = body?;
    may_write(&s, &name, me.name(), secret.0.as_deref()).await?;
    let bio = clean_bio(&body.bio)?;
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

async fn last_live(db: &PgPool, name: &str) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT max(se.ended_at) FROM streamers s
         JOIN sessions se ON se.user_id = s.id OR (se.user_id IS NULL AND se.name = s.name AND s.password_hash IS NULL)
         WHERE s.name = $1",
    )
    .bind(name)
    .fetch_one(db)
    .await
}

async fn get_streamer(State(s): State<AppState>, Name(name): Name, me: Me) -> ApiResult {
    if test_streamers::hidden(&s.db, s.hide_test, &name).await? {
        return Err(test_streamers::not_found());
    }
    let p = profile::load_profile(&s.db, &name).await?;
    let presence = presence::presence(&s, &name).await?;
    let thumbs = profile::thumb_ids(&s.db, std::slice::from_ref(&name)).await?.remove(&name).unwrap_or_default();
    let follows = follows::stats(&s.db, &name, me.0.as_ref().map(|a| a.id)).await?;
    let last_live = last_live(&s.db, &name).await?;
    let badge = if p.verified { groups::badge_of(&s.db, &name).await? } else { None };
    Ok(Json(json!({
        "name": p.name, "bio": p.bio, "avatar": p.avatar, "verified": p.verified, "oauth_verified": p.oauth_verified, "presence": presence, "thumbs": thumbs,
        "offline": p.offline, "offline_note": p.offline_note, "socials": p.socials, "about": p.about,
        "welcome_on": p.welcome_on, "welcome": p.welcome,
        "followers": follows.followers, "following": follows.following, "follows_you": follows.follows_you,
        "last_live": last_live, "joined_at": p.joined, "badge": badge,
    })))
}

#[derive(Deserialize, Default)]
struct RangeQuery {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

const RANGE_MAX_DAYS: i64 = 93;
const RANGE_LIMIT: i64 = 1000;

type SessionRow = (i64, String, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>, Option<String>);

async fn list_sessions(State(s): State<AppState>, Name(name): Name, q: Result<Query<RangeQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let name = auth::renamed_to(&s.db, &name).await?.unwrap_or(name);
    let range = match (q.from, q.to) {
        (None, None) => None,
        (Some(from), Some(to)) if to > from && to - from <= chrono::Duration::days(RANGE_MAX_DAYS) => Some((from, to)),
        _ => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad range. from and to, rfc3339, at most 93 days apart")),
    };
    let rows: Vec<SessionRow> = match range {
        None => {
            sqlx::query_as(
                "SELECT id, name, started_at, ended_at, last_beat_at, ended_by FROM sessions
                 WHERE name = $1 ORDER BY started_at DESC LIMIT 20",
            )
            .bind(&name)
            .fetch_all(&s.db)
            .await?
        }
        Some((from, to)) => {
            let account: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL")
                .bind(&name)
                .fetch_optional(&s.db)
                .await?;
            match account {
                Some(id) => {
                    sqlx::query_as(
                        "SELECT id, name, started_at, ended_at, last_beat_at, ended_by FROM sessions
                         WHERE user_id = $1 AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)
                         ORDER BY started_at LIMIT $4",
                    )
                    .bind(id)
                    .bind(from)
                    .bind(to)
                    .bind(RANGE_LIMIT)
                    .fetch_all(&s.db)
                    .await?
                }
                None => {
                    sqlx::query_as(
                        "SELECT id, name, started_at, ended_at, last_beat_at, ended_by FROM sessions
                         WHERE name = $1 AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)
                         ORDER BY started_at LIMIT $4",
                    )
                    .bind(&name)
                    .bind(from)
                    .bind(to)
                    .bind(RANGE_LIMIT)
                    .fetch_all(&s.db)
                    .await?
                }
            }
        }
    };
    let out = rows.into_iter().map(|(id, name, started_at, ended_at, last_beat_at, ended_by)| {
        json!({ "id": id, "name": name, "started_at": started_at, "ended_at": ended_at, "last_beat_at": last_beat_at, "ended_by": ended_by })
    });
    Ok(Json(Value::Array(out.collect())))
}

async fn card_of(s: &AppState, name: &str, session: i64) -> Result<Value, ApiError> {
    let verified: Option<bool> = sqlx::query_scalar("SELECT verified FROM sessions WHERE id = $1")
        .bind(session)
        .fetch_optional(&s.db)
        .await?;
    let p = profile::load_profile(&s.db, name).await?;
    let names = [name.to_owned()];
    let thumbs = profile::thumb_ids(&s.db, &names).await?.remove(name).unwrap_or_default();
    let verified = verified.unwrap_or(false);
    let badge = if verified { groups::badge_of(&s.db, name).await? } else { None };
    Ok(json!({ "verified": verified, "avatar": p.avatar, "bio": p.bio, "thumbs": thumbs, "badge": badge }))
}

async fn go_live(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    secret: DummySecret,
) -> ApiResult {
    may_write(&s, &name, me.name(), secret.0.as_deref()).await?;
    if test_streamers::hidden(&s.db, s.hide_test, &name).await? {
        return Err(test_streamers::refused());
    }

    let key = live_key(&name);
    let mut r = s.redis.clone();

    let Some(connected) = video_live(&s).await else {
        return Err(ApiError::video_down());
    };
    if connected.contains(&name) {
        return Err(ApiError::already_live());
    }
    if let Some(holder) = r.get::<_, Option<i64>>(&key).await? {
        let young: Option<bool> = sqlx::query_scalar(
            "SELECT started_at > now() - make_interval(secs => $2) FROM sessions WHERE id = $1 AND ended_at IS NULL",
        )
        .bind(holder)
        .bind(GO_LIVE_GRACE_SECS as f64)
        .fetch_optional(&s.db)
        .await?;
        if young == Some(true) {
            return Err(ApiError::already_live());
        }
        log::info!("{name}: clearing stale live key of session {holder}");
        let _: i64 = redis::cmd("EVAL").arg(DEL_IF_HELD_BY).arg(1).arg(&key).arg(holder).query_async(&mut r).await?;
    }

    let account = me.0.as_ref().filter(|a| a.name == name);
    let verified = account.is_some();
    let token = new_session_token();
    let id: i64 = sqlx::query_scalar("INSERT INTO sessions (name, token, verified, user_id) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(&name)
        .bind(token)
        .bind(verified)
        .bind(account.map(|a| a.id))
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
    sqlx::query(
        "UPDATE sessions SET ended_at = COALESCE(last_beat_at, started_at), ended_by = 'sweep'
         WHERE name = $1 AND ended_at IS NULL AND id <> $2",
    )
    .bind(&name)
    .bind(id)
    .execute(&s.db)
    .await?;
    if let Err(e) = analytics::open(&s.db, id).await {
        log::warn!("{name}: analytics row for session {id}: {e}");
    }

    log::info!("{name}: go live, session {id}");
    Ok(Json(
        json!({ "url": WS_PATH, "session": id, "token": token }),
    ))
}

async fn attached(
    State(s): State<AppState>,
    Name(name): Name,
    owner: Result<Query<Owner>, QueryRejection>,
) -> ApiResult {
    let Query(owner) = owner?;
    if !owns_session(&s.db, &name, &owner).await? {
        return Err(ApiError::not_yours());
    }

    let key = live_key(&name);
    let mut r = s.redis.clone();
    match r.get::<_, Option<i64>>(&key).await? {
        Some(holder) if holder == owner.session => {}
        Some(_) => return Err(ApiError::already_live()),
        None => {
            let claimed: Option<String> = r.set_options(&key, owner.session, nx_ex()).await?;
            if claimed.is_none() {
                return Err(ApiError::already_live());
            }
        }
    }
    let since: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT started_at FROM sessions WHERE id = $1")
        .bind(owner.session)
        .fetch_optional(&s.db)
        .await?;
    let card = card_of(&s, &name, owner.session).await?;
    presence::publish_live(&mut r, &name, since.map_or_else(presence::now_ms, |t| t.timestamp_millis()), owner.session, &card).await;
    log::info!("{name}: video has the publisher, session {}", owner.session);
    notify::stream_started(&s, &name, owner.session).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ViewersQuery {
    session: i64,
    token: i64,
    viewers: usize,
}

async fn viewers(State(s): State<AppState>, Name(name): Name, q: Result<Query<ViewersQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let owner = Owner { session: q.session, token: q.token };
    if !owns_session(&s.db, &name, &owner).await? {
        return Err(ApiError::not_yours());
    }
    presence::publish_viewers(&mut s.redis.clone(), &name, owner.session, q.viewers).await;
    if let Err(e) = analytics::peak(&s.db, owner.session, q.viewers).await {
        log::warn!("{name}: peak viewers: {e}");
    }
    Ok(Json(json!({ "ok": true })))
}

async fn heartbeat(
    State(s): State<AppState>,
    Name(name): Name,
    owner: Result<Query<Owner>, QueryRejection>,
) -> ApiResult {
    let Query(owner) = owner?;
    let beat = sqlx::query(
        "UPDATE sessions SET last_beat_at = now()
         WHERE id = $1 AND token = $2 AND name = $3 AND ended_at IS NULL",
    )
    .bind(owner.session)
    .bind(owner.token)
    .bind(&name)
    .execute(&s.db)
    .await?;
    if beat.rows_affected() == 0 {
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
            let claimed: Option<String> = r.set_options(&key, owner.session, nx_ex()).await?;
            if claimed.is_none() {
                return Err(ApiError::already_live());
            }
            let since: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT started_at FROM sessions WHERE id = $1")
                .bind(owner.session)
                .fetch_optional(&s.db)
                .await?;
            let card = card_of(&s, &name, owner.session).await?;
            presence::publish_live(&mut r, &name, since.map_or_else(presence::now_ms, |t| t.timestamp_millis()), owner.session, &card).await;
            Ok(Json(json!({ "ok": true, "reclaimed": true })))
        }
    }
}

#[derive(Deserialize)]
struct StopQuery {
    session: i64,
    token: i64,
    by: Option<String>,
}

async fn stop(
    State(s): State<AppState>,
    Name(name): Name,
    q: Result<Query<StopQuery>, QueryRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let owner = Owner { session: q.session, token: q.token };
    let by = if q.by.as_deref() == Some("video") { "video" } else { "stop" };
    let done = sqlx::query(
        "UPDATE sessions SET ended_at = now(), ended_by = $4
         WHERE id = $1 AND token = $2 AND name = $3 AND ended_at IS NULL",
    )
    .bind(owner.session)
    .bind(owner.token)
    .bind(&name)
    .bind(by)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_yours());
    }
    if let Err(e) = analytics::ended(&s.db, owner.session).await {
        log::warn!("{name}: analytics end of session {}: {e}", owner.session);
    }

    let key = live_key(&name);
    let mut r = s.redis.clone();
    let deleted: i64 = redis::cmd("EVAL").arg(DEL_IF_HELD_BY).arg(1).arg(&key).arg(owner.session).query_async(&mut r).await?;
    let another_holds = deleted == 0 && matches!(r.get::<_, Option<i64>>(&key).await?, Some(holder) if holder != owner.session);
    if !another_holds {
        presence::publish_ended(&mut r, &name, Some(owner.session), "stop").await;
    }
    log::info!("{name}: stop, session {}", owner.session);
    Ok(Json(json!({ "ok": true })))
}

async fn watch(State(s): State<AppState>, Name(name): Name, me: Me) -> ApiResult {
    let name = auth::renamed_to(&s.db, &name).await?.unwrap_or(name);
    if test_streamers::hidden(&s.db, s.hide_test, &name).await? {
        return Err(test_streamers::not_found());
    }
    let live = is_live(&s, &name).await?;
    let p = profile::load_profile(&s.db, &name).await?;
    let verified = live && session_verified(&s.db, &name).await?;
    let oauth_verified = p.oauth_verified && (!live || verified);
    let presence = presence::presence_with(&mut s.redis.clone(), &s.db, &name, live).await?;
    let follows = follows::stats(&s.db, &name, me.0.as_ref().map(|a| a.id)).await?;
    let badge = if p.verified { groups::badge_of(&s.db, &name).await? } else { None };
    let can_moderate = janny::can_moderate(&s, &name, me.0.as_ref()).await?;
    Ok(Json(json!({
        "url": WS_PATH, "name": name, "bio": p.bio, "live": live, "verified": verified, "oauth_verified": oauth_verified, "avatar": p.avatar, "presence": presence,
        "offline": p.offline, "offline_note": p.offline_note, "socials": p.socials, "about": p.about,
        "welcome_on": p.welcome_on, "welcome": p.welcome,
        "followers": follows.followers, "following": follows.following, "joined_at": p.joined, "badge": badge,
        "can_moderate": can_moderate,
    })))
}

fn router(state: AppState) -> Router {
    Router::new()
        .merge(auth::routes())
        .merge(oauth::routes())
        .merge(turnstile::routes())
        .merge(profile::routes())
        .merge(about_page::routes())
        .merge(groups::routes())
        .merge(group_mod::routes())
        .merge(pins::routes())
        .merge(follows::routes())
        .merge(dms::routes())
        .merge(chat_images::routes())
        .merge(chat_videos::routes())
        .merge(emotes::routes())
        .merge(models::routes())
        .merge(notify::routes())
        .merge(presence::routes())
        .merge(debug::routes())
        .merge(voice::routes())
        .merge(janny::routes())
        .merge(analytics::routes())
        .route("/api/health", get(health))
        .route("/api/streamers/{name}", get(get_streamer).put(put_streamer))
        .route("/api/streamers/{name}/sessions", get(list_sessions).layer(axum::middleware::map_response(crate::media::public_cache(crate::media::SESSIONS_CACHE))))
        .route("/api/streams/{name}/go-live", post(go_live))
        .route("/api/streams/{name}/attached", post(attached))
        .route("/api/streams/{name}/viewers", post(viewers))
        .route("/api/streams/{name}/heartbeat", post(heartbeat))
        .route("/api/streams/{name}/stop", post(stop))
        .route("/api/streams/{name}/watch", post(watch))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), ratelimit::api))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "no such route") })
        .layer(axum::middleware::map_response(media::no_store_by_default))
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

pub(crate) async fn connect_redis(url: &str) -> ConnectionManager {
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

pub(crate) async fn wait_for_signal() {
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

    if env::args().nth(1).as_deref() == Some("monitor") {
        monitor::run().await.expect("monitor");
        return;
    }

    if env::args().nth(1).as_deref() == Some("models") {
        let args: Vec<String> = env::args().skip(2).collect();
        if let Err(e) = models::upload(&args).await {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://stream:stream@database:5432/stream".into());
    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://redis:6379/0".into());
    let video_url = env::var("VIDEO_URL").unwrap_or_else(|_| "http://video:7880".into());
    let port = env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4000);

    let db = connect_postgres(&database_url).await;

    if env::args().nth(1).as_deref() == Some("chat") {
        let port = env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4100);
        chat::run(db, &redis_url, port).await.expect("chat");
        return;
    }

    if env::args().nth(1).as_deref() == Some("events") {
        let port = env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4100);
        events::run(db, &redis_url, port).await.expect("events");
        return;
    }

    if env::args().nth(1).as_deref() == Some("home") {
        let port = env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4100);
        home::run(db, &redis_url, &video_url, port).await.expect("home");
        return;
    }

    schema::ensure(&db).await.expect("schema");
    moderate::warn_if_keyless();

    if env::args().nth(1).as_deref() == Some("passwd") {
        let name = env::args().nth(2).unwrap_or_default();
        if let Err(e) = auth::passwd(&db, &name).await {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    if env::args().nth(1).as_deref() == Some("release") {
        let version = env::args().nth(2).unwrap_or_default();
        let commit = env::args().nth(3).unwrap_or_default();
        if let Err(e) = release::record(&db, &version, &commit).await {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    let redis = connect_redis(&redis_url).await;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("http client");

    let debug_url = env::var("DEBUG_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://stream:stream@database:5432/debug".into());
    let debug = debug::connect(&db, &debug_url).await;
    if let Some(pool) = &debug {
        debug::housekeeping(db.clone(), pool.clone(), debug_url.clone());
    }
    let admin_names: Vec<String> = env::var("ADMIN_NAMES")
        .unwrap_or_default()
        .split(',')
        .map(|n| n.trim().to_lowercase())
        .filter(|n| valid_name(n))
        .collect();
    let admins = debug::admins_with_accounts(&db, admin_names).await.expect("read streamers");
    let admin_names: Vec<&str> = admins.iter().map(|a| a.name.as_str()).collect();
    let ops_token = env::var("OPS_TOKEN").ok().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    let ops_token = match ops_token {
        Some(t) if t.len() < 16 => {
            log::warn!("OPS_TOKEN is shorter than 16 characters, ignoring it. openssl rand -hex 32 makes a good one");
            None
        }
        other => other,
    };
    match (&admin_names[..], &ops_token) {
        ([], None) => log::info!("no ADMIN_NAMES and no OPS_TOKEN: GET /api/errors is off"),
        _ => log::info!("GET /api/errors: admins {admin_names:?}{}", if ops_token.is_some() { ", and OPS_TOKEN" } else { "" }),
    }
    let env_name = env::var("ENV_NAME").ok().map(|e| e.trim().to_owned()).filter(|e| !e.is_empty()).unwrap_or_else(|| "unnamed".into());
    if env_name == "unnamed" {
        log::warn!("no ENV_NAME: this box reports as \"unnamed\" in /api/health and every stored error. set ENV_NAME in .env");
    }
    let build = env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into());
    log::info!("env {env_name}, build {build}");
    let groups_per_owner = groups::groups_per_owner_from_env();
    log::info!("a login may own {groups_per_owner} group(s) (GROUPS_PER_OWNER)");

    let s3 = s3::from_env().unwrap_or_else(|e| {
        log::error!("{e}");
        std::process::exit(1);
    });
    s3::ensure(&s3).await;

    let state = AppState {
        db,
        debug,
        redis,
        http,
        video_url,
        dummy_prefix: env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into()),
        dummy_password: env::var("DUMMY_PASSWORD").ok().filter(|p| !p.trim().is_empty()),
        hide_test: test_streamers::hide_from_env(),
        env_name,
        build,
        started: Instant::now(),
        admins,
        ops_token,
        s3,
        groups_per_owner,
        live_cache: Arc::default(),
        recent_cache: Arc::default(),
        oauth: Arc::new(oauth::Config::from_env()),
        turnstile: Arc::new(turnstile::Config::from_env()),
    };

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    log::info!("api on 0.0.0.0:{port}");
    tokio::spawn(sweep_sessions(state.clone()));
    tokio::spawn(voice::sweep(state.clone()));
    tokio::spawn(analytics::sampler(state.clone()));
    axum::serve(listener, router(state))
        .with_graceful_shutdown(wait_for_signal())
        .await
        .expect("server");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_is_one_clean_line_and_refused_past_the_cap() {
        assert_eq!(clean_bio("  playing\n\n  chess\t now ").unwrap(), "playing chess now");
        assert_eq!(clean_bio("a\u{0}b\u{7}c\u{202E}d").unwrap(), "abcd");
        assert_eq!(clean_bio("").unwrap(), "");
        assert_eq!(clean_bio(&"é".repeat(MAX_BIO_CHARS)).unwrap().chars().count(), MAX_BIO_CHARS);
        let long = clean_bio(&"x".repeat(MAX_BIO_CHARS + 1)).unwrap_err();
        assert_eq!((long.0, long.1.as_str()), (StatusCode::BAD_REQUEST, "status: 200 characters at most"));
        assert!(clean_bio(&format!("{}{}", "x ".repeat(100).replace(' ', "   "), "\u{200B}".repeat(50))).is_ok());
    }

    #[test]
    fn names() {
        assert!(valid_name("a"));
        assert!(valid_name("billy_01-x"));
        assert!(valid_name(&"a".repeat(32)));
        assert!(!valid_name(""));
        assert!(!valid_name(&"a".repeat(33)));
        assert!(!valid_name("Billy"));
        assert!(!valid_name("bil ly"));
        assert!(!valid_name("bïlly"));
        assert!(!valid_name("a.b"));
        assert!(!valid_name("../x"));
    }

    #[test]
    fn session_token_is_a_safe_js_integer() {
        let tokens: Vec<i64> = (0..1000).map(|_| new_session_token()).collect();
        assert!(tokens.iter().all(|t| (0..1i64 << 53).contains(t)));
        let distinct: HashSet<i64> = tokens.iter().copied().collect();
        assert_eq!(distinct.len(), tokens.len());
    }
}
