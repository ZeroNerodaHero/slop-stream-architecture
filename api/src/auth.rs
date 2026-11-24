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
const RENAME_DAYS: i64 = 30;
const HOLD_DAYS: i64 = 30;
const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;
const LOGIN_PER_NAME: i64 = 10;
const LOGIN_PER_IP: i64 = 100;
const LOGIN_WINDOW_SECS: i64 = 15 * 60;
const SIGNUP_PER_IP: i64 = 20;
const SIGNUP_WINDOW_SECS: i64 = 3600;
const HASH_SLOTS: usize = 4;

const ARGON2_ALGORITHM: Algorithm = Algorithm::Argon2id;
const ARGON2_VERSION: Version = Version::V0x13;
const ARGON2_M_COST_KIB: u32 = 19_456;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

fn hasher() -> Argon2<'static> {
    let params = Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, None).expect("argon2 params");
    Argon2::new(ARGON2_ALGORITHM, ARGON2_VERSION, params)
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

fn needs_rehash(hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else { return false };
    let same_algorithm = Algorithm::try_from(parsed.algorithm).is_ok_and(|a| a == ARGON2_ALGORITHM);
    let same_version = parsed.version == Some(ARGON2_VERSION.into());
    let same_params = Params::try_from(&parsed).is_ok_and(|p| {
        p.m_cost() == ARGON2_M_COST_KIB && p.t_cost() == ARGON2_T_COST && p.p_cost() == ARGON2_P_COST
    });
    let same_len = parsed.hash.is_some_and(|h| h.len() == Params::DEFAULT_OUTPUT_LEN);
    !(same_algorithm && same_version && same_params && same_len)
}

pub(crate) const NO_PASSWORD: &str = "!no-password";

pub(crate) fn is_password(stored: &str) -> bool {
    stored != NO_PASSWORD
}

pub(crate) async fn has_password(db: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    let stored: Option<Option<String>> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE id = $1").bind(id).fetch_optional(db).await?;
    Ok(stored.flatten().as_deref().is_some_and(is_password))
}

fn decoy_hash() -> &'static str {
    static DECOY: OnceLock<String> = OnceLock::new();
    DECOY.get_or_init(|| hash_password("not a password").unwrap_or_default())
}

static HASHING: Semaphore = Semaphore::const_new(HASH_SLOTS);

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

#[derive(Debug)]
enum Verdict {
    Wrong,
    Right { upgraded: Option<String> },
}

async fn verify_blocking(password: String, hash: Option<String>) -> Verdict {
    let slot = HASHING.acquire().await.ok();
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        match hash {
            Some(hash) if verify_password(&password, &hash) => {
                Verdict::Right { upgraded: needs_rehash(&hash).then(|| hash_password(&password)).flatten() }
            }
            Some(_) => Verdict::Wrong,
            None => {
                let _ = verify_password(&password, decoy_hash());
                Verdict::Wrong
            }
        }
    })
    .await
    .unwrap_or(Verdict::Wrong)
}

async fn upgrade_hash(db: &PgPool, id: Uuid, old: &str, new: &str) {
    let result = sqlx::query("UPDATE streamers SET password_hash = $3 WHERE id = $1 AND password_hash = $2")
        .bind(id)
        .bind(old)
        .bind(new)
        .execute(db)
        .await;
    match result {
        Ok(done) if done.rows_affected() == 1 => log::info!("{id}: password hash moved to the current argon2 settings"),
        Ok(_) => {}
        Err(e) => log::warn!("{id}: could not store the rehashed password: {e}"),
    }
}

fn normalize(raw: &str) -> String {
    raw.nfkc().collect()
}

fn clean_password(raw: &str) -> Option<String> {
    let password = normalize(raw);
    (MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&password.chars().count()).then_some(password)
}

const NEW_PASSWORD_RULE: &str = "password: 8 to 128 characters, with at least one number and one symbol";

fn is_symbol(c: char) -> bool {
    !c.is_alphanumeric() && !c.is_whitespace()
}

fn clean_new_password(raw: &str) -> Result<String, ApiError> {
    let refused = || ApiError::new(StatusCode::BAD_REQUEST, NEW_PASSWORD_RULE);
    let password = clean_password(raw).ok_or_else(refused)?;
    let has_number = password.chars().any(char::is_numeric);
    let has_symbol = password.chars().any(is_symbol);
    if has_number && has_symbol {
        Ok(password)
    } else {
        Err(refused())
    }
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

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

pub(crate) fn set_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Path=/; Max-Age={}; HttpOnly; Secure; SameSite=Lax", LOGIN_DAYS * 86400)
}

fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax")
}

pub(crate) async fn open_login(db: &PgPool, account: &Account) -> Result<String, sqlx::Error> {
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Account {
    pub(crate) id: Uuid,
    pub(crate) name: String,
}

type AccountRow = (Uuid, String);

fn account(row: Option<AccountRow>) -> Option<Account> {
    row.map(|(id, name)| Account { id, name })
}

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

pub(crate) async fn is_held(db: &PgPool, name: &str, except: Option<Uuid>) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM held_names WHERE name = $1 AND until > now() AND ($2::uuid IS NULL OR user_id <> $2))",
    )
    .bind(name)
    .bind(except)
    .fetch_one(db)
    .await
}

pub(crate) async fn renamed_to(db: &PgPool, name: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT s.name FROM held_names h JOIN streamers s ON s.id = h.user_id WHERE h.name = $1 AND h.until > now()",
    )
    .bind(name)
    .fetch_optional(db)
    .await
}

pub(crate) async fn is_claimed(db: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM streamers WHERE name = $1 AND password_hash IS NOT NULL)
             OR EXISTS (SELECT 1 FROM held_names WHERE name = $1 AND until > now())",
    )
    .bind(name)
    .fetch_one(db)
    .await
}

pub(crate) const NAME_HAS_ACCOUNT: &str = "that name has an account. log in as it";
pub(crate) const NICK_HAS_ACCOUNT: &str = "that name has an account. log in as it, or pick another";

pub(crate) async fn may_act_as(db: &PgPool, name: &str, me: Option<&str>) -> Result<(), ApiError> {
    if me == Some(name) || !is_claimed(db, name).await? {
        return Ok(());
    }
    Err(ApiError::new(StatusCode::FORBIDDEN, NAME_HAS_ACCOUNT))
}

pub(crate) struct Me(pub(crate) Option<Account>);

#[derive(Clone)]
pub(crate) struct Seen(pub(crate) Option<Account>);

impl Me {
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
        if let Some(Seen(me)) = parts.extensions.get::<Seen>() {
            return Ok(Me(me.clone()));
        }
        Ok(Me(whoami(&PgPool::from_ref(state), &parts.headers).await?))
    }
}

pub(crate) async fn bump(s: &AppState, key: &str, window_secs: i64) -> Result<i64, ApiError> {
    let (n,): (i64,) = redis::pipe()
        .atomic()
        .incr(key, 1)
        .cmd("EXPIRE").arg(key).arg(window_secs).arg("NX").ignore()
        .query_async(&mut s.redis.clone())
        .await?;
    Ok(n)
}

pub(crate) async fn limit(s: &AppState, key: &str, window_secs: i64, max: i64, message: &str) -> Result<(), ApiError> {
    let (n, ttl) = crate::ratelimit::hit(&s.redis, key, window_secs).await?;
    if n > max {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, message).retry_after(if ttl > 0 { ttl } else { window_secs }));
    }
    Ok(())
}

pub(crate) fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|ip| ip.trim().to_owned())
        .filter(|ip| !ip.is_empty())
        .unwrap_or_else(|| "?".to_owned())
}

#[derive(Deserialize)]
struct Credentials {
    name: String,
    password: String,
    #[serde(default)]
    turnstile_token: Option<String>,
}

#[derive(Deserialize)]
struct PasswordChange {
    #[serde(default)]
    old: String,
    new: String,
}

#[derive(Deserialize)]
struct NameChange {
    name: String,
    #[serde(default)]
    password: String,
}

fn wrong() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "wrong name or password")
}

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn too_many() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many tries. wait 15 minutes")
}

fn name_taken() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "name taken")
}

fn wrong_password() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "wrong password")
}

fn login_key(ip: &str, name: &str) -> String {
    format!("rl:login:name:{ip}:{name}")
}

fn from_here(headers: &HeaderMap) -> bool {
    match headers.get("sec-fetch-site") {
        None => true,
        Some(site) => matches!(site.to_str(), Ok("same-origin" | "none")),
    }
}

fn with_cookie(status: StatusCode, cookie: String, body: Value) -> Response {
    (status, [(header::SET_COOKIE, cookie)], Json(body)).into_response()
}

pub(crate) async fn limit_signup(s: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    limit(s, &format!("rl:signup:ip:{}", client_ip(headers)), SIGNUP_WINDOW_SECS, SIGNUP_PER_IP, "too many signups from here. try later").await
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
    crate::turnstile::verify(&s, body.turnstile_token.as_deref(), &client_ip(&headers)).await?;
    limit_signup(&s, &headers).await?;
    if is_held(&s.db, &name, None).await? {
        return Err(name_taken());
    }
    let hash = hash_blocking(password).await?;
    let claimed: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
         WHERE streamers.password_hash IS NULL AND NOT streamers.is_test
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
    if !valid_name(&name) {
        return Err(wrong());
    }
    let Some(password) = clean_password(&body.password) else { return Err(wrong()) };
    let ip = client_ip(&headers);
    crate::turnstile::verify(&s, body.turnstile_token.as_deref(), &ip).await?;
    let name_key = login_key(&ip, &name);
    let ip_key = format!("rl:login:ip:{ip}");
    let (tries, name_ttl) = crate::ratelimit::hit(&s.redis, &name_key, LOGIN_WINDOW_SECS).await?;
    let (from_ip, ip_ttl) = crate::ratelimit::hit(&s.redis, &ip_key, LOGIN_WINDOW_SECS).await?;
    if tries > LOGIN_PER_NAME || from_ip > LOGIN_PER_IP {
        let wait = if from_ip > LOGIN_PER_IP { ip_ttl.max(name_ttl) } else { name_ttl };
        return Err(too_many().retry_after(if wait > 0 { wait } else { LOGIN_WINDOW_SECS }));
    }
    let stored: Option<(Uuid, Option<String>)> = sqlx::query_as("SELECT id, password_hash FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    let (id, hash) = match stored {
        Some((id, hash)) => (Some(id), hash),
        None => (None, None),
    };
    let Verdict::Right { upgraded } = verify_blocking(password, hash.clone()).await else {
        return Err(wrong());
    };
    let Some(id) = id else { return Err(wrong()) };
    if let (Some(new), Some(old)) = (upgraded, hash) {
        upgrade_hash(&s.db, id, &old, &new).await;
    }
    let _: () = s.redis.clone().del(&name_key).await?;
    let me = Account { id, name };
    let token = open_login(&s.db, &me).await?;
    log::info!("{}: logged in", me.name);
    Ok(with_cookie(StatusCode::OK, set_cookie(&token), json!({ "id": me.id, "name": me.name })))
}

async fn logout(State(s): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
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

async fn me(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let Some(me) = me else {
        return Ok(Json(json!({ "id": null, "name": null, "renamed_at": null, "has_password": null, "oauth_verified": null, "held": [] })));
    };
    let row: Option<(Option<DateTime<Utc>>, Option<String>, bool)> =
        sqlx::query_as(concat!("SELECT s.renamed_at, s.password_hash, ", crate::oauth::linked_sql!("s"), " FROM streamers s WHERE s.id = $1"))
            .bind(me.id)
            .fetch_optional(&s.db)
            .await?;
    let (renamed_at, hash, oauth_verified) = row.unwrap_or((None, None, false));
    let has_password = hash.as_deref().is_some_and(is_password);
    let held: Vec<String> = sqlx::query_scalar("SELECT name FROM held_names WHERE user_id = $1 AND until > now() ORDER BY name")
        .bind(me.id)
        .fetch_all(&s.db)
        .await?;
    Ok(Json(json!({ "id": me.id, "name": me.name, "renamed_at": renamed_at, "has_password": has_password, "oauth_verified": oauth_verified, "held": held })))
}

async fn check_password(s: &AppState, headers: &HeaderMap, me: &Account, raw: &str) -> Result<(), ApiError> {
    let Some(password) = clean_password(raw) else { return Err(wrong_password()) };
    let key = login_key(&client_ip(headers), &me.name);
    limit(s, &key, LOGIN_WINDOW_SECS, LOGIN_PER_NAME, "too many tries. wait 15 minutes").await?;
    let stored: Option<Option<String>> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE id = $1")
        .bind(me.id)
        .fetch_optional(&s.db)
        .await?;
    let Some(hash) = stored.flatten() else { return Err(not_logged_in()) };
    let Verdict::Right { upgraded } = verify_blocking(password, Some(hash.clone())).await else {
        return Err(wrong_password());
    };
    if let Some(new) = upgraded {
        upgrade_hash(&s.db, me.id, &hash, &new).await;
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
    if has_password(&s.db, me.id).await? {
        check_password(&s, &headers, &me, &body.old).await?;
    }
    let hash = hash_blocking(new).await?;
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

fn rename_wait(last: Option<DateTime<Utc>>, returning: bool, now: DateTime<Utc>) -> Result<(), ApiError> {
    let Some(at) = last.filter(|_| !returning) else { return Ok(()) };
    let again = at + chrono::Duration::days(RENAME_DAYS);
    if again > now {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("you changed your name on {}. again from {}", at.format("%Y-%m-%d"), again.format("%Y-%m-%d")),
        ));
    }
    Ok(())
}

pub(crate) async fn take_free_row(conn: &mut PgConnection, free: Uuid, me: Uuid, new: &str) -> Result<Vec<String>, ApiError> {
    let thumbs: Vec<i64> = sqlx::query_scalar("SELECT id FROM stream_thumbs WHERE name = $1").bind(new).fetch_all(&mut *conn).await?;
    let assets: Vec<(i64, String)> = sqlx::query_as("SELECT id, mime FROM stream_assets WHERE name = $1").bind(new).fetch_all(&mut *conn).await?;
    let abouts: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, kind, mime FROM about_files WHERE name = $1").bind(new).fetch_all(&mut *conn).await?;
    let mut orphaned = profile::picture_keys(free, &thumbs, &assets);
    for (id, kind, mime) in &abouts {
        orphaned.push(crate::about_page::about_key(free, *id, crate::about_page::ext_of(kind, mime)));
    }
    sqlx::query("DELETE FROM stream_thumbs WHERE name = $1").bind(new).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM stream_assets WHERE name = $1").bind(new).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM about_files WHERE name = $1").bind(new).execute(&mut *conn).await?;
    sqlx::query(
        "INSERT INTO follows (follower_id, followed_id, followed_at)
         SELECT follower_id, $2, followed_at FROM follows WHERE followed_id = $1 AND follower_id <> $2
         ON CONFLICT DO NOTHING",
    )
    .bind(free)
    .bind(me)
    .execute(&mut *conn)
    .await?;
    let gone = sqlx::query("DELETE FROM streamers WHERE id = $1 AND password_hash IS NULL").bind(free).execute(&mut *conn).await?;
    if gone.rows_affected() == 0 {
        return Err(name_taken());
    }
    Ok(orphaned)
}

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
    if has_password(&s.db, me.id).await? {
        check_password(&s, &headers, &me, &body.password).await?;
    }
    let keyed: bool = s.redis.clone().exists(live_key(&me.name)).await?;
    if keyed || is_live(&s, &me.name).await? {
        return Err(ApiError::new(StatusCode::CONFLICT, "stop the stream first"));
    }
    profile::lift_pictures(&s, me.id, &me.name).await;

    let mut tx = s.db.begin().await?;
    let last: Option<Option<DateTime<Utc>>> = sqlx::query_scalar("SELECT renamed_at FROM streamers WHERE id = $1 FOR UPDATE")
        .bind(me.id)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM held_names WHERE until < now()").execute(&mut *tx).await?;
    let own_hold: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT until FROM held_names WHERE name = $1 AND user_id = $2 AND until > now()")
        .bind(&new)
        .bind(me.id)
        .fetch_optional(&mut *tx)
        .await?;
    rename_wait(last.flatten(), own_hold.is_some(), Utc::now())?;
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM streamers WHERE name = $1 AND (password_hash IS NOT NULL OR is_test))
             OR EXISTS (SELECT 1 FROM held_names WHERE name = $1 AND user_id <> $2)",
    )
    .bind(&new)
    .bind(me.id)
    .fetch_one(&mut *tx)
    .await?;
    if taken {
        return Err(name_taken());
    }
    let free: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(&new).fetch_optional(&mut *tx).await?;
    let orphaned = match free {
        Some(free) => take_free_row(&mut tx, free, me.id, &new).await?,
        None => Vec::new(),
    };
    let renamed_at: Option<DateTime<Utc>> = match sqlx::query_scalar(
        "UPDATE streamers SET name = $2, renamed_at = CASE WHEN $3 THEN renamed_at ELSE now() END WHERE id = $1 RETURNING renamed_at",
    )
        .bind(me.id)
        .bind(&new)
        .bind(own_hold.is_some())
        .fetch_one(&mut *tx)
        .await
    {
        Ok(at) => at,
        Err(e) if unique_violation(&e) => return Err(name_taken()),
        Err(e) => return Err(e.into()),
    };
    sqlx::query("UPDATE stream_thumbs SET name = $2 WHERE name = $1").bind(&me.name).bind(&new).execute(&mut *tx).await?;
    sqlx::query("UPDATE stream_assets SET name = $2 WHERE name = $1").bind(&me.name).bind(&new).execute(&mut *tx).await?;
    sqlx::query("UPDATE about_files SET name = $2 WHERE name = $1").bind(&me.name).bind(&new).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM held_names WHERE name = $1 AND user_id = $2").bind(&new).bind(me.id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, COALESCE($4, now() + make_interval(days => $3)))
         ON CONFLICT (name) DO UPDATE SET user_id = EXCLUDED.user_id, until = EXCLUDED.until",
    )
    .bind(&me.name)
    .bind(me.id)
    .bind(HOLD_DAYS as i32)
    .bind(own_hold)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    profile::drop_pictures(&s, &orphaned).await;
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

pub(crate) async fn passwd(db: &PgPool, name: &str) -> anyhow::Result<()> {
    let name = name.trim().to_lowercase();
    anyhow::ensure!(valid_name(&name), "bad name. use a-z 0-9 _ - (1 to 32)");
    let prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    anyhow::ensure!(!name.starts_with(&prefix), "reserved name: {prefix}* belongs to the fake streams");
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

fn random_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| ALPHABET[(*b % 32) as usize] as char).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn the_refusals_carry_the_word_the_pages_match_on() {
        assert!(NAME_HAS_ACCOUNT.contains("account"));
        assert!(NICK_HAS_ACCOUNT.contains("account"));
    }

    fn refused(raw: &str) -> bool {
        match clean_new_password(raw) {
            Ok(_) => false,
            Err(e) => {
                assert_eq!(e.into_response().status(), StatusCode::BAD_REQUEST);
                true
            }
        }
    }

    #[test]
    fn a_new_password_needs_eight_characters_a_number_and_a_symbol() {
        assert!(!refused("abcdef1!"), "8 with a number and a symbol");
        assert!(!refused("correct horse battery 9!"));
        assert!(!refused("пароль-12"), "letters of any script, a hyphen is a symbol");
        assert!(refused("abcde1!"), "7 is too short");
        assert!(refused("abcdefgh!"), "no number");
        assert!(refused("abcdefgh1"), "no symbol");
        assert!(refused("abcd efg1"), "a space is not a symbol");
        assert!(refused(&format!("{}1!", "a".repeat(127))), "129 is too long");
        assert!(!refused(&format!("{}1!", "a".repeat(126))), "128 is fine");
        assert!(!refused("abcdef\u{ff11}!"));
        assert!(refused("abcde\u{0301}1!"), "7 characters after nfkc");
    }

    #[test]
    fn logging_in_asks_only_the_length() {
        assert!(clean_password("correct horse battery").is_some());
        assert!(clean_password("short").is_none());
    }

    fn hash_with(algorithm: Algorithm, version: Version, m: u32, t: u32, p: u32, password: &str) -> String {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::new(algorithm, version, Params::new(m, t, p, None).unwrap())
            .hash_password(password.as_bytes(), &salt)
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_hash_on_other_settings_needs_a_rehash() {
        let current = hash_password("correct horse battery 9!").unwrap();
        assert!(!needs_rehash(&current), "today's settings: {current}");
        let pw = "correct horse battery 9!";
        assert!(needs_rehash(&hash_with(Algorithm::Argon2id, Version::V0x13, 8_192, 2, 1, pw)), "less memory");
        assert!(needs_rehash(&hash_with(Algorithm::Argon2id, Version::V0x13, ARGON2_M_COST_KIB, 1, 1, pw)), "fewer passes");
        assert!(needs_rehash(&hash_with(Algorithm::Argon2id, Version::V0x13, ARGON2_M_COST_KIB, 2, 2, pw)), "more lanes");
        assert!(needs_rehash(&hash_with(Algorithm::Argon2i, Version::V0x13, ARGON2_M_COST_KIB, 2, 1, pw)), "argon2i");
        assert!(needs_rehash(&hash_with(Algorithm::Argon2id, Version::V0x10, ARGON2_M_COST_KIB, 2, 1, pw)), "version 0x10");
        assert!(!needs_rehash("not a hash"), "nothing verifies against it, nothing to rehash");
    }

    #[tokio::test]
    async fn a_right_password_on_an_old_hash_comes_back_hashed_on_todays_settings() {
        let pw = "correct horse battery 9!";
        let old = hash_with(Algorithm::Argon2id, Version::V0x13, 8_192, 1, 1, pw);
        let Verdict::Right { upgraded: Some(new) } = verify_blocking(pw.into(), Some(old.clone())).await else {
            panic!("a right password on an old hash is right, with a new hash");
        };
        assert_ne!(new, old);
        assert!(!needs_rehash(&new), "the new one is on today's settings: {new}");
        assert!(verify_password(pw, &new), "and it is the same password");

        assert!(matches!(verify_blocking("wrong guess 1!".into(), Some(old)).await, Verdict::Wrong));
        let current = hash_password(pw).unwrap();
        assert!(matches!(verify_blocking(pw.into(), Some(current)).await, Verdict::Right { upgraded: None }));
        assert!(matches!(verify_blocking(pw.into(), None).await, Verdict::Wrong));
    }

    #[tokio::test]
    #[ignore]
    async fn an_upgrade_only_replaces_the_hash_it_was_made_from() {
        let pool = test_db().await;
        let run = std::process::id();
        let id = row(&pool, &format!("rehash-{run}"), Some("old-hash")).await;
        let stored = |pool: PgPool| async move {
            sqlx::query_scalar::<_, Option<String>>("SELECT password_hash FROM streamers WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        upgrade_hash(&pool, id, "old-hash", "new-hash").await;
        assert_eq!(stored(pool.clone()).await.as_deref(), Some("new-hash"));
        upgrade_hash(&pool, id, "old-hash", "stale-hash").await;
        assert_eq!(stored(pool.clone()).await.as_deref(), Some("new-hash"));
    }

    pub(crate) async fn test_db() -> PgPool {
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL: the postgres to run this against");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await.expect("connect");
        crate::schema::ensure(&pool).await.expect("schema");
        pool
    }

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
        edge(&pool, fan, nova, then).await;
        edge(&pool, both, nova, later).await;
        edge(&pool, both, alice, then).await;
        edge(&pool, alice, nova, then).await;

        let mut tx = pool.begin().await.unwrap();
        let orphaned = take_free_row(&mut tx, nova, alice, &name).await.expect("the free row is taken");
        sqlx::query("UPDATE streamers SET name = $2 WHERE id = $1").bind(alice).bind(&name).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();

        assert_eq!(orphaned, profile::picture_keys(nova, &[], &[]));
        assert_eq!(edges_of(&pool, fan).await, vec![(alice, then)]);
        assert_eq!(edges_of(&pool, both).await, vec![(alice, then)]);
        assert_eq!(edges_of(&pool, alice).await, vec![]);
        assert_eq!(
            crate::follows::stats(&pool, &name, Some(fan)).await.unwrap(),
            crate::follows::Stats { followers: 2, following: true, follows_you: false }
        );
    }

    #[tokio::test]
    #[ignore]
    async fn a_free_name_claimed_meanwhile_is_taken_not_deleted() {
        let pool = test_db().await;
        let run = std::process::id();
        let bob = row(&pool, &format!("bob-{run}"), Some("bob-hash")).await;
        let name = format!("nova2-{run}");
        let nova = row(&pool, &name, None).await;
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

    #[tokio::test]
    #[ignore]
    async fn a_held_name_is_somebodys_while_the_hold_lasts() {
        let pool = test_db().await;
        let run = std::process::id();
        let nova_name = format!("nova3-{run}");
        let nova = row(&pool, &nova_name, Some("nova-hash")).await;
        let alice = format!("alice3-{run}");
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&alice)
            .bind(nova)
            .execute(&pool)
            .await
            .unwrap();

        assert!(is_claimed(&pool, &alice).await.unwrap(), "a held name is somebody's");
        assert!(is_claimed(&pool, &nova_name).await.unwrap(), "an account's name is somebody's");
        assert!(!is_claimed(&pool, &format!("nobody3-{run}")).await.unwrap(), "a name nobody used is free");
        let guest = may_act_as(&pool, &alice, None).await.expect_err("a guest is refused");
        assert_eq!(guest.into_response().status(), StatusCode::FORBIDDEN);
        let holder = may_act_as(&pool, &alice, Some(&nova_name)).await.expect_err("the account that left it is refused");
        assert_eq!(holder.into_response().status(), StatusCode::FORBIDDEN);

        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&alice).execute(&pool).await.unwrap();
        assert!(!is_claimed(&pool, &alice).await.unwrap(), "a lapsed hold holds nothing");
        may_act_as(&pool, &alice, None).await.expect("free again");
    }

    #[test]
    fn going_back_to_your_own_held_name_never_waits() {
        let now = Utc::now();
        let yesterday = Some(now - chrono::Duration::days(1));
        let long_ago = Some(now - chrono::Duration::days(RENAME_DAYS + 1));
        assert!(rename_wait(None, false, now).is_ok(), "never renamed");
        assert!(rename_wait(long_ago, false, now).is_ok(), "the wait is over");
        let refused = rename_wait(yesterday, false, now).expect_err("once in 30 days");
        assert_eq!(refused.into_response().status(), StatusCode::FORBIDDEN);
        assert!(rename_wait(yesterday, true, now).is_ok(), "back onto a name held for me: any time");
    }

    #[test]
    fn no_password_is_not_a_password() {
        assert!(!is_password(NO_PASSWORD));
        assert!(is_password("$argon2id$v=19$m=19456,t=2,p=1$abc$def"));
        assert!(!verify_password("!no-password", NO_PASSWORD));
        assert!(!verify_password("", NO_PASSWORD));
        assert!(!needs_rehash(NO_PASSWORD));
    }

    #[tokio::test]
    #[ignore]
    async fn the_admin_pin_survives_a_rename_and_is_not_handed_on() {
        let pool = test_db().await;
        let run = std::process::id();
        let boss = format!("boss-{run}");
        let id = row(&pool, &boss, Some("boss-hash")).await;
        let admins = crate::debug::admins_with_accounts(&pool, vec![boss.clone()]).await.unwrap();
        assert_eq!(admins, vec![Account { id, name: boss.clone() }]);
        sqlx::query("UPDATE streamers SET name = $2 WHERE id = $1").bind(id).bind(format!("boss2-{run}")).execute(&pool).await.unwrap();
        let stranger = row(&pool, &boss, Some("stranger-hash")).await;
        let admins = crate::debug::admins_with_accounts(&pool, vec![boss.clone()]).await.unwrap();
        assert_eq!(admins.iter().map(|a| a.id).collect::<Vec<_>>(), vec![id], "still the first account, by id");
        assert!(!admins.iter().any(|a| a.id == stranger), "the stranger is no admin");
    }
}
