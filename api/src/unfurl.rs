use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::Semaphore;
use url::Url;
use uuid::Uuid;

use crate::chat::Line;
use crate::media::{self, Kind, Place};
use crate::moderate::UploadKind;
use crate::og::{self, Page};
use crate::ssrf::{self, Overflow, Want};
use crate::timings::Redis;
use crate::AppState;

const QUEUE: &str = "unfurl:jobs";
const QUEUE_KEEP: isize = 1000;
const QUEUE_TTL_SECS: i64 = 3600;
const JOB_MAX_AGE_MS: i64 = 120_000;
const JOB_TIMEOUT: Duration = Duration::from_secs(30);
const AT_ONCE: usize = 4;
const POP_SECS: f64 = 5.0;
const PAGE_TTL_SECS: u64 = 24 * 3600;
const MISS_TTL_SECS: u64 = 3600;
const PAGE_CAP: usize = 512 * 1024;
const IMAGE_CAP: usize = 4 * 1024 * 1024;
const STORED_CAP: usize = 256 * 1024;
const RATE_PER_WINDOW: i64 = 20;
const RATE_WINDOW_SECS: i64 = 60;
const MAX_SIDE: u32 = 864;
const SMALL_SIDE: u32 = 480;
const MIN_SIDE: u32 = 16;
const MAX_DECODE_SIDE: u32 = 8000;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MISS: &str = "-";
const HTML_TYPES: [&str; 2] = ["text/html", "application/xhtml+xml"];
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Embed {
    pub(crate) url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) image: Option<EmbedImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct EmbedImage {
    pub(crate) id: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Job {
    Room { room: String, server: Option<String>, id: String, user: Uuid, url: String, at: i64 },
    Dm { id: i64, from: Uuid, to: Uuid, url: String, at: i64 },
}

pub(crate) fn enabled() -> bool {
    !matches!(std::env::var("UNFURL").ok().map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("0" | "off" | "false" | "no"))
}

pub(crate) fn wanted(text: &str) -> Option<String> {
    if !enabled() {
        return None;
    }
    let link = og::first_link(text)?;
    let url = ssrf::check_url(&link).ok()?;
    if og::plays_inline(&url) {
        return None;
    }
    Some(url.to_string())
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) async fn enqueue(r: &mut Redis, job: &Job) {
    let Ok(raw) = serde_json::to_string(job) else { return };
    let pushed: Result<(), redis::RedisError> = redis::pipe().lpush(QUEUE, raw).ignore().ltrim(QUEUE, 0, QUEUE_KEEP - 1).ignore().expire(QUEUE, QUEUE_TTL_SECS).ignore().query_async(r).await;
    if let Err(e) = pushed {
        log::warn!("unfurl: queue: {e}");
    }
}

pub(crate) fn spawn_worker(s: AppState, redis_url: String) {
    if !enabled() {
        log::info!("unfurl: off (UNFURL)");
        return;
    }
    tokio::spawn(work(s, redis_url));
}

async fn work(s: AppState, redis_url: String) {
    let client = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => client,
        Err(e) => {
            log::warn!("unfurl: bad REDIS_URL: {e}");
            return;
        }
    };
    let config = crate::socket::blocking_config((POP_SECS * 1000.0) as usize);
    let slots = Arc::new(Semaphore::new(AT_ONCE));
    let mut con = None;
    loop {
        let Some(c) = con.as_mut() else {
            match client.get_multiplexed_async_connection_with_config(&config).await {
                Ok(c) => con = Some(c),
                Err(e) => {
                    log::warn!("unfurl: redis: {e}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
            continue;
        };
        let Ok(slot) = slots.clone().acquire_owned().await else { return };
        let popped: Result<Option<(String, String)>, _> = c.brpop(QUEUE, POP_SECS).await;
        let raw = match popped {
            Ok(Some((_, raw))) => raw,
            Ok(None) => continue,
            Err(e) => {
                log::warn!("unfurl: brpop: {e}");
                con = None;
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let Ok(job) = serde_json::from_str::<Job>(&raw) else { continue };
        let s = s.clone();
        tokio::spawn(async move {
            let _slot = slot;
            if tokio::time::timeout(JOB_TIMEOUT, run(&s, job)).await.is_err() {
                log::info!("unfurl: a job ran out of time");
            }
        });
    }
}

fn fresh(at: i64) -> bool {
    now_ms() - at < JOB_MAX_AGE_MS
}

async fn run(s: &AppState, job: Job) {
    match job {
        Job::Room { room, server, id, user, url, at } => {
            if !fresh(at) {
                return;
            }
            let place = Place::room(&room, server.as_deref());
            let Some(embed) = build(s, user, &url, &place).await else { return };
            if let Err(e) = keep_line(s, &room, &id, &embed).await {
                log::warn!("unfurl: {room} {id}: {}", e.message());
            }
        }
        Job::Dm { id, from, to, url, at } => {
            if !fresh(at) {
                return;
            }
            let Some(embed) = build(s, from, &url, &Place::dm(from, to)).await else { return };
            if let Err(e) = keep_dm(s, id, &embed).await {
                log::warn!("unfurl: dm {id}: {e}");
            }
        }
    }
}

async fn build(s: &AppState, user: Uuid, raw: &str, place: &Place) -> Option<Embed> {
    let url = ssrf::check_url(raw).ok()?;
    let page = page_for(s, user, &url).await?;
    embed_of(&url, page, s, user, place).await
}

async fn embed_of(url: &Url, page: Page, s: &AppState, user: Uuid, place: &Place) -> Option<Embed> {
    if page.title.is_none() && page.description.is_none() {
        return None;
    }
    let image = match &page.image {
        Some(raw) => picture_for(s, user, raw, place).await,
        None => None,
    };
    Some(Embed { url: url.to_string(), site: page.site, title: page.title, description: page.description, image, color: page.color })
}

fn page_key(url: &Url) -> String {
    format!("unfurl:page:{}", media::sha256_hex(url.as_str().as_bytes()))
}

async fn cached<T: for<'de> Deserialize<'de>>(r: &mut Redis, key: &str) -> Option<Option<T>> {
    let raw: Option<String> = r.get(key).await.ok()?;
    let raw = raw?;
    if raw == MISS {
        return Some(None);
    }
    serde_json::from_str(&raw).ok().map(Some)
}

async fn remember<T: Serialize>(r: &mut Redis, key: &str, value: Option<&T>) {
    let (raw, ttl) = match value.and_then(|v| serde_json::to_string(v).ok()) {
        Some(raw) => (raw, PAGE_TTL_SECS),
        None => (MISS.to_owned(), MISS_TTL_SECS),
    };
    let set: Result<(), redis::RedisError> = r.set_ex(key, raw, ttl).await;
    if let Err(e) = set {
        log::warn!("unfurl: cache: {e}");
    }
}

async fn page_for(s: &AppState, user: Uuid, url: &Url) -> Option<Page> {
    let mut r = s.redis.clone();
    let key = page_key(url);
    if let Some(hit) = cached::<Page>(&mut r, &key).await {
        return hit;
    }
    match crate::ratelimit::hit(&s.redis, &format!("rl:unfurl:{user}"), RATE_WINDOW_SECS).await {
        Ok((n, _)) if n <= RATE_PER_WINDOW => {}
        Ok(_) => return None,
        Err(e) => {
            log::warn!("unfurl: rate: {e}");
            return None;
        }
    }
    let want = Want { types: &HTML_TYPES, accept: "text/html,application/xhtml+xml;q=0.9", cap: PAGE_CAP, overflow: Overflow::Truncate };
    let page = match ssrf::fetch(url.clone(), &want).await {
        Ok(got) => Some(og::parse(&String::from_utf8_lossy(&got.body), &got.url)),
        Err(why) => {
            log::info!("unfurl: {} {why:?}", url.host_str().unwrap_or("?"));
            None
        }
    };
    remember(&mut r, &key, page.as_ref()).await;
    page
}

fn place_key(place: &Place) -> String {
    match place {
        Place::Stream { room } => format!("stream:{room}"),
        Place::Group { group, .. } => format!("group:{group}"),
        Place::Dm { a, b } => format!("dm:{a}:{b}"),
    }
}

async fn picture_for(s: &AppState, user: Uuid, raw: &str, place: &Place) -> Option<EmbedImage> {
    let mut r = s.redis.clone();
    let key = format!("unfurl:img:{}:{}", place_key(place), media::sha256_hex(raw.as_bytes()));
    if let Some(hit) = cached::<EmbedImage>(&mut r, &key).await {
        return hit;
    }
    let picture = fetch_picture(s, user, raw, place).await;
    remember(&mut r, &key, picture.as_ref()).await;
    picture
}

async fn fetch_picture(s: &AppState, user: Uuid, raw: &str, place: &Place) -> Option<EmbedImage> {
    let url = ssrf::check_url(raw).ok()?;
    let want = Want { types: &IMAGE_TYPES, accept: "image/webp,image/png,image/jpeg,image/gif;q=0.8", cap: IMAGE_CAP, overflow: Overflow::Refuse };
    let got = match ssrf::fetch(url, &want).await {
        Ok(got) => got,
        Err(why) => {
            log::info!("unfurl: picture {why:?}");
            return None;
        }
    };
    let shrunk = tokio::task::spawn_blocking(move || shrink(&got.body)).await.ok()??;
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM streamers WHERE id = $1").bind(user).fetch_optional(&s.db).await.ok()?;
    let account = crate::auth::Account { id: user, name: name? };
    let id = match crate::chat_images::store(s, &account, UploadKind::ChatImage, shrunk.mime, &shrunk.bytes, None).await {
        Ok(id) => id,
        Err(e) => {
            log::info!("unfurl: picture not kept: {}", e.message());
            return None;
        }
    };
    let facts: Option<(bool, bool, bool)> = sqlx::query_as("SELECT nsfw, graphic, moderated FROM chat_images WHERE id = $1").bind(id).fetch_optional(&s.db).await.ok()?;
    let (nsfw, graphic, moderated) = facts?;
    if nsfw || graphic || (crate::moderate::enabled() && !moderated) {
        crate::chat_images::discard(s, id, shrunk.mime).await;
        return None;
    }
    let id = id.to_string();
    if let Err(e) = media::mark_posted(&s.db, Kind::Image, &[id.as_str()], place).await {
        log::warn!("unfurl: posted: {e}");
        return None;
    }
    Some(EmbedImage { id, width: shrunk.width, height: shrunk.height })
}

pub(crate) struct Shrunk {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn shrink(body: &[u8]) -> Option<Shrunk> {
    let format = image::guess_format(body).ok()?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) {
        return None;
    }
    let mut reader = ImageReader::with_format(Cursor::new(body), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let picture = reader.decode().ok()?;
    let (w, h) = picture.dimensions();
    if w < MIN_SIDE || h < MIN_SIDE {
        return None;
    }
    let picture = fit(picture, MAX_SIDE);
    if see_through(&picture) {
        if let Some(bytes) = webp(&picture).filter(|b| b.len() <= STORED_CAP) {
            let (width, height) = picture.dimensions();
            return Some(Shrunk { bytes, mime: "image/webp", width, height });
        }
    }
    for (side, quality) in [(MAX_SIDE, 82), (MAX_SIDE, 68), (SMALL_SIDE, 70), (SMALL_SIDE, 50)] {
        let sized = fit(picture.clone(), side);
        let Some(bytes) = jpeg(&sized, quality) else { continue };
        if bytes.len() <= STORED_CAP {
            let (width, height) = sized.dimensions();
            return Some(Shrunk { bytes, mime: "image/jpeg", width, height });
        }
    }
    None
}

fn fit(picture: DynamicImage, side: u32) -> DynamicImage {
    let (w, h) = picture.dimensions();
    if w <= side && h <= side {
        return picture;
    }
    picture.resize(side, side, image::imageops::FilterType::Triangle)
}

fn see_through(picture: &DynamicImage) -> bool {
    picture.color().has_alpha() && picture.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

fn webp(picture: &DynamicImage) -> Option<Vec<u8>> {
    let rgba = picture.to_rgba8();
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out).encode(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8).ok()?;
    Some(out)
}

fn jpeg(picture: &DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let rgba = picture.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = u16::from(p.0[3]);
        let over = |c: u8| ((u16::from(c) * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([over(p.0[0]), over(p.0[1]), over(p.0[2])]));
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(&rgb).ok()?;
    Some(out)
}

async fn keep_line(s: &AppState, room: &str, id: &str, embed: &Embed) -> Result<(), crate::ApiError> {
    let value = serde_json::to_value(embed).map_err(|_| crate::ApiError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "embed"))?;
    let added = sqlx::query("INSERT INTO chat_embeds (room, line_id, embed) VALUES ($1, $2, $3) ON CONFLICT (room, line_id) DO NOTHING")
        .bind(room)
        .bind(id)
        .bind(value)
        .execute(&s.db)
        .await?;
    if added.rows_affected() == 0 {
        return Ok(());
    }
    let mut r = s.redis.clone();
    if crate::history::line_at(&s.db, &mut r, room, id).await?.is_none() {
        sqlx::query("DELETE FROM chat_embeds WHERE room = $1 AND line_id = $2").bind(room).bind(id).execute(&s.db).await?;
        return Ok(());
    }
    crate::chat::publish_embed(&mut r, room, id, Some(embed)).await?;
    Ok(())
}

async fn keep_dm(s: &AppState, id: i64, embed: &Embed) -> Result<(), sqlx::Error> {
    let value = serde_json::to_value(embed).unwrap_or(serde_json::Value::Null);
    let names: Option<(String, String)> = sqlx::query_as(
        "UPDATE dms d SET embed = $2 FROM streamers f, streamers t
         WHERE d.id = $1 AND d.embed IS NULL AND NOT d.embed_hidden AND f.id = d.from_id AND t.id = d.to_id
         RETURNING f.name, t.name",
    )
    .bind(id)
    .bind(value)
    .fetch_optional(&s.db)
    .await?;
    if let Some((from, to)) = names {
        publish_dm(&mut s.redis.clone(), &from, &to, id, Some(embed)).await;
    }
    Ok(())
}

pub(crate) async fn publish_dm(r: &mut Redis, from: &str, to: &str, id: i64, embed: Option<&Embed>) {
    let embed = embed.and_then(|e| serde_json::to_string(e).ok()).unwrap_or_default();
    crate::presence::publish(r, &[("type", "dm_embed".into()), ("name", to.into()), ("from", from.into()), ("id", id.to_string()), ("embed", embed)]).await;
}

pub(crate) fn parse_stored(raw: Option<&str>) -> Option<Embed> {
    raw.filter(|r| !r.is_empty()).and_then(|r| serde_json::from_str(r).ok())
}

pub(crate) fn from_row(embed: Option<serde_json::Value>, hidden: bool) -> Option<Embed> {
    if hidden {
        return None;
    }
    embed.and_then(|v| serde_json::from_value(v).ok())
}

pub(crate) async fn hide_line(db: &PgPool, r: &mut Redis, room: &str, id: &str) -> Result<(), crate::ApiError> {
    sqlx::query(
        "INSERT INTO chat_embeds (room, line_id, embed, hidden) VALUES ($1, $2, NULL, true)
         ON CONFLICT (room, line_id) DO UPDATE SET hidden = true, embed = NULL",
    )
    .bind(room)
    .bind(id)
    .execute(db)
    .await?;
    crate::chat::publish_embed(r, room, id, None).await?;
    Ok(())
}

pub(crate) async fn with_embeds<'a>(db: &PgPool, lines: impl IntoIterator<Item = (&'a str, &'a mut Line)>) {
    let mut lines: Vec<(&str, &mut Line)> = lines.into_iter().collect();
    for (_, line) in lines.iter_mut() {
        line.embed = None;
    }
    if lines.is_empty() {
        return;
    }
    let rooms: Vec<String> = lines.iter().map(|(room, _)| (*room).to_owned()).collect();
    let ids: Vec<String> = lines.iter().map(|(_, line)| line.id.clone()).collect();
    let rows: Vec<(String, String, serde_json::Value)> = match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query_as(
            "SELECT e.room, e.line_id, e.embed FROM chat_embeds e
             WHERE (e.room, e.line_id) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND NOT e.hidden AND e.embed IS NOT NULL",
        )
        .bind(&rooms)
        .bind(&ids)
        .fetch_all(db),
    )
    .await
    {
        Ok(Ok(rows)) => rows,
        Ok(Err(e)) => {
            log::warn!("cannot read the embeds on {} lines: {e}", lines.len());
            return;
        }
        Err(_) => {
            log::warn!("reading the embeds on {} lines timed out", lines.len());
            return;
        }
    };
    for (room, line_id, embed) in rows {
        if let Some((_, line)) = lines.iter_mut().find(|(r, l)| *r == room && l.id == line_id) {
            line.embed = serde_json::from_value(embed).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(picture: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        picture.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn a_link_in_a_line_is_wanted_once_and_only_if_safe() {
        assert_eq!(wanted("look https://en.wikipedia.org/wiki/Anime#History and https://example.com").as_deref(), Some("https://en.wikipedia.org/wiki/Anime"));
        assert_eq!(wanted("http://169.254.169.254/latest/meta-data/"), None);
        assert_eq!(wanted("http://localhost:8080/admin"), None);
        assert_eq!(wanted("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(wanted("just words"), None);
    }

    #[test]
    fn a_job_round_trips() {
        let job = Job::Room { room: "g/general".into(), server: Some("g".into()), id: "1-0".into(), user: Uuid::nil(), url: "https://example.com/".into(), at: 5 };
        let raw = serde_json::to_string(&job).unwrap();
        assert!(raw.contains(r#""kind":"room""#));
        assert_eq!(serde_json::from_str::<Job>(&raw).unwrap(), job);
        let dm = Job::Dm { id: 7, from: Uuid::nil(), to: Uuid::max(), url: "https://example.com/".into(), at: 5 };
        assert_eq!(serde_json::from_str::<Job>(&serde_json::to_string(&dm).unwrap()).unwrap(), dm);
    }

    #[test]
    fn an_old_job_is_dropped() {
        assert!(fresh(now_ms()));
        assert!(!fresh(now_ms() - JOB_MAX_AGE_MS - 1));
    }

    #[test]
    fn a_big_picture_is_shrunk_to_a_small_still() {
        let big = DynamicImage::ImageRgb8(image::RgbImage::from_fn(2000, 1000, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x ^ y) % 256) as u8])));
        let out = shrink(&encoded(&big, ImageFormat::Png)).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert!(out.bytes.len() <= STORED_CAP);
        assert_eq!((out.width, out.height), (MAX_SIDE, MAX_SIDE / 2));
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!(back.dimensions(), (out.width, out.height));
    }

    #[test]
    fn a_see_through_picture_stays_see_through() {
        let logo = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(64, 64, |x, _| image::Rgba([200, 30, 30, if x < 32 { 0 } else { 255 }])));
        let out = shrink(&encoded(&logo, ImageFormat::Png)).unwrap();
        assert_eq!(out.mime, "image/webp");
        assert_eq!((out.width, out.height), (64, 64));
    }

    #[test]
    fn garbage_tiny_and_unknown_pictures_are_refused() {
        assert!(shrink(b"<html>not a picture</html>").is_none());
        let tiny = DynamicImage::ImageRgb8(image::RgbImage::new(8, 8));
        assert!(shrink(&encoded(&tiny, ImageFormat::Png)).is_none());
        let bmp = DynamicImage::ImageRgb8(image::RgbImage::new(64, 64));
        let mut out = Cursor::new(Vec::new());
        if bmp.write_to(&mut out, ImageFormat::Bmp).is_ok() {
            assert!(shrink(&out.into_inner()).is_none());
        }
    }

    #[test]
    fn a_hidden_or_missing_embed_is_none() {
        let embed = Embed { url: "https://example.com/".into(), site: None, title: Some("t".into()), description: None, image: None, color: None };
        let value = serde_json::to_value(&embed).unwrap();
        assert_eq!(from_row(Some(value.clone()), false), Some(embed.clone()));
        assert_eq!(from_row(Some(value), true), None);
        assert_eq!(from_row(None, false), None);
        assert_eq!(parse_stored(Some("")), None);
        assert_eq!(parse_stored(Some(&serde_json::to_string(&embed).unwrap())), Some(embed));
    }
}
