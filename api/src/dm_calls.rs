use std::collections::HashMap;
use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{Account, Me};
use crate::{dms, follows, presence, voice};
use crate::{ApiError, ApiResult, AppState, Name};

pub(crate) const PREFIX: &str = "dm--";
pub(crate) const CHANNEL: &str = "call";
pub(crate) const SEATS: usize = 2;
const HASH_CHARS: usize = 28;
const RING_SECS: i64 = 30;
const KEEP_SECS: i64 = 12 * 3600;
const PAIR_SECS: i64 = 24 * 3600;
const LEFT_GRACE: Duration = Duration::from_secs(8);
const AWAY_MS: i64 = 15_000;
const CALLS_KEY: &str = "dmcalls";
const CALLS_PER_MINUTE: i64 = 10;
const RATE_WINDOW_SECS: i64 = 60;

const RING: &str = r"
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'caller', ARGV[2], 'callee', ARGV[3], 'state', 'ringing', 'rung', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1";

const ACCEPT: &str = r"
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'state') ~= 'ringing' then return 0 end
if redis.call('HGET', KEYS[1], 'callee') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'accepted', 'accepted', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1";

const TAKE: &str = r"
local id = redis.call('HGET', KEYS[1], 'id')
if not id then return false end
if ARGV[1] ~= '' and id ~= ARGV[1] then return false end
if ARGV[2] ~= '' and redis.call('HGET', KEYS[1], 'state') ~= ARGV[2] then return false end
local all = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return all";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/dm/{name}/call", post(start))
        .route("/api/dm/{name}/call/accept", post(accept))
        .route("/api/dm/{name}/call/decline", post(decline))
        .route("/api/dm/{name}/call/end", post(end))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Ringing,
    Accepted,
}

impl Phase {
    fn word(self) -> &'static str {
        match self {
            Phase::Ringing => "ringing",
            Phase::Accepted => "accepted",
        }
    }
}

#[derive(Debug, PartialEq)]
struct Call {
    id: String,
    caller: Uuid,
    callee: Uuid,
    phase: Phase,
    rung: i64,
    accepted: Option<i64>,
    away: Option<i64>,
}

impl Call {
    fn from_fields(f: &HashMap<String, String>) -> Option<Call> {
        let phase = match f.get("state")?.as_str() {
            "ringing" => Phase::Ringing,
            "accepted" => Phase::Accepted,
            _ => return None,
        };
        Some(Call {
            id: f.get("id")?.clone(),
            caller: Uuid::parse_str(f.get("caller")?).ok()?,
            callee: Uuid::parse_str(f.get("callee")?).ok()?,
            phase,
            rung: f.get("rung")?.parse().ok()?,
            accepted: f.get("accepted").and_then(|a| a.parse().ok()),
            away: f.get("away").and_then(|a| a.parse().ok()),
        })
    }

    fn has(&self, user: Uuid) -> bool {
        user == self.caller || user == self.callee
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum How {
    Hangup,
    Declined,
    Timeout,
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Missed,
    Declined,
    Ended(i64),
}

impl Outcome {
    fn of(call: &Call, how: How, now: i64) -> Outcome {
        match call.accepted {
            Some(at) => Outcome::Ended((now - at).max(0) / 1000),
            None if how == How::Declined => Outcome::Declined,
            None => Outcome::Missed,
        }
    }

    fn what(&self) -> &'static str {
        match self {
            Outcome::Missed => "missed",
            Outcome::Declined => "declined",
            Outcome::Ended(_) => "ended",
        }
    }

    fn line(&self) -> String {
        match self {
            Outcome::Ended(secs) => format!("call ended ({})", clock(*secs)),
            _ => "missed call".to_owned(),
        }
    }

    fn secs(&self) -> Option<i64> {
        match self {
            Outcome::Ended(secs) => Some(*secs),
            _ => None,
        }
    }
}

pub(crate) fn clock(secs: i64) -> String {
    let secs = secs.max(0);
    let (h, m, s) = (secs / 3600, secs / 60 % 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

pub(crate) fn room_of(a: Uuid, b: Uuid) -> String {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    let digest = Sha256::digest(format!("{lo}:{hi}"));
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{PREFIX}{}", &hex[..HASH_CHARS])
}

pub(crate) fn is_room(server: &str) -> bool {
    server.len() == PREFIX.len() + HASH_CHARS
        && server.starts_with(PREFIX)
        && server[PREFIX.len()..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn room_named(server: &str) -> Option<String> {
    let server = server.trim().to_lowercase();
    is_room(&server).then_some(server)
}

fn may_join(call: &Call, room: &str, user: Uuid) -> Result<(), &'static str> {
    if room_of(call.caller, call.callee) != room {
        return Err("no such call");
    }
    if user == call.caller || (user == call.callee && call.phase == Phase::Accepted) {
        return Ok(());
    }
    if user == call.callee {
        return Err("answer the call first");
    }
    Err("not your call")
}

fn call_key(room: &str) -> String {
    format!("dmcall:{room}")
}

fn pair_key(room: &str) -> String {
    format!("dmpair:{room}")
}

fn new_id() -> String {
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn no_call() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no call")
}

async fn load(s: &AppState, room: &str) -> Result<Option<Call>, ApiError> {
    let fields: HashMap<String, String> = redis::cmd("HGETALL").arg(call_key(room)).query_async(&mut s.redis.clone()).await?;
    Ok(Call::from_fields(&fields))
}

pub(crate) async fn may_talk(s: &AppState, user: Uuid, room: &str, channel: &str) -> Result<(), ApiError> {
    if channel.trim().to_lowercase() != CHANNEL {
        return Err(no_call());
    }
    let call = load(s, room).await?.ok_or_else(no_call)?;
    may_join(&call, room, user).map_err(|why| ApiError::new(StatusCode::FORBIDDEN, why))?;
    if !follows::friends(&s.db, call.caller, call.callee).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, dms::NOT_FRIENDS));
    }
    Ok(())
}

async fn avatar_of(s: &AppState, user: Uuid) -> Result<Option<i64>, sqlx::Error> {
    let row: Option<Option<i64>> = sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM avatar_at))::bigint FROM streamers WHERE id = $1")
        .bind(user)
        .fetch_optional(&s.db)
        .await?;
    Ok(row.flatten())
}

async fn accounts(s: &AppState, caller: Uuid, callee: Uuid) -> Result<Option<(Account, Account)>, sqlx::Error> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM streamers WHERE id = ANY($1)").bind(vec![caller, callee]).fetch_all(&s.db).await?;
    let find = |id: Uuid| rows.iter().find(|(r, _)| *r == id).map(|(id, name)| Account { id: *id, name: name.clone() });
    Ok(find(caller).zip(find(callee)))
}

async fn say(s: &AppState, caller: &str, callee: &str, what: &str, data: Value) {
    presence::publish_call(&mut s.redis.clone(), caller, callee, what, &data).await;
}

fn answer(call: &Call, room: &str, peer: &str) -> Value {
    json!({ "id": call.id, "server": room, "channel": CHANNEL, "state": call.phase.word(), "peer": peer, "ring": RING_SECS })
}

async fn start(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    voice::voice_ready()?;
    let other = dms::peer(&s.db, &me, name).await?;
    if !follows::friends(&s.db, me.id, other.id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, dms::NOT_FRIENDS));
    }
    let room = room_of(me.id, other.id);
    if let Some(call) = load(&s, &room).await? {
        if call.phase == Phase::Ringing && call.callee == me.id {
            return take_up(&s, &room, &call, &me, &other).await;
        }
        return Ok(Json(answer(&call, &room, &other.name)));
    }
    crate::auth::limit(&s, &format!("rl:dmcall:name:{}", me.name), RATE_WINDOW_SECS, CALLS_PER_MINUTE, "slow down").await?;
    let id = new_id();
    let now = now_ms();
    let mut redis = s.redis.clone();
    let made: i64 = redis::cmd("EVAL")
        .arg(RING)
        .arg(1)
        .arg(call_key(&room))
        .arg(&id)
        .arg(me.id.to_string())
        .arg(other.id.to_string())
        .arg(now)
        .arg(RING_SECS + 30)
        .query_async(&mut redis)
        .await?;
    if made == 0 {
        let call = load(&s, &room).await?.ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "try again"))?;
        return Ok(Json(answer(&call, &room, &other.name)));
    }
    let () = redis::pipe()
        .cmd("SADD")
        .arg(CALLS_KEY)
        .arg(&room)
        .ignore()
        .cmd("SET")
        .arg(pair_key(&room))
        .arg(format!("{} {}", me.id, other.id))
        .arg("EX")
        .arg(PAIR_SECS)
        .ignore()
        .query_async(&mut redis)
        .await?;
    let avatar = avatar_of(&s, me.id).await?;
    say(&s, &me.name, &other.name, "ringing", json!({ "id": id, "server": room, "channel": CHANNEL, "avatar": avatar, "ring": RING_SECS })).await;
    log::info!("{}: calling {}", me.name, other.name);
    let timer = (s.clone(), room.clone(), id.clone());
    tokio::spawn(async move {
        let (s, room, id) = timer;
        tokio::time::sleep(Duration::from_secs(RING_SECS.unsigned_abs())).await;
        if let Err(e) = finish(&s, &room, &id, Some(Phase::Ringing), How::Timeout).await {
            log::warn!("dm call {room}: {}", e.message());
        }
    });
    let call = Call { id, caller: me.id, callee: other.id, phase: Phase::Ringing, rung: now, accepted: None, away: None };
    Ok(Json(answer(&call, &room, &other.name)))
}

#[derive(Deserialize, Default)]
struct IdBody {
    #[serde(default)]
    id: Option<String>,
}

fn id_of(body: Result<Option<Json<IdBody>>, JsonRejection>) -> Result<Option<String>, ApiError> {
    Ok(body?.and_then(|Json(b)| b.id).filter(|id| !id.is_empty()))
}

fn same_call(call: &Call, asked: Option<&str>) -> Result<(), ApiError> {
    if asked.is_some_and(|id| id != call.id) {
        return Err(ApiError::new(StatusCode::CONFLICT, "that call is over"));
    }
    Ok(())
}

async fn take_up(s: &AppState, room: &str, call: &Call, me: &Account, other: &Account) -> ApiResult {
    let took: i64 = redis::cmd("EVAL")
        .arg(ACCEPT)
        .arg(1)
        .arg(call_key(room))
        .arg(&call.id)
        .arg(me.id.to_string())
        .arg(now_ms())
        .arg(KEEP_SECS)
        .query_async(&mut s.redis.clone())
        .await?;
    if took == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "that call is over"));
    }
    say(s, &other.name, &me.name, "accepted", json!({ "id": call.id, "server": room, "channel": CHANNEL })).await;
    log::info!("{}: took the call from {}", me.name, other.name);
    let now = Call { id: call.id.clone(), caller: call.caller, callee: call.callee, phase: Phase::Accepted, rung: call.rung, accepted: Some(now_ms()), away: None };
    Ok(Json(answer(&now, room, &other.name)))
}

async fn accept(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Option<Json<IdBody>>, JsonRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let asked = id_of(body)?;
    voice::voice_ready()?;
    let other = dms::peer(&s.db, &me, name).await?;
    if !follows::friends(&s.db, me.id, other.id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, dms::NOT_FRIENDS));
    }
    let room = room_of(me.id, other.id);
    let call = load(&s, &room).await?.ok_or_else(no_call)?;
    same_call(&call, asked.as_deref())?;
    if call.callee != me.id {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your call to answer"));
    }
    if call.phase != Phase::Ringing {
        return Ok(Json(answer(&call, &room, &other.name)));
    }
    take_up(&s, &room, &call, &me, &other).await
}

async fn decline(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Option<Json<IdBody>>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let asked = id_of(body)?;
    let other = dms::peer(&s.db, &me, name).await?;
    let room = room_of(me.id, other.id);
    let Some(call) = load(&s, &room).await? else { return Ok(StatusCode::NO_CONTENT) };
    same_call(&call, asked.as_deref())?;
    if call.callee != me.id || call.phase != Phase::Ringing {
        return Err(ApiError::new(StatusCode::CONFLICT, "nothing to decline"));
    }
    finish(&s, &room, &call.id, Some(Phase::Ringing), How::Declined).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn end(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Option<Json<IdBody>>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let asked = id_of(body)?;
    let other = dms::peer(&s.db, &me, name).await?;
    let room = room_of(me.id, other.id);
    let Some(call) = load(&s, &room).await? else { return Ok(StatusCode::NO_CONTENT) };
    same_call(&call, asked.as_deref())?;
    if !call.has(me.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your call"));
    }
    finish(&s, &room, &call.id, None, How::Hangup).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn fields_of(flat: Vec<String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut it = flat.into_iter();
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        out.insert(k, v);
    }
    out
}

async fn finish(s: &AppState, room: &str, id: &str, need: Option<Phase>, how: How) -> Result<bool, ApiError> {
    let mut redis = s.redis.clone();
    let taken: Option<Vec<String>> = redis::cmd("EVAL")
        .arg(TAKE)
        .arg(1)
        .arg(call_key(room))
        .arg(id)
        .arg(need.map(Phase::word).unwrap_or_default())
        .query_async(&mut redis)
        .await?;
    let Some(call) = taken.map(fields_of).as_ref().and_then(Call::from_fields) else { return Ok(false) };
    let _: i64 = redis::cmd("SREM").arg(CALLS_KEY).arg(room).query_async(&mut redis).await?;
    let outcome = Outcome::of(&call, how, now_ms());
    if let Some((caller, callee)) = accounts(s, call.caller, call.callee).await? {
        let line = outcome.line();
        let kept = json!({ "outcome": outcome.what(), "secs": outcome.secs() });
        dms::call_line(s, &caller, &callee, &line, &kept).await?;
        say(s, &caller.name, &callee.name, outcome.what(), json!({ "id": call.id, "server": room, "channel": CHANNEL, "secs": outcome.secs() })).await;
        log::info!("{}: call with {} {}", caller.name, callee.name, line);
    }
    for user in [call.caller, call.callee] {
        voice::drop_from_voice(s, room, user).await;
    }
    Ok(true)
}

pub(crate) async fn tell(s: &AppState, room: &str, what: &str, mut data: Value) {
    let pair: Result<Option<String>, redis::RedisError> = redis::cmd("GET").arg(pair_key(room)).query_async(&mut s.redis.clone()).await;
    let pair = match pair {
        Ok(Some(pair)) => pair,
        Ok(None) => return,
        Err(e) => {
            log::warn!("dm call {room}: {e}");
            return;
        }
    };
    let mut ids = pair.split(' ').filter_map(|id| Uuid::parse_str(id).ok());
    let (Some(caller), Some(callee)) = (ids.next(), ids.next()) else { return };
    match accounts(s, caller, callee).await {
        Ok(Some((caller, callee))) => {
            data["server"] = json!(room);
            say(s, &caller.name, &callee.name, what, data).await;
        }
        Ok(None) => {}
        Err(e) => log::warn!("dm call {room}: {e}"),
    }
}

pub(crate) fn left_room(s: AppState, room: String, user: Uuid) {
    tokio::spawn(async move {
        tokio::time::sleep(LEFT_GRACE).await;
        if let Err(e) = hang_up_if_gone(&s, &room, user).await {
            log::warn!("dm call {room}: {}", e.message());
        }
    });
}

async fn seated(s: &AppState, room: &str, user: Uuid) -> Result<bool, ApiError> {
    let now: Option<String> = redis::cmd("GET").arg(voice::voiceof_key(user)).query_async(&mut s.redis.clone()).await?;
    Ok(now.as_deref() == Some(format!("{room}/{CHANNEL}").as_str()))
}

async fn hang_up_if_gone(s: &AppState, room: &str, user: Uuid) -> Result<(), ApiError> {
    let Some(call) = load(s, room).await? else { return Ok(()) };
    if !call.has(user) || seated(s, room, user).await? {
        return Ok(());
    }
    if call.phase == Phase::Ringing && user == call.callee {
        return Ok(());
    }
    finish(s, room, &call.id, None, How::Hangup).await?;
    Ok(())
}

pub(crate) async fn sweep_once(s: &AppState) -> Result<usize, ApiError> {
    let mut redis = s.redis.clone();
    let rooms: Vec<String> = redis::cmd("SMEMBERS").arg(CALLS_KEY).query_async(&mut redis).await?;
    let now = now_ms();
    let mut done = 0;
    for room in rooms {
        let Some(call) = load(s, &room).await? else {
            let _: i64 = redis::cmd("SREM").arg(CALLS_KEY).arg(&room).query_async(&mut redis).await?;
            continue;
        };
        let both_in = seated(s, &room, call.caller).await? && seated(s, &room, call.callee).await?;
        if both_in && call.phase == Phase::Accepted {
            let _: i64 = redis::cmd("EXPIRE").arg(call_key(&room)).arg(KEEP_SECS).query_async(&mut redis).await?;
        }
        match due(&call, now, both_in) {
            Due::Nothing => {}
            Due::Back => {
                let _: i64 = redis::cmd("HDEL").arg(call_key(&room)).arg("away").query_async(&mut redis).await?;
            }
            Due::Away => {
                let _: i64 = redis::cmd("HSETNX").arg(call_key(&room)).arg("away").arg(now).query_async(&mut redis).await?;
            }
            Due::Missed => {
                if finish(s, &room, &call.id, Some(Phase::Ringing), How::Timeout).await? {
                    done += 1;
                }
            }
            Due::Over => {
                if finish(s, &room, &call.id, Some(Phase::Accepted), How::Hangup).await? {
                    done += 1;
                }
            }
        }
    }
    Ok(done)
}

#[derive(Debug, PartialEq)]
enum Due {
    Nothing,
    Back,
    Away,
    Missed,
    Over,
}

fn due(call: &Call, now: i64, both_in: bool) -> Due {
    match call.phase {
        Phase::Ringing if now - call.rung > RING_SECS * 1000 => Due::Missed,
        Phase::Ringing => Due::Nothing,
        Phase::Accepted if both_in => {
            if call.away.is_some() {
                Due::Back
            } else {
                Due::Nothing
            }
        }
        Phase::Accepted if call.accepted.is_some_and(|at| now - at <= AWAY_MS) => Due::Nothing,
        Phase::Accepted => match call.away {
            Some(at) if now - at > AWAY_MS => Due::Over,
            Some(_) => Due::Nothing,
            None => Due::Away,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(phase: Phase) -> Call {
        Call { id: "c1".into(), caller: Uuid::from_u128(1), callee: Uuid::from_u128(2), phase, rung: 1_000, accepted: None, away: None }
    }

    #[test]
    fn a_pair_has_one_room_either_way_round() {
        let (a, b, c) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        assert_eq!(room_of(a, b), room_of(b, a));
        assert_ne!(room_of(a, b), room_of(a, c));
        let room = room_of(a, b);
        assert!(room.starts_with(PREFIX));
        assert!(crate::valid_name(&room), "the voice server takes it: {room}");
        assert!(crate::valid_name(CHANNEL));
        assert!(is_room(&room));
        assert_eq!(room_named(&format!(" {} ", room.to_uppercase())), Some(room));
    }

    #[test]
    fn no_group_can_be_named_like_a_call() {
        assert!(!is_room("lounge"));
        assert!(!is_room("dm--abc"));
        assert!(!is_room("dm--0123456789abcdef01234567-0042"));
        assert!(!is_room(&format!("dm--{}", "g".repeat(HASH_CHARS))));
        assert!(!is_room(&format!("dm-x{}", "a".repeat(HASH_CHARS))));
        for tag in [0, 42, 9999] {
            let slug = format!("{}-{tag:04}", &format!("dm--{}", "a".repeat(40))[..27]);
            assert_eq!(slug.len(), 32);
            assert!(!is_room(&slug), "a tagged group slug ends in -NNNN: {slug}");
        }
    }

    #[test]
    fn only_the_two_get_in_and_the_callee_after_answering() {
        let room = room_of(Uuid::from_u128(1), Uuid::from_u128(2));
        let ringing = call(Phase::Ringing);
        assert_eq!(may_join(&ringing, &room, Uuid::from_u128(1)), Ok(()));
        assert_eq!(may_join(&ringing, &room, Uuid::from_u128(2)), Err("answer the call first"));
        assert_eq!(may_join(&ringing, &room, Uuid::from_u128(3)), Err("not your call"));
        let accepted = call(Phase::Accepted);
        assert_eq!(may_join(&accepted, &room, Uuid::from_u128(1)), Ok(()));
        assert_eq!(may_join(&accepted, &room, Uuid::from_u128(2)), Ok(()));
        assert_eq!(may_join(&accepted, &room, Uuid::from_u128(3)), Err("not your call"));
        let other = room_of(Uuid::from_u128(1), Uuid::from_u128(3));
        assert_eq!(may_join(&accepted, &other, Uuid::from_u128(1)), Err("no such call"));
    }

    #[test]
    fn a_call_reads_back_from_its_hash() {
        let mut f = HashMap::new();
        for (k, v) in [("id", "c1"), ("caller", "00000000-0000-0000-0000-000000000001"), ("callee", "00000000-0000-0000-0000-000000000002"), ("state", "ringing"), ("rung", "1000")] {
            f.insert(k.to_owned(), v.to_owned());
        }
        assert_eq!(Call::from_fields(&f), Some(call(Phase::Ringing)));
        f.insert("state".into(), "accepted".into());
        f.insert("accepted".into(), "5000".into());
        let back = Call::from_fields(&f).unwrap();
        assert_eq!((back.phase, back.accepted), (Phase::Accepted, Some(5000)));
        f.insert("state".into(), "odd".into());
        assert_eq!(Call::from_fields(&f), None);
        assert_eq!(Call::from_fields(&HashMap::new()), None);
        assert_eq!(fields_of(vec!["a".into(), "1".into(), "b".into()]), HashMap::from([("a".to_owned(), "1".to_owned())]));
    }

    #[test]
    fn what_the_thread_says_when_it_is_over() {
        let ringing = call(Phase::Ringing);
        assert_eq!(Outcome::of(&ringing, How::Timeout, 9_000), Outcome::Missed);
        assert_eq!(Outcome::of(&ringing, How::Hangup, 9_000), Outcome::Missed);
        assert_eq!(Outcome::of(&ringing, How::Declined, 9_000), Outcome::Declined);
        let talked = Call { accepted: Some(10_000), ..call(Phase::Accepted) };
        assert_eq!(Outcome::of(&talked, How::Hangup, 93_500), Outcome::Ended(83));
        assert_eq!(Outcome::Ended(83).line(), "call ended (1:23)");
        assert_eq!(Outcome::Missed.line(), "missed call");
        assert_eq!(Outcome::Declined.line(), "missed call");
        assert_eq!(Outcome::Declined.what(), "declined");
        assert_eq!(Outcome::Missed.secs(), None);
    }

    #[test]
    fn a_clock() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(9), "0:09");
        assert_eq!(clock(83), "1:23");
        assert_eq!(clock(3599), "59:59");
        assert_eq!(clock(3661), "1:01:01");
        assert_eq!(clock(-4), "0:00");
    }

    #[test]
    fn the_sweep_rings_out_and_hangs_up_on_the_gone() {
        let ringing = call(Phase::Ringing);
        assert_eq!(due(&ringing, 1_000 + RING_SECS * 1000, false), Due::Nothing);
        assert_eq!(due(&ringing, 1_001 + RING_SECS * 1000, false), Due::Missed);
        let talking = Call { accepted: Some(10_000), ..call(Phase::Accepted) };
        assert_eq!(due(&talking, 20_000, false), Due::Nothing, "a moment to get in");
        assert_eq!(due(&talking, 90_000, true), Due::Nothing);
        assert_eq!(due(&talking, 90_000, false), Due::Away);
        let away = Call { away: Some(90_000), ..talking };
        assert_eq!(due(&away, 100_000, false), Due::Nothing);
        assert_eq!(due(&away, 90_001 + AWAY_MS, false), Due::Over);
        assert_eq!(due(&away, 100_000, true), Due::Back);
    }
}
