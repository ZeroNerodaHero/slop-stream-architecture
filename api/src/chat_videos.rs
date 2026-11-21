//! A short video on a chat line, the pictures' way (chat_images.rs): the page posts the file
//! here as it is, the say names the id, and the panel plays it back from the bucket. See
//! docs/chat.md "videos". A test version: no transcoding, nothing deleted on its own.
//!
//! An mp4 of H.264 (with AAC, or no sound) or a webm of VP8 or VP9 (with Opus, or no sound),
//! 10 mb and 30 seconds at most. The magic bytes say which container, and a walk of its header
//! says the codecs and, when it is written there, how long: the mp4's `mvhd`, the webm's
//! `Info/Duration`. A webm straight out of a browser's recorder has no duration in its header;
//! then the page's own reading (`?duration=`, from the `<video>` it measured) is taken.
//!
//! Every video has a poster: a frame the page drew onto a canvas and kept through
//! `POST /api/chat-images`, the pictures' one road in, so it passed the pictures' checks. The
//! upload names it (`?poster=`), it must be the uploader's own, and the line carries both ids.

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, QueryRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Me;
use crate::s3;
use crate::{ApiError, ApiResult, AppState};

/// A phone's half minute at a sensible bitrate. The bucket is on the box, and its disk is small.
const MAX_BYTES: usize = 10 * 1024 * 1024;
/// Half a minute, and half a second over for a container's rounding (a 30s recording reads 30.02).
const MAX_MS: u64 = 30_000;
const SLACK_MS: u64 = 500;
/// Videos per login per ten minutes, on top of ratelimit.rs's `VIDEO_UPLOAD`. Stricter than the
/// pictures' 30: each is up to forty times the bytes.
const RATE_PER_WINDOW: i64 = 5;
const RATE_WINDOW_SECS: i64 = 600;
const CACHE: &str = "public, max-age=86400";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // the 10 mb is this route's alone: every other body keeps axum's 2 mb
        .route("/api/chat-videos", post(upload).layer(DefaultBodyLimit::max(MAX_BYTES)))
        .route("/api/chat-videos/{id}", get(show))
}

/// The poster of the video `id`, when the api kept one by that id. The say checks this before it
/// keeps a line that names a video, and puts both ids on the line.
pub(crate) async fn poster_of(db: &PgPool, id: &str) -> Result<Option<Uuid>, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id) else { return Ok(None) };
    sqlx::query_scalar("SELECT poster FROM chat_videos WHERE id = $1").bind(id).fetch_optional(db).await
}

#[derive(Deserialize)]
struct UploadQuery {
    /// The frame the page grabbed, kept through `POST /api/chat-images`.
    poster: Option<String>,
    /// How long the page measured it, in ms. Read only when the header does not say.
    duration: Option<u64>,
}

/// `POST /api/chat-videos?poster=<picture id>&duration=<ms>`, the file as the body: 200 `{ id, poster,
/// duration_ms }`. 401 for nobody; 413 `video too big`; 400 `not an mp4 or webm`, the codecs' words,
/// `video too long`, `no poster` or `no such poster` (not a picture of yours); 429 past five in ten minutes.
async fn upload(State(s): State<AppState>, Me(me): Me, q: Result<Query<UploadQuery>, QueryRejection>, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "log in to send a video"))?;
    let q = q.map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad query"))?.0;
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => return Err(too_big()),
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    if body.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "empty video"));
    }
    if body.len() > MAX_BYTES {
        return Err(too_big());
    }
    let probe = probe(&body).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    // the header's length when it has one; a recorder's webm has none, and the page measured it
    let duration_ms = match probe.duration_ms.filter(|ms| *ms > 0) {
        Some(ms) => ms,
        None => q.duration.filter(|ms| *ms > 0).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "say how long the video is"))?,
    };
    if duration_ms > MAX_MS + SLACK_MS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "video too long. 30 seconds at most"));
    }
    let poster = q.poster.as_deref().map(str::trim).filter(|p| !p.is_empty()).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "no poster"))?;
    let poster = Uuid::parse_str(poster).map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "no such poster"))?;
    // the poster came in the pictures' way, so it passed their checks; and it is this login's own
    let mine: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM chat_images WHERE id = $1 AND created_by = $2)")
        .bind(poster)
        .bind(me.id)
        .fetch_one(&s.db)
        .await?;
    if !mine {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such poster"));
    }
    crate::auth::limit(&s, &format!("rl:chatvid:{}", me.id), RATE_WINDOW_SECS, RATE_PER_WINDOW, "slow down").await?;
    // the row first, as the pictures do; a failed save deletes it
    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO chat_videos (id, mime, bytes, duration_ms, poster, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(probe.mime)
    .bind(body.len() as i32)
    .bind(duration_ms as i32)
    .bind(poster)
    .bind(me.id)
    .fetch_one(&s.db)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::warn!("{}: chat video row: {e}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the video"));
        }
    };
    if let Err(e) = s3::put(&s.s3, &key_of(id, probe.mime), &body, probe.mime).await {
        let _ = sqlx::query("DELETE FROM chat_videos WHERE id = $1").bind(id).execute(&s.db).await;
        log::warn!("{}: chat video: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not save the video"));
    }
    log::info!("{}: chat video {id} ({} bytes, {duration_ms} ms, {})", me.name, body.len(), probe.mime);
    Ok(Json(json!({ "id": id, "poster": poster, "duration_ms": duration_ms })))
}

fn too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "video too big. 10 mb at most")
}

/// `GET /api/chat-videos/:id`: the file, or the part of it a `Range` asks for (206, one range;
/// several are answered with the whole, which the spec allows), so a player can seek, and
/// Safari, which will not play a video it cannot ask for in parts, plays it at all.
async fn show(State(s): State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> Result<Response, ApiError> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad video"));
    };
    let row: Option<(String, i32)> = sqlx::query_as("SELECT mime, bytes FROM chat_videos WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some((mime, len)) = row else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such video"));
    };
    let len = len.max(0) as u64;
    let key = key_of(id, &mime);
    let mut out = HeaderMap::new();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE));
    let asked = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let range = match range_of(asked, len) {
        Ok(range) => range,
        Err(()) => {
            out.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{len}")).unwrap_or(HeaderValue::from_static("bytes */0")));
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, out).into_response());
        }
    };
    let got = match range {
        Some((start, end)) => s3::get_range(&s.s3, &key, start, end).await,
        None => s3::get(&s.s3, &key).await,
    };
    let bytes = match got {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(ApiError::new(StatusCode::NOT_FOUND, "no such video")),
        Err(e) => {
            log::warn!("chat video {id}: {e}");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not load the video"));
        }
    };
    match range {
        Some((start, _)) => {
            let end = start + (bytes.len() as u64).saturating_sub(1);
            if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")) {
                out.insert(header::CONTENT_RANGE, v);
            }
            Ok((StatusCode::PARTIAL_CONTENT, out, bytes).into_response())
        }
        None => Ok((StatusCode::OK, out, bytes).into_response()),
    }
}

/// The one range a `Range: bytes=…` header asks of a file `len` long, as `start..=end`.
/// `Ok(None)`: the whole file (no header, one this does not read, or several ranges).
/// `Err`: a range wholly past the end, the 416.
fn range_of(asked: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = asked.and_then(|a| a.trim().strip_prefix("bytes=")) else { return Ok(None) };
    if spec.contains(',') || len == 0 {
        return Ok(None);
    }
    let Some((a, b)) = spec.trim().split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // the last n bytes
        let Ok(n) = b.parse::<u64>() else { return Ok(None) };
        if n == 0 {
            return Err(());
        }
        return Ok(Some((len - n.min(len), len - 1)));
    }
    let Ok(start) = a.parse::<u64>() else { return Ok(None) };
    let end = if b.is_empty() {
        len - 1
    } else {
        match b.parse::<u64>() {
            Ok(end) if end >= start => end.min(len - 1),
            _ => return Ok(None),
        }
    };
    if start >= len {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn key_of(id: Uuid, mime: &str) -> String {
    let ext = if mime == "video/webm" { "webm" } else { "mp4" };
    format!("chat-videos/{id}.{ext}")
}

/// What the header says about a file: its type and, when written there, its length.
#[derive(Debug, PartialEq)]
struct Probe {
    mime: &'static str,
    duration_ms: Option<u64>,
}

const WRONG_TYPE: &str = "not an mp4 or webm";
const MP4_CODECS: &str = "an mp4 must be H.264 video with AAC sound";
const WEBM_CODECS: &str = "a webm must be VP8 or VP9 video with Opus sound";
const NO_VIDEO: &str = "no video in that file";

/// The container by its magic bytes (`ftyp` at 4, or the EBML mark), then its header walked for
/// the codecs and the length. Anything else is refused.
fn probe(b: &[u8]) -> Result<Probe, &'static str> {
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        let brand = &b[8..12];
        // sound alone, and quicktime's own: not the mp4 this takes
        if brand == b"M4A " || brand == b"M4B " || brand == b"qt  " {
            return Err(WRONG_TYPE);
        }
        return probe_mp4(b);
    }
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return probe_webm(b);
    }
    Err(WRONG_TYPE)
}

// ---- mp4 ----------------------------------------------------------------------------------------

/// The boxes laid end to end in `b`: their four letters and their insides. A box that runs past
/// the end is cut there and ends the walk (a file is whole here, so that is a broken one).
fn boxes(mut b: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    while b.len() >= 8 {
        let mut size = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as u64;
        let kind = [b[4], b[5], b[6], b[7]];
        let mut head = 8usize;
        if size == 1 {
            if b.len() < 16 {
                break;
            }
            size = u64::from_be_bytes([b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]]);
            head = 16;
        } else if size == 0 {
            size = b.len() as u64;
        }
        if size < head as u64 || size > b.len() as u64 {
            out.push((kind, &b[head.min(b.len())..]));
            break;
        }
        let size = size as usize;
        out.push((kind, &b[head..size]));
        b = &b[size..];
    }
    out
}

fn child<'a>(b: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(b).into_iter().find(|(k, _)| k == kind).map(|(_, inside)| inside)
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be64(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8).map(|s| u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

/// `moov/mvhd` for the length, and each `trak`'s handler and first sample entry for the codecs:
/// every video track `avc1`/`avc3`, every sound track `mp4a`, and at least one video track.
fn probe_mp4(b: &[u8]) -> Result<Probe, &'static str> {
    let moov = child(b, b"moov").ok_or(WRONG_TYPE)?;
    let duration_ms = child(moov, b"mvhd").and_then(|mvhd| {
        let (scale, duration) = if mvhd.first() == Some(&1) {
            (be32(mvhd, 20)? as u64, be64(mvhd, 24)?)
        } else {
            (be32(mvhd, 12)? as u64, be32(mvhd, 16)? as u64)
        };
        // 0 and all ones are "not said" (a fragmented file says it per fragment)
        if scale == 0 || duration == 0 || duration == u32::MAX as u64 || duration == u64::MAX {
            return None;
        }
        Some(duration.saturating_mul(1000) / scale)
    });
    let mut video = false;
    for (kind, trak) in boxes(moov) {
        if &kind != b"trak" {
            continue;
        }
        let Some(mdia) = child(trak, b"mdia") else { continue };
        let Some(handler) = child(mdia, b"hdlr").and_then(|h| h.get(8..12)) else { continue };
        let entry = child(mdia, b"minf").and_then(|m| child(m, b"stbl")).and_then(|s| child(s, b"stsd")).and_then(|stsd| stsd.get(12..16));
        match handler {
            b"vide" => {
                if !matches!(entry, Some(b"avc1") | Some(b"avc3")) {
                    return Err(MP4_CODECS);
                }
                video = true;
            }
            b"soun" => {
                if entry != Some(b"mp4a") {
                    return Err(MP4_CODECS);
                }
            }
            _ => {}
        }
    }
    if !video {
        return Err(NO_VIDEO);
    }
    Ok(Probe { mime: "video/mp4", duration_ms })
}

// ---- webm ---------------------------------------------------------------------------------------

/// An EBML variable-length number at the start of `b`: its value and how many bytes it took.
/// An id keeps its length mark (`0x1A45DFA3`); a size drops it, and all ones is `None`, unknown.
fn vint(b: &[u8], id: bool) -> Option<(Option<u64>, usize)> {
    let first = *b.first()?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || b.len() < len {
        return None;
    }
    let mut value = if id { first as u64 } else { (first as u64) & (0xFF >> len) };
    for &byte in &b[1..len] {
        value = (value << 8) | byte as u64;
    }
    let all_ones = !id && value == (1u64 << (7 * len)) - 1;
    Some((if all_ones { None } else { Some(value) }, len))
}

/// The elements laid end to end in `b`: id and insides. One of unknown size (a recorder's
/// `Segment` and `Cluster`) runs to the end of `b`, and ends the walk after it.
fn elements(mut b: &[u8]) -> Vec<(u64, &[u8])> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let Some((Some(id), id_len)) = vint(b, true) else { break };
        let Some((size, size_len)) = vint(&b[id_len..], false) else { break };
        let head = id_len + size_len;
        match size {
            Some(size) if (size as usize) <= b.len() - head => {
                let end = head + size as usize;
                out.push((id, &b[head..end]));
                b = &b[end..];
            }
            _ => {
                out.push((id, &b[head..]));
                break;
            }
        }
    }
    out
}

const EBML: u64 = 0x1A45DFA3;
const DOC_TYPE: u64 = 0x4282;
const SEGMENT: u64 = 0x18538067;
const INFO: u64 = 0x1549A966;
const TIMECODE_SCALE: u64 = 0x2AD7B1;
const DURATION: u64 = 0x4489;
const TRACKS: u64 = 0x1654AE6B;
const TRACK_ENTRY: u64 = 0xAE;
const TRACK_TYPE: u64 = 0x83;
const CODEC_ID: u64 = 0x86;
const CLUSTER: u64 = 0x1F43B675;

fn uint(b: &[u8]) -> u64 {
    b.iter().take(8).fold(0, |n, &byte| (n << 8) | byte as u64)
}

/// The header's doc type must be `webm`. `Segment/Info` says the length (in its timecode scale,
/// a millionth of a second unless said), `Segment/Tracks` the codecs: every video track
/// `V_VP8`/`V_VP9`, every sound track `A_OPUS`, and at least one video track. The walk stops at
/// the first `Cluster`: the header is before the frames.
fn probe_webm(b: &[u8]) -> Result<Probe, &'static str> {
    let top = elements(b);
    let header = top.iter().find(|(id, _)| *id == EBML).ok_or(WRONG_TYPE)?.1;
    let doc = elements(header).into_iter().find(|(id, _)| *id == DOC_TYPE).map(|(_, v)| v);
    if doc != Some(b"webm".as_slice()) {
        return Err(WRONG_TYPE);
    }
    let segment = top.iter().find(|(id, _)| *id == SEGMENT).ok_or(WRONG_TYPE)?.1;
    let mut duration_ms = None;
    let mut video = false;
    for (id, inside) in elements(segment) {
        match id {
            INFO => {
                let fields = elements(inside);
                let scale = fields.iter().find(|(id, _)| *id == TIMECODE_SCALE).map(|(_, v)| uint(v)).filter(|s| *s > 0).unwrap_or(1_000_000);
                let ticks = fields.iter().find(|(id, _)| *id == DURATION).and_then(|(_, v)| match v.len() {
                    4 => Some(f32::from_be_bytes([v[0], v[1], v[2], v[3]]) as f64),
                    8 => Some(f64::from_be_bytes([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]])),
                    _ => None,
                });
                duration_ms = ticks.filter(|t| t.is_finite() && *t > 0.0).map(|t| (t * scale as f64 / 1_000_000.0).round() as u64);
            }
            TRACKS => {
                for (id, entry) in elements(inside) {
                    if id != TRACK_ENTRY {
                        continue;
                    }
                    let fields = elements(entry);
                    let kind = fields.iter().find(|(id, _)| *id == TRACK_TYPE).map(|(_, v)| uint(v));
                    let codec = fields.iter().find(|(id, _)| *id == CODEC_ID).map(|(_, v)| *v);
                    match kind {
                        Some(1) => {
                            if !matches!(codec, Some(b"V_VP8") | Some(b"V_VP9")) {
                                return Err(WEBM_CODECS);
                            }
                            video = true;
                        }
                        Some(2) => {
                            if codec != Some(b"A_OPUS".as_slice()) {
                                return Err(WEBM_CODECS);
                            }
                        }
                        _ => {}
                    }
                }
            }
            CLUSTER => break,
            _ => {}
        }
    }
    if !video {
        return Err(NO_VIDEO);
    }
    Ok(Probe { mime: "video/webm", duration_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4_box(kind: &[u8; 4], inside: &[u8]) -> Vec<u8> {
        let mut out = ((inside.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(inside);
        out
    }

    /// A trak of `handler` whose first sample entry is `entry`.
    fn trak(handler: &[u8; 4], entry: &[u8; 4]) -> Vec<u8> {
        let mut hdlr = vec![0u8; 8];
        hdlr.extend_from_slice(handler);
        hdlr.extend_from_slice(&[0u8; 12]);
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend_from_slice(&mp4_box(entry, &[0u8; 8]));
        let stbl = mp4_box(b"stbl", &mp4_box(b"stsd", &stsd));
        let minf = mp4_box(b"minf", &stbl);
        let mut mdia = mp4_box(b"hdlr", &hdlr);
        mdia.extend_from_slice(&minf);
        mp4_box(b"trak", &mp4_box(b"mdia", &mdia))
    }

    fn mp4(brand: &[u8; 4], seconds: u32, traks: &[Vec<u8>]) -> Vec<u8> {
        let mut out = mp4_box(b"ftyp", &[brand.as_slice(), &[0, 0, 2, 0], b"isomavc1"].concat());
        let mut mvhd = vec![0u8; 12];
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&(seconds * 1000).to_be_bytes());
        mvhd.extend_from_slice(&[0u8; 80]);
        let mut moov = mp4_box(b"mvhd", &mvhd);
        for t in traks {
            moov.extend_from_slice(t);
        }
        out.extend_from_slice(&mp4_box(b"moov", &moov));
        out.extend_from_slice(&mp4_box(b"mdat", &[0u8; 32]));
        out
    }

    #[test]
    fn an_h264_mp4_reads_its_length_and_codecs() {
        let file = mp4(b"isom", 12, &[trak(b"vide", b"avc1"), trak(b"soun", b"mp4a")]);
        assert_eq!(probe(&file), Ok(Probe { mime: "video/mp4", duration_ms: Some(12_000) }));
        // no sound is fine
        assert_eq!(probe(&mp4(b"mp42", 3, &[trak(b"vide", b"avc3")])).map(|p| p.duration_ms), Ok(Some(3_000)));
    }

    #[test]
    fn other_mp4s_are_refused() {
        assert_eq!(probe(&mp4(b"isom", 5, &[trak(b"vide", b"hvc1")])), Err(MP4_CODECS));
        assert_eq!(probe(&mp4(b"isom", 5, &[trak(b"vide", b"avc1"), trak(b"soun", b"Opus")])), Err(MP4_CODECS));
        assert_eq!(probe(&mp4(b"isom", 5, &[trak(b"soun", b"mp4a")])), Err(NO_VIDEO));
        assert_eq!(probe(&mp4(b"qt  ", 5, &[trak(b"vide", b"avc1")])), Err(WRONG_TYPE));
        assert_eq!(probe(&mp4(b"M4A ", 5, &[trak(b"soun", b"mp4a")])), Err(WRONG_TYPE));
        // a long one is read as long; the upload refuses it
        assert_eq!(probe(&mp4(b"isom", 31, &[trak(b"vide", b"avc1")])).unwrap().duration_ms, Some(31_000));
    }

    fn el(id: &[u8], inside: &[u8]) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend_from_slice(&[0x01, 0, 0, 0, 0, 0, 0, 0]);
        out[id.len() + 7] = inside.len() as u8;
        out.extend_from_slice(inside);
        out
    }

    fn track(kind: u8, codec: &[u8]) -> Vec<u8> {
        el(&[0xAE], &[el(&[0x83], &[kind]), el(&[0x86], codec)].concat())
    }

    fn webm(duration: Option<f64>, tracks: &[Vec<u8>], unknown_size: bool) -> Vec<u8> {
        let mut out = el(&[0x1A, 0x45, 0xDF, 0xA3], &el(&[0x42, 0x82], b"webm"));
        let mut info = el(&[0x2A, 0xD7, 0xB1], &[0x0F, 0x42, 0x40]);
        if let Some(ms) = duration {
            info.extend_from_slice(&el(&[0x44, 0x89], &ms.to_be_bytes()));
        }
        let mut segment = el(&[0x15, 0x49, 0xA9, 0x66], &info);
        segment.extend_from_slice(&el(&[0x16, 0x54, 0xAE, 0x6B], &tracks.concat()));
        // a cluster of unknown size, the way a recorder writes them
        segment.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, 0xFF, 0xE7, 0x81, 0x00]);
        if unknown_size {
            out.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
            out.extend_from_slice(&segment);
        } else {
            // an 8-byte size: 0x01 then seven bytes
            let mut sized = vec![0x18, 0x53, 0x80, 0x67, 0x01];
            sized.extend_from_slice(&(segment.len() as u64).to_be_bytes()[1..]);
            out.extend_from_slice(&sized);
            out.extend_from_slice(&segment);
        }
        out
    }

    #[test]
    fn a_vp9_webm_reads_its_length_and_codecs() {
        let file = webm(Some(9_500.0), &[track(1, b"V_VP9"), track(2, b"A_OPUS")], false);
        assert_eq!(probe(&file), Ok(Probe { mime: "video/webm", duration_ms: Some(9_500) }));
        // a recorder's: no length in the header, a segment of unknown size
        let file = webm(None, &[track(1, b"V_VP8"), track(2, b"A_OPUS")], true);
        assert_eq!(probe(&file), Ok(Probe { mime: "video/webm", duration_ms: None }));
    }

    #[test]
    fn other_webms_are_refused() {
        assert_eq!(probe(&webm(None, &[track(1, b"V_AV1")], false)), Err(WEBM_CODECS));
        assert_eq!(probe(&webm(None, &[track(1, b"V_VP8"), track(2, b"A_VORBIS")], false)), Err(WEBM_CODECS));
        assert_eq!(probe(&webm(None, &[track(2, b"A_OPUS")], false)), Err(NO_VIDEO));
        let mut mkv = webm(None, &[track(1, b"V_VP8")], false);
        let at = mkv.windows(4).position(|w| w == b"webm").unwrap();
        mkv[at..at + 4].copy_from_slice(b"mkv!");
        assert_eq!(probe(&mkv), Err(WRONG_TYPE));
    }

    #[test]
    fn anything_else_is_the_wrong_type() {
        assert_eq!(probe(&[0xFF, 0xD8, 0xFF, 0xE0]), Err(WRONG_TYPE));
        assert_eq!(probe(b"RIFF\0\0\0\0WEBPVP8 "), Err(WRONG_TYPE));
        assert_eq!(probe(b""), Err(WRONG_TYPE));
        // an ftyp with nothing after it
        assert_eq!(probe(b"\x00\x00\x00\x10ftypisom\x00\x00\x02\x00"), Err(WRONG_TYPE));
    }

    #[test]
    fn ranges() {
        assert_eq!(range_of(None, 100), Ok(None));
        assert_eq!(range_of(Some("bytes=0-"), 100), Ok(Some((0, 99))));
        assert_eq!(range_of(Some("bytes=0-1"), 100), Ok(Some((0, 1))));
        assert_eq!(range_of(Some("bytes=10-500"), 100), Ok(Some((10, 99))));
        assert_eq!(range_of(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(range_of(Some("bytes=-500"), 100), Ok(Some((0, 99))));
        assert_eq!(range_of(Some("bytes=100-"), 100), Err(()));
        assert_eq!(range_of(Some("bytes=-0"), 100), Err(()));
        // not read: the whole file
        assert_eq!(range_of(Some("bytes=0-1,5-6"), 100), Ok(None));
        assert_eq!(range_of(Some("bytes=5-1"), 100), Ok(None));
        assert_eq!(range_of(Some("items=0-1"), 100), Ok(None));
        assert_eq!(range_of(Some("bytes=x-1"), 100), Ok(None));
    }
}
