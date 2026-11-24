use std::collections::HashMap;
use std::env;
use std::io::Cursor;
use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, JsonRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, RawQuery, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{self, Me};
use crate::chat::clean_text;
use crate::presence::{self, Presence};
use crate::moderate::{self, UploadKind};
use crate::s3;
use crate::{is_live, may_write, thumb_exists, unique_violation, valid_name, ApiError, ApiResult, AppState, Name, PasswordQuery};

const MAX_AVATAR_BYTES: usize = 256 * 1024;
const MAX_OFFLINE_BYTES: usize = 1024 * 1024;
const MAX_NOTE_CHARS: usize = 140;
const MAX_THUMBS: i64 = 6;
const AVATAR_CACHE: &str = "public, max-age=86400";
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];
const AVATAR_SIDE: u32 = 96;
const AVATAR_QUALITY: u8 = 85;
const AVATAR_MAX_SOURCE_SIDE: u32 = 8192;
const NOT_A_JPEG: &str = "not a jpeg";
const MAX_ASSET_BYTES: usize = 2 * 1024 * 1024;
const MAX_ASSETS: i64 = 24;
const ASSET_CACHE: &str = "public, max-age=31536000, immutable";
const WATCH_CACHE: &str = "public, max-age=0, s-maxage=15, must-revalidate";

const AVATAR_IMG_CLASS: &str = "mr-3 inline-block h-10 w-10 border border-primaryStroke object-cover align-middle";
const VERIFIED_HTML: &str = r#"<span class="ml-2 text-increase" title="has an account: this really is them">✓</span>"#;
const STATUS_SPAN_CLASS: &str = "mt-1 block truncate text-base font-normal text-textSecondary";
const TEMPLATE_OPEN: &str = r#"<template id="watch-shell">"#;
const TEMPLATE_CLOSE: &str = "</template>";
const EMPTY_ROOT: &str = r#"<div id="root"></div>"#;

fn pages_dir() -> String {
    env::var("PAGES_DIR").unwrap_or_else(|_| "/srv".into())
}

pub(crate) struct Profile {
    pub(crate) name: String,
    pub(crate) bio: String,
    pub(crate) avatar: Option<i64>,
    pub(crate) verified: bool,
    pub(crate) oauth_verified: bool,
    pub(crate) offline: Option<i64>,
    pub(crate) offline_note: String,
    pub(crate) joined: Option<DateTime<Utc>>,
    pub(crate) socials: Socials,
    pub(crate) about: String,
    pub(crate) welcome_on: bool,
    pub(crate) welcome: String,
}

type ProfileRow = (String, Option<i64>, bool, Option<i64>, String, Option<DateTime<Utc>>, Value, String, bool, bool, String);

pub(crate) async fn load_profile(db: &PgPool, name: &str) -> Result<Profile, sqlx::Error> {
    let row: Option<ProfileRow> = sqlx::query_as(concat!(
        "SELECT bio, (EXTRACT(EPOCH FROM avatar_at))::bigint, password_hash IS NOT NULL,
                (EXTRACT(EPOCH FROM offline_at))::bigint, offline_note,
                CASE WHEN password_hash IS NOT NULL THEN created_at END, socials, about, ",
        crate::oauth::linked_sql!("streamers"),
        ", welcome_on, welcome FROM streamers WHERE name = $1",
    ))
    .bind(name)
    .fetch_optional(db)
    .await?;
    let row = row.unwrap_or_else(|| (String::new(), None, false, None, String::new(), None, Value::Null, String::new(), false, true, DEFAULT_WELCOME.to_owned()));
    let (bio, avatar, verified, offline, offline_note, joined, socials, about, oauth_verified, welcome_on, welcome) = row;
    let socials = serde_json::from_value(socials).unwrap_or_default();
    let oauth_verified = oauth_verified && verified;
    Ok(Profile { name: name.to_owned(), bio, avatar, verified, oauth_verified, offline, offline_note, joined, socials, about, welcome_on, welcome })
}

async fn row_id(db: &PgPool, name: &str) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(name).fetch_optional(db).await
}

async fn ensure_row(db: &PgPool, name: &str) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO streamers (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    )
    .bind(name)
    .fetch_one(db)
    .await
}

fn avatar_key(id: Uuid) -> String {
    format!("avatars/{id}.jpg")
}

fn legacy_avatar_key(name: &str) -> String {
    format!("avatars/{name}.jpg")
}

fn jpeg(bytes: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, AVATAR_CACHE)], bytes).into_response()
}

fn no_picture() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no picture")
}

fn picture_failed(name: &str, what: &str, err: String) -> ApiError {
    log::error!("s3 avatar {name}: {err}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what)
}

async fn lift_object(s: &AppState, from: &str, to: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(bytes) = s3::get(&s.s3, from).await? else { return Ok(None) };
    s3::put(&s.s3, to, &bytes, "image/jpeg").await?;
    if let Err(e) = s3::delete(&s.s3, from).await {
        log::warn!("s3: {from} is at {to} now, but the old copy stayed: {e}");
    }
    Ok(Some(bytes))
}

#[allow(clippy::too_many_arguments)]
async fn look(s: &AppState, me: &Me, row: Uuid, headers: &HeaderMap, kind: UploadKind, mime: &str, key: Option<&str>, body: &[u8]) -> Result<moderate::Passed, ApiError> {
    let ip = crate::ratelimit::forwarded_ip(headers);
    let who = me.0.as_ref().map_or(row, |a| a.id);
    moderate::check(s, moderate::Upload { kind, who: Some(who), ip: ip.as_deref(), mime, key, sha: None }, body).await
}

async fn get_avatar(State(s): State<AppState>, Name(name): Name, RawQuery(q): RawQuery) -> Result<Response, ApiError> {
    crate::media::versioned_cache(avatar(&s, name).await, q.as_deref())
}

async fn avatar(s: &AppState, name: String) -> Result<Response, ApiError> {
    let name = auth::renamed_to(&s.db, &name).await?.unwrap_or(name);
    let row: Option<(Uuid, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT id, avatar FROM streamers WHERE name = $1 AND (avatar IS NOT NULL OR avatar_at IS NOT NULL)",
    )
    .bind(&name)
    .fetch_optional(&s.db)
    .await?;
    let Some((id, legacy)) = row else {
        return Err(no_picture());
    };
    let key = avatar_key(id);
    match s3::get(&s.s3, &key).await {
        Ok(Some(bytes)) => Ok(jpeg(bytes)),
        Ok(None) => match lift_object(s, &legacy_avatar_key(&name), &key).await {
            Ok(Some(bytes)) => Ok(jpeg(bytes)),
            Ok(None) => match legacy {
                Some(bytes) => {
                    lift_legacy(s, id, &name, &bytes).await;
                    Ok(jpeg(bytes))
                }
                None => Err(no_picture()),
            },
            Err(e) => match legacy {
                Some(bytes) => {
                    log::warn!("s3 avatar {name}: {e}. serving the copy still in postgres");
                    Ok(jpeg(bytes))
                }
                None => Err(picture_failed(&name, "could not load the picture", e)),
            },
        },
        Err(e) => match legacy {
            Some(bytes) => {
                log::warn!("s3 avatar {name}: {e}. serving the copy still in postgres");
                Ok(jpeg(bytes))
            }
            None => Err(picture_failed(&name, "could not load the picture", e)),
        },
    }
}

async fn lift_legacy(s: &AppState, id: Uuid, name: &str, bytes: &[u8]) {
    if let Err(e) = s3::put(&s.s3, &avatar_key(id), bytes, "image/jpeg").await {
        log::warn!("s3: could not move {name}'s picture out of postgres: {e}");
        return;
    }
    if let Err(e) = sqlx::query("UPDATE streamers SET avatar = NULL WHERE id = $1 AND avatar IS NOT NULL")
        .bind(id)
        .execute(&s.db)
        .await
    {
        log::warn!("postgres: moved {name}'s picture but could not clear the old bytes: {e}");
    }
}

pub(crate) async fn lift_pictures(s: &AppState, id: Uuid, name: &str) {
    if let Err(e) = lift_object(s, &legacy_avatar_key(name), &avatar_key(id)).await {
        log::warn!("s3: could not lift {name}'s picture to its id before the rename: {e}");
    }
    let thumbs: Vec<i64> = match sqlx::query_scalar("SELECT id FROM stream_thumbs WHERE name = $1").bind(name).fetch_all(&s.db).await {
        Ok(thumbs) => thumbs,
        Err(e) => {
            log::warn!("postgres: could not list {name}'s thumbnails before the rename: {e}");
            return;
        }
    };
    for n in thumbs {
        if let Err(e) = lift_object(s, &legacy_thumb_key(name, n), &thumb_key(id, n)).await {
            log::warn!("s3: could not lift {name}'s thumbnail {n} to its id before the rename: {e}");
        }
    }
}

pub(crate) fn picture_keys(id: Uuid, thumbs: &[i64], assets: &[(i64, String)]) -> Vec<String> {
    [avatar_key(id), offline_key(id)]
        .into_iter()
        .chain(thumbs.iter().map(|n| thumb_key(id, *n)))
        .chain(assets.iter().filter_map(|(n, mime)| kind_of(mime).map(|kind| asset_key(id, *n, kind.ext))))
        .collect()
}

pub(crate) async fn drop_pictures(s: &AppState, keys: &[String]) {
    for key in keys {
        if let Err(e) = s3::delete(&s.s3, key).await {
            log::warn!("s3: could not drop {key}: {e}");
        }
    }
}

fn too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big. 256 kb at most")
}

fn jpeg_body(body: Result<Bytes, BytesRejection>, max: usize, too_big: fn() -> ApiError) -> Result<Bytes, ApiError> {
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => return Err(too_big()),
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    if body.len() > max {
        return Err(too_big());
    }
    if !body.starts_with(&JPEG_MAGIC) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a jpeg"));
    }
    Ok(body)
}

fn shrink_avatar(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Jpeg);
    let mut limits = Limits::default();
    limits.max_image_width = Some(AVATAR_MAX_SOURCE_SIDE);
    limits.max_image_height = Some(AVATAR_MAX_SOURCE_SIDE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| NOT_A_JPEG)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|_| NOT_A_JPEG)?;
    img.apply_orientation(orientation);
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(NOT_A_JPEG);
    }
    let side = w.min(h);
    let square = img.crop_imm((w - side) / 2, (h - side) / 2, side, side);
    let drawn = square.resize_exact(AVATAR_SIDE, AVATAR_SIDE, FilterType::Lanczos3).to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, AVATAR_QUALITY).encode_image(&drawn).map_err(|_| NOT_A_JPEG)?;
    Ok(out)
}

async fn put_avatar(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = jpeg_body(body, MAX_AVATAR_BYTES, too_big)?;
    let body = tokio::task::spawn_blocking(move || shrink_avatar(&body))
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not read the picture"))?
        .map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    let id = ensure_row(&s.db, &name).await?;
    look(&s, &me, id, &headers, UploadKind::Avatar, "image/jpeg", Some(&avatar_key(id)), &body).await?;
    if let Err(e) = s3::put(&s.s3, &avatar_key(id), &body, "image/jpeg").await {
        return Err(picture_failed(&name, "could not save the picture", e));
    }
    let version: i64 = sqlx::query_scalar(
        "UPDATE streamers SET avatar = NULL, avatar_at = now(), updated_at = now() WHERE id = $1
         RETURNING (EXTRACT(EPOCH FROM avatar_at))::bigint",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await?;
    log::info!("{name}: new picture, {} bytes", body.len());
    Ok(Json(json!({ "name": name, "avatar": version })))
}

async fn delete_avatar(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let version: Option<i64> = sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM avatar_at))::bigint FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?
        .flatten();
    let mut keys = vec![legacy_avatar_key(&name)];
    if let Some(id) = row_id(&s.db, &name).await? {
        keys.push(avatar_key(id));
    }
    for key in keys {
        if let Err(e) = s3::delete(&s.s3, &key).await {
            return Err(picture_failed(&name, "could not remove the picture", e));
        }
    }
    sqlx::query("UPDATE streamers SET avatar = NULL, avatar_at = NULL, updated_at = now() WHERE name = $1")
        .bind(&name)
        .execute(&s.db)
        .await?;
    let bare = format!("/api/streamers/{name}/avatar");
    let mut paths = vec![bare.clone()];
    paths.extend(version.map(|v| format!("{bare}?v={v}")));
    crate::cf_purge::purge(paths);
    Ok(StatusCode::NO_CONTENT)
}

fn thumb_key(id: Uuid, n: i64) -> String {
    format!("thumbs/{id}/{n}.jpg")
}

fn legacy_thumb_key(name: &str, n: i64) -> String {
    format!("thumbs/{name}/{n}.jpg")
}

fn checked_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError::bad_name());
    }
    Ok(name)
}

fn thumb_failed(name: &str, what: &str, err: String) -> ApiError {
    log::error!("s3 thumb {name}: {err}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what)
}

fn no_thumbnail() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no thumbnail")
}

fn too_many_thumbs() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "6 pictures at most. remove one first")
}

fn new_thumb_id() -> i64 {
    ((OsRng.next_u64() >> 11) as i64).max(1)
}

pub(crate) async fn thumb_ids(db: &PgPool, names: &[String]) -> Result<HashMap<String, Vec<i64>>, sqlx::Error> {
    let mut out: HashMap<String, Vec<i64>> = HashMap::new();
    if names.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT name, id FROM stream_thumbs WHERE name = ANY($1::text[]) ORDER BY created_at, id",
    )
    .bind(names)
    .fetch_all(db)
    .await?;
    for (name, id) in rows {
        out.entry(name).or_default().push(id);
    }
    Ok(out)
}

async fn list_thumbs(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let thumbs = thumb_ids(&s.db, std::slice::from_ref(&name)).await?.remove(&name).unwrap_or_default();
    Ok(Json(json!({ "thumbs": thumbs })))
}

async fn get_thumb(State(s): State<AppState>, Path((raw, n)): Path<(String, i64)>) -> Result<Response, ApiError> {
    let name = checked_name(&raw)?;
    if n <= 0 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    }
    let Some(id) = row_id(&s.db, &name).await? else {
        return Err(no_thumbnail());
    };
    let key = thumb_key(id, n);
    match s3::get(&s.s3, &key).await {
        Ok(Some(bytes)) => Ok(jpeg(bytes)),
        Ok(None) => match lift_object(&s, &legacy_thumb_key(&name, n), &key).await {
            Ok(Some(bytes)) => Ok(jpeg(bytes)),
            Ok(None) => Err(no_thumbnail()),
            Err(e) => Err(thumb_failed(&name, "could not load the picture", e)),
        },
        Err(e) => Err(thumb_failed(&name, "could not load the picture", e)),
    }
}

async fn put_thumb(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = jpeg_body(body, MAX_AVATAR_BYTES, too_big)?;
    let row = ensure_row(&s.db, &name).await?;
    let looked = look(&s, &me, row, &headers, UploadKind::Thumb, "image/jpeg", None, &body).await?;
    for _ in 0..2 {
        let id = new_thumb_id();
        let mut tx = s.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))").bind(&name).execute(&mut *tx).await?;
        let inserted: Option<i64> = match sqlx::query_scalar(
            "INSERT INTO stream_thumbs (name, id)
             SELECT $1, $2
             WHERE (SELECT count(*) FROM stream_thumbs WHERE name = $1) < $3
             RETURNING id",
        )
        .bind(&name)
        .bind(id)
        .bind(MAX_THUMBS)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(row) => row,
            Err(e) if unique_violation(&e) => {
                tx.rollback().await?;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let Some(id) = inserted else {
            return Err(too_many_thumbs());
        };
        tx.commit().await?;
        if let Err(e) = s3::put(&s.s3, &thumb_key(row, id), &body, "image/jpeg").await {
            if let Err(drop) = sqlx::query("DELETE FROM stream_thumbs WHERE name = $1 AND id = $2")
                .bind(&name)
                .bind(id)
                .execute(&s.db)
                .await
            {
                log::warn!("postgres: {name}'s thumbnail {id} did not reach the bucket, and the row stayed: {drop}");
            }
            return Err(thumb_failed(&name, "could not save the picture", e));
        }
        moderate::set_key(&s.db, looked.row, &thumb_key(row, id)).await;
        log::info!("{name}: thumbnail {id}, {} bytes", body.len());
        return Ok(Json(json!({ "id": id })));
    }
    Err(ApiError::new(StatusCode::CONFLICT, "try again"))
}

async fn delete_thumb(
    State(s): State<AppState>,
    Path((raw, id)): Path<(String, i64)>,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let Query(q) = q?;
    let name = checked_name(&raw)?;
    if id <= 0 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    }
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM stream_thumbs WHERE name = $1 AND id = $2)")
        .bind(&name)
        .bind(id)
        .fetch_one(&s.db)
        .await?;
    if !exists {
        return Err(no_thumbnail());
    }
    let mut keys = vec![legacy_thumb_key(&name, id)];
    if let Some(row) = row_id(&s.db, &name).await? {
        keys.push(thumb_key(row, id));
    }
    for key in keys {
        if let Err(e) = s3::delete(&s.s3, &key).await {
            return Err(thumb_failed(&name, "could not remove the picture", e));
        }
    }
    sqlx::query("DELETE FROM stream_thumbs WHERE name = $1 AND id = $2")
        .bind(&name)
        .bind(id)
        .execute(&s.db)
        .await?;
    crate::cf_purge::purge(vec![format!("/api/streamers/{name}/thumbs/{id}")]);
    Ok(StatusCode::NO_CONTENT)
}

struct Kind {
    mime: &'static str,
    ext: &'static str,
}

const PNG: Kind = Kind { mime: "image/png", ext: "png" };
const JPEG: Kind = Kind { mime: "image/jpeg", ext: "jpg" };
const GIF: Kind = Kind { mime: "image/gif", ext: "gif" };
const WEBP: Kind = Kind { mime: "image/webp", ext: "webp" };

fn sniff(b: &[u8]) -> Option<&'static Kind> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(&PNG);
    }
    if b.starts_with(&JPEG_MAGIC) {
        return Some(&JPEG);
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(&GIF);
    }
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        return Some(&WEBP);
    }
    None
}

fn kind_of(mime: &str) -> Option<&'static Kind> {
    [&PNG, &JPEG, &GIF, &WEBP].into_iter().find(|k| k.mime == mime)
}

fn asset_key(id: Uuid, n: i64, ext: &str) -> String {
    format!("assets/{id}/{n}.{ext}")
}

fn asset_failed(name: &str, what: &str, err: String) -> ApiError {
    log::error!("s3 asset {name}: {err}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what)
}

fn no_asset() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such picture")
}

fn too_many_assets() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "24 pictures at most. remove one first")
}

fn asset_too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big. 2 mb at most")
}

fn asset_body(body: Result<Bytes, BytesRejection>) -> Result<(Bytes, &'static Kind), ApiError> {
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => return Err(asset_too_big()),
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    if body.len() > MAX_ASSET_BYTES {
        return Err(asset_too_big());
    }
    let Some(kind) = sniff(&body) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a png, jpeg, gif or webp"));
    };
    Ok((body, kind))
}

pub(crate) async fn asset_rows(db: &PgPool, name: &str) -> Result<Vec<(i64, String, i32)>, sqlx::Error> {
    sqlx::query_as("SELECT id, mime, bytes FROM stream_assets WHERE name = $1 ORDER BY created_at, id")
        .bind(name)
        .fetch_all(db)
        .await
}

async fn list_assets(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let assets: Vec<serde_json::Value> = asset_rows(&s.db, &name)
        .await?
        .into_iter()
        .map(|(id, mime, bytes)| json!({ "id": id, "mime": mime, "bytes": bytes }))
        .collect();
    Ok(Json(json!({ "assets": assets })))
}

async fn get_asset(State(s): State<AppState>, Path((raw, id)): Path<(String, i64)>) -> Result<Response, ApiError> {
    let name = checked_name(&raw)?;
    if id <= 0 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    }
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT s.id, a.mime FROM stream_assets a JOIN streamers s ON s.name = a.name WHERE a.name = $1 AND a.id = $2")
            .bind(&name)
            .bind(id)
            .fetch_optional(&s.db)
            .await?;
    let Some((row, mime)) = row else {
        return Err(no_asset());
    };
    let Some(kind) = kind_of(&mime) else {
        return Err(no_asset());
    };
    match s3::get(&s.s3, &asset_key(row, id, kind.ext)).await {
        Ok(Some(bytes)) => Ok((
            [
                (header::CONTENT_TYPE, kind.mime),
                (header::CACHE_CONTROL, ASSET_CACHE),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response()),
        Ok(None) => Err(no_asset()),
        Err(e) => Err(asset_failed(&name, "could not load the picture", e)),
    }
}

async fn put_asset(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let (body, kind) = asset_body(body)?;
    moderate::refuse_animated(&body)?;
    let row = ensure_row(&s.db, &name).await?;
    let looked = look(&s, &me, row, &headers, UploadKind::Asset, kind.mime, None, &body).await?;
    for _ in 0..2 {
        let id = new_thumb_id();
        let mut tx = s.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))").bind(&name).execute(&mut *tx).await?;
        let inserted: Option<i64> = match sqlx::query_scalar(
            "INSERT INTO stream_assets (name, id, mime, bytes)
             SELECT $1, $2, $3, $4
             WHERE (SELECT count(*) FROM stream_assets WHERE name = $1) < $5
             RETURNING id",
        )
        .bind(&name)
        .bind(id)
        .bind(kind.mime)
        .bind(body.len() as i32)
        .bind(MAX_ASSETS)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(row) => row,
            Err(e) if unique_violation(&e) => {
                tx.rollback().await?;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let Some(id) = inserted else {
            return Err(too_many_assets());
        };
        tx.commit().await?;
        if let Err(e) = s3::put(&s.s3, &asset_key(row, id, kind.ext), &body, kind.mime).await {
            if let Err(drop) = sqlx::query("DELETE FROM stream_assets WHERE name = $1 AND id = $2")
                .bind(&name)
                .bind(id)
                .execute(&s.db)
                .await
            {
                log::warn!("postgres: {name}'s picture {id} did not reach the bucket, and the row stayed: {drop}");
            }
            return Err(asset_failed(&name, "could not save the picture", e));
        }
        moderate::set_key(&s.db, looked.row, &asset_key(row, id, kind.ext)).await;
        log::info!("{name}: scene picture {id}, {} bytes, {}", body.len(), kind.mime);
        return Ok(Json(json!({ "id": id, "mime": kind.mime, "bytes": body.len() })));
    }
    Err(ApiError::new(StatusCode::CONFLICT, "try again"))
}

async fn delete_asset(
    State(s): State<AppState>,
    Path((raw, id)): Path<(String, i64)>,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let Query(q) = q?;
    let name = checked_name(&raw)?;
    if id <= 0 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    }
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let mime: Option<String> = sqlx::query_scalar("SELECT mime FROM stream_assets WHERE name = $1 AND id = $2")
        .bind(&name)
        .bind(id)
        .fetch_optional(&s.db)
        .await?;
    let Some(mime) = mime else {
        return Err(no_asset());
    };
    if let (Some(row), Some(kind)) = (row_id(&s.db, &name).await?, kind_of(&mime)) {
        if let Err(e) = s3::delete(&s.s3, &asset_key(row, id, kind.ext)).await {
            return Err(asset_failed(&name, "could not remove the picture", e));
        }
    }
    sqlx::query("DELETE FROM stream_assets WHERE name = $1 AND id = $2")
        .bind(&name)
        .bind(id)
        .execute(&s.db)
        .await?;
    crate::cf_purge::purge(vec![format!("/api/streamers/{name}/assets/{id}")]);
    Ok(StatusCode::NO_CONTENT)
}

fn offline_key(id: Uuid) -> String {
    format!("offline/{id}.jpg")
}

fn offline_failed(name: &str, what: &str, err: String) -> ApiError {
    log::error!("s3 offline {name}: {err}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what)
}

fn offline_too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big. 1 mb at most")
}

async fn get_offline(State(s): State<AppState>, Name(name): Name, RawQuery(q): RawQuery) -> Result<Response, ApiError> {
    crate::media::versioned_cache(offline(&s, &name).await, q.as_deref())
}

async fn offline(s: &AppState, name: &str) -> Result<Response, ApiError> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND offline_at IS NOT NULL")
        .bind(name)
        .fetch_optional(&s.db)
        .await?;
    let Some(id) = id else {
        return Err(no_picture());
    };
    match s3::get(&s.s3, &offline_key(id)).await {
        Ok(Some(bytes)) => Ok(jpeg(bytes)),
        Ok(None) => Err(no_picture()),
        Err(e) => Err(offline_failed(name, "could not load the picture", e)),
    }
}

async fn put_offline(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = jpeg_body(body, MAX_OFFLINE_BYTES, offline_too_big)?;
    let id = ensure_row(&s.db, &name).await?;
    look(&s, &me, id, &headers, UploadKind::Offline, "image/jpeg", Some(&offline_key(id)), &body).await?;
    if let Err(e) = s3::put(&s.s3, &offline_key(id), &body, "image/jpeg").await {
        return Err(offline_failed(&name, "could not save the picture", e));
    }
    let version: i64 = sqlx::query_scalar(
        "UPDATE streamers SET offline_at = now(), updated_at = now() WHERE id = $1
         RETURNING (EXTRACT(EPOCH FROM offline_at))::bigint",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await?;
    log::info!("{name}: new offline picture, {} bytes", body.len());
    Ok(Json(json!({ "name": name, "offline": version })))
}

async fn delete_offline(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    if let Some(id) = row_id(&s.db, &name).await? {
        if let Err(e) = s3::delete(&s.s3, &offline_key(id)).await {
            return Err(offline_failed(&name, "could not remove the picture", e));
        }
        sqlx::query("UPDATE streamers SET offline_at = NULL, updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(&s.db)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct NoteBody {
    note: String,
}

fn clean_note(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NOTE_CHARS).collect()
}

async fn put_offline_note(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<NoteBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let note: String = sqlx::query_scalar(
        "INSERT INTO streamers (name, offline_note) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET offline_note = EXCLUDED.offline_note, updated_at = now()
         RETURNING offline_note",
    )
    .bind(&name)
    .bind(clean_note(&body.note))
    .fetch_one(&s.db)
    .await?;
    Ok(Json(json!({ "name": name, "offline_note": note })))
}

const MAX_ABOUT_CHARS: usize = 2000;

#[derive(Deserialize)]
struct AboutBody {
    about: String,
}

fn clean_about(raw: &str) -> String {
    clean_text(raw).chars().take(MAX_ABOUT_CHARS).collect()
}

async fn put_about(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<AboutBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let about: String = sqlx::query_scalar(
        "INSERT INTO streamers (name, about) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET about = EXCLUDED.about, updated_at = now()
         RETURNING about",
    )
    .bind(&name)
    .bind(clean_about(&body.about))
    .fetch_one(&s.db)
    .await?;
    Ok(Json(json!({ "name": name, "about": about })))
}

const DEFAULT_WELCOME: &str = "welcome to the chat!";
const MAX_WELCOME_CHARS: usize = 300;

#[derive(Deserialize)]
struct WelcomeBody {
    on: bool,
    message: String,
}

fn clean_welcome(raw: &str) -> String {
    let text: String = clean_text(raw).chars().take(MAX_WELCOME_CHARS).collect();
    let text = text.trim_end();
    if text.is_empty() { DEFAULT_WELCOME.to_owned() } else { text.to_owned() }
}

async fn put_welcome(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<WelcomeBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let (on, welcome): (bool, String) = sqlx::query_as(
        "INSERT INTO streamers (name, welcome_on, welcome) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET welcome_on = EXCLUDED.welcome_on, welcome = EXCLUDED.welcome, updated_at = now()
         RETURNING welcome_on, welcome",
    )
    .bind(&name)
    .bind(body.on)
    .bind(clean_welcome(&body.message))
    .fetch_one(&s.db)
    .await?;
    Ok(Json(json!({ "name": name, "welcome_on": on, "welcome": welcome })))
}

const MAX_LINKS: usize = 20;
const MAX_URL_CHARS: usize = 500;
const MAX_LABEL_CHARS: usize = 40;
const MAX_SOCIALS_BYTES: usize = 32 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Layout {
    #[default]
    Row,
    Grid,
}

impl Layout {
    fn parse(raw: &str) -> Option<Layout> {
        match raw {
            "row" => Some(Layout::Row),
            "grid" => Some(Layout::Grid),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Size {
    Small,
    #[default]
    Medium,
    Large,
}

impl Size {
    fn parse(raw: &str) -> Option<Size> {
        match raw {
            "small" => Some(Size::Small),
            "medium" => Some(Size::Medium),
            "large" => Some(Size::Large),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Tiktok,
    Youtube,
    Twitch,
    Kick,
    Discord,
    Instagram,
    X,
    Threads,
    Bluesky,
    Facebook,
    Snapchat,
    Reddit,
    Github,
    Spotify,
    Soundcloud,
    Patreon,
    Telegram,
    Steam,
    Web,
}

const PLATFORMS: &[(Platform, &str)] = &[
    (Platform::Tiktok, "tiktok"),
    (Platform::Youtube, "youtube"),
    (Platform::Twitch, "twitch"),
    (Platform::Kick, "kick"),
    (Platform::Discord, "discord"),
    (Platform::Instagram, "instagram"),
    (Platform::X, "x"),
    (Platform::Threads, "threads"),
    (Platform::Bluesky, "bluesky"),
    (Platform::Facebook, "facebook"),
    (Platform::Snapchat, "snapchat"),
    (Platform::Reddit, "reddit"),
    (Platform::Github, "github"),
    (Platform::Spotify, "spotify"),
    (Platform::Soundcloud, "soundcloud"),
    (Platform::Patreon, "patreon"),
    (Platform::Telegram, "telegram"),
    (Platform::Steam, "steam"),
    (Platform::Web, "web"),
];

impl Platform {
    pub(crate) fn parse(raw: &str) -> Option<Platform> {
        PLATFORMS.iter().find(|(_, word)| *word == raw).map(|(kind, _)| *kind)
    }
    fn word(self) -> &'static str {
        PLATFORMS.iter().find(|(kind, _)| *kind == self).map(|(_, word)| *word).unwrap_or("web")
    }
}

impl Serialize for Platform {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.word())
    }
}

impl<'de> Deserialize<'de> for Platform {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Platform, D::Error> {
        let word = String::deserialize(d)?;
        Ok(Platform::parse(&word).unwrap_or(Platform::Web))
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct SocialLink {
    pub(crate) kind: Platform,
    pub(crate) url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct Socials {
    pub(crate) layout: Layout,
    pub(crate) size: Size,
    pub(crate) links: Vec<SocialLink>,
}

#[derive(Deserialize)]
struct SocialsBody {
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    links: Vec<LinkBody>,
}

#[derive(Deserialize)]
struct LinkBody {
    kind: String,
    url: String,
    #[serde(default)]
    label: String,
}

fn bad_url() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "bad url. http or https, 500 characters at most")
}

fn clean_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > MAX_URL_CHARS {
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
    (kept.chars().count() <= MAX_URL_CHARS).then_some(kept)
}

fn clean_label(raw: &str) -> String {
    clean_text(raw).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_LABEL_CHARS).collect()
}

fn clean_socials(body: SocialsBody) -> Result<Socials, ApiError> {
    let layout = match body.layout.as_deref().map(str::trim) {
        None | Some("") => Layout::Row,
        Some(raw) => Layout::parse(raw).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "bad layout. one of row, grid"))?,
    };
    let size = match body.size.as_deref().map(str::trim) {
        None | Some("") => Size::Medium,
        Some(raw) => Size::parse(raw).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "bad size. one of small, medium, large"))?,
    };
    if body.links.len() > MAX_LINKS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "too many links. 20 at most"));
    }
    let mut links = Vec::with_capacity(body.links.len());
    for link in body.links {
        let kind = Platform::parse(&link.kind.trim().to_lowercase()).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "bad kind"))?;
        let url = clean_url(&link.url).ok_or_else(bad_url)?;
        links.push(SocialLink { kind, url, label: clean_label(&link.label) });
    }
    Ok(Socials { layout, size, links })
}

async fn put_socials(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Json<SocialsBody>, JsonRejection>,
) -> ApiResult {
    let Query(q) = q?;
    let Json(body) = body?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let socials = clean_socials(body)?;
    sqlx::query(
        "INSERT INTO streamers (name, socials) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET socials = EXCLUDED.socials, updated_at = now()",
    )
    .bind(&name)
    .bind(serde_json::to_value(&socials).unwrap_or_else(|_| json!({})))
    .execute(&s.db)
    .await?;
    log::info!("{name}: {} links", socials.links.len());
    Ok(Json(json!({ "name": name, "socials": socials })))
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn one_line(text: &str, max_chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let mut cut: String = flat.chars().take(max_chars - 1).collect();
    cut.push('…');
    cut
}

fn public_url() -> Option<&'static str> {
    static PUBLIC_URL: OnceLock<Option<String>> = OnceLock::new();
    PUBLIC_URL.get_or_init(|| env::var("PUBLIC_URL").ok().and_then(|v| clean_origin(&v))).as_deref()
}

fn clean_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn origin(public_url: Option<&str>, headers: &HeaderMap) -> String {
    if let Some(url) = public_url {
        return url.to_owned();
    }
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("https");
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    format!("{proto}://{host}")
}

enum Card {
    Thumbnail,
    Offline(i64),
    Picture(i64),
    None,
}

fn head_tags(p: &Profile, presence: Presence, card: &Card, origin: &str) -> String {
    let live = presence == Presence::Streaming;
    let title = format!("{} · {}", p.name, if live { "live" } else { "offline" });
    let about = if p.bio.is_empty() {
        match presence {
            Presence::Streaming => "live now",
            Presence::Online => "online, not live",
            Presence::Dnd => "do not disturb, not live",
            Presence::Offline => "not live right now",
        }
        .to_owned()
    } else {
        one_line(&p.bio, 200)
    };
    let url = format!("{origin}/watch/{}", p.name);
    let (image, kind) = match card {
        Card::Thumbnail => (Some(format!("{origin}/thumb/{}.jpg", p.name)), "summary_large_image"),
        Card::Offline(v) => (Some(format!("{origin}/api/streamers/{}/offline?v={v}", p.name)), "summary_large_image"),
        Card::Picture(v) => (Some(format!("{origin}/api/streamers/{}/avatar?v={v}", p.name)), "summary"),
        Card::None => (None, "summary"),
    };
    let (title, about, url) = (escape(&title), escape(&about), escape(&url));
    let mut h = format!(
        "<title>{title}</title>\n\
         <meta name=\"description\" content=\"{about}\">\n\
         <link rel=\"canonical\" href=\"{url}\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:site_name\" content=\"streams\">\n\
         <meta property=\"og:title\" content=\"{title}\">\n\
         <meta property=\"og:description\" content=\"{about}\">\n\
         <meta property=\"og:url\" content=\"{url}\">\n\
         <meta name=\"twitter:card\" content=\"{kind}\">\n\
         <meta name=\"twitter:title\" content=\"{title}\">\n\
         <meta name=\"twitter:description\" content=\"{about}\">\n"
    );
    if let Some(image) = image {
        let image = escape(&image);
        h.push_str(&format!(
            "<meta property=\"og:image\" content=\"{image}\">\n\
             <meta name=\"twitter:image\" content=\"{image}\">\n"
        ));
    }
    h
}

fn card_html(shell: &str, p: &Profile, presence: Presence, card: &Card) -> Option<String> {
    let start = shell.find(TEMPLATE_OPEN)? + TEMPLATE_OPEN.len();
    let end = start + shell[start..].find(TEMPLATE_CLOSE)?;
    let avatar = p
        .avatar
        .map(|v| format!(r#"<img src="/api/streamers/{}/avatar?v={v}" alt="" class="{AVATAR_IMG_CLASS}" draggable="false">"#, p.name))
        .unwrap_or_default();
    let status = if p.bio.is_empty() {
        String::new()
    } else {
        let bio = escape(&p.bio);
        format!(r#"<span class="{STATUS_SPAN_CLASS}" title="{bio}">{bio}</span>"#)
    };
    let banner = match card {
        Card::Offline(v) => format!("background-image:url(/api/streamers/{}/offline?v={v})", p.name),
        _ => String::new(),
    };
    Some(
        shell[start..end]
            .replace("{{avatar}}", &avatar)
            .replace("{{banner}}", &escape(&banner))
            .replace("{{name}}", &escape(&p.name))
            .replace("{{verified}}", if p.verified { VERIFIED_HTML } else { "" })
            .replace("{{status}}", presence.shown())
            .replace("{{tone}}", presence_tone(presence))
            .replace("{{bio}}", &status),
    )
}

fn presence_tone(presence: Presence) -> &'static str {
    match presence {
        Presence::Streaming => "text-primaryBlue",
        Presence::Online => "text-increase",
        Presence::Dnd => "text-decrease",
        Presence::Offline => "text-textSecondary",
    }
}

fn render(shell: &str, p: &Profile, presence: Presence, card: &Card, origin: &str) -> String {
    let mut html = shell.to_owned();
    if let (Some(a), Some(b)) = (html.find("<title>"), html.find("</title>")) {
        if a < b {
            html.replace_range(a..b + "</title>".len(), "");
        }
    }
    if let Some(at) = html.find("</head>") {
        html.insert_str(at, &head_tags(p, presence, card, origin));
    }
    if let Some(filled) = card_html(shell, p, presence, card) {
        html = html.replacen(EMPTY_ROOT, &format!(r#"<div id="root">{filled}</div>"#), 1);
    }
    html
}

async fn read_shell() -> std::io::Result<String> {
    tokio::fs::read_to_string(format!("{}/index.html", pages_dir())).await
}

fn page(status: StatusCode, html: String) -> Response {
    (status, [(header::CACHE_CONTROL, "no-cache")], Html(html)).into_response()
}

fn shared_page(html: String) -> Response {
    let mut res = (StatusCode::OK, [(header::CACHE_CONTROL, WATCH_CACHE)], Html(html)).into_response();
    res.headers_mut().remove(header::SET_COOKIE);
    res
}

async fn watch_page(State(s): State<AppState>, headers: HeaderMap, Path(rest): Path<String>) -> Response {
    let shell = match read_shell().await {
        Ok(shell) => shell,
        Err(e) => {
            log::error!("pages: cannot read index.html in {}: {e}", pages_dir());
            return (StatusCode::SERVICE_UNAVAILABLE, "pages not published yet").into_response();
        }
    };
    let trimmed = rest.trim_matches('/');
    let name = trimmed.to_lowercase();
    if trimmed.contains('/') || !valid_name(&name) {
        return page(StatusCode::NOT_FOUND, shell);
    }
    if let Ok(Some(to)) = auth::renamed_to(&s.db, &name).await {
        return (StatusCode::FOUND, [(header::LOCATION, format!("/watch/{to}")), (header::CACHE_CONTROL, "no-cache".to_owned())]).into_response();
    }
    let (profile, live) = match (load_profile(&s.db, &name).await, is_live(&s, &name).await) {
        (Ok(profile), Ok(live)) => (profile, live),
        (Err(e), _) => {
            log::error!("postgres: {e}");
            return page(StatusCode::OK, shell);
        }
        (_, Err(_)) => return page(StatusCode::OK, shell),
    };
    let card = if live && thumb_exists(&s, &name).await {
        Card::Thumbnail
    } else {
        match (live, profile.offline, profile.avatar) {
            (false, Some(v), _) => Card::Offline(v),
            (_, _, Some(v)) => Card::Picture(v),
            _ => Card::None,
        }
    };
    let presence = match presence::presence_with(&mut s.redis.clone(), &s.db, &name, live).await {
        Ok(presence) => presence,
        Err(_) if live => Presence::Streaming,
        Err(_) => Presence::Offline,
    };
    shared_page(render(&shell, &profile, presence, &card, &origin(public_url(), &headers)))
}

async fn watch_nobody() -> Response {
    match read_shell().await {
        Ok(shell) => page(StatusCode::NOT_FOUND, shell),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "pages not published yet").into_response(),
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/streamers/{name}/avatar", get(get_avatar).put(put_avatar).delete(delete_avatar))
        .route("/api/streamers/{name}/thumbs", get(list_thumbs).put(put_thumb))
        .route("/api/streamers/{name}/thumbs/{id}", get(get_thumb).delete(delete_thumb))
        .layer(DefaultBodyLimit::max(MAX_AVATAR_BYTES))
        .route(
            "/api/streamers/{name}/offline",
            get(get_offline).put(put_offline).delete(delete_offline).layer(DefaultBodyLimit::max(MAX_OFFLINE_BYTES)),
        )
        .route("/api/streamers/{name}/assets", get(list_assets).put(put_asset).layer(DefaultBodyLimit::max(MAX_ASSET_BYTES)))
        .route("/api/streamers/{name}/assets/{id}", get(get_asset).delete(delete_asset))
        .route("/api/streamers/{name}/offline-note", put(put_offline_note))
        .route("/api/streamers/{name}/about", put(put_about))
        .route("/api/streamers/{name}/welcome", put(put_welcome))
        .route("/api/streamers/{name}/socials", put(put_socials).layer(DefaultBodyLimit::max(MAX_SOCIALS_BYTES)))
        .route("/watch/", get(watch_nobody))
        .route("/watch/{*rest}", get(watch_page))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>streams</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <template id="watch-shell"><h1>{{avatar}}{{name}}{{verified}}{{bio}}</h1><div style="{{banner}}"></div><p class="{{tone}}">{{status}}</p></template>
    <div id="root"></div>
  </body>
</html>
"#;

    #[test]
    fn picture_keys_are_under_the_id() {
        let id = Uuid::parse_str("7f3a1b2c-0000-4000-8000-000000000001").unwrap();
        assert_eq!(thumb_key(id, 7), "thumbs/7f3a1b2c-0000-4000-8000-000000000001/7.jpg");
        assert_eq!(avatar_key(id), "avatars/7f3a1b2c-0000-4000-8000-000000000001.jpg");
        assert_eq!(legacy_thumb_key("bob", 7), "thumbs/bob/7.jpg");
        assert_eq!(legacy_avatar_key("bob"), "avatars/bob.jpg");
        assert_eq!(offline_key(id), "offline/7f3a1b2c-0000-4000-8000-000000000001.jpg");
        assert_eq!(asset_key(id, 7, "gif"), "assets/7f3a1b2c-0000-4000-8000-000000000001/7.gif");
        assert_eq!(picture_keys(id, &[7, 9], &[(3, "image/png".into()), (4, "image/svg+xml".into())]).len(), 5);
    }

    #[test]
    fn an_avatar_is_kept_as_a_small_square_jpeg() {
        let img = image::RgbImage::from_fn(400, 240, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut jpeg = Vec::new();
        DynamicImage::ImageRgb8(img).write_to(&mut Cursor::new(&mut jpeg), ImageFormat::Jpeg).unwrap();
        let small = shrink_avatar(&jpeg).unwrap();
        assert!(small.starts_with(&JPEG_MAGIC));
        let back = image::load_from_memory_with_format(&small, ImageFormat::Jpeg).unwrap();
        assert_eq!((back.width(), back.height()), (AVATAR_SIDE, AVATAR_SIDE));
        assert_eq!(shrink_avatar(&[0xFF, 0xD8, 0xFF, 0x00]), Err(NOT_A_JPEG));
    }

    #[test]
    fn a_scene_picture_is_what_its_first_bytes_say() {
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]).map(|k| k.mime), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]).map(|k| k.ext), Some("jpg"));
        assert_eq!(sniff(b"GIF89a\x01\x00").map(|k| k.mime), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ").map(|k| k.mime), Some("image/webp"));
        assert!(sniff(b"RIFF\x00\x00\x00\x00WAVEfmt ").is_none());
        assert!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\">").is_none());
        assert!(sniff(b"").is_none());
        assert_eq!(kind_of("image/gif").map(|k| k.ext), Some("gif"));
        assert!(kind_of("text/html").is_none());
    }

    fn profile(bio: &str, avatar: Option<i64>, verified: bool) -> Profile {
        Profile { name: "bob".into(), bio: bio.into(), avatar, verified, oauth_verified: false, offline: None, offline_note: String::new(), joined: None, socials: Socials::default(), about: String::new(), welcome_on: true, welcome: DEFAULT_WELCOME.into() }
    }

    #[test]
    fn live_with_thumbnail() {
        let html = render(SHELL, &profile("hi <all>", None, true), Presence::Streaming, &Card::Thumbnail, "https://1.2.3.4");
        assert_eq!(html.matches("<title>").count(), 1);
        assert!(html.contains("<title>bob · live</title>"));
        assert!(html.contains(r#"og:image" content="https://1.2.3.4/thumb/bob.jpg""#));
        assert!(html.contains(r#"twitter:card" content="summary_large_image""#));
        assert!(html.contains(r#"og:description" content="hi &lt;all&gt;""#));
        assert!(html.contains(r#"<div id="root"><h1>bob<span class="ml-2 text-increase""#));
        assert!(html.contains(r#"<p class="text-primaryBlue">streaming</p>"#));
        assert!(html.contains(&format!(r#"<span class="{STATUS_SPAN_CLASS}" title="hi &lt;all&gt;">hi &lt;all&gt;</span></h1>"#)));
        assert!(html.contains(r#"<div style=""></div>"#));
        assert!(html.find("<meta charset").unwrap() < html.find("og:title").unwrap());
        assert!(html.find("og:title").unwrap() < html.find("</head>").unwrap());
        assert!(html.contains("/assets/index-abc.js"));
    }

    #[test]
    fn offline_with_picture() {
        let html = render(SHELL, &profile("", Some(1700000000), false), Presence::Offline, &Card::Picture(1700000000), "https://x");
        assert!(html.contains("<title>bob · offline</title>"));
        assert!(html.contains(r#"og:description" content="not live right now""#));
        assert!(html.contains(r#"og:image" content="https://x/api/streamers/bob/avatar?v=1700000000""#));
        assert!(html.contains(r#"twitter:card" content="summary""#));
        assert!(html.contains(r#"<img src="/api/streamers/bob/avatar?v=1700000000" alt="" class=""#));
        assert!(html.contains(r#"<p class="text-textSecondary">offline</p>"#));
        assert!(!html.contains(STATUS_SPAN_CLASS));
        let root = &html[html.find(r#"<div id="root">"#).unwrap()..];
        assert!(!root.contains("{{"));
    }

    #[test]
    fn offline_with_an_offline_picture() {
        let mut p = profile("", Some(1700000000), false);
        p.offline = Some(1700000001);
        let html = render(SHELL, &p, Presence::Offline, &Card::Offline(1700000001), "https://x");
        assert!(html.contains(r#"og:image" content="https://x/api/streamers/bob/offline?v=1700000001""#));
        assert!(html.contains(r#"twitter:card" content="summary_large_image""#));
        assert!(html.contains(r#"<img src="/api/streamers/bob/avatar?v=1700000000" alt="""#));
        assert!(html.contains(r#"<div style="background-image:url(/api/streamers/bob/offline?v=1700000001)"></div>"#));
    }

    #[test]
    fn notes_are_one_line_and_capped() {
        assert_eq!(clean_note("  back\n\ttuesday   8pm  "), "back tuesday 8pm");
        assert_eq!(clean_note("").len(), 0);
        assert_eq!(clean_note(&"x".repeat(300)).chars().count(), MAX_NOTE_CHARS);
    }

    #[test]
    fn about_me_keeps_its_paragraphs_and_is_capped() {
        assert_eq!(clean_about("  hi\n\nthere\n\n\n\nall\u{200b}  "), "hi\n\nthere\n\nall");
        assert_eq!(clean_about("").len(), 0);
        assert_eq!(clean_about(&"x".repeat(3000)).chars().count(), MAX_ABOUT_CHARS);
    }

    #[test]
    fn a_welcome_is_cleaned_capped_and_never_empty() {
        assert_eq!(clean_welcome("  hi\u{200b} all  "), "hi all");
        assert_eq!(clean_welcome(""), DEFAULT_WELCOME);
        assert_eq!(clean_welcome(" \n\u{200b} "), DEFAULT_WELCOME);
        assert_eq!(clean_welcome(&"x".repeat(400)).chars().count(), MAX_WELCOME_CHARS);
        assert_eq!(clean_welcome(&format!("{} y", "x".repeat(MAX_WELCOME_CHARS - 1))), "x".repeat(MAX_WELCOME_CHARS - 1));
    }

    #[test]
    fn a_link_is_http_with_a_host_and_nothing_else() {
        assert_eq!(clean_url(" https://twitch.tv/bob ").as_deref(), Some("https://twitch.tv/bob"));
        assert_eq!(clean_url("HTTP://Example.COM").as_deref(), Some("http://example.com/"));
        for bad in ["javascript:alert(1)", "data:text/html,hi", "twitch.tv/bob", "/watch/bob", "https://", "ftp://x.com/a", "https://twitch.tv@evil.example/", "https://bob:pw@x.com/", ""] {
            assert!(clean_url(bad).is_none(), "{bad:?} got through");
        }
        assert!(clean_url(&format!("https://x.com/{}", "a".repeat(MAX_URL_CHARS))).is_none());
    }

    #[test]
    fn the_document_is_checked_at_the_door() {
        let link = |kind: &str, url: &str, label: &str| LinkBody { kind: kind.into(), url: url.into(), label: label.into() };
        let body = |links: Vec<LinkBody>| SocialsBody { layout: None, size: None, links };
        let doc = clean_socials(SocialsBody {
            layout: Some("grid".into()),
            size: Some("large".into()),
            links: vec![link("youtube", "https://youtube.com/@bob", "  my\u{200b}   channel "), link("WEB", "https://example.com", "")],
        })
        .unwrap();
        assert_eq!((doc.layout, doc.size), (Layout::Grid, Size::Large));
        assert_eq!(doc.links[0].label, "my channel");
        assert_eq!(doc.links[1].kind, Platform::Web);
        assert_eq!(doc.links[1].url, "https://example.com/");
        let empty = clean_socials(body(vec![])).unwrap();
        assert_eq!(empty, Socials::default());
        assert_eq!((empty.layout, empty.size), (Layout::Row, Size::Medium));
        assert_eq!(clean_socials(body(vec![link("myspace", "https://x.com", "")])).unwrap_err().message(), "bad kind");
        assert_eq!(clean_socials(body(vec![link("web", "javascript:alert(1)", "")])).unwrap_err().message(), "bad url. http or https, 500 characters at most");
        assert_eq!(clean_socials(body((0..=MAX_LINKS).map(|_| link("web", "https://x.com", "")).collect())).unwrap_err().message(), "too many links. 20 at most");
        assert_eq!(clean_socials(SocialsBody { layout: Some("spiral".into()), size: None, links: vec![] }).unwrap_err().message(), "bad layout. one of row, grid");
        assert_eq!(clean_socials(SocialsBody { layout: None, size: Some("huge".into()), links: vec![] }).unwrap_err().message(), "bad size. one of small, medium, large");
        assert_eq!(clean_label(&"y".repeat(100)).chars().count(), MAX_LABEL_CHARS);
        let json = serde_json::to_value(&doc).unwrap();
        assert!(json["links"][1].get("label").is_none());
        assert_eq!(serde_json::from_value::<Socials>(json).unwrap(), doc);
        let odd: Socials = serde_json::from_value(json!({ "layout": "row", "size": "small", "links": [{ "kind": "myspace", "url": "https://x.com/" }] })).unwrap();
        assert_eq!((odd.links[0].kind, odd.links[0].label.as_str(), odd.size), (Platform::Web, "", Size::Small));
        assert_eq!(serde_json::from_value::<Socials>(Value::Null).unwrap_or_default(), Socials::default());
    }

    #[test]
    fn offline_without_anything() {
        let html = render(SHELL, &profile("", None, false), Presence::Offline, &Card::None, "https://x");
        assert!(!html.contains("og:image"));
        assert!(html.contains(r#"<div id="root"><h1>bob</h1>"#));
    }

    #[test]
    fn online_but_not_live() {
        let html = render(SHELL, &profile("", None, false), Presence::Online, &Card::None, "https://x");
        assert!(html.contains("<title>bob · offline</title>"));
        assert!(html.contains(r#"og:description" content="online, not live""#));
        assert!(html.contains(r#"<p class="text-increase">online</p>"#));
        let dnd = render(SHELL, &profile("", None, false), Presence::Dnd, &Card::None, "https://x");
        assert!(dnd.contains(r#"og:description" content="do not disturb, not live""#));
        assert!(dnd.contains(r#"<p class="text-decrease">do not disturb</p>"#));
    }

    #[test]
    fn no_template_still_gets_a_head() {
        let shell = SHELL.replace(r#"<template id="watch-shell">"#, "<template>");
        let html = render(&shell, &profile("", None, false), Presence::Streaming, &Card::None, "https://x");
        assert!(html.contains("<title>bob · live</title>"));
        assert!(html.contains(EMPTY_ROOT));
    }

    #[test]
    fn bio_is_one_line_and_cut() {
        assert_eq!(one_line("a\n\n  b   c", 200), "a b c");
        let long = "x".repeat(300);
        let cut = one_line(&long, 200);
        assert_eq!(cut.chars().count(), 200);
        assert!(cut.ends_with('…'));
    }

    fn header<'a>(res: &'a Response, name: header::HeaderName) -> Option<&'a str> {
        res.headers().get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn only_a_rendered_watch_page_is_shared() {
        let shared = shared_page(SHELL.into());
        assert_eq!(shared.status(), StatusCode::OK);
        assert_eq!(header(&shared, header::CACHE_CONTROL), Some("public, max-age=0, s-maxage=15, must-revalidate"));
        assert!(shared.headers().get(header::SET_COOKIE).is_none());
        let missing = page(StatusCode::NOT_FOUND, SHELL.into());
        assert_eq!(header(&missing, header::CACHE_CONTROL), Some("no-cache"));
        assert!(missing.headers().get(header::SET_COOKIE).is_none());
        let fallback = page(StatusCode::OK, SHELL.into());
        assert_eq!(header(&fallback, header::CACHE_CONTROL), Some("no-cache"));
    }

    #[test]
    fn the_origin_is_public_url_when_set() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "evil.example".parse().unwrap());
        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        let public = clean_origin(" https://nodentity.xyz/ ");
        assert_eq!(public.as_deref(), Some("https://nodentity.xyz"));
        assert_eq!(origin(public.as_deref(), &headers), "https://nodentity.xyz");
        assert_eq!(clean_origin("  "), None);
        assert_eq!(origin(None, &headers), "http://evil.example");
        assert_eq!(origin(None, &HeaderMap::new()), "https://localhost");
    }

    #[test]
    fn escaping() {
        assert_eq!(escape(r#"<a href="x">'&'</a>"#), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    }
}
