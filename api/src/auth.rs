//! Accounts: username + password. See docs/accounts.md.
//!
//! The password is hashed with argon2id and forgotten. A login is 32 random
//! bytes in an httponly cookie; the database keeps their sha256. Nobody has to
//! log in: a name without an account is free for anyone, like before. A name
//! with one (a "claimed" name) can only go live, save a bio or talk in chat
//! when the cookie says it is them.

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
use rand::rngs::OsRng;
use rand::RngCore;
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::sync::Semaphore;
use unicode_normalization::UnicodeNormalization;

use crate::{valid_name, ApiError, ApiResult, AppState};

const COOKIE: &str = "login";
const LOGIN_DAYS: i64 = 30;
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
/// and never more than HASH_SLOTS at a time.
async fn hash_blocking(password: String) -> Result<String, ApiError> {
    let _slot = HASHING.acquire().await.ok();
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not hash"))
}

/// `None` is a name with no account: the decoy is checked instead, so the answer
/// takes as long as a wrong password, and is false.
async fn verify_blocking(password: String, hash: Option<String>) -> bool {
    let _slot = HASHING.acquire().await.ok();
    tokio::task::spawn_blocking(move || match hash {
        Some(hash) => verify_password(&password, &hash),
        None => {
            let _ = verify_password(&password, decoy_hash());
            false
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

fn cookie_token(headers: &HeaderMap) -> Option<String> {
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

/// A new login row. The name's expired rows go at the same time: nothing else
/// ever sweeps them. Live ones stay; a phone and a laptop are both you.
async fn open_login(db: &PgPool, name: &str) -> Result<String, sqlx::Error> {
    let token = new_token();
    sqlx::query(
        "WITH swept AS (DELETE FROM logins WHERE name = $2 AND expires_at < now())
         INSERT INTO logins (token_hash, name, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    )
    .bind(token_hash(&token))
    .bind(name)
    .bind(LOGIN_DAYS as i32)
    .execute(db)
    .await?;
    Ok(token)
}

// ---- who is this ----------------------------------------------------------------

/// The name behind the cookie, if the login is real and not expired. A read; the
/// row's last_seen moves at most once an hour (the cte, in the same round trip),
/// so a logged-in page does not turn every request into a write.
pub(crate) async fn whoami(db: &PgPool, headers: &HeaderMap) -> Result<Option<String>, sqlx::Error> {
    let Some(token) = cookie_token(headers) else { return Ok(None) };
    sqlx::query_scalar(
        "WITH seen AS (
            UPDATE logins SET last_seen = now()
            WHERE token_hash = $1 AND expires_at > now() AND last_seen < now() - interval '1 hour'
         )
         SELECT name FROM logins WHERE token_hash = $1 AND expires_at > now()",
    )
    .bind(token_hash(&token))
    .fetch_optional(db)
    .await
}

/// whoami that never writes. For the error reports: a sick main database must
/// not make a report wait, and a report is not a visit.
pub(crate) async fn whoami_readonly(db: &PgPool, headers: &HeaderMap) -> Result<Option<String>, sqlx::Error> {
    let Some(token) = cookie_token(headers) else { return Ok(None) };
    sqlx::query_scalar("SELECT name FROM logins WHERE token_hash = $1 AND expires_at > now()")
        .bind(token_hash(&token))
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
pub(crate) struct Me(pub(crate) Option<String>);

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
    let hash = hash_blocking(password).await?;
    // A row with no hash is a name someone used without an account. The first
    // signup claims it, bio and all. A row with a hash is somebody's.
    let claimed: Option<String> = sqlx::query_scalar(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
         WHERE streamers.password_hash IS NULL
         RETURNING name",
    )
    .bind(&name)
    .bind(&hash)
    .fetch_optional(&s.db)
    .await?;
    if claimed.is_none() {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    let token = open_login(&s.db, &name).await?;
    log::info!("{name}: signed up");
    Ok(with_cookie(StatusCode::CREATED, set_cookie(&token), json!({ "name": name })))
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
    let stored: Option<Option<String>> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    if !verify_blocking(password, stored.flatten()).await {
        return Err(wrong());
    }
    let _: () = s.redis.clone().del(&name_key).await?;
    let token = open_login(&s.db, &name).await?;
    log::info!("{name}: logged in");
    Ok(with_cookie(StatusCode::OK, set_cookie(&token), json!({ "name": name })))
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
    let name = me.ok_or_else(not_logged_in)?;
    sqlx::query("DELETE FROM logins WHERE name = $1")
        .bind(&name)
        .execute(&s.db)
        .await?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear_cookie())]).into_response())
}

async fn me(Me(me): Me) -> ApiResult {
    Ok(Json(json!({ "name": me })))
}

async fn change_password(
    State(s): State<AppState>,
    headers: HeaderMap,
    Me(me): Me,
    body: Result<Json<PasswordChange>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let name = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let new = clean_new_password(&body.new)?;
    let wrong_password = || ApiError::new(StatusCode::FORBIDDEN, "wrong password");
    let Some(old) = clean_password(&body.old) else { return Err(wrong_password()) };
    // `old` is a guess at this name's password like any at login: the same counter,
    // counted first, so a stolen cookie is not unlimited tries
    let key = login_key(&client_ip(&headers), &name);
    if bump(&s, &key, LOGIN_WINDOW_SECS).await? > LOGIN_PER_NAME {
        return Err(too_many());
    }
    let stored: Option<Option<String>> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    let Some(hash) = stored.flatten() else { return Err(not_logged_in()) };
    if !verify_blocking(old, Some(hash)).await {
        return Err(wrong_password());
    }
    let _: () = s.redis.clone().del(&key).await?;
    let hash = hash_blocking(new).await?;
    sqlx::query("UPDATE streamers SET password_hash = $2 WHERE name = $1")
        .bind(&name)
        .bind(&hash)
        .execute(&s.db)
        .await?;
    // every other login is out. this one stays.
    let keep = cookie_token(&headers).map(|t| token_hash(&t)).unwrap_or_default();
    sqlx::query("DELETE FROM logins WHERE name = $1 AND token_hash <> $2")
        .bind(&name)
        .bind(&keep)
        .execute(&s.db)
        .await?;
    log::info!("{name}: password changed");
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/signup", post(signup))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/logout-all", post(logout_all))
        .route("/api/me", get(me))
        .route("/api/password", post(change_password))
}

// ---- `api passwd <name>` ---------------------------------------------------------------

/// A new random password for a name, printed once. The reset, since there is no
/// email. Works on a name with no account too: it becomes one.
pub(crate) async fn passwd(db: &PgPool, name: &str) -> anyhow::Result<()> {
    let name = name.trim().to_lowercase();
    anyhow::ensure!(valid_name(&name), "bad name. use a-z 0-9 _ - (1 to 32)");
    let password = random_password();
    let hash = hash_password(&password).ok_or_else(|| anyhow::anyhow!("could not hash"))?;
    sqlx::query(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash",
    )
    .bind(&name)
    .bind(&hash)
    .execute(db)
    .await?;
    sqlx::query("DELETE FROM logins WHERE name = $1").bind(&name).execute(db).await?;
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
