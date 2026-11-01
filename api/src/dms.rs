//! Direct messages: a login writes a line to a friend (someone it follows who follows it
//! back), and every device of either sees it at once. See docs/dms.md.
//!
//! One table of lines, `dms (from_id, to_id, text, image, sent_at)`, both ids (docs/ids.md): a
//! renamed name keeps its threads, and a line is shown under whatever name its writer has
//! now. A thread is the pair, whichever way round. The api is the one writer: a line is a
//! row, then a `dm` fact on the `events` stream, and the gateway (events.rs) pushes it to
//! the sockets of both names, the way `live` reaches a stream's watchers. Reading is http, a
//! page at a time. `dm_reads` says how far into each thread a login has read, so the count
//! of what is new holds across reloads and devices; a read on one device clears the others
//! through a `dm_read` fact.
//!
//! A line may carry pictures, the room chat's way (chat_images.rs): the page shrinks each and
//! `POST /api/chat-images` keeps it, the line names the ids (`images`, ten at most), and the
//! row keeps them joined by commas in `image`, as a chat line does. The words may be empty
//! when there is a picture.

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{self, bump, Account, Me};
use crate::chat::{clean_text, picture_ids, split_pictures, MAX_TEXT_CHARS};
use crate::presence::{self, Presence};
use crate::{chat_images, follows, notify};
use crate::{ApiError, ApiResult, AppState, Name};

/// Lines in one page of a thread. A shorter page is the start of the thread.
const PAGE: i64 = 50;
/// Threads `GET /api/dms` lists, the newest first. More than a column of faces shows.
const THREADS: i64 = 100;
/// Lines per login per minute: a conversation, even a quick one, not a flood.
const RATE_PER_MINUTE: i64 = 60;
const RATE_WINDOW_SECS: i64 = 60;

/// The one refusal of a line: the pages show it under the box as it is.
const NOT_FRIENDS: &str = "not friends. a chat is with someone you follow who follows you back";

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

/// The account behind a name in the path: a held name answers for the account that left it
/// (docs/ids.md), a free name is nobody's and cannot be written to. 403 in the friends' words
/// either way: a name with no account is never a friend.
async fn peer(db: &PgPool, me: &Account, name: String) -> Result<Account, ApiError> {
    let name = auth::renamed_to(db, &name).await?.unwrap_or(name);
    if name == me.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that is you"));
    }
    let row: Option<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM streamers WHERE name = $1 AND password_hash IS NOT NULL")
        .bind(&name)
        .fetch_optional(db)
        .await?;
    let (id, name) = row.ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, NOT_FRIENDS))?;
    Ok(Account { id, name })
}

/// id, from (the name now), text, sent at (ms), the pictures' ids joined by commas (null for none)
type LineRow = (i64, String, String, i64, Option<String>);

fn line_json((id, from, text, at, image): &LineRow) -> Value {
    json!({ "id": id, "from": from, "text": text, "at": at, "images": split_pictures(image.clone()) })
}

/// Every id a line names is a picture `POST /api/chat-images` kept (the say's check, chat.rs
/// `pictures_exist`): 400 `no such picture` otherwise.
async fn pictures_exist(db: &PgPool, ids: &[String]) -> Result<(), ApiError> {
    for id in ids {
        if !chat_images::exists(db, id).await? {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such picture"));
        }
    }
    Ok(())
}

#[derive(Deserialize, Default)]
struct BeforeQuery {
    before: Option<i64>,
}

/// `GET /api/dm/:name[?before=<id>]`: one page of the thread with `name`, oldest first, the
/// newest page without `before`, the page before a line with it. A line is `id`, `from`,
/// `text`, `at` and `images` (the pictures' ids, empty for none). `friends` says whether a
/// line may be sent now; the thread reads either way, so an old conversation is not lost
/// with the follow.
async fn thread(State(s): State<AppState>, Name(name): Name, Me(me): Me, q: Result<Query<BeforeQuery>, QueryRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Query(q) = q?;
    let other = peer(&s.db, &me, name).await?;
    let mut rows: Vec<LineRow> = sqlx::query_as(
        "SELECT d.id, f.name, d.text, (EXTRACT(EPOCH FROM d.sent_at) * 1000)::bigint, d.image
         FROM dms d JOIN streamers f ON f.id = d.from_id
         WHERE LEAST(d.from_id, d.to_id) = LEAST($1, $2) AND GREATEST(d.from_id, d.to_id) = GREATEST($1, $2)
           AND ($3::bigint IS NULL OR d.id < $3)
         ORDER BY d.id DESC
         LIMIT $4",
    )
    .bind(me.id)
    .bind(other.id)
    .bind(q.before)
    .bind(PAGE)
    .fetch_all(&s.db)
    .await?;
    rows.reverse();
    let friends = follows::friends(&s.db, me.id, other.id).await?;
    Ok(Json(json!({ "name": other.name, "friends": friends, "lines": rows.iter().map(line_json).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
struct TextBody {
    #[serde(default)]
    text: String,
    /// The pictures on the line, the ids `POST /api/chat-images` handed back. The say's shape
    /// (chat.rs `In::Say`): `images` the set, or the one `image`.
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    images: Vec<String>,
}

/// `POST /api/dm/:name` with `{ text, images? }`: a line to a friend. 201 with the line as it
/// was kept (`id`, `from`, `text`, `at`, `images`); the same line comes back through the events
/// socket to every device of both, which is how the writer's other tabs hear it. 400 `too long`
/// past 500 characters, `nothing to say` for nothing once cleaned and no picture, `bad picture`,
/// `too many pictures` (ten is the cap) and `no such picture` for ids the upload never handed
/// out; 403 in the friends' words for anyone who is not one; 429 past 60 a minute.
async fn send(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Json<TextBody>, JsonRejection>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let text = clean_text(&body.text);
    let images = picture_ids(body.image, body.images).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    if text.is_empty() && images.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "nothing to say"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "too long"));
    }
    let other = peer(&s.db, &me, name).await?;
    if !follows::friends(&s.db, me.id, other.id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NOT_FRIENDS));
    }
    if bump(&s, &format!("rl:dm:name:{}", me.name), RATE_WINDOW_SECS).await? > RATE_PER_MINUTE {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "slow down"));
    }
    // the pictures must be ones the upload kept: a lookup each, paid for by the rate like the say's (chat.rs `accept`)
    pictures_exist(&s.db, &images).await?;
    let image = if images.is_empty() { None } else { Some(images.join(",")) };
    let (id, at): (i64, i64) = sqlx::query_as(
        "INSERT INTO dms (from_id, to_id, text, image) VALUES ($1, $2, $3, $4)
         RETURNING id, (EXTRACT(EPOCH FROM sent_at) * 1000)::bigint",
    )
    .bind(me.id)
    .bind(other.id)
    .bind(&text)
    .bind(&image)
    .fetch_one(&s.db)
    .await?;
    // the writer has read their own thread this far: a line of yours is never "new" to you
    mark_read(&s.db, me.id, other.id, id).await?;
    // the inbox row before the frame: the open thread's read must find it already there. a line of
    // pictures alone is a row with no words, and the list says `a picture` for it
    notify::messaged(&s, &other, &me, &text).await;
    let mut r = s.redis.clone();
    presence::publish_dm(&mut r, &me.name, &other.name, id, &text, &images, at, &me.id.to_string()).await;
    log::info!("{}: dm to {} ({} chars, {} pictures)", me.name, other.name, text.chars().count(), images.len());
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "from": me.name, "to": other.name, "text": text, "at": at, "images": images }))))
}

/// The reader has seen the thread with `peer` up to `id`. Never backwards: two devices
/// reading at once settle on the further one.
async fn mark_read(db: &PgPool, reader: Uuid, peer: Uuid, id: i64) -> Result<bool, sqlx::Error> {
    let moved = sqlx::query(
        "INSERT INTO dm_reads (reader_id, peer_id, last_read_id) VALUES ($1, $2, $3)
         ON CONFLICT (reader_id, peer_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, read_at = now()
         WHERE dm_reads.last_read_id < EXCLUDED.last_read_id",
    )
    .bind(reader)
    .bind(peer)
    .bind(id)
    .execute(db)
    .await?;
    let moved = moved.rows_affected() > 0;
    // what the peer wrote was in the reader's inbox too; read there with the thread
    if moved {
        notify::dm_read(db, reader, peer).await?;
    }
    Ok(moved)
}

#[derive(Deserialize)]
struct IdBody {
    id: i64,
}

/// `PUT /api/dm/:name/read` with `{ id }`: the login has seen the thread up to that line. 204.
/// A `dm_read` fact tells the login's other devices, so their count drops too.
async fn read(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Json<IdBody>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let other = peer(&s.db, &me, name).await?;
    if mark_read(&s.db, me.id, other.id, body.id).await? {
        let mut r = s.redis.clone();
        presence::publish_dm_read(&mut r, &me.name, &other.name, &other.id.to_string(), body.id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// peer id, name, verified, avatar, bio, status, last id, last from, last text, last at (ms), unread, last pictures (joined by commas)
type ThreadRow = (Uuid, String, bool, Option<i64>, String, String, i64, String, String, i64, i64, Option<String>);

/// `GET /api/dms`: every thread the login is in, the one with the newest line first, with the
/// other side as the sidebar lists people (face, ✓, bio, how they are), their account `id`,
/// the last line, and how many of their lines are past what the login has read. 100 at most.
/// 401 for nobody.
async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let rows: Vec<ThreadRow> = sqlx::query_as(
        "WITH mine AS (
            SELECT CASE WHEN from_id = $1 THEN to_id ELSE from_id END AS peer_id, max(id) AS last_id
            FROM dms WHERE from_id = $1 OR to_id = $1
            GROUP BY 1
         )
         SELECT s.id, s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio, s.status,
                d.id, f.name, d.text, (EXTRACT(EPOCH FROM d.sent_at) * 1000)::bigint,
                (SELECT count(*) FROM dms u
                  WHERE u.from_id = m.peer_id AND u.to_id = $1
                    AND u.id > COALESCE((SELECT r.last_read_id FROM dm_reads r WHERE r.reader_id = $1 AND r.peer_id = m.peer_id), 0)),
                d.image
         FROM mine m
         JOIN streamers s ON s.id = m.peer_id
         JOIN dms d ON d.id = m.last_id
         JOIN streamers f ON f.id = d.from_id
         ORDER BY d.id DESC
         LIMIT $2",
    )
    .bind(me.id)
    .bind(THREADS)
    .fetch_all(&s.db)
    .await?;
    let people: Vec<_> = rows.iter().map(|r| follows::choice(&r.1, &r.5)).collect();
    let words = follows::words(&s, &people).await?;
    let out = rows.iter().map(|(peer, name, verified, avatar, bio, _, id, from, text, at, unread, image)| {
        let (live, word) = words.get(name).copied().unwrap_or((false, Presence::Offline));
        json!({
            "id": peer.to_string(),
            "name": name, "verified": verified, "avatar": avatar, "bio": bio, "live": live, "presence": word,
            "last": { "id": id, "from": from, "text": text, "at": at, "images": split_pictures(image.clone()) }, "unread": unread,
        })
    });
    Ok(Json(Value::Array(out.collect())))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/dms", get(list))
        .route("/api/dm/{name}", get(thread).post(send))
        .route("/api/dm/{name}/read", put(read))
}
