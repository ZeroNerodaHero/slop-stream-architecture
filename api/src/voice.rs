//! Voice channels: the grant a page takes to the voice server, and the voice server's own
//! calls back here (docs/groups.md "voice").
//!
//! Joining is two steps. The page asks `POST /api/groups/:group/voice/:channel/join` with its
//! login; the api checks the person may be there and hands back a grant, 32 random bytes as hex,
//! kept in redis as `voicegrant:<hex>` for `GRANT_TTL` seconds. The page gives the grant to the
//! voice server (`/voice`), which redeems it here once (`POST /api/voice/redeem`, GETDEL) and
//! learns who it is talking to. The voice server never sees the cookie, and a grant is good for
//! one connection and half a minute.
//!
//! Who is in a channel is `voice:<server>`, a hash of user id to `{name, channel, ...}`, and
//! `voiceof:<user>` says `server/channel` for whoever is in one. The voice server writes both
//! through its own calls; join only reads them, for `already in voice` and `channel full`.
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
use crate::groups::{channel_names, may_see, member};
use crate::{ApiError, ApiResult, AppState};

/// How long a grant waits to be redeemed, in seconds.
const GRANT_TTL: u64 = 30;
/// How many fit in a voice channel whose `user_limit` is 0 (no limit set).
const DEFAULT_LIMIT: usize = 16;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/groups/{group}/voice/{channel}/join", post(join))
        .route("/api/voice/redeem", post(redeem))
}

/// What a grant stands for: who, and where they may talk.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Grant {
    user_id: Uuid,
    name: String,
    server: String,
    channel: String,
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

/// The gate on every internal route, with VOICE_SECRET as `secret`: 404 for anything caddy
/// passed, 503 `voice is off` without a secret, 403 `bad secret` for a wrong or missing header.
fn inside(headers: &HeaderMap, secret: Option<&str>) -> Result<(), ApiError> {
    if headers.contains_key("x-forwarded-for") {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such route"));
    }
    let Some(secret) = secret else {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "voice is off"));
    };
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

/// `POST /api/groups/:group/voice/:channel/join`: a grant to take to the voice server,
/// `{url: "/voice", grant, ttl: 30}`. 401 nobody; 403 not a member; 404 `no such channel` (or
/// one this login does not see); 400 `not a voice channel`; 409 `already in voice` while in
/// another channel; 409 `channel full` at its `user_limit` (16 when 0). An owner, the channels
/// power and a site admin are never kept out by the limit.
async fn join(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let (server, channel) = channel_names(&group, &channel)?;
    let limit = may_talk(&s, who.id, &server, &channel).await?;
    let mut redis = s.redis.clone();
    let here = format!("{server}/{channel}");
    let now: Option<String> = redis::cmd("GET").arg(voiceof_key(who.id)).query_async(&mut redis).await?;
    if now.is_some_and(|now| now != here) {
        return Err(ApiError::new(StatusCode::CONFLICT, "already in voice"));
    }
    if !allows(&s, who.id, &server, CHANNELS).await? {
        let fields: HashMap<String, String> = redis::cmd("HGETALL").arg(voice_key(&server)).query_async(&mut redis).await?;
        if others_in(&fields, &channel, who.id) >= room_for(limit) {
            return Err(ApiError::new(StatusCode::CONFLICT, "channel full"));
        }
    }
    let grant = new_grant();
    let kept = json!(Grant { user_id: who.id, name: who.name, server, channel }).to_string();
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

#[derive(Deserialize)]
struct RedeemBody {
    grant: String,
}

/// `POST /api/voice/redeem {grant}`: the voice server's, inside only (`inside`). Takes the grant
/// out of redis (GETDEL, so a second redeem of it is a 403 `bad grant`, as is one past its half
/// minute), asks `may_talk` again, and → `{user_id, name, server, channel}`.
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
    Ok(Json(json!(grant)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

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
    fn a_grant_round_trips() {
        let g = Grant { user_id: Uuid::from_u128(7), name: "a".into(), server: "s".into(), channel: "c".into() };
        let back: Grant = serde_json::from_str(&json!(g).to_string()).unwrap();
        assert_eq!(back, g);
    }
}
