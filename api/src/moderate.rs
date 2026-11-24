use std::sync::OnceLock;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{ApiError, AppState};

const ENDPOINT: &str = "https://api.openai.com/v1/moderations";
const MODEL: &str = "omni-moderation-latest";
const TIMEOUT: Duration = Duration::from_secs(5);
const RATE_PER_WINDOW: i64 = 40;
const RATE_WINDOW_SECS: i64 = 600;
const MAX_ASK_BYTES: usize = 20 * 1024 * 1024;

pub(crate) const REJECTED: &str = "image rejected by moderation";
pub(crate) const IMAGE_CHECKS_DOWN: &str = "image checks are down, try again later";
pub(crate) const SLOW_DOWN: &str = "too many uploads, slow down";
pub(crate) const UNCHECKED: &str = "this picture was never checked, send it again";
pub(crate) const ANIMATED: &str = "animated images aren't allowed";
pub(crate) const TOO_BIG_TO_CHECK: &str = "picture too big to check. 20 mb at most";
pub(crate) const ABOUT_VIDEO_OFF: &str = "videos can't be added to the about page while image checks are on";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UploadKind {
    Avatar,
    Offline,
    Thumb,
    Asset,
    AboutFile,
    GroupIcon,
    GroupBanner,
    Emote,
    ModelThumb,
    ChatImage,
    VideoPoster,
}

impl UploadKind {
    pub(crate) fn word(self) -> &'static str {
        match self {
            UploadKind::Avatar => "avatar",
            UploadKind::Offline => "offline",
            UploadKind::Thumb => "thumb",
            UploadKind::Asset => "asset",
            UploadKind::AboutFile => "about_file",
            UploadKind::GroupIcon => "group_icon",
            UploadKind::GroupBanner => "group_banner",
            UploadKind::Emote => "emote",
            UploadKind::ModelThumb => "model_thumb",
            UploadKind::ChatImage => "chat_image",
            UploadKind::VideoPoster => "video_poster",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    pub(crate) block_sexual: bool,
    pub(crate) block_graphic: bool,
}

const PUBLIC: Policy = Policy { block_sexual: true, block_graphic: true };
const CHAT: Policy = Policy { block_sexual: false, block_graphic: false };

pub(crate) const fn policy(kind: UploadKind) -> Policy {
    match kind {
        UploadKind::Avatar
        | UploadKind::Offline
        | UploadKind::Thumb
        | UploadKind::Asset
        | UploadKind::AboutFile
        | UploadKind::GroupIcon
        | UploadKind::GroupBanner
        | UploadKind::Emote
        | UploadKind::ModelThumb => PUBLIC,
        UploadKind::ChatImage | UploadKind::VideoPoster => CHAT,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlaceKind {
    Stream,
    Group { adult: bool },
    Dm,
}

pub(crate) const fn place_policy(place: PlaceKind) -> Policy {
    match place {
        PlaceKind::Stream => PUBLIC,
        PlaceKind::Group { adult } => Policy { block_sexual: !adult, block_graphic: false },
        PlaceKind::Dm => CHAT,
    }
}

pub(crate) fn refusal_at(place: PlaceKind, nsfw: bool, graphic: bool, unchecked: bool) -> Option<&'static str> {
    let policy = place_policy(place);
    if unchecked && policy.block_sexual {
        return Some(UNCHECKED);
    }
    let refused = (nsfw && policy.block_sexual) || (graphic && policy.block_graphic);
    refused.then_some(REJECTED)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Flags {
    pub(crate) sexual: bool,
    pub(crate) graphic: bool,
    pub(crate) violence: bool,
    pub(crate) self_harm: bool,
    pub(crate) categories: Value,
    pub(crate) scores: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Down {
    NoKey,
    NoClient,
    TooBig(usize),
    Unreachable(String),
    Status(u16),
    Malformed(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Decision {
    Accept { nsfw: bool, graphic: bool, logged: Vec<&'static str> },
    Reject { because: Vec<&'static str> },
    Unavailable,
}

pub(crate) fn read_answer(status: u16, body: &str) -> Result<Flags, Down> {
    if !(200..300).contains(&status) {
        return Err(Down::Status(status));
    }
    let v: Value = serde_json::from_str(body).map_err(|_| Down::Malformed("not json"))?;
    let first = v.get("results").and_then(|r| r.get(0)).ok_or(Down::Malformed("no results"))?;
    let categories = first.get("categories").filter(|c| c.is_object()).ok_or(Down::Malformed("no categories"))?;
    let flag = |name: &str| categories.get(name).and_then(Value::as_bool);
    let sexual = flag("sexual").ok_or(Down::Malformed("no sexual"))?;
    let on = |name: &str| flag(name).unwrap_or(false);
    let self_harm = categories.as_object().is_some_and(|m| m.iter().any(|(k, v)| k.starts_with("self-harm") && v.as_bool() == Some(true)));
    Ok(Flags {
        sexual,
        graphic: on("violence/graphic"),
        violence: on("violence"),
        self_harm,
        categories: categories.clone(),
        scores: first.get("category_scores").cloned().unwrap_or(Value::Null),
    })
}

pub(crate) fn decide(policy: Policy, answer: &Result<Flags, Down>) -> Decision {
    let Ok(f) = answer else { return Decision::Unavailable };
    let mut because = Vec::new();
    if f.sexual && policy.block_sexual {
        because.push("sexual");
    }
    if f.graphic && policy.block_graphic {
        because.push("violence/graphic");
    }
    if !because.is_empty() {
        return Decision::Reject { because };
    }
    let mut logged = Vec::new();
    if f.sexual {
        logged.push("sexual");
    }
    if f.violence {
        logged.push("violence");
    }
    if f.graphic {
        logged.push("violence/graphic");
    }
    if f.self_harm {
        logged.push("self-harm");
    }
    Decision::Accept { nsfw: f.sexual, graphic: f.graphic, logged }
}

pub(crate) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        let on = std::env::var("MODERATION_ENABLED").is_ok_and(|v| flag_on(&v));
        if on {
            log::info!("image moderation on ({MODEL})");
        }
        on
    })
}

fn flag_on(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}

pub(crate) fn warn_if_keyless() {
    if enabled() && std::env::var("OPENAI_API_KEY").map_or(true, |k| k.trim().is_empty()) {
        log::warn!("MODERATION_ENABLED is on but OPENAI_API_KEY is not set: every picture upload will be refused with 503");
    }
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| match reqwest::Client::builder().timeout(TIMEOUT).build() {
            Ok(c) => Some(c),
            Err(e) => {
                log::error!("moderation http client: {e}");
                None
            }
        })
        .as_ref()
}

pub(crate) async fn ask(mime: &str, bytes: &[u8]) -> Result<Flags, Down> {
    if bytes.len() > MAX_ASK_BYTES {
        return Err(Down::TooBig(bytes.len()));
    }
    let key = std::env::var("OPENAI_API_KEY").ok().filter(|k| !k.trim().is_empty()).ok_or(Down::NoKey)?;
    let client = client().ok_or(Down::NoClient)?;
    let body = json!({
        "model": MODEL,
        "input": [{ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{}", base64(bytes)) } }],
    });
    let res = client.post(ENDPOINT).bearer_auth(key.trim()).json(&body).send().await.map_err(|e| Down::Unreachable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| Down::Unreachable(e.without_url().to_string()))?;
    read_answer(status, &text)
}

pub(crate) struct Upload<'a> {
    pub(crate) kind: UploadKind,
    pub(crate) who: Option<Uuid>,
    pub(crate) ip: Option<&'a str>,
    pub(crate) mime: &'a str,
    pub(crate) key: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Passed {
    pub(crate) nsfw: bool,
    pub(crate) graphic: bool,
    pub(crate) checked: bool,
    pub(crate) row: Option<Uuid>,
}

pub(crate) fn refuse_animated(bytes: &[u8]) -> Result<(), ApiError> {
    if enabled() && is_animated(bytes) {
        return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, ANIMATED));
    }
    Ok(())
}

pub(crate) fn refuse_about_video() -> Result<(), ApiError> {
    if enabled() {
        return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, ABOUT_VIDEO_OFF));
    }
    Ok(())
}

pub(crate) async fn check(s: &AppState, up: Upload<'_>, bytes: &[u8]) -> Result<Passed, ApiError> {
    if !enabled() {
        return Ok(Passed::default());
    }
    if bytes.len() > MAX_ASK_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, TOO_BIG_TO_CHECK));
    }
    let subject = match (up.who, up.ip) {
        (Some(id), _) => format!("acct:{id}"),
        (None, Some(ip)) => format!("ip:{ip}"),
        (None, None) => "anon".to_owned(),
    };
    crate::auth::limit(s, &format!("rl:moderate:{subject}"), RATE_WINDOW_SECS, RATE_PER_WINDOW, SLOW_DOWN).await?;
    let sha = crate::media::sha256_hex(bytes);
    let answer = ask(up.mime, bytes).await;
    let decision = decide(policy(up.kind), &answer);
    let ip = up.ip.unwrap_or("?");
    let kind = up.kind.word();
    let flags = match &answer {
        Ok(f) => f,
        Err(why) => {
            log::warn!("moderation down for {kind} {sha} from {ip}: {}", down_words(why));
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, IMAGE_CHECKS_DOWN));
        }
    };
    match decision {
        Decision::Unavailable => Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, IMAGE_CHECKS_DOWN)),
        Decision::Reject { because } => {
            log::warn!("moderation rejected {kind} {sha} from {ip} ({}): {}", because.join(", "), flags.categories);
            record(&s.db, &up, &sha, bytes.len(), flags, "rejected").await;
            Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, REJECTED))
        }
        Decision::Accept { nsfw, graphic, logged } => {
            if !logged.is_empty() {
                log::warn!("moderation kept {kind} {sha} from {ip}, flagged {}: {}", logged.join(", "), flags.categories);
            }
            let row = record(&s.db, &up, &sha, bytes.len(), flags, "accepted").await;
            Ok(Passed { nsfw, graphic, checked: true, row })
        }
    }
}

pub(crate) async fn check_offline(kind: UploadKind, mime: &str, bytes: &[u8]) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let sha = crate::media::sha256_hex(bytes);
    let answer = ask(mime, bytes).await;
    match (decide(policy(kind), &answer), answer) {
        (Decision::Accept { .. }, _) => Ok(()),
        (Decision::Reject { because }, _) => Err(format!("{} {sha}: {REJECTED} ({})", kind.word(), because.join(", "))),
        (Decision::Unavailable, Err(why)) => Err(format!("{} {sha}: {IMAGE_CHECKS_DOWN} ({})", kind.word(), down_words(&why))),
        (Decision::Unavailable, Ok(_)) => Err(format!("{} {sha}: {IMAGE_CHECKS_DOWN}", kind.word())),
    }
}

fn down_words(why: &Down) -> String {
    match why {
        Down::NoKey => "OPENAI_API_KEY is not set".to_owned(),
        Down::NoClient => "no http client".to_owned(),
        Down::TooBig(len) => format!("{len} bytes, over {MAX_ASK_BYTES}"),
        Down::Unreachable(e) => format!("unreachable: {e}"),
        Down::Status(code) => format!("status {code}"),
        Down::Malformed(what) => format!("malformed answer: {what}"),
    }
}

async fn record(db: &PgPool, up: &Upload<'_>, sha: &str, len: usize, flags: &Flags, status: &str) -> Option<Uuid> {
    let key = if status == "accepted" { up.key } else { None };
    match sqlx::query_scalar(
        "INSERT INTO uploads (key, kind, uploader_id, uploader_name, uploader_ip, sha256, bytes, mime, nsfw, graphic, categories, scores, status)
         VALUES ($1, $2, $3, (SELECT name FROM streamers WHERE id = $3), $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id",
    )
    .bind(key)
    .bind(up.kind.word())
    .bind(up.who)
    .bind(up.ip)
    .bind(sha)
    .bind(len as i32)
    .bind(up.mime)
    .bind(flags.sexual)
    .bind(flags.graphic)
    .bind(&flags.categories)
    .bind(&flags.scores)
    .bind(status)
    .fetch_one(db)
    .await
    {
        Ok(id) => Some(id),
        Err(e) => {
            log::warn!("uploads row for {} {sha}: {e}", up.kind.word());
            None
        }
    }
}

pub(crate) async fn set_key(db: &PgPool, row: Option<Uuid>, key: &str) {
    let Some(row) = row else { return };
    if let Err(e) = sqlx::query("UPDATE uploads SET key = $2 WHERE id = $1").bind(row).bind(key).execute(db).await {
        log::warn!("uploads row {row} key: {e}");
    }
}

pub(crate) async fn group_place(db: &PgPool, server: &str) -> Result<PlaceKind, sqlx::Error> {
    let adult: Option<bool> = sqlx::query_scalar("SELECT adult_content FROM groups WHERE name = $1").bind(server).fetch_optional(db).await?;
    Ok(PlaceKind::Group { adult: adult.unwrap_or(false) })
}

pub(crate) async fn may_post(db: &PgPool, ids: &[&str], place: PlaceKind) -> Result<Result<(), &'static str>, sqlx::Error> {
    let ids: Vec<Uuid> = ids.iter().filter_map(|id| Uuid::parse_str(id).ok()).collect();
    if ids.is_empty() {
        return Ok(Ok(()));
    }
    let (nsfw, graphic, unchecked): (Option<bool>, Option<bool>, Option<bool>) =
        sqlx::query_as("SELECT bool_or(nsfw), bool_or(graphic), bool_or(NOT moderated) FROM chat_images WHERE id = ANY($1)").bind(&ids).fetch_one(db).await?;
    let unchecked = enabled() && unchecked.unwrap_or(false);
    Ok(match refusal_at(place, nsfw.unwrap_or(false), graphic.unwrap_or(false), unchecked) {
        Some(why) => Err(why),
        None => Ok(()),
    })
}

pub(crate) fn is_animated(bytes: &[u8]) -> bool {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return gif_frames(bytes) > 1;
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return webp_animated(bytes);
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return png_animated(bytes);
    }
    false
}

fn color_table_len(packed: u8) -> usize {
    if packed & 0x80 == 0 {
        0
    } else {
        3 << ((packed & 0x07) + 1)
    }
}

fn skip_sub_blocks(b: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let n = *b.get(at)? as usize;
        at += 1;
        if n == 0 {
            return Some(at);
        }
        at += n;
    }
}

fn gif_frames(b: &[u8]) -> usize {
    let Some(&packed) = b.get(10) else { return 0 };
    let mut at = 13 + color_table_len(packed);
    let mut frames = 0;
    while let Some(&intro) = b.get(at) {
        match intro {
            0x21 => match skip_sub_blocks(b, at + 2) {
                Some(next) => at = next,
                None => break,
            },
            0x2C => {
                let Some(&packed) = b.get(at + 9) else { break };
                frames += 1;
                if frames > 1 {
                    break;
                }
                match skip_sub_blocks(b, at + 10 + color_table_len(packed) + 1) {
                    Some(next) => at = next,
                    None => break,
                }
            }
            _ => break,
        }
    }
    frames
}

fn webp_animated(b: &[u8]) -> bool {
    let mut at = 12;
    while at + 8 <= b.len() {
        let len = u32::from_le_bytes([b[at + 4], b[at + 5], b[at + 6], b[at + 7]]) as usize;
        match &b[at..at + 4] {
            b"VP8X" if b.get(at + 8).is_some_and(|flags| flags & 0x02 != 0) => return true,
            b"ANIM" | b"ANMF" => return true,
            _ => {}
        }
        at = at.saturating_add(8).saturating_add(len).saturating_add(len & 1);
    }
    false
}

fn png_animated(b: &[u8]) -> bool {
    let mut at = 8;
    while at + 8 <= b.len() {
        let len = u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize;
        match &b[at + 4..at + 8] {
            b"acTL" => return true,
            b"IDAT" => return false,
            _ => {}
        }
        at = at.saturating_add(12).saturating_add(len);
    }
    false
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ABC[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ABC[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(categories: Value) -> String {
        json!({ "id": "modr-1", "model": MODEL, "results": [{ "flagged": true, "categories": categories, "category_scores": { "sexual": 0.5 } }] }).to_string()
    }

    fn clean() -> Value {
        json!({ "sexual": false, "sexual/minors": false, "violence": false, "violence/graphic": false, "self-harm": false, "self-harm/intent": false, "self-harm/instructions": false })
    }

    fn with(name: &str) -> Value {
        let mut c = clean();
        c[name] = Value::Bool(true);
        c
    }

    fn decided(kind: UploadKind, categories: Value) -> Decision {
        decide(policy(kind), &read_answer(200, &answer(categories)))
    }

    #[test]
    fn sexual_is_rejected_on_a_public_kind() {
        assert_eq!(decided(UploadKind::Avatar, with("sexual")), Decision::Reject { because: vec!["sexual"] });
    }

    #[test]
    fn clean_is_accepted() {
        assert_eq!(decided(UploadKind::Avatar, clean()), Decision::Accept { nsfw: false, graphic: false, logged: vec![] });
    }

    #[test]
    fn violence_alone_is_accepted_and_logged() {
        assert_eq!(decided(UploadKind::Emote, with("violence")), Decision::Accept { nsfw: false, graphic: false, logged: vec!["violence"] });
        assert_eq!(decided(UploadKind::Thumb, with("self-harm/intent")), Decision::Accept { nsfw: false, graphic: false, logged: vec!["self-harm"] });
    }

    #[test]
    fn graphic_violence_is_rejected_on_public_kinds_and_logged_on_chat() {
        assert_eq!(decided(UploadKind::GroupBanner, with("violence/graphic")), Decision::Reject { because: vec!["violence/graphic"] });
        assert_eq!(decided(UploadKind::ChatImage, with("violence/graphic")), Decision::Accept { nsfw: false, graphic: true, logged: vec!["violence/graphic"] });
    }

    #[test]
    fn errors_and_garbage_are_unavailable() {
        for status in [429, 500, 502, 503, 401, 400, 302] {
            assert_eq!(read_answer(status, &answer(clean())), Err(Down::Status(status)), "{status}");
            assert_eq!(decide(PUBLIC, &read_answer(status, &answer(clean()))), Decision::Unavailable);
        }
        assert_eq!(read_answer(200, "{ nope"), Err(Down::Malformed("not json")));
        assert_eq!(read_answer(200, r#"{"results":[]}"#), Err(Down::Malformed("no results")));
        assert_eq!(read_answer(200, r#"{"results":[{"categories":{"violence":true}}]}"#), Err(Down::Malformed("no sexual")));
        assert_eq!(read_answer(200, r#"{"results":[{"categories":{"sexual":"yes"}}]}"#), Err(Down::Malformed("no sexual")));
        assert_eq!(decide(PUBLIC, &Err(Down::NoKey)), Decision::Unavailable);
        assert_eq!(decide(CHAT, &Err(Down::Unreachable("timed out".into()))), Decision::Unavailable);
    }

    #[test]
    fn scores_are_kept_as_sent() {
        let f = read_answer(200, &answer(with("sexual"))).unwrap();
        assert_eq!(f.scores, json!({ "sexual": 0.5 }));
        assert!(f.sexual);
    }

    #[test]
    fn disabled_unless_said_so() {
        for v in ["true", "1", " ON ", "yes"] {
            assert!(flag_on(v), "{v}");
        }
        for v in ["", "false", "0", "off", "nope"] {
            assert!(!flag_on(v), "{v}");
        }
    }

    #[test]
    fn every_public_kind_blocks_both() {
        use UploadKind::*;
        for kind in [Avatar, Offline, Thumb, Asset, AboutFile, GroupIcon, GroupBanner, Emote, ModelThumb] {
            assert_eq!(policy(kind), Policy { block_sexual: true, block_graphic: true }, "{kind:?}");
        }
    }

    #[test]
    fn chat_uploads_keep_sexual_with_nsfw_until_the_place_decides() {
        for kind in [UploadKind::ChatImage, UploadKind::VideoPoster] {
            assert_eq!(decided(kind, with("sexual")), Decision::Accept { nsfw: true, graphic: false, logged: vec!["sexual"] }, "{kind:?}");
        }
    }

    fn decided_at(place: PlaceKind, categories: Value) -> Decision {
        decide(place_policy(place), &read_answer(200, &answer(categories)))
    }

    #[test]
    fn a_group_without_adult_content_blocks_sexual_like_a_public_kind() {
        let group = PlaceKind::Group { adult: false };
        assert_eq!(decided_at(group, with("sexual")), Decision::Reject { because: vec!["sexual"] });
        assert_eq!(refusal_at(group, true, false, false), Some(REJECTED));
        assert_eq!(refusal_at(group, false, false, true), Some(UNCHECKED));
        assert_eq!(refusal_at(group, false, false, false), None);
    }

    #[test]
    fn a_group_with_adult_content_takes_sexual_marked_nsfw() {
        let group = PlaceKind::Group { adult: true };
        assert_eq!(decided_at(group, with("sexual")), Decision::Accept { nsfw: true, graphic: false, logged: vec!["sexual"] });
        assert_eq!(refusal_at(group, true, false, false), None);
        assert_eq!(refusal_at(group, false, false, true), None);
    }

    #[test]
    fn a_dm_takes_sexual_marked_nsfw() {
        assert_eq!(decided_at(PlaceKind::Dm, with("sexual")), Decision::Accept { nsfw: true, graphic: false, logged: vec!["sexual"] });
        assert_eq!(refusal_at(PlaceKind::Dm, true, true, false), None);
        assert_eq!(refusal_at(PlaceKind::Dm, false, false, true), None);
    }

    #[test]
    fn graphic_is_only_logged_in_groups_and_dms() {
        for place in [PlaceKind::Dm, PlaceKind::Group { adult: false }, PlaceKind::Group { adult: true }] {
            assert_eq!(refusal_at(place, false, true, false), None, "{place:?}");
            assert_eq!(decided_at(place, with("violence/graphic")), Decision::Accept { nsfw: false, graphic: true, logged: vec!["violence/graphic"] }, "{place:?}");
        }
    }

    #[test]
    fn a_stream_takes_neither_flag_nor_an_unchecked_picture() {
        assert_eq!(place_policy(PlaceKind::Stream), PUBLIC);
        assert_eq!(refusal_at(PlaceKind::Stream, true, false, false), Some(REJECTED));
        assert_eq!(refusal_at(PlaceKind::Stream, false, true, false), Some(REJECTED));
        assert_eq!(refusal_at(PlaceKind::Stream, false, false, true), Some(UNCHECKED));
        assert_eq!(refusal_at(PlaceKind::Stream, false, false, false), None);
    }

    fn gif(frames: &[&[u8]], global_table: bool) -> Vec<u8> {
        let mut b = b"GIF89a".to_vec();
        b.extend_from_slice(&[1, 0, 1, 0, if global_table { 0x80 } else { 0 }, 0, 0]);
        if global_table {
            b.extend_from_slice(&[0x2C; 6]);
        }
        b.extend_from_slice(&[0x21, 0xFF, 11]);
        b.extend_from_slice(b"NETSCAPE2.0");
        b.extend_from_slice(&[3, 1, 0, 0, 0]);
        for data in frames {
            b.extend_from_slice(&[0x21, 0xF9, 4, 0, 10, 0, 0, 0]);
            b.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2]);
            b.push(data.len() as u8);
            b.extend_from_slice(data);
            b.push(0);
        }
        b.push(0x3B);
        b
    }

    fn riff(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        for (id, data) in chunks {
            body.extend_from_slice(*id);
            body.extend_from_slice(&(data.len() as u32).to_le_bytes());
            body.extend_from_slice(data);
            if data.len() % 2 == 1 {
                body.push(0);
            }
        }
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&(body.len() as u32).to_le_bytes());
        b.extend_from_slice(&body);
        b
    }

    fn png(chunks: &[&[u8; 4]]) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        for id in chunks {
            let data: &[u8] = if *id == b"IHDR" { &[0; 13] } else if *id == b"acTL" { &[0, 0, 0, 2, 0, 0, 0, 0] } else { &[1, 2, 3] };
            b.extend_from_slice(&(data.len() as u32).to_be_bytes());
            b.extend_from_slice(*id);
            b.extend_from_slice(data);
            b.extend_from_slice(&[0; 4]);
        }
        b
    }

    #[test]
    fn gif_frames_are_counted_by_block() {
        assert!(!is_animated(&gif(&[&[0x4C, 0x01]], false)));
        assert!(!is_animated(&gif(&[&[0x2C, 0x2C, 0x2C]], true)), "0x2c inside a frame's data or a color table is not a frame");
        assert!(is_animated(&gif(&[&[0x4C, 0x01], &[0x4C, 0x01]], false)));
        assert!(is_animated(&gif(&[&[0x4C], &[0x4C], &[0x4C]], true)));
        let mut cut = gif(&[&[0x4C, 0x01]], false);
        cut.pop();
        assert!(!is_animated(&cut));
    }

    #[test]
    fn webp_animation_is_the_vp8x_flag_or_an_anim_chunk() {
        assert!(!is_animated(&riff(&[(b"VP8 ", &[0; 11])])));
        assert!(!is_animated(&riff(&[(b"VP8X", &[0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]), (b"VP8L", &[0; 5])])));
        assert!(is_animated(&riff(&[(b"VP8X", &[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])])));
        assert!(is_animated(&riff(&[(b"VP8X", &[0; 10]), (b"ANIM", &[0; 6])])));
        assert!(is_animated(&riff(&[(b"VP8X", &[0; 10]), (b"ICCP", &[0; 3]), (b"ANMF", &[0; 16])])));
    }

    #[test]
    fn png_is_animated_only_with_actl_before_idat() {
        assert!(!is_animated(&png(&[b"IHDR", b"IDAT", b"IEND"])));
        assert!(is_animated(&png(&[b"IHDR", b"acTL", b"IDAT", b"IEND"])));
        assert!(!is_animated(&png(&[b"IHDR", b"IDAT", b"acTL", b"IEND"])));
    }

    #[test]
    fn other_bytes_are_not_animated() {
        assert!(!is_animated(&[]));
        assert!(!is_animated(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]));
        assert!(!is_animated(b"GIF89a"));
        assert!(!is_animated(b"RIFF\0\0\0\0WEBP"));
        assert!(!is_animated(b"not a picture at all"));
    }

    #[test]
    fn base64_is_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }
}
