//! Log in with Google or Discord (or any provider in `PROVIDERS`), next to the password. See
//! docs/accounts.md.
//!
//! The authorization-code flow with PKCE (S256) and a random `state`:
//!
//! 1. `GET /api/oauth/{provider}/start` (`?link=1` when logged in, to attach the provider to
//!    this account). A fresh `state` and PKCE verifier go into redis for ten minutes, the state
//!    also into a short HttpOnly cookie on `/api/oauth`, and the browser goes to the provider.
//! 2. `GET /api/oauth/{provider}/callback?code&state`. The state in the query must equal the
//!    cookie's (a callback started in somebody else's browser is refused: no login csrf), and is
//!    taken out of redis in one GETDEL (used once). The code is traded for a token with the
//!    verifier and the client secret, over https, and the provider's user endpoint says who it is.
//! 3. Who it is, by the provider's stable user id (never the email, never the display name):
//!    - linked already: logged in, the same login cookie as a password login (`auth::open_login`).
//!    - `link` and still logged in as the account that started: linked to it.
//!    - nobody's: a pending signup in redis (15 minutes, its own HttpOnly cookie), and the pages
//!      ask for a name (`/oauth?pick=1`). `POST /api/oauth/signup {name}` makes the account under
//!      the same name rules as a password signup, with no password (`auth::NO_PASSWORD`).
//!
//!    An email that matches another account's is never a reason to link: a provider's email is
//!    whatever that provider let somebody type.
//!
//! An account with at least one provider linked is *oauth verified* (`linked_sql!`): the mark
//! next to its name. Any provider counts, so a new entry in `PROVIDERS` counts with no change.
//!
//! Config is the environment: `<ENV>_CLIENT_ID` and `<ENV>_CLIENT_SECRET` for each provider in
//! `PROVIDERS` (GOOGLE, DISCORD), and PUBLIC_URL (the callback is
//! `{PUBLIC_URL}/api/oauth/{provider}/callback`). A provider without both, or every provider
//! without PUBLIC_URL, is off; nothing crashes.

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
use crate::{unique_violation, valid_name, ApiError, ApiResult, AppState};

/// How long a started login may take at the provider.
const STATE_SECS: u64 = 600;
/// How long a new identity may take to pick its name.
const SIGNUP_SECS: u64 = 900;
const STATE_COOKIE: &str = "oauth_state";
const SIGNUP_COOKIE: &str = "oauth_signup";
/// Where the pages pick up after the provider (frontend/src/app/auth/OAuthPage.tsx).
const PAGE: &str = "/oauth";

/// The oauth-verified mark as SQL, for the `streamers` row named by the alias: whether it has
/// any outside login linked. An EXISTS rather than a kept column: it cannot drift from the
/// links, and it is one probe of `oauth_identities`' unique (user_id, provider) index (user_id
/// leads) per row, inside whatever query already reads the row. No N+1, no extra round trip.
macro_rules! linked_sql {
    ($row:literal) => {
        concat!("EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = ", $row, ".id)")
    };
}
pub(crate) use linked_sql;

// ---- providers and config ------------------------------------------------------------------

/// Everything that differs between two providers. A new provider is one entry in `PROVIDERS`,
/// its two env vars, and its callback url in the provider's console: the routes, the buttons,
/// the security tab and the verified mark all go by this list. (The pages have an icon per
/// slug, and a plain one for a slug they do not know: frontend/src/infra/oauth.ts.)
pub(crate) struct Spec {
    /// In the urls and the database: `[a-z0-9_]`, never changed once people have linked it.
    slug: &'static str,
    /// `<env>_CLIENT_ID`, `<env>_CLIENT_SECRET`.
    env: &'static str,
    /// For words a person reads.
    label: &'static str,
    authorize_url: &'static str,
    token_url: &'static str,
    /// Who the token belongs to.
    user_url: &'static str,
    scope: &'static str,
    /// More query pairs on the way to the provider.
    authorize_extra: &'static [(&'static str, &'static str)],
    /// The user endpoint's answer, read. None when it has no stable id.
    parse: fn(&Value) -> Option<Profile>,
}

const GOOGLE: Spec = Spec {
    slug: "google",
    env: "GOOGLE",
    label: "Google",
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    // the OpenID userinfo endpoint: the answer comes straight from Google over tls for a token
    // we just got from Google, so no ID token has to be verified by hand
    user_url: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    authorize_extra: &[("prompt", "select_account")],
    parse: parse_google,
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
};

/// Every provider this api knows, in the order the buttons show them.
const PROVIDERS: &[Spec] = &[GOOGLE, DISCORD];

/// One of `PROVIDERS`. Equal by slug.
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
}

#[derive(Clone)]
struct Client {
    id: String,
    secret: String,
}

/// What the environment turned on. Read once at boot (`from_env`).
#[derive(Clone, Default)]
pub(crate) struct Config {
    /// `https://example.org`, no trailing slash. None: every provider is off.
    public_url: Option<String>,
    clients: HashMap<Provider, Client>,
}

impl Config {
    pub(crate) fn from_env() -> Self {
        let config = Self::from_vars(|k| std::env::var(k).ok());
        let on: Vec<&str> = config.enabled().into_iter().map(Provider::slug).collect();
        match (&config.public_url, on.is_empty()) {
            (_, true) => log::info!("oauth: no provider set up (<P>_CLIENT_ID and _SECRET for {:?}, and PUBLIC_URL)", PROVIDERS.iter().map(|p| p.env).collect::<Vec<_>>()),
            (Some(url), false) => log::info!("oauth: {on:?}, callbacks at {url}/api/oauth/<provider>/callback"),
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
        Some(format!("{}/api/oauth/{}/callback", self.public_url.as_ref()?, p.slug()))
    }
}

/// An http(s) url with a host, as the origin the browser types: no path, no trailing slash.
fn clean_public_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

// ---- state and pkce --------------------------------------------------------------------------

/// 32 random bytes, hex: the state, the verifier and the signup token are each one.
/// 64 characters of [0-9a-f] is a valid PKCE verifier (43 to 128 unreserved characters).
fn random_hex() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// base64url without padding (RFC 4648 §5), for the S256 challenge.
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

/// RFC 7636: BASE64URL(SHA256(verifier)).
fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// The callback's `state` against the cookie set at the start: both there, both ours, the same.
fn check_state<'a>(query: Option<&'a str>, cookie: Option<&str>) -> Result<&'a str, &'static str> {
    let query = query.filter(|s| is_token(s)).ok_or("that login link is broken. try again")?;
    let cookie = cookie.filter(|s| is_token(s)).ok_or("that login started in another browser, or ran out. try again")?;
    // both are ours and random, and the redis entry is the real check; still, no early exit
    let same = query.len() == cookie.len() && query.bytes().zip(cookie.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if same {
        Ok(query)
    } else {
        Err("that login started in another browser. try again")
    }
}

/// A started login, in redis under its state.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Started {
    provider: String,
    verifier: String,
    /// The account to attach to, for `?link=1`.
    link: Option<Uuid>,
}

/// Somebody the providers know and we do not, picking a name. In redis under its token.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
struct Newcomer {
    provider: String,
    provider_user_id: String,
    email: Option<String>,
    suggested: String,
    /// What the provider shows (`Profile`), for the identity row. Absent in one saved before.
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

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|kv| kv.trim().strip_prefix(prefix.as_str()).map(str::to_owned))
        .find(|t| is_token(t))
}

/// HttpOnly, Secure, Lax (the provider's redirect back is a top-level GET, which Lax sends),
/// and only on `/api/oauth`: no other route ever sees it.
fn short_cookie(name: &str, value: &str, secs: u64) -> String {
    format!("{name}={value}; Path=/api/oauth; Max-Age={secs}; HttpOnly; Secure; SameSite=Lax")
}

fn gone_cookie(name: &str) -> String {
    format!("{name}=; Path=/api/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Lax")
}

fn redirect_with(to: &str, cookies: &[String]) -> Response {
    let mut res = Redirect::to(to).into_response();
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

/// Back to the pages with words a person can read; the state cookie goes either way.
fn fail(words: &str) -> Response {
    redirect_with(&page_url("error", words), &[gone_cookie(STATE_COOKIE)])
}

// ---- the provider's side --------------------------------------------------------------------

/// Who the provider says this is.
#[derive(Debug, PartialEq, Clone)]
struct Profile {
    /// The provider's own id for the account: google's `sub`, discord's `id`.
    id: String,
    /// Only when the provider says it is verified.
    email: Option<String>,
    /// The provider's handle, made into a name we allow, for the pick-a-name box.
    suggested: String,
    /// The name the provider shows, cleaned (`shown_name`). Only for the account's own
    /// security tab: never who it is, never a reason to link.
    name: Option<String>,
    /// The provider's picture, only on its own image host (`shown_avatar`).
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

/// Discord's picture for the account: its own when it set one, else the default one its id
/// picks (discord's newer rule, `(id >> 22) % 6`).
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

/// The longest provider name kept, in characters.
const SHOWN_NAME_MAX: usize = 64;

/// A provider's display name as kept: no control characters, trimmed, at most
/// `SHOWN_NAME_MAX` characters. None when nothing is left.
fn shown_name(raw: Option<&str>) -> Option<String> {
    let clean: String = raw?.chars().filter(|c| !c.is_control()).collect();
    let capped: String = clean.trim().chars().take(SHOWN_NAME_MAX).collect();
    Some(capped.trim_end().to_owned()).filter(|n| !n.is_empty())
}

/// The only hosts a provider picture is kept from.
const AVATAR_HOSTS: [&str; 2] = ["lh3.googleusercontent.com", "cdn.discordapp.com"];

/// A provider picture as kept: https, exactly one of `AVATAR_HOSTS`, no port, no login part,
/// 512 characters at most. Anything else is None, and the tab draws the provider's icon.
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

/// The provider's user answer, read. None when it has no stable id.
fn parse_profile(p: Provider, v: &Value) -> Option<Profile> {
    (p.0.parse)(v)
}

/// A handle as a name we allow (a-z 0-9 _ -, 1 to 32), or empty. Only a suggestion: the
/// person picks, and the pick goes through every signup rule.
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
            // a token endpoint that redirects is not one to follow with a client secret
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .build()
            .expect("oauth http client")
    })
}

/// The code for a token, then the token for a profile. Errors are logged and come back as one
/// word for the person: what the provider said is for the log, not for the page.
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
        .map_err(|e| log::warn!("oauth {}: token: {e}", p.slug()))?;
    if !res.status().is_success() {
        log::warn!("oauth {}: token: http {}", p.slug(), res.status());
        return Err(());
    }
    let token: Value = res.json().await.map_err(|e| log::warn!("oauth {}: token body: {e}", p.slug()))?;
    let access = token.get("access_token").and_then(Value::as_str).ok_or_else(|| log::warn!("oauth {}: no access_token", p.slug()))?;
    let res = http()
        .get(p.0.user_url)
        .bearer_auth(access)
        .header(header::ACCEPT, "application/json")
        .send().await.map_err(|e| log::warn!("oauth {}: user: {e}", p.slug()))?;
    if !res.status().is_success() {
        log::warn!("oauth {}: user: http {}", p.slug(), res.status());
        return Err(());
    }
    let body: Value = res.json().await.map_err(|e| log::warn!("oauth {}: user body: {e}", p.slug()))?;
    parse_profile(p, &body).ok_or_else(|| log::warn!("oauth {}: user answer has no id", p.slug()))
}

// ---- the database ---------------------------------------------------------------------------

/// The account a provider's user is linked to, if any.
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

/// Whether this account is oauth verified: any provider linked (`linked_sql!`). The routes read
/// the mark inside the queries that already read the row; this is the one-account form.
#[cfg(test)]
pub(crate) async fn is_verified(db: &sqlx::PgPool, user: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(concat!("SELECT ", linked_sql!("s"), " FROM streamers s WHERE s.id = $1"))
        .bind(user)
        .fetch_optional(db)
        .await
        .map(|v| v.unwrap_or(false))
}

/// What a link keeps beside the provider's id: the verified email, and the name and picture
/// the provider shows. Each None when the provider gave none.
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

/// The provider's latest for a linked identity, on every login and link with it: a new verified
/// email (an unverified or missing one keeps the old), and the name and picture as they are now.
/// Best effort: a failure here never stops the login.
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

/// Attach. `Ok(false)`: that provider account is somebody's already, or this account has that
/// provider already (the two unique keys); nothing changed.
pub(crate) async fn link(conn: &mut sqlx::PgConnection, user: Uuid, p: Provider, provider_user_id: &str, shown: &Shown<'_>) -> Result<bool, sqlx::Error> {
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
        Ok(_) => Ok(true),
        Err(e) if unique_violation(&e) => Ok(false),
        Err(e) => Err(e),
    }
}

/// May this account let go of `p`? Not when it is not linked, and not when it is the last way
/// in: no password and no other provider.
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

/// The unlink, under a lock on the account's row: two unlinks at once (two tabs, one for each
/// provider) cannot both pass the last-way-in check.
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

/// A new account under `name` for a newcomer, with no password, and the provider linked, in
/// one transaction. A free row under the name (somebody used it without an account) is claimed
/// the way a password signup claims it. `name taken` when it is somebody's; a 409 with other
/// words when the provider account got linked meanwhile (two tabs).
pub(crate) async fn create_account(db: &sqlx::PgPool, name: &str, p: Provider, provider_user_id: &str, shown: &Shown<'_>) -> Result<Uuid, ApiError> {
    let mut tx = db.begin().await?;
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO streamers (name, password_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash
         WHERE streamers.password_hash IS NULL
         RETURNING id",
    )
    .bind(name)
    .bind(auth::NO_PASSWORD)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else { return Err(ApiError::new(StatusCode::CONFLICT, "name taken")) };
    if !link(&mut tx, id, p, provider_user_id, shown).await? {
        return Err(ApiError::new(StatusCode::CONFLICT, "that account is linked already. log in with it"));
    }
    tx.commit().await?;
    Ok(id)
}

// ---- routes ---------------------------------------------------------------------------------

#[derive(Deserialize)]
struct StartQuery {
    #[serde(default)]
    link: Option<String>,
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
    let (client, redirect_uri) = (s.oauth.client(p).expect("checked"), s.oauth.redirect_uri(p).expect("checked"));
    let state = random_hex();
    let verifier = random_hex();
    let started = Started { provider: p.slug().to_owned(), verifier: verifier.clone(), link };
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
    Ok(redirect_with(to.as_str(), &[short_cookie(STATE_COOKIE, &state, STATE_SECS)]))
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(State(s): State<AppState>, Path(slug): Path<String>, Query(q): Query<CallbackQuery>, headers: HeaderMap) -> Result<Response, ApiError> {
    let Some(p) = Provider::from_slug(&slug).filter(|p| s.oauth.client(*p).is_some()) else {
        return Ok(fail("that login is not set up here"));
    };
    if q.error.is_some() {
        return Ok(fail(&format!("{} said no, or you cancelled", p.label())));
    }
    let cookie = cookie_value(&headers, STATE_COOKIE);
    let state = match check_state(q.state.as_deref(), cookie.as_deref()) {
        Ok(state) => state,
        Err(words) => return Ok(fail(words)),
    };
    // used once: a replayed callback finds nothing
    let raw: Option<String> = redis::cmd("GETDEL").arg(state_key(state)).query_async(&mut s.redis.clone()).await?;
    let Some(started) = raw.and_then(|r| serde_json::from_str::<Started>(&r).ok()) else {
        return Ok(fail("that login ran out. try again"));
    };
    if started.provider != p.slug() {
        return Ok(fail("that login link is broken. try again"));
    }
    let Some(code) = q.code.filter(|c| !c.is_empty() && c.len() <= 2048) else {
        return Ok(fail("that login link is broken. try again"));
    };
    let Ok(profile) = who_is_it(&s.oauth, p, &code, &started.verifier).await else {
        return Ok(fail(&format!("could not reach {}. try again", p.label())));
    };
    let linked = linked_account(&s.db, p, &profile.id).await?;

    // attach to the account that started it, if that is still who is logged in here
    if let Some(want) = started.link {
        let me = auth::whoami(&s.db, &headers).await?;
        if me.as_ref().map(|m| m.id) != Some(want) {
            return Ok(fail("log in again, then link"));
        }
        return Ok(match linked {
            Some(owner) if owner.id == want => {
                refresh(&s.db, p, &profile).await;
                redirect_with(&page_url("linked", p.slug()), &[gone_cookie(STATE_COOKIE)])
            }
            Some(_) => fail(&format!("that {} account is linked to another account here", p.label())),
            None => {
                let mut conn = s.db.acquire().await?;
                if link(&mut conn, want, p, &profile.id, &Shown::of(&profile)).await? {
                    log::info!("{}: linked {}", me.map(|m| m.name).unwrap_or_default(), p.slug());
                    redirect_with(&page_url("linked", p.slug()), &[gone_cookie(STATE_COOKIE)])
                } else {
                    fail(&format!("this account has a {} login already. unlink it first", p.label()))
                }
            }
        });
    }

    // known: logged in, the same login a password makes
    if let Some(account) = linked {
        refresh(&s.db, p, &profile).await;
        let token = auth::open_login(&s.db, &account).await?;
        log::info!("{}: logged in with {}", account.name, p.slug());
        return Ok(redirect_with(&page_url("done", p.slug()), &[gone_cookie(STATE_COOKIE), auth::set_cookie(&token)]));
    }

    // new here: pick a name first
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
    Ok(redirect_with(&page_url("pick", p.slug()), &[gone_cookie(STATE_COOKIE), short_cookie(SIGNUP_COOKIE, &token, SIGNUP_SECS)]))
}

async fn newcomer(s: &AppState, headers: &HeaderMap) -> Result<Option<(String, Newcomer)>, ApiError> {
    let Some(token) = cookie_value(headers, SIGNUP_COOKIE) else { return Ok(None) };
    let raw: Option<String> = redis::cmd("GET").arg(signup_key(&token)).query_async(&mut s.redis.clone()).await?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).map(|n| (token, n)))
}

/// `GET /api/oauth/signup`: the pending newcomer's provider and suggested name. Never its email.
async fn signup_info(State(s): State<AppState>, headers: HeaderMap) -> ApiResult {
    let Some((_, n)) = newcomer(&s, &headers).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "nothing to finish. start the login again"));
    };
    Ok(Json(json!({ "provider": n.provider, "suggested": n.suggested })))
}

#[derive(Deserialize)]
struct Pick {
    name: String,
}

/// `POST /api/oauth/signup {name}`: the account, named, with the provider linked, and logged in.
async fn signup_finish(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<Pick>, JsonRejection>) -> Result<Response, ApiError> {
    let Json(body) = body?;
    let Some((token, n)) = newcomer(&s, &headers).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "nothing to finish. start the login again"));
    };
    let p = Provider::from_slug(&n.provider).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "nothing to finish. start the login again"))?;
    // the same rules as a password signup (auth.rs `signup`)
    let name = body.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError::bad_name());
    }
    if name.starts_with(&s.dummy_prefix) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "reserved name"));
    }
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

/// `GET /api/oauth/providers`: the ones turned on here, for the buttons. Public.
async fn providers(State(s): State<AppState>) -> Json<Value> {
    Json(json!({ "providers": s.oauth.enabled().into_iter().map(Provider::slug).collect::<Vec<_>>() }))
}

/// An identity as the tab reads it: provider, linked at, and the name and picture it shows.
type IdentityRow = (String, DateTime<Utc>, Option<String>, Option<String>);

/// `GET /api/oauth/identities`: this login's linked providers, whether it has a password, and
/// whether it is oauth verified. Each identity has the name and picture its provider shows
/// (null for one linked before they were kept, until its next login). The provider emails stay
/// in the database.
async fn identities(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let rows: Vec<IdentityRow> = sqlx::query_as("SELECT provider, created_at, display_name, avatar_url FROM oauth_identities WHERE user_id = $1 ORDER BY created_at")
        .bind(me.id)
        .fetch_all(&s.db)
        .await?;
    let has_password = auth::has_password(&s.db, me.id).await?;
    // oauth verified is exactly "anything linked" (`linked_sql!`), said here so the tab need not work it out
    let verified = !rows.is_empty();
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(provider, at, name, avatar)| json!({ "provider": provider, "linked_at": at, "name": name, "avatar": avatar }))
        .collect();
    Ok(Json(json!({ "has_password": has_password, "oauth_verified": verified, "identities": list })))
}

/// `POST /api/oauth/{provider}/unlink`. Refused when it would leave no way in.
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
        .route("/api/oauth/providers", get(providers))
        .route("/api/oauth/identities", get(identities))
        .route("/api/oauth/signup", get(signup_info).post(signup_finish))
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
        // RFC 7636 appendix B
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
        // (80351110224678912 >> 22) % 6 == 19156530 % 6 == 0; this one is 1
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
        assert_eq!(Provider::from_slug("twitch"), None, "twitch is gone");
    }

    #[test]
    fn the_registry_is_well_formed() {
        let slugs: Vec<&str> = PROVIDERS.iter().map(|p| p.slug).collect();
        assert_eq!(slugs, ["google", "discord"]);
        for (i, p) in PROVIDERS.iter().enumerate() {
            // the slug is a url segment and a database key (schema.sql's check)
            assert!(!p.slug.is_empty() && p.slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), "{}", p.slug);
            assert!(p.env.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'), "{}", p.env);
            for url in [p.authorize_url, p.token_url, p.user_url] {
                assert!(url.starts_with("https://"), "{url}");
            }
            assert!(PROVIDERS[i + 1..].iter().all(|q| q.slug != p.slug && q.env != p.env), "{} twice", p.slug);
        }
    }

    // ---- against a postgres (`auth::tests::test_db`): cargo test -- --ignored oauth

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
        // the same provider account again (a second tab): refused, and no second account
        let again = create_account(&pool, &format!("oa-new2-{run}"), Provider::GOOGLE, &format!("g-{run}"), &Shown::default()).await;
        assert_eq!(again.expect_err("linked already").into_response().status(), StatusCode::CONFLICT);
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM streamers WHERE name = $1)").bind(format!("oa-new2-{run}")).fetch_one(&pool).await.unwrap();
        assert!(!exists, "the rolled back account is not left behind");
        // a name with an account is taken
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
        assert!(link(&mut conn, with_pw, Provider::GOOGLE, &format!("lg-{run}"), &Shown::default()).await.unwrap());
        assert!(is_verified(&pool, with_pw).await.unwrap(), "linked: verified");
        assert!(!link(&mut conn, with_pw, Provider::GOOGLE, &format!("lg2-{run}"), &Shown::default()).await.unwrap(), "one google per account");
        let other = create_account(&pool, &format!("oa-only-{run}"), Provider::DISCORD, &format!("ld-{run}"), &Shown::default()).await.unwrap();
        assert!(is_verified(&pool, other).await.unwrap(), "made with a provider: verified");
        assert!(!link(&mut conn, other, Provider::GOOGLE, &format!("lg-{run}"), &Shown::default()).await.unwrap(), "somebody else's google");
        drop(conn);
        assert_eq!(unlink(&pool, other, Provider::DISCORD).await.unwrap(), Unlink::LastWayIn);
        assert!(is_verified(&pool, other).await.unwrap(), "the refused unlink left it linked");
        assert_eq!(unlink(&pool, with_pw, Provider::GOOGLE).await.unwrap(), Unlink::Yes, "the password is left");
        assert!(!is_verified(&pool, with_pw).await.unwrap(), "nothing linked: not verified");
        assert_eq!(unlink(&pool, with_pw, Provider::GOOGLE).await.unwrap(), Unlink::NotLinked);
        // a no-password account with two providers may let go of one, never the second
        let mut conn = pool.acquire().await.unwrap();
        assert!(link(&mut conn, other, Provider::GOOGLE, &format!("lg3-{run}"), &Shown::default()).await.unwrap());
        drop(conn);
        assert_eq!(unlink(&pool, other, Provider::DISCORD).await.unwrap(), Unlink::Yes);
        assert_eq!(unlink(&pool, other, Provider::GOOGLE).await.unwrap(), Unlink::LastWayIn);
        // the mark where the pages read it: the profile, and a free name never wears it
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
        // the next login: a new name, no picture, no verified email (the old email stays)
        let next = Profile { id: pid.clone(), email: None, suggested: String::new(), name: Some("Billy B".into()), avatar: None };
        refresh(&pool, Provider::GOOGLE, &next).await;
        assert_eq!(shown_of(&pool, &pid).await, (Some("a@b.c".into()), Some("Billy B".into()), None));
        let next = Profile { email: Some("new@b.c".into()), avatar: Some(pic.into()), ..next };
        refresh(&pool, Provider::GOOGLE, &next).await;
        assert_eq!(shown_of(&pool, &pid).await, (Some("new@b.c".into()), Some("Billy B".into()), Some(pic.into())));
    }
}
