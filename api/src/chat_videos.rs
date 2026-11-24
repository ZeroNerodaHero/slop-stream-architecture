//! A short video on a chat line, the pictures' way (chat_images.rs): the page posts the file
//! here, the say names the id, and the panel plays it back from the bucket. See docs/chat.md
//! "videos".
//!
//! An mp4 of H.264 (with AAC, or no sound) or a webm of VP8 or VP9 (with Opus, or no sound),
//! 10 mb and 30 seconds at most. The magic bytes say which container, and a walk of its header
//! (`probe`) refuses the wrong codecs before anything is run. Then ffprobe reads the file itself
//! (`prepare`): its streams' codecs again, and how long it really is, the container's word or its
//! packets' last timestamp, whichever is longer. One it cannot tell the length of is refused, as
//! is one over 30 seconds; the page's own reading is not asked for.
//!
//! What the bucket keeps is ffmpeg's copy, not the upload: the first video and sound stream
//! remuxed as they are (`-c copy`), every other stream, the metadata and the chapters left out,
//! an mp4's index at the front (`+faststart`). Only when that copy fails is it encoded again, an
//! H.264/AAC mp4 at modest settings. The poster is a frame ffmpeg draws from that copy (a second
//! in, or the first), kept as a chat picture of the uploader's. ffmpeg and ffprobe run on a
//! blocking thread, two jobs at most at once, each with a timeout and, on linux, limits on its
//! memory, cpu time and file size, reading only local files (`-protocol_whitelist file`) with the
//! demuxer named, never guessed.
//!
//! Who is served one is media.rs's: a stream's are public, a group channel's and a direct
//! message's are for those who may read them. A site admin may take one down (`take_down`).

use std::io::Read as _;
use std::path::{Path as FsPath, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody};
use axum::extract::{DefaultBodyLimit, Path, State};
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
use crate::media::{self, Kind};
use crate::{chat_images, s3};
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
/// ffmpeg jobs at once, across every upload: the box has few cores and a stream to serve.
static JOBS: Semaphore = Semaphore::const_new(2);

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // the 10 mb is this route's alone: every other body keeps axum's 2 mb
        .route("/api/chat-videos", post(upload).layer(DefaultBodyLimit::max(MAX_BYTES)))
        .route("/api/chat-videos/{id}", get(show).delete(take_down))
}

/// The poster of the video `id`, when the api kept one by that id and it still has its poster.
/// The say checks this before it keeps a line that names a video, and puts both ids on the line.
pub(crate) async fn poster_of(db: &PgPool, id: &str) -> Result<Option<Uuid>, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id) else { return Ok(None) };
    let poster: Option<Option<Uuid>> = sqlx::query_scalar("SELECT poster FROM chat_videos WHERE id = $1").bind(id).fetch_optional(db).await?;
    Ok(poster.flatten())
}

/// `POST /api/chat-videos`, the file as the body: 200 `{ id, poster, duration_ms }`, the poster
/// a chat picture the api drew. 401 for nobody; 413 `video too big`; 400 `not an mp4 or webm`,
/// the codecs' words, `video too long` or `could not tell how long that video is`; 429 past five
/// in ten minutes. A query (an older page's `?poster=` and `?duration=`) is not read.
async fn upload(State(s): State<AppState>, Me(me): Me, headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "log in to send a video"))?;
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
    // the header's word on the container and codecs, before anything is run
    let probe = probe(&body).map_err(|why| ApiError::new(StatusCode::BAD_REQUEST, why))?;
    if probe.duration_ms.is_some_and(|ms| ms > MAX_MS + SLACK_MS) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, TOO_LONG));
    }
    crate::auth::limit(&s, &format!("rl:chatvid:{}", me.id), RATE_WINDOW_SECS, RATE_PER_WINDOW, "slow down").await?;
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
            log::warn!("{}: chat video: {why}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not read that video"));
        }
    };
    if ready.video.len() > MAX_BYTES {
        return Err(too_big());
    }
    let ip = crate::ratelimit::forwarded_ip(&headers);
    // the poster is the one part of a video moderation looks at (moderate.rs), as the bytes kept
    let poster = chat_images::store(&s, &me, crate::moderate::UploadKind::VideoPoster, "image/jpeg", &ready.poster, ip.as_deref()).await?;
    // the row first, as the pictures do; a failed save deletes it, and the poster with it
    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO chat_videos (id, mime, bytes, duration_ms, poster, created_by, sha256, uploader_ip)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(ready.mime)
    .bind(ready.video.len() as i32)
    .bind(ready.duration_ms as i32)
    .bind(poster)
    .bind(me.id)
    .bind(media::sha256_hex(&ready.video))
    .bind(ip.as_deref())
    .fetch_one(&s.db)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            chat_images::discard(&s, poster, "image/jpeg").await;
            log::warn!("{}: chat video row: {e}", me.name);
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the video"));
        }
    };
    if let Err(e) = s3::put(&s.s3, &key_of(id, ready.mime), &ready.video, ready.mime).await {
        let _ = sqlx::query("DELETE FROM chat_videos WHERE id = $1").bind(id).execute(&s.db).await;
        chat_images::discard(&s, poster, "image/jpeg").await;
        log::warn!("{}: chat video: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not save the video"));
    }
    log::info!(
        "{}: chat video {id} ({} bytes in, {} kept, {} ms, {}{})",
        me.name,
        ready.bytes_in,
        ready.video.len(),
        ready.duration_ms,
        ready.mime,
        if ready.encoded { ", encoded again" } else { "" }
    );
    Ok(Json(json!({ "id": id, "poster": poster, "duration_ms": ready.duration_ms })))
}

fn too_big() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "video too big. 10 mb at most")
}

/// `GET /api/chat-videos/:id`: the file, or the part of it a `Range` asks for (206, one range;
/// several are answered with the whole, which the spec allows), so a player can seek, and
/// Safari, which will not play a video it cannot ask for in parts, plays it at all. To whoever
/// may see it (media.rs `access`): 401/403 for anyone else, 410 `removed` after a takedown.
async fn show(State(s): State<AppState>, Me(me): Me, Path(id): Path<String>, headers: HeaderMap) -> Result<Response, ApiError> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad video"));
    };
    let Some(access) = media::access(&s.db, Kind::Video, id, me.map(|m| m.id)).await? else {
        return Err(media::missing(&s.db, Kind::Video, id).await);
    };
    if let Some(no) = media::refused(&access) {
        return Err(no);
    }
    let row: Option<(String, i32)> = sqlx::query_as("SELECT mime, bytes FROM chat_videos WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some((mime, len)) = row else {
        return Err(media::missing(&s.db, Kind::Video, id).await);
    };
    let len = len.max(0) as u64;
    let key = key_of(id, &mime);
    let mut out = HeaderMap::new();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    media::headers(&mut out, access == media::Access::Public);
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

/// `DELETE /api/chat-videos/:id`: a site admin's takedown. The file out of the bucket, the row
/// gone, its poster taken down with it, and the lines naming it say "removed". 204; 401 nobody,
/// 403 anyone else, 404 no such video.
async fn take_down(State(s): State<AppState>, Me(me): Me, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let me = chat_images::admin(&s, me)?;
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad video"));
    };
    let row: Option<(String, Option<Uuid>)> = sqlx::query_as("SELECT mime, poster FROM chat_videos WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let Some((mime, poster)) = row else {
        return Err(media::missing(&s.db, Kind::Video, id).await);
    };
    if let Err(e) = s3::delete(&s.s3, &key_of(id, &mime)).await {
        log::warn!("{}: take down chat video {id}: {e}", me.name);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "could not delete the video"));
    }
    media::remember_removed(&s.db, Kind::Video, id, me.id).await?;
    sqlx::query("DELETE FROM chat_videos WHERE id = $1").bind(id).execute(&s.db).await?;
    if let Some(poster) = poster {
        let mime: Option<String> = sqlx::query_scalar("SELECT mime FROM chat_images WHERE id = $1").bind(poster).fetch_optional(&s.db).await?;
        if let Some(mime) = mime {
            chat_images::remove(&s, &me, poster, &mime).await?;
        }
    }
    log::info!("{}: took down chat video {id}", me.name);
    Ok(StatusCode::NO_CONTENT)
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

// ---- ffmpeg -------------------------------------------------------------------------------------

/// What `prepare` made of an upload: the file to keep, its type, its real length and a poster.
#[derive(Debug)]
struct Ready {
    mime: &'static str,
    video: Vec<u8>,
    poster: Vec<u8>,
    duration_ms: u64,
    bytes_in: usize,
    /// The copy failed and it was encoded again.
    encoded: bool,
}

#[derive(Debug, PartialEq)]
enum Failed {
    /// The file's fault: a 400 in these words.
    Refused(&'static str),
    /// Ours (ffmpeg missing, a timeout, the disk): logged, a 500.
    Broken(String),
}

const TOO_LONG: &str = "video too long. 30 seconds at most";
const UNKNOWN_LENGTH: &str = "could not tell how long that video is";
const UNREADABLE: &str = "could not read that video";

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const COPY_TIMEOUT: Duration = Duration::from_secs(30);
const ENCODE_TIMEOUT: Duration = Duration::from_secs(120);
const POSTER_TIMEOUT: Duration = Duration::from_secs(15);
/// ffprobe's packet list, at most: a 30 second clip's is a few hundred kb.
const MAX_PROBE_OUTPUT: u64 = 16 * 1024 * 1024;
/// A chat picture's ceiling (chat_images.rs): the poster is one.
const MAX_POSTER_BYTES: usize = 256 * 1024;

/// ffmpeg's and ffprobe's paths: `FFMPEG`/`FFPROBE` when set, otherwise found on the PATH.
fn bin(var: &str, name: &str) -> String {
    std::env::var(var).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| name.to_owned())
}

/// A directory of one upload's files, gone when this is.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> std::io::Result<Scratch> {
        let dir = std::env::temp_dir().join(format!("chat-video-{}", Uuid::from_u128(rand::random())));
        std::fs::create_dir(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Scratch(dir))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The upload made ready to keep, on a blocking thread: probed, its length checked, remuxed
/// (or, when that fails, encoded again), and a poster drawn.
fn prepare(body: &[u8], mime: &'static str) -> Result<Ready, Failed> {
    let (demuxer, ext) = if mime == "video/webm" { ("matroska", "webm") } else { ("mov", "mp4") };
    let scratch = Scratch::new().map_err(|e| Failed::Broken(format!("scratch dir: {e}")))?;
    let input = scratch.file(&format!("in.{ext}"));
    std::fs::write(&input, body).map_err(|e| Failed::Broken(format!("write the upload: {e}")))?;

    let streams = probe_streams(&scratch, &input, demuxer)?;
    check_codecs(mime, &streams.codecs)?;
    let packets_ms = packets_end_ms(&scratch, &input, demuxer)?;
    let duration_ms = length_of(streams.duration_ms, packets_ms)?;

    let copy = scratch.file(&format!("copy.{ext}"));
    let (kept, kept_mime, kept_demuxer, encoded) = match remux(&input, demuxer, &copy, mime) {
        Ok(()) => (copy, mime, demuxer, false),
        Err(why) => {
            log::info!("chat video: copy failed ({why}), encoding again");
            let encoded = scratch.file("encoded.mp4");
            encode(&input, demuxer, &encoded)?;
            (encoded, "video/mp4", "mov", true)
        }
    };
    let poster = poster(&scratch, &kept, kept_demuxer)?;
    let video = std::fs::read(&kept).map_err(|e| Failed::Broken(format!("read the copy: {e}")))?;
    if video.is_empty() {
        return Err(Failed::Broken("ffmpeg wrote nothing".to_owned()));
    }
    Ok(Ready { mime: kept_mime, video, poster, duration_ms: duration_ms.min(MAX_MS + SLACK_MS), bytes_in: body.len(), encoded })
}

/// The length to go by: the longer of the container's word and the packets' last timestamp, so
/// neither a header that lies short nor one that says nothing lets a long file by.
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

#[derive(Debug, Default)]
struct Streams {
    /// (codec_type, codec_name) of each stream.
    codecs: Vec<(String, String)>,
    duration_ms: Option<u64>,
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

/// ffprobe's word on the streams and the container's length.
fn probe_streams(scratch: &Scratch, input: &FsPath, demuxer: &str) -> Result<Streams, Failed> {
    let out = scratch.file("streams.json");
    let mut cmd = Command::new(bin("FFPROBE", "ffprobe"));
    cmd.args(["-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json"]).arg(input);
    run(&mut cmd, Some(&out), PROBE_TIMEOUT).map_err(|why| refused_or_broken(why, UNREADABLE))?;
    let raw = read_capped(&out, MAX_PROBE_OUTPUT)?;
    let parsed: ProbeJson = serde_json::from_slice(&raw).map_err(|e| Failed::Broken(format!("ffprobe json: {e}")))?;
    Ok(Streams {
        codecs: parsed.streams.into_iter().map(|s| (s.codec_type, s.codec_name)).collect(),
        duration_ms: parsed.format.and_then(|f| f.duration).as_deref().and_then(seconds_ms),
    })
}

/// The end of the last packet of any stream, in ms: `pts + duration`, read off every packet.
fn packets_end_ms(scratch: &Scratch, input: &FsPath, demuxer: &str) -> Result<Option<u64>, Failed> {
    let out = scratch.file("packets.csv");
    let mut cmd = Command::new(bin("FFPROBE", "ffprobe"));
    cmd.args(["-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0"]).arg(input);
    run(&mut cmd, Some(&out), PROBE_TIMEOUT).map_err(|why| refused_or_broken(why, UNREADABLE))?;
    let raw = read_capped(&out, MAX_PROBE_OUTPUT)?;
    Ok(last_packet_ms(&String::from_utf8_lossy(&raw)))
}

/// The packets' list as ffprobe writes it, `pts,duration[,…]` a line, `N/A` for one not known.
fn last_packet_ms(csv: &str) -> Option<u64> {
    csv.lines()
        .filter_map(|line| {
            let mut fields = line.split(',');
            let pts = fields.next().and_then(|f| f.trim().parse::<f64>().ok())?;
            let dur = fields.next().and_then(|f| f.trim().parse::<f64>().ok()).unwrap_or(0.0);
            let end = pts + dur.max(0.0);
            end.is_finite().then_some(end)
        })
        .fold(None, |most: Option<f64>, end| Some(most.map_or(end, |m| m.max(end))))
        .filter(|end| *end > 0.0)
        .map(|end| (end * 1000.0).round() as u64)
}

fn seconds_ms(raw: &str) -> Option<u64> {
    raw.trim().parse::<f64>().ok().filter(|s| s.is_finite() && *s > 0.0).map(|s| (s * 1000.0).round() as u64)
}

/// The container's codecs, by ffprobe this time: every video stream H.264 (mp4) or VP8/VP9
/// (webm), every sound stream AAC or Opus, and at least one video stream. Other streams (an
/// iPhone's metadata track, subtitles) are left out of the copy, so they do not matter here.
fn check_codecs(mime: &str, codecs: &[(String, String)]) -> Result<(), Failed> {
    let (videos, sounds, words): (&[&str], &[&str], &'static str) =
        if mime == "video/webm" { (&["vp8", "vp9"], &["opus"], WEBM_CODECS) } else { (&["h264"], &["aac"], MP4_CODECS) };
    let mut video = false;
    for (kind, codec) in codecs {
        match kind.as_str() {
            "video" if videos.contains(&codec.as_str()) => video = true,
            "video" => return Err(Failed::Refused(words)),
            "audio" if !sounds.contains(&codec.as_str()) => return Err(Failed::Refused(words)),
            _ => {}
        }
    }
    if !video {
        return Err(Failed::Refused(NO_VIDEO));
    }
    Ok(())
}

/// The first video and sound stream copied as they are into a fresh file of the same container:
/// no other stream, no metadata (the file's or a stream's), no chapters, no encoder's name, and
/// an mp4's index at the front so it plays before it has all come.
fn remux(input: &FsPath, demuxer: &str, out: &FsPath, mime: &str) -> Result<(), String> {
    let mut cmd = ffmpeg_reading(input, demuxer);
    cmd.args(["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"]);
    strip(&mut cmd);
    if mime == "video/webm" {
        cmd.args(["-f", "webm"]);
    } else {
        cmd.args(["-movflags", "+faststart", "-f", "mp4"]);
    }
    cmd.arg(out);
    run(&mut cmd, None, COPY_TIMEOUT).map_err(|why| why.to_string())?;
    match std::fs::metadata(out) {
        Ok(m) if m.len() > 0 => Ok(()),
        _ => Err("an empty copy".to_owned()),
    }
}

/// The copy's fallback: an H.264/AAC mp4, 1280 on its long side at most, a fast preset at a
/// modest quality on two threads, cut at the 30 seconds.
fn encode(input: &FsPath, demuxer: &str, out: &FsPath) -> Result<(), Failed> {
    let mut cmd = ffmpeg_reading(input, demuxer);
    cmd.args(["-map", "0:v:0", "-map", "0:a:0?", "-t", "30.5"])
        .args(["-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-threads", "2"])
        .args(["-c:a", "aac", "-b:a", "96k", "-ac", "2"]);
    strip(&mut cmd);
    cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(out);
    run(&mut cmd, None, ENCODE_TIMEOUT).map_err(|why| refused_or_broken(why, UNREADABLE))
}

/// A frame of the kept file as a jpeg, 640 on its long side at most: a second in, or the first
/// frame for a clip shorter than that.
fn poster(scratch: &Scratch, video: &FsPath, demuxer: &str) -> Result<Vec<u8>, Failed> {
    let out = scratch.file("poster.jpg");
    for at in [Some("1"), None] {
        let _ = std::fs::remove_file(&out);
        let mut cmd = Command::new(bin("FFMPEG", "ffmpeg"));
        cmd.args(["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file"]);
        if let Some(at) = at {
            cmd.args(["-ss", at]);
        }
        cmd.args(["-f", demuxer, "-i"]).arg(video);
        cmd.args(["-map", "0:v:0", "-frames:v", "1", "-vf", "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease"])
            .args(["-map_metadata", "-1", "-fflags", "+bitexact", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2"])
            .arg(&out);
        if let Err(why) = run(&mut cmd, None, POSTER_TIMEOUT) {
            if matches!(why, RunError::TimedOut | RunError::Spawn(_)) {
                return Err(Failed::Broken(format!("poster: {why}")));
            }
            continue;
        }
        if let Ok(jpeg) = std::fs::read(&out) {
            if jpeg.len() >= 3 && jpeg[..3] == [0xFF, 0xD8, 0xFF] && jpeg.len() <= MAX_POSTER_BYTES {
                return Ok(jpeg);
            }
        }
    }
    Err(Failed::Refused("no picture in that video"))
}

/// ffmpeg, reading `input` as `demuxer` and nothing but the local file, writing over its output.
fn ffmpeg_reading(input: &FsPath, demuxer: &str) -> Command {
    let mut cmd = Command::new(bin("FFMPEG", "ffmpeg"));
    cmd.args(["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-f", demuxer, "-i"]).arg(input);
    cmd
}

/// No metadata out: the file's, each stream's, the chapters', and no encoder's name.
fn strip(cmd: &mut Command) {
    cmd.args(["-map_metadata", "-1", "-map_metadata:s:v", "-1", "-map_metadata:s:a", "-1", "-map_chapters", "-1", "-fflags", "+bitexact"]);
}

#[derive(Debug)]
enum RunError {
    Spawn(std::io::Error),
    TimedOut,
    /// It ran and said no: the exit and the start of what it wrote to stderr.
    Exit(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Spawn(e) => write!(f, "could not start: {e}"),
            RunError::TimedOut => write!(f, "timed out"),
            RunError::Exit(why) => write!(f, "{why}"),
        }
    }
}

/// A file ffmpeg would not read is the file's fault; anything else is ours.
fn refused_or_broken(why: RunError, words: &'static str) -> Failed {
    match why {
        RunError::Exit(said) => {
            log::info!("chat video: {said}");
            Failed::Refused(words)
        }
        other => Failed::Broken(other.to_string()),
    }
}

fn read_capped(path: &FsPath, cap: u64) -> Result<Vec<u8>, Failed> {
    let file = std::fs::File::open(path).map_err(|e| Failed::Broken(format!("read {}: {e}", path.display())))?;
    let mut raw = Vec::new();
    file.take(cap + 1).read_to_end(&mut raw).map_err(|e| Failed::Broken(format!("read {}: {e}", path.display())))?;
    if raw.len() as u64 > cap {
        return Err(Failed::Refused(UNREADABLE));
    }
    Ok(raw)
}

/// One run of ffmpeg or ffprobe: stdin closed, stdout to `stdout` (or nowhere), stderr kept to
/// say why, killed past `timeout`. On linux, at a lower priority and with limits on its memory,
/// cpu seconds and the size of a file it writes, so one bad file cannot take the box.
fn run(cmd: &mut Command, stdout: Option<&FsPath>, timeout: Duration) -> Result<(), RunError> {
    let dir = stdout.and_then(FsPath::parent).map(FsPath::to_path_buf).unwrap_or_else(std::env::temp_dir);
    let err_path = dir.join(format!("stderr-{}", Uuid::from_u128(rand::random())));
    let err_file = std::fs::File::create(&err_path).map_err(RunError::Spawn)?;
    cmd.stdin(Stdio::null()).stderr(Stdio::from(err_file));
    match stdout {
        Some(path) => cmd.stdout(Stdio::from(std::fs::File::create(path).map_err(RunError::Spawn)?)),
        None => cmd.stdout(Stdio::null()),
    };
    limit(cmd);
    let mut child = cmd.spawn().map_err(RunError::Spawn)?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&err_path);
                return Err(RunError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                let _ = std::fs::remove_file(&err_path);
                return Err(RunError::Spawn(e));
            }
        }
    };
    let said = std::fs::read(&err_path).unwrap_or_default();
    let _ = std::fs::remove_file(&err_path);
    if status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&said[..said.len().min(400)]).trim().replace('\n', " | ");
    Err(RunError::Exit(format!("{status}: {said}")))
}

#[cfg(target_os = "linux")]
fn limit(cmd: &mut Command) {
    use std::os::unix::process::CommandExt as _;
    // SAFETY: between fork and exec only async-signal-safe calls (setrlimit, setpriority), no allocation
    unsafe {
        cmd.pre_exec(|| {
            let cap = |what, n: libc::rlim_t| {
                let lim = libc::rlimit { rlim_cur: n, rlim_max: n };
                libc::setrlimit(what, &lim);
            };
            cap(libc::RLIMIT_AS, 2 << 30);
            cap(libc::RLIMIT_CPU, 180);
            cap(libc::RLIMIT_FSIZE, 64 << 20);
            libc::setpriority(libc::PRIO_PROCESS, 0, 10);
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn limit(_: &mut Command) {}

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
    fn the_length_is_the_longer_reading_and_must_be_known() {
        assert_eq!(length_of(Some(12_000), None), Ok(12_000));
        // a recorder's webm: no word in the header, the packets say
        assert_eq!(length_of(None, Some(9_000)), Ok(9_000));
        // a header that lies short does not let a long file by
        assert_eq!(length_of(Some(5_000), Some(45_000)), Err(Failed::Refused(TOO_LONG)));
        assert_eq!(length_of(Some(31_000), Some(2_000)), Err(Failed::Refused(TOO_LONG)));
        assert_eq!(length_of(Some(30_400), None), Ok(30_400), "the container's rounding");
        // nothing known is refused: the page's own reading is not asked for any more
        assert_eq!(length_of(None, None), Err(Failed::Refused(UNKNOWN_LENGTH)));
        assert_eq!(length_of(Some(0), Some(0)), Err(Failed::Refused(UNKNOWN_LENGTH)));
    }

    #[test]
    fn the_packets_say_where_the_file_ends() {
        assert_eq!(last_packet_ms("0.000000,0.200000\n3.954000,0.020000\n3.994000,0.007000,\n1.0,0.5\n"), Some(4_001));
        assert_eq!(last_packet_ms("N/A,N/A\n2.5,N/A\n"), Some(2_500));
        assert_eq!(last_packet_ms(""), None);
        assert_eq!(last_packet_ms("N/A,0.04\n"), None);
    }

    #[test]
    fn ffprobe_codecs() {
        let c = |pairs: &[(&str, &str)]| pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(check_codecs("video/mp4", &c(&[("video", "h264"), ("audio", "aac"), ("data", "bin_data")])), Ok(()));
        assert_eq!(check_codecs("video/mp4", &c(&[("video", "hevc")])), Err(Failed::Refused(MP4_CODECS)));
        assert_eq!(check_codecs("video/mp4", &c(&[("video", "h264"), ("audio", "opus")])), Err(Failed::Refused(MP4_CODECS)));
        assert_eq!(check_codecs("video/webm", &c(&[("video", "vp9"), ("audio", "opus")])), Ok(()));
        assert_eq!(check_codecs("video/webm", &c(&[("video", "av1")])), Err(Failed::Refused(WEBM_CODECS)));
        assert_eq!(check_codecs("video/webm", &c(&[("audio", "opus")])), Err(Failed::Refused(NO_VIDEO)));
    }

    /// ffmpeg on this machine, or the ffmpeg tests skip (say so, and pass): the box's image has it,
    /// a laptop may not. `FFMPEG_TESTS=off` skips them on purpose.
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

    /// A test clip `seconds` long, made by ffmpeg: an H.264/AAC mp4, or a webm the way a browser's
    /// recorder writes one (`-live 1`: no duration in the header, clusters of unknown size). It
    /// carries a title, to see the copy leave it out.
    fn clip(scratch: &Scratch, seconds: u32, webm: bool) -> Vec<u8> {
        let out = scratch.file(if webm { "clip.webm" } else { "clip.mp4" });
        let mut cmd = Command::new(bin("FFMPEG", "ffmpeg"));
        cmd.args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-f", "lavfi", "-i", "sine=frequency=440"])
            .args(["-t", &seconds.to_string(), "-metadata", "title=SECRET-TITLE"]);
        if webm {
            cmd.args(["-c:v", "libvpx", "-deadline", "realtime", "-b:v", "50k", "-c:a", "libopus", "-f", "webm", "-live", "1"]);
        } else {
            cmd.args(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "mp4"]);
        }
        let status = cmd.arg(&out).status().expect("ffmpeg");
        assert!(status.success(), "ffmpeg made no clip");
        std::fs::read(&out).unwrap()
    }

    #[test]
    fn a_short_clip_is_copied_bare_with_a_poster() {
        if !have_ffmpeg() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let mp4 = clip(&scratch, 3, false);
        let ready = prepare(&mp4, "video/mp4").expect("a 3s mp4 is fine");
        assert_eq!(ready.mime, "video/mp4");
        assert!(!ready.encoded, "an H.264 mp4 copies");
        assert!((2_900..=3_200).contains(&ready.duration_ms), "{}", ready.duration_ms);
        assert!(!ready.video.windows(12).any(|w| w == b"SECRET-TITLE"), "the copy keeps no metadata");
        assert!(mp4.windows(12).any(|w| w == b"SECRET-TITLE"), "the clip did have it");
        assert_eq!(&ready.poster[..3], &[0xFF, 0xD8, 0xFF], "the poster is a jpeg");
        // faststart: the index before the frames
        let moov = ready.video.windows(4).position(|w| w == b"moov").unwrap();
        let mdat = ready.video.windows(4).position(|w| w == b"mdat").unwrap();
        assert!(moov < mdat, "moov first");

        // the copy's fallback, run on its own: an H.264 mp4 of the clip, with no metadata
        let input = scratch.file("again-in.mp4");
        std::fs::write(&input, &mp4).unwrap();
        let out = scratch.file("again.mp4");
        encode(&input, "mov", &out).expect("encodes");
        let again = std::fs::read(&out).unwrap();
        assert_eq!(probe(&again).map(|p| p.mime), Ok("video/mp4"));
        assert!(!again.windows(12).any(|w| w == b"SECRET-TITLE"));

        // a recorder's webm has no length in its header: the packets give it
        let webm = clip(&scratch, 3, true);
        assert_eq!(probe(&webm).unwrap().duration_ms, None);
        let ready = prepare(&webm, "video/webm").expect("a 3s recorder webm is fine");
        assert_eq!(ready.mime, "video/webm");
        assert!((2_900..=3_200).contains(&ready.duration_ms), "{}", ready.duration_ms);
        assert!(!ready.video.windows(12).any(|w| w == b"SECRET-TITLE"));
    }

    #[test]
    fn a_long_clip_is_refused() {
        if !have_ffmpeg() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        assert_eq!(prepare(&clip(&scratch, 32, false), "video/mp4").unwrap_err(), Failed::Refused(TOO_LONG));
        // no length in the header, and long all the same: the packets tell
        let webm = clip(&scratch, 33, true);
        assert_eq!(probe(&webm).unwrap().duration_ms, None);
        assert_eq!(prepare(&webm, "video/webm").unwrap_err(), Failed::Refused(TOO_LONG));
    }

    #[test]
    fn a_clip_of_unknown_length_is_refused() {
        if !have_ffmpeg() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let webm = clip(&scratch, 3, true);
        // the header, then one empty cluster (its timestamp alone): streams, and no length anywhere
        let cluster = webm.windows(4).position(|w| w == [0x1F, 0x43, 0xB6, 0x75]).unwrap();
        let mut bare = webm[..cluster].to_vec();
        bare.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, 0x83, 0xE7, 0x81, 0x00]);
        assert_eq!(probe(&bare).map(|p| p.duration_ms), Ok(None), "the header walk is happy with it");
        assert_eq!(prepare(&bare, "video/webm").unwrap_err(), Failed::Refused(UNKNOWN_LENGTH));
        // the header alone, cut before the cluster: ffprobe will not read it at all
        assert_eq!(prepare(&webm[..cluster], "video/webm").unwrap_err(), Failed::Refused(UNREADABLE));
    }

    #[test]
    fn a_run_past_its_timeout_is_killed() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let started = Instant::now();
        assert!(matches!(run(&mut cmd, None, Duration::from_millis(200)), Err(RunError::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(2));
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
