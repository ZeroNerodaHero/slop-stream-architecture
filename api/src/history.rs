//! Durable chat lines. The chat process, and only when `CHAT_PERSIST` is on.
//!
//! Redis stays the live tail: the last 500, the join history, the fan-out. Postgres
//! (`chat_lines`, created by the api process with the other tables) is the record you
//! scroll into and search. A line is written to redis first and inserted here after,
//! so a slow database never holds up the room.
//!
//! Reads take one side or the other. Anything still inside the redis window comes from
//! redis. A request older than the oldest id redis still has comes from postgres, strictly
//! older than the id the client sent, so a line kept in both is not returned twice.
//!
//! `GET /chat/<name>/before?id=`  older lines, oldest first. redis, then postgres.
//! `GET /chat/<name>/search?q=`   matching lines in this room, newest first. off: history is not kept.
//! `GET /chat/<name>/by/<name>`   that account's verified lines in this room, newest first.
//! `GET /chat/<name>/around/<id>` a window around one line. redis when the id is still in
//! the stream, otherwise postgres. the panel scrolls to that id.
//!
//! A server channel is the same four reads with the room `server/channel`:
//! `/chat/<server>/<channel>/before`, `search`, `by/<account>`, `around/<id>`.

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Utc};
use redis::streams::StreamRangeReply;
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::chat::{line_from, room_key, with_faces, ChatState, Line};
use crate::groups::Badge;
use crate::socket::id_parts;
use crate::{valid_name, ApiError, Name};

use axum::http::StatusCode;

/// How many older lines one scroll asks for. The panel treats a short page as the end.
const PAGE: i64 = 50;
/// Lines on each side of the one a search hit opens on.
const WINDOW: usize = 40;
const SEARCH_LIMIT: i64 = 50;

/// A line's columns, with its speaker's picture as it is now (`LineRow`). The row keeps no
/// picture: a read joins `streamers` for it, by account for a verified line (so a rename
/// keeps it) and by name for the streamer's. A nick's line joins nothing: it is nobody's
/// picture, whoever holds that name later. A line out of redis gets the same from
/// `chat::with_faces`, so the two sides of the window agree.
const LINE_COLUMNS: &str = "l.id, l.at, l.speaker, l.user_id, l.\"text\", l.streamer, l.verified, l.badges, l.image,
                            (EXTRACT(EPOCH FROM COALESCE(u.avatar_at, r.avatar_at)))::bigint";
const LINE_TABLES: &str = "chat_lines l
                           LEFT JOIN streamers u ON l.verified AND u.id = l.user_id
                           LEFT JOIN streamers r ON l.streamer AND NOT l.verified AND r.name = l.speaker";

pub(crate) fn routes() -> Router<ChatState> {
    Router::new()
        .route("/chat/{name}/before", get(before))
        .route("/chat/{name}/search", get(search))
        .route("/chat/{name}/by/{speaker}", get(by_user))
        .route("/chat/{name}/around/{id}", get(around))
        .route("/chat/{server}/{channel}/before", get(before_channel))
        .route("/chat/{server}/{channel}/search", get(search_channel))
        .route("/chat/{server}/{channel}/by/{speaker}", get(by_channel))
        .route("/chat/{server}/{channel}/around/{id}", get(around_channel))
}

async fn room_of_channel(s: &ChatState, server: &str, channel: &str) -> Result<String, ApiError> {
    Ok(crate::groups::channel_room(&s.db, server, channel).await?.1)
}

async fn before_channel(State(s): State<ChatState>, Path((server, channel)): Path<(String, String)>, Query(q): Query<IdQuery>) -> Result<JsonLines, ApiError> {
    let room = room_of_channel(&s, &server, &channel).await?;
    let id = stream_id(&q.id)?;
    Ok(json_lines(older(&s, &room, &id).await?))
}

async fn search_channel(State(s): State<ChatState>, Path((server, channel)): Path<(String, String)>, Query(q): Query<SearchQuery>) -> Result<JsonLines, ApiError> {
    let room = room_of_channel(&s, &server, &channel).await?;
    search_room(&s, &room, &q.q).await
}

async fn by_channel(
    State(s): State<ChatState>,
    Path((server, channel, speaker)): Path<(String, String, String)>,
) -> Result<JsonLines, ApiError> {
    let room = room_of_channel(&s, &server, &channel).await?;
    lines_of(&s, &room, &speaker).await
}

async fn around_channel(State(s): State<ChatState>, Path((server, channel, id)): Path<(String, String, String)>) -> Result<JsonLines, ApiError> {
    let room = room_of_channel(&s, &server, &channel).await?;
    window(&s, &room, &id).await
}

/// `CHAT_PERSIST=1` (also true, on, yes). Anything else, including unset, is off.
/// Read from `chat::run` only, so the api process never turns this on.
pub(crate) fn enabled() -> bool {
    flag_on(std::env::var("CHAT_PERSIST").ok().as_deref())
}

fn flag_on(raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return false };
    let raw = raw.trim().to_ascii_lowercase();
    matches!(raw.as_str(), "1" | "true" | "on" | "yes")
}

/// One accepted line, after its XADD. A conflict (the same id twice) is fine.
/// The caller logs a failure and does not tell the sender: the line is already in the room.
pub(crate) async fn store(
    db: &PgPool,
    room: &str,
    id: &str,
    speaker: &str,
    user_id: Option<Uuid>,
    text: &str,
    image: Option<&str>,
    streamer: bool,
    verified: bool,
    groups: &[Badge],
) -> Result<(), sqlx::Error> {
    let Some((at, seq)) = at_seq(id) else {
        log::warn!("{room}: history id {id} is not a redis stream id");
        return Ok(());
    };
    // verified is the only thing that earns an account id. a nick, and a streamer logged
    // in as somebody else, are null, so "this user's lines" cannot be a guess.
    let user_id = user_id.filter(|_| verified);
    let badges = serde_json::to_value(groups).unwrap_or_else(|_| json!([]));
    sqlx::query(
        "INSERT INTO chat_lines (room, id, at, seq, speaker, user_id, \"text\", streamer, verified, badges, image)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (room, id) DO NOTHING",
    )
    .bind(room)
    .bind(id)
    .bind(at)
    .bind(seq)
    .bind(speaker)
    .bind(user_id)
    .bind(text)
    .bind(streamer)
    .bind(verified)
    .bind(badges)
    .bind(image)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
struct IdQuery {
    id: String,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn before(State(s): State<ChatState>, Name(room): Name, Query(q): Query<IdQuery>) -> Result<JsonLines, ApiError> {
    let id = stream_id(&q.id)?;
    Ok(json_lines(older(&s, &room, &id).await?))
}

async fn search(State(s): State<ChatState>, Name(room): Name, Query(q): Query<SearchQuery>) -> Result<JsonLines, ApiError> {
    search_room(&s, &room, &q.q).await
}

async fn search_room(s: &ChatState, room: &str, q: &str) -> Result<JsonLines, ApiError> {
    if !s.persist {
        return Err(not_kept());
    }
    let q = q.trim();
    if q.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "say what to look for"));
    }
    if q.chars().count() > 200 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "too long"));
    }
    // `simple`: the words as written, not stems. websearch so a quoted phrase stays a phrase.
    let sql = format!(
        "SELECT {LINE_COLUMNS} FROM {LINE_TABLES}
         WHERE l.room = $1 AND l.search @@ websearch_to_tsquery('simple', $2)
         ORDER BY l.at DESC, l.seq DESC LIMIT $3"
    );
    let rows: Vec<LineRow> = sqlx::query_as(&sql).bind(room).bind(q).bind(SEARCH_LIMIT).fetch_all(&s.db).await?;
    Ok(json_lines(rows.into_iter().map(line_of).collect()))
}

async fn by_user(State(s): State<ChatState>, Path((room, speaker)): Path<(String, String)>) -> Result<JsonLines, ApiError> {
    let room = room_of(&room)?;
    lines_of(&s, &room, &speaker).await
}

async fn lines_of(s: &ChatState, room: &str, speaker: &str) -> Result<JsonLines, ApiError> {
    if !s.persist {
        return Err(not_kept());
    }
    let speaker = room_of(speaker)?;
    let user_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL")
        .bind(&speaker)
        .fetch_optional(&s.db)
        .await?;
    let Some(user_id) = user_id else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "that name has no account"));
    };
    let sql = format!(
        "SELECT {LINE_COLUMNS} FROM {LINE_TABLES}
         WHERE l.room = $1 AND l.user_id = $2
         ORDER BY l.at DESC, l.seq DESC LIMIT $3"
    );
    let rows: Vec<LineRow> = sqlx::query_as(&sql).bind(room).bind(user_id).bind(SEARCH_LIMIT).fetch_all(&s.db).await?;
    Ok(json_lines(rows.into_iter().map(line_of).collect()))
}

async fn around(State(s): State<ChatState>, Path((room, id)): Path<(String, String)>) -> Result<JsonLines, ApiError> {
    let room = room_of(&room)?;
    window(&s, &room, &id).await
}

async fn window(s: &ChatState, room: &str, id: &str) -> Result<JsonLines, ApiError> {
    let id = stream_id(id)?;
    if let Some(lines) = redis_window(s, room, &id).await? {
        return Ok(json_lines(lines));
    }
    if !s.persist {
        return Err(not_kept());
    }
    let Some((at, seq)) = at_seq(&id) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad id"));
    };
    let sql = format!("SELECT {LINE_COLUMNS} FROM {LINE_TABLES} WHERE l.room = $1 AND l.id = $2");
    let hit: Option<LineRow> = sqlx::query_as(&sql).bind(room).bind(&id).fetch_optional(&s.db).await?;
    let Some(hit) = hit else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such line"));
    };
    let before = pg_side(&s.db, room, at, seq, Side::Before).await?;
    let after = pg_side(&s.db, room, at, seq, Side::After).await?;
    let mut lines = before;
    lines.push(line_of(hit));
    lines.extend(after);
    Ok(json_lines(lines))
}

/// Lines strictly older than `id`, oldest first, one page.
/// A full page from redis is still inside the window, and postgres is not asked.
/// A short page is the end of redis: the rest, older than the oldest redis line
/// returned (or older than `id` when redis had none), comes from postgres.
async fn older(s: &ChatState, room: &str, id: &str) -> Result<Vec<Line>, ApiError> {
    let mut from_redis = redis_older(s, room, id, PAGE as usize).await?;
    if from_redis.len() == PAGE as usize || !s.persist {
        from_redis.reverse();
        return Ok(from_redis);
    }
    let boundary = from_redis.last().map(|l| l.id.clone()).unwrap_or_else(|| id.to_owned());
    let Some((at, seq)) = at_seq(&boundary) else {
        from_redis.reverse();
        return Ok(from_redis);
    };
    let need = PAGE - from_redis.len() as i64;
    let mut from_pg = pg_older(&s.db, room, at, seq, need).await?;
    from_pg.reverse();
    from_redis.reverse();
    from_pg.extend(from_redis);
    Ok(from_pg)
}

/// Newest first, strictly older than `id`, at most `limit`. Empty when redis has none
/// (the id is already past the window, or the room's stream does not have it).
async fn redis_older(s: &ChatState, room: &str, id: &str, limit: usize) -> Result<Vec<Line>, ApiError> {
    let mut r = s.redis.clone();
    // `(` is exclusive. XREVRANGE's first bound is the newest end.
    let reply: StreamRangeReply = r.xrevrange_count(room_key(room), format!("({id}"), "-", limit).await?;
    let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
    with_faces(&s.db, &mut lines).await;
    Ok(lines)
}

/// The window from redis when `id` is still in the stream. None when it has been trimmed.
async fn redis_window(s: &ChatState, room: &str, id: &str) -> Result<Option<Vec<Line>>, ApiError> {
    let mut r = s.redis.clone();
    let key = room_key(room);
    let hit: StreamRangeReply = r.xrange_count(&key, id, id, 1).await?;
    let Some(line) = hit.ids.into_iter().find_map(line_from) else {
        return Ok(None);
    };
    let older: StreamRangeReply = r.xrevrange_count(&key, format!("({id}"), "-", WINDOW).await?;
    let newer: StreamRangeReply = r.xrange_count(&key, format!("({id}"), "+", WINDOW).await?;
    let mut lines: Vec<Line> = older.ids.into_iter().filter_map(line_from).collect();
    lines.reverse();
    lines.push(line);
    lines.extend(newer.ids.into_iter().filter_map(line_from));
    with_faces(&s.db, &mut lines).await;
    Ok(Some(lines))
}

async fn pg_older(db: &PgPool, room: &str, at: DateTime<Utc>, seq: i64, limit: i64) -> Result<Vec<Line>, sqlx::Error> {
    let sql = format!(
        "SELECT {LINE_COLUMNS} FROM {LINE_TABLES}
         WHERE l.room = $1 AND (l.at, l.seq) < ($2, $3)
         ORDER BY l.at DESC, l.seq DESC LIMIT $4"
    );
    let rows: Vec<LineRow> = sqlx::query_as(&sql).bind(room).bind(at).bind(seq).bind(limit).fetch_all(db).await?;
    Ok(rows.into_iter().map(line_of).collect())
}

enum Side {
    Before,
    After,
}

async fn pg_side(db: &PgPool, room: &str, at: DateTime<Utc>, seq: i64, side: Side) -> Result<Vec<Line>, sqlx::Error> {
    let (cmp, order) = match side {
        Side::Before => ("<", "DESC"),
        Side::After => (">", "ASC"),
    };
    // order is one of the two literals above, never a value
    let sql = format!(
        "SELECT {LINE_COLUMNS} FROM {LINE_TABLES}
         WHERE l.room = $1 AND (l.at, l.seq) {cmp} ($2, $3)
         ORDER BY l.at {order}, l.seq {order} LIMIT {WINDOW}"
    );
    let rows: Vec<LineRow> = sqlx::query_as(&sql).bind(room).bind(at).bind(seq).fetch_all(db).await?;
    let mut lines: Vec<Line> = rows.into_iter().map(line_of).collect();
    if matches!(side, Side::Before) {
        lines.reverse();
    }
    Ok(lines)
}

/// `LINE_COLUMNS`, in order: `image` is the picture ids on the line (one, or several joined by
/// commas), and the last is the speaker's face the join found.
type LineRow = (String, DateTime<Utc>, String, Option<Uuid>, String, bool, bool, Value, Option<String>, Option<i64>);

fn line_of((id, at, speaker, user_id, text, streamer, verified, badges, image, avatar): LineRow) -> Line {
    let groups = serde_json::from_value::<Vec<Badge>>(badges).unwrap_or_default();
    let images = crate::chat::split_pictures(image);
    let image = images.first().cloned();
    Line {
        id,
        from: speaker,
        text,
        streamer,
        verified,
        groups,
        avatar,
        user_id,
        image,
        images,
        at: at.timestamp_millis().max(0) as u64,
    }
}

type JsonLines = axum::Json<Value>;

fn json_lines(lines: Vec<Line>) -> JsonLines {
    axum::Json(json!({ "lines": lines }))
}

fn not_kept() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "history is not kept")
}

fn room_of(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError::bad_name());
    }
    Ok(name)
}

/// A redis stream id, `milliseconds-sequence`. Anything else is a 400, so a junk
/// id cannot become (0, 0) and read the whole table.
fn stream_id(raw: &str) -> Result<String, ApiError> {
    if at_seq(raw).is_none() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad id"));
    }
    Ok(raw.to_owned())
}

fn at_seq(id: &str) -> Option<(DateTime<Utc>, i64)> {
    let (ms, seq) = id_parts(id);
    let mut parts = id.split('-');
    let head = parts.next()?;
    let tail = parts.next()?;
    if parts.next().is_some() || head.is_empty() || tail.is_empty() {
        return None;
    }
    if !head.bytes().all(|b| b.is_ascii_digit()) || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // id_parts already parsed these. reject a value that does not fit the column.
    let ms = i64::try_from(ms).ok()?;
    let seq = i64::try_from(seq).ok()?;
    Some((DateTime::from_timestamp_millis(ms)?, seq))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_on_only_for_the_four_words() {
        assert!(flag_on(Some("1")));
        assert!(flag_on(Some("true")));
        assert!(flag_on(Some(" on ")));
        assert!(flag_on(Some("YES")));
        assert!(!flag_on(None));
        assert!(!flag_on(Some("")));
        assert!(!flag_on(Some("0")));
        assert!(!flag_on(Some("false")));
        assert!(!flag_on(Some("yes please")));
    }

    #[test]
    fn only_a_redis_stream_id_is_a_line_id() {
        assert!(at_seq("1729000000000-0").is_some());
        assert!(at_seq("1729000000000-10").is_some());
        assert!(at_seq("0-0").is_some());
        assert!(at_seq("garbage").is_none());
        assert!(at_seq("1-2-3").is_none());
        assert!(at_seq("-1").is_none());
        assert!(at_seq("1-").is_none());
        assert!(at_seq("").is_none());
        assert!(at_seq("1729-0 ").is_none());
    }
}
