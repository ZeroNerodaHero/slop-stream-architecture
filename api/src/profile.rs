//! The profile picture, and the one html route: the watch document.
//!
//! The picture is a small jpeg the browser makes from whatever file was picked
//! (256x256, see the live page) and is stored in the bucket at `avatars/<id>.jpg`,
//! keyed by the row's id (docs/ids.md), so a name can change and nothing moves.
//! The streamers row only keeps when it was saved. That time is the `?v=` of the
//! url, so it is cached for a day and still changes the moment a new one is saved.
//! A picture saved before ids sits at `avatars/<name>.jpg`, and one saved before the
//! bucket is bytes still in the row: either is served from where it is and copied to
//! the id's key on that read. Only the name's owner may change it, the same rule as
//! the bio.
//!
//! Thumbnails are the pictures on that name's card on home: up to six, each a
//! 640x360 jpeg the browser made, at `thumbs/<id>/<n>.jpg` (before ids:
//! `thumbs/<name>/<n>.jpg`, lifted the same way). The row is written first and
//! dropped again if the bucket does not take the bytes. None means home shows the
//! camera, the way it always has.
//!
//! The offline picture is what the watch page shows where the player would be while the
//! name is not live: a 1280x720 jpeg the browser made, at `offline/<id>.jpg`, its save time
//! in `offline_at` as the `?v=`. Newer than ids, so there is no name key to lift. With it
//! goes a line under the word, `offline_note`. Both through the bio's gate.
//!
//! `GET /watch/<name>` exists for link previews. iMessage, Discord, Slack and X
//! make them with a bot that fetches the url once, reads `<title>` and the
//! `og:*` tags, and never runs js; the spa's index.html says "streams" for
//! every page. So caddy sends `/watch/*` here instead of to the files, and
//! this answers with the same index.html, read from the pages volume so the
//! hashed asset names are always the current ones, with a real head for this
//! one name. The profile card in its `<template id="watch-shell">` is filled
//! in and put inside `#root`, so the page shows the name, picture, status and
//! bio before react boots. React replaces the card when it renders.

use std::collections::HashMap;
use std::env;

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, JsonRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{self, Me};
use crate::presence::{self, Presence};
use crate::s3;
use crate::{is_live, may_write, thumb_exists, unique_violation, valid_name, ApiError, ApiResult, AppState, Name, PasswordQuery};

/// The browser sends 256x256 at quality 0.85, a few tens of kb. This is the ceiling.
/// A thumbnail is 640x360 and shares it: the same body limit covers both routes.
const MAX_AVATAR_BYTES: usize = 256 * 1024;
/// The offline picture is 1280x720 at quality 0.8, and a photo at that size runs past the
/// avatar's ceiling. The page steps the quality down until it fits under this one.
const MAX_OFFLINE_BYTES: usize = 512 * 1024;
/// The line under the word while they are not live. One line; the page's box stops here too.
const MAX_NOTE_CHARS: usize = 140;
/// How many pictures one name may put on its home card.
const MAX_THUMBS: i64 = 6;
/// The url changes with every upload (`?v=`), so a day is safe.
const AVATAR_CACHE: &str = "public, max-age=86400";
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];

/// The markup the api itself emits into the card. The classes are tailwind's, generated
/// because the same strings appear in the pages (`Avatar.tsx`, `WatchPage.tsx`).
const AVATAR_IMG_CLASS: &str = "mr-3 inline-block h-10 w-10 border border-primaryStroke object-cover align-middle";
const VERIFIED_HTML: &str = r#"<span class="ml-2 text-increase" title="has an account: this really is them">✓</span>"#;
const TEMPLATE_OPEN: &str = r#"<template id="watch-shell">"#;
const TEMPLATE_CLOSE: &str = "</template>";
const EMPTY_ROOT: &str = r#"<div id="root"></div>"#;

/// Where the pages one-shot copies the vite build. The same volume caddy serves from.
fn pages_dir() -> String {
    env::var("PAGES_DIR").unwrap_or_else(|_| "/srv".into())
}

// ---- the profile row -------------------------------------------------------------

pub(crate) struct Profile {
    pub(crate) name: String,
    pub(crate) bio: String,
    /// When the picture was saved, unix seconds. None: no picture. The `?v=` of its url.
    pub(crate) avatar: Option<i64>,
    /// The name has an account, so only its owner can be behind it.
    pub(crate) verified: bool,
    /// When the offline picture was saved, unix seconds. None: none. The `?v=` of its url.
    pub(crate) offline: Option<i64>,
    /// The line under the word while they are not live. Empty for none.
    pub(crate) offline_note: String,
}

/// Bio, picture versions, account flag and the offline line in one query. A name nobody saved anything for is all defaults.
pub(crate) async fn load_profile(db: &PgPool, name: &str) -> Result<Profile, sqlx::Error> {
    let row: Option<(String, Option<i64>, bool, Option<i64>, String)> = sqlx::query_as(
        "SELECT bio, (EXTRACT(EPOCH FROM avatar_at))::bigint, password_hash IS NOT NULL,
                (EXTRACT(EPOCH FROM offline_at))::bigint, offline_note
         FROM streamers WHERE name = $1",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    let (bio, avatar, verified, offline, offline_note) = row.unwrap_or_default();
    Ok(Profile { name: name.to_owned(), bio, avatar, verified, offline, offline_note })
}

// ---- the row behind a name ---------------------------------------------------------------

/// The id of the name's row, if it has one.
async fn row_id(db: &PgPool, name: &str) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(name).fetch_optional(db).await
}

/// The id of the name's row, made bare if it had none: a picture needs a key before the
/// bytes go up. The `DO UPDATE` is the idiom that makes `RETURNING` answer for a row already there.
async fn ensure_row(db: &PgPool, name: &str) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO streamers (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    )
    .bind(name)
    .fetch_one(db)
    .await
}

// ---- the picture ---------------------------------------------------------------------

fn avatar_key(id: Uuid) -> String {
    format!("avatars/{id}.jpg")
}

/// Where a picture saved before ids sits. Read from, lifted out of, never written.
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

/// The bytes at `from`, if any, copied to `to` and gone from `from`. For the pictures saved
/// before ids: a read serves them from where they are and moves them, so the next read, and
/// a rename, find them under the id. The bucket has no copy, so this is a get and a put.
async fn lift_object(s: &AppState, from: &str, to: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(bytes) = s3::get(&s.s3, from).await? else { return Ok(None) };
    s3::put(&s.s3, to, &bytes, "image/jpeg").await?;
    if let Err(e) = s3::delete(&s.s3, from).await {
        log::warn!("s3: {from} is at {to} now, but the old copy stayed: {e}");
    }
    Ok(Some(bytes))
}

async fn get_avatar(State(s): State<AppState>, Name(name): Name) -> Result<Response, ApiError> {
    // avatar_at set, or bytes still in the row from before the bucket: there is a picture.
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
        // not under the id: saved before ids (at the name's key), or before the bucket (in the row)
        Ok(None) => match lift_object(&s, &legacy_avatar_key(&name), &key).await {
            Ok(Some(bytes)) => Ok(jpeg(bytes)),
            Ok(None) => match legacy {
                Some(bytes) => {
                    lift_legacy(&s, id, &name, &bytes).await;
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

/// A picture from before the bucket. Copy it up and drop the postgres bytes. A miss
/// here still serves the row: the next read tries again.
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

/// Before a rename (auth.rs): every picture of this name that still sits at a name key moves
/// to the id's, so nothing in the bucket says the name when it changes. Best effort: a miss
/// is logged, and the read path lifts what is left on its next look.
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

/// Every key a row's pictures can sit under: for a rename that takes a free name's row away.
pub(crate) fn picture_keys(id: Uuid, thumbs: &[i64]) -> Vec<String> {
    [avatar_key(id), offline_key(id)].into_iter().chain(thumbs.iter().map(|n| thumb_key(id, *n))).collect()
}

/// Objects nobody can reach any more, dropped. Best effort: a miss leaves an orphan, nothing worse.
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

/// The body as the jpeg it has to be: not a form, under `max` (the route's read limit stopped
/// an oversized one already, and that reads as the same 413 here), and starting like a jpeg.
/// The page resizes before sending, so this is all the api ever checks of a picture.
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

/// The route's body limit stops reading at the ceiling, so an oversized upload costs nothing past it.
async fn put_avatar(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = jpeg_body(body, MAX_AVATAR_BYTES, too_big)?;
    // the row's id is the key, so the row first (bare, if the name had none). then the
    // bucket, then the version: a failed save leaves the old version number, so a cached
    // url does not start pointing at a picture that never landed.
    let id = ensure_row(&s.db, &name).await?;
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
    // under the id, and under the name for one saved before ids
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
    Ok(StatusCode::NO_CONTENT)
}

// ---- thumbnails --------------------------------------------------------------------------

fn thumb_key(id: Uuid, n: i64) -> String {
    format!("thumbs/{id}/{n}.jpg")
}

/// Where a thumbnail saved before ids sits. Read from, lifted out of, never written.
fn legacy_thumb_key(name: &str, n: i64) -> String {
    format!("thumbs/{name}/{n}.jpg")
}

/// A name from a path that also carries an id. `Name` only fits a path with the one segment.
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

/// 53 bits, so the id survives a js number. Never 0.
fn new_thumb_id() -> i64 {
    ((OsRng.next_u64() >> 11) as i64).max(1)
}

/// Ids for these names, oldest first. A name with none is absent.
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
        // saved before ids: at the name's key, moved to the id's on this read
        Ok(None) => match lift_object(&s, &legacy_thumb_key(&name, n), &key).await {
            Ok(Some(bytes)) => Ok(jpeg(bytes)),
            Ok(None) => Err(no_thumbnail()),
            Err(e) => Err(thumb_failed(&name, "could not load the picture", e)),
        },
        Err(e) => Err(thumb_failed(&name, "could not load the picture", e)),
    }
}

/// The row first, then the bytes. A bucket miss drops the row, so home never lists a
/// picture that is not there. A failed save of a later one does not touch the rest.
/// The cap is counted and the row written under a lock on the name, so two saves at
/// once cannot both land as the seventh.
async fn put_thumb(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = jpeg_body(body, MAX_AVATAR_BYTES, too_big)?;
    // the row's id is the key in the bucket; the thumbs table still lists them by name
    let row = ensure_row(&s.db, &name).await?;
    for _ in 0..2 {
        let id = new_thumb_id();
        // the cap is a count in the insert's own statement, but a statement only sees rows
        // committed before it began: two puts at five would both see 5 < 6 and both land.
        // the lock is per name and lasts until the transaction ends, so the second waits
        // for the first to commit and counts its row
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
            // a failed statement aborts the transaction: end it, and the next pass opens a new one
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
    // the object first, under the id and under the name (one saved before ids). a miss
    // there leaves the row, so the next try removes it
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
    Ok(StatusCode::NO_CONTENT)
}

// ---- the offline picture and the line under the word ----------------------------------------

fn offline_key(id: Uuid) -> String {
    format!("offline/{id}.jpg")
}

fn offline_failed(name: &str, what: &str, err: String) -> ApiError {
    log::error!("s3 offline {name}: {err}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what)
}

fn offline_too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big. 512 kb at most")
}

async fn get_offline(State(s): State<AppState>, Name(name): Name) -> Result<Response, ApiError> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND offline_at IS NOT NULL")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    let Some(id) = id else {
        return Err(no_picture());
    };
    match s3::get(&s.s3, &offline_key(id)).await {
        Ok(Some(bytes)) => Ok(jpeg(bytes)),
        Ok(None) => Err(no_picture()),
        Err(e) => Err(offline_failed(&name, "could not load the picture", e)),
    }
}

/// The same shape as the avatar's save, with its own ceiling: the bucket first, then the version,
/// so a cached url never points at a picture that did not land.
async fn put_offline(
    State(s): State<AppState>,
    Name(name): Name,
    me: Me,
    q: Result<Query<PasswordQuery>, QueryRejection>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let Query(q) = q?;
    may_write(&s, &name, me.name(), q.password.as_deref()).await?;
    let body = jpeg_body(body, MAX_OFFLINE_BYTES, offline_too_big)?;
    let id = ensure_row(&s.db, &name).await?;
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
    // the object first: a miss there leaves the version, so the next try removes it
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

/// The note as it is kept: one line (any run of whitespace is a space), MAX_NOTE_CHARS at most.
fn clean_note(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NOTE_CHARS).collect()
}

/// `{ note }`: the line under the word while they are not live. Empty clears it. The bio's
/// upsert, so a name nobody saved anything for gets its row here too.
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

// ---- the watch document ------------------------------------------------------------------

/// Text into html: safe inside a tag and inside a double-quoted attribute.
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

/// A bio as one line for a preview card. Bots show about 200 characters.
fn one_line(text: &str, max_chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let mut cut: String = flat.chars().take(max_chars - 1).collect();
    cut.push('…');
    cut
}

/// `https://<host>` as the browser sees it. Caddy keeps the Host header and sets the proto.
fn origin(headers: &HeaderMap) -> String {
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("https");
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    format!("{proto}://{host}")
}

/// What the picture in the card is: the stream itself while live and a thumbnail exists, else
/// the offline picture while not live, else the profile picture, else nothing. The two wide
/// ones show big (`summary_large_image`); the profile picture is a square beside the words.
enum Card {
    Thumbnail,
    Offline(i64),
    Picture(i64),
    None,
}

/// The title keeps `live|offline`: it is about the stream, and previews are cached for hours.
/// The description with no bio says the presence word too: a watcher deciding whether to wait.
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

/// The `<template id="watch-shell">` of index.html with the placeholders filled in.
/// None if the pages have no such template (an older build): the head alone still works.
fn card_html(shell: &str, p: &Profile, presence: Presence, card: &Card) -> Option<String> {
    let start = shell.find(TEMPLATE_OPEN)? + TEMPLATE_OPEN.len();
    let end = start + shell[start..].find(TEMPLATE_CLOSE)?;
    let avatar = p
        .avatar
        .map(|v| format!(r#"<img src="/api/streamers/{}/avatar?v={v}" alt="" class="{AVATAR_IMG_CLASS}" draggable="false">"#, p.name))
        .unwrap_or_default();
    // the box where the player goes: the offline picture over it while they are not live and
    // have one, else black. an inline style, so an api older than the placeholder leaves words
    // the browser ignores, not words on the page
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
            .replace("{{bio}}", &escape(&p.bio)),
    )
}

/// The same colours the pages give the four words (`presence-atoms.ts`).
fn presence_tone(presence: Presence) -> &'static str {
    match presence {
        Presence::Streaming => "text-primaryBlue",
        Presence::Online => "text-increase",
        Presence::Dnd => "text-decrease",
        Presence::Offline => "text-textSecondary",
    }
}

/// index.html with its head replaced for this name and the card inside `#root`.
fn render(shell: &str, p: &Profile, presence: Presence, card: &Card, origin: &str) -> String {
    let mut html = shell.to_owned();
    // one title: ours, not the "streams" of every other page
    if let (Some(a), Some(b)) = (html.find("<title>"), html.find("</title>")) {
        if a < b {
            html.replace_range(a..b + "</title>".len(), "");
        }
    }
    // after everything else in the head, so <meta charset> stays in the first bytes
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

/// Caddy sends every `/watch/*` here. The rest of the path is the name, with or without a
/// trailing slash. Anything else is still the spa, with a 404, so a mistyped link shows the
/// page's own "bad name" instead of json.
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
    // a name somebody renamed away from leads to the new one while it is held (docs/ids.md):
    // a shared link keeps working, and the preview bots follow a redirect
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
            // the offline picture is for a page with no player on it: live without a thumbnail yet shows the face
            (false, Some(v), _) => Card::Offline(v),
            (_, _, Some(v)) => Card::Picture(v),
            _ => Card::None,
        }
    };
    // the word beside the name: live is known; here and the choice come from redis and the row.
    // a redis that does not answer leaves the two words the page always had
    let presence = match presence::presence_with(&mut s.redis.clone(), &s.db, &name, live).await {
        Ok(presence) => presence,
        Err(_) if live => Presence::Streaming,
        Err(_) => Presence::Offline,
    };
    page(StatusCode::OK, render(&shell, &profile, presence, &card, &origin(&headers)))
}

/// `/watch/` with nothing after it: the spa's own not-found page.
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
        // the picture's ceiling is the read limit too: past it the body is dropped, not buffered
        .layer(DefaultBodyLimit::max(MAX_AVATAR_BYTES))
        // after that layer, so the wider picture gets its own ceiling and nothing else does
        .route(
            "/api/streamers/{name}/offline",
            get(get_offline).put(put_offline).delete(delete_offline).layer(DefaultBodyLimit::max(MAX_OFFLINE_BYTES)),
        )
        .route("/api/streamers/{name}/offline-note", put(put_offline_note))
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
    <template id="watch-shell"><h1>{{avatar}}{{name}}{{verified}}</h1><div style="{{banner}}"></div><p class="{{tone}}">{{status}}</p><p>{{bio}}</p></template>
    <div id="root"></div>
  </body>
</html>
"#;

    #[test]
    fn picture_keys_are_under_the_id() {
        let id = Uuid::parse_str("7f3a1b2c-0000-4000-8000-000000000001").unwrap();
        assert_eq!(thumb_key(id, 7), "thumbs/7f3a1b2c-0000-4000-8000-000000000001/7.jpg");
        assert_eq!(avatar_key(id), "avatars/7f3a1b2c-0000-4000-8000-000000000001.jpg");
        // the ones from before ids, read and lifted, never written
        assert_eq!(legacy_thumb_key("bob", 7), "thumbs/bob/7.jpg");
        assert_eq!(legacy_avatar_key("bob"), "avatars/bob.jpg");
        assert_eq!(offline_key(id), "offline/7f3a1b2c-0000-4000-8000-000000000001.jpg");
        assert_eq!(picture_keys(id, &[7, 9]).len(), 4);
    }

    fn profile(bio: &str, avatar: Option<i64>, verified: bool) -> Profile {
        Profile { name: "bob".into(), bio: bio.into(), avatar, verified, offline: None, offline_note: String::new() }
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
        assert!(html.contains("<p>hi &lt;all&gt;</p>"));
        // the player's box stays black: the stream goes there
        assert!(html.contains(r#"<div style=""></div>"#));
        // the head came after the charset, before </head>, and the script is still there
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
        // every placeholder in the card is filled; the inert <template> keeps its own
        let root = &html[html.find(r#"<div id="root">"#).unwrap()..];
        assert!(!root.contains("{{"));
    }

    #[test]
    fn offline_with_an_offline_picture() {
        let mut p = profile("", Some(1700000000), false);
        p.offline = Some(1700000001);
        let html = render(SHELL, &p, Presence::Offline, &Card::Offline(1700000001), "https://x");
        // the wide picture is the card, big; the face stays beside the name; the player's box is the picture
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
    fn offline_without_anything() {
        let html = render(SHELL, &profile("", None, false), Presence::Offline, &Card::None, "https://x");
        assert!(!html.contains("og:image"));
        assert!(html.contains(r#"<div id="root"><h1>bob</h1>"#));
    }

    #[test]
    fn online_but_not_live() {
        let html = render(SHELL, &profile("", None, false), Presence::Online, &Card::None, "https://x");
        // the title is about the stream; the description and the card say they are around
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

    #[test]
    fn escaping() {
        assert_eq!(escape(r#"<a href="x">'&'</a>"#), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    }
}
