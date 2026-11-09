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
//!
//! A thread is searched the room chat's way too (`GET /api/dm/:name/search?q=`, history.rs
//! `read_search`: the words, a quoted phrase, and the filters among them), over its own rows
//! alone: the pair bounds a thread to a few thousand lines at most, so the words are matched
//! as `to_tsvector` over the text and a link is the rooms' regex over it, with no column or
//! index of their own.

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
use crate::history::{self, Bind, Search};
use crate::presence::{self, Presence};
use crate::{chat_images, follows, notify};
use crate::{ApiError, ApiResult, AppState, Name};

/// Lines in one page of a thread. A shorter page is the start of the thread.
const PAGE: i64 = 50;
/// Hits a search of a thread answers, newest first: the room search's number (history.rs).
const SEARCH_LIMIT: i64 = 50;
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
struct SearchQuery {
    q: String,
}

/// `GET /api/dm/:name/search?q=`: the lines of the thread with `name` that match, newest first,
/// 50 at most, `{ lines: [{ id, from, text, at, images }] }`, a line as the thread has it. The
/// box is the room chat's (history.rs `read_search`): the words, a quoted phrase, and the filters
/// among them, `from:<name>` (one of the two; anyone else finds nothing), `has:image`,
/// `has:link`, `has:video`, `before:<day>`, `after:<day>`. 400 `say what to look for` for an
/// empty box, `too long` past 200 characters, and a filter's own words when its value will not
/// read; 401 nobody; 400 `that is you` and 403 for a name with no account, as the thread is. A
/// thread reads whether or not the two are still friends, and so does its search.
async fn search(State(s): State<AppState>, Name(name): Name, Me(me): Me, q: Result<Query<SearchQuery>, QueryRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Query(q) = q?;
    let search = history::read_search(&q.q)?;
    if search.channel.is_some() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "channel: is for a group's chat"));
    }
    let other = peer(&s.db, &me, name).await?;
    // `from:` names one of the two, by the name they have now or one held for them after a rename
    // (docs/ids.md). anyone else wrote nothing in this thread
    let from = match &search.from {
        Some(asked) => {
            let now = auth::renamed_to(&s.db, asked).await?.unwrap_or_else(|| asked.clone());
            match [&me, &other].into_iter().find(|a| a.name == now) {
                Some(who) => Some(who.id),
                None => return Ok(Json(json!({ "lines": [] }))),
            }
        }
        None => None,
    };
    let (sql, binds) = search_sql(&search, from);
    let mut query = sqlx::query_as::<_, LineRow>(&sql).bind(me.id).bind(other.id);
    for bind in binds {
        query = match bind {
            Bind::Text(text) => query.bind(text),
            Bind::Id(id) => query.bind(id),
            Bind::At(at) => query.bind(at),
        };
    }
    let rows: Vec<LineRow> = query.bind(SEARCH_LIMIT).fetch_all(&s.db).await?;
    Ok(Json(json!({ "lines": rows.iter().map(line_json).collect::<Vec<_>>() })))
}

/// The query for a search of a thread: the pair ($1, $2), then one clause per thing asked, each
/// bound in the order returned, and the limit last. The thread index narrows the rows to the
/// pair first; the rest is read off each row (`to_tsvector` over the words, the rooms' link
/// regex, `history::LINK`, over the text for `has:link`, `VIDEO_LINK` for `has:video`), since
/// a thread is a few thousand lines at most and a column for each would cost more than it saves.
fn search_sql(search: &Search, from: Option<Uuid>) -> (String, Vec<Bind>) {
    let mut binds: Vec<Bind> = Vec::new();
    let mut clauses: Vec<String> = Vec::new();
    // the next placeholder: the pair is $1 and $2, so a bind pushed here is $(its count + 2)
    let mut placeholder = |bind: Bind| {
        binds.push(bind);
        format!("${}", binds.len() + 2)
    };
    if !search.words.is_empty() {
        let words = placeholder(Bind::Text(search.words.clone()));
        clauses.push(format!("to_tsvector('simple', d.text) @@ websearch_to_tsquery('simple', {words})"));
    }
    if let Some(id) = from {
        let id = placeholder(Bind::Id(id));
        clauses.push(format!("d.from_id = {id}"));
    }
    if search.image {
        clauses.push("d.image IS NOT NULL".to_owned());
    }
    if search.link || search.video {
        let link = placeholder(Bind::Text(history::LINK.to_owned()));
        clauses.push(format!("d.text ~* {link}"));
    }
    if search.video {
        let hosts = placeholder(Bind::Text(history::VIDEO_LINK.to_owned()));
        clauses.push(format!("d.text ~* {hosts}"));
    }
    if let Some(at) = search.before {
        let at = placeholder(Bind::At(at));
        clauses.push(format!("d.sent_at < {at}"));
    }
    if let Some(at) = search.after {
        let at = placeholder(Bind::At(at));
        clauses.push(format!("d.sent_at >= {at}"));
    }
    let limit = binds.len() + 3;
    let mut sql = "SELECT d.id, f.name, d.text, (EXTRACT(EPOCH FROM d.sent_at) * 1000)::bigint, d.image
         FROM dms d JOIN streamers f ON f.id = d.from_id
         WHERE LEAST(d.from_id, d.to_id) = LEAST($1, $2) AND GREATEST(d.from_id, d.to_id) = GREATEST($1, $2)"
        .to_owned();
    for clause in &clauses {
        sql.push_str(" AND ");
        sql.push_str(clause);
    }
    sql.push_str(&format!(" ORDER BY d.id DESC LIMIT ${limit}"));
    (sql, binds)
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
        .route("/api/dm/{name}/search", get(search))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, NaiveDate, NaiveTime, Utc};

    fn utc(day: &str) -> DateTime<Utc> {
        NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap().and_time(NaiveTime::MIN).and_utc()
    }

    #[test]
    fn the_query_binds_the_pair_then_each_thing_asked_and_the_limit_last() {
        let id = Uuid::nil();
        let s = history::parse_search("from:bob has:video hello before:2026-10-30").unwrap();
        let (sql, binds) = search_sql(&s, Some(id));
        assert!(sql.contains("LEAST(d.from_id, d.to_id) = LEAST($1, $2) AND GREATEST(d.from_id, d.to_id) = GREATEST($1, $2)"));
        assert!(sql.contains("to_tsvector('simple', d.text) @@ websearch_to_tsquery('simple', $3)"));
        assert!(sql.contains("d.from_id = $4"));
        assert!(sql.contains("d.text ~* $5") && sql.contains("d.text ~* $6"), "a video is a link first, then a video link: {sql}");
        assert!(sql.contains("d.sent_at < $7"));
        assert!(sql.ends_with("ORDER BY d.id DESC LIMIT $8"));
        assert_eq!(binds.len(), 5);
        assert!(matches!(&binds[0], Bind::Text(w) if w == "hello"));
        assert!(matches!(&binds[1], Bind::Id(i) if *i == id));
        assert!(matches!(&binds[2], Bind::Text(re) if re == history::LINK));
        assert!(matches!(&binds[3], Bind::Text(re) if re == history::VIDEO_LINK));
        assert!(matches!(&binds[4], Bind::At(at) if *at == utc("2026-10-30")));

        // pictures bind nothing: the pair and the limit alone. words and a day are a bind each
        let s = history::parse_search("has:image").unwrap();
        let (sql, binds) = search_sql(&s, None);
        assert!(sql.contains("AND d.image IS NOT NULL ORDER BY d.id DESC LIMIT $3"));
        assert!(binds.is_empty());
        let s = history::parse_search("hi there after:2026-10-01").unwrap();
        let (sql, binds) = search_sql(&s, None);
        assert!(sql.contains("d.sent_at >= $4") && sql.ends_with("LIMIT $5"));
        assert_eq!(binds.len(), 2);
    }
}
