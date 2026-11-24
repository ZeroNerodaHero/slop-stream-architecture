//! The one look every uploaded picture gets before it is kept (docs/image-moderation.md).
//!
//! The exact bytes the bucket will keep (after any redraw: an emote's webp, a video's poster) go
//! to OpenAI's moderation endpoint (`omni-moderation-latest`) as a data url, and only its
//! `categories` booleans are acted on: no score thresholds of ours. Each kind of upload has a row
//! in `policy`: what refuses it. `sexual` refuses every public kind, and so does
//! `violence/graphic`; a direct message's or a group channel's picture is kept either way, with
//! `nsfw` on its row (the page blurs it until clicked). `violence`, `violence/graphic` where not
//! refused, and any `self-harm*` are logged, never refused.
//!
//! A chat picture is uploaded before anyone knows where it goes, so its verdict is kept on its
//! row (`chat_images.nsfw`, `chat_images.graphic`) and the say checks it (`may_post`): a stream's
//! chat refuses either, a direct message and a group channel refuse `nsfw` only while
//! `DM_GROUP_IMAGE_BLOCK_SEXUAL` says so.
//!
//! Off unless `MODERATION_ENABLED` is true: then nothing is asked and nothing is written. On, it
//! fails closed: no key, a timeout, a 429, any other non-2xx, or an answer it cannot read refuses
//! the upload with 503 `IMAGE_CHECKS_DOWN`. A refusal is 422 `REJECTED` and nothing is kept.
//! Before each ask, a count per uploader (`RATE_PER_WINDOW`), 429 past it.
//!
//! Every picture looked at gets an `uploads` row (migration 0015): kind, uploader, address,
//! sha256, size, the scores as sent, accepted or rejected. Best effort: a failed insert is
//! logged, and a refusal stays a refusal. Logs carry the sha256, the address and the categories,
//! never the bytes, never the key.

use std::sync::OnceLock;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{ApiError, AppState};

const ENDPOINT: &str = "https://api.openai.com/v1/moderations";
const MODEL: &str = "omni-moderation-latest";
/// The whole ask, connect to last byte. Past it the upload is refused as `IMAGE_CHECKS_DOWN`.
const TIMEOUT: Duration = Duration::from_secs(5);
/// Pictures looked at per uploader per ten minutes, in front of the ask: every upload kind
/// together. Above the chat pictures' own 30, so a person sending pictures never meets it; a
/// script spending our moderation quota does.
const RATE_PER_WINDOW: i64 = 40;
const RATE_WINDOW_SECS: i64 = 600;

/// A direct message's or a group channel's picture flagged `sexual`: refused (`true`), or kept
/// with `nsfw` and blurred by the page until clicked (`false`, Billy's call). One line to flip.
pub(crate) const DM_GROUP_IMAGE_BLOCK_SEXUAL: bool = false;

pub(crate) const REJECTED: &str = "image rejected by moderation";
pub(crate) const IMAGE_CHECKS_DOWN: &str = "image checks are down, try again later";
pub(crate) const SLOW_DOWN: &str = "too many uploads, slow down";

/// What a picture is for. Named in `uploads.kind` (`word`).
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
    /// `POST /api/chat-images`: a stream's, a group channel's or a direct message's, not known yet.
    ChatImage,
    /// The frame the api drew from a chat video (chat_videos.rs). The video itself is never looked at.
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

/// What refuses a kind at upload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    pub(crate) block_sexual: bool,
    pub(crate) block_graphic: bool,
}

const PUBLIC: Policy = Policy { block_sexual: true, block_graphic: true };
/// A chat picture (or poster) may yet go to a direct message or a group channel, so the upload
/// refuses only what those refuse; a stream's chat refuses the rest when a line names it (`may_post`).
const CHAT: Policy = Policy { block_sexual: DM_GROUP_IMAGE_BLOCK_SEXUAL, block_graphic: false };

/// The table: every kind seen by anyone who opens a page is `PUBLIC`.
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

/// Where a line with pictures goes, for `refusal_at`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlaceKind {
    Stream,
    Group,
    Dm,
}

/// A line's pictures, `nsfw` and `graphic` for any of them, refused at `place`: the stream's chat
/// is public, so it takes neither; a direct message and a group channel take both unless
/// `block_private_sexual`.
pub(crate) fn refusal_at(place: PlaceKind, nsfw: bool, graphic: bool, block_private_sexual: bool) -> Option<&'static str> {
    let refused = match place {
        PlaceKind::Stream => nsfw || graphic,
        PlaceKind::Group | PlaceKind::Dm => nsfw && block_private_sexual,
    };
    refused.then_some(REJECTED)
}

/// The booleans read off one answer, and the scores kept as they came.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Flags {
    pub(crate) sexual: bool,
    pub(crate) graphic: bool,
    pub(crate) violence: bool,
    pub(crate) self_harm: bool,
    pub(crate) categories: Value,
    pub(crate) scores: Value,
}

/// Why there is no answer to act on. Each refuses the upload as `IMAGE_CHECKS_DOWN`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Down {
    NoKey,
    /// Timed out, refused, dns: reqwest's words.
    Unreachable(String),
    /// A non-2xx, 429 and 5xx included.
    Status(u16),
    /// A 2xx that is not the shape we know.
    Malformed(&'static str),
}

/// What happens to the upload.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Decision {
    /// Kept. `nsfw` (`sexual`) and `graphic` (`violence/graphic`) go on a chat picture's row;
    /// `logged` names the categories worth a warning.
    Accept { nsfw: bool, graphic: bool, logged: Vec<&'static str> },
    /// Refused by policy: 422, never stored.
    Reject { because: Vec<&'static str> },
    /// No answer: 503.
    Unavailable,
}

/// OpenAI's reply, by status and body, read into `Flags`. Only `results[0].categories` is
/// trusted; a category it leaves out reads as false, but `sexual` must be there.
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

/// The policy applied to an answer, or to its absence.
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

/// `MODERATION_ENABLED` is `true`, `1`, `yes` or `on`. Read once; anything else, unset included, is off.
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

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(TIMEOUT).build().unwrap_or_default())
}

/// Ask OpenAI about one picture. Never logs the key or the bytes.
pub(crate) async fn ask(mime: &str, bytes: &[u8]) -> Result<Flags, Down> {
    let key = std::env::var("OPENAI_API_KEY").ok().filter(|k| !k.trim().is_empty()).ok_or(Down::NoKey)?;
    let body = json!({
        "model": MODEL,
        "input": [{ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{}", base64(bytes)) } }],
    });
    let res = client().post(ENDPOINT).bearer_auth(key.trim()).json(&body).send().await.map_err(|e| Down::Unreachable(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| Down::Unreachable(e.without_url().to_string()))?;
    read_answer(status, &text)
}

/// One upload as `check` sees it.
pub(crate) struct Upload<'a> {
    pub(crate) kind: UploadKind,
    /// The account behind it (the name's own row for a dummy-password write).
    pub(crate) who: Option<Uuid>,
    pub(crate) ip: Option<&'a str>,
    pub(crate) mime: &'a str,
    /// The bucket key, when it is known before the put; `set_key` fills it in after otherwise.
    pub(crate) key: Option<&'a str>,
}

/// Checked and kept: the flags for a chat picture's row, and the `uploads` row to put the key on.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Passed {
    pub(crate) nsfw: bool,
    pub(crate) graphic: bool,
    pub(crate) row: Option<Uuid>,
}

/// The look: off, `Passed::default()`; on, the count, the ask, the policy, the log and the row.
/// `Err` is the answer to send: 429 `SLOW_DOWN`, 422 `REJECTED`, 503 `IMAGE_CHECKS_DOWN`.
pub(crate) async fn check(s: &AppState, up: Upload<'_>, bytes: &[u8]) -> Result<Passed, ApiError> {
    if !enabled() {
        return Ok(Passed::default());
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
    let scores = answer.as_ref().ok().map(|f| f.scores.clone());
    match &decision {
        Decision::Unavailable => {
            if let Err(why) = &answer {
                log::warn!("moderation down for {kind} {sha} from {ip}: {}", down_words(why));
            }
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, IMAGE_CHECKS_DOWN));
        }
        Decision::Reject { because } => {
            let categories = answer.as_ref().map(|f| f.categories.to_string()).unwrap_or_default();
            log::warn!("moderation rejected {kind} {sha} from {ip} ({}): {categories}", because.join(", "));
            record(&s.db, &up, &sha, bytes.len(), false, scores, "rejected").await;
            return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, REJECTED));
        }
        Decision::Accept { logged, .. } if !logged.is_empty() => {
            let categories = answer.as_ref().map(|f| f.categories.to_string()).unwrap_or_default();
            log::warn!("moderation kept {kind} {sha} from {ip}, flagged {}: {categories}", logged.join(", "));
        }
        Decision::Accept { .. } => {}
    }
    let Decision::Accept { nsfw, graphic, .. } = decision else { unreachable!() };
    let row = record(&s.db, &up, &sha, bytes.len(), nsfw, scores, "accepted").await;
    Ok(Passed { nsfw, graphic, row })
}

/// The look for a command run by hand with no postgres or redis (`api models`): no count, no
/// row, the same ask and the same policy. `Err` is the words to stop the run with.
pub(crate) async fn check_offline(kind: UploadKind, mime: &str, bytes: &[u8]) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let sha = crate::media::sha256_hex(bytes);
    let answer = ask(mime, bytes).await;
    match decide(policy(kind), &answer) {
        Decision::Accept { .. } => Ok(()),
        Decision::Reject { because } => Err(format!("{} {sha}: {REJECTED} ({})", kind.word(), because.join(", "))),
        Decision::Unavailable => Err(format!("{} {sha}: {IMAGE_CHECKS_DOWN} ({})", kind.word(), answer.err().map(|d| down_words(&d)).unwrap_or_default())),
    }
}

fn down_words(why: &Down) -> String {
    match why {
        Down::NoKey => "OPENAI_API_KEY is not set".to_owned(),
        Down::Unreachable(e) => format!("unreachable: {e}"),
        Down::Status(code) => format!("status {code}"),
        Down::Malformed(what) => format!("malformed answer: {what}"),
    }
}

/// The `uploads` row, best effort.
async fn record(db: &PgPool, up: &Upload<'_>, sha: &str, len: usize, nsfw: bool, scores: Option<Value>, status: &str) -> Option<Uuid> {
    let key = if status == "accepted" { up.key } else { None };
    match sqlx::query_scalar(
        "INSERT INTO uploads (key, kind, uploader_id, uploader_ip, sha256, bytes, mime, nsfw, scores, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
    )
    .bind(key)
    .bind(up.kind.word())
    .bind(up.who)
    .bind(up.ip)
    .bind(sha)
    .bind(len as i32)
    .bind(up.mime)
    .bind(nsfw)
    .bind(scores)
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

/// The bucket key on a `check`'s row, for an upload whose key came after (a thumb's id, a chat
/// picture's). Best effort, like the row.
pub(crate) async fn set_key(db: &PgPool, row: Option<Uuid>, key: &str) {
    let Some(row) = row else { return };
    if let Err(e) = sqlx::query("UPDATE uploads SET key = $2 WHERE id = $1").bind(row).bind(key).execute(db).await {
        log::warn!("uploads row {row} key: {e}");
    }
}

/// A line's pictures (its video's poster among them) at `place`, as their rows' verdicts say:
/// `Err` with `REJECTED` when one may not go there.
pub(crate) async fn may_post(db: &PgPool, ids: &[&str], place: PlaceKind) -> Result<Result<(), &'static str>, sqlx::Error> {
    let ids: Vec<Uuid> = ids.iter().filter_map(|id| Uuid::parse_str(id).ok()).collect();
    if ids.is_empty() {
        return Ok(Ok(()));
    }
    let (nsfw, graphic): (Option<bool>, Option<bool>) =
        sqlx::query_as("SELECT bool_or(nsfw), bool_or(graphic) FROM chat_images WHERE id = ANY($1)").bind(&ids).fetch_one(db).await?;
    Ok(match refusal_at(place, nsfw.unwrap_or(false), graphic.unwrap_or(false), DM_GROUP_IMAGE_BLOCK_SEXUAL) {
        Some(why) => Err(why),
        None => Ok(()),
    })
}

/// Standard base64 with padding (RFC 4648 §4), for the data url.
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
    fn chat_uploads_keep_sexual_with_nsfw_while_dms_and_groups_allow_it() {
        assert!(!DM_GROUP_IMAGE_BLOCK_SEXUAL, "Billy's call: dm and group pictures are blurred, not refused");
        for kind in [UploadKind::ChatImage, UploadKind::VideoPoster] {
            assert_eq!(decided(kind, with("sexual")), Decision::Accept { nsfw: true, graphic: false, logged: vec!["sexual"] }, "{kind:?}");
        }
        // with the const flipped, the upload itself refuses: nowhere would take it
        let strict = Policy { block_sexual: true, block_graphic: false };
        assert_eq!(decide(strict, &read_answer(200, &answer(with("sexual")))), Decision::Reject { because: vec!["sexual"] });
    }

    #[test]
    fn a_stream_takes_neither_flag_and_private_places_take_both_unless_flipped() {
        assert_eq!(refusal_at(PlaceKind::Stream, true, false, false), Some(REJECTED));
        assert_eq!(refusal_at(PlaceKind::Stream, false, true, false), Some(REJECTED));
        assert_eq!(refusal_at(PlaceKind::Stream, false, false, false), None);
        for place in [PlaceKind::Dm, PlaceKind::Group] {
            assert_eq!(refusal_at(place, true, true, false), None, "{place:?}");
            assert_eq!(refusal_at(place, true, false, true), Some(REJECTED), "{place:?} with the const flipped");
            assert_eq!(refusal_at(place, false, true, true), None, "{place:?}: graphic is only logged");
        }
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
