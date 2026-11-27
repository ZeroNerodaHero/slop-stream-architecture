use std::collections::{HashMap, HashSet};

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;

use crate::about_md::{html_to_md, render, text_to_md};
use crate::about_page::{about_key, clean_color, decode_entities, ensure_row, ext_of, file_src, http_url, StoredBlock, StoredPage, BLOCKS_MAX};
use crate::auth::Me;
use crate::chat::clean_text;
use crate::s3;
use crate::test_streamers::DummySecret;
use crate::{may_write, ApiError, ApiResult, AppState, Name};

pub(crate) const KINDS: [&str; 13] = ["heading", "text", "panel", "image", "gallery", "buttons", "socials", "schedule", "clip", "sound", "stats", "quote", "divider"];
const PHONES: [&str; 3] = ["full", "half", "hide"];
const FILLS: [&str; 4] = ["none", "card", "accent", "image"];
const FONTS: [&str; 4] = ["geist", "mono", "serif", "display"];
const ALIGNS: [&str; 3] = ["left", "center", "right"];
const SPAN_MIN: i64 = 3;
const SPAN_MAX: i64 = 12;
const TITLE_MAX: usize = 80;
const SUB_MAX: usize = 160;
const LABEL_MAX: usize = 40;
const MD_MAX: usize = 10_000;
const ITEMS_MAX: usize = 12;
const ID_MAX: usize = 16;
const MAX_DOC: usize = 2 * 1024 * 1024;
const CARD_X: i32 = 1600;
const SLOT: i32 = 100;
const MEDIA_AT: i32 = 50;
const CARD_TITLES: [&str; 7] = ["what i stream", "when i'm on", "my setup", "rules", "links", "faq", "more"];

type Files = HashMap<i64, (String, String)>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Item {
    pub(crate) file: i64,
    pub(crate) label: String,
    pub(crate) href: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Block {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) span: i64,
    pub(crate) phone: String,
    pub(crate) fill: String,
    pub(crate) accent: String,
    pub(crate) font: String,
    pub(crate) align: String,
    pub(crate) href: String,
    pub(crate) title: String,
    pub(crate) sub: String,
    pub(crate) md: String,
    pub(crate) file: i64,
    pub(crate) bg: i64,
    pub(crate) label: String,
    pub(crate) link: String,
    pub(crate) socials: bool,
    pub(crate) items: Vec<Item>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Doc {
    pub(crate) v: i64,
    pub(crate) blocks: Vec<Block>,
}

#[derive(Deserialize)]
struct DraftBody {
    blocks: Vec<Block>,
}

#[derive(Serialize)]
struct Shown<'a> {
    #[serde(flatten)]
    block: &'a Block,
    html: String,
}

struct Wants {
    title: bool,
    sub: bool,
    md: bool,
    href: bool,
    button: bool,
    items: bool,
    file: Option<&'static str>,
}

const NOTHING: Wants = Wants { title: false, sub: false, md: false, href: false, button: false, items: false, file: None };

fn wants(kind: &str) -> Wants {
    match kind {
        "heading" => Wants { title: true, sub: true, href: true, ..NOTHING },
        "text" => Wants { md: true, href: true, ..NOTHING },
        "panel" => Wants { title: true, md: true, href: true, button: true, file: Some("image"), ..NOTHING },
        "image" => Wants { title: true, href: true, file: Some("image"), ..NOTHING },
        "gallery" | "buttons" => Wants { items: true, ..NOTHING },
        "socials" | "divider" => Wants { title: true, ..NOTHING },
        "schedule" => Wants { title: true, md: true, ..NOTHING },
        "clip" => Wants { title: true, file: Some("video"), ..NOTHING },
        "sound" => Wants { title: true, file: Some("sound"), ..NOTHING },
        "quote" => Wants { md: true, sub: true, ..NOTHING },
        _ => NOTHING,
    }
}

fn default_span(kind: &str) -> i64 {
    match kind {
        "heading" | "gallery" | "divider" => 12,
        "buttons" | "socials" | "schedule" | "sound" | "stats" => 4,
        _ => 6,
    }
}

fn default_fill(kind: &str) -> &'static str {
    match kind {
        "heading" => "accent",
        "image" | "gallery" | "buttons" | "divider" | "clip" => "none",
        _ => "card",
    }
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message.into())
}

fn pick(value: &str, allowed: &[&'static str], fallback: &'static str) -> String {
    allowed.iter().find(|a| **a == value).copied().unwrap_or(fallback).to_owned()
}

fn line(raw: &str, max: usize) -> String {
    let flat: String = raw.chars().map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c }).collect();
    clean_text(&flat).chars().take(max).collect::<String>().trim().to_owned()
}

fn body(raw: &str) -> String {
    let unix = raw.replace("\r\n", "\n").replace('\r', "\n");
    clean_text(&unix).chars().take(MD_MAX).collect::<String>().trim_end().to_owned()
}

fn link(raw: &str, strict: bool) -> Result<String, ApiError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    match http_url(raw) {
        Some(href) => Ok(href),
        None if strict => Err(bad("not a link. it needs to be an http or https address")),
        None => Ok(String::new()),
    }
}

fn file(id: i64, want: &str, have: &Files, strict: bool) -> Result<i64, ApiError> {
    if id <= 0 {
        return Ok(0);
    }
    match have.get(&id) {
        Some((kind, _)) if kind == want => Ok(id),
        Some(_) if strict => Err(bad("that file is a different kind")),
        None if strict => Err(bad("no such file")),
        _ => Ok(0),
    }
}

fn clean(b: &Block, have: &Files, strict: bool) -> Result<Block, ApiError> {
    let Some(kind) = KINDS.iter().copied().find(|k| *k == b.kind) else {
        return Err(bad(format!("bad kind. one of {}", KINDS.join(", "))));
    };
    let w = wants(kind);
    let mut out = Block {
        id: b.id.clone(),
        kind: kind.to_owned(),
        span: if b.span <= 0 { default_span(kind) } else { b.span.clamp(SPAN_MIN, SPAN_MAX) },
        phone: pick(&b.phone, &PHONES, "full"),
        fill: pick(&b.fill, &FILLS, default_fill(kind)),
        accent: clean_color(&b.accent),
        font: pick(&b.font, &FONTS, "geist"),
        align: pick(&b.align, &ALIGNS, "left"),
        ..Block::default()
    };
    if w.title {
        out.title = line(&b.title, TITLE_MAX);
    }
    if w.sub {
        out.sub = line(&b.sub, SUB_MAX);
    }
    if w.md {
        out.md = body(&b.md);
    }
    if w.href {
        out.href = link(&b.href, strict)?;
    }
    if w.button {
        out.label = line(&b.label, LABEL_MAX);
        out.link = link(&b.link, strict)?;
    }
    if let Some(want) = w.file {
        out.file = file(b.file, want, have, strict)?;
    }
    if out.fill == "image" {
        out.bg = file(b.bg, "image", have, strict)?;
    }
    if kind == "stats" {
        out.socials = b.socials;
    }
    if w.items {
        if strict && b.items.len() > ITEMS_MAX {
            return Err(bad(format!("{ITEMS_MAX} items in a block at most")));
        }
        for it in b.items.iter().take(ITEMS_MAX) {
            let file = if kind == "gallery" { file(it.file, "image", have, strict)? } else { 0 };
            out.items.push(Item { file, label: line(&it.label, LABEL_MAX), href: link(&it.href, strict)? });
        }
    }
    Ok(out)
}

fn good_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= ID_MAX && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn fresh_id() -> String {
    format!("b{:x}", OsRng.next_u64() >> 24)
}

fn clean_all(blocks: &[Block], have: &Files) -> Result<Vec<Block>, ApiError> {
    if blocks.len() > BLOCKS_MAX {
        return Err(bad(format!("{BLOCKS_MAX} blocks at most")));
    }
    let mut out = blocks.iter().map(|b| clean(b, have, true)).collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    for b in &out {
        if good_id(&b.id) && !seen.insert(b.id.clone()) {
            return Err(bad("a block is on the page twice"));
        }
    }
    for b in out.iter_mut().filter(|b| !good_id(&b.id)) {
        loop {
            let id = fresh_id();
            if seen.insert(id.clone()) {
                b.id = id;
                break;
            }
        }
    }
    Ok(out)
}

fn normalize(blocks: &[Block], have: &Files) -> Vec<Block> {
    let mut seen = HashSet::new();
    blocks
        .iter()
        .take(BLOCKS_MAX)
        .filter_map(|b| clean(b, have, false).ok())
        .filter(|b| good_id(&b.id) && seen.insert(b.id.clone()))
        .collect()
}

fn files_of(blocks: &[Block]) -> impl Iterator<Item = i64> + '_ {
    blocks.iter().flat_map(|b| [b.file, b.bg].into_iter().chain(b.items.iter().map(|i| i.file))).filter(|id| *id > 0)
}

fn card_of(b: &StoredBlock) -> Option<(usize, i32)> {
    if b.x != CARD_X || b.y < 0 {
        return None;
    }
    let slot = usize::try_from(b.y / SLOT).ok().filter(|s| *s < CARD_TITLES.len())?;
    let part = b.y % SLOT;
    match b.kind.as_str() {
        "text" if part < MEDIA_AT => Some((slot, part)),
        "image" | "video" | "sound" if part >= MEDIA_AT => Some((slot, part)),
        _ => None,
    }
}

fn plain_between<'a>(html: &'a str, open: &str, close: &str) -> Option<(&'a str, &'a str)> {
    let rest = html.strip_prefix(open)?;
    let end = rest.find(close)?;
    let inner = &rest[..end];
    (!inner.contains('<')).then_some((inner, &rest[end + close.len()..]))
}

fn card_head(html: &str) -> Option<(String, String, String)> {
    let (title, rest) = plain_between(html, "<h3>", "</h3>")?;
    let (body, rest) = plain_between(rest, "<p>", "</p>")?;
    let link = if rest.is_empty() {
        ""
    } else {
        let (link, tail) = plain_between(rest, "<blockquote>", "</blockquote>")?;
        if !tail.is_empty() {
            return None;
        }
        link
    };
    Some((decode_entities(title), decode_entities(body), decode_entities(link)))
}

fn card_more(html: &str) -> Option<String> {
    let (body, rest) = plain_between(html, "<p>", "</p>")?;
    rest.is_empty().then(|| decode_entities(body))
}

fn short_link(href: &str) -> String {
    let Ok(url) = url::Url::parse(href) else { return href.chars().take(LABEL_MAX).collect() };
    let host = url.host_str().unwrap_or_default().trim_start_matches("www.");
    let path = if url.path() == "/" { "" } else { url.path() };
    format!("{host}{path}").chars().take(LABEL_MAX).collect()
}

fn span_of(w: i32, fallback: i32) -> i64 {
    let w = if w > 0 { w } else { fallback };
    ((i64::from(w) * 12 + 400) / 800).clamp(SPAN_MIN, SPAN_MAX)
}

fn media_block(b: &StoredBlock, span: i64) -> Block {
    let kind = match b.kind.as_str() {
        "image" => "image",
        "video" => "clip",
        _ => "sound",
    };
    Block { kind: kind.to_owned(), span, file: b.id, ..Block::default() }
}

pub(crate) fn upgrade(v1: &StoredPage, texts: &HashMap<i64, String>) -> Vec<Block> {
    let mut words: Vec<Vec<(i32, &StoredBlock)>> = (0..CARD_TITLES.len()).map(|_| Vec::new()).collect();
    let mut media: Vec<Vec<(i32, &StoredBlock)>> = (0..CARD_TITLES.len()).map(|_| Vec::new()).collect();
    let mut legacy: Vec<&StoredBlock> = Vec::new();
    for b in &v1.blocks {
        match card_of(b) {
            Some((slot, part)) if b.kind == "text" => words[slot].push((part, b)),
            Some((slot, part)) => media[slot].push((part, b)),
            None => legacy.push(b),
        }
    }
    let mut out = Vec::new();
    for slot in 0..CARD_TITLES.len() {
        words[slot].sort_by_key(|(part, _)| *part);
        media[slot].sort_by_key(|(part, _)| *part);
        let Some((_, first)) = words[slot].first().or(media[slot].first()) else { continue };
        if first.z <= 0 {
            continue;
        }
        let mut title = CARD_TITLES[slot].to_owned();
        let mut link_to = String::new();
        let mut segments: Vec<String> = Vec::new();
        let mut plain = String::new();
        for (i, (_, b)) in words[slot].iter().enumerate() {
            let html = texts.get(&b.id).map(String::as_str).unwrap_or_default();
            if let Some((t, body, l)) = (i == 0).then(|| card_head(html)).flatten() {
                let t = line(&t, TITLE_MAX);
                if !t.is_empty() {
                    title = t;
                }
                plain.push_str(&body);
                link_to = http_url(&l).unwrap_or_default();
            } else if let Some(more) = (i > 0).then(|| card_more(html)).flatten() {
                plain.push_str(&more);
            } else {
                if !plain.trim().is_empty() {
                    segments.push(text_to_md(&plain));
                }
                plain.clear();
                let md = html_to_md(html);
                if !md.is_empty() {
                    segments.push(md);
                }
            }
        }
        if !plain.trim().is_empty() {
            segments.push(text_to_md(&plain));
        }
        let files: Vec<&StoredBlock> = media[slot].iter().map(|(_, b)| *b).filter(|b| b.id > 0).collect();
        let md = segments.join("\n\n");
        if md.trim().is_empty() && link_to.is_empty() && files.is_empty() {
            continue;
        }
        let picture = files.iter().find(|b| b.kind == "image").map(|b| b.id);
        let mut panel = Block { kind: "panel".to_owned(), span: 6, title, md, file: picture.unwrap_or(0), ..Block::default() };
        if !link_to.is_empty() {
            panel.label = short_link(&link_to);
            panel.link = link_to;
        }
        out.push(panel);
        for m in files {
            if Some(m.id) != picture {
                out.push(media_block(m, 6));
            }
        }
    }
    legacy.sort_by_key(|b| (b.y, b.x, b.z));
    for b in legacy {
        match b.kind.as_str() {
            "text" => {
                let md = texts.get(&b.id).map(|h| html_to_md(h)).unwrap_or_default();
                if !md.is_empty() {
                    out.push(Block { kind: "text".to_owned(), span: span_of(b.w, 280), md, align: b.look.align.clone(), ..Block::default() });
                }
            }
            "image" if b.id > 0 => out.push(media_block(b, span_of(b.w, 300))),
            "video" if b.id > 0 => out.push(media_block(b, span_of(b.w, 320))),
            "sound" if b.id > 0 => out.push(media_block(b, span_of(b.w, 280))),
            _ => {}
        }
    }
    for (i, b) in out.iter_mut().enumerate() {
        b.id = format!("u{i}");
    }
    out
}

struct Loaded {
    row: Option<uuid::Uuid>,
    v1: StoredPage,
    draft: Option<Doc>,
    live: Option<Doc>,
    have: Files,
    socials: Value,
    joined: Option<DateTime<Utc>>,
    avatar: Option<i64>,
}

type LoadRow = (uuid::Uuid, Value, Option<Value>, Option<Value>, Value, Option<DateTime<Utc>>, Option<i64>);

async fn load(conn: &mut PgConnection, name: &str) -> Result<Loaded, ApiError> {
    let row: Option<LoadRow> = sqlx::query_as(
        "SELECT id, about_page, about_draft, about_live, socials, CASE WHEN password_hash IS NOT NULL THEN created_at END,
                (EXTRACT(EPOCH FROM avatar_at))::bigint
         FROM streamers WHERE name = $1",
    )
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;
    let files: Vec<(i64, String, String)> = sqlx::query_as("SELECT id, kind, mime FROM about_files WHERE name = $1").bind(name).fetch_all(&mut *conn).await?;
    let have: Files = files.into_iter().map(|(id, kind, mime)| (id, (kind, mime))).collect();
    let Some((row, v1, draft, live, socials, joined, avatar)) = row else {
        return Ok(Loaded { row: None, v1: StoredPage::default(), draft: None, live: None, have, socials: Value::Null, joined: None, avatar: None });
    };
    let doc = |v: Option<Value>| v.and_then(|v| serde_json::from_value::<Doc>(v).ok());
    Ok(Loaded {
        row: Some(row),
        v1: serde_json::from_value(v1).unwrap_or_default(),
        draft: doc(draft),
        live: doc(live),
        have,
        socials,
        joined,
        avatar,
    })
}

async fn upgraded(s: &AppState, l: &Loaded) -> Vec<Block> {
    let Some(row) = l.row else { return Vec::new() };
    let mut texts = HashMap::new();
    for b in l.v1.blocks.iter().filter(|b| b.kind == "text") {
        if !matches!(l.have.get(&b.id), Some((kind, _)) if kind == "text") {
            continue;
        }
        match s3::get(&s.s3, &about_key(row, b.id, "html")).await {
            Ok(Some(bytes)) => {
                texts.insert(b.id, String::from_utf8(bytes).unwrap_or_default());
            }
            Ok(None) => {}
            Err(e) => log::warn!("s3: about text {} for an old page: {e}", b.id),
        }
    }
    normalize(&upgrade(&l.v1, &texts), &l.have)
}

async fn pages(s: &AppState, l: &Loaded) -> (Vec<Block>, Vec<Block>) {
    let live = match &l.live {
        Some(doc) => normalize(&doc.blocks, &l.have),
        None => upgraded(s, l).await,
    };
    let draft = match &l.draft {
        Some(doc) => normalize(&doc.blocks, &l.have),
        None => live.clone(),
    };
    (draft, live)
}

fn shown(blocks: &[Block]) -> Vec<Shown<'_>> {
    blocks.iter().map(|block| Shown { block, html: render(&block.md) }).collect()
}

async fn answer(s: &AppState, name: &str, l: &Loaded, blocks: &[Block]) -> Result<Value, ApiError> {
    let followers = crate::follows::stats(&s.db, name, None).await?.followers;
    let streams: i64 = match (l.joined, l.row) {
        (Some(_), Some(id)) => sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id = $1").bind(id).fetch_one(&s.db).await?,
        _ => sqlx::query_scalar("SELECT count(*) FROM sessions WHERE name = $1").bind(name).fetch_one(&s.db).await?,
    };
    let socials = serde_json::from_value::<crate::profile::Socials>(l.socials.clone()).unwrap_or_default();
    Ok(json!({ "blocks": shown(blocks), "followers": followers, "streams": streams, "joined": l.joined, "avatar": l.avatar, "socials": socials }))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/streamers/{name}/about-blocks",
            get(get_live).layer(axum::middleware::map_response(crate::media::public_cache(crate::media::ABOUT_PAGE_CACHE))).put(put_draft).layer(DefaultBodyLimit::max(MAX_DOC)),
        )
        .route("/api/streamers/{name}/about-blocks/draft", get(get_draft))
        .route("/api/streamers/{name}/about-blocks/publish", post(publish))
}

async fn get_live(State(s): State<AppState>, Name(name): Name) -> ApiResult {
    let mut conn = s.db.acquire().await?;
    let l = load(&mut conn, &name).await?;
    drop(conn);
    let (_, live) = pages(&s, &l).await;
    Ok(Json(answer(&s, &name, &l, &live).await?))
}

async fn draft_answer(s: &AppState, name: &str, l: &Loaded) -> ApiResult {
    let (draft, live) = pages(s, l).await;
    let mut out = answer(s, name, l, &draft).await?;
    out["changed"] = json!(draft != live);
    Ok(Json(out))
}

async fn get_draft(State(s): State<AppState>, Name(name): Name, me: Me, secret: DummySecret) -> ApiResult {
    may_write(&s, &name, me.name(), secret.0.as_deref()).await?;
    let mut conn = s.db.acquire().await?;
    let l = load(&mut conn, &name).await?;
    drop(conn);
    draft_answer(&s, &name, &l).await
}

async fn locked<F>(s: &AppState, name: &str, work: F) -> ApiResult
where
    F: for<'c> FnOnce(&'c mut PgConnection) -> std::pin::Pin<Box<dyn std::future::Future<Output = ApiResult> + Send + 'c>>,
{
    let mut conn = s.db.acquire().await?;
    let lock = format!("about-page:{name}");
    sqlx::query("SELECT pg_advisory_lock(hashtext($1))").bind(&lock).execute(&mut *conn).await?;
    let result = work(&mut conn).await;
    if let Err(e) = sqlx::query("SELECT pg_advisory_unlock(hashtext($1))").bind(&lock).execute(&mut *conn).await {
        log::warn!("postgres: about page lock for {name} stayed: {e}");
    }
    result
}

async fn put_draft(State(s): State<AppState>, Name(name): Name, me: Me, secret: DummySecret, body: Result<Json<DraftBody>, JsonRejection>) -> ApiResult {
    let Json(body) = body.map_err(|_| bad("bad json body"))?;
    may_write(&s, &name, me.name(), secret.0.as_deref()).await?;
    if body.blocks.len() > BLOCKS_MAX {
        return Err(bad(format!("{BLOCKS_MAX} blocks at most")));
    }
    let row = ensure_row(&s.db, &name).await?;
    let state = s.clone();
    let who = name.clone();
    locked(&s, &name, move |conn| {
        Box::pin(async move {
            let l = load(conn, &who).await?;
            let blocks = clean_all(&body.blocks, &l.have)?;
            let doc = serde_json::to_value(Doc { v: 2, blocks }).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the page"))?;
            sqlx::query("UPDATE streamers SET about_draft = $2, updated_at = now() WHERE name = $1").bind(&who).bind(doc).execute(&mut *conn).await?;
            sweep(&state, conn, &who, row).await?;
            let l = load(conn, &who).await?;
            log::info!("{who}: about draft saved");
            draft_answer(&state, &who, &l).await
        })
    })
    .await
}

async fn publish(State(s): State<AppState>, Name(name): Name, me: Me, secret: DummySecret) -> ApiResult {
    may_write(&s, &name, me.name(), secret.0.as_deref()).await?;
    let row = ensure_row(&s.db, &name).await?;
    let state = s.clone();
    let who = name.clone();
    locked(&s, &name, move |conn| {
        Box::pin(async move {
            let l = load(conn, &who).await?;
            let (draft, _) = pages(&state, &l).await;
            let doc = serde_json::to_value(Doc { v: 2, blocks: draft }).map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not publish the page"))?;
            sqlx::query("UPDATE streamers SET about_live = $2, about_draft = NULL, updated_at = now() WHERE name = $1").bind(&who).bind(doc).execute(&mut *conn).await?;
            sweep(&state, conn, &who, row).await?;
            crate::cf_purge::purge(vec![format!("/api/streamers/{who}/about-blocks")]);
            let l = load(conn, &who).await?;
            log::info!("{who}: about page published");
            draft_answer(&state, &who, &l).await
        })
    })
    .await
}

pub(crate) async fn kept_by_blocks(conn: &mut PgConnection, name: &str) -> Result<HashSet<i64>, sqlx::Error> {
    let row: Option<(Option<Value>, Option<Value>)> =
        sqlx::query_as("SELECT about_draft, about_live FROM streamers WHERE name = $1").bind(name).fetch_optional(&mut *conn).await?;
    let mut kept = HashSet::new();
    let Some((draft, live)) = row else { return Ok(kept) };
    for doc in [draft, live].into_iter().flatten() {
        if let Ok(doc) = serde_json::from_value::<Doc>(doc) {
            kept.extend(files_of(&doc.blocks));
        }
    }
    Ok(kept)
}

async fn sweep(s: &AppState, conn: &mut PgConnection, name: &str, row: uuid::Uuid) -> Result<(), ApiError> {
    let mut kept = kept_by_blocks(&mut *conn, name).await?;
    let v1: Option<Value> = sqlx::query_scalar("SELECT about_page FROM streamers WHERE name = $1").bind(name).fetch_optional(&mut *conn).await?;
    let v1: StoredPage = v1.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    kept.extend(v1.blocks.iter().map(|b| b.id));
    let stale: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, kind, mime FROM about_files WHERE name = $1 AND kind <> 'text' AND created_at < now() - interval '1 hour'",
    )
    .bind(name)
    .fetch_all(&mut *conn)
    .await?;
    for (id, kind, mime) in stale {
        if kept.contains(&id) {
            continue;
        }
        if let Err(e) = s3::delete(&s.s3, &about_key(row, id, ext_of(&kind, &mime))).await {
            log::warn!("s3: {name}'s about file {id} is on no page, and the object stayed: {e}");
            continue;
        }
        sqlx::query("DELETE FROM about_files WHERE name = $1 AND id = $2").bind(name).bind(id).execute(&mut *conn).await?;
        crate::cf_purge::purge(vec![file_src(name, id)]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> Files {
        let mut have = HashMap::new();
        have.insert(7, ("image".to_owned(), "image/png".to_owned()));
        have.insert(8, ("sound".to_owned(), "audio/mpeg".to_owned()));
        have.insert(9, ("video".to_owned(), "video/mp4".to_owned()));
        have
    }

    fn block(kind: &str) -> Block {
        Block { kind: kind.to_owned(), ..Block::default() }
    }

    #[test]
    fn a_block_keeps_only_what_its_kind_has() {
        let have = files();
        let mut text = block("text");
        text.md = "**hi**".into();
        text.title = "dropped".into();
        text.file = 7;
        text.span = 40;
        text.phone = "tablet".into();
        text.accent = "#FF00AA".into();
        let kept = clean(&text, &have, true).unwrap();
        assert_eq!((kept.span, kept.phone.as_str(), kept.fill.as_str(), kept.accent.as_str()), (12, "full", "card", "#ff00aa"));
        assert_eq!((kept.title.as_str(), kept.file, kept.md.as_str()), ("", 0, "**hi**"));
        let mut panel = block("panel");
        panel.file = 7;
        panel.label = "join".into();
        panel.link = "https://discord.gg/wolf".into();
        panel.span = 1;
        let kept = clean(&panel, &have, true).unwrap();
        assert_eq!((kept.file, kept.span, kept.link.as_str()), (7, 3, "https://discord.gg/wolf"));
        let mut gallery = block("gallery");
        gallery.items = vec![Item { file: 7, label: "wip rig".into(), href: String::new() }];
        assert_eq!(clean(&gallery, &have, true).unwrap().items[0].file, 7);
    }

    #[test]
    fn a_bad_link_or_file_is_refused_when_saved() {
        let have = files();
        let mut text = block("text");
        text.href = "javascript:alert(1)".into();
        assert_eq!(clean(&text, &have, true).unwrap_err().message(), "not a link. it needs to be an http or https address");
        assert_eq!(clean(&text, &have, false).unwrap().href, "");
        let mut clip = block("clip");
        clip.file = 7;
        assert_eq!(clean(&clip, &have, true).unwrap_err().message(), "that file is a different kind");
        clip.file = 99;
        assert_eq!(clean(&clip, &have, true).unwrap_err().message(), "no such file");
        assert_eq!(clean(&clip, &have, false).unwrap().file, 0);
        assert!(clean(&block("iframe"), &have, true).unwrap_err().message().starts_with("bad kind. one of heading, text"));
        let mut buttons = block("buttons");
        buttons.items = (0..13).map(|_| Item::default()).collect();
        assert_eq!(clean(&buttons, &have, true).unwrap_err().message(), "12 items in a block at most");
    }

    #[test]
    fn ids_are_kept_given_or_refused_twice() {
        let have = files();
        let mut a = block("divider");
        a.id = "keep-1".into();
        let mut b = block("divider");
        b.id = "NOT OK".into();
        let out = clean_all(&[a.clone(), b], &have).unwrap();
        assert_eq!(out[0].id, "keep-1");
        assert!(good_id(&out[1].id) && out[1].id != "keep-1");
        assert_eq!(clean_all(&[a.clone(), a.clone()], &have).unwrap_err().message(), "a block is on the page twice");
        let many: Vec<Block> = (0..=BLOCKS_MAX).map(|_| block("divider")).collect();
        assert_eq!(clean_all(&many, &have).unwrap_err().message(), "60 blocks at most");
    }

    fn stored(kind: &str, id: i64, x: i32, y: i32, z: i32, w: i32) -> StoredBlock {
        StoredBlock { kind: kind.to_owned(), id, x, y, z, w, h: 0, look: crate::about_page::Paint::default() }
    }

    #[test]
    fn old_cards_become_panels_in_their_order() {
        let page = StoredPage {
            blocks: vec![
                stored("text", 30, 1600, 300, 1, 0),
                stored("image", 7, 1600, 350, 1, 0),
                stored("text", 10, 1600, 0, 1, 0),
                stored("text", 11, 1600, 1, 1, 0),
                stored("text", 20, 1600, 200, 0, 0),
                stored("text", 40, 24, 500, 1, 520),
                stored("sound", 8, 40, 100, 1, 0),
                stored("box", 50, 0, 0, 1, 0),
            ],
        };
        let mut texts = HashMap::new();
        texts.insert(10, "<h3>what i play</h3><p>horror *games* &amp; ".to_owned() + "chat</p><blockquote>https://www.kit.co/wolf</blockquote>");
        texts.insert(11, "<p> and more</p>".to_owned());
        texts.insert(20, "<h3>off</h3><p>hidden</p>".to_owned());
        texts.insert(30, "<h3>rules</h3><p>1. be nice\n2. no spoilers</p>".to_owned());
        texts.insert(40, "<p>old <b>canvas</b> words</p>".to_owned());
        let out = upgrade(&page, &texts);
        let kinds: Vec<&str> = out.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["panel", "panel", "sound", "text"]);
        assert_eq!(out[0].title, "what i play");
        assert_eq!(out[0].md, "horror \\*games\\* & chat and more");
        assert_eq!((out[0].label.as_str(), out[0].link.as_str()), ("kit.co/wolf", "https://www.kit.co/wolf"));
        assert_eq!((out[1].title.as_str(), out[1].file, out[1].span), ("rules", 7, 6));
        assert_eq!(render(&out[1].md), "<ol><li>be nice</li><li>no spoilers</li></ol>");
        assert_eq!((out[2].file, out[2].span), (8, 4));
        assert_eq!((out[3].md.as_str(), out[3].span), ("old **canvas** words", 8));
        let ids: Vec<&str> = out.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["u0", "u1", "u2", "u3"]);
        let kept = normalize(&out, &files());
        assert_eq!(kept.len(), 4);
        assert_eq!(kept[0].fill, "card");
    }

    #[test]
    fn the_stored_document_reads_back_the_same() {
        let have = files();
        let mut heading = block("heading");
        heading.title = "WOLF HOURS".into();
        heading.sub = "rigs · chats · late night".into();
        heading.fill = "image".into();
        heading.bg = 7;
        let saved = clean_all(&[heading], &have).unwrap();
        let doc = serde_json::to_value(Doc { v: 2, blocks: saved.clone() }).unwrap();
        let back: Doc = serde_json::from_value(doc).unwrap();
        assert_eq!(normalize(&back.blocks, &have), saved);
        assert_eq!(files_of(&saved).collect::<Vec<_>>(), vec![7]);
    }
}
