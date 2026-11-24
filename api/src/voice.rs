//! Voice channels: the grant a page takes to the voice server, and the voice server's own
//! calls back here (docs/voice.md).
//!
//! Joining is two steps. The page asks `POST /api/groups/:group/voice/:channel/join` with its
//! login; the api checks the person may be there and hands back a grant, 32 random bytes as hex,
//! kept in redis as `voicegrant:<hex>` for `GRANT_TTL` seconds. The page gives the grant to the
//! voice server (`/voice`), which redeems it here once (`POST /api/voice/redeem`, GETDEL) and
//! learns who it is talking to. The voice server never sees the cookie, and a grant is good for
//! one connection and half a minute.
//!
//! Who is in a channel is `voice:<server>`, a hash of user id to `{name, channel, seat, since,
//! beat, session}`, and `voiceof:<user>` says `server/channel` for whoever is in one;
//! `voice:servers` is the set of servers with anyone in voice. The voice server writes them
//! through its own calls: `attached` once a person has a seat, `left` when the seat frees, and
//! one `beat` every 15s for everyone seated. Each stay is a `voice_sessions` row (its id is the
//! field's `session`), and each change is a group fact on `group:<server>`, `voice` and
//! `voice_left`, `{who, uid, channel}`. Join only reads them, for `already in voice` and
//! `channel full`.
//!
//! A voice server that dies says nothing, so `sweep` drops every field whose beat is older than
//! `STALE_AFTER` the same way `left` does: its people are gone within a minute.
//!
//! The internal routes answer only inside the compose network: a request caddy passed (it
//! always sets X-Forwarded-For) is a 404, and one without `X-Voice-Secret` equal to
//! VOICE_SECRET is a 403. With VOICE_SECRET unset or empty, voice is off and they are a 503.
//! Neither the secret nor a grant is ever logged.

use std::collections::HashMap;
use std::sync::OnceLock;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::Me;
use crate::group_mod::{allows, CHANNELS};
use crate::groups::{channel_names, may_see, member, tell};
use crate::{ApiError, ApiResult, AppState};

/// How long a grant waits to be redeemed, in seconds.
const GRANT_TTL: u64 = 30;
/// How many fit in a voice channel whose `user_limit` is 0 (no limit set).
const DEFAULT_LIMIT: usize = 16;
/// How often `sweep` looks, in milliseconds.
const SWEEP_EVERY: i64 = 15_000;
/// A field whose beat is older than this, in milliseconds, is a seat nobody holds any more: three
/// beats missed. Swept within `STALE_AFTER + SWEEP_EVERY`, a minute.
const STALE_AFTER: i64 = 45_000;
/// The set of servers that have had anyone in voice, for `sweep`.
const SERVERS_KEY: &str = "voice:servers";

/// Takes field ARGV[1] out of hash KEYS[1] and → it, or nil when it is not there. With ARGV[2]
/// set, a field whose beat is at or past ARGV[2] stays (a beat came in after the sweep looked).
const TAKE: &str = r"
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return false end
if ARGV[2] ~= '' then
  local ok, t = pcall(cjson.decode, v)
  if ok and type(t) == 'table' and tonumber(t.beat) and tonumber(t.beat) >= tonumber(ARGV[2]) then return false end
end
redis.call('HDEL', KEYS[1], ARGV[1])
return v";

/// Sets `beat` to ARGV[2] in field ARGV[1] of hash KEYS[1], only while the field is there: a
/// beat never brings back someone who left. → 1 when it did.
const BEAT: &str = r"
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
local ok, t = pcall(cjson.decode, v)
if not ok or type(t) ~= 'table' then return 0 end
t.beat = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(t))
return 1";

/// Seats everyone in channel ARGV[1] of hash KEYS[1] in channel ARGV[2] instead (a rename), in
/// one go so a beat cannot land between the read and the write and undo it. → their user ids.
const MOVE_SEATS: &str = r"
local moved = {}
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  local ok, t = pcall(cjson.decode, all[i + 1])
  if ok and type(t) == 'table' and t.channel == ARGV[1] then
    t.channel = ARGV[2]
    redis.call('HSET', KEYS[1], all[i], cjson.encode(t))
    moved[#moved + 1] = all[i]
  end
end
return moved";

/// Sets KEYS[1] to ARGV[2] only while it still holds ARGV[1].
const SET_IF: &str = r"
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2]) end
return false";

/// Deletes KEYS[1] only while it still holds ARGV[1].
const DEL_IF: &str = r"
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0";

/// Forgets server ARGV[1] in set KEYS[2] only while its hash KEYS[1] is empty.
const FORGET_IF_EMPTY: &str = r"
if redis.call('HLEN', KEYS[1]) == 0 then return redis.call('SREM', KEYS[2], ARGV[1]) end
return 0";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/groups/{group}/voice/{channel}/join", post(join))
        .route("/api/groups/{group}/voice-mute", post(server_mute))
        .route("/api/groups/{group}/voice-disconnect", post(disconnect))
        .route("/api/voice/redeem", post(redeem))
        .route("/api/voice/attached", post(attached))
        .route("/api/voice/left", post(left))
        .route("/api/voice/beat", post(beat))
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Grant {
    user_id: Uuid,
    name: String,
    server: String,
    channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
}

#[derive(Deserialize, Default)]
struct JoinBody {
    #[serde(default)]
    tab: Option<String>,
}

fn tab_of(tab: Option<String>) -> Result<Option<String>, ApiError> {
    match tab {
        None => Ok(None),
        Some(t) if (1..=64).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => Ok(Some(t)),
        Some(_) => Err(ApiError::new(StatusCode::BAD_REQUEST, "bad tab")),
    }
}

fn grant_key(grant: &str) -> String {
    format!("voicegrant:{grant}")
}

fn voiceof_key(user: Uuid) -> String {
    format!("voiceof:{user}")
}

fn voice_key(server: &str) -> String {
    format!("voice:{server}")
}

/// The set of user ids a moderator muted in `server`'s voice (`server_mute`): their mic carries
/// nothing until a moderator lifts it, across leaving and coming back.
pub(crate) fn muted_key(server: &str) -> String {
    format!("voicemuted:{server}")
}

/// One person in voice: the value of their field in `voice:<server>`. `since` and `beat` are
/// unix milliseconds (as a chat line's `at`), `session` the `voice_sessions` row of this stay.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Seated {
    name: String,
    channel: String,
    seat: usize,
    since: i64,
    beat: i64,
    session: i64,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The beat in a field of `voice:<server>`, None when it has none or is not json.
fn beat_of(field: &str) -> Option<i64> {
    serde_json::from_str::<Value>(field).ok()?["beat"].as_i64()
}

/// Whether a field last beat at `beat` is a seat nobody holds at `now`: more than `STALE_AFTER`
/// seconds ago, or no beat at all.
fn stale(beat: Option<i64>, now: i64) -> bool {
    beat.is_none_or(|b| now - b > STALE_AFTER)
}

/// VOICE_SECRET, read once. None while it is unset or empty: voice is off.
fn secret() -> Option<&'static str> {
    static SECRET: OnceLock<Option<String>> = OnceLock::new();
    SECRET
        .get_or_init(|| std::env::var("VOICE_SECRET").ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()))
        .as_deref()
}

/// Whether two strings are the same, in a time that says nothing about where they differ: both
/// are hashed first, and the digests compared byte by byte with no early way out.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (Sha256::digest(a), Sha256::digest(b));
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// VOICE_SECRET as `secret`, or 503 `voice is off` while it is unset or empty.
fn voice_on(secret: Option<&str>) -> Result<&str, ApiError> {
    secret.ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "voice is off"))
}

/// The gate on every internal route, with VOICE_SECRET as `secret`: 404 for anything caddy
/// passed, 503 `voice is off` without a secret, 403 `bad secret` for a wrong or missing header.
fn inside(headers: &HeaderMap, secret: Option<&str>) -> Result<(), ApiError> {
    if headers.contains_key("x-forwarded-for") {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such route"));
    }
    let secret = voice_on(secret)?;
    let given = headers.get("x-voice-secret").and_then(|v| v.to_str().ok()).unwrap_or("");
    if given.is_empty() || !same(given, secret) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "bad secret"));
    }
    Ok(())
}

fn is_admin(s: &AppState, user: Uuid) -> bool {
    s.admins.iter().any(|a| a.id == user)
}

/// A voice channel this account may be in: a member of the server (403), who sees the channel
/// (404 `no such channel`, a hidden one and a missing one alike), and it is a voice one (400).
/// → its `user_limit`. Join asks this, and redeem asks again: a grant is half a minute old.
async fn may_talk(s: &AppState, user: Uuid, server: &str, channel: &str) -> Result<i32, ApiError> {
    if !member(&s.db, user, server).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the server first"));
    }
    if !may_see(&s.db, server, channel, Some(user), is_admin(s, user)).await? {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    let (kind, limit): (String, i32) = sqlx::query_as("SELECT kind, user_limit FROM channels WHERE server = $1 AND name = $2")
        .bind(server)
        .bind(channel)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such channel"))?;
    if kind != "voice" {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a voice channel"));
    }
    // a timeout keeps them out of voice as it keeps their lines out (group_mod.rs `timeout`)
    let timed_out: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM timeouts WHERE group_name = $1 AND user_id = $2 AND until > now())")
        .bind(server)
        .bind(user)
        .fetch_one(&s.db)
        .await?;
    if timed_out {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "timed out"));
    }
    Ok(limit)
}

/// How many fit: the channel's `user_limit`, `DEFAULT_LIMIT` when that is 0.
fn room_for(user_limit: i32) -> usize {
    match usize::try_from(user_limit) {
        Ok(n) if n > 0 => n,
        _ => DEFAULT_LIMIT,
    }
}

/// How many others are in `channel`, from the fields of `voice:<server>` (user id → json with a
/// `channel`). `user` is not counted: being in it already takes no second seat.
fn others_in(fields: &HashMap<String, String>, channel: &str, user: Uuid) -> usize {
    let me = user.to_string();
    fields
        .iter()
        .filter(|(uid, _)| **uid != me)
        .filter(|(_, v)| serde_json::from_str::<Value>(v).ok().is_some_and(|v| v["channel"] == channel))
        .count()
}

fn new_grant() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn join(
    State(s): State<AppState>,
    Path((group, channel)): Path<(String, String)>,
    Me(me): Me,
    body: Result<Option<Json<JoinBody>>, JsonRejection>,
) -> ApiResult {
    let who = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let tab = tab_of(body?.map(|Json(b)| b).unwrap_or_default().tab)?;
    let (server, channel) = channel_names(&group, &channel)?;
    let limit = may_talk(&s, who.id, &server, &channel).await?;
    let mut redis = s.redis.clone();
    let here = format!("{server}/{channel}");
    let now: Option<String> = redis::cmd("GET").arg(voiceof_key(who.id)).query_async(&mut redis).await?;
    if let Some(now) = now.filter(|now| *now != here) {
        if !stale_voiceof(&s, who.id, &now, tab.as_deref()).await {
            return Err(ApiError::new(StatusCode::CONFLICT, "already in voice"));
        }
    }
    if !allows(&s, who.id, &server, CHANNELS).await? {
        let fields: HashMap<String, String> = redis::cmd("HGETALL").arg(voice_key(&server)).query_async(&mut redis).await?;
        if others_in(&fields, &channel, who.id) >= room_for(limit) {
            return Err(ApiError::new(StatusCode::CONFLICT, "channel full"));
        }
    }
    voice_on(secret())?;
    let grant = new_grant();
    let kept = json!(Grant { user_id: who.id, name: who.name, server, channel, tab }).to_string();
    let set: Option<String> = redis::cmd("SET")
        .arg(grant_key(&grant))
        .arg(kept)
        .arg("EX")
        .arg(GRANT_TTL)
        .arg("NX")
        .query_async(&mut redis)
        .await?;
    if set.is_none() {
        // 256 random bits already taken: never, but not a grant to hand out twice
        return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "try again"));
    }
    Ok(Json(json!({ "url": "/voice", "grant": grant, "ttl": GRANT_TTL })))
}

async fn stale_voiceof(s: &AppState, user: Uuid, now: &str, tab: Option<&str>) -> bool {
    let Some((server, _)) = now.split_once('/') else { return false };
    tell_voice(s, Order::Count, user, server, tab).await == Some(0)
}

#[derive(Deserialize)]
struct RedeemBody {
    grant: String,
}

async fn redeem(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<RedeemBody>, JsonRejection>) -> ApiResult {
    inside(&headers, secret())?;
    let Json(body) = body?;
    let bad_grant = || ApiError::new(StatusCode::FORBIDDEN, "bad grant");
    if body.grant.len() != 64 || !body.grant.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad_grant());
    }
    let kept: Option<String> = redis::cmd("GETDEL").arg(grant_key(&body.grant)).query_async(&mut s.redis.clone()).await?;
    let grant: Grant = kept.and_then(|k| serde_json::from_str(&k).ok()).ok_or_else(bad_grant)?;
    may_talk(&s, grant.user_id, &grant.server, &grant.channel).await?;
    let muted = is_muted(&s, &grant.server, grant.user_id).await?;
    let mut out = json!(grant);
    out["muted"] = json!(muted);
    Ok(Json(out))
}

async fn is_muted(s: &AppState, server: &str, user: Uuid) -> Result<bool, redis::RedisError> {
    redis::cmd("SISMEMBER").arg(muted_key(server)).arg(user.to_string()).query_async(&mut s.redis.clone()).await
}

// ---- moderating voice -----------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Order {
    Mute,
    Unmute,
    Disconnect,
    Count,
}

impl Order {
    fn word(self) -> &'static str {
        match self {
            Order::Mute => "mute",
            Order::Unmute => "unmute",
            Order::Disconnect => "disconnect",
            Order::Count => "count",
        }
    }
}

/// VOICE_URL, the voice server inside the compose network (`http://voice:7881`). Its
/// `/internal/voice` is not behind caddy: caddy sends `/voice` alone there, as `/ws`.
fn voice_url() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        std::env::var("VOICE_URL")
            .ok()
            .map(|u| u.trim().trim_end_matches('/').to_owned())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "http://voice:7881".to_owned())
    })
}

fn order_body(order: Order, user: Uuid, server: &str, tab: Option<&str>) -> Value {
    let mut body = json!({ "action": order.word(), "user_id": user, "server": server });
    if let Some(tab) = tab {
        body["tab"] = json!(tab);
    }
    body
}

fn rename_body(server: &str, from: &str, to: &str) -> Value {
    json!({ "action": "rename", "server": server, "channel": from, "to": to })
}

async fn tell_voice(s: &AppState, order: Order, user: Uuid, server: &str, tab: Option<&str>) -> Option<u64> {
    ask_voice(s, order.word(), &order_body(order, user, server, tab)).await
}

async fn ask_voice(s: &AppState, word: &str, body: &Value) -> Option<u64> {
    let secret = secret()?;
    let res = s.http.post(format!("{}/internal/voice", voice_url())).header("x-voice-secret", secret).json(body).send().await;
    match res {
        Ok(res) if res.status().is_success() => res.json::<Value>().await.ok().and_then(|v| v["seats"].as_u64()),
        Ok(res) => {
            log::warn!("voice {word}: the voice server answered {}", res.status());
            None
        }
        Err(e) => {
            log::warn!("voice {word}: voice server unreachable: {}", e.without_url());
            None
        }
    }
}

fn seated_in(fields: &HashMap<String, String>, channel: Option<&str>) -> Vec<Uuid> {
    fields
        .iter()
        .filter(|(_, v)| channel.is_none_or(|c| serde_json::from_str::<Value>(v).ok().is_some_and(|v| v["channel"] == c)))
        .filter_map(|(uid, _)| Uuid::parse_str(uid).ok())
        .collect()
}

pub(crate) async fn drop_channel_from_voice(s: &AppState, server: &str, channel: Option<&str>) {
    if secret().is_none() {
        return;
    }
    let fields: Result<HashMap<String, String>, redis::RedisError> = redis::cmd("HGETALL").arg(voice_key(server)).query_async(&mut s.redis.clone()).await;
    let fields = match fields {
        Ok(fields) => fields,
        Err(e) => {
            log::warn!("voice drop {server}: {e}");
            return;
        }
    };
    for user in seated_in(&fields, channel) {
        drop_from_voice(s, server, user).await;
    }
}

/// Takes `user` out of voice in `server` now, whatever voice server seats them: a kick, a ban,
/// a timeout (group_mod.rs), a moderator's disconnect. The voice server drops their peer, and
/// their seat leaves the room here at once rather than at its `left`. Never fails the caller:
/// a voice server that does not answer is a warning, and the seat goes from the room anyway.
pub(crate) async fn drop_from_voice(s: &AppState, server: &str, user: Uuid) {
    if secret().is_none() {
        return;
    }
    let now: Result<Option<String>, redis::RedisError> = redis::cmd("GET").arg(voiceof_key(user)).query_async(&mut s.redis.clone()).await;
    let here = match now {
        Ok(now) => now.is_some_and(|w| w.starts_with(&format!("{server}/"))),
        Err(e) => {
            log::warn!("voice drop {server}: {e}");
            true
        }
    };
    if !here {
        return;
    }
    tell_voice(s, Order::Disconnect, user, server, None).await;
    if let Err(e) = leave(s, server, user, None).await {
        log::warn!("voice drop {server}: {}", e.message());
    }
}

#[derive(Deserialize)]
struct MuteBody {
    name: String,
    muted: bool,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

/// The powers that moderate voice: kick (docs/groups.md) or the voice power, which says so.
const VOICE_MOD: i32 = crate::group_mod::KICK | crate::group_mod::VOICE;

/// `POST /api/groups/:group/voice-mute {name, muted}`: a moderator's mute on `name`'s mic in this
/// group's voice, or its lifting. The voice server stops carrying their audio (and starts again);
/// they cannot lift it themselves, and it stays across leaving and coming back. The kick or voice
/// power; not on yourself (400), an owner only by an owner (403), a member (404). A `voice_mute`
/// fact `{who, uid, muted}`. → `{muted}`.
async fn server_mute(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<MuteBody>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let Json(body) = body?;
    let server = crate::group_mod::server(&s.db, &group).await?;
    let (user, name) = crate::group_mod::moderated(&s, &who, &server, VOICE_MOD, &body.name).await?;
    let mut redis = s.redis.clone();
    let changed: i64 = if body.muted {
        redis::cmd("SADD").arg(muted_key(&server)).arg(user.to_string()).query_async(&mut redis).await?
    } else {
        redis::cmd("SREM").arg(muted_key(&server)).arg(user.to_string()).query_async(&mut redis).await?
    };
    tell_voice(&s, if body.muted { Order::Mute } else { Order::Unmute }, user, &server, None).await;
    if changed > 0 {
        log::info!("{}: {} {name} in {server}'s voice", who.name, if body.muted { "muted" } else { "unmuted" });
        tell(&s, &server, "voice_mute", json!({ "who": name, "uid": user, "muted": body.muted })).await;
    }
    Ok(Json(json!({ "muted": body.muted })))
}

/// `POST /api/groups/:group/voice-disconnect {name}`: `name` out of this group's voice now
/// (`drop_from_voice`); they may join again. The kick or voice power, and the rules of
/// `server_mute`. 204, also when they were not in voice.
async fn disconnect(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<NameBody>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let Json(body) = body?;
    let server = crate::group_mod::server(&s.db, &group).await?;
    let (user, name) = crate::group_mod::moderated(&s, &who, &server, VOICE_MOD, &body.name).await?;
    voice_on(secret())?;
    drop_from_voice(&s, &server, user).await;
    log::info!("{}: disconnected {name} from {server}'s voice", who.name);
    Ok(StatusCode::NO_CONTENT)
}

/// Takes `user` out of voice in `server`: their field (with `older_than`, only while its beat is
/// older than that: the sweep's), their open `voice_sessions` rows, `voiceof` while it still
/// names this stay, then `voice_left` to the group. Row first, then the fact. → whether there
/// was a field to take.
async fn leave(s: &AppState, server: &str, user: Uuid, older_than: Option<i64>) -> Result<bool, ApiError> {
    let mut redis = s.redis.clone();
    let taken: Option<String> = redis::cmd("EVAL")
        .arg(TAKE)
        .arg(1)
        .arg(voice_key(server))
        .arg(user.to_string())
        .arg(older_than.map(|t| t.to_string()).unwrap_or_default())
        .query_async(&mut redis)
        .await?;
    if taken.is_none() && older_than.is_some() {
        return Ok(false);
    }
    sqlx::query("UPDATE voice_sessions SET left_at = now() WHERE user_id = $1 AND server = $2 AND left_at IS NULL")
        .bind(user)
        .bind(server)
        .execute(&s.db)
        .await?;
    let Some(taken) = taken else { return Ok(false) };
    let seated = serde_json::from_str::<Value>(&taken).unwrap_or_default();
    let (name, channel) = (seated["name"].as_str().unwrap_or(""), seated["channel"].as_str().unwrap_or(""));
    let _: i64 = redis::cmd("EVAL")
        .arg(DEL_IF)
        .arg(1)
        .arg(voiceof_key(user))
        .arg(format!("{server}/{channel}"))
        .query_async(&mut redis)
        .await?;
    tell(s, server, "voice_left", json!({ "who": name, "uid": user, "channel": channel })).await;
    Ok(true)
}

/// The voice channel `from` of `server` is called `to` now (groups.rs, `edit_channel`): whoever
/// sits in it keeps their seat under the new name, in `voice:<server>` and in their `voiceof`.
pub(crate) async fn follow_rename(s: &AppState, server: &str, from: &str, to: &str) -> Result<(), ApiError> {
    ask_voice(s, "rename", &rename_body(server, from, to)).await;
    let mut redis = s.redis.clone();
    let moved: Vec<String> = redis::cmd("EVAL").arg(MOVE_SEATS).arg(1).arg(voice_key(server)).arg(from).arg(to).query_async(&mut redis).await?;
    for uid in moved {
        let Ok(user) = Uuid::parse_str(&uid) else { continue };
        let _: Option<String> = redis::cmd("EVAL")
            .arg(SET_IF)
            .arg(1)
            .arg(voiceof_key(user))
            .arg(format!("{server}/{from}"))
            .arg(format!("{server}/{to}"))
            .query_async(&mut redis)
            .await?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct AttachedBody {
    user_id: Uuid,
    server: String,
    channel: String,
    seat: usize,
}

/// `POST /api/voice/attached {user_id, server, channel, seat}`: the voice server's, inside only,
/// once the person has a seat. Asks `may_talk` again, takes them out of wherever they were
/// (`leave`), opens a `voice_sessions` row, writes their field, `voiceof` and `voice:servers`,
/// then tells the group `voice {who, uid, channel, muted}`. → `{session}`.
async fn attached(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<AttachedBody>, JsonRejection>) -> ApiResult {
    inside(&headers, secret())?;
    let Json(body) = body?;
    let (server, channel) = channel_names(&body.server, &body.channel)?;
    let user = body.user_id;
    may_talk(&s, user, &server, &channel).await?;
    let name: String = sqlx::query_scalar("SELECT name FROM streamers WHERE id = $1")
        .bind(user)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such account"))?;
    let mut redis = s.redis.clone();
    let was: Option<String> = redis::cmd("GET").arg(voiceof_key(user)).query_async(&mut redis).await?;
    if let Some((old, _)) = was.as_deref().and_then(|w| w.split_once('/')) {
        leave(&s, old, user, None).await?;
    }
    if was.is_none_or(|w| !w.starts_with(&format!("{server}/"))) {
        // a field here that voiceof did not know of (a voice server that restarted)
        leave(&s, &server, user, None).await?;
    }
    let session: i64 = sqlx::query_scalar("INSERT INTO voice_sessions (server, channel, user_id) VALUES ($1, $2, $3) RETURNING id")
        .bind(&server)
        .bind(&channel)
        .bind(user)
        .fetch_one(&s.db)
        .await?;
    let now = now_ms();
    let seated = Seated { name: name.clone(), channel: channel.clone(), seat: body.seat, since: now, beat: now, session };
    let () = redis::pipe()
        .atomic()
        .cmd("HSET")
        .arg(voice_key(&server))
        .arg(user.to_string())
        .arg(json!(seated).to_string())
        .ignore()
        .cmd("SET")
        .arg(voiceof_key(user))
        .arg(format!("{server}/{channel}"))
        .ignore()
        .cmd("SADD")
        .arg(SERVERS_KEY)
        .arg(&server)
        .ignore()
        .query_async(&mut redis)
        .await?;
    // a moderator's mute from before they came rides along, so the room marks the seat at once
    let muted = is_muted(&s, &server, user).await.unwrap_or(false);
    tell(&s, &server, "voice", json!({ "who": name, "uid": user, "channel": channel, "muted": muted })).await;
    Ok(Json(json!({ "session": session })))
}

#[derive(Deserialize)]
struct Peer {
    user_id: Uuid,
    server: String,
}

/// `POST /api/voice/left {user_id, server}`: the voice server's, inside only, when a seat
/// frees. `leave`, and → `{left}`, false when they were not in voice there (already swept, or
/// a second call).
async fn left(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<Peer>, JsonRejection>) -> ApiResult {
    inside(&headers, secret())?;
    let Json(body) = body?;
    let server = body.server.trim().to_lowercase();
    let left = leave(&s, &server, body.user_id, None).await?;
    Ok(Json(json!({ "left": left })))
}

#[derive(Deserialize)]
struct BeatBody {
    peers: Vec<Peer>,
}

async fn beat(State(s): State<AppState>, headers: HeaderMap, body: Result<Json<BeatBody>, JsonRejection>) -> ApiResult {
    inside(&headers, secret())?;
    let Json(body) = body?;
    if body.peers.is_empty() {
        return Ok(Json(json!({ "beat": 0 })));
    }
    let now = now_ms();
    let mut pipe = redis::pipe();
    for peer in &body.peers {
        pipe.cmd("EVAL")
            .arg(BEAT)
            .arg(1)
            .arg(voice_key(&peer.server.trim().to_lowercase()))
            .arg(peer.user_id.to_string())
            .arg(now);
    }
    let found: Vec<i64> = pipe.query_async(&mut s.redis.clone()).await?;
    Ok(Json(json!({ "beat": found.iter().sum::<i64>(), "missing": missing(&body.peers, &found) })))
}

fn missing(peers: &[Peer], found: &[i64]) -> Vec<Value> {
    peers
        .iter()
        .zip(found)
        .filter(|(_, &f)| f == 0)
        .map(|(p, _)| json!({ "user_id": p.user_id, "server": p.server.trim().to_lowercase() }))
        .collect()
}

/// Every `SWEEP_EVERY`, takes out of voice everyone whose beat is older than
/// `STALE_AFTER` (`sweep_once`). Not at boot: after an api outage the voice server's next beat
/// brings its people's fields back to now, and it beats every 15s, so the first sweep waits a
/// full `STALE_AFTER`. Never runs while voice is off.
pub(crate) async fn sweep(s: AppState) {
    if secret().is_none() {
        return;
    }
    let every = std::time::Duration::from_millis(SWEEP_EVERY.unsigned_abs());
    let start = tokio::time::Instant::now() + std::time::Duration::from_millis(STALE_AFTER.unsigned_abs());
    let mut tick = tokio::time::interval_at(start, every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay); // a woken box sweeps once, not n times
    loop {
        tick.tick().await;
        match sweep_once(&s).await {
            Ok(0) => {}
            Ok(n) => log::info!("voice sweep: {n} gone without a word"),
            Err(e) => log::warn!("voice sweep: {}", e.message()),
        }
    }
}

/// One sweep over `voice:servers`: `leave` for each stale field (only while it is still stale,
/// so a beat that lands meanwhile wins), and a server whose hash is empty is forgotten. A field
/// whose key is not a user id is dropped outright. → how many it took out.
async fn sweep_once(s: &AppState) -> Result<usize, ApiError> {
    let mut redis = s.redis.clone();
    let servers: Vec<String> = redis::cmd("SMEMBERS").arg(SERVERS_KEY).query_async(&mut redis).await?;
    let now = now_ms();
    let mut gone = 0;
    for server in servers {
        let fields: HashMap<String, String> = redis::cmd("HGETALL").arg(voice_key(&server)).query_async(&mut redis).await?;
        for (uid, field) in &fields {
            if !stale(beat_of(field), now) {
                continue;
            }
            let Ok(user) = Uuid::parse_str(uid) else {
                let _: i64 = redis::cmd("HDEL").arg(voice_key(&server)).arg(uid).query_async(&mut redis).await?;
                continue;
            };
            match leave(s, &server, user, Some(now - STALE_AFTER)).await {
                Ok(true) => gone += 1,
                Ok(false) => {}
                Err(e) => log::warn!("voice sweep: {server} {user}: {}", e.message()),
            }
        }
        let _: i64 = redis::cmd("EVAL")
            .arg(FORGET_IF_EMPTY)
            .arg(2)
            .arg(voice_key(&server))
            .arg(SERVERS_KEY)
            .arg(&server)
            .query_async(&mut redis)
            .await?;
    }
    Ok(gone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn an_order_says_what_who_and_where() {
        let user = Uuid::from_u128(7);
        assert_eq!(order_body(Order::Mute, user, "g", None), json!({ "action": "mute", "user_id": user, "server": "g" }));
        assert_eq!(order_body(Order::Unmute, user, "g", None)["action"], "unmute");
        assert_eq!(order_body(Order::Disconnect, user, "g", None)["action"], "disconnect");
        assert_eq!(order_body(Order::Count, user, "g", Some("t1")), json!({ "action": "count", "user_id": user, "server": "g", "tab": "t1" }));
        assert_eq!(rename_body("g", "lounge", "hall"), json!({ "action": "rename", "server": "g", "channel": "lounge", "to": "hall" }));
    }

    #[test]
    fn voice_is_moderated_by_kick_or_the_voice_power() {
        use crate::group_mod::{BAN, KICK, VOICE};
        assert_ne!(VOICE_MOD & KICK, 0);
        assert_ne!(VOICE_MOD & VOICE, 0);
        assert_eq!(VOICE_MOD & BAN, 0, "ban alone does not mute");
    }

    #[test]
    fn the_mute_set_is_the_servers() {
        assert_eq!(muted_key("g"), "voicemuted:g");
        assert_ne!(muted_key("g"), voice_key("g"));
    }

    #[test]
    fn the_gate() {
        let mut h = HeaderMap::new();
        assert_eq!(inside(&h, None).unwrap_err().message(), "voice is off");
        assert_eq!(inside(&h, Some("s3cret")).unwrap_err().message(), "bad secret");
        h.insert("x-voice-secret", HeaderValue::from_static("nope"));
        assert_eq!(inside(&h, Some("s3cret")).unwrap_err().message(), "bad secret");
        h.insert("x-voice-secret", HeaderValue::from_static("s3cret"));
        assert!(inside(&h, Some("s3cret")).is_ok());
        h.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9"));
        assert_eq!(inside(&h, Some("s3cret")).unwrap_err().message(), "no such route");
        assert_eq!(inside(&h, None).unwrap_err().message(), "no such route");
        h.insert("x-forwarded-for", HeaderValue::from_static(""));
        assert_eq!(inside(&h, Some("s3cret")).unwrap_err().message(), "no such route");
    }

    #[test]
    fn join_needs_voice_on() {
        let off = voice_on(None).unwrap_err();
        assert_eq!((off.0, off.message()), (StatusCode::SERVICE_UNAVAILABLE, "voice is off"));
        assert_eq!(voice_on(Some("s3cret")).unwrap(), "s3cret");
    }

    #[test]
    fn same_is_equality() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }

    #[test]
    fn a_grant_is_64_hex() {
        let (a, b) = (new_grant(), new_grant());
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert_ne!(a, b);
    }

    #[test]
    fn counting_a_channel() {
        let me = Uuid::from_u128(1);
        let mut f = HashMap::new();
        f.insert(Uuid::from_u128(2).to_string(), r#"{"name":"a","channel":"lounge"}"#.to_owned());
        f.insert(Uuid::from_u128(3).to_string(), r#"{"name":"b","channel":"other"}"#.to_owned());
        f.insert(me.to_string(), r#"{"name":"me","channel":"lounge"}"#.to_owned());
        f.insert(Uuid::from_u128(4).to_string(), "not json".to_owned());
        assert_eq!(others_in(&f, "lounge", me), 1);
        assert_eq!(others_in(&f, "other", me), 1);
        assert_eq!(room_for(0), DEFAULT_LIMIT);
        assert_eq!(room_for(-1), DEFAULT_LIMIT);
        assert_eq!(room_for(3), 3);
    }

    #[test]
    fn who_sits_in_a_channel_that_goes() {
        let mut f = HashMap::new();
        f.insert(Uuid::from_u128(2).to_string(), r#"{"name":"a","channel":"lounge"}"#.to_owned());
        f.insert(Uuid::from_u128(3).to_string(), r#"{"name":"b","channel":"other"}"#.to_owned());
        f.insert(Uuid::from_u128(4).to_string(), "not json".to_owned());
        f.insert("not a uuid".to_owned(), r#"{"name":"c","channel":"lounge"}"#.to_owned());
        assert_eq!(seated_in(&f, Some("lounge")), vec![Uuid::from_u128(2)]);
        assert!(seated_in(&f, Some("gone")).is_empty());
        let mut all = seated_in(&f, None);
        all.sort();
        assert_eq!(all, vec![Uuid::from_u128(2), Uuid::from_u128(3), Uuid::from_u128(4)]);
    }

    #[test]
    fn a_grant_round_trips() {
        let g = Grant { user_id: Uuid::from_u128(7), name: "a".into(), server: "s".into(), channel: "c".into(), tab: None };
        let back: Grant = serde_json::from_str(&json!(g).to_string()).unwrap();
        assert_eq!(back, g);
        assert!(!json!(g).to_string().contains("tab"), "no tab, none said");
        let g = Grant { tab: Some("t1".into()), ..g };
        assert_eq!(json!(g)["tab"], "t1");
        let old: Grant = serde_json::from_str(r#"{"user_id":"00000000-0000-0000-0000-000000000007","name":"a","server":"s","channel":"c"}"#).unwrap();
        assert_eq!(old.tab, None);
    }

    #[test]
    fn a_tab_is_short_and_plain() {
        assert_eq!(tab_of(None).unwrap(), None);
        assert_eq!(tab_of(Some("a1-_Z".into())).unwrap().as_deref(), Some("a1-_Z"));
        assert_eq!(tab_of(Some("x".repeat(64))).unwrap().map(|t| t.len()), Some(64));
        for bad in ["", "a b", "a/b", "é", &"x".repeat(65)] {
            assert_eq!(tab_of(Some(bad.into())).unwrap_err().message(), "bad tab", "{bad:?}");
        }
    }

    #[test]
    fn the_sweep_age_check() {
        let now = 1_795_000_000_000;
        assert!(!stale(Some(now), now));
        assert!(!stale(Some(now - STALE_AFTER), now));
        assert!(stale(Some(now - STALE_AFTER - 1), now));
        assert!(stale(None, now));
        assert!(!stale(Some(now + 5_000), now)); // a clock a little ahead is not stale
        assert_eq!(beat_of(r#"{"name":"a","beat":12}"#), Some(12));
        assert_eq!(beat_of(r#"{"name":"a"}"#), None);
        assert_eq!(beat_of("not json"), None);
        // swept within a minute of the last beat
        const { assert!(STALE_AFTER + SWEEP_EVERY <= 60_000) };
    }

    #[test]
    fn a_beat_names_who_it_did_not_find() {
        let peer = |n: u128, server: &str| Peer { user_id: Uuid::from_u128(n), server: server.into() };
        let peers = [peer(1, "g"), peer(2, " G "), peer(3, "h")];
        assert_eq!(missing(&peers, &[1, 0, 0]), vec![json!({ "user_id": Uuid::from_u128(2), "server": "g" }), json!({ "user_id": Uuid::from_u128(3), "server": "h" })]);
        assert!(missing(&peers, &[1, 1, 1]).is_empty());
    }

    #[test]
    fn a_seated_field_counts_and_beats() {
        let s = Seated { name: "a".into(), channel: "lounge".into(), seat: 3, since: 10, beat: 20, session: 5 };
        let field = json!(s).to_string();
        assert_eq!(beat_of(&field), Some(20));
        let mut f = HashMap::new();
        f.insert(Uuid::from_u128(2).to_string(), field);
        assert_eq!(others_in(&f, "lounge", Uuid::from_u128(1)), 1);
    }
}
