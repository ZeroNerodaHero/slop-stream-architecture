//! Notifications: a login's inbox of the last 30 things that happened to them. See
//! docs/notifications.md.
//!
//! Three kinds. `live`: someone they follow went live (one row per session: video retries
//! `attached`, and a heartbeat that takes a lapsed key back is the same stream). `follow`:
//! someone followed them (one row per follower among the rows kept: a follow, unfollow,
//! follow loop is one line). `dm`: a friend wrote (the newest line from them is the one
//! unread row; reading the thread reads it). Which kinds are kept is the login's own,
//! `streamers.notify`, a json document of the kinds turned off; a kind not in it is on.
//!
//! One table of rows, `notifications (user_id, kind, actor_id, ...)`, both ids (docs/ids.md),
//! so a rename keeps the inbox and the actor shows under the name they have now. The api is
//! the one writer: a row, then a `notify` fact on the `events` stream naming every login it
//! reached and their row ids, and the gateway (events.rs) pushes the same row to each one's
//! own sockets, the way a direct message reaches every device of its reader. Reading is
//! http. Every write clips the login's rows to the last KEEP: an inbox is a short memory,
//! not a log.

use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{Account, Me};
use crate::presence;
use crate::{ApiError, ApiResult, AppState};

/// Rows kept per login. Older ones go with every write.
pub(crate) const KEEP: i64 = 30;
/// A direct message's words in its row: one line of the list, not the whole message.
const TEXT_CHARS: usize = 140;

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

// ---- the kinds and the settings -----------------------------------------------------------------

/// What can happen to a login: the `kind` column, the settings' keys, the frame's `kind`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Live,
    Follow,
    Dm,
}

impl Kind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Live => "live",
            Kind::Follow => "follow",
            Kind::Dm => "dm",
        }
    }
}

/// Which kinds a login keeps, as the row's `notify` document reads: every kind on unless the
/// document says `false` for it. The settings tab's three switches, and the json of the api.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub(crate) struct Settings {
    pub(crate) live: bool,
    pub(crate) follow: bool,
    pub(crate) dm: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { live: true, follow: true, dm: true }
    }
}

impl Settings {
    /// From the row's document. A key that is not `false` (missing, or anything else) is on.
    pub(crate) fn from_doc(doc: &Value) -> Settings {
        let on = |key: &str| doc.get(key).and_then(Value::as_bool).unwrap_or(true);
        Settings { live: on("live"), follow: on("follow"), dm: on("dm") }
    }

    /// The document the row keeps: only what is off, so a row never written reads as all on.
    pub(crate) fn to_doc(self) -> Value {
        let mut doc = serde_json::Map::new();
        for (kind, on) in [(Kind::Live, self.live), (Kind::Follow, self.follow), (Kind::Dm, self.dm)] {
            if !on {
                doc.insert(kind.as_str().to_owned(), Value::Bool(false));
            }
        }
        Value::Object(doc)
    }
}

// ---- the actor -----------------------------------------------------------------------------------

/// Who did it, as the row is drawn: the name now, the ✓, the picture.
struct Actor {
    id: Uuid,
    name: String,
    verified: bool,
    avatar: Option<i64>,
}

type ActorRow = (Uuid, String, bool, Option<i64>);

const ACTOR_COLUMNS: &str = "id, name, password_hash IS NOT NULL, (EXTRACT(EPOCH FROM avatar_at))::bigint";

fn actor(row: Option<ActorRow>) -> Option<Actor> {
    row.map(|(id, name, verified, avatar)| Actor { id, name, verified, avatar })
}

async fn actor_by_name(db: &PgPool, name: &str) -> Result<Option<Actor>, sqlx::Error> {
    let row: Option<ActorRow> = sqlx::query_as(&format!("SELECT {ACTOR_COLUMNS} FROM streamers WHERE name = $1")).bind(name).fetch_optional(db).await?;
    Ok(actor(row))
}

async fn actor_by_id(db: &PgPool, id: Uuid) -> Result<Option<Actor>, sqlx::Error> {
    let row: Option<ActorRow> = sqlx::query_as(&format!("SELECT {ACTOR_COLUMNS} FROM streamers WHERE id = $1")).bind(id).fetch_optional(db).await?;
    Ok(actor(row))
}

// ---- the writers ---------------------------------------------------------------------------------

/// What one write made: a row per login reached, and when. The fact carries all of it.
struct Made {
    /// Login name → the row's id. The gateway pushes to each name's own sockets.
    to: HashMap<String, i64>,
    at_ms: i64,
    text: String,
    session: Option<i64>,
}

/// Every login's rows past the newest KEEP go. One statement for any number of logins.
async fn clip(db: &PgPool, users: &[Uuid]) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM notifications WHERE id IN (
            SELECT id FROM (
                SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY id DESC) AS n
                FROM notifications WHERE user_id = ANY($1)
            ) ranked WHERE n > $2
         )",
    )
    .bind(users)
    .bind(KEEP)
    .execute(db)
    .await?;
    Ok(())
}

/// The fact, once per write: the gateway pushes a frame per login named in `to`.
async fn tell(s: &AppState, kind: Kind, actor: &Actor, made: &Made) {
    if made.to.is_empty() {
        return;
    }
    let to = Value::Object(made.to.iter().map(|(name, id)| (name.clone(), json!(id))).collect());
    presence::publish_notify(&mut s.redis.clone(), kind.as_str(), &actor.name, actor.verified, actor.avatar, &to, made.at_ms, &made.text, made.session).await;
}

/// id, login name, user id, at (ms)
type LiveRow = (i64, String, Uuid, i64);

/// Someone went live (`attached`, main.rs): a row for every login that follows the name and
/// keeps `live`, unless this session already made theirs. Then the one fact for all of them.
/// Never fails the call it rides on: a miss is logged, the stream is live all the same.
pub(crate) async fn stream_started(s: &AppState, name: &str, session: i64) {
    if let Err(e) = live_rows(s, name, session).await {
        log::warn!("notify: {name} live: {}", e.message());
    }
}

async fn live_rows(s: &AppState, name: &str, session: i64) -> Result<(), ApiError> {
    // a name nobody saved anything for has no row, and so no followers
    let Some(actor) = actor_by_name(&s.db, name).await? else { return Ok(()) };
    let rows: Vec<LiveRow> = sqlx::query_as(
        "WITH made AS (
            INSERT INTO notifications (user_id, kind, actor_id, session)
            SELECT f.follower_id, 'live', $1, $2
            FROM follows f JOIN streamers u ON u.id = f.follower_id
            WHERE f.followed_id = $1 AND u.password_hash IS NOT NULL
              AND COALESCE((u.notify->>'live')::boolean, true)
              AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = f.follower_id AND n.kind = 'live' AND n.session = $2)
            RETURNING id, user_id, at
         )
         SELECT m.id, u.name, m.user_id, (EXTRACT(EPOCH FROM m.at) * 1000)::bigint
         FROM made m JOIN streamers u ON u.id = m.user_id",
    )
    .bind(actor.id)
    .bind(session)
    .fetch_all(&s.db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let users: Vec<Uuid> = rows.iter().map(|r| r.2).collect();
    clip(&s.db, &users).await?;
    let made = Made {
        to: rows.iter().map(|(id, login, _, _)| (login.clone(), *id)).collect(),
        at_ms: rows.first().map_or_else(presence::now_ms, |r| r.3),
        text: String::new(),
        session: Some(session),
    };
    log::info!("notify: {name} live, {} told", rows.len());
    tell(s, Kind::Live, &actor, &made).await;
    Ok(())
}

/// `follower` followed the login `followed` (follows.rs, once the edge is new): one row, if they
/// are a login who keeps `follow` and have none from this follower among the rows kept.
pub(crate) async fn followed(s: &AppState, followed: Uuid, followed_name: &str, follower: &Account) {
    if let Err(e) = follow_row(s, followed, followed_name, follower).await {
        log::warn!("notify: {} followed {followed_name}: {}", follower.name, e.message());
    }
}

async fn follow_row(s: &AppState, followed: Uuid, followed_name: &str, follower: &Account) -> Result<(), ApiError> {
    let Some(actor) = actor_by_id(&s.db, follower.id).await? else { return Ok(()) };
    let row: Option<(i64, i64)> = sqlx::query_as(
        "INSERT INTO notifications (user_id, kind, actor_id)
         SELECT u.id, 'follow', $2 FROM streamers u
         WHERE u.id = $1 AND u.password_hash IS NOT NULL
           AND COALESCE((u.notify->>'follow')::boolean, true)
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = $1 AND n.kind = 'follow' AND n.actor_id = $2)
         RETURNING id, (EXTRACT(EPOCH FROM at) * 1000)::bigint",
    )
    .bind(followed)
    .bind(actor.id)
    .fetch_optional(&s.db)
    .await?;
    let Some((id, at_ms)) = row else { return Ok(()) };
    clip(&s.db, &[followed]).await?;
    let made = Made { to: HashMap::from([(followed_name.to_owned(), id)]), at_ms, text: String::new(), session: None };
    tell(s, Kind::Follow, &actor, &made).await;
    Ok(())
}

/// `from` wrote `text` to `to` (dms.rs, once the line is kept): the newest line from a friend
/// is the one unread row from them, so a conversation is one line of the list that says what
/// they said last, not thirty. An unread row from them goes as the new one comes, including
/// when two messages land at once; a read one stays, it is history.
pub(crate) async fn messaged(s: &AppState, to: &Account, from: &Account, text: &str) {
    if let Err(e) = dm_row(s, to, from, text).await {
        log::warn!("notify: {} wrote to {}: {}", from.name, to.name, e.message());
    }
}

async fn dm_row(s: &AppState, to: &Account, from: &Account, text: &str) -> Result<(), ApiError> {
    let Some(actor) = actor_by_id(&s.db, from.id).await? else { return Ok(()) };
    let words: String = text.chars().take(TEXT_CHARS).collect();
    // Lock the recipient before replacing the unread row. Two messages at once queue on this
    // statement, and the one that waited reads the row the first one committed. The delete and
    // the insert lock that row too; their statement keeps the snapshot it started with, which
    // is from before that wait, so this statement is what lets the second delete land.
    let mut tx = s.db.begin().await?;
    let _held: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE id = $1 FOR UPDATE").bind(to.id).fetch_optional(&mut *tx).await?;
    let row: Option<(i64, i64)> = sqlx::query_as(
        "WITH locked AS (
            SELECT id FROM streamers WHERE id = $1 FOR UPDATE
         ),
         gone AS (
            DELETE FROM notifications WHERE user_id = $1 AND kind = 'dm' AND actor_id = $2 AND read_at IS NULL
              AND EXISTS (SELECT 1 FROM locked)
              AND EXISTS (
                SELECT 1 FROM streamers u
                WHERE u.id = $1 AND COALESCE((u.notify->>'dm')::boolean, true)
              )
         )
         INSERT INTO notifications (user_id, kind, actor_id, text)
         SELECT u.id, 'dm', $2, $3 FROM streamers u
         WHERE u.id = $1 AND COALESCE((u.notify->>'dm')::boolean, true)
           AND EXISTS (SELECT 1 FROM locked)
         RETURNING id, (EXTRACT(EPOCH FROM at) * 1000)::bigint",
    )
    .bind(to.id)
    .bind(actor.id)
    .bind(&words)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let Some((id, at_ms)) = row else { return Ok(()) };
    clip(&s.db, &[to.id]).await?;
    let made = Made { to: HashMap::from([(to.name.clone(), id)]), at_ms, text: words, session: None };
    tell(s, Kind::Dm, &actor, &made).await;
    Ok(())
}

/// `reader` read their thread with `peer` (dms.rs `mark_read`): what `peer` wrote is not news
/// any more. The `dm_read` fact that follows the mark tells the reader's other devices.
pub(crate) async fn dm_read(db: &PgPool, reader: Uuid, peer: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND kind = 'dm' AND actor_id = $2 AND read_at IS NULL")
        .bind(reader)
        .bind(peer)
        .execute(db)
        .await?;
    Ok(())
}

// ---- the routes ------------------------------------------------------------------------------------

/// id, kind, actor name, actor verified, actor avatar, at (ms), read, text, session
type ItemRow = (i64, String, String, bool, Option<i64>, i64, bool, String, Option<i64>);

/// `GET /api/notifications`: `{ settings, items }`. The login's rows, newest first, the last
/// KEEP, each with who did it as they are now and whether it has been read; and which kinds
/// are kept. 401 for nobody.
async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let doc: Option<Value> = sqlx::query_scalar("SELECT notify FROM streamers WHERE id = $1").bind(me.id).fetch_optional(&s.db).await?;
    let settings = doc.as_ref().map(Settings::from_doc).unwrap_or_default();
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT n.id, n.kind, a.name, a.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM a.avatar_at))::bigint,
                (EXTRACT(EPOCH FROM n.at) * 1000)::bigint, n.read_at IS NOT NULL, n.text, n.session
         FROM notifications n JOIN streamers a ON a.id = n.actor_id
         WHERE n.user_id = $1
         ORDER BY n.id DESC
         LIMIT $2",
    )
    .bind(me.id)
    .bind(KEEP)
    .fetch_all(&s.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, kind, name, verified, avatar, at, read, text, session)| {
            json!({ "id": id, "kind": kind, "name": name, "verified": verified, "avatar": avatar, "at": at, "read": read, "text": text, "session": session })
        })
        .collect();
    Ok(Json(json!({ "settings": settings, "items": items })))
}

#[derive(Deserialize)]
struct IdBody {
    id: i64,
}

/// `PUT /api/notifications/read` with `{ id }`: the login has seen everything up to that row,
/// on this device. 204. A `notify_read` fact tells the login's other devices, when anything
/// was still unread.
async fn read(State(s): State<AppState>, Me(me): Me, body: Result<Json<IdBody>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let done = sqlx::query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id <= $2 AND read_at IS NULL")
        .bind(me.id)
        .bind(body.id)
        .execute(&s.db)
        .await?;
    if done.rows_affected() > 0 {
        presence::publish_notify_read(&mut s.redis.clone(), &me.name, body.id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The body of a settings save: a kind left out stays on.
#[derive(Deserialize)]
struct SettingsBody {
    #[serde(default = "on")]
    live: bool,
    #[serde(default = "on")]
    follow: bool,
    #[serde(default = "on")]
    dm: bool,
}

fn on() -> bool {
    true
}

/// `PUT /api/notifications/settings` with `{ live, follow, dm }`: which kinds the login keeps
/// from now on, replaced whole. 200 with the settings as kept. What is already in the inbox
/// stays. 401 for nobody.
async fn settings(State(s): State<AppState>, Me(me): Me, body: Result<Json<SettingsBody>, JsonRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let wanted = Settings { live: body.live, follow: body.follow, dm: body.dm };
    sqlx::query("UPDATE streamers SET notify = $2 WHERE id = $1").bind(me.id).bind(wanted.to_doc()).execute(&s.db).await?;
    log::info!("{}: notifications {}", me.name, wanted.to_doc());
    Ok(Json(json!(wanted)))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(list))
        .route("/api/notifications/read", put(read))
        .route("/api/notifications/settings", put(settings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_never_written_keeps_everything() {
        assert_eq!(Settings::from_doc(&json!({})), Settings::default());
        assert_eq!(Settings::default().to_doc(), json!({}));
    }

    #[test]
    fn only_what_is_off_is_written() {
        let s = Settings { live: true, follow: false, dm: false };
        assert_eq!(s.to_doc(), json!({ "follow": false, "dm": false }));
        assert_eq!(Settings::from_doc(&s.to_doc()), s);
        // anything that is not `false` is on: a stray value cannot turn a kind off by accident
        assert_eq!(Settings::from_doc(&json!({ "live": "no", "dm": 0 })), Settings::default());
    }

    #[test]
    fn the_json_names_every_kind() {
        assert_eq!(serde_json::to_value(Settings::default()).unwrap(), json!({ "live": true, "follow": true, "dm": true }));
    }
}
