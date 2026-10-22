//! The profile picture, and the one html route: the watch document.
//!
//! The picture is a small jpeg the browser makes from whatever file was picked
//! (256x256, see the live page) and is kept as bytes in the streamers row. Its
//! url carries the upload time as `?v=`, so it is cached for a day and still
//! changes the moment a new one is saved. Only the name's owner may change it,
//! the same rule as the bio.
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

use std::env;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;

use crate::auth::{self, Me};
use crate::{is_live, thumb_exists, valid_name, ApiError, ApiResult, AppState, Name};

/// The browser sends 256x256 at quality 0.85, a few tens of kb. This is the ceiling.
const MAX_AVATAR_BYTES: usize = 256 * 1024;
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
}

/// Bio, picture version and account flag in one query. A name nobody saved anything for is all defaults.
pub(crate) async fn load_profile(db: &PgPool, name: &str) -> Result<Profile, sqlx::Error> {
    let row: Option<(String, Option<i64>, bool)> = sqlx::query_as(
        "SELECT bio, (EXTRACT(EPOCH FROM avatar_at))::bigint, password_hash IS NOT NULL
         FROM streamers WHERE name = $1",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    let (bio, avatar, verified) = row.unwrap_or_default();
    Ok(Profile { name: name.to_owned(), bio, avatar, verified })
}

// ---- the picture ---------------------------------------------------------------------

async fn get_avatar(State(s): State<AppState>, Name(name): Name) -> Result<Response, ApiError> {
    let bytes: Option<Option<Vec<u8>>> = sqlx::query_scalar("SELECT avatar FROM streamers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&s.db)
        .await?;
    let Some(bytes) = bytes.flatten() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no picture"));
    };
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, AVATAR_CACHE)], bytes).into_response())
}

/// The body is the jpeg itself, not a form. The page resizes before sending.
async fn put_avatar(State(s): State<AppState>, Name(name): Name, Me(me): Me, body: Bytes) -> ApiResult {
    auth::may_act_as(&s.db, &name, me.as_deref()).await?;
    if body.len() > MAX_AVATAR_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big. 256 kb at most"));
    }
    if !body.starts_with(&JPEG_MAGIC) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a jpeg"));
    }
    let version: i64 = sqlx::query_scalar(
        "INSERT INTO streamers (name, avatar, avatar_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET avatar = EXCLUDED.avatar, avatar_at = now(), updated_at = now()
         RETURNING (EXTRACT(EPOCH FROM avatar_at))::bigint",
    )
    .bind(&name)
    .bind(body.as_ref())
    .fetch_one(&s.db)
    .await?;
    log::info!("{name}: new picture, {} bytes", body.len());
    Ok(Json(json!({ "name": name, "avatar": version })))
}

async fn delete_avatar(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    auth::may_act_as(&s.db, &name, me.as_deref()).await?;
    sqlx::query("UPDATE streamers SET avatar = NULL, avatar_at = NULL, updated_at = now() WHERE name = $1")
        .bind(&name)
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
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

/// What the picture in the card is: the stream itself while live and a thumbnail exists,
/// else the profile picture, else nothing. `summary_large_image` shows the thumbnail big.
enum Card {
    Thumbnail,
    Picture(i64),
    None,
}

fn head_tags(p: &Profile, live: bool, card: &Card, origin: &str) -> String {
    let title = format!("{} · {}", p.name, if live { "live" } else { "offline" });
    let about = if p.bio.is_empty() {
        if live { "live now" } else { "not live right now" }.to_owned()
    } else {
        one_line(&p.bio, 200)
    };
    let url = format!("{origin}/watch/{}", p.name);
    let (image, kind) = match card {
        Card::Thumbnail => (Some(format!("{origin}/thumb/{}.jpg", p.name)), "summary_large_image"),
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
fn card_html(shell: &str, p: &Profile, live: bool) -> Option<String> {
    let start = shell.find(TEMPLATE_OPEN)? + TEMPLATE_OPEN.len();
    let end = start + shell[start..].find(TEMPLATE_CLOSE)?;
    let avatar = p
        .avatar
        .map(|v| format!(r#"<img src="/api/streamers/{}/avatar?v={v}" alt="" class="{AVATAR_IMG_CLASS}">"#, p.name))
        .unwrap_or_default();
    Some(
        shell[start..end]
            .replace("{{avatar}}", &avatar)
            .replace("{{name}}", &escape(&p.name))
            .replace("{{verified}}", if p.verified { VERIFIED_HTML } else { "" })
            .replace("{{status}}", if live { "live" } else { "offline" })
            .replace("{{tone}}", if live { "text-increase" } else { "text-textSecondary" })
            .replace("{{bio}}", &escape(&p.bio)),
    )
}

/// index.html with its head replaced for this name and the card inside `#root`.
fn render(shell: &str, p: &Profile, live: bool, card: &Card, origin: &str) -> String {
    let mut html = shell.to_owned();
    // one title: ours, not the "streams" of every other page
    if let (Some(a), Some(b)) = (html.find("<title>"), html.find("</title>")) {
        if a < b {
            html.replace_range(a..b + "</title>".len(), "");
        }
    }
    // after everything else in the head, so <meta charset> stays in the first bytes
    if let Some(at) = html.find("</head>") {
        html.insert_str(at, &head_tags(p, live, card, origin));
    }
    if let Some(filled) = card_html(shell, p, live) {
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
        profile.avatar.map_or(Card::None, Card::Picture)
    };
    page(StatusCode::OK, render(&shell, &profile, live, &card, &origin(&headers)))
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
    <template id="watch-shell"><h1>{{avatar}}{{name}}{{verified}}</h1><p class="{{tone}}">{{status}}</p><p>{{bio}}</p></template>
    <div id="root"></div>
  </body>
</html>
"#;

    fn profile(bio: &str, avatar: Option<i64>, verified: bool) -> Profile {
        Profile { name: "bob".into(), bio: bio.into(), avatar, verified }
    }

    #[test]
    fn live_with_thumbnail() {
        let html = render(SHELL, &profile("hi <all>", None, true), true, &Card::Thumbnail, "https://1.2.3.4");
        assert_eq!(html.matches("<title>").count(), 1);
        assert!(html.contains("<title>bob · live</title>"));
        assert!(html.contains(r#"og:image" content="https://1.2.3.4/thumb/bob.jpg""#));
        assert!(html.contains(r#"twitter:card" content="summary_large_image""#));
        assert!(html.contains(r#"og:description" content="hi &lt;all&gt;""#));
        assert!(html.contains(r#"<div id="root"><h1>bob<span class="ml-2 text-increase""#));
        assert!(html.contains(r#"<p class="text-increase">live</p>"#));
        assert!(html.contains("<p>hi &lt;all&gt;</p>"));
        // the head came after the charset, before </head>, and the script is still there
        assert!(html.find("<meta charset").unwrap() < html.find("og:title").unwrap());
        assert!(html.find("og:title").unwrap() < html.find("</head>").unwrap());
        assert!(html.contains("/assets/index-abc.js"));
    }

    #[test]
    fn offline_with_picture() {
        let html = render(SHELL, &profile("", Some(1700000000), false), false, &Card::Picture(1700000000), "https://x");
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
    fn offline_without_anything() {
        let html = render(SHELL, &profile("", None, false), false, &Card::None, "https://x");
        assert!(!html.contains("og:image"));
        assert!(html.contains(r#"<div id="root"><h1>bob</h1>"#));
    }

    #[test]
    fn no_template_still_gets_a_head() {
        let shell = SHELL.replace(r#"<template id="watch-shell">"#, "<template>");
        let html = render(&shell, &profile("", None, false), true, &Card::None, "https://x");
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
