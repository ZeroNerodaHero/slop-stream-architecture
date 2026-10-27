//! The json api. Bios live in postgres. Who is live lives in redis, and the
//! video server is asked to confirm it is really connected.
//!
//! When the video server answers, it is the truth for "live right now": the
//! list and the watch page come from it, and a redis key with no connected
//! publisher behind it is treated as stale once its session is older than a
//! short grace (a fresh go-live has not reached video yet). When it does not
//! answer, redis is used alone (list and watch), and go-live refuses rather
//! than guess.
//!
//! go-live hands out a session id plus a random token. Heartbeat and stop
//! must present them, so a stranger cannot end someone else's stream. A row
//! whose tab vanished without stop is ended by a sweeper once its key lapsed and
//! video does not have the name connected.
//!
//! Nobody has to log in. A name with an account (auth.rs) is the one thing a
//! login is for: only its owner can go live, save its bio, its pictures (profile.rs:
//! the face, the home card's, and the one its page shows while it is not live) or
//! chat as it. A login can also join groups (groups.rs), whose badges go on its chat lines.
//!
//! Every streamers row has a uuid that never changes (docs/ids.md). Logins,
//! memberships, groups and the pictures in the bucket point at it, so a login can
//! change its name (auth.rs, `POST /api/name`) and keep all of them. The name stays
//! the url, the chat nick and every redis key: nothing a person reads is an id.
//! The tables are the files in `api/migrations`, applied in order at boot (migrate.rs).
//!
//! The same binary run as `api chat` is the text chat server (chat.rs),
//! `api monitor` watches the other boxes from a box of its own (monitor.rs), and
//! `api passwd <name>` resets a password.
//!
//! One route is html, not json: `GET /watch/<name>` (profile.rs), so a shared
//! watch link gets a preview card with the name, picture, bio and live status.
//!
//! /api/health says how this box is doing (postgres, redis, video, the s3 bucket,
//! uptimes, build). The pages post their own failures to /api/errors (debug.rs).

mod auth;
mod chat;
mod debug;
mod events;
mod follows;
mod groups;
mod history;
mod home;
mod migrate;
mod monitor;
mod presence;
mod profile;
mod s3;
mod socket;

use std::collections::{HashMap, HashSet};
use std::env;
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
use tokio::time::sleep;

/// A live key dies this long after the last heartbeat. The page beats every 15s.
const LIVE_TTL_SECS: i64 = 90;
/// A key whose publisher video does not list yet is still theirs this long after
/// go-live: the page needs a moment to reach video. Older than this, it is a tab
/// that died without stop and the name is free again.
const GO_LIVE_GRACE_SECS: i64 = 20;
/// An open session row with no live key behind it is ended by the sweeper once it
/// is this old: longer than the key's ttl, so a merely slow heartbeat is never hit.
const ZOMBIE_AFTER_SECS: i64 = 180;
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const WS_PATH: &str = "/ws";

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) db: PgPool,
    /// The pages' error reports. None when DEBUG_DATABASE_URL is empty. See debug.rs.
    pub(crate) debug: Option<PgPool>,
    pub(crate) redis: ConnectionManager,
    http: reqwest::Client,
    video_url: String,
    /// Names starting with this are the fake streams of `video dummy`.
    pub(crate) dummy_prefix: String,
    dummy_password: Option<String>,
    /// ENV_NAME: what this box is called in /api/health and in every stored error. "unnamed" when unset.
    pub(crate) env_name: String,
    /// BUILD: the commit the image was built from.
    build: String,
    started: Instant,
    /// Logins that may read /api/errors (ADMIN_NAMES, resolved to accounts at boot so a rename
    /// keeps them admin until the next restart), and the bearer token a machine may use instead.
    pub(crate) admins: Vec<auth::Account>,
    pub(crate) ops_token: Option<String>,
    /// The bucket. The container when S3_ENDPOINT is off, otherwise the url it names. See s3.rs.
    s3: s3::Store,
}

impl FromRef<AppState> for PgPool {
    fn from_ref(s: &AppState) -> PgPool {
        s.db.clone()
    }
}

#[derive(Debug)]
pub(crate) struct ApiError(StatusCode, String);

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
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
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        log::error!("postgres: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "database error")
    }
}

/// Postgres said a unique key was already there (23505): a race somebody else won.
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

/// A missing or malformed query string is a 400 in the same `{error}` shape as
/// everything else, not axum's plain-text page.
impl From<QueryRejection> for ApiError {
    fn from(_: QueryRejection) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad query string")
    }
}

pub(crate) type ApiResult<T = Value> = Result<Json<T>, ApiError>;

/// Lowercase a-z 0-9 _ -, 1 to 32 chars. The same rule as video and the pages.
pub(crate) fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A stream name from the path.
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

/// Proof that you are the one who went live. From the query string, so the
/// page can also send it with `sendBeacon` when the tab closes.
#[derive(Deserialize)]
pub(crate) struct Owner {
    pub(crate) session: i64,
    pub(crate) token: i64,
}

/// `?password=`: only needed to write a reserved (dummy) name. Everyone else sends nothing.
#[derive(Deserialize, Default)]
pub(crate) struct PasswordQuery {
    pub(crate) password: Option<String>,
}

/// May whoever is behind `me` write `name`: go live as it, save its bio, set its picture.
/// A reserved name belongs to the dummy box and wants its password, nothing else opens it
/// (it can never be claimed, so `may_act_as` alone would hand it to anyone). Any other name
/// follows `auth::may_act_as`: free for anyone, claimed only for its own login.
pub(crate) async fn may_write(s: &AppState, name: &str, me: Option<&str>, password: Option<&str>) -> Result<(), ApiError> {
    if name.starts_with(&s.dummy_prefix) {
        let allowed = matches!((&s.dummy_password, password), (Some(p), Some(given)) if p == given);
        if !allowed {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
        }
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

/// Names the video server says are connected right now. None if it cannot be reached.
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

/// The names of `video_live` with how many different addresses are receiving each one
/// (docs/viewers.md). One call for both: the home service builds and heals its table from it.
/// None if video cannot be reached.
pub(crate) async fn video_viewers(http: &reqwest::Client, video_url: &str) -> Option<HashMap<String, usize>> {
    let res = http
        .get(format!("{video_url}/viewers"))
        .send()
        .await
        .map_err(|e| log::warn!("video unreachable: {e}"))
        .ok()?;
    res.json().await.ok()
}

/// Is this name live right now: the video server's word when it answers, else redis.
pub(crate) async fn is_live(s: &AppState, name: &str) -> Result<bool, ApiError> {
    Ok(match video_live(s).await {
        Some(connected) => connected.contains(name),
        None => {
            let mut r = s.redis.clone();
            r.exists(live_key(name)).await?
        }
    })
}

/// Does the video server have a picture of this stream yet (about 6s after going live).
pub(crate) async fn thumb_exists(s: &AppState, name: &str) -> bool {
    s.http
        .head(format!("{}/thumb/{name}.jpg", s.video_url))
        .send()
        .await
        .is_ok_and(|res| res.status().is_success())
}

/// Names with a live key in redis.
pub(crate) async fn redis_live(s: &AppState) -> Result<Vec<String>, redis::RedisError> {
    let mut r = s.redis.clone();
    let mut names = HashSet::new();
    let mut iter: redis::AsyncIter<String> = r.scan_match("live:*").await?;
    while let Some(key) = iter.next_item().await {
        names.insert(key?.trim_start_matches("live:").to_string());
    }
    Ok(names.into_iter().collect())
}

/// The session ids the live keys hold right now.
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

/// Nothing ends the row of a tab that vanished without stop: its key lapses, the
/// row stays open for good. Once a minute, end every open row that is older than
/// a key could survive without heartbeats and that no live key names any more.
/// A row whose name's key still holds its id is a stream whose heartbeat is coming.
async fn sweep_sessions(s: AppState) {
    // Not at boot. The keys only come from heartbeats, so after an api outage longer than the
    // ttl, or a redis restart, every live stream is keyless until its page's next beat (15s)
    // takes its key back; a sweep right then would end them all. A full period in, they have.
    let start = tokio::time::Instant::now() + SWEEP_EVERY;
    let mut tick = tokio::time::interval_at(start, SWEEP_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay); // a woken box sweeps once, not n times
    loop {
        tick.tick().await;
        match sweep_once(&s).await {
            Ok(0) => {}
            Ok(n) => log::debug!("sweep: ended {n} open sessions nobody holds"),
            Err(e) => log::warn!("sweep: {e}"),
        }
    }
}

/// Ends open rows old enough that no honest heartbeat could still be coming, that no live
/// key names, and whose name video does not have connected: a key can lapse under a stream
/// that is really on (the api was down past the ttl, redis restarted), and video's word is
/// what tells that from a dead tab. Without it nothing is ended: a zombie row ended a minute
/// late costs nothing, a live stream ended costs the stream.
async fn sweep_once(s: &AppState) -> anyhow::Result<u64> {
    let Some(connected) = video_live(s).await else {
        log::info!("sweep: video unreachable, nothing ended");
        return Ok(0);
    };
    let connected: Vec<String> = connected.into_iter().collect();
    let held = held_sessions(s).await?;
    // the block ends at the last heartbeat, not at this sweep: the stream was gone within a beat
    // of it, and the calendar draws the row (docs/calendar.md)
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
    // one `ended` per stream the sweep closed, for whoever is watching it (docs/status.md)
    let mut r = s.redis.clone();
    for (name, id) in &ended {
        presence::publish_ended(&mut r, name, Some(*id), "sweep").await;
    }
    Ok(ended.len() as u64)
}

/// 53 random bits from the os. The page keeps the token as a js number, which is
/// exact up to 2^53, and sends it back in the heartbeat and stop query strings.
fn new_session_token() -> i64 {
    (OsRng.next_u64() >> 11) as i64
}

/// Deletes the key only while it still holds the value we read, so a key that
/// changed hands between our GET and this call is left alone.
const DEL_IF_HELD_BY: &str = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

/// Was the name's open session started by its own account. False with no open session.
async fn session_verified(db: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    let verified: Option<bool> = sqlx::query_scalar(
        "SELECT verified FROM sessions WHERE name = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(verified.unwrap_or(false))
}

/// Does this session own the live key for the name, and is it still open?
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

/// What video's own GET /health says. Every field best-effort: during a deploy
/// the api can be new while video still answers the old plain `ok`.
#[derive(Deserialize, Default)]
struct VideoHealth {
    up_secs: Option<u64>,
    live: Option<usize>,
    build: Option<String>,
}

/// Some when video answered 2xx, whatever the body was.
async fn video_health(s: &AppState) -> Option<VideoHealth> {
    let res = s.http.get(format!("{}/health", s.video_url)).send().await.ok()?.error_for_status().ok()?;
    Some(res.json().await.unwrap_or_default())
}

/// The optional dependencies (debug db, video, the bucket) get this long in /api/health,
/// so a sick one cannot push the answer past docker's 3s healthcheck.
pub(crate) const OPTIONAL_PROBE: Duration = Duration::from_millis(1500);

/// 200 when postgres and redis answer, 503 otherwise. The rest of the body is for
/// a monitor: video reachable, rooms live, uptimes (they go backwards after a
/// restart), the build, reports the limits dropped. See docs/debugging.md.
async fn health(State(s): State<AppState>) -> Response {
    // all at once: the answer takes as long as the slowest probe, not the sum
    let (postgres, redis, debug_db, video, errors_dropped, s3_ok) = tokio::join!(
        async { sqlx::query("SELECT 1").execute(&s.db).await.is_ok() },
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
    let ok = postgres && redis;
    let body = json!({
        "ok": ok,
        "env": s.env_name,
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

async fn put_streamer(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<BioBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
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

async fn get_streamer(State(s): State<AppState>, Name(name): Name, me: Me) -> ApiResult {
    let p = profile::load_profile(&s.db, &name).await?;
    let presence = presence::presence(&s, &name).await?;
    let thumbs = profile::thumb_ids(&s.db, std::slice::from_ref(&name)).await?.remove(&name).unwrap_or_default();
    // how many follow the name (public), and whether the asking login does (docs/follows.md)
    let (followers, following) = follows::stats(&s.db, &name, me.0.as_ref().map(|a| a.id)).await?;
    Ok(Json(json!({
        "name": p.name, "bio": p.bio, "avatar": p.avatar, "verified": p.verified, "presence": presence, "thumbs": thumbs,
        "offline": p.offline, "offline_note": p.offline_note,
        "followers": followers, "following": following,
    })))
}

/// `?from=&to=`, both rfc3339, for the calendar's range. Neither: the last 20, as before.
#[derive(Deserialize, Default)]
struct RangeQuery {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

/// The most one calendar request spans: a quarter. The page asks four weeks at a time.
const RANGE_MAX_DAYS: i64 = 93;
/// The most rows one range answers. A person live every night for three years is a thousand.
const RANGE_LIMIT: i64 = 1000;

/// id, name, started_at, ended_at, last_beat_at, ended_by
type SessionRow = (i64, String, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>, Option<String>);

/// The name's sessions: the blocks of its calendar (docs/calendar.md). With a range, every row
/// overlapping `[from, to)`, oldest first, at most RANGE_LIMIT. A claimed name's are its
/// account's (`user_id`: a rename keeps them as one list, a stranger's anonymous stream under
/// the name before it was claimed is not on it); a free name's are the name's. Without a range,
/// the last 20 newest first, the shape the route has always had. Never the token.
async fn list_sessions(State(s): State<AppState>, Name(name): Name, q: Result<Query<RangeQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    // a name held after a rename answers for the name it became (docs/ids.md)
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

/// What a home card draws for a live name, as the `live` fact carries it (docs/status.md): the
/// session's ✓ (not the name's: an account that signs up while a stranger streams anonymously
/// under its name must not put a ✓ on that stream), the profile's picture and bio, and the
/// pictures the streamer put on the card. `GET /api/streams`, the home service's snapshot,
/// joins the same fields from postgres per answer.
async fn card_of(s: &AppState, name: &str, session: i64) -> Result<Value, ApiError> {
    let verified: Option<bool> = sqlx::query_scalar("SELECT verified FROM sessions WHERE id = $1")
        .bind(session)
        .fetch_optional(&s.db)
        .await?;
    let p = profile::load_profile(&s.db, name).await?;
    let names = [name.to_owned()];
    let thumbs = profile::thumb_ids(&s.db, &names).await?.remove(name).unwrap_or_default();
    Ok(json!({ "verified": verified.unwrap_or(false), "avatar": p.avatar, "bio": p.bio, "thumbs": thumbs }))
}

async fn go_live(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;

    let key = live_key(&name);
    let mut r = s.redis.clone();

    // Without video's word a key alone cannot tell a live stream from a dead tab,
    // so no go-live at all rather than a guess.
    let Some(connected) = video_live(&s).await else {
        return Err(ApiError::video_down());
    };
    if connected.contains(&name) {
        return Err(ApiError::already_live());
    }
    if let Some(holder) = r.get::<_, Option<i64>>(&key).await? {
        // A key with nobody connected under the name is either a tab that died
        // without stop, or a go-live from seconds ago whose publisher is still on
        // its way to video. The holder's row tells them apart: young and open, the
        // name is theirs; older than the grace, or already ended, the key is stale
        // and the name goes live again instead of waiting for the ttl.
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

    // the ✓: this session was started by the name's own account, not just by someone. the
    // account's id goes on the row too, so its history is one list after a rename (docs/ids.md)
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
    // We own the name now. Anything older that still looks open is over, and was over at its
    // last heartbeat: the same judgement as the sweeper's, a row nobody holds.
    sqlx::query(
        "UPDATE sessions SET ended_at = COALESCE(last_beat_at, started_at), ended_by = 'sweep'
         WHERE name = $1 AND ended_at IS NULL AND id <> $2",
    )
    .bind(&name)
    .bind(id)
    .execute(&s.db)
    .await?;

    // no `live` fact yet: the page has not reached video, and a watcher told now would be
    // answered "not live". video says when it has the publisher (`attached`), and that is
    // the push (docs/status.md)
    log::info!("{name}: go live, session {id}");
    Ok(Json(
        json!({ "url": WS_PATH, "session": id, "token": token }),
    ))
}

/// Video has the publisher: the room is claimed and answered, so a watcher who connects now
/// is served. This is where `live` is published for the name's watchers, not at go-live: the
/// gateway pushes it the moment it lands, and the page that gets it connects first time. Video
/// calls it after its claim with the go-live grant, like `heartbeat` and `stop`. A key that
/// lapsed meanwhile is taken back, as the heartbeat would.
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
    // `since` is the session's start, the go-live: how long they have been live counts from
    // there, not from the second or two video took to get the publisher
    let since: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT started_at FROM sessions WHERE id = $1")
        .bind(owner.session)
        .fetch_optional(&s.db)
        .await?;
    let card = card_of(&s, &name, owner.session).await?;
    presence::publish_live(&mut r, &name, since.map_or_else(presence::now_ms, |t| t.timestamp_millis()), owner.session, &card).await;
    log::info!("{name}: video has the publisher, session {}", owner.session);
    Ok(Json(json!({ "ok": true })))
}

/// `?session=&token=&viewers=`: the stream's grant and how many are receiving it.
#[derive(Deserialize)]
struct ViewersQuery {
    session: i64,
    token: i64,
    viewers: usize,
}

/// How many different addresses are receiving the stream, from video, whenever the number
/// moves (docs/viewers.md: video counts once ICE and DTLS are done, and says so at most once a
/// second per stream). A fact for the name's watchers and for home (docs/status.md); nothing
/// is stored here, the home service keeps the latest in its table.
async fn viewers(State(s): State<AppState>, Name(name): Name, q: Result<Query<ViewersQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let owner = Owner { session: q.session, token: q.token };
    if !owns_session(&s.db, &name, &owner).await? {
        return Err(ApiError::not_yours());
    }
    presence::publish_viewers(&mut s.redis.clone(), &name, owner.session, q.viewers).await;
    Ok(Json(json!({ "ok": true })))
}

async fn heartbeat(
    State(s): State<AppState>,
    Name(name): Name,
    owner: Result<Query<Owner>, QueryRejection>,
) -> ApiResult {
    let Query(owner) = owner?;
    // Session ids are guessable. The token is not. Check both every time. The check is the
    // write of the beat's time (docs/calendar.md): the same row, the same round trip, and a
    // row that vanishes without stop is later ended where this last landed.
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
            // The key lapsed (sleeping laptop, throttled tab). Take it back.
            let claimed: Option<String> = r.set_options(&key, owner.session, nx_ex()).await?;
            if claimed.is_none() {
                return Err(ApiError::already_live());
            }
            // live again as far as the key knows (a redis restart, an api outage past the ttl):
            // the watchers' word follows the key, so they are told. `since` stays the session's
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

/// `stop`'s query: the grant, and who is saying it. `by=video` is video's call when the
/// publisher's peer went; anything else, or nothing, is the page. A word for the record
/// (`sessions.ended_by`, docs/calendar.md), not a right: the grant is what is checked.
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

    // only while this session still holds it, in one step: a go-live that took the name
    // between a read here and the delete would lose its fresh key to this one's stop
    let key = live_key(&name);
    let mut r = s.redis.clone();
    let deleted: i64 = redis::cmd("EVAL").arg(DEL_IF_HELD_BY).arg(1).arg(&key).arg(owner.session).query_async(&mut r).await?;
    // `ended` for whoever is watching, unless another session took the name meanwhile: then
    // the name is still live and the word must not say otherwise (docs/status.md)
    let another_holds = deleted == 0 && matches!(r.get::<_, Option<i64>>(&key).await?, Some(holder) if holder != owner.session);
    if !another_holds {
        presence::publish_ended(&mut r, &name, Some(owner.session), "stop").await;
    }
    log::info!("{name}: stop, session {}", owner.session);
    Ok(Json(json!({ "ok": true })))
}

async fn watch(State(s): State<AppState>, Name(name): Name, me: Me) -> ApiResult {
    // a name held after a rename answers for the name it became; the grant says which, and the
    // page moves there (docs/ids.md). the url the person typed keeps working for the hold's length
    let name = auth::renamed_to(&s.db, &name).await?.unwrap_or(name);
    let live = is_live(&s, &name).await?;
    let p = profile::load_profile(&s.db, &name).await?;
    // the ✓ belongs to the live session (started by the account), not to the name
    let verified = live && session_verified(&s.db, &name).await?;
    let presence = presence::presence_with(&mut s.redis.clone(), &s.db, &name, live).await?;
    let (followers, following) = follows::stats(&s.db, &name, me.0.as_ref().map(|a| a.id)).await?;
    Ok(Json(json!({
        "url": WS_PATH, "name": name, "bio": p.bio, "live": live, "verified": verified, "avatar": p.avatar, "presence": presence,
        "offline": p.offline, "offline_note": p.offline_note,
        "followers": followers, "following": following,
    })))
}

fn router(state: AppState) -> Router {
    Router::new()
        .merge(auth::routes())
        .merge(profile::routes())
        .merge(groups::routes())
        .merge(follows::routes())
        .merge(presence::routes())
        .merge(debug::routes())
        .route("/api/health", get(health))
        // `GET /api/streams`, the home list, is the home service's (`api home`, home.rs): caddy sends it there
        .route("/api/streamers/{name}", get(get_streamer).put(put_streamer))
        .route("/api/streamers/{name}/sessions", get(list_sessions))
        .route("/api/streams/{name}/go-live", post(go_live))
        .route("/api/streams/{name}/attached", post(attached))
        .route("/api/streams/{name}/viewers", post(viewers))
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

    // `api monitor` runs on a box of its own, with no postgres and no redis: before either is touched
    if env::args().nth(1).as_deref() == Some("monitor") {
        monitor::run().await.expect("monitor");
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

    // `api chat` is the text chat, same binary, see chat.rs
    if env::args().nth(1).as_deref() == Some("chat") {
        let port = env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4100);
        chat::run(db, &redis_url, port).await.expect("chat");
        return;
    }

    // `api events` is the gateway: the /events socket, presence and the pushes. same binary, see events.rs
    if env::args().nth(1).as_deref() == Some("events") {
        let port = env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4100);
        events::run(db, &redis_url, port).await.expect("events");
        return;
    }

    // `api home` is the home list: every live stream and its viewers in memory, from the facts. same binary, see home.rs
    if env::args().nth(1).as_deref() == Some("home") {
        let port = env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4100);
        home::run(db, &redis_url, &video_url, port).await.expect("home");
        return;
    }

    // chat, events and home returned above and do not create tables. this process does, from api/migrations.
    migrate::run(&db).await.expect("migrations");

    // `api passwd <name>`: a new random password, printed once. see auth.rs
    if env::args().nth(1).as_deref() == Some("passwd") {
        let name = env::args().nth(2).unwrap_or_default();
        if let Err(e) = auth::passwd(&db, &name).await {
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

    // the pages' error reports. see debug.rs and docs/debugging.md
    let debug_url = env::var("DEBUG_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://stream:stream@database:5432/debug".into());
    let debug = debug::connect(&db, &debug_url).await;
    if let Some(pool) = &debug {
        debug::housekeeping(db.clone(), pool.clone(), debug_url.clone());
    }
    // only names with an account: a free name would make whoever signs up as it first the admin
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
    // "unnamed", not a guess like "prod": a box nobody labelled must not look like the real one in the error table
    let env_name = env::var("ENV_NAME").ok().map(|e| e.trim().to_owned()).filter(|e| !e.is_empty()).unwrap_or_else(|| "unnamed".into());
    if env_name == "unnamed" {
        log::warn!("no ENV_NAME: this box reports as \"unnamed\" in /api/health and every stored error. set ENV_NAME in .env");
    }
    let build = env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into());
    log::info!("env {env_name}, build {build}");

    // off: the seaweedfs container, and this waits until its bucket answers. a url is checked once.
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
        env_name,
        build,
        started: Instant::now(),
        admins,
        ops_token,
        s3,
    };

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    log::info!("api on 0.0.0.0:{port}");
    tokio::spawn(sweep_sessions(state.clone()));
    axum::serve(listener, router(state))
        .with_graceful_shutdown(wait_for_signal())
        .await
        .expect("server");
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // 1000 draws from 2^53 values: a repeat means the generator is broken
        let distinct: HashSet<i64> = tokens.iter().copied().collect();
        assert_eq!(distinct.len(), tokens.len());
    }
}
