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
//!                                 the box takes filters among the words (`parse_search`): `from:<name>`,
//!                                 `has:image`, `has:link`, `has:video`, `before:<day>`, `after:<day>`.
//! `GET /chat/<name>/by/<name>`   that account's verified lines in this room, newest first.
//! `GET /chat/<name>/around/<id>` a window around one line. redis when the id is still in
//! the stream, otherwise postgres. the panel scrolls to that id.
//!
//! A server channel is the same four reads with the room `server/channel`:
//! `/chat/<server>/<channel>/before`, `search`, `by/<account>`, `around/<id>`.

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveTime, Utc};
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
/// A search's box, in unicode scalars: filters and words together.
const SEARCH_CHARS: usize = 200;
/// A link to a video, for `has:video`: a postgres regex (case-insensitive) over the text of the
/// lines that have a link (`has_link`, migrate-22.sql). The host or the file type has to sit
/// inside a link of that same shape, so a video-looking word beside an unrelated link
/// (`a.mov … https://example.com`) is not one. A file link may end a sentence: the punctuation
/// the panel leaves out of a link (`LinkedText.tsx`) is allowed before a space or the end, so
/// `clip.mp4.` and `(…/clip.mp4)` are videos and `x.movie` and `clip.mp4.example.com/a` are not.
/// The chat keeps no videos of its own, so this is the hosts people paste, and the file types a
/// browser plays. Not the schema's: a host is added here.
const VIDEO_LINK: &str = r"(^|[^[:alnum:]])(https?://|www\.)[^[:space:]]*(youtube\.com/(watch|shorts|live|embed)|youtu\.be/|twitch\.tv/videos/|clips\.twitch\.tv/|twitch\.tv/[^/[:space:]]+/clip/|vimeo\.com/[0-9]|streamable\.com/|kick\.com/[^[:space:]]*/clips?/|tiktok\.com/|\.(mp4|webm|mov|m3u8)([?#]|[[:punct:]]*([[:space:]]|$)))";

/// A line's columns, with its speaker's picture as it is now (`LineRow`). The row keeps no
/// picture: a read joins `streamers` for it, by account for a verified line (so a rename
/// keeps it for the hold's length; after it, the letter: the name the page fetches by leads
/// elsewhere) and by name for the streamer's. A nick's line joins nothing: it is nobody's
/// picture, whoever holds that name later. A line out of redis gets the same from
/// `chat::with_faces`, so the two sides of the window agree.
const LINE_COLUMNS: &str = "l.id, l.at, l.speaker, l.user_id, l.\"text\", l.streamer, l.verified, l.badges, l.image,
                            (EXTRACT(EPOCH FROM COALESCE(u.avatar_at, r.avatar_at)))::bigint";
const LINE_TABLES: &str = "chat_lines l
                           LEFT JOIN streamers u ON l.verified AND u.id = l.user_id
                               AND (u.name = l.speaker OR EXISTS (SELECT 1 FROM held_names h WHERE h.user_id = u.id AND h.name = l.speaker AND h.until > now()))
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
    if q.chars().count() > SEARCH_CHARS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "too long"));
    }
    let search = parse_search(q)?;
    if search.words.is_empty() && !search.filtered() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "say what to look for"));
    }
    // `from:` is the name's account too, when it has one: a login's line is its account's
    // whatever name it was said under (a rename), and the account's lines are all its names'
    let account: Option<Uuid> = match &search.from {
        Some(name) => {
            sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL")
                .bind(name)
                .fetch_optional(&s.db)
                .await?
        }
        None => None,
    };
    let (sql, binds) = search_sql(&search, account);
    let mut query = sqlx::query_as::<_, LineRow>(&sql).bind(room);
    for bind in binds {
        query = match bind {
            Bind::Text(text) => query.bind(text),
            Bind::Id(id) => query.bind(id),
            Bind::At(at) => query.bind(at),
        };
    }
    let rows: Vec<LineRow> = query.bind(SEARCH_LIMIT).fetch_all(&s.db).await?;
    Ok(json_lines(rows.into_iter().map(line_of).collect()))
}

/// What the one box asked for: the words looked for, and the filters taken out from among them.
#[derive(Debug, Default, PartialEq)]
struct Search {
    /// The words as typed, filters removed, for `websearch_to_tsquery`. Empty with filters alone.
    words: String,
    /// `from:<name>`, lower case: lines said under that name, and its account's under any name.
    from: Option<String>,
    /// `has:image` (or `picture`): a line with a picture on it.
    image: bool,
    /// `has:link` (or `url`): a line with a link in its words.
    link: bool,
    /// `has:video` (or `clip`): a line with a link to a video (`VIDEO_LINK`).
    video: bool,
    /// `before:<day>`: said before that day began (utc).
    before: Option<DateTime<Utc>>,
    /// `after:<day>`: said once that day was over (utc), so the day itself is out, as on discord.
    after: Option<DateTime<Utc>>,
}

impl Search {
    fn filtered(&self) -> bool {
        self.from.is_some() || self.image || self.link || self.video || self.before.is_some() || self.after.is_some()
    }
}

/// The box's text apart: a `key:value` word with a key this knows is a filter; the rest are the
/// words, kept in their order. Inside a quoted phrase nothing is a filter, so `"from: the top"`
/// is still a phrase; the phrase ends at its closing `"` even mid-word (`world",`), as
/// `websearch_to_tsquery` reads it. A known key with nothing after the colon, or a value it
/// cannot read, is a 400 that says what the key wants.
fn parse_search(q: &str) -> Result<Search, ApiError> {
    let mut search = Search::default();
    let mut words: Vec<&str> = Vec::new();
    let mut quoted = false;
    for token in q.split_whitespace() {
        if quoted || token.starts_with('"') {
            words.push(token);
            // each `"` opens or closes a phrase, so `"a"` and `"gg"!` are whole and `world",` closes
            if token.matches('"').count() % 2 == 1 {
                quoted = !quoted;
            }
            continue;
        }
        let Some((key, value)) = token.split_once(':') else {
            words.push(token);
            continue;
        };
        let key = key.to_ascii_lowercase();
        let bad = |want: &str| ApiError::new(StatusCode::BAD_REQUEST, format!("{key}: wants {want}"));
        match key.as_str() {
            "from" => {
                let name = value.to_lowercase();
                if !valid_name(&name) {
                    return Err(bad("a name, like from:bob"));
                }
                search.from = Some(name);
            }
            "has" => match value.to_ascii_lowercase().as_str() {
                "image" | "picture" => search.image = true,
                "link" | "url" => search.link = true,
                "video" | "clip" => search.video = true,
                _ => return Err(bad("image, link or video")),
            },
            "before" | "after" => {
                // `%Y` reads a signed year of any length (`-5000`), which postgres cannot hold as an
                // `at`; and no line is at a day before the epoch (`at_seq`), so 1970 is the floor
                let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok().filter(|day| day.year() >= 1970);
                let Some(day) = day else {
                    return Err(bad(&format!("a day, like {key}:2026-10-30")));
                };
                if key == "before" {
                    search.before = Some(day.and_time(NaiveTime::MIN).and_utc());
                } else {
                    let next = day.checked_add_days(Days::new(1)).ok_or_else(|| bad("a day this side of the end of time"))?;
                    search.after = Some(next.and_time(NaiveTime::MIN).and_utc());
                }
            }
            // `https://…`, `re:…`: a word with a colon in it
            _ => words.push(token),
        }
    }
    search.words = words.join(" ");
    Ok(search)
}

/// A value the search binds after the room ($1), in the order `search_sql` named them.
enum Bind {
    Text(String),
    Id(Uuid),
    At(DateTime<Utc>),
}

/// The next placeholder: the room is $1, so a bind pushed here is $(its count + 1).
fn placeholder(binds: &mut Vec<Bind>, bind: Bind) -> String {
    binds.push(bind);
    format!("${}", binds.len() + 1)
}

/// The query for a search: the room, then one clause per thing asked, each bound in the order
/// returned, and the limit last. `simple`: the words as written, not stems; websearch so a
/// quoted phrase stays a phrase. `has:image` and `has:link` are the partial indexes of
/// migrate-22.sql; `has:video` is a regex over the linked lines; the dates are the room index.
fn search_sql(search: &Search, account: Option<Uuid>) -> (String, Vec<Bind>) {
    let mut binds = Vec::new();
    let mut clauses: Vec<String> = Vec::new();
    if !search.words.is_empty() {
        let words = placeholder(&mut binds, Bind::Text(search.words.clone()));
        clauses.push(format!("l.search @@ websearch_to_tsquery('simple', {words})"));
    }
    if let Some(name) = &search.from {
        // a nick is stored as typed (`Bob`); an account name is lower case already
        let name = placeholder(&mut binds, Bind::Text(name.clone()));
        match account {
            Some(id) => {
                let id = placeholder(&mut binds, Bind::Id(id));
                clauses.push(format!("(lower(l.speaker) = {name} OR l.user_id = {id})"));
            }
            None => clauses.push(format!("lower(l.speaker) = {name}")),
        }
    }
    if search.image {
        clauses.push("l.image IS NOT NULL".to_owned());
    }
    if search.link || search.video {
        clauses.push("l.has_link".to_owned());
    }
    if search.video {
        let hosts = placeholder(&mut binds, Bind::Text(VIDEO_LINK.to_owned()));
        clauses.push(format!("l.\"text\" ~* {hosts}"));
    }
    if let Some(at) = search.before {
        let at = placeholder(&mut binds, Bind::At(at));
        clauses.push(format!("l.at < {at}"));
    }
    if let Some(at) = search.after {
        let at = placeholder(&mut binds, Bind::At(at));
        clauses.push(format!("l.at >= {at}"));
    }
    let limit = binds.len() + 2;
    let mut sql = format!("SELECT {LINE_COLUMNS} FROM {LINE_TABLES} WHERE l.room = $1");
    for clause in &clauses {
        sql.push_str(" AND ");
        sql.push_str(clause);
    }
    sql.push_str(&format!(" ORDER BY l.at DESC, l.seq DESC LIMIT ${limit}"));
    (sql, binds)
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

    fn utc(day: &str) -> DateTime<Utc> {
        NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap().and_time(NaiveTime::MIN).and_utc()
    }

    #[test]
    fn words_alone_are_the_old_search() {
        let s = parse_search("hello world").unwrap();
        assert_eq!(s.words, "hello world");
        assert!(!s.filtered());
        // a colon with a key this does not know is a word, so a pasted link is looked for
        let s = parse_search("https://example.com/x re:that").unwrap();
        assert_eq!(s.words, "https://example.com/x re:that");
        assert!(!s.filtered());
    }

    #[test]
    fn filters_come_out_from_among_the_words() {
        let s = parse_search("from:Bob has:image hello HAS:link there").unwrap();
        assert_eq!(s.from.as_deref(), Some("bob"), "a name is lower case, as nicks are compared");
        assert!(s.image && s.link && !s.video);
        assert_eq!(s.words, "hello there");
        // filters alone are a search
        let s = parse_search("has:video").unwrap();
        assert!(s.video && s.words.is_empty() && s.filtered());
        assert!(parse_search("has:picture").unwrap().image);
        assert!(parse_search("has:url").unwrap().link);
        assert!(parse_search("has:clip").unwrap().video);
    }

    #[test]
    fn a_quoted_phrase_is_never_a_filter() {
        let s = parse_search("\"from: the top\" rope").unwrap();
        assert_eq!(s.words, "\"from: the top\" rope");
        assert!(s.from.is_none());
        let s = parse_search("\"has:image\" from:ann").unwrap();
        assert_eq!(s.words, "\"has:image\"");
        assert!(!s.image && s.from.as_deref() == Some("ann"));
    }

    #[test]
    fn a_phrase_ends_at_its_closing_quote_even_mid_word() {
        // the sentence's punctuation after a closing quote is not part of the phrase, as
        // websearch_to_tsquery reads it, so what follows is a filter again
        let s = parse_search("\"hello world\", from:bob").unwrap();
        assert_eq!(s.words, "\"hello world\",");
        assert_eq!(s.from.as_deref(), Some("bob"));
        let s = parse_search("\"gg\"! has:video").unwrap();
        assert_eq!(s.words, "\"gg\"!");
        assert!(s.video);
        let s = parse_search("\"hello world\") from:bob").unwrap();
        assert_eq!(s.from.as_deref(), Some("bob"));
        // a phrase that opens and closes in one word
        let s = parse_search("\"a\" from:bob").unwrap();
        assert_eq!(s.words, "\"a\"");
        assert_eq!(s.from.as_deref(), Some("bob"));
    }

    #[test]
    fn the_days_are_utc_and_the_day_itself_is_out() {
        let s = parse_search("before:2026-10-30 after:2026-10-01").unwrap();
        assert_eq!(s.before, Some(utc("2026-10-30")));
        assert_eq!(s.after, Some(utc("2026-10-02")), "after a day is from the next day on");
        assert!(parse_search("before:1970-01-01").is_ok(), "the epoch is the first day a line can be at");
    }

    #[test]
    fn a_filter_it_cannot_read_says_what_it_wants() {
        let want = |q: &str| parse_search(q).err().map(|e| e.message().to_owned()).unwrap_or_default();
        assert_eq!(want("has:gif"), "has: wants image, link or video");
        assert_eq!(want("from:"), "from: wants a name, like from:bob");
        assert_eq!(want("from:b!b"), "from: wants a name, like from:bob");
        assert_eq!(want("before:yesterday"), "before: wants a day, like before:2026-10-30");
        assert_eq!(want("after:2026-13-01"), "after: wants a day, like after:2026-10-30");
        // chrono's `%Y` reads a signed year of any length, which postgres cannot hold; and no
        // line is at a day before the epoch, so the floor is 1970 and a shorter year is out too
        assert_eq!(want("before:-5000-01-01"), "before: wants a day, like before:2026-10-30");
        assert_eq!(want("after:-9999-01-01"), "after: wants a day, like after:2026-10-30");
        assert_eq!(want("before:1969-12-31"), "before: wants a day, like before:2026-10-30");
        assert_eq!(want("before:26-10-30"), "before: wants a day, like before:2026-10-30");
    }

    #[test]
    fn the_query_binds_each_thing_asked_in_order_and_the_limit_last() {
        let id = Uuid::nil();
        let s = parse_search("from:bob has:video hello before:2026-10-30").unwrap();
        let (sql, binds) = search_sql(&s, Some(id));
        assert!(sql.starts_with(&format!("SELECT {LINE_COLUMNS} FROM {LINE_TABLES} WHERE l.room = $1")));
        assert!(sql.contains("l.search @@ websearch_to_tsquery('simple', $2)"));
        assert!(sql.contains("(lower(l.speaker) = $3 OR l.user_id = $4)"));
        assert!(sql.contains("l.has_link") && sql.contains("l.\"text\" ~* $5"));
        assert!(sql.contains("l.at < $6"));
        assert!(sql.ends_with("ORDER BY l.at DESC, l.seq DESC LIMIT $7"));
        assert_eq!(binds.len(), 5);
        assert!(matches!(&binds[0], Bind::Text(w) if w == "hello"));
        assert!(matches!(&binds[1], Bind::Text(n) if n == "bob"));
        assert!(matches!(&binds[2], Bind::Id(i) if *i == id));
        assert!(matches!(&binds[3], Bind::Text(re) if re == VIDEO_LINK));
        assert!(matches!(&binds[4], Bind::At(at) if *at == utc("2026-10-30")));

        // a name with no account is the speaker alone; pictures bind nothing
        let s = parse_search("from:guest has:image").unwrap();
        let (sql, binds) = search_sql(&s, None);
        assert!(sql.contains("lower(l.speaker) = $2 AND l.image IS NOT NULL"));
        assert!(sql.ends_with("LIMIT $3"));
        assert_eq!(binds.len(), 1);
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

    /// The one line in `room`, read the way a scroll reads it (`pg_older`, so `LINE_TABLES`), and its face.
    async fn face_of_the_line_in(pool: &PgPool, room: &str, speaker: &str) -> Option<i64> {
        let (at, seq) = at_seq("1729000000001-0").unwrap();
        let lines = pg_older(pool, room, at, seq, PAGE).await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].from, speaker, "a line keeps the name it was said under");
        lines[0].avatar
    }

    /// The postgres side of `chat::with_faces`'s rule, so the two sides of the window agree: a
    /// verified line wears its account's face while the name it was said under is the account's
    /// or held for it; after the hold, the letter, whoever holds that name later.
    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored a_stored_lines_face` against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn a_stored_lines_face_follows_a_rename_for_the_hold_and_then_is_the_letter() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let room = format!("room6-{run}");
        let alice_name = format!("alice6-{run}");
        let alice = row(&pool, &alice_name, Some("alice-hash")).await;
        sqlx::query("UPDATE streamers SET avatar_at = to_timestamp(1690000000) WHERE id = $1").bind(alice).execute(&pool).await.unwrap();
        store(&pool, &room, "1729000000000-0", &alice_name, Some(alice), "hi", None, false, true, &[]).await.unwrap();
        // her own name: her picture
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, Some(1690000000));

        // what change_name leaves behind: the row is bob, and alice is held for it. the face follows
        let bob_name = format!("bob6-{run}");
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(alice).bind(&bob_name).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&alice_name)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, Some(1690000000), "the face follows a rename for the hold's length");

        // the hold runs out: the old name is nobody's, so the line is the letter, not an <img> that 404s
        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&alice_name).execute(&pool).await.unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, None, "after the hold the old name is not the account's: the letter");

        // a stranger signs up as alice and uploads a picture: still the letter, not theirs and not bob's
        let stranger = row(&pool, &alice_name, Some("stranger-hash")).await;
        sqlx::query("UPDATE streamers SET avatar_at = to_timestamp(1700000000) WHERE id = $1").bind(stranger).execute(&pool).await.unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, None, "a stranger on the freed name is nobody's picture on the account's words");
    }

    /// The ids a search of `room` finds, through the query `search_room` runs, newest first.
    async fn found(pool: &PgPool, room: &str, q: &str) -> Vec<String> {
        let search = parse_search(q).unwrap();
        let account: Option<Uuid> = match &search.from {
            Some(name) => sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL").bind(name).fetch_optional(pool).await.unwrap(),
            None => None,
        };
        let (sql, binds) = search_sql(&search, account);
        let mut query = sqlx::query_as::<_, LineRow>(&sql).bind(room);
        for bind in binds {
            query = match bind {
                Bind::Text(text) => query.bind(text),
                Bind::Id(id) => query.bind(id),
                Bind::At(at) => query.bind(at),
            };
        }
        let rows: Vec<LineRow> = query.bind(SEARCH_LIMIT).fetch_all(pool).await.unwrap();
        rows.into_iter().map(|row| line_of(row).id).collect()
    }

    /// The filters against the database: the generated `has_link` (migrate-22.sql), the video
    /// regex as postgres reads it, `from:` by name and by account, and the days.
    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored the_filters` against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn the_filters_find_the_lines_they_name() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let room = format!("room7-{run}");
        let ann_name = format!("ann7-{run}");
        let ann = row(&pool, &ann_name, Some("ann-hash")).await;
        // ids are redis stream ids: 2026-10-29 is 1793232000000 ms, 2026-10-30 is 1793318400000
        let oct29 = 1_793_232_000_000u64;
        let oct30 = 1_793_318_400_000u64;
        let line = |ms: u64, seq: u64| format!("{ms}-{seq}");
        // ann, logged in: plain words
        store(&pool, &room, &line(oct29, 0), &ann_name, Some(ann), "morning everyone", None, false, true, &[]).await.unwrap();
        // a nick, Bob as typed, with a link
        store(&pool, &room, &line(oct29, 1), "Bob", None, "look https://example.com/page.", None, false, false, &[]).await.unwrap();
        // ann with a picture and no words
        store(&pool, &room, &line(oct30, 0), &ann_name, Some(ann), "", Some("11111111-1111-1111-1111-111111111111"), false, true, &[]).await.unwrap();
        // a nick with a video link, scheme-less
        store(&pool, &room, &line(oct30, 1), "cy", None, "this one www.youtube.com/watch?v=abc", None, false, false, &[]).await.unwrap();
        // a nick with a link to a video file
        store(&pool, &room, &line(oct30, 2), "cy", None, "or http://files.test/clip.mp4?x=1 later", None, false, false, &[]).await.unwrap();
        // "example.com" in words is not a link
        store(&pool, &room, &line(oct30, 3), "Bob", None, "example.com is a domain not a link", None, false, false, &[]).await.unwrap();
        // a video file link that ends a sentence: the period, the bracket and the exclamation are
        // the sentence's, not the link's, as the panel draws it (LinkedText.tsx)
        store(&pool, &room, &line(oct30, 4), "cy", None, "watch this https://files.test/clip.mp4.", None, false, false, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 5), "cy", None, "clip (https://files.test/clip.mp4)", None, false, false, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 6), "cy", None, "lol https://x.test/a.webm!", None, false, false, &[]).await.unwrap();
        // a video-looking word beside a link that is not one: linked, not a video
        store(&pool, &room, &line(oct30, 7), "cy", None, "I saw a.mov yesterday https://example.com", None, false, false, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 8), "cy", None, "x.movie https://example.com", None, false, false, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 9), "cy", None, "the youtube.com/watch page is slow, see https://example.com/help", None, false, false, &[]).await.unwrap();
        // the extension inside a host is not a video file
        store(&pool, &room, &line(oct30, 10), "cy", None, "see https://clip.mp4.example.com/a", None, false, false, &[]).await.unwrap();

        assert_eq!(found(&pool, &room, "everyone").await, vec![line(oct29, 0)], "the words alone, as before");
        assert_eq!(found(&pool, &room, "has:image").await, vec![line(oct30, 0)]);
        let linked = vec![line(oct30, 10), line(oct30, 9), line(oct30, 8), line(oct30, 7), line(oct30, 6), line(oct30, 5), line(oct30, 4), line(oct30, 2), line(oct30, 1), line(oct29, 1)];
        assert_eq!(found(&pool, &room, "has:link").await, linked, "newest first, and a bare domain is not a link");
        assert_eq!(
            found(&pool, &room, "has:video").await,
            vec![line(oct30, 6), line(oct30, 5), line(oct30, 4), line(oct30, 2), line(oct30, 1)],
            "a file link may end a sentence; a video-looking word beside another link is not a video"
        );
        assert_eq!(found(&pool, &room, "has:video later").await, vec![line(oct30, 2)], "a filter and the words together");
        assert_eq!(found(&pool, &room, "from:bob").await, vec![line(oct30, 3), line(oct29, 1)], "a nick as typed, asked for in lower case");
        assert_eq!(found(&pool, &room, &format!("from:{ann_name}")).await, vec![line(oct30, 0), line(oct29, 0)], "an account's lines");
        assert_eq!(found(&pool, &room, "from:bob has:link").await, vec![line(oct29, 1)]);
        assert_eq!(found(&pool, &room, "before:2026-10-30").await, vec![line(oct29, 1), line(oct29, 0)]);
        assert_eq!(found(&pool, &room, "after:2026-10-29").await.len(), 11, "after a day is from the next day on");
        assert_eq!(found(&pool, &room, "after:2026-10-29 before:2026-10-30").await, Vec::<String>::new());

        // the account's lines follow a rename: ann is now dee, and `from:dee` finds what ann said
        let dee_name = format!("dee7-{run}");
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(ann).bind(&dee_name).execute(&pool).await.unwrap();
        assert_eq!(found(&pool, &room, &format!("from:{dee_name}")).await, vec![line(oct30, 0), line(oct29, 0)]);
    }
}
