//! Accounts: username + password. See docs/accounts.md.
//!
//! The password is hashed with argon2id and forgotten. A login is 32 random
//! bytes in an httponly cookie; the database keeps their sha256. Nobody has to
//! log in: a name without an account is free for anyone, like before. A name
//! with one (a "claimed" name) can only go live, save a bio or talk in chat
//! when the cookie says it is them.
//!
//! Behind every name is a row id, a uuid that never changes (docs/ids.md). The
//! cookie resolves to the id and the name together (`Account`); logins point at
//! the id, so `POST /api/name` can change the name and every device stays logged
//! in. The old name is held for the account for a while, and a signup as it is
//! refused like a taken one.

use std::sync::OnceLock;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRef, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use tokio::sync::Semaphore;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::{is_live, live_key, presence, profile, unique_violation, valid_name, ApiError, ApiResult, AppState};

const COOKIE: &str = "login";
const LOGIN_DAYS: i64 = 30;
/// A name changes once in this many days, and the old one is held for the account as long:
/// nobody else can sign up as it or rename onto it, and `/watch/<old>` leads to the new one.
const RENAME_DAYS: i64 = 30;
const HOLD_DAYS: i64 = 30;
const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;
/// Password tries in a window: per name from one ip (a right one clears that count),
/// and per ip over every name. Keyed on the ip too, so a stranger's wrong guesses
/// cannot lock the owner out; an attacker has to bring many ips.
const LOGIN_PER_NAME: i64 = 10;
const LOGIN_PER_IP: i64 = 100;
const LOGIN_WINDOW_SECS: i64 = 15 * 60;
const SIGNUP_PER_IP: i64 = 20;
const SIGNUP_WINDOW_SECS: i64 = 3600;
/// argon2 runs at once, process-wide. Each takes 19 MiB, so a burst of logins must
/// queue here rather than allocate n × 19 MiB on the blocking pool. A wait, never an error.
const HASH_SLOTS: usize = 4;

// ---- passwords ---------------------------------------------------------------

/// argon2id with owasp's numbers: 19 MiB, 2 passes, 1 lane. About 50ms on a small vps.
/// The salt and these settings travel inside the stored string, so they can change later.
fn hasher() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(19_456, 2, 1, None).expect("argon2 params"))
}

fn hash_password(password: &str) -> Option<String> {
    let salt = SaltString::generate(&mut OsRng);
    hasher().hash_password(password.as_bytes(), &salt).ok().map(|h| h.to_string())
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// Checked against when the name does not exist, so that takes as long as a wrong
/// password. Made the first time it is needed, on the blocking thread that needs it.
fn decoy_hash() -> &'static str {
    static DECOY: OnceLock<String> = OnceLock::new();
    DECOY.get_or_init(|| hash_password("not a password").unwrap_or_default())
}

static HASHING: Semaphore = Semaphore::const_new(HASH_SLOTS);

/// Hashing blocks a thread for tens of milliseconds. Never on the async runtime,
/// and never more than HASH_SLOTS at a time. The slot travels into the blocking job
/// and is freed when the hash is done: a request future dropped mid-wait cannot stop
/// the job, so freeing the slot with the future would let the next one start a fifth.
async fn hash_blocking(password: String) -> Result<String, ApiError> {
    let slot = HASHING.acquire().await.ok();
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        hash_password(&password)
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not hash"))
}

/// `None` is a name with no account: the decoy is checked instead, so the answer
/// takes as long as a wrong password, and is false.
async fn verify_blocking(password: String, hash: Option<String>) -> bool {
    let slot = HASHING.acquire().await.ok();
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        match hash {
            Some(hash) => verify_password(&password, &hash),
            None => {
                let _ = verify_password(&password, decoy_hash());
                false
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// The same string from a phone and a laptop: compatibility normalisation.
fn normalize(raw: &str) -> String {
    raw.nfkc().collect()
}

/// Normalised, then 8 to 128 characters, anything in them. One rule for a new
/// password and for a typed one, measured the same way, or what signup takes
/// could never log in (`e` + combining acute is two chars raw, one after nfkc).
fn clean_password(raw: &str) -> Option<String> {
    let password = normalize(raw);
    (MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&password.chars().count()).then_some(password)
}

/// For a new password: the rule above, with the reason as a 400.
fn clean_new_password(raw: &str) -> Result<String, ApiError> {
    clean_password(raw).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "password: 8 to 128 characters"))
}

// ---- login tokens and the cookie ----------------------------------------------

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What the database keeps. The token itself only ever lives in the browser.
fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub(crate) fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|kv| kv.trim().strip_prefix("login="))
        .find(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned)
}

/// Httponly: scripts never see it. Secure: https only (browsers allow it on localhost too).
/// Lax: a form on another site cannot post with it. No Domain: it sticks to this host.
fn set_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Path=/; Max-Age={}; HttpOnly; Secure; SameSite=Lax", LOGIN_DAYS * 86400)
}

fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax")
}

/// A new login row, pointing at the account's id. The account's expired rows go at
/// the same time: nothing else ever sweeps them. Live ones stay; a phone and a laptop
/// are both you. The `name` column is still written while it exists (docs/ids.md): the
/// previous image reads it, and a rename cascades into it.
async fn open_login(db: &PgPool, account: &Account) -> Result<String, sqlx::Error> {
    let token = new_token();
    sqlx::query(
        "WITH swept AS (DELETE FROM logins WHERE user_id = $2 AND expires_at < now())
         INSERT INTO logins (token_hash, user_id, name, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    )
    .bind(token_hash(&token))
    .bind(account.id)
    .bind(&account.name)
    .bind(LOGIN_DAYS as i32)
    .execute(db)
    .await?;
    Ok(token)
}

// ---- who is this ----------------------------------------------------------------

/// An account: the row id that never changes, and the name it has right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Account {
    pub(crate) id: Uuid,
    pub(crate) name: String,
}

type AccountRow = (Uuid, String);

fn account(row: Option<AccountRow>) -> Option<Account> {
    row.map(|(id, name)| Account { id, name })
}

/// The account behind the cookie, if the login is real and not expired. A read; the
/// row's last_seen moves at most once an hour (the cte, in the same round trip),
/// so a logged-in page does not turn every request into a write.
pub(crate) async fn whoami(db: &PgPool, headers: &HeaderMap) -> Result<Option<Account>, sqlx::Error> {
    let Some(token) = cookie_token(headers) else { return Ok(None) };
    let row: Option<AccountRow> = sqlx::query_as(
        "WITH seen AS (
            UPDATE logins SET last_seen = now()
            WHERE token_hash = $1 AND expires_at > now() AND last_seen < now() - interval '1 hour'
         )
         SELECT s.id, s.name FROM logins l JOIN streamers s ON s.id = l.user_id
         WHERE l.token_hash = $1 AND l.expires_at > now()",
    )
    .bind(token_hash(&token))
    .fetch_optional(db)
    .await?;
    Ok(account(row))
}

/// whoami that never writes. For the error reports: a sick main database must
/// not make a report wait, and a report is not a visit.
pub(crate) async fn whoami_readonly(db: &PgPool, headers: &HeaderMap) -> Result<Option<Account>, sqlx::Error> {
    let Some(token) = cookie_token(headers) else { return Ok(None) };
    let row: Option<AccountRow> = sqlx::query_as(
        "SELECT s.id, s.name FROM logins l JOIN streamers s ON s.id = l.user_id
         WHERE l.token_hash = $1 AND l.expires_at > now()",
    )
    .bind(token_hash(&token))
    .fetch_optional(db)
    .await?;
    Ok(account(row))
}

/// Is `name` held for an account that renamed away from it (and not for `except`, when
/// given: an account may take its own old name back). A hold is a claim in waiting: a
/// signup or a rename onto it gets `name taken`, the same words as for an account's name.
pub(crate) async fn is_held(db: &PgPool, name: &str, except: Option<Uuid>) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM held_names WHERE name = $1 AND until > now() AND ($2::uuid IS NULL OR user_id <> $2))",
    )
    .bind(name)
    .bind(except)
    .fetch_one(db)
    .await
}

/// The name a held name became, while the hold lasts: `/watch/<old>` leads there.
pub(crate) async fn renamed_to(db: &PgPool, name: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT s.name FROM held_names h JOIN streamers s ON s.id = h.user_id WHERE h.name = $1 AND h.until > now()",
    )
    .bind(name)
    .fetch_optional(db)
    .await
}

/// Is this name somebody's: it has an account, or an account renamed away from it and the
/// hold is still on (`is_held`; a claim in waiting). The one answer for the write gates and
/// both socket hellos, in one statement, so nobody can go live as, write or wear a held
/// name while `/watch/<name>` leads to the account that left it (docs/ids.md).
pub(crate) async fn is_claimed(db: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM streamers WHERE name = $1 AND password_hash IS NOT NULL)
             OR EXISTS (SELECT 1 FROM held_names WHERE name = $1 AND until > now())",
    )
    .bind(name)
    .fetch_one(db)
    .await
}

/// The refusals for a name that is somebody's, the http one and the sockets' one. The word
/// `account` is the wire contract: the pages recognise a refused nick by regex on this text
/// (`/nick|account|fake/` in frontend/src/infra/events.worker.ts and events.ts,
/// `/nick|account/` in frontend/src/infra/atoms/chat-atoms.ts) and only then stop re-sending
/// it; docs/status.md, chat.md, accounts.md, spec.md and test/auth.js, presence.js quote it.
/// A held name is held for an account, so the words hold for it too. Change them together
/// with all of those, or not at all.
pub(crate) const NAME_HAS_ACCOUNT: &str = "that name has an account. log in as it";
pub(crate) const NICK_HAS_ACCOUNT: &str = "that name has an account. log in as it, or pick another";

/// The one rule the rest of the api asks: may whoever holds `me` act as `name`?
/// A free name: anyone. A claimed name: only its own login. A held name: nobody, not even
/// the account that left it (its login is under the new name; it renames back instead).
pub(crate) async fn may_act_as(db: &PgPool, name: &str, me: Option<&str>) -> Result<(), ApiError> {
    if me == Some(name) || !is_claimed(db, name).await? {
        return Ok(());
    }
    Err(ApiError::new(StatusCode::FORBIDDEN, NAME_HAS_ACCOUNT))
}

/// Who the cookie says this is. `None` for everyone without a (valid) login.
pub(crate) struct Me(pub(crate) Option<Account>);

impl Me {
    /// The login's name, the one thing most of the api compares against (a stream name, a room).
    pub(crate) fn name(&self) -> Option<&str> {
        self.0.as_ref().map(|a| a.name.as_str())
    }
}

impl<S> FromRequestParts<S> for Me
where
    S: Send + Sync,
    PgPool: FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Ok(Me(whoami(&PgPool::from_ref(state), &parts.headers).await?))
    }
}

// ---- rate limits ------------------------------------------------------------------

/// One more in redis, window from the first. Returns the count. One atomic round
/// trip: INCR and EXPIRE NX (a ttl only when the key has none, redis 7) together,
/// so a crash between them can never leave a counter that never expires.
pub(crate) async fn bump(s: &AppState, key: &str, window_secs: i64) -> Result<i64, ApiError> {
    let (n,): (i64,) = redis::pipe()
        .atomic()
        .incr(key, 1)
        .cmd("EXPIRE").arg(key).arg(window_secs).arg("NX").ignore()
        .query_async(&mut s.redis.clone())
        .await?;
    Ok(n)
}

/// Caddy sets X-Forwarded-For and nothing else reaches this port, so it is trusted.
pub(crate) fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|ip| ip.trim().to_owned())
        .filter(|ip| !ip.is_empty())
        .unwrap_or_else(|| "?".to_owned())
}

// ---- routes --------------------------------------------------------------------------

#[derive(Deserialize)]
struct Credentials {
    name: String,
    password: String,
}

#[derive(Deserialize)]
struct PasswordChange {
    old: String,
    new: String,
}

#[derive(Deserialize)]
struct NameChange {
    name: String,
    password: String,
}

/// One answer for a wrong name and a wrong password, so a guess learns nothing about
/// which it was. Not a secret that the name exists: GET /api/streamers/<name> says so.
fn wrong() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "wrong name or password")
}

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn too_many() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many tries. wait 15 minutes")
}

/// Another account's, or held for one. One answer for both: a hold is a claim in waiting.
fn name_taken() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "name taken")
}

fn wrong_password() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "wrong password")
}

/// The counter a guess at this name's password from this ip lands on: login and
/// a password change share it.
fn login_key(ip: &str, name: &str) -> String {
    format!("rl:login:name:{ip}:{name}")
}

/// Did the browser send this from one of our own pages? Browsers put Sec-Fetch-Site
/// on every request; a form on another site says `cross-site`. Nothing without the
/// header (curl, the tests, old browsers) is held back by it.
fn from_here(headers: &HeaderMap) -> bool {
    match headers.get("sec-fetch-site") {
        None => true,
        Some(site) => matches!(site.to_str(), Ok("same-origin" | "none")),
    }
}

fn with_cookie(status: StatusCode, cookie: String, body: Value) -> Response {
    (status, [(header::SET_COOKIE, cookie)], Json(body)).into_response()
}

async fn signup(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<Credentials>, JsonRejection>) -> Result<Response, ApiError> {
    let Json(body) = body?;
    let name = body.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError::bad_name());
    }
    if name.starts_with(&s.dummy_prefix) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
    }
    let password = clean_new_password(&body.password)?;
    if bump(&s, &format!("rl:signup:ip:{}", client_ip(&headers)), SIGNUP_WINDOW_SECS).await? > SIGNUP_PER_IP {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many signups from here. try later"));
    }
    // a name somebody renamed away from is theirs for a while yet (docs/ids.md)
    if is_held(&s.db, &name, None).await? {
        return Err(name_taken());
    }
    let hash = hash_blocking(password).await?;
    // A row with no hash is a name someone used without an account. The first
    // signup claims it, bio and all (the row keeps its id). A row with a hash is somebody's.
    let claimed: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
         WHERE streamers.password_hash IS NULL
         RETURNING id",
    )
    .bind(&name)
    .bind(&hash)
    .fetch_optional(&s.db)
    .await?;
    let Some(id) = claimed else {
        return Err(name_taken());
    };
    let me = Account { id, name };
    let token = open_login(&s.db, &me).await?;
    log::info!("{}: signed up", me.name);
    Ok(with_cookie(StatusCode::CREATED, set_cookie(&token), json!({ "id": me.id, "name": me.name })))
}

async fn login(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<Credentials>, JsonRejection>) -> Result<Response, ApiError> {
    let Json(body) = body?;
    let name = body.name.trim().to_lowercase();
    // a name or a password no account can have is wrong at once: nothing to verify, nothing to count
    if !valid_name(&name) {
        return Err(wrong());
    }
    let Some(password) = clean_password(&body.password) else { return Err(wrong()) };
    let ip = client_ip(&headers);
    let name_key = login_key(&ip, &name);
    let ip_key = format!("rl:login:ip:{ip}");
    // counted before the verify, not after: a parallel burst would otherwise all read
    // zero, all run argon2, and all get through. INCR is atomic, so each try gets its own
    // number and exactly the first LOGIN_PER_NAME of them are checked.
    let tries = bump(&s, &name_key, LOGIN_WINDOW_SECS).await?;
    let from_ip = bump(&s, &ip_key, LOGIN_WINDOW_SECS).await?;
    if tries > LOGIN_PER_NAME || from_ip > LOGIN_PER_IP {
        return Err(too_many());
    }
    let stored: Option<(Uuid, Option<String>)> = sqlx::query_as("SELECT id, password_hash FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    let (id, hash) = match stored {
        Some((id, hash)) => (Some(id), hash),
        None => (None, None),
    };
    if !verify_blocking(password, hash).await {
        return Err(wrong());
    }
    // a verified password means the row was there
    let Some(id) = id else { return Err(wrong()) };
    let _: () = s.redis.clone().del(&name_key).await?;
    let me = Account { id, name };
    let token = open_login(&s.db, &me).await?;
    log::info!("{}: logged in", me.name);
    Ok(with_cookie(StatusCode::OK, set_cookie(&token), json!({ "id": me.id, "name": me.name })))
}

async fn logout(State(s): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    // the one route that acts without the cookie (it clears it), so SameSite does not
    // cover it: a form on another site could log you out. the browser says where it came from
    if !from_here(&headers) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not from this site"));
    }
    if let Some(token) = cookie_token(&headers) {
        sqlx::query("DELETE FROM logins WHERE token_hash = $1")
            .bind(token_hash(&token))
            .execute(&s.db)
            .await?;
    }
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear_cookie())]).into_response())
}

async fn logout_all(State(s): State<AppState>, Me(me): Me) -> Result<Response, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    sqlx::query("DELETE FROM logins WHERE user_id = $1")
        .bind(me.id)
        .execute(&s.db)
        .await?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear_cookie())]).into_response())
}

/// `{ id, name, renamed_at }`; every field null for nobody. The one place a person can read
/// their own id; no page needs it. `renamed_at` is when the name last changed, for the
/// profile tab to say when it may change again.
async fn me(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let Some(me) = me else {
        return Ok(Json(json!({ "id": null, "name": null, "renamed_at": null })));
    };
    let renamed_at: Option<Option<DateTime<Utc>>> = sqlx::query_scalar("SELECT renamed_at FROM streamers WHERE id = $1")
        .bind(me.id)
        .fetch_optional(&s.db)
        .await?;
    Ok(Json(json!({ "id": me.id, "name": me.name, "renamed_at": renamed_at.flatten() })))
}

/// The login's own password, counted on the login limiter first: a stolen cookie is not
/// unlimited guesses. The counter clears on a right one. `None` when the account is gone.
async fn check_password(s: &AppState, headers: &HeaderMap, me: &Account, raw: &str) -> Result<(), ApiError> {
    let Some(password) = clean_password(raw) else { return Err(wrong_password()) };
    let key = login_key(&client_ip(headers), &me.name);
    if bump(s, &key, LOGIN_WINDOW_SECS).await? > LOGIN_PER_NAME {
        return Err(too_many());
    }
    let stored: Option<Option<String>> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE id = $1")
        .bind(me.id)
        .fetch_optional(&s.db)
        .await?;
    let Some(hash) = stored.flatten() else { return Err(not_logged_in()) };
    if !verify_blocking(password, Some(hash)).await {
        return Err(wrong_password());
    }
    let _: () = s.redis.clone().del(&key).await?;
    Ok(())
}

async fn change_password(
    State(s): State<AppState>,
    headers: HeaderMap,
    Me(me): Me,
    body: Result<Json<PasswordChange>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let new = clean_new_password(&body.new)?;
    check_password(&s, &headers, &me, &body.old).await?;
    let hash = hash_blocking(new).await?;
    // every other login is out, this one stays: in the one statement with the new hash,
    // so a failure between the two cannot leave the password changed and the others in
    let keep = cookie_token(&headers).map(|t| token_hash(&t)).unwrap_or_default();
    sqlx::query(
        "WITH changed AS (UPDATE streamers SET password_hash = $2 WHERE id = $1)
         DELETE FROM logins WHERE user_id = $1 AND token_hash <> $3",
    )
    .bind(me.id)
    .bind(&hash)
    .bind(&keep)
    .execute(&s.db)
    .await?;
    log::info!("{}: password changed", me.name);
    Ok(StatusCode::NO_CONTENT)
}

/// Takes the free row (no account) under `new` for `me`, who is about to be renamed onto it:
/// its followers move to `me` (they followed the name, docs/follows.md), then its thumbs and
/// the row go. Returns its picture keys in the bucket, to drop after the commit. `name taken`
/// when the row is not free any more: a signup claimed it between the check and here, and the
/// caller's early return rolls the transaction back.
pub(crate) async fn take_free_row(conn: &mut PgConnection, free: Uuid, me: Uuid, new: &str) -> Result<Vec<String>, ApiError> {
    let thumbs: Vec<i64> = sqlx::query_scalar("SELECT id FROM stream_thumbs WHERE name = $1").bind(new).fetch_all(&mut *conn).await?;
    let assets: Vec<(i64, String)> = sqlx::query_as("SELECT id, mime FROM stream_assets WHERE name = $1").bind(new).fetch_all(&mut *conn).await?;
    let orphaned = profile::picture_keys(free, &thumbs, &assets);
    sqlx::query("DELETE FROM stream_thumbs WHERE name = $1").bind(new).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM stream_assets WHERE name = $1").bind(new).execute(&mut *conn).await?;
    // the name's followers are mine now, from when they followed. not my own edge to it (no
    // self edges), and one who follows me already keeps the one edge
    sqlx::query(
        "INSERT INTO follows (follower_id, followed_id, followed_at)
         SELECT follower_id, $2, followed_at FROM follows WHERE followed_id = $1 AND follower_id <> $2
         ON CONFLICT DO NOTHING",
    )
    .bind(free)
    .bind(me)
    .execute(&mut *conn)
    .await?;
    // only while it is still free: a signup that claimed it since the check keeps the row
    let gone = sqlx::query("DELETE FROM streamers WHERE id = $1 AND password_hash IS NULL").bind(free).execute(&mut *conn).await?;
    if gone.rows_affected() == 0 {
        return Err(name_taken());
    }
    Ok(orphaned)
}

/// `POST /api/name` `{ name, password }`: the login's name changes; its logins, groups and
/// pictures stay, because they point at the id. Once in RENAME_DAYS, with the password (a
/// stolen cookie must not walk off with the name), never while live (the stream's url, key
/// and room are the name). The old name is held HOLD_DAYS for this account. See docs/ids.md.
async fn change_name(
    State(s): State<AppState>,
    headers: HeaderMap,
    Me(me): Me,
    body: Result<Json<NameChange>, JsonRejection>,
) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let new = body.name.trim().to_lowercase();
    if !valid_name(&new) {
        return Err(ApiError::bad_name());
    }
    if new.starts_with(&s.dummy_prefix) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
    }
    if new == me.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that is your name"));
    }
    check_password(&s, &headers, &me, &body.password).await?;
    let last: Option<Option<DateTime<Utc>>> = sqlx::query_scalar("SELECT renamed_at FROM streamers WHERE id = $1")
        .bind(me.id)
        .fetch_optional(&s.db)
        .await?;
    if let Some(at) = last.flatten() {
        let again = at + chrono::Duration::days(RENAME_DAYS);
        if again > Utc::now() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                format!("you changed your name on {}. again from {}", at.format("%Y-%m-%d"), again.format("%Y-%m-%d")),
            ));
        }
    }
    // the stream's url, its live key and its chat room are the name: it ends first. the key
    // too, not only video's word: a go-live whose page has not reached video yet holds it
    let keyed: bool = s.redis.clone().exists(live_key(&me.name)).await?;
    if keyed || is_live(&s, &me.name).await? {
        return Err(ApiError::new(StatusCode::CONFLICT, "stop the stream first"));
    }
    // pictures saved before ids sit at the name's keys. at the id's now, so nothing in
    // the bucket says the name when it changes (profile.rs does the same lazily on read)
    profile::lift_pictures(&s, me.id, &me.name).await;

    let mut tx = s.db.begin().await?;
    sqlx::query("DELETE FROM held_names WHERE until < now()").execute(&mut *tx).await?;
    // another account's name, or held for another account: the same answer for both
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM streamers WHERE name = $1 AND password_hash IS NOT NULL)
             OR EXISTS (SELECT 1 FROM held_names WHERE name = $1 AND user_id <> $2)",
    )
    .bind(&new)
    .bind(me.id)
    .fetch_one(&mut *tx)
    .await?;
    if taken {
        return Err(name_taken());
    }
    // a free row under the new name: its bio and picture were anyone's, and yours arrive
    // with you; its followers come along. the row goes, and its pictures in the bucket after the commit
    let free: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(&new).fetch_optional(&mut *tx).await?;
    let orphaned = match free {
        Some(free) => take_free_row(&mut tx, free, me.id, &new).await?,
        None => Vec::new(),
    };
    // the one statement the id is for. logins.name, memberships.name and groups.created_by
    // follow by ON UPDATE CASCADE while those columns live; stream_thumbs has no key and is told
    let renamed_at: DateTime<Utc> = match sqlx::query_scalar("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1 RETURNING renamed_at")
        .bind(me.id)
        .bind(&new)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(at) => at,
        // a signup or another rename took the name between the check and here
        Err(e) if unique_violation(&e) => return Err(name_taken()),
        Err(e) => return Err(e.into()),
    };
    sqlx::query("UPDATE stream_thumbs SET name = $2 WHERE name = $1").bind(&me.name).bind(&new).execute(&mut *tx).await?;
    sqlx::query("UPDATE stream_assets SET name = $2 WHERE name = $1").bind(&me.name).bind(&new).execute(&mut *tx).await?;
    // going back to a name of mine ends its hold; the name I leave is held from now
    sqlx::query("DELETE FROM held_names WHERE name = $1 AND user_id = $2").bind(&new).bind(me.id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + make_interval(days => $3))
         ON CONFLICT (name) DO UPDATE SET user_id = EXCLUDED.user_id, until = EXCLUDED.until",
    )
    .bind(&me.name)
    .bind(me.id)
    .bind(HOLD_DAYS as i32)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    profile::drop_pictures(&s, &orphaned).await;
    // the fact, for the gateway: its sockets of the old name are the new name now, and every
    // tab and device of mine, and every page on /watch/<old>, is told (docs/ids.md)
    presence::publish_renamed(&mut s.redis.clone(), &me.name, &new).await;
    log::info!("{}: renamed to {new}", me.name);
    Ok(Json(json!({ "id": me.id, "name": new, "renamed_at": renamed_at })))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/signup", post(signup))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/logout-all", post(logout_all))
        .route("/api/me", get(me))
        .route("/api/password", post(change_password))
        .route("/api/name", post(change_name))
}

// ---- `api passwd <name>` ---------------------------------------------------------------

/// A new random password for a name, printed once. The reset, since there is no
/// email. Works on a name with no account too: it becomes one.
pub(crate) async fn passwd(db: &PgPool, name: &str) -> anyhow::Result<()> {
    let name = name.trim().to_lowercase();
    anyhow::ensure!(valid_name(&name), "bad name. use a-z 0-9 _ - (1 to 32)");
    // the same rule as signup: a reserved name stays with the dummy box, an account on it would claim it
    let prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    anyhow::ensure!(!name.starts_with(&prefix), "reserved name: {prefix}* belongs to the fake streams");
    // a name somebody renamed away from is still theirs: an account on it now would be a stranger's claim
    anyhow::ensure!(!is_held(db, &name, None).await?, "{name} is held for the account that renamed away from it. wait for the hold to end, or use their new name");
    let password = random_password();
    let hash = hash_password(&password).ok_or_else(|| anyhow::anyhow!("could not hash"))?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id",
    )
    .bind(&name)
    .bind(&hash)
    .fetch_one(db)
    .await?;
    sqlx::query("DELETE FROM logins WHERE user_id = $1").bind(id).execute(db).await?;
    println!("{name}: the new password is  {password}");
    println!("every login of {name} is out. this is the only time it is shown.");
    Ok(())
}

/// 16 symbols from a 32-letter alphabet (no 0 o 1 l): 80 bits.
fn random_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| ALPHABET[(*b % 32) as usize] as char).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The pages stop re-sending a refused nick only when the error matches `/nick|account|fake/`
    /// (events.worker.ts, events.ts) or `/nick|account/` (chat-atoms.ts); without the word a
    /// guest with a claimed nick reconnects every 3 s for ever. test/auth.js and presence.js match `/account/`.
    #[test]
    fn the_refusals_carry_the_word_the_pages_match_on() {
        assert!(NAME_HAS_ACCOUNT.contains("account"));
        assert!(NICK_HAS_ACCOUNT.contains("account"));
    }

    /// A throwaway postgres, migrated. For example
    /// `docker run -d --name test-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t -p 55434:5432 postgres:17-alpine`
    /// and `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t`. follows.rs's tests use it too.
    pub(crate) async fn test_db() -> PgPool {
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL: the postgres to run this against");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await.expect("connect");
        crate::migrate::run(&pool).await.expect("migrate");
        pool
    }

    /// A row with a hash is an account; without one, a name somebody used (a follow, a bio).
    pub(crate) async fn row(pool: &PgPool, name: &str, hash: Option<&str>) -> Uuid {
        sqlx::query_scalar("INSERT INTO streamers (name, password_hash) VALUES ($1, $2) RETURNING id")
            .bind(name)
            .bind(hash)
            .fetch_one(pool)
            .await
            .expect("a row")
    }

    async fn edge(pool: &PgPool, follower: Uuid, followed: Uuid, at: DateTime<Utc>) {
        sqlx::query("INSERT INTO follows (follower_id, followed_id, followed_at) VALUES ($1, $2, $3)")
            .bind(follower)
            .bind(followed)
            .bind(at)
            .execute(pool)
            .await
            .expect("an edge");
    }

    pub(crate) async fn edges_of(pool: &PgPool, follower: Uuid) -> Vec<(Uuid, DateTime<Utc>)> {
        sqlx::query_as("SELECT followed_id, followed_at FROM follows WHERE follower_id = $1")
            .bind(follower)
            .fetch_all(pool)
            .await
            .expect("edges")
    }

    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored keeps_its_followers` against a throwaway postgres (see `test_db`).
    #[tokio::test]
    #[ignore]
    async fn taking_a_free_name_keeps_its_followers() {
        let pool = test_db().await;
        let run = std::process::id();
        let alice = row(&pool, &format!("alice-{run}"), Some("alice-hash")).await;
        let fan = row(&pool, &format!("fan-{run}"), Some("fan-hash")).await;
        let both = row(&pool, &format!("both-{run}"), Some("both-hash")).await;
        let name = format!("nova-{run}");
        let nova = row(&pool, &name, None).await;
        let then: DateTime<Utc> = "2024-01-02T03:04:05Z".parse().unwrap();
        let later: DateTime<Utc> = "2024-06-07T08:09:10Z".parse().unwrap();
        // fan follows the free name; both follows it and alice; alice follows it herself
        edge(&pool, fan, nova, then).await;
        edge(&pool, both, nova, later).await;
        edge(&pool, both, alice, then).await;
        edge(&pool, alice, nova, then).await;

        // what change_name does: take the row, then rename onto the name
        let mut tx = pool.begin().await.unwrap();
        let orphaned = take_free_row(&mut tx, nova, alice, &name).await.expect("the free row is taken");
        sqlx::query("UPDATE streamers SET name = $2 WHERE id = $1").bind(alice).bind(&name).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();

        assert_eq!(orphaned, profile::picture_keys(nova, &[], &[]));
        // fan's one edge points at alice now, from when it was made
        assert_eq!(edges_of(&pool, fan).await, vec![(alice, then)]);
        // one edge for somebody who followed alice already, the one they had
        assert_eq!(edges_of(&pool, both).await, vec![(alice, then)]);
        // alice's own edge to the free name is gone, not a self edge
        assert_eq!(edges_of(&pool, alice).await, vec![]);
        assert_eq!(
            crate::follows::stats(&pool, &name, Some(fan)).await.unwrap(),
            crate::follows::Stats { followers: 2, following: true, follows_you: false }
        );
    }

    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored claimed_meanwhile` against a throwaway postgres (see `test_db`).
    #[tokio::test]
    #[ignore]
    async fn a_free_name_claimed_meanwhile_is_taken_not_deleted() {
        let pool = test_db().await;
        let run = std::process::id();
        let bob = row(&pool, &format!("bob-{run}"), Some("bob-hash")).await;
        let name = format!("nova2-{run}");
        let nova = row(&pool, &name, None).await;
        // bob's rename has read the free row's id; a signup claims the row before it is deleted
        let claimed: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
             WHERE streamers.password_hash IS NULL
             RETURNING id",
        )
        .bind(&name)
        .bind("carol-hash")
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(claimed, Some(nova));

        let mut tx = pool.begin().await.unwrap();
        let err = take_free_row(&mut tx, nova, bob, &name).await.expect_err("the row is somebody's now");
        assert_eq!(err.into_response().status(), StatusCode::CONFLICT);
        tx.rollback().await.unwrap();

        let hash: Option<String> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE id = $1").bind(nova).fetch_one(&pool).await.unwrap();
        assert_eq!(hash.as_deref(), Some("carol-hash"));
    }

    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored held_name_is_somebodys` against a throwaway postgres (see `test_db`).
    #[tokio::test]
    #[ignore]
    async fn a_held_name_is_somebodys_while_the_hold_lasts() {
        let pool = test_db().await;
        let run = std::process::id();
        let nova_name = format!("nova3-{run}");
        let nova = row(&pool, &nova_name, Some("nova-hash")).await;
        let alice = format!("alice3-{run}");
        // what change_name leaves behind: nova renamed away from alice, and alice is held for her
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&alice)
            .bind(nova)
            .execute(&pool)
            .await
            .unwrap();

        assert!(is_claimed(&pool, &alice).await.unwrap(), "a held name is somebody's");
        assert!(is_claimed(&pool, &nova_name).await.unwrap(), "an account's name is somebody's");
        assert!(!is_claimed(&pool, &format!("nobody3-{run}")).await.unwrap(), "a name nobody used is free");
        // nobody acts as the held name: not a guest, and not the account it is held for (it renames back)
        let guest = may_act_as(&pool, &alice, None).await.expect_err("a guest is refused");
        assert_eq!(guest.into_response().status(), StatusCode::FORBIDDEN);
        let holder = may_act_as(&pool, &alice, Some(&nova_name)).await.expect_err("the account that left it is refused");
        assert_eq!(holder.into_response().status(), StatusCode::FORBIDDEN);

        // the hold runs out: the name is anyone's again
        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&alice).execute(&pool).await.unwrap();
        assert!(!is_claimed(&pool, &alice).await.unwrap(), "a lapsed hold holds nothing");
        may_act_as(&pool, &alice, None).await.expect("free again");
    }
}
