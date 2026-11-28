use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{self, Me};
use crate::oauth::{check_state, clean_public_url, cookie_value, pkce_challenge, random_hex};
use crate::{ApiError, ApiResult, AppState};

const STATE_SECS: u64 = 600;
const STATE_COOKIE: &str = "dest_state";
const PAGE: &str = "/live";
const REFRESH_AHEAD_SECS: i64 = 120;
const NAME_MAX: usize = 40;
const URL_MAX: usize = 512;
const KEY_MAX: usize = 512;
const TITLE_MAX: usize = 140;
const CATEGORY_MAX: usize = 100;
const YOUTUBE_TITLE_MAX: usize = 100;
const YOUTUBE_STREAM: &str = "slop";
const PRIVACY: [&str; 3] = ["unlisted", "public", "private"];

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Platform {
    Twitch,
    Kick,
    Youtube,
}

impl Platform {
    const ALL: [Platform; 3] = [Platform::Twitch, Platform::Kick, Platform::Youtube];

    pub(crate) fn slug(self) -> &'static str {
        match self {
            Platform::Twitch => "twitch",
            Platform::Kick => "kick",
            Platform::Youtube => "youtube",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Platform::Twitch => "Twitch",
            Platform::Kick => "Kick",
            Platform::Youtube => "YouTube",
        }
    }

    fn env(self) -> &'static str {
        match self {
            Platform::Twitch => "TWITCH",
            Platform::Kick => "KICK",
            Platform::Youtube => "YOUTUBE",
        }
    }

    fn from_slug(slug: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.slug() == slug)
    }

    pub(crate) fn scope(self) -> &'static str {
        match self {
            Platform::Twitch => "user:read:email channel:read:stream_key channel:manage:broadcast user:read:chat user:write:chat",
            Platform::Kick => "user:read channel:read channel:write streamkey:read chat:write events:subscribe",
            Platform::Youtube => "https://www.googleapis.com/auth/youtube",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Spec {
    pub(crate) authorize_url: String,
    pub(crate) token_url: String,
    pub(crate) revoke_url: String,
    pub(crate) api_url: String,
}

impl Spec {
    fn of(p: Platform) -> Self {
        match p {
            Platform::Twitch => Spec {
                authorize_url: "https://id.twitch.tv/oauth2/authorize".into(),
                token_url: "https://id.twitch.tv/oauth2/token".into(),
                revoke_url: "https://id.twitch.tv/oauth2/revoke".into(),
                api_url: "https://api.twitch.tv/helix".into(),
            },
            Platform::Kick => Spec {
                authorize_url: "https://id.kick.com/oauth/authorize".into(),
                token_url: "https://id.kick.com/oauth/token".into(),
                revoke_url: "https://id.kick.com/oauth/revoke".into(),
                api_url: "https://api.kick.com/public/v1".into(),
            },
            Platform::Youtube => Spec {
                authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
                token_url: "https://oauth2.googleapis.com/token".into(),
                revoke_url: "https://oauth2.googleapis.com/revoke".into(),
                api_url: "https://www.googleapis.com/youtube/v3".into(),
            },
        }
    }
}

const TWITCH_INGEST: &str = "rtmps://live.twitch.tv:443/app";

#[derive(Clone)]
struct App {
    id: String,
    secret: String,
    spec: Spec,
}

pub(crate) struct Sealer(Aes256Gcm);

impl Sealer {
    pub(crate) fn from_base64(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(raw))
            .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw))
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(raw))
            .ok()?;
        (bytes.len() == 32).then(|| Sealer(Aes256Gcm::new_from_slice(&bytes).expect("32 bytes")))
    }

    pub(crate) fn seal(&self, aad: &str, plain: &str) -> Vec<u8> {
        use rand::RngCore;
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let sealed = self.0.encrypt(Nonce::from_slice(&nonce), Payload { msg: plain.as_bytes(), aad: aad.as_bytes() }).expect("aes-gcm seal");
        let mut out = Vec::with_capacity(12 + sealed.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        out
    }

    pub(crate) fn open(&self, aad: &str, sealed: &[u8]) -> Option<String> {
        if sealed.len() < 12 + 16 {
            return None;
        }
        let (nonce, body) = sealed.split_at(12);
        let plain = self.0.decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad: aad.as_bytes() }).ok()?;
        String::from_utf8(plain).ok()
    }
}

fn aad(user: Uuid, platform: &str, field: &str) -> String {
    format!("{user}:{platform}:{field}")
}

pub(crate) struct Config {
    public_url: Option<String>,
    sealer: Option<Sealer>,
    apps: HashMap<Platform, App>,
    http: reqwest::Client,
}

impl Default for Config {
    fn default() -> Self {
        Config { public_url: None, sealer: None, apps: HashMap::new(), http: http_client(true) }
    }
}

fn http_client(https_only: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(https_only)
        .build()
        .expect("destinations http client")
}

impl Config {
    pub(crate) fn from_env() -> Self {
        let config = Self::from_vars(|k| std::env::var(k).ok());
        if config.on() {
            let on: Vec<&str> = config.platforms().into_iter().map(Platform::slug).collect();
            log::info!("destinations: on for {on:?} and custom rtmp, callbacks at <PUBLIC_URL>/api/auth/<platform>/callback");
        } else {
            log::info!("destinations: off (needs STREAM_KEY_ENC, PUBLIC_URL, and TWITCH_ or KICK_ _CLIENT_ID and _CLIENT_SECRET, or YOUTUBE_ENABLED with GOOGLE_ _CLIENT_ID and _CLIENT_SECRET)");
        }
        config
    }

    fn from_vars(get: impl Fn(&str) -> Option<String>) -> Self {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let public_url = val("PUBLIC_URL").and_then(|raw| clean_public_url(&raw));
        let sealer = match val("STREAM_KEY_ENC") {
            Some(raw) => {
                let sealer = Sealer::from_base64(&raw);
                if sealer.is_none() {
                    log::warn!("destinations: STREAM_KEY_ENC is not 32 bytes of base64, so destinations are off");
                }
                sealer
            }
            None => None,
        };
        let mut apps = HashMap::new();
        for p in Platform::ALL {
            let own = (val(&format!("{}_CLIENT_ID", p.env())), val(&format!("{}_CLIENT_SECRET", p.env())));
            let pair = match p {
                Platform::Youtube if !val("YOUTUBE_ENABLED").is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")) => continue,
                Platform::Youtube => (own.0.or_else(|| val("GOOGLE_CLIENT_ID")), own.1.or_else(|| val("GOOGLE_CLIENT_SECRET"))),
                _ => own,
            };
            match pair {
                (Some(id), Some(secret)) => {
                    apps.insert(p, App { id, secret, spec: Spec::of(p) });
                }
                (Some(_), None) | (None, Some(_)) => log::warn!("destinations: {} needs both _CLIENT_ID and _CLIENT_SECRET, so it is off", p.slug()),
                (None, None) => {}
            }
        }
        Config { public_url, sealer, apps, http: http_client(true) }
    }

    #[cfg(test)]
    pub(crate) fn for_test(public_url: &str, key: &str, specs: &[(Platform, Spec)]) -> Self {
        let apps = specs.iter().map(|(p, spec)| (*p, App { id: format!("{}-client", p.slug()), secret: format!("{}-secret", p.slug()), spec: spec.clone() })).collect();
        Config { public_url: Some(public_url.to_owned()), sealer: Sealer::from_base64(key), apps, http: http_client(false) }
    }

    pub(crate) fn on(&self) -> bool {
        self.sealer.is_some() && self.public_url.is_some() && !self.apps.is_empty()
    }

    pub(crate) fn platforms(&self) -> Vec<Platform> {
        if !self.on() {
            return Vec::new();
        }
        Platform::ALL.into_iter().filter(|p| self.apps.contains_key(p)).collect()
    }

    fn app(&self, p: Platform) -> Option<&App> {
        self.on().then(|| self.apps.get(&p)).flatten()
    }

    fn sealer(&self) -> &Sealer {
        self.sealer.as_ref().expect("on() checked")
    }

    pub(crate) fn redirect_uri(&self, p: Platform) -> Option<String> {
        Some(format!("{}/api/auth/{}/callback", self.public_url.as_ref()?, p.slug()))
    }
}

#[derive(Debug, PartialEq, Clone)]
pub(crate) struct Tokens {
    access: String,
    refresh: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    scopes: Option<String>,
}

fn number_of(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn text_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned).filter(|s| !s.is_empty())
}

fn id_of(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub(crate) fn parse_tokens(v: &Value, now: DateTime<Utc>) -> Option<Tokens> {
    let access = text_of(v, "access_token")?;
    let scopes = match v.get("scope") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(a)) => Some(a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
        _ => None,
    }
    .filter(|s| !s.is_empty());
    Some(Tokens {
        access,
        refresh: text_of(v, "refresh_token"),
        expires_at: number_of(v.get("expires_in")).filter(|n| *n > 0).map(|n| now + chrono::Duration::seconds(n)),
        scopes,
    })
}

#[derive(Debug, PartialEq, Clone)]
pub(crate) struct Account {
    id: String,
    name: String,
}

#[derive(PartialEq, Clone)]
pub(crate) struct Ingest {
    url: String,
    key: String,
}

impl std::fmt::Debug for Ingest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ingest").field("url", &self.url).field("key", &"<sealed>").finish()
    }
}

fn first(v: &Value) -> Option<&Value> {
    v.get("data").and_then(Value::as_array).and_then(|a| a.first())
}

fn items(v: &Value) -> &[Value] {
    v.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

pub(crate) fn parse_account(p: Platform, v: &Value) -> Option<Account> {
    match p {
        Platform::Twitch => {
            let row = first(v)?;
            Some(Account { id: id_of(row, "id")?, name: text_of(row, "login").or_else(|| text_of(row, "display_name"))? })
        }
        Platform::Kick => {
            let row = first(v)?;
            Some(Account { id: id_of(row, "user_id")?, name: text_of(row, "name")? })
        }
        Platform::Youtube => {
            let row = items(v).first()?;
            let snippet = row.get("snippet")?;
            Some(Account { id: id_of(row, "id")?, name: text_of(snippet, "customUrl").or_else(|| text_of(snippet, "title"))? })
        }
    }
}

pub(crate) fn parse_ingest(p: Platform, v: &Value) -> Option<Ingest> {
    match p {
        Platform::Twitch => Some(Ingest { url: TWITCH_INGEST.into(), key: text_of(first(v)?, "stream_key")? }),
        Platform::Kick => {
            let stream = first(v)?.get("stream")?;
            Some(Ingest { url: text_of(stream, "url")?, key: text_of(stream, "key")? })
        }
        Platform::Youtube => parse_youtube_stream(v).map(|(_, ingest)| ingest),
    }
}

pub(crate) fn parse_youtube_stream(v: &Value) -> Option<(String, Ingest)> {
    let info = v.pointer("/cdn/ingestionInfo")?;
    let url = text_of(info, "rtmpsIngestionAddress").or_else(|| text_of(info, "ingestionAddress"))?;
    Some((id_of(v, "id")?, Ingest { url, key: text_of(info, "streamName")? }))
}

pub(crate) fn youtube_reason(v: &Value) -> Option<String> {
    v.pointer("/error/errors/0/reason").and_then(Value::as_str).map(str::to_owned).filter(|r| !r.is_empty())
}

fn kick_slug(v: &Value) -> Option<String> {
    first(v).and_then(|row| text_of(row, "slug"))
}

#[derive(Debug)]
enum Fail {
    Http(String),
    Status(StatusCode),
    Shape,
    Unauthorized,
    Said(String),
}

impl Fail {
    fn words(&self, p: Platform) -> String {
        match self {
            Fail::Unauthorized => format!("{} let go of this app. connect again", p.label()),
            Fail::Status(s) if s.as_u16() == 429 => format!("{} says slow down. try again soon", p.label()),
            Fail::Said(r) if r == "liveStreamingNotEnabled" => "YouTube live is off for this channel. turn it on at youtube.com/features, it can take a day".to_owned(),
            Fail::Said(r) if r == "livePermissionBlocked" => "YouTube blocked live streaming on this channel. see youtube.com/features".to_owned(),
            Fail::Said(r) if r == "noChannel" => "that google account has no YouTube channel yet. make one, then connect".to_owned(),
            Fail::Said(r) if r == "insufficientPermissions" || r == "forbidden" => format!("{} did not let slop manage live. connect again", p.label()),
            Fail::Said(r) if r == "rateLimitExceeded" || r == "userRequestsExceedRateLimit" || r == "quotaExceeded" => format!("{} says slow down. try again soon", p.label()),
            Fail::Said(r) => format!("{} said no ({r})", p.label()),
            _ => format!("could not reach {}. try again", p.label()),
        }
    }
}

fn scrub(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

async fn form_post(cfg: &Config, url: &str, pairs: &[(&str, &str)]) -> Result<Value, Fail> {
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.iter().copied()).finish();
    let res = cfg
        .http
        .post(url)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| Fail::Http(scrub(e)))?;
    let status = res.status();
    if status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED {
        return Err(Fail::Unauthorized);
    }
    if !status.is_success() {
        return Err(Fail::Status(status));
    }
    res.json().await.map_err(|e| Fail::Http(scrub(e)))
}

fn authed(p: Platform, app: &App, req: reqwest::RequestBuilder, access: &str) -> reqwest::RequestBuilder {
    let req = req.bearer_auth(access).header(header::ACCEPT, "application/json");
    match p {
        Platform::Twitch => req.header("Client-Id", &app.id),
        Platform::Kick | Platform::Youtube => req,
    }
}

async fn api_get(cfg: &Config, p: Platform, app: &App, path: &str, query: &[(&str, &str)], access: &str) -> Result<Value, Fail> {
    let url = format!("{}{path}", app.spec.api_url);
    let res = authed(p, app, cfg.http.get(url).query(query), access).send().await.map_err(|e| Fail::Http(scrub(e)))?;
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(Fail::Unauthorized);
    }
    if !status.is_success() {
        return Err(Fail::Status(status));
    }
    res.json().await.map_err(|e| Fail::Http(scrub(e)))
}

async fn api_patch(cfg: &Config, p: Platform, app: &App, path: &str, query: &[(&str, &str)], body: &Value, access: &str) -> Result<(), Fail> {
    let url = format!("{}{path}", app.spec.api_url);
    let res = authed(p, app, cfg.http.patch(url).query(query).json(body), access).send().await.map_err(|e| Fail::Http(scrub(e)))?;
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(Fail::Unauthorized);
    }
    if !status.is_success() {
        return Err(Fail::Status(status));
    }
    Ok(())
}

fn warn(p: Platform, what: &str, fail: &Fail) {
    match fail {
        Fail::Http(e) => log::warn!("destinations {}: {what}: {e}", p.slug()),
        Fail::Status(s) => log::warn!("destinations {}: {what}: http {s}", p.slug()),
        Fail::Shape => log::warn!("destinations {}: {what}: an answer of another shape", p.slug()),
        Fail::Unauthorized => log::info!("destinations {}: {what}: refused", p.slug()),
        Fail::Said(r) => log::info!("destinations {}: {what}: {r}", p.slug()),
    }
}

async fn exchange_code(cfg: &Config, p: Platform, app: &App, code: &str, verifier: &str) -> Result<Tokens, Fail> {
    let redirect_uri = cfg.redirect_uri(p).ok_or(Fail::Shape)?;
    let v = form_post(
        cfg,
        &app.spec.token_url,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &app.id),
            ("client_secret", &app.secret),
            ("code_verifier", verifier),
        ],
    )
    .await?;
    parse_tokens(&v, Utc::now()).ok_or(Fail::Shape)
}

async fn exchange_refresh(cfg: &Config, app: &App, refresh: &str) -> Result<Tokens, Fail> {
    let v = form_post(
        cfg,
        &app.spec.token_url,
        &[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", &app.id), ("client_secret", &app.secret)],
    )
    .await?;
    parse_tokens(&v, Utc::now()).ok_or(Fail::Shape)
}

async fn youtube(cfg: &Config, app: &App, method: reqwest::Method, path: &str, query: &[(&str, &str)], body: Option<&Value>, access: &str) -> Result<Value, Fail> {
    let url = format!("{}{path}", app.spec.api_url);
    let mut req = cfg.http.request(method, url).query(query).bearer_auth(access).header(header::ACCEPT, "application/json");
    if let Some(body) = body {
        req = req.json(body);
    }
    let res = req.send().await.map_err(|e| Fail::Http(scrub(e)))?;
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(Fail::Unauthorized);
    }
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(youtube_reason(&v).map(Fail::Said).unwrap_or(Fail::Status(status)));
    }
    Ok(v)
}

async fn account_of(cfg: &Config, p: Platform, app: &App, access: &str) -> Result<Account, Fail> {
    if p == Platform::Youtube {
        let v = youtube(cfg, app, reqwest::Method::GET, "/channels", &[("part", "id,snippet"), ("mine", "true")], None, access).await?;
        return parse_account(p, &v).ok_or_else(|| Fail::Said("noChannel".into()));
    }
    let v = api_get(cfg, p, app, "/users", &[], access).await?;
    parse_account(p, &v).ok_or(Fail::Shape)
}

async fn youtube_stream(cfg: &Config, app: &App, access: &str, make: bool) -> Result<Option<Value>, Fail> {
    let list = youtube(cfg, app, reqwest::Method::GET, "/liveStreams", &[("part", "id,snippet,cdn"), ("mine", "true"), ("maxResults", "50")], None, access).await?;
    if let Some(found) = items(&list).iter().find(|s| s.pointer("/snippet/title").and_then(Value::as_str) == Some(YOUTUBE_STREAM)) {
        return Ok(Some(found.clone()));
    }
    if !make {
        return Ok(None);
    }
    let body = json!({
        "snippet": { "title": YOUTUBE_STREAM, "description": "slop sends your stream here" },
        "cdn": { "ingestionType": "rtmp", "resolution": "variable", "frameRate": "variable" },
        "contentDetails": { "isReusable": true },
    });
    youtube(cfg, app, reqwest::Method::POST, "/liveStreams", &[("part", "id,snippet,cdn,contentDetails")], Some(&body), access).await.map(Some)
}

async fn ingest_of(cfg: &Config, p: Platform, app: &App, account: &Account, access: &str) -> Result<(Ingest, Option<String>), Fail> {
    match p {
        Platform::Twitch => {
            let v = api_get(cfg, p, app, "/streams/key", &[("broadcaster_id", &account.id)], access).await?;
            Ok((parse_ingest(p, &v).ok_or(Fail::Shape)?, None))
        }
        Platform::Kick => {
            let v = api_get(cfg, p, app, "/channels", &[], access).await?;
            Ok((parse_ingest(p, &v).ok_or(Fail::Shape)?, kick_slug(&v)))
        }
        Platform::Youtube => {
            let stream = youtube_stream(cfg, app, access, true).await?.ok_or(Fail::Shape)?;
            let (id, ingest) = parse_youtube_stream(&stream).ok_or(Fail::Shape)?;
            Ok((ingest, Some(id)))
        }
    }
}

async fn revoke(cfg: &Config, p: Platform, app: &App, token: &str) {
    let done = match p {
        Platform::Twitch => form_post(cfg, &app.spec.revoke_url, &[("client_id", &app.id), ("token", token)]).await.map(|_| ()),
        Platform::Youtube => {
            let body = url::form_urlencoded::Serializer::new(String::new()).append_pair("token", token).finish();
            let res = cfg.http.post(&app.spec.revoke_url).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(body).send().await;
            match res {
                Ok(r) if r.status().is_success() => Ok(()),
                Ok(r) => Err(Fail::Status(r.status())),
                Err(e) => Err(Fail::Http(scrub(e))),
            }
        }
        Platform::Kick => {
            let res = cfg.http.post(&app.spec.revoke_url).query(&[("token", token), ("token_hint_type", "access_token")]).send().await;
            match res {
                Ok(r) if r.status().is_success() => Ok(()),
                Ok(r) => Err(Fail::Status(r.status())),
                Err(e) => Err(Fail::Http(scrub(e))),
            }
        }
    };
    if let Err(fail) = done {
        warn(p, "revoke", &fail);
    }
}

fn sealed(cfg: &Config, user: Uuid, platform: &str, field: &str, plain: Option<&str>) -> Option<Vec<u8>> {
    plain.map(|v| cfg.sealer().seal(&aad(user, platform, field), v))
}

fn opened(cfg: &Config, user: Uuid, platform: &str, field: &str, raw: Option<&[u8]>) -> Option<String> {
    cfg.sealer().open(&aad(user, platform, field), raw?)
}

pub(crate) async fn connect(cfg: &Config, db: &sqlx::PgPool, user: Uuid, p: Platform, code: &str, verifier: &str) -> Result<(Uuid, Option<String>), String> {
    let app = cfg.app(p).ok_or_else(|| format!("{} is not set up here", p.label()))?;
    let tokens = exchange_code(cfg, p, app, code, verifier).await.map_err(|f| {
        warn(p, "token", &f);
        f.words(p)
    })?;
    let account = account_of(cfg, p, app, &tokens.access).await.map_err(|f| {
        warn(p, "user", &f);
        f.words(p)
    })?;
    let mut note = None;
    let ingest = match ingest_of(cfg, p, app, &account, &tokens.access).await {
        Ok((ingest, _)) => Some(ingest),
        Err(f) => {
            warn(p, "stream key", &f);
            if matches!(f, Fail::Said(_)) {
                note = Some(f.words(p));
            }
            None
        }
    };
    let slug = p.slug();
    let taken = taken_words(p);
    let db_error = |e: sqlx::Error| {
        log::error!("postgres: {e}");
        "database error".to_owned()
    };
    if owned_elsewhere(db, user, p, &account.id).await.map_err(db_error)? {
        log::info!("destinations {slug}: refused an account another login owns");
        revoke(cfg, p, app, &tokens.access).await;
        return Err(taken);
    }
    let before: Option<(Option<String>, Option<Vec<u8>>)> = sqlx::query_as("SELECT external_id, access_token FROM stream_destinations WHERE user_id = $1 AND platform = $2")
        .bind(user)
        .bind(slug)
        .fetch_optional(db)
        .await
        .map_err(db_error)?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO stream_destinations (user_id, platform, external_id, external_name, access_token, refresh_token, token_expires_at, scopes, stream_url, stream_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, platform) DO UPDATE SET
           external_id = EXCLUDED.external_id, external_name = EXCLUDED.external_name,
           access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes,
           stream_url = CASE WHEN stream_destinations.external_id = EXCLUDED.external_id THEN COALESCE(EXCLUDED.stream_url, stream_destinations.stream_url) ELSE EXCLUDED.stream_url END,
           stream_key = CASE WHEN stream_destinations.external_id = EXCLUDED.external_id THEN COALESCE(EXCLUDED.stream_key, stream_destinations.stream_key) ELSE EXCLUDED.stream_key END,
           enabled = stream_destinations.enabled OR stream_destinations.external_id IS DISTINCT FROM EXCLUDED.external_id,
           created_at = CASE WHEN stream_destinations.external_id = EXCLUDED.external_id THEN stream_destinations.created_at ELSE now() END,
           updated_at = now()
         RETURNING id",
    )
    .bind(user)
    .bind(slug)
    .bind(&account.id)
    .bind(clean_name(&account.name))
    .bind(sealed(cfg, user, slug, "access", Some(&tokens.access)))
    .bind(sealed(cfg, user, slug, "refresh", tokens.refresh.as_deref()))
    .bind(tokens.expires_at)
    .bind(&tokens.scopes)
    .bind(sealed(cfg, user, slug, "url", ingest.as_ref().map(|i| i.url.as_str())))
    .bind(sealed(cfg, user, slug, "key", ingest.as_ref().map(|i| i.key.as_str())))
    .fetch_one(db)
    .await
    .map_err(|e| if crate::unique_violation(&e) { taken.clone() } else { db_error(e) })?;
    if let Some((Some(old), access)) = before {
        if old != account.id {
            if let Some(token) = opened(cfg, user, slug, "access", access.as_deref()) {
                revoke(cfg, p, app, &token).await;
            }
            log::info!("destinations {slug}: swapped one account for another");
        }
    }
    Ok((id, note))
}

fn taken_words(p: Platform) -> String {
    format!("that {} is already linked to another account", p.slug())
}

pub(crate) async fn owned_elsewhere(db: &sqlx::PgPool, user: Uuid, p: Platform, external_id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2 AND user_id <> $3)
             OR EXISTS (SELECT 1 FROM stream_destinations WHERE platform = $1 AND external_id = $2 AND user_id <> $3)",
    )
    .bind(p.slug())
    .bind(external_id)
    .bind(user)
    .fetch_one(db)
    .await
}

fn clean_name(raw: &str) -> String {
    let clean: String = raw.chars().filter(|c| !c.is_control()).collect();
    clean.trim().chars().take(NAME_MAX).collect::<String>().trim_end().to_owned()
}

type Row = (Uuid, String, Option<String>, Option<String>, Option<Vec<u8>>, Option<Vec<u8>>, Option<DateTime<Utc>>, Option<Vec<u8>>, Option<Vec<u8>>, bool, DateTime<Utc>);

const ROW: &str = "SELECT id, platform, external_id, external_name, access_token, refresh_token, token_expires_at, stream_url, stream_key, enabled, created_at FROM stream_destinations";

struct Dest {
    id: Uuid,
    platform: String,
    external_id: Option<String>,
    name: Option<String>,
    access: Option<Vec<u8>>,
    refresh: Option<Vec<u8>>,
    expires_at: Option<DateTime<Utc>>,
    url: Option<Vec<u8>>,
    key: Option<Vec<u8>>,
    enabled: bool,
    created_at: DateTime<Utc>,
}

impl From<Row> for Dest {
    fn from(r: Row) -> Self {
        Dest { id: r.0, platform: r.1, external_id: r.2, name: r.3, access: r.4, refresh: r.5, expires_at: r.6, url: r.7, key: r.8, enabled: r.9, created_at: r.10 }
    }
}

impl Dest {
    fn summary(&self) -> Value {
        json!({
            "id": self.id,
            "platform": self.platform,
            "name": self.name,
            "enabled": self.enabled,
            "has_key": self.key.is_some(),
            "connected_at": self.created_at,
        })
    }
}

async fn dests_of(db: &sqlx::PgPool, user: Uuid) -> Result<Vec<Dest>, sqlx::Error> {
    let rows: Vec<Row> = sqlx::query_as(&format!("{ROW} WHERE user_id = $1 ORDER BY created_at, id")).bind(user).fetch_all(db).await?;
    Ok(rows.into_iter().map(Dest::from).collect())
}

async fn dest_of(db: &sqlx::PgPool, user: Uuid, id: Uuid) -> Result<Option<Dest>, sqlx::Error> {
    let row: Option<Row> = sqlx::query_as(&format!("{ROW} WHERE user_id = $1 AND id = $2")).bind(user).bind(id).fetch_optional(db).await?;
    Ok(row.map(Dest::from))
}

async fn fresh_access(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest, force: bool) -> Result<String, Fail> {
    let p = Platform::from_slug(&d.platform).ok_or(Fail::Shape)?;
    let app = cfg.app(p).ok_or(Fail::Shape)?;
    let access = opened(cfg, user, &d.platform, "access", d.access.as_deref());
    let due = d.expires_at.is_some_and(|at| at <= Utc::now() + chrono::Duration::seconds(REFRESH_AHEAD_SECS));
    if let Some(access) = access.filter(|_| !due && !force) {
        return Ok(access);
    }
    let refresh = opened(cfg, user, &d.platform, "refresh", d.refresh.as_deref()).ok_or(Fail::Unauthorized)?;
    let tokens = exchange_refresh(cfg, app, &refresh).await?;
    let new_access = sealed(cfg, user, &d.platform, "access", Some(&tokens.access));
    let new_refresh = sealed(cfg, user, &d.platform, "refresh", tokens.refresh.as_deref()).or_else(|| d.refresh.clone());
    sqlx::query("UPDATE stream_destinations SET access_token = $3, refresh_token = $4, token_expires_at = $5, scopes = COALESCE($6, scopes), updated_at = now() WHERE id = $1 AND user_id = $2")
        .bind(d.id)
        .bind(user)
        .bind(&new_access)
        .bind(&new_refresh)
        .bind(tokens.expires_at)
        .bind(&tokens.scopes)
        .execute(db)
        .await
        .map_err(|e| Fail::Http(format!("postgres: {e}")))?;
    d.access = new_access;
    d.refresh = new_refresh;
    d.expires_at = tokens.expires_at;
    Ok(tokens.access)
}

async fn refresh_key(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest) -> Result<(), Fail> {
    let p = Platform::from_slug(&d.platform).ok_or(Fail::Shape)?;
    let app = cfg.app(p).ok_or(Fail::Shape)?;
    let access = fresh_access(cfg, db, user, d, true).await?;
    let account = Account { id: d.external_id.clone().ok_or(Fail::Shape)?, name: d.name.clone().unwrap_or_default() };
    let (ingest, _) = ingest_of(cfg, p, app, &account, &access).await?;
    let url = sealed(cfg, user, &d.platform, "url", Some(&ingest.url));
    let key = sealed(cfg, user, &d.platform, "key", Some(&ingest.key));
    sqlx::query("UPDATE stream_destinations SET stream_url = $3, stream_key = $4, updated_at = now() WHERE id = $1 AND user_id = $2")
        .bind(d.id)
        .bind(user)
        .bind(&url)
        .bind(&key)
        .execute(db)
        .await
        .map_err(|e| Fail::Http(format!("postgres: {e}")))?;
    d.url = url;
    d.key = key;
    Ok(())
}

async fn twitch_category(cfg: &Config, app: &App, name: &str, access: &str) -> Result<Option<String>, Fail> {
    let v = api_get(cfg, Platform::Twitch, app, "/search/categories", &[("query", name), ("first", "10")], access).await?;
    Ok(pick_category(&v, name, "id"))
}

async fn kick_category(cfg: &Config, app: &App, name: &str, access: &str) -> Result<Option<String>, Fail> {
    let v = api_get(cfg, Platform::Kick, app, "/categories", &[("q", name)], access).await?;
    Ok(pick_category(&v, name, "id"))
}

pub(crate) fn pick_category(v: &Value, name: &str, id_key: &str) -> Option<String> {
    let rows = v.get("data").and_then(Value::as_array)?;
    let exact = rows.iter().find(|r| r.get("name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(name.trim())));
    exact.or_else(|| rows.first()).and_then(|r| id_of(r, id_key))
}

async fn set_channel(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest, title: &str, category: Option<&str>, privacy: &str) -> Result<(), Fail> {
    let p = Platform::from_slug(&d.platform).ok_or(Fail::Shape)?;
    let app = cfg.app(p).ok_or(Fail::Shape)?.clone();
    let access = fresh_access(cfg, db, user, d, false).await?;
    let broadcaster = d.external_id.clone().ok_or(Fail::Shape)?;
    match p {
        Platform::Twitch => {
            let mut body = json!({ "title": title });
            if let Some(name) = category {
                if let Some(id) = twitch_category(cfg, &app, name, &access).await? {
                    body["game_id"] = json!(id);
                }
            }
            api_patch(cfg, p, &app, "/channels", &[("broadcaster_id", &broadcaster)], &body, &access).await
        }
        Platform::Kick => {
            let mut body = json!({ "stream_title": title });
            if let Some(name) = category {
                if let Some(id) = kick_category(cfg, &app, name, &access).await?.and_then(|id| id.parse::<i64>().ok()) {
                    body["category_id"] = json!(id);
                }
            }
            api_patch(cfg, p, &app, "/channels", &[], &body, &access).await
        }
        Platform::Youtube => youtube_live(cfg, db, user, d, &app, &access, title, privacy).await,
    }
}

async fn keep_ingest(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest, ingest: &Ingest) -> Result<(), Fail> {
    let same = opened(cfg, user, &d.platform, "key", d.key.as_deref()).as_deref() == Some(ingest.key.as_str())
        && opened(cfg, user, &d.platform, "url", d.url.as_deref()).as_deref() == Some(ingest.url.as_str());
    if same {
        return Ok(());
    }
    let url = sealed(cfg, user, &d.platform, "url", Some(&ingest.url));
    let key = sealed(cfg, user, &d.platform, "key", Some(&ingest.key));
    sqlx::query("UPDATE stream_destinations SET stream_url = $3, stream_key = $4, updated_at = now() WHERE id = $1 AND user_id = $2")
        .bind(d.id)
        .bind(user)
        .bind(&url)
        .bind(&key)
        .execute(db)
        .await
        .map_err(|e| Fail::Http(format!("postgres: {e}")))?;
    d.url = url;
    d.key = key;
    Ok(())
}

fn bound_to<'a>(list: &'a Value, stream: &str) -> impl Iterator<Item = &'a Value> + 'a {
    let stream = stream.to_owned();
    items(list).iter().filter(move |b| b.pointer("/contentDetails/boundStreamId").and_then(Value::as_str) == Some(stream.as_str()))
}

#[allow(clippy::too_many_arguments)]
async fn youtube_live(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest, app: &App, access: &str, title: &str, privacy: &str) -> Result<(), Fail> {
    let stream = youtube_stream(cfg, app, access, true).await?.ok_or(Fail::Shape)?;
    let (stream_id, ingest) = parse_youtube_stream(&stream).ok_or(Fail::Shape)?;
    keep_ingest(cfg, db, user, d, &ingest).await?;
    let title: String = title.chars().take(YOUTUBE_TITLE_MAX).collect();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let parts = [("part", "id,snippet,contentDetails,status"), ("broadcastStatus", "upcoming"), ("broadcastType", "all"), ("maxResults", "50")];
    let upcoming = youtube(cfg, app, reqwest::Method::GET, "/liveBroadcasts", &parts, None, access).await?;
    if let Some(id) = bound_to(&upcoming, &stream_id).find_map(|b| id_of(b, "id")) {
        let body = json!({
            "id": id,
            "snippet": { "title": title, "scheduledStartTime": now },
            "status": { "privacyStatus": privacy, "selfDeclaredMadeForKids": false },
        });
        youtube(cfg, app, reqwest::Method::PUT, "/liveBroadcasts", &[("part", "id,snippet,status")], Some(&body), access).await?;
        return Ok(());
    }
    let body = json!({
        "snippet": { "title": title, "scheduledStartTime": now },
        "status": { "privacyStatus": privacy, "selfDeclaredMadeForKids": false },
        "contentDetails": { "enableAutoStart": true, "enableAutoStop": true, "recordFromStart": true, "enableDvr": true },
    });
    let made = youtube(cfg, app, reqwest::Method::POST, "/liveBroadcasts", &[("part", "id,snippet,contentDetails,status")], Some(&body), access).await?;
    let id = id_of(&made, "id").ok_or(Fail::Shape)?;
    youtube(cfg, app, reqwest::Method::POST, "/liveBroadcasts/bind", &[("id", &id), ("part", "id,contentDetails"), ("streamId", &stream_id)], None, access).await?;
    Ok(())
}

async fn youtube_stop(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest) -> Result<usize, Fail> {
    let app = cfg.app(Platform::Youtube).ok_or(Fail::Shape)?.clone();
    let access = fresh_access(cfg, db, user, d, false).await?;
    let Some(stream) = youtube_stream(cfg, &app, &access, false).await? else {
        return Ok(0);
    };
    let stream_id = id_of(&stream, "id").ok_or(Fail::Shape)?;
    let parts = [("part", "id,contentDetails,status"), ("broadcastStatus", "active"), ("broadcastType", "all"), ("maxResults", "50")];
    let active = youtube(cfg, &app, reqwest::Method::GET, "/liveBroadcasts", &parts, None, &access).await?;
    let mut done = 0;
    for id in bound_to(&active, &stream_id).filter_map(|b| id_of(b, "id")).collect::<Vec<_>>() {
        let q = [("broadcastStatus", "complete"), ("id", id.as_str()), ("part", "id,status")];
        match youtube(cfg, &app, reqwest::Method::POST, "/liveBroadcasts/transition", &q, None, &access).await {
            Ok(_) => done += 1,
            Err(Fail::Said(r)) if r == "redundantTransition" => {}
            Err(f) => return Err(f),
        }
    }
    Ok(done)
}

fn gate(s: &AppState) -> Result<&Config, ApiError> {
    let cfg = s.destinations.as_ref();
    if cfg.on() {
        Ok(cfg)
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "not found"))
    }
}

fn signed_in(me: Option<auth::Account>) -> Result<auth::Account, ApiError> {
    me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Started {
    platform: String,
    verifier: String,
    user: Uuid,
}

fn state_key(state: &str) -> String {
    format!("dest:state:{state}")
}

fn state_cookie(value: &str, secs: u64) -> String {
    format!("{STATE_COOKIE}={value}; Path=/api/auth; Max-Age={secs}; HttpOnly; Secure; SameSite=Lax")
}

fn gone_cookie() -> String {
    format!("{STATE_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax")
}

fn back(key: &str, value: &str) -> Response {
    let q: String = url::form_urlencoded::Serializer::new(String::new()).append_pair(key, value).finish();
    redirect(&format!("{PAGE}?{q}"), &[gone_cookie()])
}

fn redirect(to: &str, cookies: &[String]) -> Response {
    use axum::response::IntoResponse;
    let mut res = axum::response::Redirect::to(to).into_response();
    for c in cookies {
        if let Ok(v) = header::HeaderValue::from_str(c) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    res
}

fn fail(words: &str) -> Response {
    back("destination_error", words)
}

pub(crate) fn authorize_url(cfg: &Config, p: Platform, state: &str, verifier: &str) -> Option<String> {
    let app = cfg.app(p)?;
    let redirect_uri = cfg.redirect_uri(p)?;
    let mut to = url::Url::parse(&app.spec.authorize_url).ok()?;
    to.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &app.id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", p.scope())
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce_challenge(verifier))
        .append_pair("code_challenge_method", "S256");
    match p {
        Platform::Twitch => {
            to.query_pairs_mut().append_pair("force_verify", "true");
        }
        Platform::Youtube => {
            to.query_pairs_mut().append_pair("access_type", "offline").append_pair("prompt", "consent");
        }
        Platform::Kick => {}
    }
    Some(to.to_string())
}

async fn start(State(s): State<AppState>, Path(slug): Path<String>, Me(me): Me) -> Result<Response, ApiError> {
    let cfg = gate(&s)?;
    let Some(p) = Platform::from_slug(&slug).filter(|p| cfg.app(*p).is_some()) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not found"));
    };
    let Some(me) = me else {
        return Ok(fail("log in first, then connect"));
    };
    let state = random_hex();
    let verifier = random_hex();
    let started = Started { platform: p.slug().to_owned(), verifier: verifier.clone(), user: me.id };
    let _: () = redis::cmd("SET")
        .arg(state_key(&state))
        .arg(serde_json::to_string(&started).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not start"))?)
        .arg("EX")
        .arg(STATE_SECS)
        .query_async(&mut s.redis.clone())
        .await?;
    let to = authorize_url(cfg, p, &state, &verifier).ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not start"))?;
    Ok(redirect(&to, &[state_cookie(&state, STATE_SECS)]))
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(State(s): State<AppState>, Path(slug): Path<String>, Query(q): Query<CallbackQuery>, headers: HeaderMap) -> Result<Response, ApiError> {
    if crate::oauth::is_login_state(&headers, q.state.as_deref()) || !s.destinations.on() {
        let q = crate::oauth::CallbackQuery { code: q.code, state: q.state, error: q.error };
        return crate::oauth::finish(&s, &slug, q, &headers).await;
    }
    let cfg = gate(&s)?;
    let Some(p) = Platform::from_slug(&slug).filter(|p| cfg.app(*p).is_some()) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not found"));
    };
    if q.error.is_some() {
        return Ok(fail(&format!("{} said no, or you cancelled", p.label())));
    }
    let cookie = cookie_value(&headers, STATE_COOKIE);
    let state = match check_state(q.state.as_deref(), cookie.as_deref()) {
        Ok(state) => state,
        Err(_) => return Ok(fail("that connect started in another browser, or ran out. try again")),
    };
    let raw: Option<String> = redis::cmd("GETDEL").arg(state_key(state)).query_async(&mut s.redis.clone()).await?;
    let Some(started) = raw.and_then(|r| serde_json::from_str::<Started>(&r).ok()) else {
        return Ok(fail("that connect ran out. try again"));
    };
    if started.platform != p.slug() {
        return Ok(fail("that connect link is broken. try again"));
    }
    let me = auth::whoami(&s.db, &headers).await?;
    let Some(me) = me.filter(|m| m.id == started.user) else {
        return Ok(fail("log in again, then connect"));
    };
    let Some(code) = q.code.filter(|c| !c.is_empty() && c.len() <= 2048) else {
        return Ok(fail("that connect link is broken. try again"));
    };
    match connect(cfg, &s.db, me.id, p, &code, &started.verifier).await {
        Ok((_, None)) => {
            log::info!("{}: connected {}", me.name, p.slug());
            Ok(back("destination", p.slug()))
        }
        Ok((_, Some(note))) => {
            log::info!("{}: connected {} without a stream key yet", me.name, p.slug());
            Ok(fail(&format!("{} connected, but {note}", p.slug())))
        }
        Err(words) => Ok(fail(&words)),
    }
}

async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let cfg = gate(&s)?;
    let me = signed_in(me)?;
    let dests = dests_of(&s.db, me.id).await?;
    let mut platforms: Vec<&str> = cfg.platforms().into_iter().map(Platform::slug).collect();
    platforms.push("custom");
    let relayed = crate::relay::statuses(&s, me.id).await;
    let list: Vec<Value> = dests
        .iter()
        .map(|d| {
            let mut v = d.summary();
            if let Some(status) = relayed.get(&d.id) {
                v["relay"] = status.clone();
            }
            v
        })
        .collect();
    Ok(Json(json!({ "platforms": platforms, "relay": s.relay.on(), "direct": s.relay.direct(), "destinations": list })))
}

#[derive(Deserialize)]
struct CustomBody {
    url: String,
    key: String,
    #[serde(default)]
    name: Option<String>,
}

pub(crate) fn check_rtmp_url(raw: &str) -> Result<url::Url, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > URL_MAX {
        return Err("bad url. rtmp or rtmps, 512 characters at most");
    }
    let u = url::Url::parse(raw).map_err(|_| "bad url. rtmp or rtmps, 512 characters at most")?;
    let ok = matches!(u.scheme(), "rtmp" | "rtmps") && u.host_str().is_some_and(|h| !h.is_empty()) && u.username().is_empty() && u.password().is_none() && u.fragment().is_none();
    if ok {
        Ok(u)
    } else {
        Err("bad url. rtmp or rtmps, 512 characters at most")
    }
}

pub(crate) fn check_key(raw: &str) -> Result<&str, &'static str> {
    let key = raw.trim();
    if key.is_empty() || key.len() > KEY_MAX || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("bad stream key. 512 characters at most, no spaces");
    }
    Ok(key)
}

async fn add_custom(State(s): State<AppState>, Me(me): Me, body: Result<Json<CustomBody>, JsonRejection>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let cfg = gate(&s)?;
    let me = signed_in(me)?;
    let Json(body) = body?;
    let url = check_rtmp_url(&body.url).map_err(|w| ApiError::new(StatusCode::BAD_REQUEST, w))?;
    let key = check_key(&body.key).map_err(|w| ApiError::new(StatusCode::BAD_REQUEST, w))?;
    let name = body.name.as_deref().map(clean_name).filter(|n| !n.is_empty()).unwrap_or_else(|| clean_name(url.host_str().unwrap_or("custom")));
    let row = put_custom(cfg, &s.db, me.id, &name, url.as_str(), key).await?;
    log::info!("{}: set their custom destination", me.name);
    Ok((StatusCode::CREATED, Json(Dest::from(row).summary())))
}

async fn put_custom(cfg: &Config, db: &sqlx::PgPool, user: Uuid, name: &str, url: &str, key: &str) -> Result<Row, sqlx::Error> {
    sqlx::query_as(
        "INSERT INTO stream_destinations (user_id, platform, external_name, stream_url, stream_key) VALUES ($1, 'custom', $2, $3, $4)
         ON CONFLICT (user_id, platform) DO UPDATE SET
           external_name = EXCLUDED.external_name, stream_url = EXCLUDED.stream_url, stream_key = EXCLUDED.stream_key, updated_at = now()
         RETURNING id, platform, external_id, external_name, access_token, refresh_token, token_expires_at, stream_url, stream_key, enabled, created_at",
    )
    .bind(user)
    .bind(name)
    .bind(sealed(cfg, user, "custom", "url", Some(url)))
    .bind(sealed(cfg, user, "custom", "key", Some(key)))
    .fetch_one(db)
    .await
}

async fn remove(State(s): State<AppState>, Path(id): Path<Uuid>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let cfg = gate(&s)?;
    let me = signed_in(me)?;
    let Some(d) = dest_of(&s.db, me.id, id).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such destination"));
    };
    sqlx::query("DELETE FROM stream_destinations WHERE id = $1 AND user_id = $2").bind(id).bind(me.id).execute(&s.db).await?;
    if let Some(p) = Platform::from_slug(&d.platform) {
        let token = opened(cfg, me.id, &d.platform, "access", d.access.as_deref()).or_else(|| opened(cfg, me.id, &d.platform, "refresh", d.refresh.as_deref()));
        if let (Some(token), Some(app)) = (token, cfg.app(p)) {
            let cfg = Arc::clone(&s.destinations);
            let app = app.clone();
            tokio::spawn(async move { revoke(&cfg, p, &app, &token).await });
        }
    }
    log::info!("{}: removed a {} destination", me.name, d.platform);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn set_enabled(State(s): State<AppState>, Path(id): Path<Uuid>, Me(me): Me, body: Result<Json<EnabledBody>, JsonRejection>) -> ApiResult {
    gate(&s)?;
    let me = signed_in(me)?;
    let Json(body) = body?;
    let d = switch(&s.db, me.id, id, body.enabled).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such destination"))?;
    log::info!("{}: turned their {} destination {}", me.name, d.platform, if d.enabled { "on" } else { "off" });
    Ok(Json(d.summary()))
}

async fn switch(db: &sqlx::PgPool, user: Uuid, id: Uuid, on: bool) -> Result<Option<Dest>, sqlx::Error> {
    let done = sqlx::query("UPDATE stream_destinations SET enabled = $3 WHERE id = $1 AND user_id = $2").bind(id).bind(user).bind(on).execute(db).await?;
    if done.rows_affected() == 0 {
        return Ok(None);
    }
    dest_of(db, user, id).await
}

async fn refresh_route(State(s): State<AppState>, Path(id): Path<Uuid>, Me(me): Me) -> ApiResult {
    let cfg = gate(&s)?;
    let me = signed_in(me)?;
    let mut d = dest_of(&s.db, me.id, id).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such destination"))?;
    let Some(p) = Platform::from_slug(&d.platform) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "a custom destination has nothing to refresh"));
    };
    if cfg.app(p).is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not found"));
    }
    if let Err(f) = refresh_key(cfg, &s.db, me.id, &mut d).await {
        warn(p, "refresh", &f);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, f.words(p)));
    }
    Ok(Json(d.summary()))
}

#[derive(Deserialize)]
struct LiveBody {
    title: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    privacy: Option<String>,
}

pub(crate) fn clean_title(raw: &str) -> Option<String> {
    let clean: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t: String = clean.trim().chars().take(TITLE_MAX).collect();
    Some(t.trim_end().to_owned()).filter(|t| !t.is_empty())
}

async fn go_live(State(s): State<AppState>, Me(me): Me, body: Result<Json<LiveBody>, JsonRejection>) -> ApiResult {
    let cfg = gate(&s)?;
    let me = signed_in(me)?;
    let Json(body) = body?;
    let title = clean_title(&body.title).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "a title, 140 characters at most"))?;
    let category = body.category.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(|c| c.chars().take(CATEGORY_MAX).collect::<String>());
    let privacy = match body.privacy.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        None => PRIVACY[0],
        Some(p) => PRIVACY.into_iter().find(|k| *k == p).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "privacy is unlisted, public or private"))?,
    };
    auth::limit(&s, &format!("dest:live:{}", me.id), 60, 10, "slow down").await?;
    let out = announce(cfg, &s.db, me.id, &title, category.as_deref(), privacy).await?;
    Ok(Json(json!({ "results": out })))
}

pub(crate) async fn announce(cfg: &Config, db: &sqlx::PgPool, user: Uuid, title: &str, category: Option<&str>, privacy: &str) -> Result<Vec<Value>, sqlx::Error> {
    let mut out = Vec::new();
    for mut d in dests_of(db, user).await? {
        let Some(p) = Platform::from_slug(&d.platform) else { continue };
        if !d.enabled || cfg.app(p).is_none() {
            continue;
        }
        match set_channel(cfg, db, user, &mut d, title, category, privacy).await {
            Ok(()) => out.push(json!({ "id": d.id, "platform": d.platform, "ok": true })),
            Err(f) => {
                warn(p, "title", &f);
                out.push(json!({ "id": d.id, "platform": d.platform, "ok": false, "error": f.words(p) }));
            }
        }
    }
    Ok(out)
}

async fn stop_live(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let cfg = gate(&s)?;
    let me = signed_in(me)?;
    auth::limit(&s, &format!("dest:stop:{}", me.id), 60, 10, "slow down").await?;
    let out = stop_youtube(cfg, &s.db, me.id).await?;
    Ok(Json(json!({ "results": out })))
}

pub(crate) async fn stop_youtube(cfg: &Config, db: &sqlx::PgPool, user: Uuid) -> Result<Vec<Value>, sqlx::Error> {
    let mut out = Vec::new();
    for mut d in dests_of(db, user).await? {
        if d.platform != Platform::Youtube.slug() || cfg.app(Platform::Youtube).is_none() {
            continue;
        }
        match youtube_stop(cfg, db, user, &mut d).await {
            Ok(ended) => out.push(json!({ "id": d.id, "platform": d.platform, "ok": true, "ended": ended })),
            Err(f) => {
                warn(Platform::Youtube, "stop", &f);
                out.push(json!({ "id": d.id, "platform": d.platform, "ok": false, "error": f.words(Platform::Youtube) }));
            }
        }
    }
    Ok(out)
}

pub(crate) struct Target {
    pub(crate) id: Uuid,
    pub(crate) platform: String,
    pub(crate) url: String,
    pub(crate) key: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target").field("id", &self.id).field("platform", &self.platform).field("key", &"<sealed>").finish()
    }
}

fn usable(cfg: &Config, d: &Dest) -> bool {
    d.enabled && (d.platform == "custom" || Platform::from_slug(&d.platform).is_some_and(|p| cfg.app(p).is_some()))
}

pub(crate) async fn usable_count(cfg: &Config, db: &sqlx::PgPool, user: Uuid) -> Result<usize, sqlx::Error> {
    Ok(dests_of(db, user).await?.iter().filter(|d| usable(cfg, d)).count())
}

async fn fresh_ingest(cfg: &Config, db: &sqlx::PgPool, user: Uuid, d: &mut Dest) -> Result<(), Fail> {
    match Platform::from_slug(&d.platform) {
        Some(Platform::Youtube) => {
            let app = cfg.app(Platform::Youtube).ok_or(Fail::Shape)?.clone();
            let access = fresh_access(cfg, db, user, d, false).await?;
            let stream = youtube_stream(cfg, &app, &access, true).await?.ok_or(Fail::Shape)?;
            let (_, ingest) = parse_youtube_stream(&stream).ok_or(Fail::Shape)?;
            keep_ingest(cfg, db, user, d, &ingest).await
        }
        Some(_) => refresh_key(cfg, db, user, d).await,
        None => Ok(()),
    }
}

pub(crate) async fn targets(cfg: &Config, db: &sqlx::PgPool, user: Uuid, refresh: Option<Uuid>) -> Result<(Vec<Target>, Vec<(Uuid, String)>), sqlx::Error> {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    for mut d in dests_of(db, user).await? {
        if !usable(cfg, &d) {
            continue;
        }
        let missing = opened(cfg, user, &d.platform, "key", d.key.as_deref()).is_none() || opened(cfg, user, &d.platform, "url", d.url.as_deref()).is_none();
        if let Some(p) = Platform::from_slug(&d.platform).filter(|_| missing || refresh == Some(d.id)) {
            if let Err(f) = fresh_ingest(cfg, db, user, &mut d).await {
                warn(p, "relay key", &f);
                notes.push((d.id, f.words(p)));
                if missing {
                    continue;
                }
            }
        }
        let (Some(url), Some(key)) = (opened(cfg, user, &d.platform, "url", d.url.as_deref()), opened(cfg, user, &d.platform, "key", d.key.as_deref())) else {
            notes.push((d.id, "no stream key yet".to_owned()));
            continue;
        };
        out.push(Target { id: d.id, platform: d.platform.clone(), url, key });
    }
    Ok((out, notes))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/destinations", get(list))
        .route("/api/destinations/custom", post(add_custom))
        .route("/api/destinations/live", post(go_live))
        .route("/api/destinations/stop", post(stop_live))
        .route("/api/destinations/{id}", delete(remove))
        .route("/api/destinations/{id}/enabled", post(set_enabled))
        .route("/api/destinations/{id}/refresh", post(refresh_route))
        .route("/api/auth/{platform}/start", get(start))
        .route("/api/auth/{platform}/callback", get(callback))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    static ONE_MOCK_ACCOUNT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn vars(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_vars(|k| map.get(k).cloned())
    }

    fn query_of(raw: &str) -> HashMap<String, String> {
        url::Url::parse(raw).unwrap().query_pairs().into_owned().collect()
    }

    #[test]
    fn a_sealed_value_opens_only_with_its_own_label() {
        let sealer = Sealer::from_base64(KEY).unwrap();
        let user = Uuid::from_u128(rand::random());
        let sealed = sealer.seal(&aad(user, "twitch", "key"), "live_123_secret");
        assert!(!sealed.windows(6).any(|w| w == b"secret"));
        assert_eq!(sealer.open(&aad(user, "twitch", "key"), &sealed).as_deref(), Some("live_123_secret"));
        assert_eq!(sealer.open(&aad(user, "twitch", "access"), &sealed), None);
        assert_eq!(sealer.open(&aad(Uuid::from_u128(rand::random()), "twitch", "key"), &sealed), None);
        assert_ne!(sealer.seal("a", "x"), sealer.seal("a", "x"));
        assert_eq!(sealer.open("a", &[0u8; 10]), None);
    }

    #[test]
    fn the_key_must_be_32_bytes_of_any_base64() {
        assert!(Sealer::from_base64(KEY).is_some());
        assert!(Sealer::from_base64(KEY.trim_end_matches('=')).is_some());
        assert!(Sealer::from_base64("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").is_some());
        assert!(Sealer::from_base64("AAECAwQFBgcICQoLDA0ODw==").is_none());
        assert!(Sealer::from_base64("not base64 at all!").is_none());
    }

    #[test]
    fn it_stays_off_until_everything_is_set() {
        let all = [
            ("PUBLIC_URL", "https://nodentity.xyz"),
            ("STREAM_KEY_ENC", KEY),
            ("TWITCH_CLIENT_ID", "tid"),
            ("TWITCH_CLIENT_SECRET", "tsecret"),
            ("KICK_CLIENT_ID", "kid"),
            ("KICK_CLIENT_SECRET", "ksecret"),
        ];
        let on = vars(&all);
        assert!(on.on());
        assert_eq!(on.platforms(), vec![Platform::Twitch, Platform::Kick]);
        assert_eq!(on.redirect_uri(Platform::Twitch).as_deref(), Some("https://nodentity.xyz/api/auth/twitch/callback"));
        assert_eq!(on.redirect_uri(Platform::Kick).as_deref(), Some("https://nodentity.xyz/api/auth/kick/callback"));
        for skip in ["PUBLIC_URL", "STREAM_KEY_ENC"] {
            let some: Vec<_> = all.iter().copied().filter(|(k, _)| *k != skip).collect();
            assert!(!vars(&some).on(), "without {skip}");
            assert!(vars(&some).platforms().is_empty());
        }
        let no_apps: Vec<_> = all.iter().copied().filter(|(k, _)| k.starts_with("PUBLIC") || k.starts_with("STREAM")).collect();
        assert!(!vars(&no_apps).on());
        let half: Vec<_> = all.iter().copied().filter(|(k, _)| *k != "KICK_CLIENT_SECRET").collect();
        assert_eq!(vars(&half).platforms(), vec![Platform::Twitch]);
        let bad_key: Vec<_> = all.iter().copied().map(|(k, v)| if k == "STREAM_KEY_ENC" { (k, "c2hvcnQ=") } else { (k, v) }).collect();
        assert!(!vars(&bad_key).on());
        assert!(!vars(&[]).on());
        assert!(authorize_url(&vars(&[]), Platform::Twitch, "s", "v").is_none());
    }

    #[test]
    fn the_authorize_links_carry_the_registered_redirects_and_scopes() {
        let cfg = vars(&[
            ("PUBLIC_URL", "http://localhost:5173/"),
            ("STREAM_KEY_ENC", KEY),
            ("TWITCH_CLIENT_ID", "tid"),
            ("TWITCH_CLIENT_SECRET", "tsecret"),
            ("KICK_CLIENT_ID", "kid"),
            ("KICK_CLIENT_SECRET", "ksecret"),
        ]);
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let twitch = authorize_url(&cfg, Platform::Twitch, "st", verifier).unwrap();
        assert!(twitch.starts_with("https://id.twitch.tv/oauth2/authorize?"));
        let q = query_of(&twitch);
        assert_eq!(q["client_id"], "tid");
        assert_eq!(q["redirect_uri"], "http://localhost:5173/api/auth/twitch/callback");
        assert_eq!(q["scope"], "user:read:email channel:read:stream_key channel:manage:broadcast user:read:chat user:write:chat");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["state"], "st");
        assert_eq!(q["code_challenge"], "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["force_verify"], "true");
        assert!(!twitch.contains("tsecret"));
        let kick = authorize_url(&cfg, Platform::Kick, "st", verifier).unwrap();
        assert!(kick.starts_with("https://id.kick.com/oauth/authorize?"));
        let q = query_of(&kick);
        assert_eq!(q["client_id"], "kid");
        assert_eq!(q["redirect_uri"], "http://localhost:5173/api/auth/kick/callback");
        assert_eq!(q["scope"], "user:read channel:read channel:write streamkey:read chat:write events:subscribe");
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(!q.contains_key("force_verify"));
        assert!(!kick.contains("ksecret"));
    }

    #[test]
    fn tokens_parse_from_either_shape() {
        let now: DateTime<Utc> = "2026-01-01T00:00:00Z".parse().unwrap();
        let twitch = parse_tokens(&json!({"access_token": "a", "refresh_token": "r", "expires_in": 14400, "scope": ["user:read:email", "channel:read:stream_key"], "token_type": "bearer"}), now).unwrap();
        assert_eq!(twitch.access, "a");
        assert_eq!(twitch.refresh.as_deref(), Some("r"));
        assert_eq!(twitch.expires_at, Some(now + chrono::Duration::seconds(14400)));
        assert_eq!(twitch.scopes.as_deref(), Some("user:read:email channel:read:stream_key"));
        let kick = parse_tokens(&json!({"access_token": "a", "refresh_token": "r", "expires_in": "3600", "scope": "user:read channel:read"}), now).unwrap();
        assert_eq!(kick.expires_at, Some(now + chrono::Duration::seconds(3600)));
        assert_eq!(kick.scopes.as_deref(), Some("user:read channel:read"));
        assert!(parse_tokens(&json!({"error": "invalid_grant"}), now).is_none());
        assert!(parse_tokens(&json!({"access_token": ""}), now).is_none());
    }

    #[test]
    fn accounts_and_ingests_parse_from_each_platform() {
        let twitch_user = json!({"data": [{"id": "141981764", "login": "twitchdev", "display_name": "TwitchDev"}]});
        assert_eq!(parse_account(Platform::Twitch, &twitch_user), Some(Account { id: "141981764".into(), name: "twitchdev".into() }));
        let kick_user = json!({"data": [{"user_id": 123, "name": "billy", "email": "x"}], "message": "OK"});
        assert_eq!(parse_account(Platform::Kick, &kick_user), Some(Account { id: "123".into(), name: "billy".into() }));
        assert_eq!(parse_account(Platform::Kick, &json!({"data": []})), None);
        let key = json!({"data": [{"stream_key": "live_44322889_a34ub37c8ajv98a0"}]});
        let ingest = parse_ingest(Platform::Twitch, &key).unwrap();
        assert_eq!(ingest.url, "rtmps://live.twitch.tv:443/app");
        assert!(!format!("{ingest:?}").contains("a34ub37c8ajv98a0"));
        let channel = json!({"data": [{"slug": "billy", "stream": {"url": "rtmps://fa723fc1b171.global-contribute.live-video.net", "key": "sk_us-west-2_x"}}]});
        let ingest = parse_ingest(Platform::Kick, &channel).unwrap();
        assert_eq!(ingest.url, "rtmps://fa723fc1b171.global-contribute.live-video.net");
        assert_eq!(ingest.key, "sk_us-west-2_x");
        assert_eq!(kick_slug(&channel).as_deref(), Some("billy"));
        assert!(parse_ingest(Platform::Kick, &json!({"data": [{"slug": "billy"}]})).is_none());
    }

    #[test]
    fn categories_prefer_an_exact_name() {
        let v = json!({"data": [{"id": "1", "name": "Just Chatting Plus"}, {"id": 509658, "name": "Just Chatting"}]});
        assert_eq!(pick_category(&v, "just chatting", "id").as_deref(), Some("509658"));
        assert_eq!(pick_category(&v, "just", "id").as_deref(), Some("1"));
        assert_eq!(pick_category(&json!({"data": []}), "x", "id"), None);
    }

    #[test]
    fn custom_targets_must_be_rtmp_and_carry_no_login() {
        assert!(check_rtmp_url("rtmp://localhost/live").is_ok());
        assert!(check_rtmp_url("rtmps://a.rtmp.youtube.com/live2").is_ok());
        assert!(check_rtmp_url("https://example.com/live").is_err());
        assert!(check_rtmp_url("rtmp://user:pass@example.com/live").is_err());
        assert!(check_rtmp_url(&format!("rtmp://example.com/{}", "a".repeat(600))).is_err());
        assert!(check_rtmp_url("not a url").is_err());
        assert!(check_key("abcd-1234").is_ok());
        assert!(check_key("").is_err());
        assert!(check_key("has space").is_err());
        assert!(check_key(&"k".repeat(600)).is_err());
        assert_eq!(clean_title("  hello  ").as_deref(), Some("hello"));
        assert_eq!(clean_title("   "), None);
        assert_eq!(clean_title(&"t".repeat(141)).map(|t| t.chars().count()), Some(140));
        assert_eq!(clean_name("bi\u{7}lly"), "billy");
    }

    #[test]
    fn the_state_cookie_stays_under_its_own_path() {
        let c = state_cookie("abc", 600);
        assert!(c.starts_with("dest_state=abc;"));
        assert!(c.contains("Path=/api/auth;") && c.contains("HttpOnly") && c.contains("SameSite=Lax"));
        assert!(gone_cookie().contains("Max-Age=0"));
    }

    async fn mock() -> String {
        use axum::extract::Form;
        async fn token(Form(f): Form<HashMap<String, String>>) -> Result<Json<Value>, StatusCode> {
            match f.get("grant_type").map(String::as_str) {
                Some("authorization_code") if f.get("code").map(String::as_str) == Some("good") && f.get("code_verifier").is_some_and(|v| v.len() == 64) && f.get("client_secret").map(String::as_str) == Some("twitch-secret") => {
                    Ok(Json(json!({"access_token": "acc-1", "refresh_token": "ref-1", "expires_in": 1, "scope": ["user:read:email"]})))
                }
                Some("authorization_code") if f.get("code").map(String::as_str) == Some("second") => Ok(Json(json!({"access_token": "alt-1", "refresh_token": "alt-ref", "expires_in": 14400}))),
                Some("refresh_token") => match f.get("refresh_token").map(String::as_str) {
                    Some("ref-1") => Ok(Json(json!({"access_token": "acc-2", "refresh_token": "ref-2", "expires_in": 14400}))),
                    Some("ref-2") => Ok(Json(json!({"access_token": "acc-3", "expires_in": 14400}))),
                    _ => Err(StatusCode::BAD_REQUEST),
                },
                _ => Err(StatusCode::BAD_REQUEST),
            }
        }
        async fn users(headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
            let client = headers.get("client-id").and_then(|v| v.to_str().ok());
            if client != Some("twitch-client") {
                return Err(StatusCode::UNAUTHORIZED);
            }
            let alt = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).is_some_and(|a| a.starts_with("Bearer alt-"));
            Ok(Json(if alt { json!({"data": [{"id": "5151", "login": "billyalt"}]}) } else { json!({"data": [{"id": "4242", "login": "billy"}]}) }))
        }
        async fn key(headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, StatusCode> {
            let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            let who = q.get("broadcaster_id").map(String::as_str).unwrap_or_default().to_owned();
            let ok = (who == "4242" && auth.starts_with("Bearer acc-")) || (who == "5151" && auth.starts_with("Bearer alt-"));
            if !ok {
                return Err(StatusCode::UNAUTHORIZED);
            }
            Ok(Json(json!({"data": [{"stream_key": format!("live_{who}_{}", &auth[7..])}]})))
        }
        let app = Router::new().route("/token", axum::routing::post(token)).route("/helix/users", get(users)).route("/helix/streams/key", get(key));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    #[ignore]
    async fn connecting_stores_only_sealed_secrets_and_refreshes_them() {
        let _one = ONE_MOCK_ACCOUNT.lock().await;
        let pool = crate::auth::tests::test_db().await;
        let base = mock().await;
        let spec = Spec { authorize_url: format!("{base}/authorize"), token_url: format!("{base}/token"), revoke_url: format!("{base}/revoke"), api_url: format!("{base}/helix") };
        let cfg = Config::for_test("http://localhost:5173", KEY, &[(Platform::Twitch, spec)]);
        let user = crate::auth::tests::row(&pool, &format!("dest-{}", std::process::id()), Some("hash")).await;
        assert!(connect(&cfg, &pool, user, Platform::Twitch, "bad", &random_hex()).await.is_err());
        let id = connect(&cfg, &pool, user, Platform::Twitch, "good", &random_hex()).await.unwrap().0;
        let again = connect(&cfg, &pool, user, Platform::Twitch, "good", &random_hex()).await.unwrap().0;
        assert_eq!(id, again);
        let raw: (Vec<u8>, Vec<u8>, Vec<u8>, String) = sqlx::query_as("SELECT access_token, stream_key, stream_url, external_name FROM stream_destinations WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
        assert!(!raw.0.windows(5).any(|w| w == b"acc-1"));
        assert!(!raw.1.windows(9).any(|w| w == b"live_4242"));
        assert_eq!(raw.3, "billy");
        let mut d = dest_of(&pool, user, id).await.unwrap().unwrap();
        assert_eq!(opened(&cfg, user, "twitch", "key", d.key.as_deref()).as_deref(), Some("live_4242_acc-1"));
        assert_eq!(opened(&cfg, user, "twitch", "url", d.url.as_deref()).as_deref(), Some(TWITCH_INGEST));
        assert_eq!(d.summary().as_object().unwrap().keys().cloned().collect::<Vec<_>>(), vec!["connected_at", "enabled", "has_key", "id", "name", "platform"]);
        assert_eq!(fresh_access(&cfg, &pool, user, &mut d, false).await.unwrap(), "acc-2");
        assert_eq!(fresh_access(&cfg, &pool, user, &mut d, false).await.unwrap(), "acc-2");
        refresh_key(&cfg, &pool, user, &mut dest_of(&pool, user, id).await.unwrap().unwrap()).await.unwrap();
        let d = dest_of(&pool, user, id).await.unwrap().unwrap();
        assert_eq!(opened(&cfg, user, "twitch", "refresh", d.refresh.as_deref()).as_deref(), Some("ref-2"));
        assert_eq!(opened(&cfg, user, "twitch", "access", d.access.as_deref()).as_deref(), Some("acc-3"));
        assert_eq!(opened(&cfg, user, "twitch", "key", d.key.as_deref()).as_deref(), Some("live_4242_acc-3"));
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(user).execute(&pool).await.unwrap();
        assert!(dest_of(&pool, user, id).await.unwrap().is_none());
    }

    #[tokio::test]
    #[ignore]
    async fn the_relay_gets_only_enabled_targets_with_fresh_keys() {
        let _one = ONE_MOCK_ACCOUNT.lock().await;
        let pool = crate::auth::tests::test_db().await;
        let base = mock().await;
        let spec = Spec { authorize_url: format!("{base}/authorize"), token_url: format!("{base}/token"), revoke_url: format!("{base}/revoke"), api_url: format!("{base}/helix") };
        let cfg = Config::for_test("http://localhost:5173", KEY, &[(Platform::Twitch, spec)]);
        sqlx::query("DELETE FROM stream_destinations WHERE platform = 'twitch' AND external_id IN ('4242', '5151')").execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM oauth_identities WHERE provider = 'twitch' AND provider_user_id IN ('4242', '5151')").execute(&pool).await.unwrap();
        let user = crate::auth::tests::row(&pool, &format!("dest-relay-{}", std::process::id()), Some("hash")).await;
        assert_eq!(usable_count(&cfg, &pool, user).await.unwrap(), 0);
        let tw = connect(&cfg, &pool, user, Platform::Twitch, "good", &random_hex()).await.unwrap().0;
        let custom = put_custom(&cfg, &pool, user, "sink", "rtmps://sink.example/live", "sink-key").await.unwrap().0;
        assert_eq!(usable_count(&cfg, &pool, user).await.unwrap(), 2);
        let (list, notes) = targets(&cfg, &pool, user, None).await.unwrap();
        assert!(notes.is_empty());
        let mut got: Vec<(Uuid, String, String, String)> = list.iter().map(|t| (t.id, t.platform.clone(), t.url.clone(), t.key.clone())).collect();
        got.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(got, vec![(custom, "custom".into(), "rtmps://sink.example/live".into(), "sink-key".into()), (tw, "twitch".into(), TWITCH_INGEST.into(), "live_4242_acc-1".into())]);
        assert!(!format!("{:?}", list).contains("sink-key"));
        let (list, _) = targets(&cfg, &pool, user, Some(tw)).await.unwrap();
        assert_eq!(list.iter().find(|t| t.id == tw).map(|t| t.key.as_str()), Some("live_4242_acc-2"));
        switch(&pool, user, custom, false).await.unwrap().unwrap();
        let (list, _) = targets(&cfg, &pool, user, None).await.unwrap();
        assert_eq!(list.iter().map(|t| t.id).collect::<Vec<_>>(), vec![tw]);
        assert_eq!(usable_count(&cfg, &pool, user).await.unwrap(), 1);
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(user).execute(&pool).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn a_twitch_another_login_owns_cannot_be_connected() {
        let _one = ONE_MOCK_ACCOUNT.lock().await;
        let pool = crate::auth::tests::test_db().await;
        let base = mock().await;
        let spec = Spec { authorize_url: format!("{base}/authorize"), token_url: format!("{base}/token"), revoke_url: format!("{base}/revoke"), api_url: format!("{base}/helix") };
        let cfg = Config::for_test("http://localhost:5173", KEY, &[(Platform::Twitch, spec)]);
        let run = std::process::id();
        let a = crate::auth::tests::row(&pool, &format!("dest-own-a-{run}"), Some("hash")).await;
        let b = crate::auth::tests::row(&pool, &format!("dest-own-b-{run}"), Some("hash")).await;
        sqlx::query("DELETE FROM stream_destinations WHERE platform = 'twitch' AND external_id = '4242'").execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM oauth_identities WHERE provider = 'twitch' AND provider_user_id = '4242'").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO oauth_identities (user_id, provider, provider_user_id) VALUES ($1, 'twitch', '4242')").bind(a).execute(&pool).await.unwrap();
        let refused = connect(&cfg, &pool, b, Platform::Twitch, "good", &random_hex()).await;
        assert_eq!(refused, Err("that twitch is already linked to another account".to_owned()));
        let mine = connect(&cfg, &pool, a, Platform::Twitch, "good", &random_hex()).await.expect("a logs in with it and streams to it").0;
        assert_eq!(connect(&cfg, &pool, a, Platform::Twitch, "good", &random_hex()).await.map(|c| c.0), Ok(mine), "connecting again just reconnects");
        sqlx::query("DELETE FROM oauth_identities WHERE provider = 'twitch' AND provider_user_id = '4242'").execute(&pool).await.unwrap();
        assert_eq!(connect(&cfg, &pool, b, Platform::Twitch, "good", &random_hex()).await, Err("that twitch is already linked to another account".to_owned()), "a still streams to it");
        assert!(!owned_elsewhere(&pool, a, Platform::Twitch, "4242").await.unwrap());
        assert!(owned_elsewhere(&pool, b, Platform::Twitch, "4242").await.unwrap());
        for u in [a, b] {
            sqlx::query("DELETE FROM streamers WHERE id = $1").bind(u).execute(&pool).await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore]
    async fn one_place_per_platform_that_reconnects_swaps_and_switches() {
        let _one = ONE_MOCK_ACCOUNT.lock().await;
        let pool = crate::auth::tests::test_db().await;
        let base = mock().await;
        let spec = Spec { authorize_url: format!("{base}/authorize"), token_url: format!("{base}/token"), revoke_url: format!("{base}/revoke"), api_url: format!("{base}/helix") };
        let cfg = Config::for_test("http://localhost:5173", KEY, &[(Platform::Twitch, spec)]);
        let run = std::process::id();
        sqlx::query("DELETE FROM stream_destinations WHERE platform = 'twitch' AND external_id IN ('4242', '5151')").execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM oauth_identities WHERE provider = 'twitch' AND provider_user_id IN ('4242', '5151')").execute(&pool).await.unwrap();
        let user = crate::auth::tests::row(&pool, &format!("dest-one-{run}"), Some("hash")).await;
        let first = connect(&cfg, &pool, user, Platform::Twitch, "good", &random_hex()).await.unwrap().0;
        let off = switch(&pool, user, first, false).await.unwrap().unwrap();
        assert!(!off.enabled);
        assert_eq!(connect(&cfg, &pool, user, Platform::Twitch, "good", &random_hex()).await.unwrap().0, first, "the same account reconnects in place");
        assert!(!dest_of(&pool, user, first).await.unwrap().unwrap().enabled, "a reconnect keeps the switch where it was");
        let swapped = connect(&cfg, &pool, user, Platform::Twitch, "second", &random_hex()).await.unwrap().0;
        assert_eq!(swapped, first, "another twitch account takes the one twitch row");
        let d = dest_of(&pool, user, first).await.unwrap().unwrap();
        assert_eq!((d.external_id.as_deref(), d.name.as_deref(), d.enabled), (Some("5151"), Some("billyalt"), true));
        assert_eq!(opened(&cfg, user, "twitch", "key", d.key.as_deref()).as_deref(), Some("live_5151_alt-1"));
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM stream_destinations WHERE user_id = $1").bind(user).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 1);
        assert!(switch(&pool, user, first, true).await.unwrap().unwrap().enabled);
        assert!(switch(&pool, Uuid::from_u128(rand::random()), first, false).await.unwrap().is_none(), "not someone else's");
        let a = put_custom(&cfg, &pool, user, "a", "rtmp://a/live", "ka").await.unwrap();
        let b = put_custom(&cfg, &pool, user, "b", "rtmps://b/live", "kb").await.unwrap();
        assert_eq!(a.0, b.0, "one custom rtmp, replaced in place");
        let d = dest_of(&pool, user, b.0).await.unwrap().unwrap();
        assert_eq!(opened(&cfg, user, "custom", "url", d.url.as_deref()).as_deref(), Some("rtmps://b/live"));
        assert_eq!(opened(&cfg, user, "custom", "key", d.key.as_deref()).as_deref(), Some("kb"));
        let dup = sqlx::query("INSERT INTO stream_destinations (user_id, platform, external_id) VALUES ($1, 'twitch', 'x-other')").bind(user).execute(&pool).await;
        assert!(dup.is_err_and(|e| crate::unique_violation(&e)), "the database holds one per platform too");
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(user).execute(&pool).await.unwrap();
    }

    #[test]
    fn youtube_stays_hidden_until_it_is_turned_on() {
        let base = [("PUBLIC_URL", "https://nodentity.xyz"), ("STREAM_KEY_ENC", KEY), ("GOOGLE_CLIENT_ID", "gid"), ("GOOGLE_CLIENT_SECRET", "gsecret"), ("TWITCH_CLIENT_ID", "tid"), ("TWITCH_CLIENT_SECRET", "ts")];
        assert_eq!(vars(&base).platforms(), vec![Platform::Twitch], "google login alone does not turn youtube on");
        let mut on = base.to_vec();
        on.push(("YOUTUBE_ENABLED", "1"));
        let cfg = vars(&on);
        assert_eq!(cfg.platforms(), vec![Platform::Twitch, Platform::Youtube]);
        assert_eq!(cfg.app(Platform::Youtube).map(|a| a.id.as_str()), Some("gid"), "the google login client is reused");
        assert_eq!(cfg.redirect_uri(Platform::Youtube).as_deref(), Some("https://nodentity.xyz/api/auth/youtube/callback"));
        let mut own = on.clone();
        own.extend([("YOUTUBE_CLIENT_ID", "yid"), ("YOUTUBE_CLIENT_SECRET", "ys")]);
        assert_eq!(vars(&own).app(Platform::Youtube).map(|a| a.id.as_str()), Some("yid"));
        let mut off = base.to_vec();
        off.push(("YOUTUBE_ENABLED", "0"));
        assert_eq!(vars(&off).platforms(), vec![Platform::Twitch]);
        let url = authorize_url(&cfg, Platform::Youtube, "st", &"v".repeat(64)).unwrap();
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        let q = query_of(&url);
        assert_eq!(q.get("scope").map(String::as_str), Some("https://www.googleapis.com/auth/youtube"));
        assert_eq!(q.get("access_type").map(String::as_str), Some("offline"));
        assert_eq!(q.get("prompt").map(String::as_str), Some("consent"));
        assert_eq!(q.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(q.get("redirect_uri").map(String::as_str), Some("https://nodentity.xyz/api/auth/youtube/callback"));
        assert!(!q.contains_key("force_verify"));
    }

    #[test]
    fn youtube_reasons_read_as_words() {
        let off = json!({"error": {"code": 403, "errors": [{"reason": "liveStreamingNotEnabled", "domain": "youtube.liveBroadcast"}]}});
        assert_eq!(youtube_reason(&off).as_deref(), Some("liveStreamingNotEnabled"));
        assert_eq!(youtube_reason(&json!({"error": {}})), None);
        let words = |r: &str| Fail::Said(r.into()).words(Platform::Youtube);
        assert!(words("liveStreamingNotEnabled").contains("youtube.com/features"));
        assert!(words("livePermissionBlocked").contains("blocked"));
        assert!(words("noChannel").contains("no YouTube channel"));
        assert_eq!(words("somethingNew"), "YouTube said no (somethingNew)");
        let stream = json!({"id": "s1", "cdn": {"ingestionInfo": {"ingestionAddress": "rtmp://a/live2", "rtmpsIngestionAddress": "rtmps://a/live2", "streamName": "k"}}});
        assert_eq!(parse_youtube_stream(&stream), Some(("s1".into(), Ingest { url: "rtmps://a/live2".into(), key: "k".into() })));
        let acct = json!({"items": [{"id": "UC1", "snippet": {"title": "Billy", "customUrl": "@billy"}}]});
        assert_eq!(parse_account(Platform::Youtube, &acct), Some(Account { id: "UC1".into(), name: "@billy".into() }));
        assert_eq!(parse_account(Platform::Youtube, &json!({"items": []})), None);
    }

    #[derive(Default)]
    struct Yt {
        streams: Vec<Value>,
        broadcasts: Vec<Value>,
        revoked: Vec<String>,
    }

    type Shared = Arc<std::sync::Mutex<Yt>>;

    async fn google() -> (String, Shared) {
        use axum::extract::Form;
        fn said(reason: &str) -> (StatusCode, Json<Value>) {
            (StatusCode::FORBIDDEN, Json(json!({"error": {"code": 403, "errors": [{"reason": reason}]}})))
        }
        fn bearer(h: &HeaderMap) -> String {
            h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or_default().trim_start_matches("Bearer ").to_owned()
        }
        async fn token(Form(f): Form<HashMap<String, String>>) -> Result<Json<Value>, StatusCode> {
            if f.get("client_secret").map(String::as_str) != Some("youtube-secret") {
                return Err(StatusCode::UNAUTHORIZED);
            }
            match (f.get("grant_type").map(String::as_str), f.get("code").map(String::as_str)) {
                (Some("authorization_code"), Some(code)) if f.get("code_verifier").is_some_and(|v| v.len() == 64) => match code {
                    "yt-good" => Ok(Json(json!({"access_token": "ya-1", "refresh_token": "yr-1", "expires_in": 3599, "scope": "https://www.googleapis.com/auth/youtube"}))),
                    "yt-off" => Ok(Json(json!({"access_token": "yoff", "refresh_token": "yr-off", "expires_in": 3599}))),
                    "yt-blocked" => Ok(Json(json!({"access_token": "yblk", "refresh_token": "yr-blk", "expires_in": 3599}))),
                    "yt-none" => Ok(Json(json!({"access_token": "ynone", "expires_in": 3599}))),
                    _ => Err(StatusCode::BAD_REQUEST),
                },
                (Some("refresh_token"), _) if f.get("refresh_token").map(String::as_str) == Some("yr-1") => Ok(Json(json!({"access_token": "ya-2", "expires_in": 3599}))),
                _ => Err(StatusCode::BAD_REQUEST),
            }
        }
        async fn channels(headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
            if q.get("mine").map(String::as_str) != Some("true") {
                return (StatusCode::BAD_REQUEST, Json(json!({})));
            }
            let id = match bearer(&headers).as_str() {
                "ya-1" | "ya-2" => "UCbilly",
                "yoff" => "UCoff",
                "yblk" => "UCblk",
                _ => return (StatusCode::OK, Json(json!({"items": []}))),
            };
            (StatusCode::OK, Json(json!({"items": [{"id": id, "snippet": {"title": "Billy", "customUrl": format!("@{}", id.to_lowercase())}}]})))
        }
        async fn list_streams(State(yt): State<Shared>, headers: HeaderMap) -> Json<Value> {
            let mine = bearer(&headers).starts_with("ya-");
            Json(json!({"items": if mine { yt.lock().unwrap().streams.clone() } else { Vec::new() }}))
        }
        async fn add_stream(State(yt): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
            match bearer(&headers).as_str() {
                "yoff" => return said("liveStreamingNotEnabled"),
                "yblk" => return said("livePermissionBlocked"),
                _ => {}
            }
            let cdn = &body["cdn"];
            if cdn["ingestionType"] != "rtmp" || cdn["resolution"] != "variable" || cdn["frameRate"] != "variable" {
                return (StatusCode::BAD_REQUEST, Json(json!({})));
            }
            let mut yt = yt.lock().unwrap();
            let n = yt.streams.len() + 1;
            let made = json!({"id": format!("st-{n}"), "snippet": body["snippet"], "cdn": {"ingestionInfo": {"ingestionAddress": "rtmp://a.rtmp.youtube.com/live2", "rtmpsIngestionAddress": "rtmps://a.rtmps.youtube.com/live2", "streamName": format!("yt-key-{n}")}}});
            yt.streams.push(made.clone());
            (StatusCode::OK, Json(made))
        }
        async fn list_broadcasts(State(yt): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
            let want = match q.get("broadcastStatus").map(String::as_str) {
                Some("upcoming") => "ready",
                Some("active") => "live",
                _ => "",
            };
            let found: Vec<Value> = yt.lock().unwrap().broadcasts.iter().filter(|b| b["status"]["lifeCycleStatus"] == want).cloned().collect();
            Json(json!({"items": found}))
        }
        async fn add_broadcast(State(yt): State<Shared>, Json(mut body): Json<Value>) -> Json<Value> {
            let mut yt = yt.lock().unwrap();
            body["id"] = json!(format!("b-{}", yt.broadcasts.len() + 1));
            body["status"]["lifeCycleStatus"] = json!("ready");
            yt.broadcasts.push(body.clone());
            Json(body)
        }
        async fn put_broadcast(State(yt): State<Shared>, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
            let mut yt = yt.lock().unwrap();
            let Some(b) = yt.broadcasts.iter_mut().find(|b| b["id"] == body["id"]) else {
                return (StatusCode::NOT_FOUND, Json(json!({})));
            };
            if body["snippet"]["scheduledStartTime"].as_str().is_none() {
                return (StatusCode::BAD_REQUEST, Json(json!({})));
            }
            b["snippet"]["title"] = body["snippet"]["title"].clone();
            b["status"]["privacyStatus"] = body["status"]["privacyStatus"].clone();
            (StatusCode::OK, Json(b.clone()))
        }
        async fn bind(State(yt): State<Shared>, Query(q): Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
            let mut yt = yt.lock().unwrap();
            let Some(b) = yt.broadcasts.iter_mut().find(|b| b["id"].as_str() == q.get("id").map(String::as_str)) else {
                return (StatusCode::NOT_FOUND, Json(json!({})));
            };
            b["contentDetails"]["boundStreamId"] = json!(q.get("streamId"));
            (StatusCode::OK, Json(b.clone()))
        }
        async fn transition(State(yt): State<Shared>, Query(q): Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
            let mut yt = yt.lock().unwrap();
            let Some(b) = yt.broadcasts.iter_mut().find(|b| b["id"].as_str() == q.get("id").map(String::as_str)) else {
                return (StatusCode::NOT_FOUND, Json(json!({})));
            };
            if q.get("broadcastStatus").map(String::as_str) != Some("complete") || b["status"]["lifeCycleStatus"] != "live" {
                return said("redundantTransition");
            }
            b["status"]["lifeCycleStatus"] = json!("complete");
            (StatusCode::OK, Json(b.clone()))
        }
        async fn revoke(State(yt): State<Shared>, Form(f): Form<HashMap<String, String>>) -> StatusCode {
            yt.lock().unwrap().revoked.extend(f.get("token").cloned());
            StatusCode::OK
        }
        let yt: Shared = Arc::default();
        let app = Router::new()
            .route("/token", axum::routing::post(token))
            .route("/revoke", axum::routing::post(revoke))
            .route("/yt/channels", get(channels))
            .route("/yt/liveStreams", get(list_streams).post(add_stream))
            .route("/yt/liveBroadcasts", get(list_broadcasts).post(add_broadcast).put(put_broadcast))
            .route("/yt/liveBroadcasts/bind", axum::routing::post(bind))
            .route("/yt/liveBroadcasts/transition", axum::routing::post(transition))
            .with_state(Arc::clone(&yt));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), yt)
    }

    #[tokio::test]
    #[ignore]
    async fn youtube_connects_goes_live_and_stops() {
        let pool = crate::auth::tests::test_db().await;
        let (base, yt) = google().await;
        let spec = Spec { authorize_url: format!("{base}/authorize"), token_url: format!("{base}/token"), revoke_url: format!("{base}/revoke"), api_url: format!("{base}/yt") };
        let cfg = Config::for_test("http://localhost:5173", KEY, &[(Platform::Youtube, spec)]);
        sqlx::query("DELETE FROM stream_destinations WHERE platform = 'youtube' AND external_id IN ('UCbilly', 'UCoff', 'UCblk')").execute(&pool).await.unwrap();
        let run = std::process::id();
        let user = crate::auth::tests::row(&pool, &format!("yt-{run}"), Some("hash")).await;

        let (id, note) = connect(&cfg, &pool, user, Platform::Youtube, "yt-good", &random_hex()).await.unwrap();
        assert_eq!(note, None);
        let mut d = dest_of(&pool, user, id).await.unwrap().unwrap();
        assert_eq!((d.platform.as_str(), d.external_id.as_deref(), d.name.as_deref(), d.enabled), ("youtube", Some("UCbilly"), Some("@ucbilly"), true));
        assert_eq!(opened(&cfg, user, "youtube", "key", d.key.as_deref()).as_deref(), Some("yt-key-1"));
        assert_eq!(opened(&cfg, user, "youtube", "url", d.url.as_deref()).as_deref(), Some("rtmps://a.rtmps.youtube.com/live2"));
        assert_eq!(opened(&cfg, user, "youtube", "refresh", d.refresh.as_deref()).as_deref(), Some("yr-1"), "offline access left a refresh token");
        let raw: Vec<u8> = sqlx::query_scalar("SELECT stream_key FROM stream_destinations WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
        assert!(!raw.windows(8).any(|w| w == b"yt-key-1"));
        assert_eq!(yt.lock().unwrap().streams[0]["snippet"]["title"], YOUTUBE_STREAM);

        let long = "t".repeat(130);
        set_channel(&cfg, &pool, user, &mut d, &long, None, "unlisted").await.unwrap();
        {
            let yt = yt.lock().unwrap();
            assert_eq!(yt.broadcasts.len(), 1);
            let b = &yt.broadcasts[0];
            assert_eq!(b["snippet"]["title"].as_str().map(str::len), Some(100), "youtube titles stop at 100");
            assert_eq!(b["status"]["privacyStatus"], "unlisted");
            assert_eq!(b["status"]["selfDeclaredMadeForKids"], false);
            for flag in ["enableAutoStart", "enableAutoStop", "recordFromStart", "enableDvr"] {
                assert_eq!(b["contentDetails"][flag], true, "{flag}");
            }
            assert_eq!(b["contentDetails"]["boundStreamId"], "st-1");
        }
        set_channel(&cfg, &pool, user, &mut d, "second go", None, "public").await.unwrap();
        {
            let yt = yt.lock().unwrap();
            assert_eq!(yt.broadcasts.len(), 1, "a broadcast that never started is reused");
            assert_eq!(yt.broadcasts[0]["snippet"]["title"], "second go");
            assert_eq!(yt.broadcasts[0]["status"]["privacyStatus"], "public");
        }
        yt.lock().unwrap().broadcasts[0]["status"]["lifeCycleStatus"] = json!("live");
        assert_eq!(youtube_stop(&cfg, &pool, user, &mut d).await.unwrap(), 1);
        assert_eq!(yt.lock().unwrap().broadcasts[0]["status"]["lifeCycleStatus"], "complete");
        assert_eq!(youtube_stop(&cfg, &pool, user, &mut d).await.unwrap(), 0, "nothing left to stop");
        set_channel(&cfg, &pool, user, &mut d, "third", None, "unlisted").await.unwrap();
        assert_eq!(yt.lock().unwrap().broadcasts.len(), 2, "a finished broadcast is not reused");

        assert_eq!(connect(&cfg, &pool, user, Platform::Youtube, "yt-good", &random_hex()).await.unwrap().0, id);
        assert_eq!(yt.lock().unwrap().streams.len(), 1, "the slop stream is reused, so the key stays the same");

        let off = crate::auth::tests::row(&pool, &format!("yt-off-{run}"), Some("hash")).await;
        let (off_id, note) = connect(&cfg, &pool, off, Platform::Youtube, "yt-off", &random_hex()).await.unwrap();
        assert!(note.as_deref().is_some_and(|n| n.contains("youtube.com/features") && n.contains("off")), "{note:?}");
        assert!(dest_of(&pool, off, off_id).await.unwrap().unwrap().key.is_none());
        let mut od = dest_of(&pool, off, off_id).await.unwrap().unwrap();
        let live = set_channel(&cfg, &pool, off, &mut od, "x", None, "unlisted").await.unwrap_err();
        assert!(live.words(Platform::Youtube).contains("youtube.com/features"));

        let blk = crate::auth::tests::row(&pool, &format!("yt-blk-{run}"), Some("hash")).await;
        let (_, note) = connect(&cfg, &pool, blk, Platform::Youtube, "yt-blocked", &random_hex()).await.unwrap();
        assert!(note.as_deref().is_some_and(|n| n.contains("blocked")), "{note:?}");

        let none = crate::auth::tests::row(&pool, &format!("yt-none-{run}"), Some("hash")).await;
        let refused = connect(&cfg, &pool, none, Platform::Youtube, "yt-none", &random_hex()).await.unwrap_err();
        assert!(refused.contains("no YouTube channel"), "{refused}");

        let taken = connect(&cfg, &pool, off, Platform::Youtube, "yt-good", &random_hex()).await;
        assert_eq!(taken, Err("that youtube is already linked to another account".to_owned()));
        assert!(yt.lock().unwrap().revoked.contains(&"ya-1".to_owned()), "a refused connect gives its token back");

        revoke(&cfg, Platform::Youtube, cfg.app(Platform::Youtube).unwrap(), "ya-2").await;
        assert!(yt.lock().unwrap().revoked.contains(&"ya-2".to_owned()));
        for u in [user, off, blk, none] {
            sqlx::query("DELETE FROM streamers WHERE id = $1").bind(u).execute(&pool).await.unwrap();
        }
    }
}
