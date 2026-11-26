use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{self, Account, Me};
use crate::chat::{audio_id, audio_of, clean_text, picture_ids, split_pictures, video_id, Audio, AudioRefusal, Video, MAX_TEXT_CHARS, NOT_YOUR_PICTURE, NOT_YOUR_VIDEO, NO_SUCH_LINE};
use crate::media::{self, Kind, Place, Refusal};
use crate::history::{self, Bind, Search};
use crate::presence::{self, Presence};
use crate::{chat_videos, emotes, follows, notify, reactions};
use crate::{ApiError, ApiResult, AppState, Name};

const PAGE: i64 = 50;
const SEARCH_LIMIT: i64 = 50;
const THREADS: i64 = 100;
const RATE_PER_MINUTE: i64 = 60;
const RATE_WINDOW_SECS: i64 = 60;

pub(crate) const NOT_FRIENDS: &str = "not friends. a chat is with someone you follow who follows you back";

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

pub(crate) async fn peer(db: &PgPool, me: &Account, name: String) -> Result<Account, ApiError> {
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

struct LineRow {
    id: i64,
    from: String,
    text: String,
    at: i64,
    image: Option<String>,
    reply_to: Option<i64>,
    quote_from: Option<String>,
    quote_text: Option<String>,
    quote_avatar: Option<i64>,
    quote_image: Option<String>,
    reactions: Value,
    video: Option<String>,
    quote_video: Option<String>,
    mentions: Vec<String>,
    audio: Option<String>,
    quote_audio: Option<String>,
    call: Option<Value>,
}

impl<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> for LineRow {
    fn from_row(row: &'r sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(LineRow {
            id: row.try_get(0)?,
            from: row.try_get(1)?,
            text: row.try_get(2)?,
            at: row.try_get(3)?,
            image: row.try_get(4)?,
            reply_to: row.try_get(5)?,
            quote_from: row.try_get(6)?,
            quote_text: row.try_get(7)?,
            quote_avatar: row.try_get(8)?,
            quote_image: row.try_get(9)?,
            reactions: row.try_get(10)?,
            video: row.try_get(11)?,
            quote_video: row.try_get(12)?,
            mentions: row.try_get(13)?,
            audio: row.try_get(14)?,
            quote_audio: row.try_get(15)?,
            call: row.try_get(16)?,
        })
    }
}

const LINE_SELECT: &str = concat!(
    "SELECT d.id, f.name, d.text, (EXTRACT(EPOCH FROM d.sent_at) * 1000)::bigint, d.image,
                d.reply_to, qf.name, left(q.text, 120), (EXTRACT(EPOCH FROM qf.avatar_at))::bigint, q.image, ",
    reactions::dm_reactions_sql!(),
    ", d.video, q.video, d.mentions, d.audio, q.audio, d.call
         FROM dms d JOIN streamers f ON f.id = d.from_id
         LEFT JOIN dms q ON q.id = d.reply_to
             AND LEAST(q.from_id, q.to_id) = LEAST(d.from_id, d.to_id) AND GREATEST(q.from_id, q.to_id) = GREATEST(d.from_id, d.to_id)
         LEFT JOIN streamers qf ON qf.id = q.from_id"
);

fn line_json(LineRow { id, from, text, at, image, reply_to, quote_from, quote_text, quote_avatar, quote_image, reactions, video, quote_video, mentions, audio, quote_audio, call }: &LineRow) -> Value {
    let reply = reply_to.map(|reply_to| match quote_from {
        Some(quote_from) => quote_json(&(reply_to, quote_from.clone(), quote_text.clone().unwrap_or_default(), *quote_avatar, quote_image.clone(), quote_video.clone(), quote_audio.clone())),
        None => json!({ "id": reply_to, "gone": true }),
    });
    let mut line = json!({ "id": id, "from": from, "text": text, "at": at, "images": split_pictures(image.clone()), "reply": reply, "reactions": reactions });
    if let Some(video) = Video::parse(video.as_deref()) {
        line["video"] = json!(video);
    }
    if let Some(audio) = Audio::parse(audio.as_deref()) {
        line["audio"] = json!(audio);
    }
    if !mentions.is_empty() {
        line["mentions"] = json!(mentions);
    }
    if let Some(call) = call {
        line["call"] = call.clone();
    }
    line
}

type QuoteRow = (i64, String, String, Option<i64>, Option<String>, Option<String>, Option<String>);

fn quote_json((id, from, text, avatar, image, video, audio): &QuoteRow) -> Value {
    let mut quote = json!({ "id": id, "from": from, "text": text, "verified": true, "avatar": avatar, "images": split_pictures(image.clone()).len() });
    if video.is_some() {
        quote["video"] = json!(true);
    }
    if audio.is_some() {
        quote["audio"] = json!(true);
    }
    quote
}

async fn quote(db: &PgPool, a: Uuid, b: Uuid, id: i64) -> Result<Option<QuoteRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT q.id, f.name, left(q.text, 120), (EXTRACT(EPOCH FROM f.avatar_at))::bigint, q.image, q.video, q.audio
         FROM dms q JOIN streamers f ON f.id = q.from_id
         WHERE q.id = $3 AND LEAST(q.from_id, q.to_id) = LEAST($1, $2) AND GREATEST(q.from_id, q.to_id) = GREATEST($1, $2)",
    )
    .bind(a)
    .bind(b)
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn pictures_exist(db: &PgPool, ids: &[String], who: Uuid) -> Result<(), ApiError> {
    for id in ids {
        match media::check(db, Kind::Image, id, Some(who)).await? {
            Ok(()) => {}
            Err(Refusal::Missing) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such picture")),
            Err(Refusal::NotYours) => return Err(ApiError::new(StatusCode::BAD_REQUEST, NOT_YOUR_PICTURE)),
        }
    }
    Ok(())
}

#[derive(Deserialize, Default)]
struct BeforeQuery {
    before: Option<i64>,
}

async fn thread(State(s): State<AppState>, Name(name): Name, Me(me): Me, q: Result<Query<BeforeQuery>, QueryRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Query(q) = q?;
    let other = peer(&s.db, &me, name).await?;
    let sql = format!(
        "{LINE_SELECT}
         WHERE LEAST(d.from_id, d.to_id) = LEAST($1, $2) AND GREATEST(d.from_id, d.to_id) = GREATEST($1, $2)
           AND ($3::bigint IS NULL OR d.id < $3)
         ORDER BY d.id DESC
         LIMIT $4"
    );
    let mut rows: Vec<LineRow> = sqlx::query_as(&sql).bind(me.id).bind(other.id).bind(q.before).bind(PAGE).fetch_all(&s.db).await?;
    rows.reverse();
    let friends = follows::friends(&s.db, me.id, other.id).await?;
    Ok(Json(json!({ "name": other.name, "friends": friends, "lines": rows.iter().map(line_json).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(State(s): State<AppState>, Name(name): Name, Me(me): Me, q: Result<Query<SearchQuery>, QueryRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Query(q) = q?;
    let search = history::read_search(&q.q)?;
    if search.channel.is_some() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "channel: is for a group's chat"));
    }
    let other = peer(&s.db, &me, name).await?;
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

fn search_sql(search: &Search, from: Option<Uuid>) -> (String, Vec<Bind>) {
    let mut binds: Vec<Bind> = Vec::new();
    let mut clauses: Vec<String> = Vec::new();
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
    if search.link {
        let link = placeholder(Bind::Text(history::LINK.to_owned()));
        clauses.push(format!("d.text ~* {link}"));
    }
    if search.video {
        let link = placeholder(Bind::Text(history::LINK.to_owned()));
        let hosts = placeholder(Bind::Text(history::VIDEO_LINK.to_owned()));
        clauses.push(format!("(d.video IS NOT NULL OR (d.text ~* {link} AND d.text ~* {hosts}))"));
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
    let mut sql = format!(
        "{LINE_SELECT}
         WHERE LEAST(d.from_id, d.to_id) = LEAST($1, $2) AND GREATEST(d.from_id, d.to_id) = GREATEST($1, $2)"
    );
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
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    video: Option<String>,
    #[serde(default)]
    audio: Option<String>,
    #[serde(default)]
    reply: Option<i64>,
}

async fn send(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Json<TextBody>, JsonRejection>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let text = clean_text(&body.text);
    let images = picture_ids(body.image, body.images).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    let video = video_id(body.video).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    let audio = audio_id(body.audio).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    if text.is_empty() && images.is_empty() && video.is_none() && audio.is_none() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "nothing to say"));
    }
    if emotes::shown_chars(&text) > MAX_TEXT_CHARS || text.chars().count() > emotes::max_raw_chars(MAX_TEXT_CHARS) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "too long"));
    }
    let other = peer(&s.db, &me, name).await?;
    if !follows::friends(&s.db, me.id, other.id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NOT_FRIENDS));
    }
    crate::auth::limit(&s, &format!("rl:dm:name:{}", me.name), RATE_WINDOW_SECS, RATE_PER_MINUTE, "slow down").await?;
    let text = emotes::settle(&s.db, Some(me.id), &text).await;
    let mentions = crate::mentions::resolve(&s.db, &text).await;
    pictures_exist(&s.db, &images, me.id).await?;
    let video = match video {
        Some(id) => {
            match media::check(&s.db, Kind::Video, &id, Some(me.id)).await? {
                Ok(()) => {}
                Err(Refusal::Missing) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such video")),
                Err(Refusal::NotYours) => return Err(ApiError::new(StatusCode::BAD_REQUEST, NOT_YOUR_VIDEO)),
            }
            match chat_videos::poster_of(&s.db, &id).await? {
                Some(poster) => Some(Video { id, poster: poster.to_string() }),
                None => return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such video")),
            }
        }
        None => None,
    };
    let audio = match audio_of(&s.db, audio.as_deref(), Some(me.id)).await {
        Ok(audio) => audio,
        Err(AudioRefusal::Words(words)) => return Err(ApiError::new(StatusCode::BAD_REQUEST, words)),
        Err(AudioRefusal::Db(e)) => return Err(e.into()),
    };
    {
        let mut all: Vec<&str> = images.iter().map(String::as_str).collect();
        if let Some(video) = &video {
            all.push(&video.poster);
        }
        if let Err(why) = crate::moderate::may_post(&s.db, &all, crate::moderate::PlaceKind::Dm).await? {
            return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, why));
        }
    }
    let reply = match body.reply {
        Some(id) => Some(quote(&s.db, me.id, other.id, id).await?.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, NO_SUCH_LINE))?),
        None => None,
    };
    let reply = reply.as_ref().map(quote_json);
    crate::chat::mark_posted(&s.db, &Place::dm(me.id, other.id), &images, video.as_ref(), audio.as_ref()).await?;
    let image = if images.is_empty() { None } else { Some(images.join(",")) };
    let (id, at) = insert(&s.db, me.id, other.id, &text, image.as_deref(), body.reply, (video.as_ref(), audio.as_ref()), &mentions).await?;
    mark_read(&s.db, me.id, other.id, id).await?;
    notify::messaged(&s, &other, &me, &text).await;
    let mut r = s.redis.clone();
    presence::publish_dm(&mut r, &me.name, &other.name, id, &text, &images, (video.as_ref(), audio.as_ref()), at, &me.id.to_string(), reply.as_ref(), &mentions, None).await;
    log::info!(
        "{}: dm to {} ({} chars, {} pictures{}{})",
        me.name,
        other.name,
        text.chars().count(),
        images.len(),
        if video.is_some() { ", a video" } else { "" },
        if audio.is_some() { ", a voice message" } else { "" }
    );
    let mut line = json!({ "id": id, "from": me.name, "to": other.name, "text": text, "at": at, "images": images, "reply": reply });
    if let Some(video) = &video {
        line["video"] = json!(video);
    }
    if let Some(audio) = &audio {
        line["audio"] = json!(audio);
    }
    if !mentions.is_empty() {
        line["mentions"] = json!(mentions);
    }
    Ok((StatusCode::CREATED, Json(line)))
}

#[allow(clippy::too_many_arguments)]
async fn insert(db: &PgPool, from: Uuid, to: Uuid, text: &str, image: Option<&str>, reply: Option<i64>, (video, audio): (Option<&Video>, Option<&Audio>), mentions: &[String]) -> Result<(i64, i64), sqlx::Error> {
    sqlx::query_as(
        "INSERT INTO dms (from_id, to_id, text, image, reply_to, video, mentions, audio) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, (EXTRACT(EPOCH FROM sent_at) * 1000)::bigint",
    )
    .bind(from)
    .bind(to)
    .bind(text)
    .bind(image)
    .bind(reply)
    .bind(video.map(Video::stored))
    .bind(mentions)
    .bind(audio.map(Audio::stored))
    .fetch_one(db)
    .await
}

pub(crate) async fn call_line(s: &AppState, caller: &Account, callee: &Account, text: &str, call: &Value) -> Result<(), ApiError> {
    let (id, at): (i64, i64) = sqlx::query_as(
        "INSERT INTO dms (from_id, to_id, text, call) VALUES ($1, $2, $3, $4)
         RETURNING id, (EXTRACT(EPOCH FROM sent_at) * 1000)::bigint",
    )
    .bind(caller.id)
    .bind(callee.id)
    .bind(text)
    .bind(call)
    .fetch_one(&s.db)
    .await?;
    mark_read(&s.db, caller.id, callee.id, id).await?;
    let mut r = s.redis.clone();
    presence::publish_dm(&mut r, &caller.name, &callee.name, id, text, &[], (None, None), at, &caller.id.to_string(), None, &[], Some(call)).await;
    Ok(())
}

#[derive(Deserialize)]
struct ReactBody {
    id: i64,
    emoji: String,
    on: bool,
}

const REACT_PER_MINUTE: i64 = 120;

async fn react(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Result<Json<ReactBody>, JsonRejection>) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let Some(emoji) = reactions::shaped(&body.emoji) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, reactions::NOT_A_REACTION));
    };
    let other = peer(&s.db, &me, name).await?;
    if !follows::friends(&s.db, me.id, other.id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NOT_FRIENDS));
    }
    crate::auth::limit(&s, &format!("rl:dmreact:name:{}", me.name), RATE_WINDOW_SECS, REACT_PER_MINUTE, "slow down").await?;
    if quote(&s.db, me.id, other.id, body.id).await?.is_none() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, NO_SUCH_LINE));
    }
    if body.on && !reactions::may_put(&s.db, me.id, &emoji).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, reactions::NOT_YOURS));
    }
    match reactions::set_dm(&s.db, body.id, me.id, &emoji, body.on).await? {
        reactions::Set::Changed => {
            let mut r = s.redis.clone();
            presence::publish_dm_react(&mut r, &me.name, &other.name, body.id, &emoji, body.on).await;
        }
        reactions::Set::Same => {}
        reactions::Set::TooMany => return Err(ApiError::new(StatusCode::BAD_REQUEST, reactions::TOO_MANY)),
    }
    let now: Value = sqlx::query_scalar(concat!("SELECT ", reactions::dm_reactions_sql!(), " FROM dms d WHERE d.id = $1"))
        .bind(body.id)
        .fetch_one(&s.db)
        .await?;
    Ok(Json(json!({ "id": body.id, "reactions": now })))
}

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
    if moved {
        notify::dm_read(db, reader, peer).await?;
    }
    Ok(moved)
}

#[derive(Deserialize)]
struct IdBody {
    id: i64,
}

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

type ThreadRow = (Uuid, String, bool, Option<i64>, String, String, i64, String, String, i64, i64, Option<String>, Option<String>, Vec<String>, Option<String>);

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
                d.image, d.video, d.mentions, d.audio
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
    let out = rows.iter().map(|(peer, name, verified, avatar, bio, _, id, from, text, at, unread, image, video, mentions, audio)| {
        let (live, word) = words.get(name).copied().unwrap_or((false, Presence::Offline));
        let mut last = json!({ "id": id, "from": from, "text": text, "at": at, "images": split_pictures(image.clone()), "video": Video::parse(video.as_deref()), "audio": Audio::parse(audio.as_deref()) });
        if !mentions.is_empty() {
            last["mentions"] = json!(mentions);
        }
        json!({
            "id": peer.to_string(),
            "name": name, "verified": verified, "avatar": avatar, "bio": bio, "live": live, "presence": word,
            "last": last, "unread": unread,
        })
    });
    Ok(Json(Value::Array(out.collect())))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/dms", get(list))
        .route("/api/dm/{name}", get(thread).post(send))
        .route("/api/dm/{name}/read", put(read))
        .route("/api/dm/{name}/react", put(react))
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
        assert!(sql.contains("(d.video IS NOT NULL OR (d.text ~* $5 AND d.text ~* $6))"), "an uploaded video, or a link first, then a video link: {sql}");
        assert!(sql.contains("d.sent_at < $7"));
        assert!(sql.ends_with("ORDER BY d.id DESC LIMIT $8"));
        assert_eq!(binds.len(), 5);
        assert!(matches!(&binds[0], Bind::Text(w) if w == "hello"));
        assert!(matches!(&binds[1], Bind::Id(i) if *i == id));
        assert!(matches!(&binds[2], Bind::Text(re) if re == history::LINK));
        assert!(matches!(&binds[3], Bind::Text(re) if re == history::VIDEO_LINK));
        assert!(matches!(&binds[4], Bind::At(at) if *at == utc("2026-10-30")));

        let s = history::parse_search("has:image").unwrap();
        let (sql, binds) = search_sql(&s, None);
        assert!(sql.contains("AND d.image IS NOT NULL ORDER BY d.id DESC LIMIT $3"));
        assert!(binds.is_empty());
        let s = history::parse_search("hi there after:2026-10-01").unwrap();
        let (sql, binds) = search_sql(&s, None);
        assert!(sql.contains("d.sent_at >= $4") && sql.ends_with("LIMIT $5"));
        assert_eq!(binds.len(), 2);
    }

    #[tokio::test]
    #[ignore]
    async fn a_dms_mentions_are_kept_and_read_back_in_the_thread() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let p = format!("mq{}-", std::process::id());
        let me = row(&pool, &format!("{p}c"), Some("h")).await;
        let friend = row(&pool, &format!("{p}f"), Some("h")).await;
        let text = format!("look @{p}F and @{p}nobody");
        let mentions = crate::mentions::resolve(&pool, &text).await;
        assert_eq!(mentions, vec![format!("{p}f")]);
        let (named, _) = insert(&pool, me, friend, &text, None, None, (None, None), &mentions).await.unwrap();
        let (plain, _) = insert(&pool, me, friend, "no one", None, None, (None, None), &[]).await.unwrap();
        let kept: Vec<String> = sqlx::query_scalar("SELECT mentions FROM dms WHERE id = $1").bind(named).fetch_one(&pool).await.unwrap();
        assert_eq!(kept, mentions);
        let sql = format!("{LINE_SELECT} WHERE d.id = ANY($1) ORDER BY d.id");
        let rows: Vec<LineRow> = sqlx::query_as(&sql).bind(vec![named, plain]).fetch_all(&pool).await.unwrap();
        let lines: Vec<Value> = rows.iter().map(line_json).collect();
        assert_eq!(lines[0]["text"], text.as_str(), "the text is kept as said");
        assert_eq!(lines[0]["mentions"], json!([format!("{p}f")]));
        assert!(lines[1].get("mentions").is_none());
        sqlx::query("DELETE FROM streamers WHERE id = ANY($1)").bind(vec![me, friend]).execute(&pool).await.unwrap();
    }
}
