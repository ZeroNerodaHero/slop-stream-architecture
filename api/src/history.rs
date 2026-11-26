use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveTime, Utc};
use redis::streams::StreamRangeReply;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::chat::{line_from, room_key, with_faces, ChatState, Line, Reply};
use crate::groups::Badge;
use crate::reactions::with_reactions;
use crate::socket::id_parts;
use crate::{valid_name, ApiError, Name};

use axum::http::StatusCode;

const PAGE: i64 = 50;
const WINDOW: usize = 40;
const SEARCH_LIMIT: i64 = 50;
pub(crate) const SEARCH_CHARS: usize = 200;
pub(crate) const LINK: &str = r"(^|[^[:alnum:]])(https?://|www\.)[^[:space:]]";
pub(crate) const VIDEO_LINK: &str = r"(^|[^[:alnum:]])(https?://|www\.)[^[:space:]]*(youtube\.com/(watch|shorts|live|embed)|youtu\.be/|youtube-nocookie\.com/embed/|twitch\.tv/[[:alnum:]_]|vimeo\.com/([^[:space:]]*/)?[0-9]|streamable\.com/|dailymotion\.com/(video|embed)/|dai\.ly/|kick\.com/[^[:space:]]*/clips?/|tiktok\.com/|\.(mp4|webm|mov|m3u8)([?#]|[[:punct:]]*([[:space:]]|$)))";

const LINE_COLUMNS: &str = concat!(
    "l.id, l.at, l.speaker, l.user_id, l.\"text\", l.streamer, l.verified, l.badges, l.image,
     (EXTRACT(EPOCH FROM COALESCE(u.avatar_at, r.avatar_at)))::bigint, l.room, (",
    crate::oauth::linked_sql!("u"),
    " OR ",
    crate::oauth::linked_sql!("r"),
    "), l.reply, l.video, l.mentions, l.audio"
);
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

async fn viewer(s: &ChatState, headers: &HeaderMap) -> Result<(Option<Uuid>, bool), ApiError> {
    let me = crate::auth::whoami_readonly(&s.db, headers).await?;
    let user = me.as_ref().map(|a| a.id);
    Ok((user, user.is_some_and(|id| s.is_admin_id(id))))
}

async fn seen_room(s: &ChatState, viewer: (Option<Uuid>, bool), server: &str, channel: &str) -> Result<(String, String), ApiError> {
    let (server, room) = crate::groups::channel_room(&s.db, server, channel).await?;
    let channel = room.strip_prefix(server.as_str()).and_then(|rest| rest.strip_prefix('/')).unwrap_or("");
    if !crate::groups::may_see_text(&s.db, &server, channel, viewer.0, viewer.1).await? {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    Ok((server, room))
}

async fn room_of_channel(s: &ChatState, headers: &HeaderMap, server: &str, channel: &str) -> Result<(String, Option<Uuid>), ApiError> {
    let who = viewer(s, headers).await?;
    Ok((seen_room(s, who, server, channel).await?.1, who.0))
}

async fn reader(s: &ChatState, headers: &HeaderMap) -> Option<Uuid> {
    crate::auth::whoami_readonly(&s.db, headers).await.ok().flatten().map(|a| a.id)
}

async fn before_channel(
    State(s): State<ChatState>,
    Path((server, channel)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<IdQuery>,
) -> Result<JsonLines, ApiError> {
    let (room, me) = room_of_channel(&s, &headers, &server, &channel).await?;
    let lines = page(&s, &room, q.id.as_deref()).await?;
    Ok(json_lines(&s, &room, me, lines).await)
}

async fn page(s: &ChatState, room: &str, id: Option<&str>) -> Result<Vec<Line>, ApiError> {
    match id {
        Some(id) => older(s, room, &stream_id(id)?).await,
        None => Ok(crate::chat::latest(s, room).await?),
    }
}

async fn search_channel(
    State(s): State<ChatState>,
    Path((server, channel)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<JsonLines, ApiError> {
    if !s.persist {
        return Err(not_kept());
    }
    let search = read_search(&q.q)?;
    let who = viewer(&s, &headers).await?;
    let (server, _) = seen_room(&s, who, &server, &channel).await?;
    let rooms: Vec<String> = match &search.channel {
        Some(name) => vec![seen_room(&s, who, &server, name).await?.1],
        None => crate::groups::visible_text_channels(&s.db, &server, who.0, who.1)
            .await?
            .into_iter()
            .map(|name| format!("{server}/{name}"))
            .collect(),
    };
    search_rooms(&s, &rooms, &search, Some(&server), who.0).await
}

async fn by_channel(
    State(s): State<ChatState>,
    Path((server, channel, speaker)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<JsonLines, ApiError> {
    let (room, me) = room_of_channel(&s, &headers, &server, &channel).await?;
    lines_of(&s, &room, &speaker, me).await
}

async fn around_channel(State(s): State<ChatState>, Path((server, channel, id)): Path<(String, String, String)>, headers: HeaderMap) -> Result<JsonLines, ApiError> {
    let (room, me) = room_of_channel(&s, &headers, &server, &channel).await?;
    window(&s, &room, &id, me).await
}

pub(crate) fn enabled() -> bool {
    flag_on(std::env::var("CHAT_PERSIST").ok().as_deref())
}

fn flag_on(raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return false };
    let raw = raw.trim().to_ascii_lowercase();
    matches!(raw.as_str(), "1" | "true" | "on" | "yes")
}

pub(crate) async fn store(
    db: &PgPool,
    room: &str,
    id: &str,
    speaker: &str,
    user_id: Option<Uuid>,
    text: &str,
    image: Option<&str>,
    (video, audio): (Option<&str>, Option<&str>),
    streamer: bool,
    verified: bool,
    groups: &[Badge],
    reply: Option<&Reply>,
    mentions: &[String],
) -> Result<(), sqlx::Error> {
    let Some((at, seq)) = at_seq(id) else {
        log::warn!("{room}: history id {id} is not a redis stream id");
        return Ok(());
    };
    let user_id = user_id.filter(|_| verified);
    let badges = serde_json::to_value(groups).unwrap_or_else(|_| json!([]));
    let reply = reply.and_then(|r| serde_json::to_value(r).ok());
    sqlx::query(
        "INSERT INTO chat_lines (room, id, at, seq, speaker, user_id, \"text\", streamer, verified, badges, image, reply, video, mentions, audio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
    .bind(reply)
    .bind(video)
    .bind(mentions)
    .bind(audio)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
struct IdQuery {
    id: Option<String>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn before(State(s): State<ChatState>, Name(room): Name, headers: HeaderMap, Query(q): Query<IdQuery>) -> Result<JsonLines, ApiError> {
    let lines = page(&s, &room, q.id.as_deref()).await?;
    Ok(json_lines(&s, &room, reader(&s, &headers).await, lines).await)
}

async fn search(State(s): State<ChatState>, Name(room): Name, headers: HeaderMap, Query(q): Query<SearchQuery>) -> Result<JsonLines, ApiError> {
    search_room(&s, &room, &q.q, &headers).await
}

pub(crate) fn read_search(q: &str) -> Result<Search, ApiError> {
    let q = q.trim();
    if q.chars().count() > SEARCH_CHARS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "too long"));
    }
    let search = parse_search(q)?;
    if search.words.is_empty() && !search.filtered() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "say what to look for"));
    }
    Ok(search)
}

async fn search_room(s: &ChatState, room: &str, q: &str, headers: &HeaderMap) -> Result<JsonLines, ApiError> {
    if !s.persist {
        return Err(not_kept());
    }
    let search = read_search(q)?;
    if search.channel.is_some() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "channel: is for a group's chat"));
    }
    search_rooms(s, &[room.to_owned()], &search, None, reader(s, headers).await).await
}

async fn search_rooms(s: &ChatState, rooms: &[String], search: &Search, server: Option<&str>, viewer: Option<Uuid>) -> Result<JsonLines, ApiError> {
    let account: Option<Uuid> = match &search.from {
        Some(name) => {
            sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL")
                .bind(name)
                .fetch_optional(&s.db)
                .await?
        }
        None => None,
    };
    let (sql, binds) = search_sql(search, account);
    let mut query = sqlx::query_as::<_, LineRow>(&sql).bind(rooms.to_vec());
    for bind in binds {
        query = match bind {
            Bind::Text(text) => query.bind(text),
            Bind::Id(id) => query.bind(id),
            Bind::At(at) => query.bind(at),
        };
    }
    let rows: Vec<LineRow> = query.bind(SEARCH_LIMIT).fetch_all(&s.db).await?;
    let rooms: Vec<String> = rows.iter().map(|row| row.10.clone()).collect();
    let mut hits: Vec<Hit> = rows.into_iter().map(|row| hit_of(row, server)).collect();
    with_reactions(&s.db, viewer, rooms.iter().map(String::as_str).zip(hits.iter_mut().map(|hit| &mut hit.line))).await;
    Ok(json_hits(hits))
}

#[derive(Serialize)]
struct Hit {
    #[serde(flatten)]
    line: Line,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

fn hit_of(row: LineRow, server: Option<&str>) -> Hit {
    let channel = server.and_then(|server| row.10.strip_prefix(server).and_then(|rest| rest.strip_prefix('/')).map(str::to_owned));
    Hit { line: line_of(row), channel }
}

fn json_hits(hits: Vec<Hit>) -> JsonLines {
    axum::Json(json!({ "lines": hits }))
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Search {
    pub(crate) words: String,
    pub(crate) from: Option<String>,
    pub(crate) channel: Option<String>,
    pub(crate) image: bool,
    pub(crate) link: bool,
    pub(crate) video: bool,
    pub(crate) before: Option<DateTime<Utc>>,
    pub(crate) after: Option<DateTime<Utc>>,
}

impl Search {
    fn filtered(&self) -> bool {
        self.from.is_some() || self.image || self.link || self.video || self.before.is_some() || self.after.is_some()
    }
}

pub(crate) fn parse_search(q: &str) -> Result<Search, ApiError> {
    let mut search = Search::default();
    let mut words: Vec<&str> = Vec::new();
    let mut quoted = false;
    for token in q.split_whitespace() {
        if quoted || token.starts_with('"') {
            words.push(token);
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
            "channel" | "in" => {
                let name = value.trim_start_matches('#').to_lowercase();
                if !valid_name(&name) {
                    return Err(bad(&format!("a channel, like {key}:general")));
                }
                search.channel = Some(name);
            }
            "has" => match value.to_ascii_lowercase().as_str() {
                "image" | "picture" => search.image = true,
                "link" | "url" => search.link = true,
                "video" | "clip" => search.video = true,
                _ => return Err(bad("image, link or video")),
            },
            "before" | "after" => {
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
            _ => words.push(token),
        }
    }
    search.words = words.join(" ");
    Ok(search)
}

pub(crate) enum Bind {
    Text(String),
    Id(Uuid),
    At(DateTime<Utc>),
}

fn placeholder(binds: &mut Vec<Bind>, bind: Bind) -> String {
    binds.push(bind);
    format!("${}", binds.len() + 1)
}

fn search_sql(search: &Search, account: Option<Uuid>) -> (String, Vec<Bind>) {
    let mut binds = Vec::new();
    let mut clauses: Vec<String> = Vec::new();
    if !search.words.is_empty() {
        let words = placeholder(&mut binds, Bind::Text(search.words.clone()));
        clauses.push(format!("l.search @@ websearch_to_tsquery('simple', {words})"));
    }
    if let Some(name) = &search.from {
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
    if search.link {
        clauses.push("l.has_link".to_owned());
    }
    if search.video {
        let hosts = placeholder(&mut binds, Bind::Text(VIDEO_LINK.to_owned()));
        clauses.push(format!("(l.video IS NOT NULL OR (l.has_link AND l.\"text\" ~* {hosts}))"));
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
    let mut sql = format!("SELECT {LINE_COLUMNS} FROM {LINE_TABLES} WHERE l.room = ANY($1)");
    for clause in &clauses {
        sql.push_str(" AND ");
        sql.push_str(clause);
    }
    sql.push_str(&format!(" ORDER BY l.at DESC, l.seq DESC LIMIT ${limit}"));
    (sql, binds)
}

async fn by_user(State(s): State<ChatState>, Path((room, speaker)): Path<(String, String)>, headers: HeaderMap) -> Result<JsonLines, ApiError> {
    let room = room_of(&room)?;
    lines_of(&s, &room, &speaker, reader(&s, &headers).await).await
}

async fn lines_of(s: &ChatState, room: &str, speaker: &str, viewer: Option<Uuid>) -> Result<JsonLines, ApiError> {
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
    Ok(json_lines(s, room, viewer, rows.into_iter().map(line_of).collect()).await)
}

async fn around(State(s): State<ChatState>, Path((room, id)): Path<(String, String)>, headers: HeaderMap) -> Result<JsonLines, ApiError> {
    let room = room_of(&room)?;
    window(&s, &room, &id, reader(&s, &headers).await).await
}

async fn window(s: &ChatState, room: &str, id: &str, viewer: Option<Uuid>) -> Result<JsonLines, ApiError> {
    let id = stream_id(id)?;
    if let Some(lines) = redis_window(s, room, &id).await? {
        return Ok(json_lines(s, room, viewer, lines).await);
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
    Ok(json_lines(s, room, viewer, lines).await)
}

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

async fn redis_older(s: &ChatState, room: &str, id: &str, limit: usize) -> Result<Vec<Line>, ApiError> {
    let mut r = s.redis.clone();
    let reply: StreamRangeReply = r.xrevrange_count(room_key(room), format!("({id}"), "-", limit).await?;
    let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
    with_faces(&s.db, &mut lines).await;
    Ok(lines)
}

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

pub(crate) async fn line_at(db: &PgPool, redis: &mut crate::timings::Redis, room: &str, id: &str) -> Result<Option<Line>, ApiError> {
    let id = stream_id(id)?;
    let hit: StreamRangeReply = redis.xrange_count(room_key(room), &id, &id, 1).await?;
    if let Some(line) = hit.ids.into_iter().find_map(line_from) {
        return Ok(Some(line));
    }
    let sql = format!("SELECT {LINE_COLUMNS} FROM {LINE_TABLES} WHERE l.room = $1 AND l.id = $2");
    let row: Option<LineRow> = sqlx::query_as(&sql).bind(room).bind(&id).fetch_optional(db).await?;
    Ok(row.map(line_of))
}

pub(crate) async fn by_account(db: &PgPool, rooms: &[String], user: Uuid, before: Option<(i64, i64, &str)>, limit: i64) -> Result<Vec<(String, Line)>, sqlx::Error> {
    let sql = format!(
        "SELECT {LINE_COLUMNS} FROM {LINE_TABLES}
         WHERE l.room = ANY($1) AND l.user_id = $2 AND l.verified
           AND (NOT $3 OR ((EXTRACT(EPOCH FROM l.at) * 1000)::bigint, l.seq, l.room) < ($4, $5, $6))
         ORDER BY l.at DESC, l.seq DESC, l.room DESC LIMIT $7"
    );
    let rows: Vec<LineRow> = sqlx::query_as(&sql)
        .bind(rooms)
        .bind(user)
        .bind(before.is_some())
        .bind(before.map_or(0, |b| b.0))
        .bind(before.map_or(0, |b| b.1))
        .bind(before.map_or("", |b| b.2))
        .bind(limit)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|row| (row.10.clone(), line_of(row))).collect())
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

type LineRow = (String, DateTime<Utc>, String, Option<Uuid>, String, bool, bool, Value, Option<String>, Option<i64>, String, bool, Option<Value>, Option<String>, Vec<String>, Option<String>);

fn line_of((id, at, speaker, user_id, text, streamer, verified, badges, image, avatar, _room, oauth_verified, reply, video, mentions, audio): LineRow) -> Line {
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
        oauth_verified,
        user_id,
        image,
        images,
        video: crate::chat::Video::parse(video.as_deref()),
        audio: crate::chat::Audio::parse(audio.as_deref()),
        reply: reply.and_then(|r| serde_json::from_value(r).ok()),
        mentions,
        reactions: Vec::new(),
        at: at.timestamp_millis().max(0) as u64,
    }
}

type JsonLines = axum::Json<Value>;

async fn json_lines(s: &ChatState, room: &str, viewer: Option<Uuid>, mut lines: Vec<Line>) -> JsonLines {
    with_reactions(&s.db, viewer, lines.iter_mut().map(|l| (room, l))).await;
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

pub(crate) fn stream_id(raw: &str) -> Result<String, ApiError> {
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
        let s = parse_search("has:video").unwrap();
        assert!(s.video && s.words.is_empty() && s.filtered());
        assert!(parse_search("has:picture").unwrap().image);
        assert!(parse_search("has:url").unwrap().link);
        assert!(parse_search("has:clip").unwrap().video);
    }

    #[test]
    fn a_channel_is_a_filter_of_a_servers_search_and_not_a_search_on_its_own() {
        let s = parse_search("channel:Clips hello").unwrap();
        assert_eq!(s.channel.as_deref(), Some("clips"), "a channel name is lower case, as the url has it");
        assert_eq!(s.words, "hello");
        assert_eq!(parse_search("in:#general gg").unwrap().channel.as_deref(), Some("general"), "`in:` and the page's `#` read the same");
        assert!(!parse_search("channel:clips").unwrap().filtered(), "a channel alone names no lines to look for");
        assert!(read_search("channel:clips").is_err());
        assert!(read_search("channel:clips has:image").is_ok(), "a filter beside it is a search");
        let want = |q: &str| parse_search(q).err().map(|e| e.message().to_owned()).unwrap_or_default();
        assert_eq!(want("channel:"), "channel: wants a channel, like channel:general");
        assert_eq!(want("in:a!b"), "in: wants a channel, like in:general");
    }

    #[test]
    fn a_hit_says_its_channel_for_a_servers_search_alone() {
        let row = |room: &str| -> LineRow {
            ("1729000000000-0".to_owned(), DateTime::from_timestamp_millis(1729000000000).unwrap(), "bob".to_owned(), None, "hi".to_owned(), false, false, json!([]), None, None, room.to_owned(), false, None, None, Vec::new(), None)
        };
        assert_eq!(hit_of(row("vip/clips"), Some("vip")).channel.as_deref(), Some("clips"));
        assert_eq!(hit_of(row("alice"), None).channel, None, "a stream's room has no channel");
        let text = serde_json::to_string(&hit_of(row("vip/clips"), Some("vip"))).unwrap();
        let hit: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(hit["channel"], "clips");
        assert_eq!(hit["from"], "bob", "the line's own fields stand beside it");
        let text = serde_json::to_string(&hit_of(row("alice"), None)).unwrap();
        assert!(!text.contains("channel"), "no channel key on a stream's hit: {text}");
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
        let s = parse_search("\"hello world\", from:bob").unwrap();
        assert_eq!(s.words, "\"hello world\",");
        assert_eq!(s.from.as_deref(), Some("bob"));
        let s = parse_search("\"gg\"! has:video").unwrap();
        assert_eq!(s.words, "\"gg\"!");
        assert!(s.video);
        let s = parse_search("\"hello world\") from:bob").unwrap();
        assert_eq!(s.from.as_deref(), Some("bob"));
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
        assert!(sql.starts_with(&format!("SELECT {LINE_COLUMNS} FROM {LINE_TABLES} WHERE l.room = ANY($1)")), "the rooms are one array, a stream's one or a server's channels");
        assert!(sql.contains("l.search @@ websearch_to_tsquery('simple', $2)"));
        assert!(sql.contains("(lower(l.speaker) = $3 OR l.user_id = $4)"));
        assert!(sql.contains("(l.video IS NOT NULL OR (l.has_link AND l.\"text\" ~* $5))"), "an uploaded video, or a link to one");
        assert!(sql.contains("l.at < $6"));
        assert!(sql.ends_with("ORDER BY l.at DESC, l.seq DESC LIMIT $7"));
        assert_eq!(binds.len(), 5);
        assert!(matches!(&binds[0], Bind::Text(w) if w == "hello"));
        assert!(matches!(&binds[1], Bind::Text(n) if n == "bob"));
        assert!(matches!(&binds[2], Bind::Id(i) if *i == id));
        assert!(matches!(&binds[3], Bind::Text(re) if re == VIDEO_LINK));
        assert!(matches!(&binds[4], Bind::At(at) if *at == utc("2026-10-30")));

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

    async fn face_of_the_line_in(pool: &PgPool, room: &str, speaker: &str) -> Option<i64> {
        let (at, seq) = at_seq("1729000000001-0").unwrap();
        let lines = pg_older(pool, room, at, seq, PAGE).await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].from, speaker, "a line keeps the name it was said under");
        lines[0].avatar
    }

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
        store(&pool, &room, "1729000000000-0", &alice_name, Some(alice), "hi", None, (None, None), false, true, &[], None, &[]).await.unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, Some(1690000000));
        let mark = |pool: PgPool, room: String| async move {
            let (at, seq) = at_seq("1729000000001-0").unwrap();
            pg_older(&pool, &room, at, seq, PAGE).await.unwrap()[0].oauth_verified
        };
        assert!(!mark(pool.clone(), room.clone()).await, "nothing linked: no oauth mark");
        sqlx::query("INSERT INTO oauth_identities (user_id, provider, provider_user_id) VALUES ($1, 'discord', $2)")
            .bind(alice)
            .bind(format!("hist-{run}"))
            .execute(&pool)
            .await
            .unwrap();
        assert!(mark(pool.clone(), room.clone()).await, "linked: the stored line wears the mark, as the row is now");

        let bob_name = format!("bob6-{run}");
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(alice).bind(&bob_name).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&alice_name)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, Some(1690000000), "the face follows a rename for the hold's length");

        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&alice_name).execute(&pool).await.unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, None, "after the hold the old name is not the account's: the letter");

        let stranger = row(&pool, &alice_name, Some("stranger-hash")).await;
        sqlx::query("UPDATE streamers SET avatar_at = to_timestamp(1700000000) WHERE id = $1").bind(stranger).execute(&pool).await.unwrap();
        assert_eq!(face_of_the_line_in(&pool, &room, &alice_name).await, None, "a stranger on the freed name is nobody's picture on the account's words");
    }

    #[tokio::test]
    #[ignore]
    async fn a_members_kept_lines_come_newest_first_from_the_rooms_asked() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let g = format!("modlog{run}");
        let (general, clips, hidden) = (format!("{g}/general"), format!("{g}/clips"), format!("{g}/hidden"));
        let al_name = format!("al{run}");
        let al = row(&pool, &al_name, Some("h")).await;
        let bo = row(&pool, &format!("bo{run}"), Some("h")).await;
        let quote = Reply { id: "1729000000000-0".into(), from: "bo".into(), text: "hi al".into(), streamer: false, verified: true, avatar: None, images: 0, video: false, audio: false };
        store(&pool, &general, "1729000000000-0", "bo", Some(bo), "hi al", None, (None, None), false, true, &[], None, &[]).await.unwrap();
        store(&pool, &general, "1729000000001-0", &al_name, Some(al), "one", None, (None, None), false, true, &[], Some(&quote), &[]).await.unwrap();
        store(&pool, &clips, "1729000000002-0", &al_name, Some(al), "two", None, (None, None), false, true, &[], None, &[]).await.unwrap();
        store(&pool, &general, "1729000000002-0", &al_name, Some(al), "three", None, (None, None), false, true, &[], None, &[]).await.unwrap();
        store(&pool, &general, "1729000000003-0", &al_name, None, "nick", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &hidden, "1729000000004-0", &al_name, Some(al), "secret", None, (None, None), false, true, &[], None, &[]).await.unwrap();

        let rooms = vec![general.clone(), clips.clone()];
        let all = by_account(&pool, &rooms, al, None, 50).await.unwrap();
        let got: Vec<(&str, &str)> = all.iter().map(|(room, l)| (room.as_str(), l.text.as_str())).collect();
        assert_eq!(got, vec![(general.as_str(), "three"), (clips.as_str(), "two"), (general.as_str(), "one")]);
        let reply = all[2].1.reply.as_ref().expect("the reply's quote rides along");
        assert_eq!((reply.from.as_str(), reply.text.as_str()), ("bo", "hi al"));

        let first = by_account(&pool, &rooms, al, None, 1).await.unwrap();
        assert_eq!(first[0].1.text, "three");
        let rest = by_account(&pool, &rooms, al, Some((1729000000002, 0, general.as_str())), 50).await.unwrap();
        assert_eq!(rest.iter().map(|(_, l)| l.text.as_str()).collect::<Vec<_>>(), vec!["two", "one"]);
        let last = by_account(&pool, &rooms, al, Some((1729000000001, 0, general.as_str())), 50).await.unwrap();
        assert!(last.is_empty());
    }

    async fn found(pool: &PgPool, room: &str, q: &str) -> Vec<String> {
        let search = parse_search(q).unwrap();
        let account: Option<Uuid> = match &search.from {
            Some(name) => sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL").bind(name).fetch_optional(pool).await.unwrap(),
            None => None,
        };
        let (sql, binds) = search_sql(&search, account);
        let mut query = sqlx::query_as::<_, LineRow>(&sql).bind(vec![room.to_owned()]);
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

    #[tokio::test]
    #[ignore]
    async fn the_filters_find_the_lines_they_name() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let room = format!("room7-{run}");
        let ann_name = format!("ann7-{run}");
        let ann = row(&pool, &ann_name, Some("ann-hash")).await;
        let oct29 = 1_793_232_000_000u64;
        let oct30 = 1_793_318_400_000u64;
        let line = |ms: u64, seq: u64| format!("{ms}-{seq}");
        store(&pool, &room, &line(oct29, 0), &ann_name, Some(ann), "morning everyone", None, (None, None), false, true, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct29, 1), "Bob", None, "look https://example.com/page.", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 0), &ann_name, Some(ann), "", Some("11111111-1111-1111-1111-111111111111"), (None, None), false, true, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 1), "cy", None, "this one www.youtube.com/watch?v=abc", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 2), "cy", None, "or http://files.test/clip.mp4?x=1 later", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 3), "Bob", None, "example.com is a domain not a link", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 4), "cy", None, "watch this https://files.test/clip.mp4.", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 5), "cy", None, "clip (https://files.test/clip.mp4)", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 6), "cy", None, "lol https://x.test/a.webm!", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 7), "cy", None, "I saw a.mov yesterday https://example.com", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 8), "cy", None, "x.movie https://example.com", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 9), "cy", None, "the youtube.com/watch page is slow, see https://example.com/help", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 10), "cy", None, "see https://clip.mp4.example.com/a", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 11), "cy", None, "live now https://www.twitch.tv/somebody", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 12), "cy", None, "https://dai.ly/x8abc12 and https://www.dailymotion.com/video/x8abc12", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 13), "cy", None, "https://player.vimeo.com/video/76979871", None, (None, None), false, false, &[], None, &[]).await.unwrap();
        store(&pool, &room, &line(oct30, 14), &ann_name, Some(ann), "", None, (Some("22222222-2222-2222-2222-222222222222,33333333-3333-3333-3333-333333333333"), None), false, true, &[], None, &[]).await.unwrap();

        assert_eq!(found(&pool, &room, "everyone").await, vec![line(oct29, 0)], "the words alone, as before");
        assert_eq!(found(&pool, &room, "has:image").await, vec![line(oct30, 0)]);
        let linked = vec![line(oct30, 13), line(oct30, 12), line(oct30, 11), line(oct30, 10), line(oct30, 9), line(oct30, 8), line(oct30, 7), line(oct30, 6), line(oct30, 5), line(oct30, 4), line(oct30, 2), line(oct30, 1), line(oct29, 1)];
        assert_eq!(found(&pool, &room, "has:link").await, linked, "newest first, and a bare domain is not a link");
        assert_eq!(
            found(&pool, &room, "has:video").await,
            vec![line(oct30, 14), line(oct30, 13), line(oct30, 12), line(oct30, 11), line(oct30, 6), line(oct30, 5), line(oct30, 4), line(oct30, 2), line(oct30, 1)],
            "an uploaded video; a file link may end a sentence; a video-looking word beside another link is not a video"
        );
        assert_eq!(found(&pool, &room, "has:video later").await, vec![line(oct30, 2)], "a filter and the words together");
        assert_eq!(found(&pool, &room, "from:bob").await, vec![line(oct30, 3), line(oct29, 1)], "a nick as typed, asked for in lower case");
        assert_eq!(found(&pool, &room, &format!("from:{ann_name}")).await, vec![line(oct30, 14), line(oct30, 0), line(oct29, 0)], "an account's lines");
        assert_eq!(found(&pool, &room, &format!("from:{ann_name} has:video")).await, vec![line(oct30, 14)]);
        assert_eq!(found(&pool, &room, "from:bob has:link").await, vec![line(oct29, 1)]);
        assert_eq!(found(&pool, &room, "before:2026-10-30").await, vec![line(oct29, 1), line(oct29, 0)]);
        assert_eq!(found(&pool, &room, "after:2026-10-29").await.len(), 15, "after a day is from the next day on");
        assert_eq!(found(&pool, &room, "after:2026-10-29 before:2026-10-30").await, Vec::<String>::new());

        let dee_name = format!("dee7-{run}");
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(ann).bind(&dee_name).execute(&pool).await.unwrap();
        assert_eq!(found(&pool, &room, &format!("from:{dee_name}")).await, vec![line(oct30, 14), line(oct30, 0), line(oct29, 0)]);
    }
}
