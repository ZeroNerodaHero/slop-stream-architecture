//! The about tab's page (docs/about.md): a json document of blocks, each `type` plus where it
//! sits (`x`, `y`, `z`) and how big it is (`w`, `h`). The bytes are in the bucket, not in the row. A picture, a clip or a
//! track goes up on its own (`PUT .../about-file`) and the document names it by id. The text
//! is html, cleaned here and cut at 10 000 characters, and that cleaned string is the object
//! the document's text block points at. The row keeps only the layout.

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, JsonRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::auth::Me;
use crate::s3;
use crate::{may_write, unique_violation, valid_name, ApiError, ApiResult, AppState, Name, PasswordQuery};

const TEXT_MAX: usize = 10_000;
const BLOCKS_MAX: usize = 40;
const POS_MAX: i32 = 1600;
const Z_MAX: i32 = 40;
/// The smallest a block can be dragged, and the largest. A missing size takes the kind's usual box.
const W_MIN: i32 = 80;
const H_MIN: i32 = 40;
const SIZE_MAX: i32 = 800;
/// A picture, the same ceiling as a scene picture.
const MAX_IMAGE: usize = 2 * 1024 * 1024;
/// A short clip on the page, not a stream.
const MAX_VIDEO: usize = 12 * 1024 * 1024;
const MAX_SOUND: usize = 8 * 1024 * 1024;
/// The document: forty texts at the cap, plus the layout.
const MAX_PAGE: usize = 2 * 1024 * 1024;
const FILE_CACHE: &str = "public, max-age=31536000, immutable";

#[derive(Deserialize)]
struct FileQuery {
    #[serde(rename = "type")]
    kind: String,
    password: Option<String>,
}

#[derive(Deserialize)]
struct PageBody {
    blocks: Vec<Incoming>,
}

#[derive(Deserialize)]
struct Incoming {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: i64,
    x: i64,
    y: i64,
    z: i64,
    #[serde(default)]
    w: i64,
    #[serde(default)]
    h: i64,
    #[serde(default)]
    html: String,
}

#[derive(Serialize)]
struct OutBlock {
    #[serde(rename = "type")]
    kind: String,
    id: i64,
    x: i32,
    y: i32,
    z: i32,
    w: i32,
    h: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
}

#[derive(Debug)]
struct Kept {
    kind: &'static str,
    id: i64,
    x: i32,
    y: i32,
    z: i32,
    w: i32,
    h: i32,
    /// Text only: the cleaned html to write. None for a picture, a clip, a track.
    html: Option<String>,
    /// True when this id is not in `about_files` yet.
    fresh: bool,
}

/// The bucket key. The row's uuid, so a rename does not move the object.
pub(crate) fn about_key(row: uuid::Uuid, id: i64, ext: &str) -> String {
    format!("about/{row}/{id}.{ext}")
}

fn file_src(name: &str, id: i64) -> String {
    format!("/api/streamers/{name}/about-file/{id}")
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/streamers/{name}/about-page", get(get_page).put(put_page).layer(DefaultBodyLimit::max(MAX_PAGE)))
        .route(
            "/api/streamers/{name}/about-file",
            put(put_file).layer(DefaultBodyLimit::max(MAX_VIDEO)),
        )
        .route("/api/streamers/{name}/about-file/{id}", get(get_file))
}

async fn get_page(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let doc: Option<Value> = sqlx::query_scalar("SELECT about_page FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    let stored = doc.and_then(|v| serde_json::from_value::<StoredPage>(v).ok()).unwrap_or_default();
    let mut blocks = Vec::with_capacity(stored.blocks.len());
    for block in stored.blocks {
        let Some(file) = file_row(&s.db, &name, block.id).await? else { continue };
        if file.kind != block.kind {
            continue;
        }
        let (w, h) = filled_size(&block.kind, block.w, block.h);
        if block.kind == "text" {
            let html = match s3::get(&s.s3, &about_key(file.row, block.id, "html")).await {
                Ok(Some(bytes)) => String::from_utf8(bytes).unwrap_or_default(),
                _ => String::new(),
            };
            blocks.push(OutBlock { kind: block.kind, id: block.id, x: block.x, y: block.y, z: block.z, w, h, html: Some(html), src: None });
        } else {
            blocks.push(OutBlock {
                kind: block.kind,
                id: block.id,
                x: block.x,
                y: block.y,
                z: block.z,
                w,
                h,
                html: None,
                src: Some(file_src(&name, block.id)),
            });
        }
    }
    Ok(Json(json!({ "blocks": blocks })))
}

async fn put_page(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<PageBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body.map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad json body"))?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    if body.blocks.len() > BLOCKS_MAX {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "40 blocks at most"));
    }
    let row = ensure_row(&s.db, &name).await?;
    let mut conn = s.db.acquire().await?;
    let lock = format!("about-page:{name}");
    sqlx::query("SELECT pg_advisory_lock(hashtext($1))").bind(&lock).execute(&mut *conn).await?;
    let result = save_page(&s, &mut conn, &name, row, body).await;
    let unlocked = sqlx::query("SELECT pg_advisory_unlock(hashtext($1))").bind(&lock).execute(&mut *conn).await;
    if let Err(e) = unlocked {
        log::warn!("postgres: about page lock for {name} stayed: {e}");
    }
    result
}

async fn save_page(
    s: &AppState,
    conn: &mut sqlx::PgConnection,
    name: &str,
    row: uuid::Uuid,
    body: PageBody,
) -> ApiResult {
    let existing: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, kind, mime FROM about_files WHERE name = $1").bind(name).fetch_all(&mut *conn).await?;
    let have: HashMap<i64, (String, String)> = existing.iter().cloned().map(|(id, kind, mime)| (id, (kind, mime))).collect();
    let kept = plan(&body, &have)?;
    let mut used = HashSet::new();
    for block in &kept {
        if block.fresh {
            sqlx::query("INSERT INTO about_files (name, id, kind, mime, bytes) VALUES ($1, $2, 'text', 'text/plain', 0)")
                .bind(name)
                .bind(block.id)
                .execute(&mut *conn)
                .await?;
        }
        if let Some(html) = &block.html {
            let bytes = html.as_bytes();
            if let Err(e) = s3::put(&s.s3, &about_key(row, block.id, "html"), bytes, "text/plain").await {
                if block.fresh {
                    let _ = sqlx::query("DELETE FROM about_files WHERE name = $1 AND id = $2")
                        .bind(name)
                        .bind(block.id)
                        .execute(&mut *conn)
                        .await;
                }
                log::error!("s3 about {name}: {e}");
                return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the text"));
            }
            sqlx::query("UPDATE about_files SET bytes = $3 WHERE name = $1 AND id = $2")
                .bind(name)
                .bind(block.id)
                .bind(bytes.len() as i32)
                .execute(&mut *conn)
                .await?;
        }
        used.insert(block.id);
    }
    let layout = StoredPage {
        blocks: kept
            .iter()
            .map(|b| StoredBlock { kind: b.kind.to_owned(), id: b.id, x: b.x, y: b.y, z: b.z, w: b.w, h: b.h })
            .collect(),
    };
    sqlx::query("UPDATE streamers SET about_page = $2, updated_at = now() WHERE name = $1")
        .bind(name)
        .bind(serde_json::to_value(&layout).unwrap_or_else(|_| json!({ "blocks": [] })))
        .execute(&mut *conn)
        .await?;
    for (id, kind, mime) in &existing {
        if used.contains(id) {
            continue;
        }
        let ext = ext_of(kind, mime);
        if let Err(e) = s3::delete(&s.s3, &about_key(row, *id, ext)).await {
            log::warn!("s3: {name}'s about file {id} is off the page, and the object stayed: {e}");
            continue;
        }
        sqlx::query("DELETE FROM about_files WHERE name = $1 AND id = $2")
            .bind(name)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    let mut out = Vec::with_capacity(kept.len());
    for block in kept {
        if block.kind == "text" {
            out.push(OutBlock { kind: block.kind.to_owned(), id: block.id, x: block.x, y: block.y, z: block.z, w: block.w, h: block.h, html: block.html, src: None });
        } else {
            out.push(OutBlock {
                kind: block.kind.to_owned(),
                id: block.id,
                x: block.x,
                y: block.y,
                z: block.z,
                w: block.w,
                h: block.h,
                html: None,
                src: Some(file_src(name, block.id)),
            });
        }
    }
    log::info!("{name}: about page, {} blocks", out.len());
    Ok(Json(json!({ "blocks": out })))
}

/// The layout as it will be kept. A text with id 0 is a new object. A picture, clip or track
/// must already be one of this name's files, and the same kind.
fn plan(body: &PageBody, have: &HashMap<i64, (String, String)>) -> Result<Vec<Kept>, ApiError> {
    let mut kept = Vec::with_capacity(body.blocks.len());
    let mut seen = HashSet::new();
    let mut reserved: HashSet<i64> = have.keys().copied().collect();
    for block in &body.blocks {
        let x = clamp_pos(block.x);
        let y = clamp_pos(block.y);
        let z = clamp_z(block.z);
        let (dw, dh) = default_size(block.kind.as_str());
        let w = clamp_size(block.w, dw, W_MIN);
        let h = clamp_size(block.h, dh, H_MIN);
        match block.kind.as_str() {
            "text" => {
                let html = sanitize_html(&block.html);
                let (id, fresh) = if block.id == 0 {
                    let id = fresh_id(&reserved);
                    reserved.insert(id);
                    (id, true)
                } else {
                    match have.get(&block.id) {
                        Some((kind, _)) if kind == "text" => (block.id, false),
                        Some(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "that file is not text")),
                        None => return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such file")),
                    }
                };
                if !seen.insert(id) {
                    return Err(ApiError::new(StatusCode::BAD_REQUEST, "a block is on the page twice"));
                }
                kept.push(Kept { kind: "text", id, x, y, z, w, h, html: Some(html), fresh });
            }
            "image" | "video" | "sound" => {
                if block.id <= 0 {
                    return Err(ApiError::new(StatusCode::BAD_REQUEST, "upload the file first"));
                }
                match have.get(&block.id) {
                    Some((kind, _)) if kind == &block.kind => {}
                    Some(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "that file is a different kind")),
                    None => return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such file")),
                }
                if !seen.insert(block.id) {
                    return Err(ApiError::new(StatusCode::BAD_REQUEST, "a block is on the page twice"));
                }
                let kind = match block.kind.as_str() {
                    "image" => "image",
                    "video" => "video",
                    _ => "sound",
                };
                kept.push(Kept { kind, id: block.id, x, y, z, w, h, html: None, fresh: false });
            }
            _ => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad type. one of text, image, video, sound")),
        }
    }
    Ok(kept)
}

fn clamp_pos(n: i64) -> i32 {
    n.clamp(0, POS_MAX as i64) as i32
}

fn clamp_z(n: i64) -> i32 {
    n.clamp(0, Z_MAX as i64) as i32
}

/// A missing size (an older page) takes the kind's usual box. A given size stays between the
/// smallest a block can be and `SIZE_MAX`.
fn clamp_size(n: i64, fallback: i32, min: i32) -> i32 {
    if n <= 0 {
        return fallback;
    }
    n.clamp(min as i64, SIZE_MAX as i64) as i32
}

fn filled_size(kind: &str, w: i32, h: i32) -> (i32, i32) {
    let (dw, dh) = default_size(kind);
    (if w > 0 { w } else { dw }, if h > 0 { h } else { dh })
}

fn default_size(kind: &str) -> (i32, i32) {
    match kind {
        "text" => (280, 120),
        "video" => (320, 200),
        "sound" => (280, 56),
        _ => (300, 180),
    }
}

fn fresh_id(reserved: &HashSet<i64>) -> i64 {
    loop {
        let id = ((OsRng.next_u64() >> 11) as i64).max(1);
        if !reserved.contains(&id) {
            return id;
        }
    }
}

struct FileRow {
    row: uuid::Uuid,
    kind: String,
    mime: String,
}

async fn file_row(db: &PgPool, name: &str, id: i64) -> Result<Option<FileRow>, sqlx::Error> {
    let row: Option<(uuid::Uuid, String, String)> = sqlx::query_as(
        "SELECT s.id, a.kind, a.mime FROM about_files a JOIN streamers s ON s.name = a.name WHERE a.name = $1 AND a.id = $2",
    )
    .bind(name)
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(row, kind, mime)| FileRow { row, kind, mime }))
}

async fn put_file(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<FileQuery>, QueryRejection>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let q = q.map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad type. one of image, video, sound"))?.0;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "file too big"));
        }
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    let kind = sniffed(&q.kind, &body)?;
    let row = ensure_row(&s.db, &name).await?;
    for _ in 0..2 {
        let id = ((OsRng.next_u64() >> 11) as i64).max(1);
        let inserted: Option<i64> = match sqlx::query_scalar(
            "INSERT INTO about_files (name, id, kind, mime, bytes)
             SELECT $1, $2, $3, $4, $5
             WHERE (SELECT count(*) FROM about_files WHERE name = $1) < $6
             RETURNING id",
        )
        .bind(&name)
        .bind(id)
        .bind(kind.kind)
        .bind(kind.mime)
        .bind(body.len() as i32)
        .bind(BLOCKS_MAX as i64)
        .fetch_optional(&s.db)
        .await
        {
            Ok(row) => row,
            Err(e) if unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        };
        let Some(id) = inserted else {
            return Err(ApiError::new(StatusCode::CONFLICT, "40 files at most. remove one first"));
        };
        if let Err(e) = s3::put(&s.s3, &about_key(row, id, kind.ext), &body, kind.mime).await {
            if let Err(drop) = sqlx::query("DELETE FROM about_files WHERE name = $1 AND id = $2")
                .bind(&name)
                .bind(id)
                .execute(&s.db)
                .await
            {
                log::warn!("postgres: {name}'s about file {id} did not reach the bucket, and the row stayed: {drop}");
            }
            log::error!("s3 about {name}: {e}");
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the file"));
        }
        log::info!("{name}: about {} {id}, {} bytes", kind.kind, body.len());
        return Ok(Json(json!({ "id": id, "type": kind.kind, "src": file_src(&name, id) })));
    }
    Err(ApiError::new(StatusCode::CONFLICT, "try again"))
}

async fn get_file(State(s): State<AppState>, Path((raw, id)): Path<(String, i64)>) -> Result<Response, ApiError> {
    let name = raw.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError::bad_name());
    }
    if id <= 0 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad file"));
    }
    let Some(file) = file_row(&s.db, &name, id).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such file"));
    };
    let ext = ext_of(&file.kind, &file.mime);
    match s3::get(&s.s3, &about_key(file.row, id, ext)).await {
        Ok(Some(bytes)) => {
            let cache = if file.kind == "text" { "no-store" } else { FILE_CACHE };
            Ok((
                [
                    (header::CONTENT_TYPE, file.mime),
                    (header::CACHE_CONTROL, cache.to_owned()),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
                ],
                bytes,
            )
                .into_response())
        }
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, "no such file")),
        Err(e) => {
            log::error!("s3 about {name}: {e}");
            Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not load the file"))
        }
    }
}

#[derive(Debug)]
struct Sniffed {
    kind: &'static str,
    mime: &'static str,
    ext: &'static str,
}

fn sniffed(asked: &str, body: &[u8]) -> Result<Sniffed, ApiError> {
    let found = sniff_file(body);
    match asked {
        "image" => match found {
            Some(s) if s.kind == "image" => {
                if body.len() > MAX_IMAGE {
                    return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big. 2 mb at most"));
                }
                Ok(s)
            }
            _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "not a png, jpeg, gif or webp")),
        },
        "video" => match found {
            Some(s) if s.kind == "video" => {
                if body.len() > MAX_VIDEO {
                    return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "video too big. 12 mb at most"));
                }
                Ok(s)
            }
            _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "not an mp4 or webm")),
        },
        "sound" => match found {
            Some(s) if s.kind == "sound" => {
                if body.len() > MAX_SOUND {
                    return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "sound too big. 8 mb at most"));
                }
                Ok(s)
            }
            _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "not an mp3 or m4a")),
        },
        _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "bad type. one of image, video, sound")),
    }
}

fn sniff_file(b: &[u8]) -> Option<Sniffed> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(Sniffed { kind: "image", mime: "image/png", ext: "png" });
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(Sniffed { kind: "image", mime: "image/jpeg", ext: "jpg" });
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(Sniffed { kind: "image", mime: "image/gif", ext: "gif" });
    }
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        return Some(Sniffed { kind: "image", mime: "image/webp", ext: "webp" });
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        let brand = &b[8..12];
        if brand == b"M4A " || brand == b"M4B " {
            return Some(Sniffed { kind: "sound", mime: "audio/mp4", ext: "m4a" });
        }
        return Some(Sniffed { kind: "video", mime: "video/mp4", ext: "mp4" });
    }
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(Sniffed { kind: "video", mime: "video/webm", ext: "webm" });
    }
    if b.starts_with(b"ID3") || (b.len() >= 2 && b[0] == 0xFF && b[1] & 0xE0 == 0xE0) {
        return Some(Sniffed { kind: "sound", mime: "audio/mpeg", ext: "mp3" });
    }
    None
}

pub(crate) fn ext_of(kind: &str, mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        _ if kind == "text" => "html",
        _ => "bin",
    }
}

#[derive(Serialize, Deserialize, Default)]
struct StoredPage {
    blocks: Vec<StoredBlock>,
}

#[derive(Serialize, Deserialize)]
struct StoredBlock {
    #[serde(rename = "type")]
    kind: String,
    id: i64,
    x: i32,
    y: i32,
    z: i32,
    #[serde(default)]
    w: i32,
    #[serde(default)]
    h: i32,
}

async fn ensure_row(db: &PgPool, name: &str) -> Result<uuid::Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO streamers (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    )
    .bind(name)
    .fetch_one(db)
    .await
}

/// The text as it is kept: a fragment of the tags a line needs (`p`, `br`, `b`, `i`, `a`, a list,
/// a heading), nothing else. A `div` becomes a `p` (that is what a text box writes for a new
/// line). A link is http or https, or it is not a link. Script, style, and the rest are dropped
/// with what is inside them. Cut at `TEXT_MAX` characters of text. The string is what the bucket
/// stores, and what the page draws.
fn sanitize_html(raw: &str) -> String {
    let mut out = String::new();
    let mut budget = TEXT_MAX;
    let mut i = 0;
    let mut stack: Vec<&'static str> = Vec::new();
    while i < raw.len() && budget > 0 && out.len() < TEXT_MAX {
        let rest = &raw[i..];
        match rest.find('<') {
            None => {
                push_text(&mut out, rest, &mut budget);
                break;
            }
            Some(0) => {
                let n = eat_tag(rest, &mut out, &mut stack, &mut budget);
                if n == 0 {
                    push_text(&mut out, "<", &mut budget);
                    i += '<'.len_utf8();
                } else {
                    i += n;
                }
            }
            Some(rel) => {
                push_text(&mut out, &rest[..rel], &mut budget);
                i += rel;
            }
        }
    }
    while let Some(tag) = stack.pop() {
        out.push_str("</");
        out.push_str(tag);
        out.push('>');
    }
    out
}

fn eat_tag(s: &str, out: &mut String, stack: &mut Vec<&'static str>, _budget: &mut usize) -> usize {
    if !s.starts_with('<') {
        return 0;
    }
    if s.starts_with("<!--") {
        return s.find("-->").map(|n| n + 3).unwrap_or(s.len());
    }
    let close = s.as_bytes().get(1) == Some(&b'/');
    let name_at = if close { 2 } else { 1 };
    let bytes = s.as_bytes();
    if name_at >= bytes.len() || !bytes[name_at].is_ascii_alphabetic() {
        return 0;
    }
    let mut j = name_at + 1;
    while j < bytes.len() && bytes[j].is_ascii_alphanumeric() {
        j += 1;
    }
    let name = s[name_at..j].to_ascii_lowercase();
    let mut k = j;
    let mut quote: Option<u8> = None;
    let end = loop {
        if k >= bytes.len() {
            return s.len();
        }
        let c = bytes[k];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if c == b'"' || c == b'\'' {
            quote = Some(c);
        } else if c == b'>' {
            break k;
        }
        k += 1;
    };
    let consumed = end + 1;
    let attrs = &s[j..end];
    if dropped(&name) {
        if close {
            return consumed;
        }
        return consumed + skip_body(&name, &s[consumed..]);
    }
    let Some(tag) = canon(&name) else {
        return consumed;
    };
    if close {
        if let Some(at) = stack.iter().rposition(|open| *open == tag) {
            while stack.len() > at {
                let open = stack.pop().unwrap();
                out.push_str("</");
                out.push_str(open);
                out.push('>');
            }
        }
        return consumed;
    }
    if tag == "br" || attrs.trim_end().ends_with('/') {
        if tag == "br" {
            out.push_str("<br>");
        }
        return consumed;
    }
    if tag == "a" {
        let Some(href) = href_of(attrs).and_then(|h| http_url(&h)) else {
            return consumed;
        };
        out.push_str("<a href=\"");
        push_attr(out, &href);
        out.push_str("\">");
        stack.push(tag);
        return consumed;
    }
    out.push('<');
    out.push_str(tag);
    out.push('>');
    stack.push(tag);
    consumed
}

fn skip_body(name: &str, s: &str) -> usize {
    let mut depth = 1usize;
    let mut i = 0;
    while i < s.len() && depth > 0 {
        let Some(rel) = s[i..].find('<') else { return s.len() };
        i += rel;
        let tag = &s[i..];
        let close = tag.as_bytes().get(1) == Some(&b'/');
        let at = if close { 2 } else { 1 };
        if tag.len() > at && tag.as_bytes()[at].is_ascii_alphabetic() {
            let mut j = at + 1;
            let bytes = tag.as_bytes();
            while j < bytes.len() && bytes[j].is_ascii_alphanumeric() {
                j += 1;
            }
            if tag[at..j].eq_ignore_ascii_case(name) {
                depth = if close { depth.saturating_sub(1) } else { depth + 1 };
            }
        }
        let Some(gt) = s[i..].find('>') else { return s.len() };
        i += gt + 1;
    }
    i
}

fn dropped(name: &str) -> bool {
    matches!(
        name,
        "script" | "style" | "iframe" | "object" | "embed" | "svg" | "math" | "noscript" | "template" | "textarea" | "title" | "head" | "link" | "meta" | "base" | "form"
    )
}

fn canon(name: &str) -> Option<&'static str> {
    Some(match name {
        "p" | "div" => "p",
        "br" => "br",
        "b" => "b",
        "strong" => "strong",
        "i" => "i",
        "em" => "em",
        "u" => "u",
        "s" => "s",
        "a" => "a",
        "ul" => "ul",
        "ol" => "ol",
        "li" => "li",
        "h2" => "h2",
        "h3" => "h3",
        "blockquote" => "blockquote",
        _ => return None,
    })
}

fn href_of(attrs: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let mut i = 0;
    while let Some(rel) = lower[i..].find("href") {
        let start = i + rel;
        let before_ok = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
        let after = start + 4;
        if !before_ok || after > attrs.len() {
            i = start + 4;
            continue;
        }
        let rest = attrs[after..].trim_start();
        if !rest.starts_with('=') {
            i = start + 4;
            continue;
        }
        let rest = rest[1..].trim_start();
        let value = if let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
            let end = rest[1..].find(q)?;
            rest[1..1 + end].to_owned()
        } else {
            let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
            rest[..end].to_owned()
        };
        return Some(value);
    }
    None
}

fn http_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > 500 {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let kept = String::from(url);
    (kept.chars().count() <= 500).then_some(kept)
}

fn push_attr(out: &mut String, value: &str) {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            _ => out.push(c),
        }
    }
}

fn push_text(out: &mut String, text: &str, budget: &mut usize) {
    for ch in decode_entities(text).chars() {
        if *budget == 0 || out.len() >= TEXT_MAX {
            *budget = 0;
            return;
        }
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\n' | '\t' => out.push(ch),
            c if c.is_control() => continue,
            c => out.push(c),
        }
        *budget -= 1;
    }
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(end) = rest.find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        if end == 0 || end > 12 {
            out.push('&');
            rest = &rest[1..];
            continue;
        }
        let body = &rest[1..end];
        if let Some(ch) = entity(body) {
            out.push(ch);
            rest = &rest[end + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

fn entity(body: &str) -> Option<char> {
    let ch = match body {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{00a0}',
        _ if body.starts_with('#') => {
            let n = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                body[1..].parse().ok()?
            };
            char::from_u32(n)?
        }
        _ => return None,
    };
    Some(ch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_keeps_a_paragraph_and_drops_a_script() {
        assert_eq!(sanitize_html("<p>hi</p>"), "<p>hi</p>");
        assert_eq!(sanitize_html("<script>alert(1)</script><p>ok</p>"), "<p>ok</p>");
        assert_eq!(sanitize_html("<p onclick=\"alert(1)\">hi</p>"), "<p>hi</p>");
        assert_eq!(sanitize_html("<div>one</div><div>two</div>"), "<p>one</p><p>two</p>");
        assert_eq!(sanitize_html("a < b & c"), "a &lt; b &amp; c");
        assert_eq!(sanitize_html("<p>a &amp; b</p>"), "<p>a &amp; b</p>");
    }

    #[test]
    fn a_link_is_http_or_it_is_not_a_link() {
        assert_eq!(
            sanitize_html("<a href=\"https://example.com/a\">x</a>"),
            "<a href=\"https://example.com/a\">x</a>"
        );
        assert_eq!(sanitize_html("<a href=\"javascript:alert(1)\">x</a>"), "x");
        assert_eq!(sanitize_html("<a href=\"https://user:pw@evil.example/\">x</a>"), "x");
    }

    #[test]
    fn text_stops_at_ten_thousand_characters() {
        let long = "a".repeat(10_050);
        let kept = sanitize_html(&long);
        assert_eq!(kept.chars().count(), TEXT_MAX);
    }

    #[test]
    fn a_file_is_what_its_first_bytes_say() {
        assert_eq!(sniff_file(&[0xFF, 0xD8, 0xFF, 0xE0]).map(|s| s.kind), Some("image"));
        assert_eq!(sniff_file(b"\x00\x00\x00\x18ftypisom").map(|s| s.mime), Some("video/mp4"));
        assert_eq!(sniff_file(b"\x00\x00\x00\x18ftypM4A ").map(|s| s.kind), Some("sound"));
        assert_eq!(sniff_file(&[0x1A, 0x45, 0xDF, 0xA3]).map(|s| s.mime), Some("video/webm"));
        assert_eq!(sniff_file(b"ID3\x03").map(|s| s.mime), Some("audio/mpeg"));
        assert!(sniff_file(b"<svg></svg>").is_none());
        assert_eq!(sniffed("image", b"<svg></svg>").unwrap_err().message(), "not a png, jpeg, gif or webp");
        assert_eq!(sniffed("video", &[0xFF, 0xD8, 0xFF]).unwrap_err().message(), "not an mp4 or webm");
    }

    #[test]
    fn the_layout_names_a_file_this_name_has() {
        let mut have = HashMap::new();
        have.insert(7, ("image".into(), "image/jpeg".into()));
        have.insert(8, ("text".into(), "text/plain".into()));
        let body = PageBody {
            blocks: vec![
                Incoming { kind: "image".into(), id: 7, x: -4, y: 20, z: 1, w: 0, h: 0, html: String::new() },
                Incoming { kind: "text".into(), id: 8, x: 0, y: 0, z: 99, w: 900, h: 10, html: "<p>hi</p>".into() },
            ],
        };
        let kept = plan(&body, &have).unwrap();
        assert_eq!(kept[0].x, 0);
        assert_eq!(kept[0].kind, "image");
        assert_eq!((kept[0].w, kept[0].h), (300, 180));
        assert_eq!(kept[1].html.as_deref(), Some("<p>hi</p>"));
        assert_eq!(kept[1].z, Z_MAX);
        assert_eq!((kept[1].w, kept[1].h), (SIZE_MAX, H_MIN));
        let missing = PageBody { blocks: vec![Incoming { kind: "video".into(), id: 3, x: 0, y: 0, z: 0, w: 0, h: 0, html: String::new() }] };
        assert_eq!(plan(&missing, &have).unwrap_err().message(), "no such file");
        let wrong = PageBody { blocks: vec![Incoming { kind: "sound".into(), id: 7, x: 0, y: 0, z: 0, w: 0, h: 0, html: String::new() }] };
        assert_eq!(plan(&wrong, &have).unwrap_err().message(), "that file is a different kind");
    }
}
