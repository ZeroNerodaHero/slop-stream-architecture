use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use redis::streams::StreamId;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::PgPool;
use tokio::net::TcpStream;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use crate::auth::Me;
use crate::chat::Line;
use crate::destinations::ChatSource;
use crate::{ApiError, ApiResult, AppState, Name};

pub(crate) const MODES: [&str; 3] = ["off", "studio", "everyone"];
pub(crate) const DEFAULT_MODE: &str = "everyone";
const SEEN_SECS: u64 = 900;
const SEEN_LOCAL: usize = 4096;
const LOCK_SECS: u64 = 45;
const TICK: Duration = Duration::from_secs(15);
const GRACE: Duration = Duration::from_secs(120);
const SWEEP: Duration = Duration::from_secs(20);
const STATUS_SECS: u64 = 60;
const RULE_FRESH: Duration = Duration::from_secs(10);
const RULES_MAX: usize = 10_000;
const KEY_FRESH: Duration = Duration::from_secs(3600);
const KEY_RETRY: Duration = Duration::from_secs(300);
const STALE_SECS: i64 = 600;
const HOOK_BODY_MAX: usize = 64 * 1024;
const TEXT_MAX: usize = 500;
const NAME_MAX: usize = 40;
const EMOTE_NAME_MAX: usize = 64;
const PARTS_MAX: usize = 120;
const BADGES_MAX: usize = 6;
const OPEN_SECS: u64 = 10;
const DRAIN: Duration = Duration::from_secs(2);
const KICK_CHECK_EVERY: u32 = 10;
const KICK_BEAT: Duration = Duration::from_secs(30);
const TWITCH_WS: &str = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const TWITCH_EVENT: &str = "channel.chat.message";
const KICK_KEY_URL: &str = "https://api.kick.com/public/v1/public-key";
const KICK_EVENT: &str = "chat.message.sent";
const BACKOFF: [u64; 6] = [1, 2, 4, 8, 16, 30];
const BADGES: [&str; 8] = ["broadcaster", "moderator", "vip", "subscriber", "founder", "staff", "verified", "og"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct External {
    pub(crate) platform: String,
    pub(crate) id: String,
    pub(crate) user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) badges: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) parts: Vec<Part>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub(crate) enum Part {
    Emote { emote: String, url: String },
    Text { text: String },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExtLine {
    pub(crate) name: String,
    pub(crate) text: String,
    pub(crate) ext: External,
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn clean_name(raw: &str) -> Option<String> {
    let name: String = raw.chars().filter(|c| !c.is_control() && !c.is_whitespace()).take(NAME_MAX).collect();
    (!name.is_empty()).then_some(name)
}

fn clean_line_text(raw: &str) -> String {
    let text = crate::chat::clean_text(&raw.replace(['\n', '\r'], " "));
    text.chars().take(TEXT_MAX).collect()
}

fn clean_badge(raw: &str) -> Option<&'static str> {
    let b = raw.trim().to_ascii_lowercase();
    let b = match b.as_str() {
        "sub" | "subscriber" | "sub_gifter" => "subscriber",
        "mod" | "moderator" => "moderator",
        other => other,
    };
    BADGES.iter().copied().find(|k| *k == b)
}

fn badges_of(raw: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for b in raw {
        if let Some(b) = clean_badge(&b) {
            if !out.iter().any(|o| o == b) {
                out.push(b.to_owned());
            }
        }
        if out.len() >= BADGES_MAX {
            break;
        }
    }
    out
}

fn safe_id(id: &str, digits_only: bool) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| if digits_only { b.is_ascii_digit() } else { b.is_ascii_alphanumeric() || b == b'_' })
}

pub(crate) fn twitch_emote_url(id: &str) -> Option<String> {
    safe_id(id, false).then(|| format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0"))
}

pub(crate) fn kick_emote_url(id: &str) -> Option<String> {
    safe_id(id, true).then(|| format!("https://files.kick.com/emotes/{id}/fullsize"))
}

fn push_text(parts: &mut Vec<Part>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Part::Text { text: last }) = parts.last_mut() {
        last.push_str(text);
        return;
    }
    parts.push(Part::Text { text: text.to_owned() });
}

fn clean_part(raw: &str) -> String {
    raw.chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control() && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{feff}'))
        .collect()
}

fn finish_parts(parts: Vec<Part>) -> Vec<Part> {
    let mut left = TEXT_MAX;
    let mut out = Vec::new();
    for p in parts {
        if left == 0 {
            break;
        }
        match p {
            Part::Text { text } => {
                let text: String = clean_part(&text).chars().take(left).collect();
                left -= text.chars().count();
                if !text.is_empty() {
                    out.push(Part::Text { text });
                }
            }
            Part::Emote { emote, url } => {
                left = left.saturating_sub(emote.chars().count());
                out.push(Part::Emote { emote, url });
            }
        }
    }
    if out.len() > PARTS_MAX || !out.iter().any(|p| matches!(p, Part::Emote { .. })) {
        return Vec::new();
    }
    out
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn id_of(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub(crate) fn twitch_line(ev: &Value) -> Option<ExtLine> {
    let id = str_of(ev, "message_id")?.to_owned();
    let user = id_of(ev, "chatter_user_id")?;
    let name = clean_name(str_of(ev, "chatter_user_name").or_else(|| str_of(ev, "chatter_user_login"))?)?;
    let message = ev.get("message")?;
    let text = clean_line_text(str_of(message, "text")?);
    if text.is_empty() {
        return None;
    }
    let color = str_of(ev, "color").filter(|c| valid_color(c)).map(str::to_owned);
    let badges = badges_of(ev.get("badges").and_then(Value::as_array).into_iter().flatten().filter_map(|b| str_of(b, "set_id").map(str::to_owned)));
    let mut parts = Vec::new();
    for f in message.get("fragments").and_then(Value::as_array).into_iter().flatten() {
        let words = str_of(f, "text").unwrap_or_default();
        let emote = (str_of(f, "type") == Some("emote")).then(|| f.get("emote").and_then(|e| str_of(e, "id")).and_then(twitch_emote_url)).flatten();
        match emote {
            Some(url) if !words.trim().is_empty() && words.chars().count() <= EMOTE_NAME_MAX => parts.push(Part::Emote { emote: words.trim().to_owned(), url }),
            _ => push_text(&mut parts, words),
        }
    }
    Some(ExtLine { name, text, ext: External { platform: "twitch".into(), id, user, color, badges, parts: finish_parts(parts) } })
}

pub(crate) fn kick_parts(content: &str) -> (String, Vec<Part>) {
    let mut parts = Vec::new();
    let mut plain = String::new();
    let mut rest = content;
    while let Some(at) = rest.find("[emote:") {
        let (before, tail) = rest.split_at(at);
        push_text(&mut parts, before);
        plain.push_str(before);
        let parsed = tail.find(']').and_then(|end| {
            let inner = &tail[7..end];
            let (id, name) = inner.split_once(':')?;
            let url = kick_emote_url(id)?;
            let name = name.trim();
            (!name.is_empty() && name.chars().count() <= EMOTE_NAME_MAX && !name.contains('[')).then(|| (end, name.to_owned(), url))
        });
        match parsed {
            Some((end, name, url)) => {
                plain.push_str(&name);
                parts.push(Part::Emote { emote: name, url });
                rest = &tail[end + 1..];
            }
            None => {
                push_text(&mut parts, "[");
                plain.push('[');
                rest = &tail[1..];
            }
        }
    }
    push_text(&mut parts, rest);
    plain.push_str(rest);
    (clean_line_text(&plain), finish_parts(parts))
}

pub(crate) fn kick_line(body: &Value) -> Option<(String, ExtLine)> {
    let id = id_of(body, "message_id")?;
    let broadcaster = id_of(body.get("broadcaster")?, "user_id")?;
    let sender = body.get("sender")?;
    let user = id_of(sender, "user_id")?;
    let name = clean_name(str_of(sender, "username")?)?;
    let (text, parts) = kick_parts(str_of(body, "content")?);
    if text.is_empty() {
        return None;
    }
    let identity = sender.get("identity");
    let color = identity.and_then(|i| str_of(i, "username_color")).filter(|c| valid_color(c)).map(str::to_owned);
    let badges = badges_of(identity.and_then(|i| i.get("badges")).and_then(Value::as_array).into_iter().flatten().filter_map(|b| str_of(b, "type").map(str::to_owned)));
    Some((broadcaster, ExtLine { name, text, ext: External { platform: "kick".into(), id, user, color, badges, parts } }))
}

pub(crate) fn fields(line: &ExtLine) -> Vec<(&'static str, String)> {
    let mut out = vec![
        ("from", line.name.clone()),
        ("text", line.text.clone()),
        ("streamer", "0".to_owned()),
        ("v", "0".to_owned()),
        ("src", line.ext.platform.clone()),
        ("xid", line.ext.id.clone()),
        ("xu", line.ext.user.clone()),
    ];
    if let Some(c) = &line.ext.color {
        out.push(("xc", c.clone()));
    }
    if !line.ext.badges.is_empty() {
        out.push(("xb", line.ext.badges.join(",")));
    }
    if !line.ext.parts.is_empty() {
        if let Ok(p) = serde_json::to_string(&line.ext.parts) {
            out.push(("xp", p));
        }
    }
    out
}

pub(crate) fn external_from(entry: &StreamId) -> Option<External> {
    let platform: String = entry.get("src")?;
    if !matches!(platform.as_str(), "twitch" | "kick") {
        return None;
    }
    let id: String = entry.get("xid")?;
    let user: String = entry.get("xu")?;
    let color = entry.get::<String>("xc").filter(|c| valid_color(c));
    let badges = badges_of(entry.get::<String>("xb").unwrap_or_default().split(',').map(str::to_owned));
    let parts: Vec<Part> = entry.get::<String>("xp").and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_default();
    let parts = parts
        .into_iter()
        .filter(|p| match p {
            Part::Emote { url, .. } => url.starts_with("https://static-cdn.jtvnw.net/emoticons/") || url.starts_with("https://files.kick.com/emotes/"),
            Part::Text { .. } => true,
        })
        .collect();
    Some(External { platform, id, user, color, badges, parts })
}

pub(crate) fn seen_key(platform: &str, id: &str) -> String {
    format!("xmsg:{platform}:{id}")
}

pub(crate) struct Recent {
    order: VecDeque<String>,
    set: HashSet<String>,
    cap: usize,
}

impl Recent {
    pub(crate) fn new(cap: usize) -> Self {
        Recent { order: VecDeque::new(), set: HashSet::new(), cap }
    }

    pub(crate) fn has(&self, key: &str) -> bool {
        self.set.contains(key)
    }

    pub(crate) fn first(&mut self, key: &str) -> bool {
        if self.set.contains(key) {
            return false;
        }
        self.set.insert(key.to_owned());
        self.order.push_back(key.to_owned());
        while self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

fn recent() -> &'static Mutex<Recent> {
    static RECENT: OnceLock<Mutex<Recent>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(Recent::new(SEEN_LOCAL)))
}

pub(crate) async fn append(redis: &crate::timings::Redis, room: &str, line: &ExtLine) -> Result<bool, redis::RedisError> {
    let key = seen_key(&line.ext.platform, &line.ext.id);
    if recent().lock().expect("recent").has(&key) {
        return Ok(false);
    }
    let mut r = redis.clone();
    let fresh: Option<String> = redis::cmd("SET").arg(&key).arg(1).arg("NX").arg("EX").arg(SEEN_SECS).query_async(&mut r).await?;
    if fresh.is_none() {
        recent().lock().expect("recent").first(&key);
        return Ok(false);
    }
    let room_key = crate::chat::room_key(room);
    let pairs = fields(line);
    let added: Result<(), _> = redis::pipe()
        .atomic()
        .cmd("XADD").arg(&room_key).arg("MAXLEN").arg("~").arg(crate::chat::KEEP_LINES).arg("*").arg(&pairs).ignore()
        .cmd("EXPIRE").arg(&room_key).arg(crate::chat::ROOM_TTL_SECS).ignore()
        .query_async(&mut r)
        .await;
    if let Err(e) = added {
        let _: Result<(), _> = redis::cmd("DEL").arg(&key).query_async(&mut r).await;
        return Err(e);
    }
    recent().lock().expect("recent").first(&key);
    Ok(true)
}

struct Rule {
    owner: Option<Uuid>,
    mode: String,
}

fn rules() -> &'static Mutex<HashMap<String, (Instant, Arc<Rule>)>> {
    static RULES: OnceLock<Mutex<HashMap<String, (Instant, Arc<Rule>)>>> = OnceLock::new();
    RULES.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn rule(db: &PgPool, room: &str) -> Arc<Rule> {
    if let Some((at, r)) = rules().lock().expect("rules").get(room) {
        if at.elapsed() < RULE_FRESH {
            return r.clone();
        }
    }
    let row: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as("SELECT id, external_chat FROM streamers WHERE name = $1").bind(room).fetch_optional(db).await;
    let r = Arc::new(match row {
        Ok(Some((owner, mode))) => Rule { owner: Some(owner), mode },
        Ok(None) => Rule { owner: None, mode: DEFAULT_MODE.to_owned() },
        Err(e) => {
            log::warn!("{room}: cannot read who sees platform chat: {e}");
            return Arc::new(Rule { owner: None, mode: "off".into() });
        }
    });
    let mut map = rules().lock().expect("rules");
    if map.len() > RULES_MAX {
        map.clear();
    }
    map.insert(room.to_owned(), (Instant::now(), r.clone()));
    r
}

fn forget_rule(room: &str) {
    rules().lock().expect("rules").remove(room);
}

fn visible(rule: &Rule, streamer: bool, viewer: Option<Uuid>) -> bool {
    rule.mode == "everyone" || streamer || (viewer.is_some() && viewer == rule.owner)
}

pub(crate) async fn shows(db: &PgPool, room: &str, streamer: bool, viewer: Option<Uuid>) -> bool {
    if room.contains('/') {
        return false;
    }
    let r = rule(db, room).await;
    visible(r.as_ref(), streamer, viewer)
}

pub(crate) async fn keep_visible(db: &PgPool, room: &str, viewer: Option<Uuid>, lines: &mut Vec<Line>) {
    if !lines.iter().any(|l| l.source.is_some()) {
        return;
    }
    if !shows(db, room, false, viewer).await {
        lines.retain(|l| l.source.is_none());
    }
}

#[derive(Clone)]
pub(crate) struct Gate {
    db: PgPool,
    room: String,
    viewer: Option<Uuid>,
}

impl Gate {
    pub(crate) fn new(db: PgPool, room: &str, viewer: Option<Uuid>) -> Self {
        Gate { db, room: room.to_owned(), viewer }
    }

    pub(crate) async fn allows(&self) -> bool {
        shows(&self.db, &self.room, false, self.viewer).await
    }
}

pub(crate) async fn mode_of(db: &PgPool, user: Uuid) -> Result<String, sqlx::Error> {
    let mode: Option<String> = sqlx::query_scalar("SELECT external_chat FROM streamers WHERE id = $1").bind(user).fetch_optional(db).await?;
    Ok(mode.unwrap_or_else(|| DEFAULT_MODE.to_owned()))
}

#[derive(Deserialize)]
pub(crate) struct ModeBody {
    mode: String,
}

pub(crate) async fn put_mode(State(s): State<AppState>, Me(me): Me, body: Result<Json<ModeBody>, JsonRejection>) -> ApiResult {
    if !s.destinations.on() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not found"));
    }
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let Json(body) = body?;
    if !MODES.contains(&body.mode.as_str()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "mode is off, studio or everyone"));
    }
    let mode: String = sqlx::query_scalar("UPDATE streamers SET external_chat = $2, updated_at = now() WHERE id = $1 RETURNING external_chat")
        .bind(me.id)
        .bind(&body.mode)
        .fetch_one(&s.db)
        .await?;
    forget_rule(&me.name);
    if mode != "off" && crate::relay::restreaming(&s, me.id).await.unwrap_or(false) {
        wake(&s, me.id, &me.name);
    }
    Ok(Json(json!({ "external_chat": mode })))
}

pub(crate) fn sources_for(mode: &str, owner: bool, platforms: Vec<&'static str>) -> Vec<&'static str> {
    match mode {
        "everyone" => platforms,
        "studio" if owner => platforms,
        _ => Vec::new(),
    }
}

async fn chat_sources_route(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> ApiResult {
    let row: Option<(Uuid, String)> = sqlx::query_as("SELECT id, external_chat FROM streamers WHERE name = $1").bind(&name).fetch_optional(&s.db).await?;
    let Some((owner, mode)) = row else {
        return Ok(Json(json!({ "sources": [], "external_chat": DEFAULT_MODE })));
    };
    let mut platforms: Vec<&'static str> = Vec::new();
    if s.destinations.on() {
        for src in crate::destinations::chat_sources(&s.destinations, &s.db, owner).await? {
            if !platforms.contains(&src.platform) {
                platforms.push(src.platform);
            }
        }
    }
    platforms.sort_by_key(|p| if *p == "twitch" { 0 } else { 1 });
    let mine = me.as_ref().is_some_and(|m| m.id == owner);
    let sources = sources_for(&mode, mine, platforms);
    Ok(Json(json!({ "sources": sources, "external_chat": if mine { Some(mode) } else { None } })))
}

fn status_key(user: Uuid) -> String {
    format!("xchat:status:{user}")
}

fn lock_key(user: Uuid) -> String {
    format!("xchat:lock:{user}")
}

fn on_key(user: Uuid) -> String {
    format!("xchat:on:{user}")
}

async fn set_status(s: &AppState, user: Uuid, dest: Uuid, state: &str, message: Option<&str>) {
    let v = json!({ "state": state, "message": message, "at": chrono::Utc::now().timestamp_millis() });
    let r: Result<(), _> = redis::pipe()
        .cmd("HSET").arg(status_key(user)).arg(dest.to_string()).arg(v.to_string()).ignore()
        .cmd("EXPIRE").arg(status_key(user)).arg(STATUS_SECS).ignore()
        .query_async(&mut s.redis.clone())
        .await;
    if let Err(e) = r {
        log::warn!("platform chat: status: {e}");
    }
}

pub(crate) async fn statuses(s: &AppState, user: Uuid) -> HashMap<Uuid, Value> {
    let raw: HashMap<String, String> = redis::cmd("HGETALL").arg(status_key(user)).query_async(&mut s.redis.clone()).await.unwrap_or_default();
    raw.into_iter().filter_map(|(k, v)| Some((k.parse().ok()?, serde_json::from_str(&v).ok()?))).collect()
}

fn running() -> &'static Mutex<HashMap<Uuid, AbortHandle>> {
    static RUNNING: OnceLock<Mutex<HashMap<Uuid, AbortHandle>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn wake(s: &AppState, user: Uuid, name: &str) {
    if !s.destinations.on() {
        return;
    }
    let mut map = running().lock().expect("running");
    if map.get(&user).is_some_and(|h| !h.is_finished()) {
        return;
    }
    let task = tokio::spawn(run(s.clone(), user, name.to_owned()));
    map.insert(user, task.abort_handle());
}

pub(crate) fn spawn(s: AppState) {
    if !s.destinations.on() {
        log::info!("platform chat: off (destinations are off)");
        return;
    }
    tokio::spawn(async move {
        loop {
            match crate::relay::restreamers(&s).await {
                Ok(list) => {
                    for (user, name) in list {
                        wake(&s, user, &name);
                    }
                }
                Err(e) => log::warn!("platform chat: cannot list restreams: {e}"),
            }
            tokio::time::sleep(SWEEP).await;
        }
    });
}

async fn take_lock(s: &AppState, user: Uuid, token: &str) -> bool {
    let got: Result<Option<String>, _> = redis::cmd("SET").arg(lock_key(user)).arg(token).arg("NX").arg("EX").arg(LOCK_SECS).query_async(&mut s.redis.clone()).await;
    matches!(got, Ok(Some(_)))
}

async fn renew_lock(s: &AppState, user: Uuid, token: &str) -> bool {
    let kept: Result<i64, _> = redis::cmd("EVAL")
        .arg("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end")
        .arg(1)
        .arg(lock_key(user))
        .arg(token)
        .arg(LOCK_SECS)
        .query_async(&mut s.redis.clone())
        .await;
    matches!(kept, Ok(1))
}

async fn drop_lock(s: &AppState, user: Uuid, token: &str) {
    let _: Result<i64, _> = redis::cmd("EVAL")
        .arg("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end")
        .arg(1)
        .arg(lock_key(user))
        .arg(token)
        .query_async(&mut s.redis.clone())
        .await;
}

struct Source {
    platform: &'static str,
    task: JoinHandle<()>,
}

async fn run(s: AppState, user: Uuid, name: String) {
    let token = crate::oauth::random_hex();
    if !take_lock(&s, user, &token).await {
        return;
    }
    log::info!("{name}: platform chat on");
    let mut sources: HashMap<Uuid, Source> = HashMap::new();
    let mut idle: Option<Instant> = None;
    loop {
        if !renew_lock(&s, user, &token).await {
            log::warn!("{name}: platform chat lost its lock");
            break;
        }
        match crate::relay::restreaming(&s, user).await {
            Ok(false) => {
                if idle.get_or_insert_with(Instant::now).elapsed() >= GRACE {
                    break;
                }
            }
            _ => idle = None,
        }
        let mode = mode_of(&s.db, user).await;
        let wanted: Option<Vec<ChatSource>> = match mode.as_deref() {
            Ok("off") => Some(Vec::new()),
            Ok(_) => crate::destinations::chat_sources(&s.destinations, &s.db, user).await.ok(),
            Err(_) => None,
        };
        if let Some(wanted) = wanted {
            let ids: HashSet<Uuid> = wanted.iter().map(|w| w.id).collect();
            sources.retain(|id, src| {
                let keep = ids.contains(id) && !src.task.is_finished();
                if !keep {
                    src.task.abort();
                }
                keep
            });
            for w in wanted {
                if sources.contains_key(&w.id) {
                    continue;
                }
                let platform = w.platform;
                let task = match platform {
                    "twitch" => tokio::spawn(twitch_loop(s.clone(), user, name.clone(), w.id, w.external_id)),
                    _ => tokio::spawn(kick_keeper(s.clone(), user, w.id, w.external_id)),
                };
                sources.insert(w.id, Source { platform, task });
            }
        }
        let on: Result<(), _> = if sources.values().any(|src| src.platform == "kick") {
            redis::cmd("SET").arg(on_key(user)).arg(&name).arg("EX").arg(LOCK_SECS).query_async(&mut s.redis.clone()).await
        } else {
            redis::cmd("DEL").arg(on_key(user)).query_async(&mut s.redis.clone()).await
        };
        if let Err(e) = on {
            log::warn!("{name}: platform chat: {e}");
        }
        tokio::time::sleep(TICK).await;
    }
    for (id, src) in sources.drain() {
        src.task.abort();
        if src.platform == "kick" {
            kick_unsubscribe(&s, user, id).await;
        }
    }
    let _: Result<(), _> = redis::cmd("DEL").arg(on_key(user)).arg(status_key(user)).query_async(&mut s.redis.clone()).await;
    drop_lock(&s, user, &token).await;
    log::info!("{name}: platform chat off");
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

enum Ended {
    Lost(String),
    Fatal(String),
}

pub(crate) fn twitch_reconnect_ok(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.scheme() == "wss" && u.host_str().is_some_and(|h| h == "eventsub.wss.twitch.tv" || h.ends_with(".twitch.tv")))
}

async fn open(url: &str) -> Result<(Ws, String, u64), String> {
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(OPEN_SECS), tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| "twitch did not answer".to_owned())?
        .map_err(|e| format!("could not reach twitch ({e})"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(OPEN_SECS);
    loop {
        let next = tokio::time::timeout_at(deadline, ws.next()).await.map_err(|_| "twitch sent no welcome".to_owned())?;
        match next {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(t.as_str()).map_err(|_| "twitch sent junk".to_owned())?;
                if v.pointer("/metadata/message_type").and_then(Value::as_str) != Some("session_welcome") {
                    continue;
                }
                let id = v.pointer("/payload/session/id").and_then(Value::as_str).ok_or("twitch sent no session")?.to_owned();
                let keep = v.pointer("/payload/session/keepalive_timeout_seconds").and_then(Value::as_u64).unwrap_or(30).clamp(10, 600);
                return Ok((ws, id, keep));
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("twitch closed ({e})")),
            None => return Err("twitch closed".into()),
        }
    }
}

async fn subscribe(s: &AppState, user: Uuid, dest: Uuid, broadcaster: &str, session: &str) -> Result<(), Ended> {
    let cfg = &s.destinations;
    let (Some(client_id), Some(api)) = (crate::destinations::twitch_client_id(cfg), crate::destinations::chat_api_url(cfg, "twitch")) else {
        return Err(Ended::Fatal("twitch is off on this site".into()));
    };
    let body = json!({
        "type": TWITCH_EVENT,
        "version": "1",
        "condition": { "broadcaster_user_id": broadcaster, "user_id": broadcaster },
        "transport": { "method": "websocket", "session_id": session },
    });
    let http = crate::destinations::chat_http(cfg);
    for force in [false, true] {
        let access = crate::destinations::chat_access(cfg, &s.db, user, dest, force).await.map_err(Ended::Fatal)?;
        let res = http
            .post(format!("{api}/eventsub/subscriptions"))
            .bearer_auth(&access)
            .header("Client-Id", &client_id)
            .json(&body)
            .send()
            .await
            .map_err(|e| Ended::Lost(format!("could not reach twitch ({})", e.without_url())))?;
        match res.status().as_u16() {
            200..=299 | 409 => return Ok(()),
            401 if !force => continue,
            401 | 403 => return Err(Ended::Fatal("twitch did not let slop read chat. connect twitch again".into())),
            429 => return Err(Ended::Lost("twitch says slow down".into())),
            code => return Err(Ended::Lost(format!("twitch said {code}"))),
        }
    }
    Err(Ended::Fatal("twitch did not let slop read chat. connect twitch again".into()))
}

enum Step {
    Go,
    Reconnect(String),
    End(Ended),
}

async fn on_frame(s: &AppState, room: &str, broadcaster: &str, frame: Result<Message, tokio_tungstenite::tungstenite::Error>) -> Step {
    match frame {
        Ok(Message::Text(t)) => {
            let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { return Step::Go };
            match v.pointer("/metadata/message_type").and_then(Value::as_str) {
                Some("notification") => {
                    if v.pointer("/metadata/subscription_type").and_then(Value::as_str) != Some(TWITCH_EVENT) {
                        return Step::Go;
                    }
                    let Some(ev) = v.pointer("/payload/event") else { return Step::Go };
                    if id_of(ev, "broadcaster_user_id").as_deref() != Some(broadcaster) {
                        return Step::Go;
                    }
                    if let Some(line) = twitch_line(ev) {
                        if let Err(e) = append(&s.redis, room, &line).await {
                            log::warn!("{room}: twitch line: {e}");
                        }
                    }
                    Step::Go
                }
                Some("session_reconnect") => match v.pointer("/payload/session/reconnect_url").and_then(Value::as_str) {
                    Some(url) if twitch_reconnect_ok(url) => Step::Reconnect(url.to_owned()),
                    _ => Step::End(Ended::Lost("twitch asked to reconnect".into())),
                },
                Some("revocation") => {
                    let why = v.pointer("/payload/subscription/status").and_then(Value::as_str).unwrap_or("revoked");
                    Step::End(Ended::Fatal(format!("twitch stopped the chat feed ({why}). connect twitch again")))
                }
                _ => Step::Go,
            }
        }
        Ok(Message::Close(c)) => Step::End(Ended::Lost(format!("twitch closed ({})", c.map(|c| u16::from(c.code)).unwrap_or(1000)))),
        Ok(_) => Step::Go,
        Err(e) => Step::End(Ended::Lost(format!("twitch dropped ({e})"))),
    }
}

async fn twitch_session(s: &AppState, user: Uuid, room: &str, dest: Uuid, broadcaster: &str) -> Ended {
    let (mut ws, session, mut keep) = match open(TWITCH_WS).await {
        Ok(o) => o,
        Err(e) => return Ended::Lost(e),
    };
    if let Err(e) = subscribe(s, user, dest, broadcaster, &session).await {
        let _ = ws.close(None).await;
        return e;
    }
    set_status(s, user, dest, "live", None).await;
    log::info!("{room}: reading twitch chat");
    loop {
        let quiet = Duration::from_secs(keep + 10);
        let next = match tokio::time::timeout(quiet, ws.next()).await {
            Ok(Some(f)) => f,
            Ok(None) => return Ended::Lost("twitch closed".into()),
            Err(_) => return Ended::Lost("twitch went quiet".into()),
        };
        if let Ok(Message::Ping(p)) = &next {
            let _ = ws.send(Message::Pong(p.clone())).await;
        }
        match on_frame(s, room, broadcaster, next).await {
            Step::Go => {}
            Step::End(e) => return e,
            Step::Reconnect(url) => {
                let (mut fresh, _, k) = match open(&url).await {
                    Ok(o) => o,
                    Err(e) => return Ended::Lost(e),
                };
                let until = tokio::time::Instant::now() + DRAIN;
                while let Ok(Some(f)) = tokio::time::timeout_at(until, ws.next()).await {
                    if let Step::End(_) = on_frame(s, room, broadcaster, f).await {
                        break;
                    }
                }
                let _ = ws.close(None).await;
                std::mem::swap(&mut ws, &mut fresh);
                keep = k;
                set_status(s, user, dest, "live", None).await;
            }
        }
        set_status(s, user, dest, "live", None).await;
    }
}

async fn twitch_loop(s: AppState, user: Uuid, room: String, dest: Uuid, broadcaster: String) {
    let mut fails = 0usize;
    loop {
        set_status(&s, user, dest, "connecting", None).await;
        let started = Instant::now();
        let wait = match twitch_session(&s, user, &room, dest, &broadcaster).await {
            Ended::Lost(why) => {
                if started.elapsed() > Duration::from_secs(60) {
                    fails = 0;
                }
                log::info!("{room}: twitch chat: {why}");
                set_status(&s, user, dest, "connecting", Some(&why)).await;
                let w = BACKOFF[fails.min(BACKOFF.len() - 1)];
                fails += 1;
                w
            }
            Ended::Fatal(why) => {
                log::warn!("{room}: twitch chat: {why}");
                set_status(&s, user, dest, "error", Some(&why)).await;
                60
            }
        };
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

async fn kick_call(s: &AppState, user: Uuid, dest: Uuid, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, String> {
    let cfg = &s.destinations;
    let api = crate::destinations::chat_api_url(cfg, "kick").ok_or("kick is off on this site")?;
    let http = crate::destinations::chat_http(cfg);
    for force in [false, true] {
        let access = crate::destinations::chat_access(cfg, &s.db, user, dest, force).await?;
        let mut req = http.request(method.clone(), format!("{api}{path}")).bearer_auth(&access).header("Accept", "application/json").query(query);
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(|e| format!("could not reach kick ({})", e.without_url()))?;
        match res.status().as_u16() {
            204 => return Ok(Value::Null),
            200..=299 => return res.json().await.map_err(|_| "kick sent junk".to_owned()),
            401 if !force => continue,
            401 | 403 => return Err("kick did not let slop read chat. connect kick again".into()),
            429 => return Err("kick says slow down".into()),
            code => return Err(format!("kick said {code}")),
        }
    }
    Err("kick did not let slop read chat. connect kick again".into())
}

pub(crate) fn kick_subscription_ids(list: &Value, broadcaster: &str) -> Vec<String> {
    list.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|row| str_of(row, "event") == Some(KICK_EVENT) && str_of(row, "method").unwrap_or("webhook") == "webhook")
        .filter(|row| id_of(row, "broadcaster_user_id").is_none_or(|b| b == broadcaster))
        .filter_map(|row| str_of(row, "id").map(str::to_owned))
        .collect()
}

async fn kick_ensure(s: &AppState, user: Uuid, dest: Uuid, broadcaster: &str) -> Result<(), String> {
    let list = kick_call(s, user, dest, reqwest::Method::GET, "/events/subscriptions", &[("broadcaster_user_id", broadcaster.to_owned())], None).await?;
    if !kick_subscription_ids(&list, broadcaster).is_empty() {
        return Ok(());
    }
    let id: i64 = broadcaster.parse().map_err(|_| "kick account id is not a number".to_owned())?;
    let body = json!({ "broadcaster_user_id": id, "method": "webhook", "events": [{ "name": KICK_EVENT, "version": 1 }] });
    let made = kick_call(s, user, dest, reqwest::Method::POST, "/events/subscriptions", &[], Some(&body)).await?;
    match made.pointer("/data/0/error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        Some(e) => Err(format!("kick said no ({})", e.chars().take(80).collect::<String>())),
        None => Ok(()),
    }
}

async fn kick_unsubscribe(s: &AppState, user: Uuid, dest: Uuid) {
    let Some(broadcaster) = crate::destinations::chat_sources(&s.destinations, &s.db, user).await.ok().and_then(|l| l.into_iter().find(|c| c.id == dest)).map(|c| c.external_id) else { return };
    let list = match kick_call(s, user, dest, reqwest::Method::GET, "/events/subscriptions", &[("broadcaster_user_id", broadcaster.clone())], None).await {
        Ok(l) => l,
        Err(e) => {
            log::info!("kick unsubscribe: {e}");
            return;
        }
    };
    let ids: Vec<(&str, String)> = kick_subscription_ids(&list, &broadcaster).into_iter().map(|id| ("id", id)).collect();
    if ids.is_empty() {
        return;
    }
    if let Err(e) = kick_call(s, user, dest, reqwest::Method::DELETE, "/events/subscriptions", &ids, None).await {
        log::info!("kick unsubscribe: {e}");
    }
}

async fn kick_keeper(s: AppState, user: Uuid, dest: Uuid, broadcaster: String) {
    let mut beat = 0u32;
    let mut last: (String, Option<String>) = ("connecting".into(), None);
    loop {
        if beat % KICK_CHECK_EVERY == 0 {
            last = match kick_ensure(&s, user, dest, &broadcaster).await {
                Ok(()) => ("live".into(), None),
                Err(e) => {
                    log::warn!("kick chat subscription: {e}");
                    beat = KICK_CHECK_EVERY - 2;
                    ("error".into(), Some(e))
                }
            };
        }
        set_status(&s, user, dest, &last.0, last.1.as_deref()).await;
        beat = beat.wrapping_add(1);
        tokio::time::sleep(KICK_BEAT).await;
    }
}

pub(crate) fn kick_signed(pem: &str, id: &str, at: &str, body: &[u8], signature: &str) -> bool {
    let Ok(key) = RsaPublicKey::from_public_key_pem(pem.trim()) else { return false };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(signature.trim()) else { return false };
    let Ok(sig) = Signature::try_from(raw.as_slice()) else { return false };
    let mut signed = Vec::with_capacity(id.len() + at.len() + body.len() + 2);
    signed.extend_from_slice(id.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(at.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(body);
    VerifyingKey::<Sha256>::new(key).verify(&signed, &sig).is_ok()
}

fn kick_key_cache() -> &'static Mutex<Option<(Instant, String)>> {
    static KEY: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
    KEY.get_or_init(|| Mutex::new(None))
}

pub(crate) fn kick_key_from(v: &Value) -> Option<String> {
    let pem = v.pointer("/data/public_key").and_then(Value::as_str)?;
    RsaPublicKey::from_public_key_pem(pem.trim()).ok()?;
    Some(pem.trim().to_owned())
}

async fn kick_key(s: &AppState, fresh: bool) -> Option<(Instant, String)> {
    if !fresh {
        if let Some((at, pem)) = kick_key_cache().lock().expect("kick key").clone() {
            if at.elapsed() < KEY_FRESH {
                return Some((at, pem));
            }
        }
    }
    let got = async {
        let res = crate::destinations::chat_http(&s.destinations).get(KICK_KEY_URL).header("Accept", "application/json").send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        kick_key_from(&res.json::<Value>().await.ok()?)
    }
    .await;
    match got {
        Some(pem) => {
            let now = Instant::now();
            *kick_key_cache().lock().expect("kick key") = Some((now, pem.clone()));
            Some((now, pem))
        }
        None => {
            log::warn!("kick webhook: cannot fetch kick's public key");
            kick_key_cache().lock().expect("kick key").clone()
        }
    }
}

fn header<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty())
}

pub(crate) fn stale(at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::DateTime::parse_from_rfc3339(at) {
        Ok(t) => (now - t.with_timezone(&chrono::Utc)).num_seconds().abs() > STALE_SECS,
        Err(_) => true,
    }
}

async fn kick_hook(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> StatusCode {
    if !s.destinations.on() || crate::destinations::chat_api_url(&s.destinations, "kick").is_none() {
        return StatusCode::NOT_FOUND;
    }
    if body.len() > HOOK_BODY_MAX {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let (Some(id), Some(at), Some(sig), Some(kind), Some(version)) = (
        header(&headers, "kick-event-message-id"),
        header(&headers, "kick-event-message-timestamp"),
        header(&headers, "kick-event-signature"),
        header(&headers, "kick-event-type"),
        header(&headers, "kick-event-version"),
    ) else {
        return StatusCode::BAD_REQUEST;
    };
    let Some((got, pem)) = kick_key(&s, false).await else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let mut ok = kick_signed(&pem, id, at, &body, sig);
    if !ok && got.elapsed() > KEY_RETRY {
        if let Some((_, pem)) = kick_key(&s, true).await {
            ok = kick_signed(&pem, id, at, &body, sig);
        }
    }
    if !ok {
        log::warn!("kick webhook: bad signature, dropped");
        return StatusCode::UNAUTHORIZED;
    }
    if stale(at, chrono::Utc::now()) || kind != KICK_EVENT || version != "1" {
        return StatusCode::OK;
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else { return StatusCode::BAD_REQUEST };
    let Some((broadcaster, line)) = kick_line(&v) else { return StatusCode::OK };
    let owner = match crate::destinations::kick_owner(&s.db, &broadcaster).await {
        Ok(Some(o)) => o,
        Ok(None) => return StatusCode::OK,
        Err(e) => {
            log::warn!("kick webhook: postgres: {e}");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    let on: Result<Option<String>, _> = redis::cmd("GET").arg(on_key(owner.0)).query_async(&mut s.redis.clone()).await;
    match on {
        Ok(Some(room)) if room == owner.1 => {}
        Ok(_) => return StatusCode::OK,
        Err(e) => {
            log::warn!("kick webhook: redis: {e}");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    }
    match append(&s.redis, &owner.1, &line).await {
        Ok(_) => StatusCode::OK,
        Err(e) => {
            log::warn!("{}: kick line: {e}", owner.1);
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hooks/kick", post(kick_hook))
        .route("/api/streamers/{name}/chat-sources", get(chat_sources_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KICK_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwS6j25E62mQWkTj45yfp\n6lOv2w8RAg6akCcKid7BZ13c1QhG2Hia0uIRNG5MGkkBwLKFpkprV3QdnA1/12Rz\nNNlCnu+Oh8mnHYX+sJA5Hkk3ktgvZmv7Ylq4xzqZEKoTVIOa5lEsa9mcJxk1X/Yb\n8ORQPNJeTmr2c1ejD81/bhaK+1CDrQrJApJMRAh7Wyw5dWDmEViGRNrZl60D4inZ\nd4EMGGzRKSbYReEtdQs1IFRfwZr9Iu4V9hjvPd5IayvaTh56f/koqHto8dgfWIW2\nAMRcFWkahg3sxncSnGasUZsbp/xPWYxwlpAjHsjn2OSrmTVaFICGRuMPo8wHUWF/\ndQIDAQAB\n-----END PUBLIC KEY-----";
    const KICK_SIG: &str = "FRZx1ls9pGlsBeo3lB2IOrzdXt77pimgm0ieIlrwwU15KgOhYOpthhWRKv0zIhQO3DOLaC+ZAws816c7Way90xu/jNyO80OAuloaxP/8RJcsn9vSjvPT7Gw2C7SdxDVUyzv5kryjWzKBEB5shEkZ6IDrDxSKqrY3wafSapP7a9ULAgzN49eUE2c790jRDUM3UFA8WlcsEWcTMP4FQbYGGCzwY4HrpiTGH/4q6sfSxlSOMLEHL/QPaLzG92w0PBHe39E/z+VLFhJ9H/CObQnos5Byp+qKzt33O7VF3L3Uo7/HD7tBzdr+mr8JOqtQxvIQk7dCucz06iOC2gKQ7A3mSw==";
    const KICK_ID: &str = "01JTESTMSG";
    const KICK_AT: &str = "2026-11-28T06:00:00Z";
    const KICK_BODY: &str = r#"{"message_id":"m1","content":"hi"}"#;

    #[test]
    fn kick_signatures_verify_against_a_known_vector() {
        assert!(kick_signed(KICK_PEM, KICK_ID, KICK_AT, KICK_BODY.as_bytes(), KICK_SIG));
    }

    #[test]
    fn kick_signatures_fail_closed() {
        assert!(!kick_signed(KICK_PEM, KICK_ID, KICK_AT, br#"{"message_id":"m1","content":"hI"}"#, KICK_SIG), "a changed body");
        assert!(!kick_signed(KICK_PEM, "01JOTHER", KICK_AT, KICK_BODY.as_bytes(), KICK_SIG), "a changed id");
        assert!(!kick_signed(KICK_PEM, KICK_ID, "2026-11-28T06:00:01Z", KICK_BODY.as_bytes(), KICK_SIG), "a changed time");
        assert!(!kick_signed(KICK_PEM, KICK_ID, KICK_AT, KICK_BODY.as_bytes(), ""), "no signature");
        assert!(!kick_signed(KICK_PEM, KICK_ID, KICK_AT, KICK_BODY.as_bytes(), "not base64!"), "junk signature");
        assert!(!kick_signed("not a key", KICK_ID, KICK_AT, KICK_BODY.as_bytes(), KICK_SIG), "junk key");
        let mut flipped = base64::engine::general_purpose::STANDARD.decode(KICK_SIG).unwrap();
        flipped[10] ^= 1;
        let flipped = base64::engine::general_purpose::STANDARD.encode(flipped);
        assert!(!kick_signed(KICK_PEM, KICK_ID, KICK_AT, KICK_BODY.as_bytes(), &flipped), "a flipped bit");
    }

    #[test]
    fn kick_public_key_answers_are_read_and_checked() {
        let v = json!({ "data": { "public_key": KICK_PEM }, "message": "OK" });
        assert_eq!(kick_key_from(&v).as_deref(), Some(KICK_PEM));
        assert_eq!(kick_key_from(&json!({ "data": { "public_key": "nope" } })), None);
        assert_eq!(kick_key_from(&json!({})), None);
    }

    #[test]
    fn old_or_bad_timestamps_are_stale() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-28T06:05:00Z").unwrap().with_timezone(&chrono::Utc);
        assert!(!stale("2026-11-28T06:00:00Z", now));
        assert!(stale("2026-11-28T05:50:00Z", now));
        assert!(stale("2026-11-28T06:20:00Z", now));
        assert!(stale("yesterday", now));
    }

    fn twitch_event() -> Value {
        json!({
            "broadcaster_user_id": "1971641",
            "chatter_user_id": "4145994",
            "chatter_user_login": "viewer32",
            "chatter_user_name": "Viewer32",
            "message_id": "cc106a89-1814-919d-454c-f4f2f970aae7",
            "message": {
                "text": "Hi chat Kappa",
                "fragments": [
                    { "type": "text", "text": "Hi chat ", "cheermote": null, "emote": null, "mention": null },
                    { "type": "emote", "text": "Kappa", "emote": { "id": "25", "emote_set_id": "0" } }
                ]
            },
            "color": "#00FF7F",
            "badges": [{ "set_id": "moderator", "id": "1", "info": "" }, { "set_id": "subscriber", "id": "12", "info": "16" }, { "set_id": "sub-gift-leader", "id": "1", "info": "" }],
            "message_type": "text"
        })
    }

    #[test]
    fn a_twitch_message_maps_to_a_line() {
        let line = twitch_line(&twitch_event()).unwrap();
        assert_eq!(line.name, "Viewer32");
        assert_eq!(line.text, "Hi chat Kappa");
        assert_eq!(line.ext.platform, "twitch");
        assert_eq!(line.ext.id, "cc106a89-1814-919d-454c-f4f2f970aae7");
        assert_eq!(line.ext.user, "4145994");
        assert_eq!(line.ext.color.as_deref(), Some("#00FF7F"));
        assert_eq!(line.ext.badges, vec!["moderator", "subscriber"]);
        assert_eq!(
            line.ext.parts,
            vec![Part::Text { text: "Hi chat ".into() }, Part::Emote { emote: "Kappa".into(), url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0".into() }]
        );
    }

    #[test]
    fn twitch_lines_are_cleaned_and_bad_ones_dropped() {
        let mut ev = twitch_event();
        ev["color"] = json!("red");
        ev["message"]["fragments"] = json!([{ "type": "text", "text": "plain" }]);
        ev["message"]["text"] = json!("plain\u{200b}\nline");
        let line = twitch_line(&ev).unwrap();
        assert_eq!(line.ext.color, None);
        assert!(line.ext.parts.is_empty(), "no emotes, no parts");
        assert!(!line.text.contains('\n') && !line.text.contains('\u{200b}'));
        let mut bad = twitch_event();
        bad["message"]["fragments"] = json!([{ "type": "emote", "text": "x", "emote": { "id": "../../evil" } }]);
        assert!(twitch_line(&bad).unwrap().ext.parts.is_empty(), "a bad emote id is plain text");
        let mut empty = twitch_event();
        empty["message"]["text"] = json!("   ");
        assert_eq!(twitch_line(&empty), None);
        let mut nameless = twitch_event();
        nameless.as_object_mut().unwrap().remove("chatter_user_id");
        assert_eq!(twitch_line(&nameless), None);
    }

    #[test]
    fn a_kick_message_maps_to_a_line() {
        let body = json!({
            "message_id": "unique_message_id_123",
            "broadcaster": { "user_id": 123456789, "username": "broadcaster_name" },
            "sender": {
                "user_id": 987654321,
                "username": "sender_name",
                "identity": { "username_color": "#FF5733", "badges": [{ "text": "Moderator", "type": "moderator" }, { "text": "Sub Gifter", "type": "sub_gifter", "count": 5 }] }
            },
            "content": "Hello [emote:4148074:HYPERCLAP] [emote:37226:KEKW]",
            "created_at": "2025-01-14T16:08:06Z"
        });
        let (broadcaster, line) = kick_line(&body).unwrap();
        assert_eq!(broadcaster, "123456789");
        assert_eq!(line.name, "sender_name");
        assert_eq!(line.text, "Hello HYPERCLAP KEKW");
        assert_eq!(line.ext.user, "987654321");
        assert_eq!(line.ext.color.as_deref(), Some("#FF5733"));
        assert_eq!(line.ext.badges, vec!["moderator", "subscriber"]);
        assert_eq!(line.ext.parts.len(), 4);
        assert_eq!(line.ext.parts[1], Part::Emote { emote: "HYPERCLAP".into(), url: "https://files.kick.com/emotes/4148074/fullsize".into() });
        let (text, parts) = kick_parts("a [emote:x:y] [b] [emote:12:");
        assert_eq!(text, "a [emote:x:y] [b] [emote:12:");
        assert!(parts.is_empty());
    }

    fn entry(id: &str, pairs: &[(&str, &str)]) -> StreamId {
        StreamId { id: id.into(), map: pairs.iter().map(|(k, v)| (k.to_string(), redis::Value::BulkString(v.as_bytes().to_vec()))).collect(), ..StreamId::default() }
    }

    #[test]
    fn lines_round_trip_through_the_stream_fields() {
        let line = twitch_line(&twitch_event()).unwrap();
        let pairs = fields(&line);
        let borrowed: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let e = entry("1-1", &borrowed);
        assert_eq!(external_from(&e), Some(line.ext.clone()));
        let parsed = crate::chat::line_from(e).unwrap();
        assert_eq!(parsed.from, "Viewer32");
        assert!(!parsed.streamer && !parsed.verified && parsed.user_id.is_none());
        assert_eq!(parsed.source, Some(line.ext));
        let wire = serde_json::to_value(&parsed).unwrap();
        assert_eq!(wire["source"]["platform"], "twitch");
        assert_eq!(crate::chat::line_from(entry("1-2", &[("from", "ann"), ("text", "hi")])).unwrap().source, None);
        assert_eq!(external_from(&entry("1-3", &[("src", "myspace"), ("xid", "1"), ("xu", "2")])), None);
    }

    #[test]
    fn stored_emote_urls_must_stay_on_the_platform_cdns() {
        let ext = external_from(&entry("1-1", &[("src", "kick"), ("xid", "1"), ("xu", "2"), ("xp", r#"[{"text":"a"},{"emote":"x","url":"https://evil.example/x.png"}]"#)])).unwrap();
        assert_eq!(ext.parts, vec![Part::Text { text: "a".into() }]);
    }

    #[test]
    fn dedupe_keeps_the_first_and_forgets_the_oldest() {
        let mut seen = Recent::new(2);
        assert!(seen.first(&seen_key("twitch", "a")));
        assert!(!seen.first(&seen_key("twitch", "a")), "a repeat is dropped");
        assert!(seen.first(&seen_key("kick", "a")), "another platform's id is its own");
        assert!(seen.first(&seen_key("twitch", "b")));
        assert!(!seen.has(&seen_key("twitch", "a")), "the oldest falls out past the cap");
        assert!(seen.has(&seen_key("twitch", "b")));
        assert_eq!(seen_key("kick", "m1"), "xmsg:kick:m1");
    }

    #[test]
    fn who_sees_platform_lines() {
        let owner = Uuid::from_u128(42);
        let everyone = Rule { owner: Some(owner), mode: "everyone".into() };
        let studio = Rule { owner: Some(owner), mode: "studio".into() };
        let off = Rule { owner: Some(owner), mode: "off".into() };
        assert!(visible(&everyone, false, None));
        assert!(!visible(&studio, false, None));
        assert!(!visible(&studio, false, Some(Uuid::from_u128(7))));
        assert!(visible(&studio, false, Some(owner)));
        assert!(visible(&studio, true, None));
        assert!(!visible(&off, false, None));
        assert_eq!(sources_for("everyone", false, vec!["twitch", "kick"]), vec!["twitch", "kick"]);
        assert!(sources_for("studio", false, vec!["twitch"]).is_empty());
        assert_eq!(sources_for("studio", true, vec!["kick"]), vec!["kick"]);
        assert!(sources_for("off", true, vec!["kick"]).is_empty());
    }

    #[test]
    fn reconnect_urls_must_be_twitch() {
        assert!(twitch_reconnect_ok("wss://eventsub.wss.twitch.tv/ws?id=abc"));
        assert!(!twitch_reconnect_ok("ws://eventsub.wss.twitch.tv/ws"));
        assert!(!twitch_reconnect_ok("wss://evil.example/ws"));
        assert!(!twitch_reconnect_ok("wss://twitch.tv.evil.example/ws"));
    }

    #[test]
    fn kick_subscriptions_are_found_by_event() {
        let list = json!({ "data": [
            { "id": "s1", "event": "chat.message.sent", "method": "webhook", "broadcaster_user_id": 7 },
            { "id": "s2", "event": "channel.followed", "method": "webhook", "broadcaster_user_id": 7 },
            { "id": "s3", "event": "chat.message.sent", "method": "webhook", "broadcaster_user_id": 8 }
        ]});
        assert_eq!(kick_subscription_ids(&list, "7"), vec!["s1"]);
        assert!(kick_subscription_ids(&json!({}), "7").is_empty());
    }
}
