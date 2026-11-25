use std::io::Cursor;
use std::time::{Duration, Instant};

use axum::extract::multipart::MultipartError;
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Me;
use crate::group_mod::{self, EMOTES};
use crate::s3;
use crate::{ApiError, ApiResult, AppState};

pub(crate) const MAX_PER_GROUP: i64 = 50;
const MAX_BYTES: usize = 512 * 1024;
const FORM_SLACK: usize = 16 * 1024;
pub(crate) const SIDE: u32 = 128;
const MAX_SOURCE_SIDE: u32 = 4096;
const RATE_PER_WINDOW: i64 = 30;
const RATE_WINDOW_SECS: i64 = 3600;
const LOOKUP_MAX: usize = 100;
const NAME_MIN: usize = 2;
const NAME_MAX: usize = 32;

const NAME_RULE: &str = "an emote name is 2 to 32 of a-z 0-9 _";
const NOT_A_PICTURE: &str = "not a picture. png, jpeg or webp";
const TOO_BIG: &str = "picture too big. 512 kb at most";
const TAKEN: &str = "that name is taken in this group";
const FULL: &str = "this group has 50 emotes already";
const NO_SUCH_EMOTE: &str = "no such emote";
const NO_PICTURE: &str = "no picture";
const NOT_SAVED: &str = "could not save the picture";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/groups/{group}/emotes", get(list).post(upload).layer(DefaultBodyLimit::max(MAX_BYTES + FORM_SLACK)))
        .route("/api/groups/{group}/emotes/{id}", patch(rename).delete(remove))
        .route("/api/emotes", get(lookup).layer(axum::middleware::map_response(crate::media::public_cache(crate::media::EMOTE_LOOKUP_CACHE))))
        .route("/api/emotes/mine", get(mine))
        .route("/api/emotes/{id}", get(picture))
}

fn name_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
}

pub(crate) fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if valid_name(&name) {
        Ok(name)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, NAME_RULE))
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    (NAME_MIN..=NAME_MAX).contains(&name.len()) && name.chars().all(name_char)
}

#[derive(Debug, PartialEq)]
pub(crate) struct Token<'a> {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) name: &'a str,
    pub(crate) id: Uuid,
}

pub(crate) fn tokens(text: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("<:") {
        let start = from + at;
        let rest = &text[start + 2..];
        let name_len = rest.find(|c: char| !name_char(c)).unwrap_or(rest.len());
        let name = &rest[..name_len];
        let after = &rest[name_len..];
        let id = after
            .strip_prefix(':')
            .filter(|tail| tail.len() >= 37 && tail.is_char_boundary(36) && tail.as_bytes()[36] == b'>')
            .and_then(|tail| Uuid::try_parse(&tail[..36]).ok());
        match id {
            Some(id) if valid_name(name) => {
                let end = start + 2 + name_len + 1 + 36 + 1;
                out.push(Token { start, end, name, id });
                from = end;
            }
            _ => from = start + 2,
        }
    }
    out
}

pub(crate) fn shown_chars(text: &str) -> usize {
    let mut n = text.chars().count();
    for t in tokens(text) {
        n = n - (t.end - t.start) + t.name.len() + 2;
    }
    n
}

pub(crate) fn max_raw_chars(shown_max: usize) -> usize {
    shown_max / 4 * 42 + shown_max % 4
}

pub(crate) async fn settle(db: &PgPool, user: Option<Uuid>, text: &str) -> String {
    let found = tokens(text);
    if found.is_empty() {
        return text.to_owned();
    }
    let usable: Vec<(Uuid, String)> = match user {
        Some(user) => {
            let ids: Vec<Uuid> = found.iter().map(|t| t.id).collect();
            match usable_of(db, user, &ids).await {
                Ok(rows) => rows,
                Err(e) => {
                    log::warn!("cannot check the emotes of a line: {e}");
                    Vec::new()
                }
            }
        }
        None => Vec::new(),
    };
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for t in found {
        out.push_str(&text[at..t.start]);
        match usable.iter().find(|(id, _)| *id == t.id) {
            Some((id, name)) => out.push_str(&format!("<:{name}:{id}>")),
            None => out.push_str(&format!(":{}:", t.name)),
        }
        at = t.end;
    }
    out.push_str(&text[at..]);
    out
}

async fn usable_of(db: &PgPool, user: Uuid, ids: &[Uuid]) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
    sqlx::query_as(
        "SELECT e.id, e.name FROM group_emotes e
         JOIN memberships m ON m.group_name = e.group_name AND m.user_id = $1
         WHERE e.id = ANY($2)",
    )
    .bind(user)
    .bind(ids)
    .fetch_all(db)
    .await
}

pub(crate) async fn usable(db: &PgPool, user: Uuid, id: Uuid) -> Result<bool, sqlx::Error> {
    Ok(!usable_of(db, user, &[id]).await?.is_empty())
}

pub(crate) fn redraw(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| NOT_A_PICTURE)?;
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)) {
        return Err(NOT_A_PICTURE);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_SIDE);
    limits.max_image_height = Some(MAX_SOURCE_SIDE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| NOT_A_PICTURE)?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(NOT_A_PICTURE);
    }
    let side = w.min(h);
    let square = img.crop_imm((w - side) / 2, (h - side) / 2, side, side);
    let drawn = square.resize_exact(SIDE, SIDE, FilterType::Lanczos3).to_rgba8();
    let mut out = Vec::new();
    WebPEncoder::new_lossless(&mut out).encode(drawn.as_raw(), SIDE, SIDE, ExtendedColorType::Rgba8).map_err(|_| NOT_A_PICTURE)?;
    Ok(out)
}

async fn screen(s: &AppState, who: &crate::auth::Account, headers: &HeaderMap, webp: &[u8], sha: &str) -> Result<crate::moderate::Passed, ApiError> {
    let ip = crate::ratelimit::forwarded_ip(headers);
    crate::moderate::check(s, crate::moderate::Upload { kind: crate::moderate::UploadKind::Emote, who: Some(who.id), ip: ip.as_deref(), mime: "image/webp", key: None, sha: Some(sha) }, webp).await
}

fn key_of(group: &str, id: Uuid) -> String {
    format!("emotes/{group}/{id}.webp")
}

fn too_big(len: usize) -> bool {
    len > MAX_BYTES
}

fn full(count: i64) -> bool {
    count >= MAX_PER_GROUP
}

pub(crate) fn refusal(status: StatusCode, message: &str) -> &'static str {
    match message {
        NAME_RULE => "bad name",
        NOT_A_PICTURE | NO_PICTURE => "not a picture",
        TOO_BIG => "too big",
        TAKEN => "name taken",
        FULL => "group full",
        NOT_SAVED => "storage failure",
        crate::moderate::REJECTED | crate::moderate::ANIMATED => "moderation refused",
        crate::moderate::IMAGE_CHECKS_DOWN => "moderation down",
        _ => match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "forbidden",
            StatusCode::PAYLOAD_TOO_LARGE => "too big",
            StatusCode::TOO_MANY_REQUESTS => "rate limited",
            StatusCode::NOT_FOUND => "no such group",
            StatusCode::UNPROCESSABLE_ENTITY => "moderation refused",
            s if s.is_server_error() => "server error",
            _ => "bad form",
        },
    }
}

fn tally(action: &str, what: &str, took: Duration, status: StatusCode) {
    crate::timings::record("emote", action, what, took, crate::timings::outcome(status.as_u16()));
}

fn login() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

async fn need_manager(s: &AppState, who: Uuid, group: &str) -> Result<(), ApiError> {
    manager_gate(group_mod::allows(s, who, group, EMOTES).await?)
}

fn manager_gate(allowed: bool) -> Result<(), ApiError> {
    if allowed {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, "you can't manage the emotes here"))
    }
}

fn is_admin(s: &AppState, who: Uuid) -> bool {
    s.admins.iter().any(|a| a.id == who)
}

type EmoteRow = (Uuid, String, Option<String>, i64);

fn emote_json((id, name, by, at): &EmoteRow) -> Value {
    json!({ "id": id, "name": name, "by": by, "at": at })
}

const EMOTE_SELECT: &str = "SELECT e.id, e.name, s.name, (EXTRACT(EPOCH FROM e.created_at))::bigint
     FROM group_emotes e LEFT JOIN streamers s ON s.id = e.created_by";

async fn one(db: &PgPool, group: &str, id: Uuid) -> Result<EmoteRow, ApiError> {
    let row: Option<EmoteRow> = sqlx::query_as(&format!("{EMOTE_SELECT} WHERE e.group_name = $1 AND e.id = $2"))
        .bind(group)
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, NO_SUCH_EMOTE))
}

fn emote_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::try_parse(raw.trim()).map_err(|_| ApiError::new(StatusCode::NOT_FOUND, NO_SUCH_EMOTE))
}

async fn list(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = group_mod::server(&s.db, &group).await?;
    if !crate::groups::member(&s.db, who.id, &group).await? && !is_admin(&s, who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the group first"));
    }
    let rows: Vec<EmoteRow> = sqlx::query_as(&format!("{EMOTE_SELECT} WHERE e.group_name = $1 ORDER BY e.created_at, e.name"))
        .bind(&group)
        .fetch_all(&s.db)
        .await?;
    let manage = group_mod::allows(&s, who.id, &group, EMOTES).await?;
    Ok(Json(json!({ "emotes": rows.iter().map(emote_json).collect::<Vec<_>>(), "max": MAX_PER_GROUP, "manage": manage })))
}

fn form_error(e: MultipartError) -> ApiError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, TOO_BIG)
    } else {
        ApiError::new(StatusCode::BAD_REQUEST, "bad form")
    }
}

async fn upload(State(s): State<AppState>, Path(group): Path<String>, me: Me, headers: HeaderMap, form: Multipart) -> Result<(StatusCode, Json<Value>), ApiError> {
    let started = Instant::now();
    let done = take(&s, &group, me, &headers, form).await;
    match &done {
        Ok((status, _)) => tally("upload", "accepted", started.elapsed(), *status),
        Err(e) => tally("upload", refusal(e.status(), e.message()), started.elapsed(), e.status()),
    }
    done
}

async fn take(s: &AppState, group: &str, Me(me): Me, headers: &HeaderMap, mut form: Multipart) -> Result<(StatusCode, Json<Value>), ApiError> {
    let who = me.ok_or_else(login)?;
    let group = group_mod::server(&s.db, group).await?;
    need_manager(&s, who.id, &group).await?;
    let mut name: Option<String> = None;
    let mut bytes: Option<Vec<u8>> = None;
    while let Some(field) = form.next_field().await.map_err(form_error)? {
        match field.name() {
            Some("name") => name = Some(field.text().await.map_err(form_error)?),
            Some("image") => {
                let got = field.bytes().await.map_err(form_error)?;
                if too_big(got.len()) {
                    return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, TOO_BIG));
                }
                bytes = Some(got.to_vec());
            }
            _ => {}
        }
    }
    let name = clean_name(name.as_deref().unwrap_or(""))?;
    let Some(bytes) = bytes.filter(|b| !b.is_empty()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, NO_PICTURE));
    };
    crate::auth::limit(&s, &format!("rl:emote:{}", who.id), RATE_WINDOW_SECS, RATE_PER_WINDOW, "slow down: too many emotes this hour").await?;
    let webp = tokio::task::spawn_blocking(move || redraw(&bytes))
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not read the picture"))?
        .map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    let sha = crate::media::sha256_hex(&webp);
    let looked = screen(&s, &who, headers, &webp, &sha).await?;
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(7311, hashtext($1))").bind(&group).execute(&mut *tx).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM group_emotes WHERE group_name = $1").bind(&group).fetch_one(&mut *tx).await?;
    if full(count) {
        return Err(ApiError::new(StatusCode::CONFLICT, FULL));
    }
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO group_emotes (group_name, name, key, created_by, sha256, uploader_ip) VALUES ($1, $2, '', $3, $4, $5)
         ON CONFLICT (group_name, name) DO NOTHING RETURNING id",
    )
    .bind(&group)
    .bind(&name)
    .bind(who.id)
    .bind(&sha)
    .bind(crate::ratelimit::forwarded_ip(headers))
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else { return Err(ApiError::new(StatusCode::CONFLICT, TAKEN)) };
    let key = key_of(&group, id);
    sqlx::query("UPDATE group_emotes SET key = $2 WHERE id = $1").bind(id).bind(&key).execute(&mut *tx).await?;
    tx.commit().await?;
    if let Err(e) = s3::put(&s.s3, &key, &webp, "image/webp").await {
        let _ = sqlx::query("DELETE FROM group_emotes WHERE id = $1").bind(id).execute(&s.db).await;
        log::error!("s3 emote {group}/{name}: {e}");
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, NOT_SAVED));
    }
    crate::moderate::set_key(&s.db, looked.row, &key).await;
    log::info!("{}: new emote :{name}: in {group}, {} bytes", who.name, webp.len());
    let row = one(&s.db, &group, id).await?;
    Ok((StatusCode::CREATED, Json(emote_json(&row))))
}

#[derive(Deserialize)]
struct NameIn {
    name: String,
}

async fn rename(State(s): State<AppState>, Path((group, id)): Path<(String, String)>, Me(me): Me, body: Result<Json<NameIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = group_mod::server(&s.db, &group).await?;
    need_manager(&s, who.id, &group).await?;
    let id = emote_id(&id)?;
    let name = clean_name(&body.name)?;
    let done = sqlx::query("UPDATE group_emotes SET name = $3 WHERE group_name = $1 AND id = $2").bind(&group).bind(id).bind(&name).execute(&s.db).await;
    match done {
        Ok(r) if r.rows_affected() == 0 => return Err(ApiError::new(StatusCode::NOT_FOUND, NO_SUCH_EMOTE)),
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(ApiError::new(StatusCode::CONFLICT, TAKEN)),
        Err(e) => return Err(e.into()),
    }
    log::info!("{}: renamed emote {id} in {group} to :{name}:", who.name);
    Ok(Json(emote_json(&one(&s.db, &group, id).await?)))
}

async fn remove(State(s): State<AppState>, Path((group, id)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let started = Instant::now();
    let who = me.ok_or_else(login)?;
    let group = group_mod::server(&s.db, &group).await?;
    need_manager(&s, who.id, &group).await?;
    let id = emote_id(&id)?;
    let key: Option<String> = sqlx::query_scalar("DELETE FROM group_emotes WHERE group_name = $1 AND id = $2 RETURNING key").bind(&group).bind(id).fetch_optional(&s.db).await?;
    let Some(key) = key else { return Err(ApiError::new(StatusCode::NOT_FOUND, NO_SUCH_EMOTE)) };
    crate::reactions::drop_emote(&s.db, id).await?;
    if let Err(e) = s3::delete(&s.s3, &key).await {
        log::warn!("s3 emote {key}: {e}");
    }
    crate::cf_purge::purge(vec![format!("/api/emotes/{id}")]);
    log::info!("{}: deleted emote {id} from {group}", who.name);
    tally("delete", "deleted", started.elapsed(), StatusCode::NO_CONTENT);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn drop_group(s: &AppState, group: &str) {
    let rows: Vec<(Uuid, String)> = match sqlx::query_as("SELECT id, key FROM group_emotes WHERE group_name = $1").bind(group).fetch_all(&s.db).await {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("emotes of {group}: {e}");
            return;
        }
    };
    for (_, key) in &rows {
        let started = Instant::now();
        let _ = s3::delete(&s.s3, key).await;
        tally("delete", "group deleted", started.elapsed(), StatusCode::NO_CONTENT);
    }
    crate::cf_purge::purge(rows.iter().map(|(id, _)| format!("/api/emotes/{id}")).collect());
}

pub(crate) async fn total(db: &PgPool) -> Option<i64> {
    sqlx::query_scalar("SELECT count(*) FROM group_emotes").fetch_one(db).await.ok()
}

async fn mine(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let Some(who) = me else { return Ok(Json(json!({ "emotes": [] }))) };
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT e.id, e.name, e.group_name FROM group_emotes e
         JOIN memberships m ON m.group_name = e.group_name AND m.user_id = $1
         ORDER BY e.group_name, e.name",
    )
    .bind(who.id)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(json!({ "emotes": rows.iter().map(|(id, name, group)| json!({ "id": id, "name": name, "group": group })).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
struct LookupQuery {
    #[serde(default)]
    ids: String,
}

async fn lookup(State(s): State<AppState>, Query(q): Query<LookupQuery>) -> ApiResult {
    let ids: Vec<Uuid> = q.ids.split(',').filter_map(|raw| Uuid::try_parse(raw.trim()).ok()).take(LOOKUP_MAX).collect();
    if ids.is_empty() {
        return Ok(Json(json!({ "emotes": [] })));
    }
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as("SELECT id, name, group_name FROM group_emotes WHERE id = ANY($1)").bind(&ids).fetch_all(&s.db).await?;
    Ok(Json(json!({ "emotes": rows.iter().map(|(id, name, group)| json!({ "id": id, "name": name, "group": group })).collect::<Vec<_>>() })))
}

async fn picture(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let id = emote_id(id.trim_end_matches(".webp"))?;
    let key: Option<String> = sqlx::query_scalar("SELECT key FROM group_emotes WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some(key) = key.filter(|k| !k.is_empty()) else { return Err(ApiError::new(StatusCode::NOT_FOUND, NO_SUCH_EMOTE)) };
    match s3::get(&s.s3, &key).await {
        Ok(Some(bytes)) => Ok((
            [(header::CONTENT_TYPE, "image/webp"), (header::CACHE_CONTROL, crate::media::PUBLIC_CACHE), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
            bytes,
        )
            .into_response()),
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, NO_SUCH_EMOTE)),
        Err(e) => {
            log::error!("s3 emote {id}: {e}");
            Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not load the picture"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b7c6c1e-4f0a-4c1e-9d55-6a1f5d3e2b10";

    #[test]
    fn names_follow_the_rule() {
        assert_eq!(clean_name("  PogChamp ").unwrap(), "pogchamp");
        assert_eq!(clean_name("a_1").unwrap(), "a_1");
        assert!(clean_name("x").is_err());
        assert!(clean_name(&"a".repeat(33)).is_err());
        assert!(clean_name(&"a".repeat(32)).is_ok());
        assert!(clean_name("no-dash").is_err());
        assert!(clean_name("spa ce").is_err());
        assert!(clean_name("ünï").is_err());
    }

    #[test]
    fn tokens_are_found_and_nothing_else_is() {
        let text = format!("hi <:pog:{ID}> and <:x:{ID}> <:bad-name:{ID}> <:ok_2:{}> <:open", ID.to_uppercase());
        let found = tokens(&text);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "pog");
        assert_eq!(&text[found[0].start..found[0].end], format!("<:pog:{ID}>"));
        assert_eq!(found[1].name, "ok_2");
        assert_eq!(found[1].id.to_string(), ID, "an id in capitals is the same id");
        let two = format!("<:aa:{ID}><:bb:{ID}>");
        assert_eq!(tokens(&two).len(), 2);
        assert!(tokens("<:aa:ééééééééééééééééééééééééééééééééééééé>").is_empty());
        assert!(tokens("").is_empty());
    }

    #[test]
    fn a_line_is_as_long_as_it_shows() {
        let text = format!("gg <:pog:{ID}>");
        assert_eq!(shown_chars(&text), "gg :pog:".chars().count());
        assert_eq!(shown_chars("plain"), 5);
        let worst = max_raw_chars(500);
        assert_eq!(worst, 125 * 42);
        assert!(worst < crate::socket::MAX_FRAME_BYTES - 200);
        let line = format!("<:ab:{ID}>").repeat(125);
        assert_eq!(shown_chars(&line), 500);
        assert_eq!(line.chars().count(), worst);
    }

    #[tokio::test]
    async fn a_nick_s_emotes_go_plain() {
        let db = PgPool::connect_lazy("postgres://nobody@127.0.0.1:1/none").unwrap();
        let text = format!("hey <:pog:{ID}>!");
        assert_eq!(settle(&db, None, &text).await, "hey :pog:!");
        assert_eq!(settle(&db, None, "no emotes").await, "no emotes");
    }

    #[tokio::test]
    #[ignore]
    async fn emotes_keep_their_rules() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let group = format!("emo{run}");
        let alice = row(&pool, &format!("alice-e{run}"), Some("h")).await;
        let bob = row(&pool, &format!("bob-e{run}"), Some("h")).await;
        sqlx::query("INSERT INTO groups (name, badge, color) VALUES ($1, 'EMO', '#5865f2')").bind(&group).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO memberships (name, group_name, user_id) SELECT name, $1, id FROM streamers WHERE id = $2")
            .bind(&group)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();
        let id: Uuid = sqlx::query_scalar("INSERT INTO group_emotes (group_name, name, key, created_by) VALUES ($1, 'pog', 'emotes/x.webp', $2) RETURNING id")
            .bind(&group)
            .bind(alice)
            .fetch_one(&pool)
            .await
            .unwrap();
        let twin = sqlx::query("INSERT INTO group_emotes (group_name, name, key) VALUES ($1, 'pog', 'k')").bind(&group).execute(&pool).await;
        assert!(twin.is_err(), "a name is once per group");

        let typed = format!("gg <:old:{}> wp", id.to_string().to_uppercase());
        assert_eq!(settle(&pool, Some(alice), &typed).await, format!("gg <:pog:{id}> wp"));
        assert_eq!(settle(&pool, Some(bob), &typed).await, "gg :old: wp", "bob is not in the group");
        assert!(usable(&pool, alice, id).await.unwrap());
        assert!(!usable(&pool, bob, id).await.unwrap());
        assert!(crate::reactions::may_put(&pool, alice, &id.to_string()).await.unwrap());
        assert!(!crate::reactions::may_put(&pool, bob, &id.to_string()).await.unwrap());
        assert!(crate::reactions::may_put(&pool, bob, "👍").await.unwrap());

        let room = format!("emo-{run}");
        assert_eq!(crate::reactions::set_line(&pool, &room, "1-0", alice, &id.to_string(), true).await.unwrap(), crate::reactions::Set::Changed);
        sqlx::query("DELETE FROM group_emotes WHERE id = $1").bind(id).execute(&pool).await.unwrap();
        crate::reactions::drop_emote(&pool, id).await.unwrap();
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_reactions WHERE room = $1").bind(&room).fetch_one(&pool).await.unwrap();
        assert_eq!(left, 0);
        assert_eq!(settle(&pool, Some(alice), &typed).await, "gg :old: wp");

        sqlx::query("INSERT INTO group_emotes (group_name, name, key) VALUES ($1, 'kek', 'k')").bind(&group).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&pool).await.unwrap();
        let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM group_emotes WHERE group_name = $1").bind(&group).fetch_one(&pool).await.unwrap();
        assert_eq!(kept, 0);
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, 90, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut Cursor::new(&mut out), ImageFormat::Png).unwrap();
        out
    }

    #[test]
    fn a_picture_is_drawn_again_square() {
        let webp = redraw(&png(300, 200)).unwrap();
        assert!(webp.starts_with(b"RIFF") && &webp[8..12] == b"WEBP");
        let back = image::load_from_memory_with_format(&webp, ImageFormat::WebP).unwrap();
        assert_eq!((back.width(), back.height()), (SIDE, SIDE));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::new(64, 64)).write_to(&mut Cursor::new(&mut jpeg), ImageFormat::Jpeg).unwrap();
        assert!(redraw(&jpeg).is_ok());
        assert!(redraw(&webp).is_ok(), "a webp goes through too");
    }

    #[test]
    fn a_non_picture_is_refused() {
        assert_eq!(redraw(b"GIF89a....").unwrap_err(), NOT_A_PICTURE);
        assert_eq!(redraw(b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap_err(), NOT_A_PICTURE);
        assert_eq!(redraw(b"").unwrap_err(), NOT_A_PICTURE);
        let mut cut = png(10, 10);
        cut.truncate(40);
        assert_eq!(redraw(&cut).unwrap_err(), NOT_A_PICTURE);
        assert_eq!(redraw(&png(MAX_SOURCE_SIDE + 1, 2)).unwrap_err(), NOT_A_PICTURE);
    }

    #[test]
    fn a_png_name_on_other_bytes_is_still_refused() {
        let mut fake = b"\x89PNG\r\n\x1a\n".to_vec();
        fake.extend_from_slice(&[0x42; 200]);
        assert_eq!(redraw(&fake).unwrap_err(), NOT_A_PICTURE);
        assert_eq!(redraw(b"just some text that a file called pog.png held").unwrap_err(), NOT_A_PICTURE);
        assert_eq!(redraw(&[0u8; 4096]).unwrap_err(), NOT_A_PICTURE);
        let garbage: Vec<u8> = (0..2048u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        assert_eq!(redraw(&garbage).unwrap_err(), NOT_A_PICTURE);
    }

    #[test]
    fn an_emote_lives_under_its_group() {
        let id = Uuid::try_parse(ID).unwrap();
        assert_eq!(key_of("lobby", id), format!("emotes/lobby/{ID}.webp"));
        assert_ne!(key_of("lobby", id), key_of("other", id));
        assert!(key_of("lobby", id).starts_with("emotes/lobby/"));
    }

    #[test]
    fn the_size_and_count_gates() {
        assert!(!too_big(0));
        assert!(!too_big(MAX_BYTES));
        assert!(too_big(MAX_BYTES + 1));
        assert!(!full(0));
        assert!(!full(MAX_PER_GROUP - 1));
        assert!(full(MAX_PER_GROUP));
        assert!(full(MAX_PER_GROUP + 3));
    }

    #[test]
    fn each_refusal_has_its_reason() {
        let why = |status: StatusCode, msg: &str| refusal(status, msg);
        assert_eq!(why(StatusCode::BAD_REQUEST, NOT_A_PICTURE), "not a picture");
        assert_eq!(why(StatusCode::BAD_REQUEST, NO_PICTURE), "not a picture");
        assert_eq!(why(StatusCode::PAYLOAD_TOO_LARGE, TOO_BIG), "too big");
        assert_eq!(why(StatusCode::PAYLOAD_TOO_LARGE, "whatever axum says"), "too big");
        assert_eq!(why(StatusCode::BAD_REQUEST, NAME_RULE), "bad name");
        assert_eq!(why(StatusCode::CONFLICT, TAKEN), "name taken");
        assert_eq!(why(StatusCode::CONFLICT, FULL), "group full");
        assert_eq!(why(StatusCode::TOO_MANY_REQUESTS, "slow down: too many emotes this hour"), "rate limited");
        assert_eq!(why(StatusCode::UNPROCESSABLE_ENTITY, crate::moderate::REJECTED), "moderation refused");
        assert_eq!(why(StatusCode::UNPROCESSABLE_ENTITY, crate::moderate::ANIMATED), "moderation refused");
        assert_eq!(why(StatusCode::SERVICE_UNAVAILABLE, crate::moderate::IMAGE_CHECKS_DOWN), "moderation down");
        assert_eq!(why(StatusCode::BAD_GATEWAY, NOT_SAVED), "storage failure");
        assert_eq!(why(StatusCode::FORBIDDEN, "you can't manage the emotes here"), "forbidden");
        assert_eq!(why(StatusCode::UNAUTHORIZED, "not logged in"), "forbidden");
        assert_eq!(why(StatusCode::NOT_FOUND, "no such group"), "no such group");
        assert_eq!(why(StatusCode::INTERNAL_SERVER_ERROR, "db"), "server error");
        assert_eq!(why(StatusCode::BAD_REQUEST, "bad form"), "bad form");
    }

    #[test]
    fn a_member_without_the_power_gets_403() {
        assert!(manager_gate(true).is_ok());
        let e = manager_gate(false).unwrap_err();
        assert_eq!(e.status(), StatusCode::FORBIDDEN);
        assert_eq!(refusal(e.status(), e.message()), "forbidden");
    }
}
