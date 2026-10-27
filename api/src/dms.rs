//! Direct messages: a login writes a line to a friend (someone it follows who follows it
//! back), and every device of either sees it at once. See docs/dms.md.
//!
//! One table of lines, `dms (from_id, to_id, text, sent_at)`, both ids (docs/ids.md): a
//! renamed name keeps its threads, and a line is shown under whatever name its writer has
//! now. A thread is the pair, whichever way round. The api is the one writer: a line is a
//! row, then a `dm` fact on the `events` stream, and the gateway (events.rs) pushes it to
//! the sockets of both names, the way `live` reaches a stream's watchers. Reading is http, a
//! page at a time. `dm_reads` says how far into each thread a login has read, so the count
//! of what is new holds across reloads and devices; a read on one device clears the others
//! through a `dm_read` fact.

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
use crate::chat::{clean_text, MAX_TEXT_CHARS};
use crate::follows;
use crate::presence::{self, Presence};
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

/// id, from (the name now), text, sent at (ms)
type LineRow = (i64, String, String, i64);

fn line_json((id, from, text, at): &LineRow) -> Value {
    json!({ "id": id, "from": from, "text": text, "at": at })
}

#[derive(Deserialize, Default)]
struct BeforeQuery {
    before: Option<i64>,
}

/// `GET /api/dm/:name[?before=<id>]`: one page of the thread with `name`, oldest first, the
/// newest page without `before`, the page before a line with it. `friends` says whether a
/// line may be sent now; the thread reads either way, so an old conversation is not lost
/// with the follow.
async fn thread(State(s): State<AppState>, Name(name): Name, Me(me): Me, q: Result<Query<BeforeQuery>, QueryRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Query(q) = q?;
    let other = peer(&s.db, &me, name).await?;
    let mut rows: Vec<LineRow> = sqlx::query_as(
        "SELECT d.id, f.name, d.text, (EXTRACT(EPOCH FROM d.sent_at) * 1000)::bigint
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
    text: String,
}

/// `POST /api/dm/:name` with `{ text }`: a line to a friend. 201 with the line as it was kept
/// (`id`, `from`, `text`, `at`); the same line comes back through the events socket to every
/// device of both, which is how the writer's other tabs hear it. 400 `too long` past 500
/// characters, or nothing once cleaned; 403 in the friends' words for anyone who is not one;
/// 429 past 60 a minute.
async fn send(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Json<TextBody>, JsonRejection>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let text = clean_text(&body.text);
    if text.is_empty() {
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
    let (id, at): (i64, i64) = sqlx::query_as(
        "INSERT INTO dms (from_id, to_id, text) VALUES ($1, $2, $3)
         RETURNING id, (EXTRACT(EPOCH FROM sent_at) * 1000)::bigint",
    )
    .bind(me.id)
    .bind(other.id)
    .bind(&text)
    .fetch_one(&s.db)
    .await?;
    // the writer has read their own thread this far: a line of yours is never "new" to you
    mark_read(&s.db, me.id, other.id, id).await?;
    let mut r = s.redis.clone();
    presence::publish_dm(&mut r, &me.name, &other.name, id, &text, at).await;
    log::info!("{}: dm to {} ({} chars)", me.name, other.name, text.chars().count());
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "from": me.name, "to": other.name, "text": text, "at": at }))))
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
    Ok(moved.rows_affected() > 0)
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
        presence::publish_dm_read(&mut r, &me.name, &other.name, body.id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// name, verified, avatar, bio, status, last id, last from, last text, last at (ms), unread
type ThreadRow = (String, bool, Option<i64>, String, String, i64, String, String, i64, i64);

/// `GET /api/dms`: every thread the login is in, the one with the newest line first, with the
/// other side as the sidebar lists people (face, ✓, bio, how they are), the last line, and how
/// many of their lines are past what the login has read. 100 at most. 401 for nobody.
async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let rows: Vec<ThreadRow> = sqlx::query_as(
        "WITH mine AS (
            SELECT CASE WHEN from_id = $1 THEN to_id ELSE from_id END AS peer_id, max(id) AS last_id
            FROM dms WHERE from_id = $1 OR to_id = $1
            GROUP BY 1
         )
         SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio, s.status,
                d.id, f.name, d.text, (EXTRACT(EPOCH FROM d.sent_at) * 1000)::bigint,
                (SELECT count(*) FROM dms u
                  WHERE u.from_id = m.peer_id AND u.to_id = $1
                    AND u.id > COALESCE((SELECT r.last_read_id FROM dm_reads r WHERE r.reader_id = $1 AND r.peer_id = m.peer_id), 0))
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
    let people: Vec<_> = rows.iter().map(|r| follows::choice(&r.0, &r.4)).collect();
    let words = follows::words(&s, &people).await?;
    let out = rows.iter().map(|(name, verified, avatar, bio, _, id, from, text, at, unread)| {
        let (live, word) = words.get(name).copied().unwrap_or((false, Presence::Offline));
        json!({
            "name": name, "verified": verified, "avatar": avatar, "bio": bio, "live": live, "presence": word,
            "last": { "id": id, "from": from, "text": text, "at": at }, "unread": unread,
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
