use std::path::Path as FsPath;
use std::process::Command;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody};
use axum::extract::{DefaultBodyLimit, OriginalUri, Path, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::auth::Me;
use crate::chat::Peaks;
use crate::chat_videos::{
    be32, be64, bin, boxes, child, elements, last_packet_ms, range_of, read_capped, refused_or_broken, run, seconds_ms, uint, Failed, Scratch, CLUSTER,
    CODEC_ID, COPY_TIMEOUT, DOC_TYPE, DURATION, EBML, INFO, MAX_PROBE_OUTPUT, PROBE_TIMEOUT, SEGMENT, TIMECODE_SCALE, TRACKS, TRACK_ENTRY, TRACK_TYPE,
};
use crate::media::{self, Kind};
use crate::{chat_images, s3};
use crate::{ApiError, ApiResult, AppState};

pub(crate) const MAX_BYTES: usize = 2 * 1024 * 1024;
const BODY_SLACK: usize = 256 * 1024;
pub(crate) const MAX_MS: u64 = 120_000;
const SLACK_MS: u64 = 1_500;
const RATE_PER_WINDOW: i64 = 20;
const RATE_WINDOW_SECS: i64 = 600;
const ENCODE_TIMEOUT: Duration = Duration::from_secs(60);
static JOBS: Semaphore = Semaphore::const_new(2);

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/chat-audio", post(upload).layer(DefaultBodyLimit::max(MAX_BYTES + BODY_SLACK)))
        .route("/api/chat-audio/{id}", get(show).delete(take_down))
}

pub(crate) async fn meta_of(db: &PgPool, id: &str) -> Result<Option<(u64, Option<Peaks>)>, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id) else { return Ok(None) };
    let row: Option<(i32, Option<Vec<i16>>)> = sqlx::query_as("SELECT duration_ms, peaks FROM chat_audio WHERE id = $1").bind(id).fetch_optional(db).await?;
    Ok(row.map(|(ms, peaks)| (ms.max(0) as u64, peaks.as_deref().and_then(Peaks::of_kept))))
}

pub(crate) const BAD_PEAKS: &str = "bad waveform";

pub(crate) fn peaks_of(raw: Option<&str>) -> Result<Option<Peaks>, &'static str> {
    let Some(raw) = raw else { return Ok(None) };
    let Some(list) = raw.split('&').find_map(|pair| pair.strip_prefix("peaks=")) else { return Ok(None) };
    let list = list.replace("%2C", ",").replace("%2c", ",");
    if list.trim().is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = list.split(',').collect();
    if parts.len() > Peaks::MAX {
        return Err(BAD_PEAKS);
    }
    let levels = parts.iter().map(|v| v.trim().parse::<f64>().map_err(|_| BAD_PEAKS)).collect::<Result<Vec<f64>, _>>()?;
    Peaks::of(&levels).map(Some).ok_or(BAD_PEAKS)
}

async fn upload(State(s): State<AppState>, Me(me): Me, RawQuery(query): RawQuery, headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "log in to send a voice message"))?;
    let peaks = peaks_of(query.as_deref()).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => return Err(too_big()),
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    if body.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "empty voice message"));
    }
    if body.len() > MAX_BYTES {
        return Err(too_big());
    }
    let probe = probe(&body).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    if probe.duration_ms.is_some_and(|ms| ms > MAX_MS + SLACK_MS) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, TOO_LONG));
    }
    crate::auth::limit(&s, &format!("rl:chataudio:{}", me.id), RATE_WINDOW_SECS, RATE_PER_WINDOW, "slow down").await?;
    let ready = {
        let _job = JOBS.acquire().await.map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "try again"))?;
        let mime = probe.mime;
        match tokio::task::spawn_blocking(move || prepare(&body, mime)).await {
            Ok(ready) => ready,
            Err(e) => Err(Failed::Broken(format!("the ffmpeg thread: {e}"))),
        }
    };
    let ready = match ready {
        Ok(ready) => ready,
        Err(Failed::Refused(why)) => return Err(ApiError::new(StatusCode::BAD_REQUEST, why)),
        Err(Failed::Broken(why)) => {
            log::warn!("{}: chat audio: {why}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, UNREADABLE));
        }
    };
    if ready.audio.len() > MAX_BYTES {
        return Err(too_big());
    }
    let ip = crate::ratelimit::forwarded_ip(&headers);
    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO chat_audio (id, mime, bytes, duration_ms, created_by, sha256, uploader_ip, peaks)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(ready.mime)
    .bind(ready.audio.len() as i32)
    .bind(ready.duration_ms as i32)
    .bind(me.id)
    .bind(media::sha256_hex(&ready.audio))
    .bind(ip.as_deref())
    .bind(peaks.as_ref().map(Peaks::kept))
    .fetch_one(&s.db)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::warn!("{}: chat audio row: {e}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the voice message"));
        }
    };
    if let Err(e) = s3::put(&s.s3, &key_of(id, ready.mime), &ready.audio, ready.mime).await {
        let _ = sqlx::query("DELETE FROM chat_audio WHERE id = $1").bind(id).execute(&s.db).await;
        log::warn!("{}: chat audio: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not save the voice message"));
    }
    log::info!(
        "{}: chat audio {id} ({} bytes in, {} kept, {} ms, {}{})",
        me.name,
        ready.bytes_in,
        ready.audio.len(),
        ready.duration_ms,
        ready.mime,
        if ready.encoded { ", encoded again" } else { "" }
    );
    Ok(Json(json!({ "id": id, "duration_ms": ready.duration_ms, "peaks": peaks })))
}

fn too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "voice message too big. 2 mb at most")
}

async fn show(State(s): State<AppState>, Me(me): Me, OriginalUri(uri): OriginalUri, Path(id): Path<String>, RawQuery(raw): RawQuery, headers: HeaderMap) -> Result<Response, ApiError> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad voice message"));
    };
    let viewer = me.map(|m| m.id);
    let Some(access) = media::access(&s.db, Kind::Audio, id, viewer).await? else {
        return Err(media::missing(&s.db, Kind::Audio, id).await);
    };
    if let Some(no) = media::refused(&access) {
        return Err(no);
    }
    let row: Option<(String, i32, Option<Uuid>, bool)> =
        sqlx::query_as("SELECT mime, bytes, created_by, posted_kind IS NOT DISTINCT FROM 'group' FROM chat_audio WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some((mime, len, by, in_group)) = row else {
        return Err(media::missing(&s.db, Kind::Audio, id).await);
    };
    let uploader = viewer.is_some() && by == viewer;
    let site_admin = viewer.is_some_and(|v| s.admins.iter().any(|a| a.id == v));
    let len = len.max(0) as u64;
    let key = key_of(id, &mime);
    let mut out = HeaderMap::new();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    media::headers(
        &mut out,
        media::CacheFacts {
            access_public: access == media::Access::Public,
            uploader,
            site_admin,
            in_group,
            extra_query: raw.is_some(),
            canonical_path: media::is_canonical_path(Kind::Audio, id, uri.path()),
            ..media::CacheFacts::default()
        },
    );
    let asked = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let range = match range_of(asked, len) {
        Ok(range) => range,
        Err(()) => {
            out.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{len}")).unwrap_or(HeaderValue::from_static("bytes */0")));
            out.insert(header::CACHE_CONTROL, HeaderValue::from_static(media::PRIVATE_CACHE));
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, out).into_response());
        }
    };
    let got = match range {
        Some((start, end)) => s3::get_range(&s.s3, &key, start, end).await,
        None => s3::get(&s.s3, &key).await,
    };
    let bytes = match got {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(ApiError::new(StatusCode::NOT_FOUND, "no such voice message")),
        Err(e) => {
            log::warn!("chat audio {id}: {e}");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not load the voice message"));
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

async fn take_down(State(s): State<AppState>, Me(me): Me, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let me = chat_images::admin(&s, me)?;
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad voice message"));
    };
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT mime, posted_kind FROM chat_audio WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some((mime, posted)) = row else {
        return Err(media::missing(&s.db, Kind::Audio, id).await);
    };
    if let Err(e) = s3::delete(&s.s3, &key_of(id, &mime)).await {
        log::warn!("{}: take down chat audio {id}: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not delete the voice message"));
    }
    media::remember_removed(&s.db, Kind::Audio, id, me.id).await?;
    sqlx::query("DELETE FROM chat_audio WHERE id = $1").bind(id).execute(&s.db).await?;
    if posted.as_deref() == Some("stream") {
        media::purge(Kind::Audio, id);
    }
    log::info!("{}: took down chat audio {id}", me.name);
    Ok(StatusCode::NO_CONTENT)
}

fn key_of(id: Uuid, mime: &str) -> String {
    format!("chat-audio/{id}.{}", ext_of(mime))
}

fn ext_of(mime: &str) -> &'static str {
    match mime {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        _ => "m4a",
    }
}

fn demuxer_of(mime: &str) -> &'static str {
    match mime {
        "audio/webm" => "matroska",
        "audio/ogg" => "ogg",
        _ => "mov",
    }
}

#[derive(Debug)]
struct Ready {
    mime: &'static str,
    audio: Vec<u8>,
    duration_ms: u64,
    bytes_in: usize,
    encoded: bool,
}

const TOO_LONG: &str = "voice message too long. 2 minutes at most";
const UNKNOWN_LENGTH: &str = "could not tell how long that voice message is";
const UNREADABLE: &str = "could not read that voice message";
const WRONG_TYPE: &str = "not a webm, ogg or m4a voice message";
const CODECS: &str = "a voice message must be Opus (webm, ogg) or AAC (m4a)";
const SOUND_ONLY: &str = "a voice message is sound only";
const NO_SOUND: &str = "no sound in that file";

fn prepare(body: &[u8], mime: &'static str) -> Result<Ready, Failed> {
    let (demuxer, ext) = (demuxer_of(mime), ext_of(mime));
    let scratch = Scratch::new().map_err(|e| Failed::Broken(format!("scratch dir: {e}")))?;
    let input = scratch.file(&format!("in.{ext}"));
    std::fs::write(&input, body).map_err(|e| Failed::Broken(format!("write the upload: {e}")))?;

    let (codecs, header_ms) = probe_streams(&scratch, &input, demuxer)?;
    check_codecs(mime, &codecs)?;
    let packets_ms = packets_end_ms(&scratch, &input, demuxer)?;
    let duration_ms = length_of(header_ms, packets_ms)?;

    let copy = scratch.file(&format!("copy.{ext}"));
    let (kept, kept_mime, encoded) = match remux(&input, demuxer, &copy, mime) {
        Ok(()) => (copy, mime, false),
        Err(why) => {
            log::info!("chat audio: copy failed ({why}), encoding again");
            let encoded = scratch.file("encoded.webm");
            encode(&input, demuxer, &encoded)?;
            (encoded, "audio/webm", true)
        }
    };
    let audio = std::fs::read(&kept).map_err(|e| Failed::Broken(format!("read the copy: {e}")))?;
    if audio.is_empty() {
        return Err(Failed::Broken("ffmpeg wrote nothing".to_owned()));
    }
    Ok(Ready { mime: kept_mime, audio, duration_ms: duration_ms.min(MAX_MS + SLACK_MS), bytes_in: body.len(), encoded })
}

fn length_of(header_ms: Option<u64>, packets_ms: Option<u64>) -> Result<u64, Failed> {
    let ms = match (header_ms.filter(|ms| *ms > 0), packets_ms.filter(|ms| *ms > 0)) {
        (None, None) => return Err(Failed::Refused(UNKNOWN_LENGTH)),
        (a, b) => a.unwrap_or(0).max(b.unwrap_or(0)),
    };
    if ms > MAX_MS + SLACK_MS {
        return Err(Failed::Refused(TOO_LONG));
    }
    Ok(ms)
}

#[derive(Deserialize)]
struct ProbeJson {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeStream {
    #[serde(default)]
    codec_type: String,
    #[serde(default)]
    codec_name: String,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[allow(clippy::type_complexity)]
fn probe_streams(scratch: &Scratch, input: &FsPath, demuxer: &str) -> Result<(Vec<(String, String)>, Option<u64>), Failed> {
    let out = scratch.file("streams.json");
    let mut cmd = Command::new(bin("FFPROBE", "ffprobe"));
    cmd.args(["-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json"]).arg(input);
    run(&mut cmd, Some(&out), PROBE_TIMEOUT).map_err(|why| refused_or_broken(why, UNREADABLE))?;
    let raw = read_capped(&out, MAX_PROBE_OUTPUT)?;
    let parsed: ProbeJson = serde_json::from_slice(&raw).map_err(|e| Failed::Broken(format!("ffprobe json: {e}")))?;
    Ok((
        parsed.streams.into_iter().map(|s| (s.codec_type, s.codec_name)).collect(),
        parsed.format.and_then(|f| f.duration).as_deref().and_then(seconds_ms),
    ))
}

fn packets_end_ms(scratch: &Scratch, input: &FsPath, demuxer: &str) -> Result<Option<u64>, Failed> {
    let out = scratch.file("packets.csv");
    let mut cmd = Command::new(bin("FFPROBE", "ffprobe"));
    cmd.args(["-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0"]).arg(input);
    run(&mut cmd, Some(&out), PROBE_TIMEOUT).map_err(|why| refused_or_broken(why, UNREADABLE))?;
    let raw = read_capped(&out, MAX_PROBE_OUTPUT)?;
    Ok(last_packet_ms(&String::from_utf8_lossy(&raw)))
}

fn check_codecs(mime: &str, codecs: &[(String, String)]) -> Result<(), Failed> {
    let wanted = if mime == "audio/mp4" { "aac" } else { "opus" };
    let mut sound = false;
    for (kind, codec) in codecs {
        match kind.as_str() {
            "audio" if codec == wanted => sound = true,
            "audio" => return Err(Failed::Refused(CODECS)),
            "video" => return Err(Failed::Refused(SOUND_ONLY)),
            _ => {}
        }
    }
    if !sound {
        return Err(Failed::Refused(NO_SOUND));
    }
    Ok(())
}

fn strip(cmd: &mut Command) {
    cmd.args(["-map_metadata", "-1", "-map_metadata:s:a", "-1", "-map_chapters", "-1", "-fflags", "+bitexact"]);
}

fn remux(input: &FsPath, demuxer: &str, out: &FsPath, mime: &str) -> Result<(), String> {
    let mut cmd = Command::new(bin("FFMPEG", "ffmpeg"));
    cmd.args(["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-f", demuxer, "-i"]).arg(input);
    cmd.args(["-map", "0:a:0", "-vn", "-c", "copy"]);
    strip(&mut cmd);
    match mime {
        "audio/webm" => cmd.args(["-f", "webm"]),
        "audio/ogg" => cmd.args(["-f", "ogg"]),
        _ => cmd.args(["-movflags", "+faststart", "-f", "mp4"]),
    };
    cmd.arg(out);
    run(&mut cmd, None, COPY_TIMEOUT).map_err(|why| why.to_string())?;
    match std::fs::metadata(out) {
        Ok(m) if m.len() > 0 => Ok(()),
        _ => Err("an empty copy".to_owned()),
    }
}

fn encode(input: &FsPath, demuxer: &str, out: &FsPath) -> Result<(), Failed> {
    let mut cmd = Command::new(bin("FFMPEG", "ffmpeg"));
    cmd.args(["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-f", demuxer, "-i"]).arg(input);
    cmd.args(["-map", "0:a:0", "-vn", "-t", "121.5", "-c:a", "libopus", "-b:a", "48k", "-ac", "1", "-threads", "2"]);
    strip(&mut cmd);
    cmd.args(["-f", "webm"]).arg(out);
    run(&mut cmd, None, ENCODE_TIMEOUT).map_err(|why| refused_or_broken(why, UNREADABLE))
}

#[derive(Debug, PartialEq)]
struct Probe {
    mime: &'static str,
    duration_ms: Option<u64>,
}

fn probe(b: &[u8]) -> Result<Probe, &'static str> {
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        if &b[8..12] == b"qt  " {
            return Err(WRONG_TYPE);
        }
        return probe_mp4(b);
    }
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return probe_webm(b);
    }
    if b.starts_with(b"OggS") {
        return probe_ogg(b);
    }
    Err(WRONG_TYPE)
}

fn probe_mp4(b: &[u8]) -> Result<Probe, &'static str> {
    let moov = child(b, b"moov").ok_or(WRONG_TYPE)?;
    let duration_ms = child(moov, b"mvhd").and_then(|mvhd| {
        let (scale, duration) = if mvhd.first() == Some(&1) {
            (be32(mvhd, 20)? as u64, be64(mvhd, 24)?)
        } else {
            (be32(mvhd, 12)? as u64, be32(mvhd, 16)? as u64)
        };
        if scale == 0 || duration == 0 || duration == u32::MAX as u64 || duration == u64::MAX {
            return None;
        }
        Some(duration.saturating_mul(1000) / scale)
    });
    let mut sound = false;
    for (kind, trak) in boxes(moov) {
        if &kind != b"trak" {
            continue;
        }
        let Some(mdia) = child(trak, b"mdia") else { continue };
        let Some(handler) = child(mdia, b"hdlr").and_then(|h| h.get(8..12)) else { continue };
        let entry = child(mdia, b"minf").and_then(|m| child(m, b"stbl")).and_then(|s| child(s, b"stsd")).and_then(|stsd| stsd.get(12..16));
        match handler {
            b"vide" => return Err(SOUND_ONLY),
            b"soun" => {
                if entry != Some(b"mp4a") {
                    return Err(CODECS);
                }
                sound = true;
            }
            _ => {}
        }
    }
    if !sound {
        return Err(NO_SOUND);
    }
    Ok(Probe { mime: "audio/mp4", duration_ms })
}

fn probe_webm(b: &[u8]) -> Result<Probe, &'static str> {
    let top = elements(b);
    let header = top.iter().find(|(id, _)| *id == EBML).ok_or(WRONG_TYPE)?.1;
    let doc = elements(header).into_iter().find(|(id, _)| *id == DOC_TYPE).map(|(_, v)| v);
    if doc != Some(b"webm".as_slice()) {
        return Err(WRONG_TYPE);
    }
    let segment = top.iter().find(|(id, _)| *id == SEGMENT).ok_or(WRONG_TYPE)?.1;
    let mut duration_ms = None;
    let mut sound = false;
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
                        Some(1) => return Err(SOUND_ONLY),
                        Some(2) => {
                            if codec != Some(b"A_OPUS".as_slice()) {
                                return Err(CODECS);
                            }
                            sound = true;
                        }
                        _ => {}
                    }
                }
            }
            CLUSTER => break,
            _ => {}
        }
    }
    if !sound {
        return Err(NO_SOUND);
    }
    Ok(Probe { mime: "audio/webm", duration_ms })
}

fn probe_ogg(b: &[u8]) -> Result<Probe, &'static str> {
    if b.len() < 27 || b[4] != 0 {
        return Err(WRONG_TYPE);
    }
    let segments = b[26] as usize;
    let body = 27 + segments;
    if b.len() < body + 8 {
        return Err(WRONG_TYPE);
    }
    if &b[body..body + 8] != b"OpusHead" {
        return Err(CODECS);
    }
    Ok(Probe { mime: "audio/ogg", duration_ms: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn an_upload_carries_its_waveform_in_the_query() {
        assert_eq!(peaks_of(None), Ok(None));
        assert_eq!(peaks_of(Some("x=1")), Ok(None));
        assert_eq!(peaks_of(Some("peaks=")), Ok(None));
        assert_eq!(peaks_of(Some("peaks=0,0.5,1")), Ok(Peaks::of(&[0.0, 0.5, 1.0])));
        assert_eq!(peaks_of(Some("a=b&peaks=0.25%2C0.75")), Ok(Peaks::of(&[0.25, 0.75])));
        assert_eq!(peaks_of(Some("peaks=0.5,1.5")), Err(BAD_PEAKS));
        assert_eq!(peaks_of(Some("peaks=0.5,-0.1")), Err(BAD_PEAKS));
        assert_eq!(peaks_of(Some("peaks=0.5,loud")), Err(BAD_PEAKS));
        assert_eq!(peaks_of(Some("peaks=NaN")), Err(BAD_PEAKS));
        let long = vec!["0.5"; Peaks::MAX + 1].join(",");
        assert_eq!(peaks_of(Some(&format!("peaks={long}"))), Err(BAD_PEAKS));
        let most = vec!["0.5"; Peaks::MAX].join(",");
        assert!(peaks_of(Some(&format!("peaks={most}"))).unwrap().is_some());
    }

    fn mp4_box(kind: &[u8; 4], inside: &[u8]) -> Vec<u8> {
        let mut out = ((inside.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(inside);
        out
    }

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
        let mut out = mp4_box(b"ftyp", &[brand.as_slice(), &[0, 0, 2, 0], b"isomM4A "].concat());
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

    fn webm(duration: Option<f64>, tracks: &[Vec<u8>]) -> Vec<u8> {
        let mut out = el(&[0x1A, 0x45, 0xDF, 0xA3], &el(&[0x42, 0x82], b"webm"));
        let mut info = el(&[0x2A, 0xD7, 0xB1], &[0x0F, 0x42, 0x40]);
        if let Some(ms) = duration {
            info.extend_from_slice(&el(&[0x44, 0x89], &ms.to_be_bytes()));
        }
        let mut segment = el(&[0x15, 0x49, 0xA9, 0x66], &info);
        segment.extend_from_slice(&el(&[0x16, 0x54, 0xAE, 0x6B], &tracks.concat()));
        segment.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, 0xFF, 0xE7, 0x81, 0x00]);
        out.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        out.extend_from_slice(&segment);
        out
    }

    fn ogg(head: &[u8]) -> Vec<u8> {
        let mut out = b"OggS".to_vec();
        out.extend_from_slice(&[0, 2]);
        out.extend_from_slice(&[0u8; 20]);
        out.push(1);
        out.push(head.len() as u8);
        out.extend_from_slice(head);
        out
    }

    #[test]
    fn an_aac_m4a_reads_its_length() {
        assert_eq!(probe(&mp4(b"M4A ", 12, &[trak(b"soun", b"mp4a")])), Ok(Probe { mime: "audio/mp4", duration_ms: Some(12_000) }));
        assert_eq!(probe(&mp4(b"iso5", 3, &[trak(b"soun", b"mp4a")])).map(|p| p.duration_ms), Ok(Some(3_000)));
    }

    #[test]
    fn other_mp4s_are_refused() {
        assert_eq!(probe(&mp4(b"isom", 5, &[trak(b"vide", b"avc1"), trak(b"soun", b"mp4a")])), Err(SOUND_ONLY));
        assert_eq!(probe(&mp4(b"M4A ", 5, &[trak(b"soun", b"Opus")])), Err(CODECS));
        assert_eq!(probe(&mp4(b"M4A ", 5, &[])), Err(NO_SOUND));
        assert_eq!(probe(&mp4(b"qt  ", 5, &[trak(b"soun", b"mp4a")])), Err(WRONG_TYPE));
    }

    #[test]
    fn an_opus_webm_reads_its_length() {
        assert_eq!(probe(&webm(Some(9_500.0), &[track(2, b"A_OPUS")])), Ok(Probe { mime: "audio/webm", duration_ms: Some(9_500) }));
        assert_eq!(probe(&webm(None, &[track(2, b"A_OPUS")])), Ok(Probe { mime: "audio/webm", duration_ms: None }));
    }

    #[test]
    fn other_webms_are_refused() {
        assert_eq!(probe(&webm(None, &[track(1, b"V_VP8"), track(2, b"A_OPUS")])), Err(SOUND_ONLY));
        assert_eq!(probe(&webm(None, &[track(2, b"A_VORBIS")])), Err(CODECS));
        assert_eq!(probe(&webm(None, &[])), Err(NO_SOUND));
        let mut mkv = webm(None, &[track(2, b"A_OPUS")]);
        let at = mkv.windows(4).position(|w| w == b"webm").unwrap();
        mkv[at..at + 4].copy_from_slice(b"mkv!");
        assert_eq!(probe(&mkv), Err(WRONG_TYPE));
    }

    #[test]
    fn an_ogg_must_be_opus() {
        assert_eq!(probe(&ogg(b"OpusHead\x01\x01\x38\x01")), Ok(Probe { mime: "audio/ogg", duration_ms: None }));
        assert_eq!(probe(&ogg(b"\x01vorbis\x00\x00\x00\x00")), Err(CODECS));
        assert_eq!(probe(b"OggS"), Err(WRONG_TYPE));
    }

    #[test]
    fn anything_else_is_the_wrong_type() {
        assert_eq!(probe(&[0xFF, 0xD8, 0xFF, 0xE0]), Err(WRONG_TYPE));
        assert_eq!(probe(b"RIFF\0\0\0\0WAVEfmt "), Err(WRONG_TYPE));
        assert_eq!(probe(b"ID3\x04\x00"), Err(WRONG_TYPE));
        assert_eq!(probe(b""), Err(WRONG_TYPE));
    }

    #[test]
    fn the_length_is_the_longer_reading_and_must_be_known() {
        assert_eq!(length_of(Some(12_000), None), Ok(12_000));
        assert_eq!(length_of(None, Some(90_000)), Ok(90_000));
        assert_eq!(length_of(Some(120_900), None), Ok(120_900), "the recorder's rounding");
        assert_eq!(length_of(Some(5_000), Some(125_000)), Err(Failed::Refused(TOO_LONG)));
        assert_eq!(length_of(None, None), Err(Failed::Refused(UNKNOWN_LENGTH)));
        assert_eq!(length_of(Some(0), Some(0)), Err(Failed::Refused(UNKNOWN_LENGTH)));
    }

    #[test]
    fn ffprobe_codecs() {
        let c = |pairs: &[(&str, &str)]| pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(check_codecs("audio/webm", &c(&[("audio", "opus")])), Ok(()));
        assert_eq!(check_codecs("audio/ogg", &c(&[("audio", "opus")])), Ok(()));
        assert_eq!(check_codecs("audio/mp4", &c(&[("audio", "aac"), ("data", "bin_data")])), Ok(()));
        assert_eq!(check_codecs("audio/mp4", &c(&[("audio", "opus")])), Err(Failed::Refused(CODECS)));
        assert_eq!(check_codecs("audio/webm", &c(&[("audio", "vorbis")])), Err(Failed::Refused(CODECS)));
        assert_eq!(check_codecs("audio/webm", &c(&[("video", "vp8"), ("audio", "opus")])), Err(Failed::Refused(SOUND_ONLY)));
        assert_eq!(check_codecs("audio/webm", &c(&[])), Err(Failed::Refused(NO_SOUND)));
    }

    #[test]
    fn each_kind_keeps_its_own_key() {
        let id = Uuid::from_u128(7);
        assert_eq!(key_of(id, "audio/webm"), format!("chat-audio/{id}.webm"));
        assert_eq!(key_of(id, "audio/ogg"), format!("chat-audio/{id}.ogg"));
        assert_eq!(key_of(id, "audio/mp4"), format!("chat-audio/{id}.m4a"));
    }

    fn have_ffmpeg() -> bool {
        if std::env::var("FFMPEG_TESTS").as_deref() == Ok("off") {
            return false;
        }
        let ok = |name: &str| Command::new(name).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        let have = ok(&bin("FFMPEG", "ffmpeg")) && ok(&bin("FFPROBE", "ffprobe"));
        if !have {
            eprintln!("no ffmpeg/ffprobe here: the ffmpeg tests are skipped");
        }
        have
    }

    fn clip(scratch: &Scratch, seconds: u32, kind: &str) -> Vec<u8> {
        let out = scratch.file(&format!("clip.{kind}"));
        let mut cmd = Command::new(bin("FFMPEG", "ffmpeg"));
        cmd.args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440"]).args(["-t", &seconds.to_string(), "-metadata", "title=SECRET-TITLE"]);
        match kind {
            "webm" => cmd.args(["-c:a", "libopus", "-b:a", "24k", "-f", "webm", "-live", "1"]),
            "ogg" => cmd.args(["-c:a", "libopus", "-b:a", "24k", "-f", "ogg"]),
            _ => cmd.args(["-c:a", "aac", "-b:a", "32k", "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4"]),
        };
        let status = cmd.arg(&out).status().expect("ffmpeg");
        assert!(status.success(), "ffmpeg made no clip");
        std::fs::read(&out).unwrap()
    }

    #[test]
    fn a_recorded_clip_is_copied_bare_with_its_length() {
        if !have_ffmpeg() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        for (kind, mime) in [("webm", "audio/webm"), ("ogg", "audio/ogg"), ("m4a", "audio/mp4")] {
            let raw = clip(&scratch, 3, kind);
            assert_eq!(probe(&raw).map(|p| p.mime), Ok(mime), "{kind}");
            let ready = prepare(&raw, mime).unwrap_or_else(|e| panic!("a 3s {kind} is fine: {e:?}"));
            assert_eq!(ready.mime, mime, "{kind}");
            assert!(!ready.encoded, "{kind} copies");
            assert!((2_900..=3_200).contains(&ready.duration_ms), "{kind}: {}", ready.duration_ms);
            assert!(!ready.audio.windows(12).any(|w| w == b"SECRET-TITLE"), "{kind}: the copy keeps no metadata");
            assert_eq!(probe(&ready.audio).map(|p| p.mime), Ok(mime), "{kind}: the copy reads again");
        }
        let webm = clip(&scratch, 3, "webm");
        assert_eq!(probe(&webm).unwrap().duration_ms, None, "a live webm says no length");
        let ready = prepare(&webm, "audio/webm").unwrap();
        assert!(probe(&ready.audio).unwrap().duration_ms.is_some_and(|ms| (2_900..=3_200).contains(&ms)), "the copy says its length");
    }

    #[test]
    fn a_long_clip_is_refused() {
        if !have_ffmpeg() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        assert_eq!(prepare(&clip(&scratch, 125, "webm"), "audio/webm").unwrap_err(), Failed::Refused(TOO_LONG));
    }
}
