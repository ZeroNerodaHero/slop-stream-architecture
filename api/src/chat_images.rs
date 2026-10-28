//! A picture on a chat line. The page shrinks it first and posts the bytes here;
//! the say names the id, and the panel fetches it back. See docs/chat.md.
//!
//! Webp, or jpeg when the browser cannot write webp. Profile pictures, group
//! pictures, thumbnails and the offline picture stay jpeg and do not come through here.

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{bump, Me};
use crate::s3;
use crate::{ApiError, ApiResult, AppState};

/// About five lines, drawn at two pixels per screen pixel, is still a small file.
const MAX_BYTES: usize = 256 * 1024;
/// Pictures per login per ten minutes. A chat, not a gallery.
const RATE_PER_WINDOW: i64 = 30;
const RATE_WINDOW_SECS: i64 = 600;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/chat-images", post(upload))
        .route("/api/chat-images/{id}", get(show))
        .layer(DefaultBodyLimit::max(MAX_BYTES))
}

/// The say checks this before it keeps a line that names a picture.
pub(crate) async fn exists(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM chat_images WHERE id = $1::uuid)").bind(id).fetch_one(db).await
}

async fn upload(State(s): State<AppState>, Me(me): Me, body: Result<Bytes, BytesRejection>) -> ApiResult {
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
    if bump(&s, &format!("rl:chatimg:{}", me.id), RATE_WINDOW_SECS).await? > RATE_PER_WINDOW {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "slow down"));
    }
    // postgres makes the id, the same as every other id. the row first; a failed save deletes it.
    let id: Uuid = match sqlx::query_scalar("INSERT INTO chat_images (id, mime, created_by) VALUES (gen_random_uuid(), $1, $2) RETURNING id")
        .bind(mime)
        .bind(me.id)
        .fetch_one(&s.db)
        .await
    {
        Ok(id) => id,
        Err(e) => {
            log::warn!("{}: chat picture row: {e}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the picture"));
        }
    };
    let key = key_of(id, mime);
    if let Err(e) = s3::put(&s.s3, &key, &body, mime).await {
        let _ = sqlx::query("DELETE FROM chat_images WHERE id = $1").bind(id).execute(&s.db).await;
        log::warn!("{}: chat picture: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not save the picture"));
    }
    Ok(Json(json!({ "id": id })))
}

async fn show(State(s): State<AppState>, Path(id): Path<String>) -> Result<impl IntoResponse, ApiError> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad picture"));
    };
    let mime: Option<String> = sqlx::query_scalar("SELECT mime FROM chat_images WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some(mime) = mime else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such picture"));
    };
    let bytes = match s3::get(&s.s3, &key_of(id, &mime)).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(ApiError::new(StatusCode::NOT_FOUND, "no such picture")),
        Err(e) => {
            log::warn!("chat picture {id}: {e}");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not load the picture"));
        }
    };
    Ok(([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=86400".to_owned())], bytes))
}

fn key_of(id: Uuid, mime: &str) -> String {
    let ext = if mime == "image/webp" { "webp" } else { "jpg" };
    format!("chat/{id}.{ext}")
}

/// Webp (`RIFF….WEBP`) or jpeg (`FF D8 FF`). Anything else is refused: the page is meant to send one of these.
fn kind(body: &[u8]) -> Option<&'static str> {
    if body.len() >= 3 && body[0] == 0xFF && body[1] == 0xD8 && body[2] == 0xFF {
        return Some("image/jpeg");
    }
    if body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}
