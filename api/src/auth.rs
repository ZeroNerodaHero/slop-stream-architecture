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
use sqlx::PgPool;
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

/// Does this name have an account.
pub(crate) async fn is_claimed(db: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    let claimed: Option<bool> = sqlx::query_scalar("SELECT password_hash IS NOT NULL FROM streamers WHERE name = $1")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(claimed.unwrap_or(false))
}

/// The one rule the rest of the api asks: may whoever holds `me` act as `name`?
/// A free name: anyone. A claimed name: only its own login.
pub(crate) async fn may_act_as(db: &PgPool, name: &str, me: Option<&str>) -> Result<(), ApiError> {
    if me == Some(name) || !is_claimed(db, name).await? {
        return Ok(());
    }
    Err(ApiError::new(StatusCode::FORBIDDEN, "that name has an account. log in as it"))
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
    // with you. the row goes, and its pictures in the bucket after the commit
    let free: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(&new).fetch_optional(&mut *tx).await?;
    let mut orphaned = Vec::new();
    if let Some(free) = free {
        let thumbs: Vec<i64> = sqlx::query_scalar("SELECT id FROM stream_thumbs WHERE name = $1").bind(&new).fetch_all(&mut *tx).await?;
        orphaned = profile::picture_keys(free, &thumbs);
        sqlx::query("DELETE FROM stream_thumbs WHERE name = $1").bind(&new).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(free).execute(&mut *tx).await?;
    }
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
