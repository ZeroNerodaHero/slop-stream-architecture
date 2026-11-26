use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::put;
use axum::{Json, Router};
use crate::timings::Redis;
use redis::streams::StreamMaxlen;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::auth::Me;
use crate::test_streamers::DummySecret;
use crate::{is_live, may_write, ApiError, ApiResult, AppState, Name};

pub(crate) const EVENTS_KEY: &str = "events";
pub(crate) const EVENTS_KEEP: usize = 1000;
pub(crate) const SEEN_WINDOW_MS: i64 = 90_000;
pub(crate) const SEEN_TTL_SECS: i64 = 90;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Presence {
    Offline,
    Online,
    Dnd,
    Streaming,
}

impl Presence {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Presence::Offline => "offline",
            Presence::Online => "online",
            Presence::Dnd => "dnd",
            Presence::Streaming => "streaming",
        }
    }

    pub(crate) fn shown(self) -> &'static str {
        match self {
            Presence::Dnd => "do not disturb",
            other => other.as_str(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    #[default]
    Online,
    Dnd,
    Invisible,
}

impl Status {
    pub(crate) fn parse(raw: &str) -> Option<Status> {
        match raw {
            "online" => Some(Status::Online),
            "dnd" => Some(Status::Dnd),
            "invisible" => Some(Status::Invisible),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Status::Online => "online",
            Status::Dnd => "dnd",
            Status::Invisible => "invisible",
        }
    }
}

pub(crate) fn seen_key(name: &str) -> String {
    format!("seen:{name}")
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub(crate) fn derive(live: bool, here: bool, status: Status) -> Presence {
    if live {
        return Presence::Streaming;
    }
    if !here {
        return Presence::Offline;
    }
    match status {
        Status::Online => Presence::Online,
        Status::Dnd => Presence::Dnd,
        Status::Invisible => Presence::Offline,
    }
}

pub(crate) async fn here<C: AsyncCommands>(r: &mut C, name: &str) -> Result<bool, redis::RedisError> {
    let fresh: i64 = r.zcount(seen_key(name), now_ms() - SEEN_WINDOW_MS, "+inf").await?;
    Ok(fresh > 0)
}

pub(crate) async fn status_of(db: &PgPool, name: &str) -> Result<Status, sqlx::Error> {
    let raw: Option<String> = sqlx::query_scalar("SELECT status FROM streamers WHERE name = $1")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(raw.as_deref().and_then(Status::parse).unwrap_or_default())
}

pub(crate) async fn presence_with(r: &mut Redis, db: &PgPool, name: &str, live: bool) -> Result<Presence, ApiError> {
    if live {
        return Ok(Presence::Streaming);
    }
    if !here(r, name).await? {
        return Ok(Presence::Offline);
    }
    Ok(derive(false, true, status_of(db, name).await?))
}

pub(crate) async fn presence(s: &AppState, name: &str) -> Result<Presence, ApiError> {
    let live = is_live(s, name).await?;
    presence_with(&mut s.redis.clone(), &s.db, name, live).await
}

pub(crate) async fn publish<C: AsyncCommands>(r: &mut C, fields: &[(&str, String)]) {
    let added: Result<String, redis::RedisError> = r.xadd_maxlen(EVENTS_KEY, StreamMaxlen::Approx(EVENTS_KEEP), "*", fields).await;
    if let Err(e) = added {
        log::warn!("events: xadd: {e}");
    }
}

pub(crate) async fn publish_live<C: AsyncCommands>(r: &mut C, name: &str, since_ms: i64, session: i64, card: &serde_json::Value) {
    publish(
        r,
        &[("type", "live".into()), ("name", name.into()), ("since", since_ms.to_string()), ("session", session.to_string()), ("card", card.to_string())],
    )
    .await;
}

pub(crate) async fn publish_viewers<C: AsyncCommands>(r: &mut C, name: &str, session: i64, viewers: usize) {
    publish(r, &[("type", "viewers".into()), ("name", name.into()), ("session", session.to_string()), ("viewers", viewers.to_string())]).await;
}

pub(crate) async fn publish_ended<C: AsyncCommands>(r: &mut C, name: &str, session: Option<i64>, by: &str) {
    let mut fields = vec![("type", "ended".to_owned()), ("name", name.to_owned()), ("by", by.to_owned())];
    if let Some(session) = session {
        fields.push(("session", session.to_string()));
    }
    publish(r, &fields).await;
}

pub(crate) async fn publish_status<C: AsyncCommands>(r: &mut C, name: &str, status: Status) {
    publish(r, &[("type", "status".into()), ("name", name.into()), ("status", status.as_str().into())]).await;
}

pub(crate) async fn publish_renamed<C: AsyncCommands>(r: &mut C, old: &str, new: &str) {
    publish(r, &[("type", "renamed".into()), ("name", old.into()), ("to", new.into())]).await;
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn publish_dm<C: AsyncCommands>(r: &mut C, from: &str, to: &str, id: i64, text: &str, images: &[String], (video, audio): (Option<&crate::chat::Video>, Option<&crate::chat::Audio>), at_ms: i64, from_id: &str, reply: Option<&serde_json::Value>, mentions: &[String]) {
    let mut fields = vec![
        ("type", "dm".to_owned()),
        ("name", to.to_owned()),
        ("from", from.to_owned()),
        ("from_id", from_id.to_owned()),
        ("id", id.to_string()),
        ("text", text.to_owned()),
        ("at", at_ms.to_string()),
    ];
    if !images.is_empty() {
        fields.push(("images", images.join(",")));
    }
    if let Some(video) = video {
        fields.push(("video", video.stored()));
    }
    if let Some(audio) = audio {
        fields.push(("audio", audio.stored()));
    }
    if let Some(reply) = reply {
        fields.push(("reply", reply.to_string()));
    }
    if !mentions.is_empty() {
        fields.push(("mentions", mentions.join(",")));
    }
    publish(r, &fields).await;
}

pub(crate) async fn publish_dm_react<C: AsyncCommands>(r: &mut C, from: &str, to: &str, id: i64, emoji: &str, on: bool) {
    publish(
        r,
        &[
            ("type", "dm_react".into()),
            ("name", to.into()),
            ("from", from.into()),
            ("id", id.to_string()),
            ("emoji", emoji.into()),
            ("on", if on { "1" } else { "0" }.into()),
        ],
    )
    .await;
}

pub(crate) async fn publish_dm_read<C: AsyncCommands>(r: &mut C, reader: &str, peer: &str, peer_id: &str, id: i64) {
    publish(r, &[("type", "dm_read".into()), ("name", reader.into()), ("peer", peer.into()), ("peer_id", peer_id.into()), ("id", id.to_string())]).await;
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn publish_notify<C: AsyncCommands>(
    r: &mut C,
    kind: &str,
    actor: &str,
    actor_id: &str,
    verified: bool,
    avatar: Option<i64>,
    to: &serde_json::Value,
    at_ms: i64,
    text: &str,
    session: Option<i64>,
    room: Option<&str>,
) {
    let mut fields = vec![
        ("type", "notify".to_owned()),
        ("name", actor.to_owned()),
        ("actor", actor_id.to_owned()),
        ("kind", kind.to_owned()),
        ("to", to.to_string()),
        ("at", at_ms.to_string()),
        ("text", text.to_owned()),
        ("verified", if verified { "1".to_owned() } else { "0".to_owned() }),
    ];
    if let Some(avatar) = avatar {
        fields.push(("avatar", avatar.to_string()));
    }
    if let Some(session) = session {
        fields.push(("session", session.to_string()));
    }
    if let Some(room) = room {
        fields.push(("room", room.to_owned()));
    }
    publish(r, &fields).await;
}

pub(crate) async fn publish_notify_read<C: AsyncCommands>(r: &mut C, reader: &str, id: i64) {
    publish(r, &[("type", "notify_read".into()), ("name", reader.into()), ("id", id.to_string())]).await;
}

pub(crate) async fn publish_notify_removed<C: AsyncCommands>(r: &mut C, owner: &str, id: i64) {
    publish(r, &[("type", "notify_removed".into()), ("name", owner.into()), ("id", id.to_string())]).await;
}

pub(crate) async fn publish_chat_read<C: AsyncCommands>(r: &mut C, reader: &str, room: &str) {
    publish(r, &[("type", "chat_read".into()), ("name", reader.into()), ("room", room.into())]).await;
}

pub(crate) async fn publish_group<C: AsyncCommands>(r: &mut C, group: &str, what: &str, data: &serde_json::Value) {
    publish(r, &[("type", "group".into()), ("name", group.into()), ("what", what.into()), ("data", data.to_string())]).await;
}

#[derive(Deserialize)]
struct StatusBody {
    status: String,
}

async fn put_presence(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    secret: DummySecret,
    body: Result<Json<StatusBody>, JsonRejection>,
) -> ApiResult {
    let Json(body) = body?;
    let Some(status) = Status::parse(body.status.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad status. one of online, dnd, invisible"));
    };
    may_write(&s, &name, me.name(), secret.0.as_deref()).await?;
    sqlx::query(
        "INSERT INTO streamers (name, status) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status",
    )
    .bind(&name)
    .bind(status.as_str())
    .execute(&s.db)
    .await?;
    let mut r = s.redis.clone();
    publish_status(&mut r, &name, status).await;
    let presence = presence(&s, &name).await?;
    log::info!("{name}: status {}", status.as_str());
    Ok(Json(json!({ "status": status, "presence": presence })))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/streamers/{name}/presence", put(put_presence))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_wins_whatever_the_choice() {
        for status in [Status::Online, Status::Dnd, Status::Invisible] {
            assert_eq!(derive(true, false, status), Presence::Streaming);
            assert_eq!(derive(true, true, status), Presence::Streaming);
        }
    }

    #[test]
    fn nobody_here_is_offline() {
        for status in [Status::Online, Status::Dnd, Status::Invisible] {
            assert_eq!(derive(false, false, status), Presence::Offline);
        }
    }

    #[test]
    fn here_the_choice_decides() {
        assert_eq!(derive(false, true, Status::Online), Presence::Online);
        assert_eq!(derive(false, true, Status::Dnd), Presence::Dnd);
        assert_eq!(derive(false, true, Status::Invisible), Presence::Offline);
    }

    #[test]
    fn words() {
        assert_eq!(Presence::Dnd.shown(), "do not disturb");
        assert_eq!(Presence::Dnd.as_str(), "dnd");
        assert_eq!(Status::parse("dnd"), Some(Status::Dnd));
        assert_eq!(Status::parse("busy"), None);
        assert_eq!(serde_json::to_string(&Presence::Streaming).unwrap(), "\"streaming\"");
    }
}
