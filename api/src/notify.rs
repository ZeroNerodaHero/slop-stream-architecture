use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use crate::timings::Redis;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{Account, Me};
use crate::presence;
use crate::test_streamers::shown_sql;
use crate::{ApiError, ApiResult, AppState};

pub(crate) const KEEP: i64 = 30;
const TEXT_CHARS: usize = 140;

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Live,
    Follow,
    Dm,
    Chat,
}

impl Kind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Live => "live",
            Kind::Follow => "follow",
            Kind::Dm => "dm",
            Kind::Chat => "chat",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub(crate) struct Settings {
    pub(crate) live: bool,
    pub(crate) follow: bool,
    pub(crate) dm: bool,
    pub(crate) chat: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { live: true, follow: true, dm: true, chat: true }
    }
}

impl Settings {
    pub(crate) fn from_doc(doc: &Value) -> Settings {
        let on = |key: &str| doc.get(key).and_then(Value::as_bool).unwrap_or(true);
        Settings { live: on("live"), follow: on("follow"), dm: on("dm"), chat: on("chat") }
    }

    pub(crate) fn to_doc(self) -> Value {
        let mut doc = serde_json::Map::new();
        for (kind, on) in [(Kind::Live, self.live), (Kind::Follow, self.follow), (Kind::Dm, self.dm), (Kind::Chat, self.chat)] {
            if !on {
                doc.insert(kind.as_str().to_owned(), Value::Bool(false));
            }
        }
        Value::Object(doc)
    }
}

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

struct Made {
    to: HashMap<String, i64>,
    at_ms: i64,
    text: String,
    session: Option<i64>,
    room: Option<String>,
}

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

async fn tell(redis: &Redis, kind: Kind, actor: &Actor, made: &Made) {
    if made.to.is_empty() {
        return;
    }
    let to = Value::Object(made.to.iter().map(|(name, id)| (name.clone(), json!(id))).collect());
    presence::publish_notify(
        &mut redis.clone(),
        kind.as_str(),
        &actor.name,
        &actor.id.to_string(),
        actor.verified,
        actor.avatar,
        &to,
        made.at_ms,
        &made.text,
        made.session,
        made.room.as_deref(),
    )
    .await;
}

type LiveRow = (i64, String, Uuid, i64);

pub(crate) async fn stream_started(s: &AppState, name: &str, session: i64) {
    if let Err(e) = live_rows(s, name, session).await {
        log::warn!("notify: {name} live: {}", e.message());
    }
}

async fn live_rows(s: &AppState, name: &str, session: i64) -> Result<(), ApiError> {
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
        room: None,
    };
    log::info!("notify: {name} live, {} told", rows.len());
    tell(&s.redis, Kind::Live, &actor, &made).await;
    Ok(())
}

pub(crate) async fn followed(s: &AppState, followed: Uuid, followed_name: &str, follower: &Account) {
    if let Err(e) = follow_row(s, followed, followed_name, follower).await {
        log::warn!("notify: {} followed {followed_name}: {}", follower.name, e.message());
    }
}

async fn follow_row(s: &AppState, followed: Uuid, followed_name: &str, follower: &Account) -> Result<(), ApiError> {
    if followed == follower.id {
        return Ok(());
    }
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
    let made = Made { to: HashMap::from([(followed_name.to_owned(), id)]), at_ms, text: String::new(), session: None, room: None };
    tell(&s.redis, Kind::Follow, &actor, &made).await;
    Ok(())
}

pub(crate) async fn messaged(s: &AppState, to: &Account, from: &Account, text: &str) {
    if let Err(e) = dm_row(s, to, from, text).await {
        log::warn!("notify: {} wrote to {}: {}", from.name, to.name, e.message());
    }
}

async fn dm_row(s: &AppState, to: &Account, from: &Account, text: &str) -> Result<(), ApiError> {
    let Some(actor) = actor_by_id(&s.db, from.id).await? else { return Ok(()) };
    let words: String = text.chars().take(TEXT_CHARS).collect();
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
    let made = Made { to: HashMap::from([(to.name.clone(), id)]), at_ms, text: words, session: None, room: None };
    tell(&s.redis, Kind::Dm, &actor, &made).await;
    Ok(())
}

pub(crate) async fn dm_read(db: &PgPool, reader: Uuid, peer: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND kind = 'dm' AND actor_id = $2 AND read_at IS NULL")
        .bind(reader)
        .bind(peer)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) fn room_of(server: &str, channel: &str) -> String {
    format!("{server}/{channel}")
}

pub(crate) async fn channel_line(db: &PgPool, redis: &Redis, server: &str, channel: &str, actor: Uuid, text: &str, admins: &[Uuid]) {
    if let Err(e) = chat_rows(db, redis, server, channel, actor, text, admins).await {
        log::warn!("notify: a line in {}: {}", room_of(server, channel), e.message());
    }
}

async fn chat_rows(db: &PgPool, redis: &Redis, server: &str, channel: &str, actor: Uuid, text: &str, admins: &[Uuid]) -> Result<(), ApiError> {
    let Some(actor) = actor_by_id(db, actor).await? else { return Ok(()) };
    let room = room_of(server, channel);
    let words: String = text.chars().take(TEXT_CHARS).collect();
    let mut tx = db.begin().await?;
    let held: Option<i32> = sqlx::query_scalar("SELECT 1 FROM channels WHERE server = $1 AND name = $2 AND kind = 'text' FOR UPDATE").bind(server).bind(channel).fetch_optional(&mut *tx).await?;
    if held.is_none() {
        return Ok(());
    }
    let sql = format!(
        "WITH recipients AS (
            SELECT m.user_id FROM memberships m JOIN streamers u ON u.id = m.user_id
            WHERE m.group_name = $1 AND m.user_id <> $3 AND u.password_hash IS NOT NULL
              AND COALESCE((u.notify->>'chat')::boolean, true)
              AND NOT EXISTS (SELECT 1 FROM channel_mutes cm WHERE cm.user_id = m.user_id AND cm.server = $1 AND cm.channel = $2)
              AND EXISTS (SELECT 1 FROM channels c WHERE c.server = $1 AND c.name = $2 AND c.kind = 'text' AND {sees})
         ),
         gone AS (
            DELETE FROM notifications n USING recipients r
            WHERE n.user_id = r.user_id AND n.kind = 'chat' AND n.room = $4 AND n.read_at IS NULL
         ),
         made AS (
            INSERT INTO notifications (user_id, kind, actor_id, text, room)
            SELECT r.user_id, 'chat', $3, $5, $4 FROM recipients r
            RETURNING id, user_id, at
         )
         SELECT m.id, u.name, m.user_id, (EXTRACT(EPOCH FROM m.at) * 1000)::bigint
         FROM made m JOIN streamers u ON u.id = m.user_id",
        sees = crate::groups::sees_sql("m.user_id", "m.user_id = ANY($6)")
    );
    let rows: Vec<LiveRow> = sqlx::query_as(&sql)
        .bind(server)
        .bind(channel)
        .bind(actor.id)
        .bind(&room)
        .bind(&words)
        .bind(admins)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    if rows.is_empty() {
        return Ok(());
    }
    let users: Vec<Uuid> = rows.iter().map(|r| r.2).collect();
    clip(db, &users).await?;
    let made = Made {
        to: rows.iter().map(|(id, login, _, _)| (login.clone(), *id)).collect(),
        at_ms: rows.first().map_or_else(presence::now_ms, |r| r.3),
        text: words,
        session: None,
        room: Some(room),
    };
    tell(redis, Kind::Chat, &actor, &made).await;
    Ok(())
}

pub(crate) async fn channel_read(db: &PgPool, reader: Uuid, room: &str) -> Result<bool, sqlx::Error> {
    let done = sqlx::query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND kind = 'chat' AND room = $2 AND read_at IS NULL")
        .bind(reader)
        .bind(room)
        .execute(db)
        .await?;
    Ok(done.rows_affected() > 0)
}

type ItemRow = (i64, String, String, bool, Option<i64>, i64, bool, String, Option<i64>, Uuid, Option<String>);

async fn item_rows(db: &PgPool, me: Uuid, hide: bool) -> Result<Vec<ItemRow>, sqlx::Error> {
    sqlx::query_as(concat!(
        "SELECT n.id, n.kind, a.name, a.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM a.avatar_at))::bigint,
                (EXTRACT(EPOCH FROM n.at) * 1000)::bigint, n.read_at IS NOT NULL, n.text, n.session, a.id, n.room
         FROM notifications n JOIN streamers a ON a.id = n.actor_id
         WHERE n.user_id = $1 AND ",
        shown_sql!("a", "$3"),
        " ORDER BY n.id DESC
         LIMIT $2",
    ))
    .bind(me)
    .bind(KEEP)
    .bind(hide)
    .fetch_all(db)
    .await
}

async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let doc: Option<Value> = sqlx::query_scalar("SELECT notify FROM streamers WHERE id = $1").bind(me.id).fetch_optional(&s.db).await?;
    let settings = doc.as_ref().map(Settings::from_doc).unwrap_or_default();
    let rows = item_rows(&s.db, me.id, s.hide_test).await?;
    let mut servers: Vec<String> = rows.iter().filter_map(|r| r.10.as_deref()?.split_once('/').map(|(server, _)| server.to_owned())).collect();
    servers.sort();
    servers.dedup();
    let badges: HashMap<String, crate::groups::Badge> = crate::groups::badges_named(&s.db, &servers).await?.into_iter().map(|b| (b.name.clone(), b)).collect();
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, kind, name, verified, avatar, at, read, text, session, actor, room)| {
            let badge = room.as_deref().and_then(|r| r.split_once('/')).and_then(|(server, _)| badges.get(server));
            json!({ "id": id, "kind": kind, "name": name, "verified": verified, "avatar": avatar, "at": at, "read": read, "text": text, "session": session, "actor": actor, "room": room, "badge": badge })
        })
        .collect();
    Ok(Json(json!({ "settings": settings, "items": items })))
}

#[derive(Deserialize)]
struct IdBody {
    id: i64,
}

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

async fn remove(db: &PgPool, user: Uuid, id: i64) -> Result<bool, sqlx::Error> {
    let done = sqlx::query("DELETE FROM notifications WHERE id = $1 AND user_id = $2").bind(id).bind(user).execute(db).await?;
    Ok(done.rows_affected() > 0)
}

async fn dismiss(State(s): State<AppState>, Me(me): Me, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let no_such = || ApiError::new(StatusCode::NOT_FOUND, "no such notification");
    let id: i64 = id.parse().map_err(|_| no_such())?;
    if !remove(&s.db, me.id, id).await? {
        return Err(no_such());
    }
    presence::publish_notify_removed(&mut s.redis.clone(), &me.name, id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SettingsBody {
    #[serde(default = "on")]
    live: bool,
    #[serde(default = "on")]
    follow: bool,
    #[serde(default = "on")]
    dm: bool,
    #[serde(default = "on")]
    chat: bool,
}

fn on() -> bool {
    true
}

async fn settings(State(s): State<AppState>, Me(me): Me, body: Result<Json<SettingsBody>, JsonRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let wanted = Settings { live: body.live, follow: body.follow, dm: body.dm, chat: body.chat };
    sqlx::query("UPDATE streamers SET notify = $2 WHERE id = $1").bind(me.id).bind(wanted.to_doc()).execute(&s.db).await?;
    log::info!("{}: notifications {}", me.name, wanted.to_doc());
    Ok(Json(json!(wanted)))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(list))
        .route("/api/notifications/read", put(read))
        .route("/api/notifications/settings", put(settings))
        .route("/api/notifications/{id}", delete(dismiss))
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
        let s = Settings { live: true, follow: false, dm: false, chat: true };
        assert_eq!(s.to_doc(), json!({ "follow": false, "dm": false }));
        assert_eq!(Settings::from_doc(&s.to_doc()), s);
        assert_eq!(Settings::from_doc(&json!({ "live": "no", "dm": 0 })), Settings::default());
        assert!(Settings::from_doc(&json!({ "dm": false })).chat);
        assert_eq!(Settings { chat: false, ..Settings::default() }.to_doc(), json!({ "chat": false }));
    }

    #[test]
    fn the_json_names_every_kind() {
        assert_eq!(serde_json::to_value(Settings::default()).unwrap(), json!({ "live": true, "follow": true, "dm": true, "chat": true }));
    }

    #[test]
    fn a_chat_rows_room_is_the_chats_key() {
        assert_eq!(room_of("gaming-0042", "clips"), "gaming-0042/clips");
        assert_eq!(crate::chat::room_key(&room_of("gaming-0042", "clips")), "chat:gaming-0042/clips");
    }

    #[test]
    fn a_dismiss_is_a_write() {
        assert_eq!(crate::ratelimit::api_rule(&axum::http::Method::DELETE, "/api/notifications/{id}"), crate::ratelimit::WRITE);
    }

    #[tokio::test]
    #[ignore]
    async fn a_test_streamers_row_in_the_inbox_is_hidden_only_when_asked() {
        use crate::auth::tests::{row, test_db};
        let pool = test_db().await;
        let run = std::process::id();
        let owner = row(&pool, &format!("owner6-{run}"), Some("owner-hash")).await;
        let human = row(&pool, &format!("actor6-{run}"), Some("actor-hash")).await;
        let dummy = format!("dummy-n{run}");
        crate::test_streamers::mark(&pool, &dummy).await.unwrap();
        let dummy_id: Uuid = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(&dummy).fetch_one(&pool).await.unwrap();
        for actor in [human, dummy_id] {
            sqlx::query("INSERT INTO notifications (user_id, kind, actor_id, session) VALUES ($1, 'live', $2, 1)").bind(owner).bind(actor).execute(&pool).await.unwrap();
        }
        let names = |rows: Vec<ItemRow>| rows.into_iter().map(|r| r.2).collect::<Vec<_>>();
        let shown = names(item_rows(&pool, owner, false).await.unwrap());
        assert!(shown.contains(&dummy) && shown.contains(&format!("actor6-{run}")), "{shown:?}");
        let hidden = names(item_rows(&pool, owner, true).await.unwrap());
        assert_eq!(hidden, vec![format!("actor6-{run}")]);
        sqlx::query("DELETE FROM streamers WHERE id = ANY($1)").bind(vec![owner, human, dummy_id]).execute(&pool).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn a_dismiss_takes_only_the_logins_own_row() {
        use crate::auth::tests::{row, test_db};
        let pool = test_db().await;
        let run = std::process::id();
        let owner = row(&pool, &format!("owner5-{run}"), Some("owner-hash")).await;
        let other = row(&pool, &format!("other5-{run}"), Some("other-hash")).await;
        let actor = row(&pool, &format!("actor5-{run}"), Some("actor-hash")).await;
        let made = |user: Uuid| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>("INSERT INTO notifications (user_id, kind, actor_id) VALUES ($1, 'follow', $2) RETURNING id")
                    .bind(user)
                    .bind(actor)
                    .fetch_one(&pool)
                    .await
                    .expect("a row")
            }
        };
        let mine = made(owner).await;
        let kept = made(owner).await;
        let theirs = made(other).await;
        let count = |id: i64| {
            let pool = pool.clone();
            async move { sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap() }
        };

        assert!(!remove(&pool, owner, theirs).await.unwrap(), "another login's row is not theirs to take");
        assert_eq!(count(theirs).await, 1);
        assert!(remove(&pool, owner, mine).await.unwrap());
        assert_eq!(count(mine).await, 0);
        assert_eq!(count(kept).await, 1, "the rest of the inbox stays");
        assert!(!remove(&pool, owner, mine).await.unwrap());

        sqlx::query("DELETE FROM streamers WHERE id = ANY($1)").bind(vec![owner, other, actor]).execute(&pool).await.unwrap();
    }
}
