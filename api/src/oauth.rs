use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{self, Account, Me};
use crate::timings::Redis;
use crate::{unique_violation, valid_name, ApiError, ApiResult, AppState};

const STATE_SECS: u64 = 600;
const SIGNUP_SECS: u64 = 900;
const HANDOFF_SECS: u64 = 60;
const HANDOFF_GONE: &str = "that sign in ran out. try again from the app";
const HANDOFF_WINDOW_SECS: i64 = 600;
const HANDOFF_PER_IP: i64 = 20;
const STATE_COOKIE: &str = "oauth_state";
const SIGNUP_COOKIE: &str = "oauth_signup";
const PAGE: &str = "/oauth";

macro_rules! linked_sql {
    ($row:literal) => {
        concat!("EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = ", $row, ".id)")
    };
}
pub(crate) use linked_sql;

pub(crate) struct Spec {
    slug: &'static str,
    env: &'static str,
    label: &'static str,
    authorize_url: &'static str,
    token_url: &'static str,
    user_url: &'static str,
    scope: &'static str,
    authorize_extra: &'static [(&'static str, &'static str)],
    parse: fn(&Value) -> Option<Profile>,
    callback_base: &'static str,
    client_id_header: bool,
}

const GOOGLE: Spec = Spec {
    slug: "google",
    env: "GOOGLE",
    label: "Google",
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    user_url: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    authorize_extra: &[("prompt", "select_account")],
    parse: parse_google,
    callback_base: OAUTH_BASE,
    client_id_header: false,
};

const DISCORD: Spec = Spec {
    slug: "discord",
    env: "DISCORD",
    label: "Discord",
    authorize_url: "https://discord.com/oauth2/authorize",
    token_url: "https://discord.com/api/oauth2/token",
    user_url: "https://discord.com/api/users/@me",
    scope: "identify email",
    authorize_extra: &[],
    parse: parse_discord,
    callback_base: OAUTH_BASE,
    client_id_header: false,
};

const TWITCH: Spec = Spec {
    slug: "twitch",
    env: "TWITCH",
    label: "Twitch",
    authorize_url: "https://id.twitch.tv/oauth2/authorize",
    token_url: "https://id.twitch.tv/oauth2/token",
    user_url: "https://api.twitch.tv/helix/users",
    scope: "user:read:email",
    authorize_extra: &[],
    parse: parse_twitch,
    callback_base: SHARED_BASE,
    client_id_header: true,
};

const KICK: Spec = Spec {
    slug: "kick",
    env: "KICK",
    label: "Kick",
    authorize_url: "https://id.kick.com/oauth/authorize",
    token_url: "https://id.kick.com/oauth/token",
    user_url: "https://api.kick.com/public/v1/users",
    scope: "user:read",
    authorize_extra: &[],
    parse: parse_kick,
    callback_base: SHARED_BASE,
    client_id_header: false,
};

const OAUTH_BASE: &str = "/api/oauth";
pub(crate) const SHARED_BASE: &str = "/api/auth";

const PROVIDERS: &[Spec] = &[GOOGLE, DISCORD, TWITCH, KICK];

#[derive(Clone, Copy)]
pub(crate) struct Provider(&'static Spec);

impl PartialEq for Provider {
    fn eq(&self, other: &Self) -> bool {
        self.0.slug == other.0.slug
    }
}
impl Eq for Provider {}
impl std::hash::Hash for Provider {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        self.0.slug.hash(h)
    }
}
impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0.slug)
    }
}

impl Provider {
    #[cfg(test)]
    pub(crate) const GOOGLE: Provider = Provider(&GOOGLE);
    #[cfg(test)]
    pub(crate) const DISCORD: Provider = Provider(&DISCORD);
    #[cfg(test)]
    pub(crate) const TWITCH: Provider = Provider(&TWITCH);
    #[cfg(test)]
    pub(crate) const KICK: Provider = Provider(&KICK);

    pub(crate) fn all() -> impl Iterator<Item = Provider> {
        PROVIDERS.iter().map(Provider)
    }

    pub(crate) fn slug(self) -> &'static str {
        self.0.slug
    }

    pub(crate) fn from_slug(slug: &str) -> Option<Self> {
        Self::all().find(|p| p.slug() == slug)
    }

    fn label(self) -> &'static str {
        self.0.label
    }

    fn streams(self) -> bool {
        self.0.callback_base == SHARED_BASE
    }

    fn taken(self) -> String {
        if self.streams() {
            format!("that {} is already linked to another account", self.slug())
        } else {
            format!("that {} account is linked to another account here", self.label())
        }
    }
}

#[derive(Clone)]
struct Client {
    id: String,
    secret: String,
}

#[derive(Clone, Default)]
pub(crate) struct Config {
    public_url: Option<String>,
    clients: HashMap<Provider, Client>,
}

impl Config {
    pub(crate) fn from_env() -> Self {
        let config = Self::from_vars(|k| std::env::var(k).ok());
        let on: Vec<&str> = config.enabled().into_iter().map(Provider::slug).collect();
        match (&config.public_url, on.is_empty()) {
            (_, true) => log::info!("oauth: no provider set up (<P>_CLIENT_ID and _SECRET for {:?}, and PUBLIC_URL)", PROVIDERS.iter().map(|p| p.env).collect::<Vec<_>>()),
            (Some(_), false) => log::info!("oauth: {on:?}, callbacks at {:?}", config.enabled().into_iter().filter_map(|p| config.redirect_uri(p)).collect::<Vec<_>>()),
            (None, false) => {}
        }
        config
    }

    fn from_vars(get: impl Fn(&str) -> Option<String>) -> Self {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let public_url = val("PUBLIC_URL").and_then(|raw| match clean_public_url(&raw) {
            Some(url) => {
                if !url.starts_with("https://") {
                    log::warn!("PUBLIC_URL is not https: google refuses a plain-http callback except on localhost");
                }
                Some(url)
            }
            None => {
                log::warn!("PUBLIC_URL is not an http(s) url with a host: oauth is off");
                None
            }
        });
        let mut clients = HashMap::new();
        for p in Provider::all() {
            let (id, secret) = (val(&format!("{}_CLIENT_ID", p.0.env)), val(&format!("{}_CLIENT_SECRET", p.0.env)));
            match (id, secret) {
                (Some(id), Some(secret)) if public_url.is_some() => {
                    clients.insert(p, Client { id, secret });
                }
                (Some(_), Some(_)) => log::warn!("oauth: {} is set up but PUBLIC_URL is not, so it is off", p.slug()),
                (Some(_), None) | (None, Some(_)) => log::warn!("oauth: {} needs both _CLIENT_ID and _CLIENT_SECRET, so it is off", p.slug()),
                (None, None) => {}
            }
        }
        Config { public_url, clients }
    }

    pub(crate) fn enabled(&self) -> Vec<Provider> {
        Provider::all().filter(|p| self.clients.contains_key(p)).collect()
    }

    fn client(&self, p: Provider) -> Option<&Client> {
        self.clients.get(&p)
    }

    fn redirect_uri(&self, p: Provider) -> Option<String> {
        Some(format!("{}{}/{}/callback", self.public_url.as_ref()?, p.0.callback_base, p.slug()))
    }
}

pub(crate) fn clean_public_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

pub(crate) fn random_hex() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn check_state<'a>(query: Option<&'a str>, cookie: Option<&str>) -> Result<&'a str, &'static str> {
    let query = query.filter(|s| is_token(s)).ok_or("that login link is broken. try again")?;
    let cookie = cookie.filter(|s| is_token(s)).ok_or("that login started in another browser, or ran out. try again")?;
    if same_secret(query, cookie) {
        Ok(query)
    } else {
        Err("that login started in another browser. try again")
    }
}

fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn desktop_param(raw: Option<&str>, link: bool) -> Result<Option<String>, &'static str> {
    match raw {
        None => Ok(None),
        Some(s) if !link && is_token(s) && !s.bytes().any(|b| b.is_ascii_uppercase()) => Ok(Some(s.to_owned())),
        Some(_) => Err("that login link is broken. try again"),
    }
}

fn desktop_url(code: &str, state: &str, next: &str, provider: &str) -> String {
    let f: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("desktop", code)
        .append_pair("state", state)
        .append_pair("next", next)
        .append_pair("provider", provider)
        .finish();
    format!("{PAGE}#{f}")
}

fn same_origin(headers: &HeaderMap, public_url: Option<&str>) -> bool {
    match headers.get(header::ORIGIN) {
        None => true,
        Some(origin) => public_url.is_some_and(|want| origin.to_str().is_ok_and(|o| o == want)),
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Started {
    provider: String,
    verifier: String,
    link: Option<Uuid>,
    #[serde(default)]
    desktop: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
enum HandoffKind {
    Login { user_id: Uuid },
    Signup { token: String },
}

impl HandoffKind {
    fn next(&self) -> &'static str {
        match self {
            HandoffKind::Login { .. } => "done",
            HandoffKind::Signup { .. } => "pick",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
struct Handoff {
    state: String,
    kind: HandoffKind,
    provider: String,
}

fn handoff_key(code: &str) -> String {
    format!("oauth:handoff:{code}")
}

async fn put_handoff(redis: &Redis, code: &str, handoff: &Handoff, secs: u64) -> Result<(), ApiError> {
    let raw = serde_json::to_string(handoff).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save"))?;
    let _: () = redis::cmd("SET").arg(handoff_key(code)).arg(raw).arg("EX").arg(secs).query_async(&mut redis.clone()).await?;
    Ok(())
}

async fn take_handoff(redis: &Redis, code: &str, state: &str) -> Result<Option<Handoff>, ApiError> {
    let raw: Option<String> = redis::cmd("GETDEL").arg(handoff_key(code)).query_async(&mut redis.clone()).await?;
    Ok(raw.and_then(|r| serde_json::from_str::<Handoff>(&r).ok()).filter(|h| same_secret(&h.state, state)))
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
struct Newcomer {
    provider: String,
    provider_user_id: String,
    email: Option<String>,
    suggested: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

fn state_key(state: &str) -> String {
    format!("oauth:state:{state}")
}

fn signup_key(token: &str) -> String {
    format!("oauth:signup:{token}")
}

pub(crate) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|kv| kv.trim().strip_prefix(prefix.as_str()).map(str::to_owned))
        .find(|t| is_token(t))
}

fn short_cookie(name: &str, value: &str, secs: u64) -> String {
    path_cookie(name, value, secs, OAUTH_BASE)
}

fn path_cookie(name: &str, value: &str, secs: u64, path: &str) -> String {
    format!("{name}={value}; Path={path}; Max-Age={secs}; HttpOnly; Secure; SameSite=Lax")
}

fn gone_cookie(name: &str) -> String {
    path_cookie(name, "", 0, OAUTH_BASE)
}

fn gone_state() -> [String; 2] {
    [path_cookie(STATE_COOKIE, "", 0, OAUTH_BASE), path_cookie(STATE_COOKIE, "", 0, SHARED_BASE)]
}

pub(crate) fn is_login_state(headers: &HeaderMap, state: Option<&str>) -> bool {
    check_state(state, cookie_value(headers, STATE_COOKIE).as_deref()).is_ok()
}

fn redirect_with(to: &str, cookies: &[String]) -> Response {
    with_cookies(Redirect::to(to).into_response(), cookies)
}

fn with_cookies(mut res: Response, cookies: &[String]) -> Response {
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(c) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

fn page_url(key: &str, value: &str) -> String {
    let q: String = url::form_urlencoded::Serializer::new(String::new()).append_pair(key, value).finish();
    format!("{PAGE}?{q}")
}

fn fail(words: &str) -> Response {
    redirect_with(&page_url("error", words), &gone_state())
}

#[derive(Debug, PartialEq, Clone)]
struct Profile {
    id: String,
    email: Option<String>,
    suggested: String,
    name: Option<String>,
    avatar: Option<String>,
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned).filter(|x| !x.is_empty())
}

fn bool_of(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn parse_google(v: &Value) -> Option<Profile> {
    Some(Profile {
        id: str_of(v, "sub")?,
        email: str_of(v, "email").filter(|_| bool_of(v, "email_verified")),
        suggested: suggest_name(&str_of(v, "given_name").or_else(|| str_of(v, "name")).unwrap_or_default()),
        name: shown_name(str_of(v, "name").as_deref()).or_else(|| shown_name(str_of(v, "given_name").as_deref())),
        avatar: str_of(v, "picture").and_then(|u| shown_avatar(&u)),
    })
}

fn parse_discord(v: &Value) -> Option<Profile> {
    let id = str_of(v, "id")?;
    Some(Profile {
        email: str_of(v, "email").filter(|_| bool_of(v, "verified")),
        suggested: suggest_name(&str_of(v, "username").unwrap_or_default()),
        name: shown_name(str_of(v, "global_name").as_deref()).or_else(|| shown_name(str_of(v, "username").as_deref())),
        avatar: discord_avatar(&id, str_of(v, "avatar").as_deref()),
        id,
    })
}

fn parse_twitch(v: &Value) -> Option<Profile> {
    let row = v.get("data").and_then(Value::as_array).and_then(|a| a.first())?;
    let login = str_of(row, "login");
    Some(Profile {
        id: str_of(row, "id")?,
        email: str_of(row, "email"),
        suggested: suggest_name(login.as_deref().unwrap_or_default()),
        name: shown_name(str_of(row, "display_name").as_deref()).or_else(|| shown_name(login.as_deref())),
        avatar: str_of(row, "profile_image_url").and_then(|u| shown_avatar(&u)),
    })
}

fn parse_kick(v: &Value) -> Option<Profile> {
    let row = v.get("data").and_then(Value::as_array).and_then(|a| a.first())?;
    let id = match row.get("user_id")? {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    let name = str_of(row, "name");
    Some(Profile {
        id,
        email: str_of(row, "email"),
        suggested: suggest_name(name.as_deref().unwrap_or_default()),
        name: shown_name(name.as_deref()),
        avatar: str_of(row, "profile_picture").and_then(|u| shown_avatar(&u)),
    })
}

fn discord_avatar(id: &str, hash: Option<&str>) -> Option<String> {
    let n: u64 = id.parse().ok()?;
    let url = match hash {
        Some(h) if h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
            format!("https://cdn.discordapp.com/avatars/{n}/{h}.png?size=64")
        }
        _ => format!("https://cdn.discordapp.com/embed/avatars/{}.png", (n >> 22) % 6),
    };
    shown_avatar(&url)
}

const SHOWN_NAME_MAX: usize = 64;

fn shown_name(raw: Option<&str>) -> Option<String> {
    let clean: String = raw?.chars().filter(|c| !c.is_control()).collect();
    let capped: String = clean.trim().chars().take(SHOWN_NAME_MAX).collect();
    Some(capped.trim_end().to_owned()).filter(|n| !n.is_empty())
}

const AVATAR_HOSTS: [&str; 4] = ["lh3.googleusercontent.com", "cdn.discordapp.com", "static-cdn.jtvnw.net", "files.kick.com"];

fn shown_avatar(raw: &str) -> Option<String> {
    if raw.len() > 512 {
        return None;
    }
    let u = url::Url::parse(raw).ok()?;
    let ok = u.scheme() == "https"
        && u.host_str().is_some_and(|h| AVATAR_HOSTS.contains(&h))
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none();
    ok.then(|| u.to_string())
}

fn parse_profile(p: Provider, v: &Value) -> Option<Profile> {
    (p.0.parse)(v)
}

fn suggest_name(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars().flat_map(char::to_lowercase) {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            c
        } else if c == ' ' || c == '.' {
            '_'
        } else {
            continue;
        };
        out.push(c);
        if out.len() == 32 {
            break;
        }
    }
    out
}

fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .build()
            .expect("oauth http client")
    })
}

async fn who_is_it(config: &Config, p: Provider, code: &str, verifier: &str) -> Result<Profile, ()> {
    let client = config.client(p).ok_or(())?;
    let redirect_uri = config.redirect_uri(p).ok_or(())?;
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("client_id", &client.id)
        .append_pair("client_secret", &client.secret)
        .append_pair("code_verifier", verifier)
        .finish();
    let res = http()
        .post(p.0.token_url)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ACCEPT, "application/json")
        .body(form)
        .send()
        .await
        .map_err(|e| log::warn!("oauth {}: token: {}", p.slug(), e.without_url()))?;
    if !res.status().is_success() {
        log::warn!("oauth {}: token: http {}", p.slug(), res.status());
        return Err(());
    }
    let token: Value = res.json().await.map_err(|e| log::warn!("oauth {}: token body: {e}", p.slug()))?;
    let access = token.get("access_token").and_then(Value::as_str).ok_or_else(|| log::warn!("oauth {}: no access_token", p.slug()))?;
    let mut req = http().get(p.0.user_url).bearer_auth(access).header(header::ACCEPT, "application/json");
    if p.0.client_id_header {
        req = req.header("Client-Id", &client.id);
    }
    let res = req
        .send().await.map_err(|e| log::warn!("oauth {}: user: {}", p.slug(), e.without_url()))?;
    if !res.status().is_success() {
        log::warn!("oauth {}: user: http {}", p.slug(), res.status());
        return Err(());
    }
    let body: Value = res.json().await.map_err(|e| log::warn!("oauth {}: user body: {e}", p.slug()))?;
    parse_profile(p, &body).ok_or_else(|| log::warn!("oauth {}: user answer has no id", p.slug()))
}

pub(crate) async fn linked_account(db: &sqlx::PgPool, p: Provider, provider_user_id: &str) -> Result<Option<Account>, sqlx::Error> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT s.id, s.name FROM oauth_identities o JOIN streamers s ON s.id = o.user_id
         WHERE o.provider = $1 AND o.provider_user_id = $2",
    )
    .bind(p.slug())
    .bind(provider_user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, name)| Account { id, name }))
}

pub(crate) async fn streaming_owner(db: &sqlx::PgPool, p: Provider, provider_user_id: &str) -> Result<Option<Account>, sqlx::Error> {
    if !p.streams() {
        return Ok(None);
    }
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT s.id, s.name FROM stream_destinations d JOIN streamers s ON s.id = d.user_id
         WHERE d.platform = $1 AND d.external_id = $2 ORDER BY d.created_at LIMIT 1",
    )
    .bind(p.slug())
    .bind(provider_user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, name)| Account { id, name }))
}

pub(crate) async fn login_owner(db: &sqlx::PgPool, p: Provider, provider_user_id: &str, shown: &Shown<'_>) -> Result<Option<Account>, sqlx::Error> {
    if let Some(account) = linked_account(db, p, provider_user_id).await? {
        return Ok(Some(account));
    }
    let Some(owner) = streaming_owner(db, p, provider_user_id).await? else { return Ok(None) };
    let mut conn = db.acquire().await?;
    if link(&mut conn, owner.id, p, provider_user_id, shown).await? == Linked::Yes {
        log::info!("{}: linked {} on its first login with it", owner.name, p.slug());
    }
    Ok(Some(owner))
}

#[cfg(test)]
pub(crate) async fn is_verified(db: &sqlx::PgPool, user: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(concat!("SELECT ", linked_sql!("s"), " FROM streamers s WHERE s.id = $1"))
        .bind(user)
        .fetch_optional(db)
        .await
        .map(|v| v.unwrap_or(false))
}

#[derive(Default, Clone, Copy)]
pub(crate) struct Shown<'a> {
    pub(crate) email: Option<&'a str>,
    pub(crate) name: Option<&'a str>,
    pub(crate) avatar: Option<&'a str>,
}

impl<'a> Shown<'a> {
    fn of(profile: &'a Profile) -> Self {
        Shown { email: profile.email.as_deref(), name: profile.name.as_deref(), avatar: profile.avatar.as_deref() }
    }
}

async fn refresh(db: &sqlx::PgPool, p: Provider, profile: &Profile) {
    let _ = sqlx::query(
        "UPDATE oauth_identities SET email = COALESCE($3, email), display_name = $4, avatar_url = $5
         WHERE provider = $1 AND provider_user_id = $2
           AND (email IS DISTINCT FROM COALESCE($3, email) OR display_name IS DISTINCT FROM $4 OR avatar_url IS DISTINCT FROM $5)",
    )
    .bind(p.slug())
    .bind(&profile.id)
    .bind(&profile.email)
    .bind(&profile.name)
    .bind(&profile.avatar)
    .execute(db)
    .await;
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Linked {
    Yes,
    Taken,
    HasOne,
}

pub(crate) async fn link(conn: &mut sqlx::PgConnection, user: Uuid, p: Provider, provider_user_id: &str, shown: &Shown<'_>) -> Result<Linked, sqlx::Error> {
    let has_one: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM oauth_identities WHERE user_id = $1 AND provider = $2 AND provider_user_id <> $3)")
        .bind(user)
        .bind(p.slug())
        .bind(provider_user_id)
        .fetch_one(&mut *conn)
        .await?;
    if has_one {
        return Ok(Linked::HasOne);
    }
    let done =
        sqlx::query("INSERT INTO oauth_identities (user_id, provider, provider_user_id, email, display_name, avatar_url) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(user)
            .bind(p.slug())
            .bind(provider_user_id)
            .bind(shown.email)
            .bind(shown.name)
            .bind(shown.avatar)
            .execute(&mut *conn)
            .await;
    match done {
        Ok(_) => Ok(Linked::Yes),
        Err(e) if unique_violation(&e) => Ok(Linked::Taken),
        Err(e) => Err(e),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Unlink {
    Yes,
    NotLinked,
    LastWayIn,
}

pub(crate) fn may_unlink(has_password: bool, linked: &[String], p: Provider) -> Unlink {
    if !linked.iter().any(|l| l == p.slug()) {
        Unlink::NotLinked
    } else if !has_password && linked.len() <= 1 {
        Unlink::LastWayIn
    } else {
        Unlink::Yes
    }
}

pub(crate) async fn unlink(db: &sqlx::PgPool, user: Uuid, p: Provider) -> Result<Unlink, sqlx::Error> {
    let mut tx = db.begin().await?;
    let hash: Option<Option<String>> = sqlx::query_scalar("SELECT password_hash FROM streamers WHERE id = $1 FOR UPDATE")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?;
    let has_password = hash.flatten().as_deref().is_some_and(auth::is_password);
    let linked: Vec<String> = sqlx::query_scalar("SELECT provider FROM oauth_identities WHERE user_id = $1").bind(user).fetch_all(&mut *tx).await?;
    let verdict = may_unlink(has_password, &linked, p);
    if verdict == Unlink::Yes {
        sqlx::query("DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2").bind(user).bind(p.slug()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(verdict)
}

pub(crate) async fn create_account(db: &sqlx::PgPool, name: &str, p: Provider, provider_user_id: &str, shown: &Shown<'_>) -> Result<Uuid, ApiError> {
    let mut tx = db.begin().await?;
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
         WHERE streamers.password_hash IS NULL AND NOT streamers.is_test
         RETURNING id",
    )
    .bind(name)
    .bind(auth::NO_PASSWORD)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else { return Err(ApiError::new(StatusCode::CONFLICT, "name taken")) };
    if link(&mut tx, id, p, provider_user_id, shown).await? != Linked::Yes {
        return Err(ApiError::new(StatusCode::CONFLICT, "that account is linked already. log in with it"));
    }
    tx.commit().await?;
    Ok(id)
}

#[derive(Deserialize)]
struct StartQuery {
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    desktop: Option<String>,
}

async fn start(State(s): State<AppState>, Path(slug): Path<String>, Query(q): Query<StartQuery>, Me(me): Me) -> Result<Response, ApiError> {
    let Some(p) = Provider::from_slug(&slug).filter(|p| s.oauth.client(*p).is_some()) else {
        return Ok(fail("that login is not set up here"));
    };
    let link = match q.link.as_deref() {
        Some("1") => match me {
            Some(me) => Some(me.id),
            None => return Ok(fail("log in first, then link")),
        },
        _ => None,
    };
    let desktop = match desktop_param(q.desktop.as_deref(), q.link.as_deref() == Some("1")) {
        Ok(desktop) => desktop,
        Err(words) => return Ok(fail(words)),
    };
    let (client, redirect_uri) = (s.oauth.client(p).expect("checked"), s.oauth.redirect_uri(p).expect("checked"));
    let state = random_hex();
    let verifier = random_hex();
    let started = Started { provider: p.slug().to_owned(), verifier: verifier.clone(), link, desktop };
    let _: () = redis::cmd("SET")
        .arg(state_key(&state))
        .arg(serde_json::to_string(&started).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not start"))?)
        .arg("EX")
        .arg(STATE_SECS)
        .query_async(&mut s.redis.clone())
        .await?;
    let mut to = url::Url::parse(p.0.authorize_url).expect("a fixed url");
    to.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client.id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", p.0.scope)
        .append_pair("state", &state)
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256");
    to.query_pairs_mut().extend_pairs(p.0.authorize_extra.iter().copied());
    Ok(redirect_with(to.as_str(), &[path_cookie(STATE_COOKIE, &state, STATE_SECS, p.0.callback_base)]))
}

#[derive(Deserialize)]
pub(crate) struct CallbackQuery {
    pub(crate) code: Option<String>,
    pub(crate) state: Option<String>,
    pub(crate) error: Option<String>,
}

async fn callback(State(s): State<AppState>, Path(slug): Path<String>, Query(q): Query<CallbackQuery>, headers: HeaderMap) -> Result<Response, ApiError> {
    match Provider::from_slug(&slug) {
        Some(p) if !p.streams() => finish(&s, &slug, q, &headers).await,
        _ => Ok(fail("that login is not set up here")),
    }
}

pub(crate) async fn finish(s: &AppState, slug: &str, q: CallbackQuery, headers: &HeaderMap) -> Result<Response, ApiError> {
    let Some(p) = Provider::from_slug(slug).filter(|p| s.oauth.client(*p).is_some()) else {
        return Ok(fail("that login is not set up here"));
    };
    if q.error.is_some() {
        return Ok(fail(&format!("{} said no, or you cancelled", p.label())));
    }
    let cookie = cookie_value(headers, STATE_COOKIE);
    let state = match check_state(q.state.as_deref(), cookie.as_deref()) {
        Ok(state) => state,
        Err(words) => return Ok(fail(words)),
    };
    let raw: Option<String> = redis::cmd("GETDEL").arg(state_key(state)).query_async(&mut s.redis.clone()).await?;
    let Some(started) = raw.and_then(|r| serde_json::from_str::<Started>(&r).ok()) else {
        return Ok(fail("that login ran out. try again"));
    };
    if started.provider != p.slug() {
        return Ok(fail("that login link is broken. try again"));
    }
    let desktop = started.desktop.clone().filter(|_| started.link.is_none());
    let Some(code) = q.code.filter(|c| !c.is_empty() && c.len() <= 2048) else {
        return Ok(fail("that login link is broken. try again"));
    };
    let Ok(profile) = who_is_it(&s.oauth, p, &code, &started.verifier).await else {
        return Ok(fail(&format!("could not reach {}. try again", p.label())));
    };
    let linked = linked_account(&s.db, p, &profile.id).await?;

    if let Some(want) = started.link {
        let me = auth::whoami(&s.db, headers).await?;
        if me.as_ref().map(|m| m.id) != Some(want) {
            return Ok(fail("log in again, then link"));
        }
        let is_linked = linked.is_some();
        let owner = match linked {
            Some(owner) => Some(owner),
            None => streaming_owner(&s.db, p, &profile.id).await?,
        };
        return Ok(match (is_linked, owner) {
            (true, Some(owner)) if owner.id == want => {
                refresh(&s.db, p, &profile).await;
                redirect_with(&page_url("linked", p.slug()), &gone_state())
            }
            (_, Some(owner)) if owner.id != want => fail(&p.taken()),
            _ => {
                let mut conn = s.db.acquire().await?;
                match link(&mut conn, want, p, &profile.id, &Shown::of(&profile)).await? {
                    Linked::Yes => {
                        log::info!("{}: linked {}", me.map(|m| m.name).unwrap_or_default(), p.slug());
                        redirect_with(&page_url("linked", p.slug()), &gone_state())
                    }
                    Linked::Taken => fail(&p.taken()),
                    Linked::HasOne => fail(&format!("this account has a {} login already. unlink it first", p.label())),
                }
            }
        });
    }

    let account = match linked {
        Some(account) => Some(account),
        None => login_owner(&s.db, p, &profile.id, &Shown::of(&profile)).await?,
    };
    if let Some(account) = account {
        refresh(&s.db, p, &profile).await;
        if let Some(desktop) = desktop {
            log::info!("{}: logged in with {} in the browser, for the app", account.name, p.slug());
            return hand_off(s, desktop, HandoffKind::Login { user_id: account.id }, p).await;
        }
        let token = auth::open_login(&s.db, &account).await?;
        log::info!("{}: logged in with {}", account.name, p.slug());
        let [a, b] = gone_state();
        return Ok(redirect_with(&page_url("done", p.slug()), &[a, b, auth::set_cookie(&token)]));
    }

    let token = random_hex();
    let newcomer = Newcomer {
        provider: p.slug().to_owned(),
        provider_user_id: profile.id,
        email: profile.email,
        suggested: profile.suggested,
        name: profile.name,
        avatar: profile.avatar,
    };
    let _: () = redis::cmd("SET")
        .arg(signup_key(&token))
        .arg(serde_json::to_string(&newcomer).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save"))?)
        .arg("EX")
        .arg(SIGNUP_SECS)
        .query_async(&mut s.redis.clone())
        .await?;
    if let Some(desktop) = desktop {
        return hand_off(s, desktop, HandoffKind::Signup { token }, p).await;
    }
    let [a, b] = gone_state();
    Ok(redirect_with(&page_url("pick", p.slug()), &[a, b, short_cookie(SIGNUP_COOKIE, &token, SIGNUP_SECS)]))
}

async fn hand_off(s: &AppState, state: String, kind: HandoffKind, p: Provider) -> Result<Response, ApiError> {
    let code = random_hex();
    let next = kind.next();
    put_handoff(&s.redis, &code, &Handoff { state: state.clone(), kind, provider: p.slug().to_owned() }, HANDOFF_SECS).await?;
    Ok(redirect_with(&desktop_url(&code, &state, next, p.slug()), &gone_state()))
}

#[derive(Deserialize)]
struct HandoffBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    state: String,
}

fn handoff_gone() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, HANDOFF_GONE)
}

async fn handoff(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<HandoffBody>, JsonRejection>) -> Result<Response, ApiError> {
    if !same_origin(&headers, s.oauth.public_url.as_deref()) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "that sign in came from another site"));
    }
    let key = format!("rl:oauth-handoff:ip:{}", auth::client_ip(&headers));
    auth::limit(&s, &key, HANDOFF_WINDOW_SECS, HANDOFF_PER_IP, "too many tries. try later").await?;
    let Json(body) = body.map_err(|_| handoff_gone())?;
    if !is_token(&body.code) || !is_token(&body.state) {
        return Err(handoff_gone());
    }
    let Some(h) = take_handoff(&s.redis, &body.code, &body.state).await? else { return Err(handoff_gone()) };
    let p = Provider::from_slug(&h.provider).ok_or_else(handoff_gone)?;
    match h.kind {
        HandoffKind::Login { user_id } => {
            let row: Option<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM streamers WHERE id = $1").bind(user_id).fetch_optional(&s.db).await?;
            let Some((id, name)) = row else { return Err(handoff_gone()) };
            let account = Account { id, name };
            let token = auth::open_login(&s.db, &account).await?;
            log::info!("{}: logged in with {} in the app", account.name, p.slug());
            Ok(with_cookies(Json(json!({ "next": "done" })).into_response(), &[auth::set_cookie(&token)]))
        }
        HandoffKind::Signup { token } => {
            let alive: bool = redis::cmd("EXISTS").arg(signup_key(&token)).query_async(&mut s.redis.clone()).await?;
            if !alive {
                return Err(handoff_gone());
            }
            Ok(with_cookies(Json(json!({ "next": "pick", "provider": p.slug() })).into_response(), &[short_cookie(SIGNUP_COOKIE, &token, SIGNUP_SECS)]))
        }
    }
}

async fn newcomer(s: &AppState, headers: &HeaderMap) -> Result<Option<(String, Newcomer)>, ApiError> {
    let Some(token) = cookie_value(headers, SIGNUP_COOKIE) else { return Ok(None) };
    let raw: Option<String> = redis::cmd("GET").arg(signup_key(&token)).query_async(&mut s.redis.clone()).await?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).map(|n| (token, n)))
}

async fn signup_info(State(s): State<AppState>, headers: HeaderMap) -> ApiResult {
    let Some((_, n)) = newcomer(&s, &headers).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "nothing to finish. start the login again"));
    };
    Ok(Json(json!({ "provider": n.provider, "suggested": n.suggested })))
}

#[derive(Deserialize)]
struct Pick {
    name: String,
    #[serde(default)]
    turnstile_token: Option<String>,
}

async fn signup_finish(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<Pick>, JsonRejection>) -> Result<Response, ApiError> {
    let Json(body) = body?;
    let Some((token, n)) = newcomer(&s, &headers).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "nothing to finish. start the login again"));
    };
    let p = Provider::from_slug(&n.provider).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "nothing to finish. start the login again"))?;
    let name = body.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError::bad_name());
    }
    if name.starts_with(&s.dummy_prefix) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
    }
    crate::turnstile::verify(&s, body.turnstile_token.as_deref(), &auth::client_ip(&headers)).await?;
    auth::limit_signup(&s, &headers).await?;
    if auth::is_held(&s.db, &name, None).await? {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    let shown = Shown { email: n.email.as_deref(), name: n.name.as_deref(), avatar: n.avatar.as_deref() };
    let id = create_account(&s.db, &name, p, &n.provider_user_id, &shown).await?;
    let _: () = redis::cmd("DEL").arg(signup_key(&token)).query_async(&mut s.redis.clone()).await?;
    let me = Account { id, name };
    let login = auth::open_login(&s.db, &me).await?;
    log::info!("{}: signed up with {}", me.name, p.slug());
    let mut res = (StatusCode::CREATED, Json(json!({ "id": me.id, "name": me.name }))).into_response();
    for c in [auth::set_cookie(&login), gone_cookie(SIGNUP_COOKIE)] {
        if let Ok(v) = HeaderValue::from_str(&c) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    Ok(res)
}

async fn providers(State(s): State<AppState>) -> Json<Value> {
    Json(json!({ "providers": s.oauth.enabled().into_iter().map(Provider::slug).collect::<Vec<_>>() }))
}

type IdentityRow = (String, DateTime<Utc>, Option<String>, Option<String>);

async fn identities(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let rows: Vec<IdentityRow> = sqlx::query_as("SELECT provider, created_at, display_name, avatar_url FROM oauth_identities WHERE user_id = $1 ORDER BY created_at")
        .bind(me.id)
        .fetch_all(&s.db)
        .await?;
    let has_password = auth::has_password(&s.db, me.id).await?;
    let verified = !rows.is_empty();
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(provider, at, name, avatar)| json!({ "provider": provider, "linked_at": at, "name": name, "avatar": avatar }))
        .collect();
    Ok(Json(json!({ "has_password": has_password, "oauth_verified": verified, "identities": list })))
}

async fn unlink_route(State(s): State<AppState>, Path(slug): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let p = Provider::from_slug(&slug).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such login"))?;
    match unlink(&s.db, me.id, p).await? {
        Unlink::Yes => {
            log::info!("{}: unlinked {}", me.name, p.slug());
            Ok(StatusCode::NO_CONTENT)
        }
        Unlink::NotLinked => Err(ApiError::new(StatusCode::NOT_FOUND, "that login is not linked")),
        Unlink::LastWayIn => Err(ApiError::new(StatusCode::CONFLICT, "that is your only way to log in. set a password or link another first")),
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/oauth/providers", get(providers).layer(axum::middleware::map_response(crate::media::public_cache(crate::media::PROVIDERS_CACHE))))
        .route("/api/oauth/identities", get(identities))
        .route("/api/oauth/signup", get(signup_info).post(signup_finish))
        .route("/api/oauth/handoff", post(handoff))
        .route("/api/oauth/{provider}/start", get(start))
        .route("/api/oauth/{provider}/callback", get(callback))
        .route("/api/oauth/{provider}/unlink", post(unlink_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_vars(|k| map.get(k).cloned())
    }

    #[test]
    fn pkce_challenge_is_rfc7636s() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn a_verifier_and_a_state_are_64_random_hex() {
        let (a, b) = (random_hex(), random_hex());
        assert!(is_token(&a) && is_token(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn the_state_must_match_the_cookie() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        assert_eq!(check_state(Some(&a), Some(&a)), Ok(a.as_str()));
        assert!(check_state(Some(&a), Some(&b)).is_err(), "a callback started in another browser");
        assert!(check_state(Some(&a), None).is_err(), "no cookie: refused");
        assert!(check_state(None, Some(&a)).is_err(), "no state: refused");
        assert!(check_state(Some("short"), Some("short")).is_err(), "not one of ours");
        assert!(check_state(Some(&"z".repeat(64)), Some(&"z".repeat(64))).is_err(), "not hex");
    }

    #[test]
    fn the_desktop_param_is_a_lowercase_token_and_never_with_a_link() {
        let t = "a1".repeat(32);
        assert_eq!(desktop_param(None, false), Ok(None));
        assert_eq!(desktop_param(None, true), Ok(None), "a link with no desktop is as before");
        assert_eq!(desktop_param(Some(&t), false), Ok(Some(t.clone())));
        assert!(desktop_param(Some(&t), true).is_err(), "a link from the app is refused");
        assert!(desktop_param(Some(&"A1".repeat(32)), false).is_err(), "uppercase");
        assert!(desktop_param(Some(&"a".repeat(63)), false).is_err(), "short");
        assert!(desktop_param(Some(&"a".repeat(65)), false).is_err(), "long");
        assert!(desktop_param(Some(&"g".repeat(64)), false).is_err(), "not hex");
        assert!(desktop_param(Some(""), false).is_err());
    }

    #[test]
    fn the_desktop_answer_is_all_in_the_fragment() {
        let (code, state) = ("c".repeat(64), "d".repeat(64));
        let to = desktop_url(&code, &state, "pick", "twitch");
        assert_eq!(to, format!("/oauth#desktop={code}&state={state}&next=pick&provider=twitch"));
        let (path, fragment) = to.split_once('#').unwrap();
        assert_eq!(path, PAGE);
        assert!(!path.contains('?') && !path.contains(&code) && !path.contains(&state), "nothing secret reaches the server");
        let pairs: HashMap<String, String> = url::form_urlencoded::parse(fragment.as_bytes()).into_owned().collect();
        assert_eq!(pairs.get("desktop"), Some(&code));
        assert_eq!(pairs.get("state"), Some(&state));
        assert_eq!(pairs.get("next").map(String::as_str), Some("pick"));
        assert_eq!(pairs.get("provider").map(String::as_str), Some("twitch"));
        assert_eq!(HandoffKind::Login { user_id: Uuid::nil() }.next(), "done");
        assert_eq!(HandoffKind::Signup { token: code }.next(), "pick");
    }

    #[test]
    fn a_handoff_comes_only_from_this_site() {
        let mut h = HeaderMap::new();
        assert!(same_origin(&h, Some("https://nodentity.xyz")), "no origin: allowed");
        h.insert(header::ORIGIN, HeaderValue::from_static("https://nodentity.xyz"));
        assert!(same_origin(&h, Some("https://nodentity.xyz")));
        assert!(!same_origin(&h, None), "no public url: nothing matches");
        h.insert(header::ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert!(!same_origin(&h, Some("https://nodentity.xyz")));
        h.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!same_origin(&h, Some("https://nodentity.xyz")));
    }

    #[test]
    fn an_old_started_record_still_parses() {
        let old = r#"{"provider":"google","verifier":"v","link":null}"#;
        let s: Started = serde_json::from_str(old).unwrap();
        assert_eq!(s.desktop, None);
        let h = Handoff { state: "s".into(), kind: HandoffKind::Signup { token: "t".into() }, provider: "kick".into() };
        assert_eq!(serde_json::from_str::<Handoff>(&serde_json::to_string(&h).unwrap()).unwrap(), h);
    }

    async fn handoff_redis() -> Redis {
        let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/15".into());
        crate::connect_redis(&url).await
    }

    fn a_handoff(state: &str) -> Handoff {
        Handoff { state: state.to_owned(), kind: HandoffKind::Login { user_id: Uuid::from_u128(u128::from(std::process::id())) }, provider: "google".into() }
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_handoff_a_code_exchanges_once() {
        let redis = handoff_redis().await;
        let (code, state) = (random_hex(), random_hex());
        let h = a_handoff(&state);
        put_handoff(&redis, &code, &h, HANDOFF_SECS).await.unwrap();
        let ttl: i64 = redis::cmd("TTL").arg(handoff_key(&code)).query_async(&mut redis.clone()).await.unwrap();
        assert!((1..=HANDOFF_SECS as i64).contains(&ttl), "{ttl}");
        assert_eq!(take_handoff(&redis, &code, &state).await.unwrap(), Some(h));
        assert_eq!(take_handoff(&redis, &code, &state).await.unwrap(), None, "used once");
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_handoff_an_expired_code_is_refused() {
        let redis = handoff_redis().await;
        let (code, state) = (random_hex(), random_hex());
        put_handoff(&redis, &code, &a_handoff(&state), HANDOFF_SECS).await.unwrap();
        let _: i64 = redis::cmd("PEXPIRE").arg(handoff_key(&code)).arg(50).query_async(&mut redis.clone()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(take_handoff(&redis, &code, &state).await.unwrap(), None);
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_handoff_a_wrong_state_is_refused_and_spends_the_code() {
        let redis = handoff_redis().await;
        let (code, state) = (random_hex(), random_hex());
        put_handoff(&redis, &code, &a_handoff(&state), HANDOFF_SECS).await.unwrap();
        assert_eq!(take_handoff(&redis, &code, &random_hex()).await.unwrap(), None);
        assert_eq!(take_handoff(&redis, &code, &state).await.unwrap(), None, "the wrong try spent it");
        assert_eq!(take_handoff(&redis, &random_hex(), &state).await.unwrap(), None, "a code never made");
    }

    #[test]
    fn the_cookie_is_read_by_name_only() {
        let mut h = HeaderMap::new();
        let t = "c".repeat(64);
        h.insert(header::COOKIE, HeaderValue::from_str(&format!("login={}; oauth_state={t}", "d".repeat(64))).unwrap());
        assert_eq!(cookie_value(&h, STATE_COOKIE), Some(t));
        assert_eq!(cookie_value(&h, SIGNUP_COOKIE), None);
    }

    #[test]
    fn short_cookies_are_httponly_secure_lax_and_scoped() {
        let c = short_cookie(STATE_COOKIE, "x", 600);
        for part in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/oauth", "Max-Age=600"] {
            assert!(c.contains(part), "{c} lacks {part}");
        }
    }

    #[test]
    fn a_provider_is_on_only_with_both_keys_and_a_public_url() {
        assert!(vars(&[]).enabled().is_empty(), "nothing set: nothing on, no crash");
        let c = vars(&[("PUBLIC_URL", "https://example.org/"), ("GOOGLE_CLIENT_ID", "id"), ("GOOGLE_CLIENT_SECRET", "s"), ("DISCORD_CLIENT_ID", "id")]);
        assert_eq!(c.enabled(), vec![Provider::GOOGLE], "discord has no secret");
        assert_eq!(c.redirect_uri(Provider::GOOGLE).as_deref(), Some("https://example.org/api/oauth/google/callback"));
        let no_url = vars(&[("GOOGLE_CLIENT_ID", "id"), ("GOOGLE_CLIENT_SECRET", "s")]);
        assert!(no_url.enabled().is_empty(), "no PUBLIC_URL: no callback, so off");
        let bad_url = vars(&[("PUBLIC_URL", "not a url"), ("DISCORD_CLIENT_ID", "id"), ("DISCORD_CLIENT_SECRET", "s")]);
        assert!(bad_url.enabled().is_empty());
        let blank = vars(&[("PUBLIC_URL", "https://x.org"), ("DISCORD_CLIENT_ID", "  "), ("DISCORD_CLIENT_SECRET", "s")]);
        assert!(blank.enabled().is_empty(), "a blank id is not an id");
    }

    #[test]
    fn the_public_url_is_an_origin() {
        assert_eq!(clean_public_url("https://Example.org/some/path?x=1").as_deref(), Some("https://example.org"));
        assert_eq!(clean_public_url("https://example.org:8443").as_deref(), Some("https://example.org:8443"));
        assert_eq!(clean_public_url("ftp://example.org"), None);
        assert_eq!(clean_public_url("example.org"), None);
    }

    #[test]
    fn profiles_key_on_the_providers_stable_id() {
        let g = parse_profile(Provider::GOOGLE, &json!({ "sub": "1234", "email": "a@b.c", "email_verified": true, "given_name": "Billy Bob" })).unwrap();
        assert_eq!(
            g,
            Profile { id: "1234".into(), email: Some("a@b.c".into()), suggested: "billy_bob".into(), name: Some("Billy Bob".into()), avatar: None }
        );
        let unverified = parse_profile(Provider::GOOGLE, &json!({ "sub": "1", "email": "a@b.c", "email_verified": false })).unwrap();
        assert_eq!(unverified.email, None, "an unverified email is not kept");
        assert!(parse_profile(Provider::GOOGLE, &json!({ "email": "a@b.c", "email_verified": true })).is_none(), "no sub: nobody");
        let d = parse_profile(Provider::DISCORD, &json!({ "id": "42", "username": "Café.Kid", "email": "d@x.y", "verified": true })).unwrap();
        let default_pic = Some("https://cdn.discordapp.com/embed/avatars/0.png".to_owned());
        assert_eq!(
            d,
            Profile { id: "42".into(), email: Some("d@x.y".into()), suggested: "caf_kid".into(), name: Some("Café.Kid".into()), avatar: default_pic }
        );
        let unverified = parse_profile(Provider::DISCORD, &json!({ "id": "42", "username": "x", "email": "d@x.y", "verified": false })).unwrap();
        assert_eq!(unverified.email, None);
        assert!(parse_profile(Provider::DISCORD, &json!({ "username": "x" })).is_none(), "no id: nobody");
    }

    #[test]
    fn a_profile_keeps_the_providers_name_and_picture() {
        let pic = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";
        let g = parse_profile(Provider::GOOGLE, &json!({ "sub": "1", "name": "Billy Bob", "given_name": "Billy", "picture": pic })).unwrap();
        assert_eq!((g.name.as_deref(), g.avatar.as_deref()), (Some("Billy Bob"), Some(pic)), "name over given_name");
        let g = parse_profile(Provider::GOOGLE, &json!({ "sub": "1", "name": " \u{7}\t ", "given_name": "Billy" })).unwrap();
        assert_eq!(g.name.as_deref(), Some("Billy"), "a name of only blanks falls back to given_name");
        let g = parse_profile(Provider::GOOGLE, &json!({ "sub": "1" })).unwrap();
        assert_eq!((g.name, g.avatar), (None, None));

        let d = parse_profile(
            Provider::DISCORD,
            &json!({ "id": "80351110224678912", "username": "nelly", "global_name": "Nelly", "avatar": "8342729096ea3675442027381ff50dfe" }),
        )
        .unwrap();
        assert_eq!(d.name.as_deref(), Some("Nelly"), "global_name over username");
        assert_eq!(d.avatar.as_deref(), Some("https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png?size=64"));
        let d = parse_profile(Provider::DISCORD, &json!({ "id": "80351110224678912", "username": "nelly", "global_name": null, "avatar": null })).unwrap();
        assert_eq!(d.name.as_deref(), Some("nelly"), "no global_name: the username");
        let d = parse_profile(Provider::DISCORD, &json!({ "id": "4194304", "username": "x" })).unwrap();
        assert_eq!(d.avatar.as_deref(), Some("https://cdn.discordapp.com/embed/avatars/1.png"), "no avatar: the default the id picks");
        let d = parse_profile(Provider::DISCORD, &json!({ "id": "42", "username": "x", "avatar": "../../evil?x=" })).unwrap();
        assert_eq!(d.avatar.as_deref(), Some("https://cdn.discordapp.com/embed/avatars/0.png"), "a hash that is not a hash: the default");
        let d = parse_profile(Provider::DISCORD, &json!({ "id": "not-a-number", "username": "x" })).unwrap();
        assert_eq!(d.avatar, None, "no snowflake: no default to pick");
    }

    #[test]
    fn a_picture_is_kept_only_from_the_providers_image_host() {
        for ok in ["https://lh3.googleusercontent.com/a/x=s96-c", "https://cdn.discordapp.com/embed/avatars/3.png"] {
            assert_eq!(shown_avatar(ok).as_deref(), Some(ok));
        }
        for bad in [
            "http://lh3.googleusercontent.com/a/x",
            "https://lh4.googleusercontent.com/a/x",
            "https://evil.lh3.googleusercontent.com/a/x",
            "https://lh3.googleusercontent.com.evil.com/a/x",
            "https://cdn.discordapp.com:8443/x.png",
            "https://me@cdn.discordapp.com/x.png",
            "https://media.discordapp.net/x.png",
            "javascript:alert(1)",
            "//cdn.discordapp.com/x.png",
            "not a url",
        ] {
            assert_eq!(shown_avatar(bad), None, "{bad}");
        }
        assert_eq!(shown_avatar(&format!("https://cdn.discordapp.com/{}", "a".repeat(600))), None, "too long");
        let g = parse_profile(Provider::GOOGLE, &json!({ "sub": "1", "picture": "https://evil.example/p.png" })).unwrap();
        assert_eq!(g.avatar, None, "a google picture off its host is dropped");
    }

    #[test]
    fn a_shown_name_is_capped_and_has_no_control_characters() {
        assert_eq!(shown_name(Some("  Billy\u{0}\n Bob\u{1b}  ")).as_deref(), Some("Billy Bob"));
        assert_eq!(shown_name(Some("\u{7}\r\n")), None);
        assert_eq!(shown_name(Some("")), None);
        assert_eq!(shown_name(None), None);
        let long = "é".repeat(100);
        assert_eq!(shown_name(Some(&long)).unwrap().chars().count(), SHOWN_NAME_MAX, "64 characters, not bytes");
        assert_eq!(shown_name(Some(&format!("{} b", "a".repeat(63)))).as_deref(), Some("a".repeat(63).as_str()), "no blank left at the cut");
        let d = parse_profile(Provider::DISCORD, &json!({ "id": "1", "username": "u", "global_name": "x".repeat(200) })).unwrap();
        assert_eq!(d.name.unwrap().len(), SHOWN_NAME_MAX);
    }

    #[test]
    fn a_suggested_name_is_a_name_we_allow_or_nothing() {
        assert_eq!(suggest_name("Hello World!"), "hello_world");
        assert_eq!(suggest_name("日本"), "");
        assert_eq!(suggest_name(&"x".repeat(50)).len(), 32);
        for raw in ["Billy", "a.b c", "--__--", "Zoë"] {
            let s = suggest_name(raw);
            assert!(s.is_empty() || valid_name(&s), "{raw} -> {s}");
        }
    }

    #[test]
    fn the_last_way_in_cannot_be_unlinked() {
        let one = vec!["google".to_string()];
        let two = vec!["google".to_string(), "discord".to_string()];
        assert_eq!(may_unlink(false, &one, Provider::GOOGLE), Unlink::LastWayIn);
        assert_eq!(may_unlink(true, &one, Provider::GOOGLE), Unlink::Yes, "the password is still a way in");
        assert_eq!(may_unlink(false, &two, Provider::GOOGLE), Unlink::Yes, "discord is still a way in");
        assert_eq!(may_unlink(true, &one, Provider::DISCORD), Unlink::NotLinked);
    }

    #[test]
    fn slugs_round_trip() {
        for p in Provider::all() {
            assert_eq!(Provider::from_slug(p.slug()), Some(p));
        }
        assert_eq!(Provider::from_slug("github"), None);
        assert_eq!(Provider::from_slug("twitch"), Some(Provider::TWITCH), "twitch is back, through the shared callback");
    }

    #[test]
    fn the_registry_is_well_formed() {
        let slugs: Vec<&str> = PROVIDERS.iter().map(|p| p.slug).collect();
        assert_eq!(slugs, ["google", "discord", "twitch", "kick"]);
        for (i, p) in PROVIDERS.iter().enumerate() {
            assert!(!p.slug.is_empty() && p.slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), "{}", p.slug);
            assert!(p.env.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'), "{}", p.env);
            for url in [p.authorize_url, p.token_url, p.user_url] {
                assert!(url.starts_with("https://"), "{url}");
            }
            assert!(PROVIDERS[i + 1..].iter().all(|q| q.slug != p.slug && q.env != p.env), "{} twice", p.slug);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_a_new_identity_gets_an_account_with_no_password() {
        let pool = auth::tests::test_db().await;
        let run = std::process::id();
        let name = format!("oa-new-{run}");
        let id = create_account(&pool, &name, Provider::GOOGLE, &format!("g-{run}"), &Shown { email: Some("x@y.z"), ..Shown::default() }).await.expect("made");
        let found = linked_account(&pool, Provider::GOOGLE, &format!("g-{run}")).await.unwrap();
        assert_eq!(found, Some(Account { id, name: name.clone() }));
        assert!(!auth::has_password(&pool, id).await.unwrap(), "no password");
        assert!(auth::is_claimed(&pool, &name).await.unwrap(), "but the name is claimed");
        let again = create_account(&pool, &format!("oa-new2-{run}"), Provider::GOOGLE, &format!("g-{run}"), &Shown::default()).await;
        assert_eq!(again.expect_err("linked already").into_response().status(), StatusCode::CONFLICT);
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM streamers WHERE name = $1)").bind(format!("oa-new2-{run}")).fetch_one(&pool).await.unwrap();
        assert!(!exists, "the rolled back account is not left behind");
        let taken = create_account(&pool, &name, Provider::DISCORD, &format!("d-{run}"), &Shown::default()).await;
        assert_eq!(taken.expect_err("taken").into_response().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_linking_and_the_unlink_guard() {
        let pool = auth::tests::test_db().await;
        let run = std::process::id();
        let with_pw = auth::tests::row(&pool, &format!("oa-pw-{run}"), Some("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).await;
        let mut conn = pool.acquire().await.unwrap();
        assert!(!is_verified(&pool, with_pw).await.unwrap(), "a password alone is not oauth verified");
        assert_eq!(link(&mut conn, with_pw, Provider::GOOGLE, &format!("lg-{run}"), &Shown::default()).await.unwrap(), Linked::Yes);
        assert!(is_verified(&pool, with_pw).await.unwrap(), "linked: verified");
        assert_eq!(link(&mut conn, with_pw, Provider::GOOGLE, &format!("lg2-{run}"), &Shown::default()).await.unwrap(), Linked::HasOne, "one google per account");
        let other = create_account(&pool, &format!("oa-only-{run}"), Provider::DISCORD, &format!("ld-{run}"), &Shown::default()).await.unwrap();
        assert!(is_verified(&pool, other).await.unwrap(), "made with a provider: verified");
        assert_eq!(link(&mut conn, other, Provider::GOOGLE, &format!("lg-{run}"), &Shown::default()).await.unwrap(), Linked::Taken, "somebody else's google");
        drop(conn);
        assert_eq!(unlink(&pool, other, Provider::DISCORD).await.unwrap(), Unlink::LastWayIn);
        assert!(is_verified(&pool, other).await.unwrap(), "the refused unlink left it linked");
        assert_eq!(unlink(&pool, with_pw, Provider::GOOGLE).await.unwrap(), Unlink::Yes, "the password is left");
        assert!(!is_verified(&pool, with_pw).await.unwrap(), "nothing linked: not verified");
        assert_eq!(unlink(&pool, with_pw, Provider::GOOGLE).await.unwrap(), Unlink::NotLinked);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(link(&mut conn, other, Provider::GOOGLE, &format!("lg3-{run}"), &Shown::default()).await.unwrap(), Linked::Yes);
        drop(conn);
        assert_eq!(unlink(&pool, other, Provider::DISCORD).await.unwrap(), Unlink::Yes);
        assert_eq!(unlink(&pool, other, Provider::GOOGLE).await.unwrap(), Unlink::LastWayIn);
        let name: String = sqlx::query_scalar("SELECT name FROM streamers WHERE id = $1").bind(other).fetch_one(&pool).await.unwrap();
        assert!(crate::profile::load_profile(&pool, &name).await.unwrap().oauth_verified);
        assert!(!crate::profile::load_profile(&pool, &format!("oa-pw-{run}")).await.unwrap().oauth_verified);
        assert!(!crate::profile::load_profile(&pool, &format!("oa-nobody-{run}")).await.unwrap().oauth_verified, "no row: no mark");
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_a_link_keeps_and_refreshes_the_providers_name_and_picture() {
        let pool = auth::tests::test_db().await;
        let run = std::process::id();
        let pid = format!("sn-{run}");
        async fn shown_of(pool: &sqlx::PgPool, pid: &str) -> (Option<String>, Option<String>, Option<String>) {
            sqlx::query_as("SELECT email, display_name, avatar_url FROM oauth_identities WHERE provider = 'google' AND provider_user_id = $1")
                .bind(pid)
                .fetch_one(pool)
                .await
                .unwrap()
        }
        let pic = "https://lh3.googleusercontent.com/a/one";
        let shown = Shown { email: Some("a@b.c"), name: Some("Billy"), avatar: Some(pic) };
        create_account(&pool, &format!("oa-shown-{run}"), Provider::GOOGLE, &pid, &shown).await.unwrap();
        assert_eq!(shown_of(&pool, &pid).await, (Some("a@b.c".into()), Some("Billy".into()), Some(pic.into())), "kept on insert");
        let next = Profile { id: pid.clone(), email: None, suggested: String::new(), name: Some("Billy B".into()), avatar: None };
        refresh(&pool, Provider::GOOGLE, &next).await;
        assert_eq!(shown_of(&pool, &pid).await, (Some("a@b.c".into()), Some("Billy B".into()), None));
        let next = Profile { email: Some("new@b.c".into()), avatar: Some(pic.into()), ..next };
        refresh(&pool, Provider::GOOGLE, &next).await;
        assert_eq!(shown_of(&pool, &pid).await, (Some("new@b.c".into()), Some("Billy B".into()), Some(pic.into())));
    }

    #[test]
    fn twitch_and_kick_come_back_to_the_registered_callbacks() {
        let c = vars(&[
            ("PUBLIC_URL", "https://nodentity.xyz"),
            ("TWITCH_CLIENT_ID", "t"),
            ("TWITCH_CLIENT_SECRET", "ts"),
            ("KICK_CLIENT_ID", "k"),
            ("KICK_CLIENT_SECRET", "ks"),
        ]);
        assert_eq!(c.enabled(), vec![Provider::TWITCH, Provider::KICK]);
        assert_eq!(c.redirect_uri(Provider::TWITCH).as_deref(), Some("https://nodentity.xyz/api/auth/twitch/callback"));
        assert_eq!(c.redirect_uri(Provider::KICK).as_deref(), Some("https://nodentity.xyz/api/auth/kick/callback"));
        assert_eq!(TWITCH.scope, "user:read:email");
        assert_eq!(KICK.scope, "user:read");
        assert!(Provider::TWITCH.streams() && Provider::KICK.streams() && !Provider::GOOGLE.streams());
        assert_eq!(Provider::TWITCH.taken(), "that twitch is already linked to another account");
        assert!(path_cookie(STATE_COOKIE, "x", 600, SHARED_BASE).contains("Path=/api/auth;"));
        assert!(gone_state().iter().any(|c| c.contains("Path=/api/auth;")) && gone_state().iter().any(|c| c.contains("Path=/api/oauth;")));
    }

    #[test]
    fn twitch_and_kick_profiles_parse() {
        let t = parse_profile(
            Provider::TWITCH,
            &json!({ "data": [{ "id": "141981764", "login": "twitchdev", "display_name": "TwitchDev", "email": "a@b.c", "profile_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-300x300.png" }] }),
        )
        .unwrap();
        assert_eq!((t.id.as_str(), t.suggested.as_str(), t.name.as_deref(), t.email.as_deref()), ("141981764", "twitchdev", Some("TwitchDev"), Some("a@b.c")));
        assert!(t.avatar.is_some());
        let k = parse_profile(Provider::KICK, &json!({ "data": [{ "user_id": 123, "name": "Billy Z", "email": "k@b.c", "profile_picture": "https://files.kick.com/images/user/1/profile_image/a.webp" }] })).unwrap();
        assert_eq!((k.id.as_str(), k.suggested.as_str(), k.name.as_deref()), ("123", "billy_z", Some("Billy Z")));
        assert!(k.avatar.is_some());
        assert!(parse_profile(Provider::KICK, &json!({ "data": [] })).is_none());
        assert!(parse_profile(Provider::TWITCH, &json!({ "data": [{ "login": "x" }] })).is_none());
        let elsewhere = parse_profile(Provider::KICK, &json!({ "data": [{ "user_id": "9", "name": "x", "profile_picture": "https://evil.example/a.png" }] })).unwrap();
        assert_eq!(elsewhere.avatar, None);
    }

    async fn destination(pool: &sqlx::PgPool, user: Uuid, platform: &str, external_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO stream_destinations (user_id, platform, external_id, external_name) VALUES ($1, $2, $3, 'x')")
            .bind(user)
            .bind(platform)
            .bind(external_id)
            .execute(pool)
            .await
            .map(|_| ())
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_a_twitch_login_makes_one_account_and_finds_it_again() {
        let pool = auth::tests::test_db().await;
        let run = std::process::id();
        let tid = format!("tw-login-{run}");
        assert_eq!(login_owner(&pool, Provider::TWITCH, &tid, &Shown::default()).await.unwrap(), None, "nobody yet: the pick a name page");
        let name = format!("oa-tw-{run}");
        let id = create_account(&pool, &name, Provider::TWITCH, &tid, &Shown::default()).await.expect("made");
        assert_eq!(login_owner(&pool, Provider::TWITCH, &tid, &Shown::default()).await.unwrap(), Some(Account { id, name: name.clone() }));
        assert_eq!(login_owner(&pool, Provider::TWITCH, &tid, &Shown::default()).await.unwrap().map(|a| a.id), Some(id), "the second login reuses it");
        let second = create_account(&pool, &format!("oa-tw2-{run}"), Provider::TWITCH, &tid, &Shown::default()).await;
        assert_eq!(second.expect_err("one account per twitch").into_response().status(), StatusCode::CONFLICT);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_identities WHERE provider = 'twitch' AND provider_user_id = $1").bind(&tid).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_a_twitch_connected_for_streaming_logs_into_its_owner() {
        let pool = auth::tests::test_db().await;
        let run = std::process::id();
        let a = auth::tests::row(&pool, &format!("oa-dest-a-{run}"), Some("hash")).await;
        let b = auth::tests::row(&pool, &format!("oa-dest-b-{run}"), Some("hash")).await;
        let kid = format!("kick-{run}");
        destination(&pool, a, "kick", &kid).await.unwrap();
        let owner = login_owner(&pool, Provider::KICK, &kid, &Shown::default()).await.unwrap().expect("a");
        assert_eq!(owner.id, a);
        assert_eq!(linked_account(&pool, Provider::KICK, &kid).await.unwrap().map(|o| o.id), Some(a), "and it is a way in from now on");
        let signup = create_account(&pool, &format!("oa-dest-new-{run}"), Provider::KICK, &kid, &Shown::default()).await;
        assert_eq!(signup.expect_err("no second account").into_response().status(), StatusCode::CONFLICT);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(link(&mut conn, b, Provider::KICK, &kid, &Shown::default()).await.unwrap(), Linked::Taken, "b cannot take a's kick");
        assert!(destination(&pool, b, "kick", &kid).await.is_err_and(|e| unique_violation(&e)), "nor stream to it");
    }

    #[tokio::test]
    #[ignore]
    async fn oauth_one_twitch_belongs_to_one_login() {
        let pool = auth::tests::test_db().await;
        let run = std::process::id();
        let a = auth::tests::row(&pool, &format!("oa-one-a-{run}"), Some("hash")).await;
        let b = auth::tests::row(&pool, &format!("oa-one-b-{run}"), Some("hash")).await;
        let tid = format!("tw-one-{run}");
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(link(&mut conn, a, Provider::TWITCH, &tid, &Shown::default()).await.unwrap(), Linked::Yes);
        assert_eq!(link(&mut conn, a, Provider::TWITCH, &tid, &Shown::default()).await.unwrap(), Linked::Taken, "already there");
        assert_eq!(linked_account(&pool, Provider::TWITCH, &tid).await.unwrap().map(|o| o.id), Some(a));
        assert_eq!(link(&mut conn, b, Provider::TWITCH, &tid, &Shown::default()).await.unwrap(), Linked::Taken);
        let err = destination(&pool, b, "twitch", &tid).await.expect_err("b cannot stream to a's twitch");
        assert!(unique_violation(&err));
        destination(&pool, a, "twitch", &tid).await.expect("a can");
        let other = format!("tw-other-{run}");
        assert_eq!(link(&mut conn, a, Provider::TWITCH, &other, &Shown::default()).await.unwrap(), Linked::HasOne);
        let dup = sqlx::query("UPDATE stream_destinations SET user_id = $1 WHERE platform = 'twitch' AND external_id = $2").bind(b).bind(&tid).execute(&pool).await;
        assert!(dup.is_err_and(|e| unique_violation(&e)), "moving it to b is refused too");
    }
}
