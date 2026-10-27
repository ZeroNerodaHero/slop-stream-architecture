//! Presence: the word next to a name (`offline`, `online`, `dnd`, `streaming`), the choice
//! behind it (`streamers.status`: `online`, `dnd`, `invisible`), and the redis stream every
//! fact about a name goes through (`events`). See docs/status.md.
//!
//! The word is derived, never stored: live (video's answer, else the `live:` key) wins; else
//! a socket for the name is open on the gateway (`seen:<name>`, a sorted set of socket ids
//! scored by the time they were last refreshed) and the choice says which word; else offline.
//! The gateway (events.rs) derives it the same way when it pushes; this file is the one place
//! the rule lives, so the two cannot drift.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::put;
use axum::{Json, Router};
use redis::aio::ConnectionManager;
use redis::streams::StreamMaxlen;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::auth::Me;
use crate::{is_live, may_write, ApiError, ApiResult, AppState, Name, PasswordQuery};

/// The stream every fact goes through: `live`, `ended`, `status` from the api, `seen` from the
/// gateway. One structure that is both the history and the live tail, with ids, so a gateway
/// that restarts resumes from where it was (docs/chat.md makes the same argument for the rooms).
pub(crate) const EVENTS_KEY: &str = "events";
/// Entries kept. Mirrors the pages' ring; `redis-cli XRANGE events - +` is the server-side inspector.
pub(crate) const EVENTS_KEEP: usize = 1000;
/// A socket's member in `seen:<name>` counts while its score is this fresh. The gateway refreshes
/// every 30s, so a member nobody refreshes (a gateway that died without its drain) lapses on its own.
pub(crate) const SEEN_WINDOW_MS: i64 = 90_000;
/// The set itself goes when nothing writes it for this long.
pub(crate) const SEEN_TTL_SECS: i64 = 90;

/// The word next to a name. Read, never chosen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Presence {
    Offline,
    Online,
    Dnd,
    Streaming,
}

impl Presence {
    /// The json value.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Presence::Offline => "offline",
            Presence::Online => "online",
            Presence::Dnd => "dnd",
            Presence::Streaming => "streaming",
        }
    }

    /// The words on the pages and in the watch document.
    pub(crate) fn shown(self) -> &'static str {
        match self {
            Presence::Dnd => "do not disturb",
            other => other.as_str(),
        }
    }
}

/// The one you pick. A column and a json field; it reaches nobody else: watchers only ever get the derived word.
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

/// Unix milliseconds: the scores in `seen:<name>` and the `since` of a `live` entry.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The rule, in one place: live wins; a socket open and the choice decides; nothing, offline.
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

/// Is a socket for the name open on some gateway: a member of `seen:<name>` scored within the
/// window. `ZCOUNT` with the floor, not `ZCARD`: a stale member is not here even before the
/// gateway's next lazy trim removes it.
pub(crate) async fn here<C: AsyncCommands>(r: &mut C, name: &str) -> Result<bool, redis::RedisError> {
    let fresh: i64 = r.zcount(seen_key(name), now_ms() - SEEN_WINDOW_MS, "+inf").await?;
    Ok(fresh > 0)
}

/// The choice. `online` for a name with no row, and for a row older than the column (its default).
pub(crate) async fn status_of(db: &PgPool, name: &str) -> Result<Status, sqlx::Error> {
    let raw: Option<String> = sqlx::query_scalar("SELECT status FROM streamers WHERE name = $1")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(raw.as_deref().and_then(Status::parse).unwrap_or_default())
}

/// The word, `live` already known by the caller (video's answer, else the key: `is_live`).
pub(crate) async fn presence_with(r: &mut ConnectionManager, db: &PgPool, name: &str, live: bool) -> Result<Presence, ApiError> {
    if live {
        return Ok(Presence::Streaming);
    }
    if !here(r, name).await? {
        return Ok(Presence::Offline);
    }
    Ok(derive(false, true, status_of(db, name).await?))
}

/// The word, asking video first like `watch` does.
pub(crate) async fn presence(s: &AppState, name: &str) -> Result<Presence, ApiError> {
    let live = is_live(s, name).await?;
    presence_with(&mut s.redis.clone(), &s.db, name, live).await
}

/// One fact onto the stream. It never fails the request it rides on: a stream that cannot be
/// written is logged, and the gateway's 30s recheck heals what a watcher missed.
pub(crate) async fn publish<C: AsyncCommands>(r: &mut C, fields: &[(&str, String)]) {
    let added: Result<String, redis::RedisError> = r.xadd_maxlen(EVENTS_KEY, StreamMaxlen::Approx(EVENTS_KEEP), "*", fields).await;
    if let Err(e) = added {
        log::warn!("events: xadd: {e}");
    }
}

/// A stream started: video has the publisher (`attached`), or a heartbeat took a lapsed key
/// back. `card` is what a home card draws without asking anything (`verified`, `avatar`, `bio`,
/// `thumbs`), carried in the fact so a thousand home pages do not each ask the api when
/// someone goes live. The gateway forwards it as it is; the home service reads the ✓ off it.
pub(crate) async fn publish_live<C: AsyncCommands>(r: &mut C, name: &str, since_ms: i64, session: i64, card: &serde_json::Value) {
    publish(
        r,
        &[("type", "live".into()), ("name", name.into()), ("since", since_ms.to_string()), ("session", session.to_string()), ("card", card.to_string())],
    )
    .await;
}

/// How many different addresses are receiving a stream, as video counts them (docs/viewers.md),
/// whenever it moves: video says so at most once a second per stream. To the name's watchers
/// and to every home page, through the gateway, and into the home service's table.
pub(crate) async fn publish_viewers<C: AsyncCommands>(r: &mut C, name: &str, session: i64, viewers: usize) {
    publish(r, &[("type", "viewers".into()), ("name", name.into()), ("session", session.to_string()), ("viewers", viewers.to_string())]).await;
}

/// A stream ended. `by`: `stop` (the page, or video on the publisher's behalf), `sweep` (a tab that vanished).
pub(crate) async fn publish_ended<C: AsyncCommands>(r: &mut C, name: &str, session: Option<i64>, by: &str) {
    let mut fields = vec![("type", "ended".to_owned()), ("name", name.to_owned()), ("by", by.to_owned())];
    if let Some(session) = session {
        fields.push(("session", session.to_string()));
    }
    publish(r, &fields).await;
}

/// The choice changed.
pub(crate) async fn publish_status<C: AsyncCommands>(r: &mut C, name: &str, status: Status) {
    publish(r, &[("type", "status".into()), ("name", name.into()), ("status", status.as_str().into())]).await;
}

/// An account changed its name (docs/ids.md). The gateway re-keys its sockets of the old
/// name and tells them, and the old name's watchers, where it went.
pub(crate) async fn publish_renamed<C: AsyncCommands>(r: &mut C, old: &str, new: &str) {
    publish(r, &[("type", "renamed".into()), ("name", old.into()), ("to", new.into())]).await;
}

#[derive(Deserialize)]
struct StatusBody {
    status: String,
}

/// `PUT /api/streamers/:name/presence` with `{ status }`: the choice, through the bio's gate (a
/// free name is anyone's, a claimed name its login's, a reserved name the dummy box's). The api
/// is the one writer of the column; the gateway reads it and tells every socket of the name.
async fn put_presence(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<StatusBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body?;
    let Some(status) = Status::parse(body.status.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad status. one of online, dnd, invisible"));
    };
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
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
