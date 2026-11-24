use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::Me;
use crate::media::{self, Kind};
use crate::moderate::{self, UploadKind};
use crate::s3;
use crate::{ApiError, ApiResult, AppState};

const MAX_BYTES: usize = 256 * 1024;
const RATE_PER_WINDOW: i64 = 30;
const RATE_WINDOW_SECS: i64 = 600;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/chat-images", post(upload))
        .route("/api/chat-images/{id}", get(show).delete(take_down))
        .layer(DefaultBodyLimit::max(MAX_BYTES))
}

async fn upload(State(s): State<AppState>, Me(me): Me, headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "log in to send a picture"))?;
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big"));
        }
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    if body.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "empty picture"));
    }
    let Some(mime) = kind(&body) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a picture"));
    };
    moderate::refuse_animated(&body)?;
    crate::auth::limit(&s, &format!("rl:chatimg:{}", me.id), RATE_WINDOW_SECS, RATE_PER_WINDOW, "slow down").await?;
    let id = store(&s, &me, UploadKind::ChatImage, mime, &body, crate::ratelimit::forwarded_ip(&headers).as_deref()).await?;
    Ok(Json(json!({ "id": id })))
}

pub(crate) async fn store(s: &AppState, me: &crate::auth::Account, kind: UploadKind, mime: &str, body: &[u8], ip: Option<&str>) -> Result<Uuid, ApiError> {
    let sha = media::sha256_hex(body);
    let passed = moderate::check(s, moderate::Upload { kind, who: Some(me.id), ip, mime, key: None, sha: Some(&sha) }, body).await?;
    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO chat_images (id, mime, created_by, sha256, uploader_ip, nsfw, graphic, moderated) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(mime)
    .bind(me.id)
    .bind(&sha)
    .bind(ip)
    .bind(passed.nsfw)
    .bind(passed.graphic)
    .bind(passed.checked)
    .fetch_one(&s.db)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::warn!("{}: chat picture row: {e}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the picture"));
        }
    };
    if let Err(e) = s3::put(&s.s3, &key_of(id, mime), body, mime).await {
        let _ = sqlx::query("DELETE FROM chat_images WHERE id = $1").bind(id).execute(&s.db).await;
        log::warn!("{}: chat picture: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not save the picture"));
    }
    moderate::set_key(&s.db, passed.row, &key_of(id, mime)).await;
    Ok(id)
}

#[derive(Deserialize, Default)]
struct ShowQuery {
    show: Option<String>,
}

const SENSITIVE: &str = "sensitive";

pub(crate) type ShownFacts = (String, bool, bool, Option<Uuid>, bool, Option<bool>);

pub(crate) async fn shown_facts(db: &sqlx::PgPool, id: Uuid) -> Result<Option<ShownFacts>, sqlx::Error> {
    sqlx::query_as(
        "SELECT i.mime, i.nsfw, i.graphic, i.created_by, i.posted_kind IS NOT DISTINCT FROM 'group',
                (SELECT g.adult_content FROM groups g WHERE g.name = i.posted_group)
         FROM chat_images i WHERE i.id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn show(State(s): State<AppState>, Me(me): Me, Path(id): Path<String>, q: Result<Query<ShowQuery>, axum::extract::rejection::QueryRejection>) -> Result<Response, ApiError> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    };
    let viewer = me.map(|m| m.id);
    let Some(access) = media::access(&s.db, Kind::Image, id, viewer).await? else {
        return Err(media::missing(&s.db, Kind::Image, id).await);
    };
    if let Some(no) = media::refused(&access) {
        return Err(no);
    }
    let Some((mime, nsfw, graphic, by, in_group, adult_now)) = shown_facts(&s.db, id).await? else {
        return Err(media::missing(&s.db, Kind::Image, id).await);
    };
    let uploader = viewer.is_some() && by == viewer;
    let site_admin = viewer.is_some_and(|v| s.admins.iter().any(|a| a.id == v));
    if moderate::hidden(nsfw, in_group, adult_now.unwrap_or(false), uploader || site_admin) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, moderate::HIDDEN));
    }
    let shown = q.ok().and_then(|Query(q)| q.show).is_some_and(|v| v == "1");
    if (nsfw || graphic) && !shown && !uploader {
        return Err(ApiError::new(StatusCode::CONFLICT, SENSITIVE));
    }
    let bytes = match s3::get(&s.s3, &key_of(id, &mime)).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(ApiError::new(StatusCode::NOT_FOUND, "no such picture")),
        Err(e) => {
            log::warn!("chat picture {id}: {e}");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not load the picture"));
        }
    };
    let mut out = HeaderMap::new();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    media::headers_cached(&mut out, access == media::Access::Public, media::IMMUTABLE_CACHE);
    Ok((out, bytes).into_response())
}

async fn take_down(State(s): State<AppState>, Me(me): Me, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let me = admin(&s, me)?;
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    };
    let mime: Option<String> = sqlx::query_scalar("SELECT mime FROM chat_images WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some(mime) = mime else {
        return Err(media::missing(&s.db, Kind::Image, id).await);
    };
    remove(&s, &me, id, &mime).await?;
    log::info!("{}: took down chat picture {id}", me.name);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn remove(s: &AppState, me: &crate::auth::Account, id: Uuid, mime: &str) -> Result<(), ApiError> {
    let posted: Option<String> = sqlx::query_scalar("SELECT posted_kind FROM chat_images WHERE id = $1").bind(id).fetch_optional(&s.db).await?.flatten();
    if let Err(e) = s3::delete(&s.s3, &key_of(id, mime)).await {
        log::warn!("{}: take down chat picture {id}: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not delete the picture"));
    }
    media::remember_removed(&s.db, Kind::Image, id, me.id).await?;
    sqlx::query("DELETE FROM chat_images WHERE id = $1").bind(id).execute(&s.db).await?;
    if posted.as_deref() == Some("stream") {
        crate::cf_purge::purge(vec![format!("/api/chat-images/{id}")]);
    }
    Ok(())
}

pub(crate) async fn discard(s: &AppState, id: Uuid, mime: &str) {
    if let Err(e) = s3::delete(&s.s3, &key_of(id, mime)).await {
        log::warn!("discard chat picture {id}: {e}");
    }
    let _ = sqlx::query("DELETE FROM chat_images WHERE id = $1").bind(id).execute(&s.db).await;
}

pub(crate) fn admin(s: &AppState, me: Option<crate::auth::Account>) -> Result<crate::auth::Account, ApiError> {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    if s.admins.iter().any(|a| a.id == me.id) {
        Ok(me)
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, "admins only"))
    }
}

fn key_of(id: Uuid, mime: &str) -> String {
    let ext = if mime == "image/webp" { "webp" } else { "jpg" };
    format!("chat/{id}.{ext}")
}

fn kind(body: &[u8]) -> Option<&'static str> {
    if body.len() >= 3 && body[0] == 0xFF && body[1] == 0xD8 && body[2] == 0xFF {
        return Some("image/jpeg");
    }
    if body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}
