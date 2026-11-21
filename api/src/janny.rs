//! Jannies: who may clean a stream's chat (docs/jannies.md).
//!
//! A site janny (added by an admin on /admin) may delete lines, ban and time out in every
//! stream's chat. A stream janny (added by the streamer on their own page's mod tab) may do the
//! same in that one stream's chat. Chat only: no janny touches a stream's pictures, its about
//! page, socials or calendar, nor dms or group channels (a group's owners have their own powers,
//! group_mod.rs).
//!
//! Who outranks whom, on one stream (`Rank`): an admin (ADMIN_NAMES) over the streamer over a
//! site janny over a stream janny over everybody else. One may act on someone only when one is a
//! janny there at least and outranks them (`may_act`): a janny never touches the streamer's lines
//! or the streamer, nor anyone of their own rank or above. The streamer is a janny of their own
//! stream with every power, the only one besides an admin who names its jannies.
//!
//! A stream is its `streamers` row, people are accounts: a rename keeps the jannies, the bans
//! and the log (0007-jannies.sql). Only a login can be banned or timed out; a nick's line can be
//! deleted. The chat (chat.rs `stream_refusal`) refuses a line or a reaction from someone banned
//! or timed out; a deleted line goes from redis and postgres, its copy into `mod_log`, and every
//! socket in the room hears a `delete` frame (through the room's reactions stream, chat.rs).

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{Account, Me};
use crate::{ApiError, ApiResult, AppState};

/// Stream jannies one stream may have.
const MAX_STREAM_JANNIES: i64 = 20;
/// Site jannies the site may have.
const MAX_SITE_JANNIES: i64 = 50;
/// Moderation actions one login may take a minute (delete, ban, timeout, and their undoing), on
/// top of the route's tier (ratelimit.rs `MODERATE`): a janny's hijacked login cannot wipe a chat.
const ACTIONS_PER_MINUTE: i64 = 30;
const MIN_TIMEOUT_SECS: i64 = 10;
const MAX_TIMEOUT_SECS: i64 = 7 * 86400;
/// The log's page, newest first.
const LOG_ROWS: i64 = 100;
const MAX_REASON_CHARS: usize = 200;

/// Someone's standing in one stream's chat, lowest first: the order is the outranking.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Rank {
    Nobody,
    StreamJanny,
    SiteJanny,
    /// The streamer: the account the stream's name is, or a line said with the go-live grant.
    Owner,
    Admin,
}

impl Rank {
    /// The highest of what someone is.
    pub(crate) fn of(admin: bool, owner: bool, site: bool, stream: bool) -> Rank {
        if admin {
            Rank::Admin
        } else if owner {
            Rank::Owner
        } else if site {
            Rank::SiteJanny
        } else if stream {
            Rank::StreamJanny
        } else {
            Rank::Nobody
        }
    }

    /// May clean this stream's chat at all.
    pub(crate) fn moderates(self) -> bool {
        self >= Rank::StreamJanny
    }

    fn word(self) -> &'static str {
        match self {
            Rank::Nobody => "nobody",
            Rank::StreamJanny => "stream janny",
            Rank::SiteJanny => "site janny",
            Rank::Owner => "streamer",
            Rank::Admin => "admin",
        }
    }
}

/// May `actor` delete a line of `target`'s, ban or time them out: a janny here at least, and
/// above them. Nobody acts on their own rank, so a stream janny never on another, a site janny
/// never on another, and nobody but an admin on the streamer.
pub(crate) fn may_act(actor: Rank, target: Rank) -> bool {
    actor.moderates() && actor > target
}

/// A stream by its name now: its row, and the account it is when the name is claimed.
pub(crate) struct Stream {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    /// The streamer's account: the row itself, when it has a password (or a linked login).
    pub(crate) owner: Option<Uuid>,
}

pub(crate) async fn stream(db: &PgPool, name: &str) -> Result<Option<Stream>, sqlx::Error> {
    let row: Option<(Uuid, bool)> = sqlx::query_as("SELECT id, password_hash IS NOT NULL FROM streamers WHERE name = $1").bind(name).fetch_optional(db).await?;
    Ok(row.map(|(id, claimed)| Stream { id, name: name.to_owned(), owner: claimed.then_some(id) }))
}

/// `user`'s rank on `stream`. `admins` are the ADMIN_NAMES accounts.
pub(crate) async fn rank_on(db: &PgPool, admins: &[Uuid], stream: &Stream, user: Uuid) -> Result<Rank, sqlx::Error> {
    if admins.contains(&user) {
        return Ok(Rank::Admin);
    }
    if stream.owner == Some(user) {
        return Ok(Rank::Owner);
    }
    let (site, mine): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM site_jannies WHERE user_id = $1),
                EXISTS (SELECT 1 FROM stream_jannies WHERE stream_id = $2 AND user_id = $1)",
    )
    .bind(user)
    .bind(stream.id)
    .fetch_one(db)
    .await?;
    Ok(Rank::of(false, false, site, mine))
}

/// For the watch grant's `can_moderate`: may this login clean `name`'s chat. A hint for the page
/// (which buttons to draw); every action asks again.
pub(crate) async fn can_moderate(s: &AppState, name: &str, me: Option<&Account>) -> Result<bool, sqlx::Error> {
    let Some(me) = me else { return Ok(false) };
    let Some(stream) = stream(&s.db, name).await? else { return Ok(s.admins.iter().any(|a| a.id == me.id)) };
    Ok(rank_on(&s.db, &admin_ids(s), &stream, me.id).await?.moderates())
}

fn admin_ids(s: &AppState) -> Vec<Uuid> {
    s.admins.iter().map(|a| a.id).collect()
}

fn is_admin(s: &AppState, me: &Account) -> bool {
    s.admins.iter().any(|a| a.id == me.id)
}

fn login() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn no_power() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "you can't do that here")
}

fn outranked(target: Rank) -> ApiError {
    match target {
        Rank::Owner => ApiError::new(StatusCode::FORBIDDEN, "the streamer can't be moderated in their own chat"),
        _ => ApiError::new(StatusCode::FORBIDDEN, format!("you can't moderate a {}", target.word())),
    }
}

fn stream_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if crate::valid_name(&name) {
        Ok(name)
    } else {
        Err(ApiError::bad_name())
    }
}

/// The stream in the path, 404 when no row has that name.
async fn the_stream(db: &PgPool, raw: &str) -> Result<Stream, ApiError> {
    let name = stream_name(raw)?;
    stream(db, &name).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such stream"))
}

/// A login, and its rank on the stream: one that moderates it, or 401 / 403.
async fn moderator(s: &AppState, me: Option<Account>, stream: &Stream) -> Result<(Account, Rank), ApiError> {
    let me = me.ok_or_else(login)?;
    let rank = rank_on(&s.db, &admin_ids(s), stream, me.id).await?;
    if !rank.moderates() {
        return Err(no_power());
    }
    Ok((me, rank))
}

/// The streamer or an admin: who names a stream's jannies.
async fn owner_or_admin(s: &AppState, me: Option<Account>, stream: &Stream) -> Result<Account, ApiError> {
    let me = me.ok_or_else(login)?;
    if stream.owner == Some(me.id) || is_admin(s, &me) {
        return Ok(me);
    }
    Err(no_power())
}

async fn paced(s: &AppState, me: &Account) -> Result<(), ApiError> {
    crate::auth::limit(s, &format!("rl:janny:{}", me.id), 60, ACTIONS_PER_MINUTE, "slow down: too many moderation actions").await
}

/// An account by its name now: 404 for a free name or a dummy's.
async fn account(s: &AppState, raw: &str) -> Result<Account, ApiError> {
    let name = stream_name(raw)?;
    if name.starts_with(&s.dummy_prefix) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such account"));
    }
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL").bind(&name).fetch_optional(&s.db).await?;
    id.map(|id| Account { id, name }).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such account"))
}

#[allow(clippy::too_many_arguments)]
async fn log_action(db: &PgPool, stream: &Stream, actor: &Account, action: &str, target: Option<Uuid>, target_name: &str, line_id: Option<&str>, snapshot: Option<Value>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO mod_log (stream_id, actor_id, actor_name, action, target_id, target_name, line_id, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(stream.id)
    .bind(actor.id)
    .bind(&actor.name)
    .bind(action)
    .bind(target)
    .bind(target_name)
    .bind(line_id)
    .bind(snapshot)
    .execute(db)
    .await?;
    Ok(())
}

// ---- deleting a line ------------------------------------------------------------------------

/// `DELETE /api/streams/:name/chat/:id`: the line goes, from redis and postgres, with its
/// reactions; its pictures stay in the bucket. Its copy is the log's. Every socket in the room
/// hears `{"type":"delete","id"}`. The streamer's lines stay (`may_act`); a janny may delete
/// their own. 204.
async fn delete_line(State(s): State<AppState>, Path((name, id)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let stream = the_stream(&s.db, &name).await?;
    let (me, rank) = moderator(&s, me, &stream).await?;
    paced(&s, &me).await?;
    let mut r = s.redis.clone();
    let Some(line) = crate::history::line_at(&s.db, &mut r, &stream.name, &id).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, crate::chat::NO_SUCH_LINE));
    };
    let target = if line.streamer {
        Rank::Owner
    } else {
        match line.user_id.filter(|_| line.verified) {
            Some(user) if user == me.id => Rank::Nobody,
            Some(user) => rank_on(&s.db, &admin_ids(&s), &stream, user).await?,
            None => Rank::Nobody,
        }
    };
    if !may_act(rank, target) {
        return Err(outranked(target));
    }
    let snapshot = serde_json::to_value(&line).ok();
    log_action(&s.db, &stream, &me, "delete", line.user_id.filter(|_| line.verified), &line.from, Some(&line.id), snapshot).await?;
    crate::chat::remove_line(&s.db, &mut r, &stream.name, &line.id).await?;
    log::info!("{}: deleted {}'s line {} in {}", me.name, line.from, line.id, stream.name);
    Ok(StatusCode::NO_CONTENT)
}

// ---- bans and timeouts ----------------------------------------------------------------------

#[derive(Deserialize)]
struct BanIn {
    name: String,
    #[serde(default)]
    reason: String,
}

#[derive(Deserialize)]
struct TimeoutIn {
    name: String,
    seconds: i64,
}

/// The target of a ban or a timeout: an account, not the actor, outranked by them.
async fn target(s: &AppState, stream: &Stream, me: &Account, rank: Rank, raw: &str) -> Result<Account, ApiError> {
    let target = account(s, raw).await?;
    if target.id == me.id {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not yourself"));
    }
    let theirs = rank_on(&s.db, &admin_ids(s), stream, target.id).await?;
    if !may_act(rank, theirs) {
        return Err(outranked(theirs));
    }
    Ok(target)
}

/// `POST /api/streams/:name/bans` `{ name, reason? }`: no line or reaction of theirs in the
/// stream's chat until lifted. 204.
async fn ban(State(s): State<AppState>, Path(name): Path<String>, Me(me): Me, body: Result<Json<BanIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let Json(body) = body?;
    let stream = the_stream(&s.db, &name).await?;
    let (me, rank) = moderator(&s, me, &stream).await?;
    paced(&s, &me).await?;
    let target = target(&s, &stream, &me, rank, &body.name).await?;
    let reason: String = crate::chat::clean_text(&body.reason).chars().take(MAX_REASON_CHARS).collect();
    sqlx::query(
        "INSERT INTO stream_bans (stream_id, user_id, by_id, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (stream_id, user_id) DO UPDATE SET by_id = EXCLUDED.by_id, reason = EXCLUDED.reason, banned_at = now()",
    )
    .bind(stream.id)
    .bind(target.id)
    .bind(me.id)
    .bind(&reason)
    .execute(&s.db)
    .await?;
    log_action(&s.db, &stream, &me, "ban", Some(target.id), &target.name, None, (!reason.is_empty()).then(|| json!({ "reason": reason }))).await?;
    log::info!("{}: banned {} from {}'s chat", me.name, target.name, stream.name);
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/streams/:name/bans/:user`: lifted. Any janny of the stream. 204, also when there was none.
async fn unban(State(s): State<AppState>, Path((name, user)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let stream = the_stream(&s.db, &name).await?;
    let (me, _) = moderator(&s, me, &stream).await?;
    paced(&s, &me).await?;
    let target = account(&s, &user).await?;
    let lifted = sqlx::query("DELETE FROM stream_bans WHERE stream_id = $1 AND user_id = $2").bind(stream.id).bind(target.id).execute(&s.db).await?;
    if lifted.rows_affected() > 0 {
        log_action(&s.db, &stream, &me, "unban", Some(target.id), &target.name, None, None).await?;
        log::info!("{}: lifted {}'s ban from {}'s chat", me.name, target.name, stream.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/streams/:name/timeouts` `{ name, seconds }`: ten seconds to a week. Set again, the
/// new end stands. The chat refuses them with `timed out` and the wait. 204.
async fn timeout(State(s): State<AppState>, Path(name): Path<String>, Me(me): Me, body: Result<Json<TimeoutIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let Json(body) = body?;
    if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&body.seconds) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("time out: {MIN_TIMEOUT_SECS} seconds to a week")));
    }
    let stream = the_stream(&s.db, &name).await?;
    let (me, rank) = moderator(&s, me, &stream).await?;
    paced(&s, &me).await?;
    let target = target(&s, &stream, &me, rank, &body.name).await?;
    sqlx::query("DELETE FROM stream_timeouts WHERE stream_id = $1 AND until < now()").bind(stream.id).execute(&s.db).await?;
    sqlx::query(
        "INSERT INTO stream_timeouts (stream_id, user_id, until, by_id) VALUES ($1, $2, now() + make_interval(secs => $3), $4)
         ON CONFLICT (stream_id, user_id) DO UPDATE SET until = EXCLUDED.until, by_id = EXCLUDED.by_id",
    )
    .bind(stream.id)
    .bind(target.id)
    .bind(body.seconds as f64)
    .bind(me.id)
    .execute(&s.db)
    .await?;
    log_action(&s.db, &stream, &me, "timeout", Some(target.id), &target.name, None, Some(json!({ "seconds": body.seconds }))).await?;
    log::info!("{}: timed {} out of {}'s chat for {}s", me.name, target.name, stream.name, body.seconds);
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/streams/:name/timeouts/:user`: lifted early. 204, also when there was none.
async fn lift_timeout(State(s): State<AppState>, Path((name, user)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let stream = the_stream(&s.db, &name).await?;
    let (me, _) = moderator(&s, me, &stream).await?;
    paced(&s, &me).await?;
    let target = account(&s, &user).await?;
    let lifted = sqlx::query("DELETE FROM stream_timeouts WHERE stream_id = $1 AND user_id = $2 AND until > now()")
        .bind(stream.id)
        .bind(target.id)
        .execute(&s.db)
        .await?;
    if lifted.rows_affected() > 0 {
        log_action(&s.db, &stream, &me, "untimeout", Some(target.id), &target.name, None, None).await?;
        log::info!("{}: lifted {}'s timeout in {}'s chat", me.name, target.name, stream.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/streams/:name/bans`: `{ bans: [{ name, by, reason, at }], timeouts: [{ name, by, until }] }`,
/// the running timeouts only, newest first. Any janny of the stream.
async fn list_bans(State(s): State<AppState>, Path(name): Path<String>, Me(me): Me) -> ApiResult {
    let stream = the_stream(&s.db, &name).await?;
    moderator(&s, me, &stream).await?;
    let bans: Vec<(String, Option<String>, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT u.name, b2.name, b.reason, b.banned_at FROM stream_bans b
         JOIN streamers u ON u.id = b.user_id LEFT JOIN streamers b2 ON b2.id = b.by_id
         WHERE b.stream_id = $1 ORDER BY b.banned_at DESC LIMIT 500",
    )
    .bind(stream.id)
    .fetch_all(&s.db)
    .await?;
    let timeouts: Vec<(String, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT u.name, b2.name, t.until FROM stream_timeouts t
         JOIN streamers u ON u.id = t.user_id LEFT JOIN streamers b2 ON b2.id = t.by_id
         WHERE t.stream_id = $1 AND t.until > now() ORDER BY t.until DESC LIMIT 500",
    )
    .bind(stream.id)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(json!({
        "bans": bans.into_iter().map(|(name, by, reason, at)| json!({ "name": name, "by": by, "reason": reason, "at": at })).collect::<Vec<_>>(),
        "timeouts": timeouts.into_iter().map(|(name, by, until)| json!({ "name": name, "by": by, "until": until })).collect::<Vec<_>>(),
    })))
}

/// `GET /api/streams/:name/mod-log`: the last 100 things done in the stream's chat, newest first:
/// `[{ at, actor, action, target, line_id, snapshot }]`. Any janny of the stream.
async fn mod_log(State(s): State<AppState>, Path(name): Path<String>, Me(me): Me) -> ApiResult {
    let stream = the_stream(&s.db, &name).await?;
    moderator(&s, me, &stream).await?;
    type Row = (chrono::DateTime<chrono::Utc>, String, String, String, Option<String>, Option<Value>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT l.at, COALESCE(a.name, l.actor_name), l.action, COALESCE(t.name, l.target_name), l.line_id, l.snapshot
         FROM mod_log l LEFT JOIN streamers a ON a.id = l.actor_id LEFT JOIN streamers t ON t.id = l.target_id
         WHERE l.stream_id = $1 ORDER BY l.at DESC, l.id DESC LIMIT $2",
    )
    .bind(stream.id)
    .bind(LOG_ROWS)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(Value::Array(
        rows.into_iter()
            .map(|(at, actor, action, target, line_id, snapshot)| json!({ "at": at, "actor": actor, "action": action, "target": target, "line_id": line_id, "snapshot": snapshot }))
            .collect(),
    )))
}

// ---- naming jannies -------------------------------------------------------------------------

#[derive(Deserialize)]
struct NameIn {
    name: String,
}

type JannyRow = (String, chrono::DateTime<chrono::Utc>);

fn jannies_json(rows: Vec<JannyRow>) -> Value {
    Value::Array(rows.into_iter().map(|(name, at)| json!({ "name": name, "added_at": at })).collect())
}

/// `GET /api/streams/:name/jannies`: `[{ name, added_at }]`. The streamer or an admin.
async fn list_stream_jannies(State(s): State<AppState>, Path(name): Path<String>, Me(me): Me) -> ApiResult {
    let stream = the_stream(&s.db, &name).await?;
    owner_or_admin(&s, me, &stream).await?;
    let rows: Vec<JannyRow> = sqlx::query_as(
        "SELECT u.name, j.added_at FROM stream_jannies j JOIN streamers u ON u.id = j.user_id WHERE j.stream_id = $1 ORDER BY j.added_at",
    )
    .bind(stream.id)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(jannies_json(rows)))
}

/// `POST /api/streams/:name/jannies` `{ name }`: one more stream janny, an account. Not the
/// streamer, not a dummy, twenty at most. 204, also when they were one already.
async fn add_stream_janny(State(s): State<AppState>, Path(name): Path<String>, Me(me): Me, body: Result<Json<NameIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let Json(body) = body?;
    let stream = the_stream(&s.db, &name).await?;
    let me = owner_or_admin(&s, me, &stream).await?;
    let janny = account(&s, &body.name).await?;
    if Some(janny.id) == stream.owner {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "the streamer is already the boss of their chat"));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM stream_jannies WHERE stream_id = $1").bind(stream.id).fetch_one(&s.db).await?;
    if count >= MAX_STREAM_JANNIES {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("{MAX_STREAM_JANNIES} jannies at most")));
    }
    let added = sqlx::query("INSERT INTO stream_jannies (stream_id, user_id, by_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(stream.id)
        .bind(janny.id)
        .bind(me.id)
        .execute(&s.db)
        .await?;
    if added.rows_affected() > 0 {
        log_action(&s.db, &stream, &me, "janny", Some(janny.id), &janny.name, None, None).await?;
        log::info!("{}: made {} a janny of {}", me.name, janny.name, stream.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/streams/:name/jannies/:user`: one fewer. 204, also when they were not one.
async fn remove_stream_janny(State(s): State<AppState>, Path((name, user)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let stream = the_stream(&s.db, &name).await?;
    let me = owner_or_admin(&s, me, &stream).await?;
    let janny = account(&s, &user).await?;
    let gone = sqlx::query("DELETE FROM stream_jannies WHERE stream_id = $1 AND user_id = $2").bind(stream.id).bind(janny.id).execute(&s.db).await?;
    if gone.rows_affected() > 0 {
        log_action(&s.db, &stream, &me, "unjanny", Some(janny.id), &janny.name, None, None).await?;
        log::info!("{}: {} is no janny of {} any more", me.name, janny.name, stream.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn admin_only(s: &AppState, me: Option<Account>) -> Result<Account, ApiError> {
    let me = me.ok_or_else(login)?;
    if !is_admin(s, &me) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admins only"));
    }
    Ok(me)
}

/// `GET /api/jannies`: the site jannies, `[{ name, added_at }]`. Admins only.
async fn list_site_jannies(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    admin_only(&s, me)?;
    let rows: Vec<JannyRow> = sqlx::query_as("SELECT u.name, j.added_at FROM site_jannies j JOIN streamers u ON u.id = j.user_id ORDER BY j.added_at")
        .fetch_all(&s.db)
        .await?;
    Ok(Json(jannies_json(rows)))
}

/// `POST /api/jannies` `{ name }`: one more site janny. Admins only. 204, also when they were one.
async fn add_site_janny(State(s): State<AppState>, Me(me): Me, body: Result<Json<NameIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let Json(body) = body?;
    let me = admin_only(&s, me)?;
    let janny = account(&s, &body.name).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM site_jannies").fetch_one(&s.db).await?;
    if count >= MAX_SITE_JANNIES {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("{MAX_SITE_JANNIES} site jannies at most")));
    }
    sqlx::query("INSERT INTO site_jannies (user_id, by_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(janny.id).bind(me.id).execute(&s.db).await?;
    log::info!("{}: made {} a site janny", me.name, janny.name);
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/jannies/:user`: one fewer site janny. Admins only. 204.
async fn remove_site_janny(State(s): State<AppState>, Path(user): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = admin_only(&s, me)?;
    let janny = account(&s, &user).await?;
    sqlx::query("DELETE FROM site_jannies WHERE user_id = $1").bind(janny.id).execute(&s.db).await?;
    log::info!("{}: {} is no site janny any more", me.name, janny.name);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/streams/{name}/chat/{id}", delete(delete_line))
        .route("/api/streams/{name}/bans", get(list_bans).post(ban))
        .route("/api/streams/{name}/bans/{user}", delete(unban))
        .route("/api/streams/{name}/timeouts", axum::routing::post(timeout))
        .route("/api/streams/{name}/timeouts/{user}", delete(lift_timeout))
        .route("/api/streams/{name}/mod-log", get(mod_log))
        .route("/api/streams/{name}/jannies", get(list_stream_jannies).post(add_stream_janny))
        .route("/api/streams/{name}/jannies/{user}", delete(remove_stream_janny))
        .route("/api/jannies", get(list_site_jannies).post(add_site_janny))
        .route("/api/jannies/{user}", delete(remove_site_janny))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_is_the_highest_thing_you_are() {
        assert_eq!(Rank::of(true, true, true, true), Rank::Admin);
        assert_eq!(Rank::of(false, true, true, true), Rank::Owner);
        assert_eq!(Rank::of(false, false, true, true), Rank::SiteJanny);
        assert_eq!(Rank::of(false, false, false, true), Rank::StreamJanny);
        assert_eq!(Rank::of(false, false, false, false), Rank::Nobody);
    }

    #[test]
    fn only_jannies_moderate() {
        assert!(!Rank::Nobody.moderates());
        for r in [Rank::StreamJanny, Rank::SiteJanny, Rank::Owner, Rank::Admin] {
            assert!(r.moderates(), "{r:?}");
        }
    }

    #[test]
    fn nobody_acts_on_their_own_rank_or_above() {
        let all = [Rank::Nobody, Rank::StreamJanny, Rank::SiteJanny, Rank::Owner, Rank::Admin];
        for actor in all {
            for target in all {
                if target >= actor {
                    assert!(!may_act(actor, target), "{actor:?} on {target:?}");
                }
            }
        }
    }

    #[test]
    fn the_ladder() {
        // a viewer moderates nobody, not even another viewer
        assert!(!may_act(Rank::Nobody, Rank::Nobody));
        // a stream janny: viewers only
        assert!(may_act(Rank::StreamJanny, Rank::Nobody));
        assert!(!may_act(Rank::StreamJanny, Rank::StreamJanny));
        assert!(!may_act(Rank::StreamJanny, Rank::SiteJanny));
        assert!(!may_act(Rank::StreamJanny, Rank::Owner));
        // a site janny: viewers and stream jannies, never the streamer or an admin
        assert!(may_act(Rank::SiteJanny, Rank::Nobody));
        assert!(may_act(Rank::SiteJanny, Rank::StreamJanny));
        assert!(!may_act(Rank::SiteJanny, Rank::SiteJanny));
        assert!(!may_act(Rank::SiteJanny, Rank::Owner));
        assert!(!may_act(Rank::SiteJanny, Rank::Admin));
        // the streamer: everyone in their chat but an admin
        assert!(may_act(Rank::Owner, Rank::SiteJanny));
        assert!(may_act(Rank::Owner, Rank::StreamJanny));
        assert!(!may_act(Rank::Owner, Rank::Admin));
        // an admin: everyone but another admin
        assert!(may_act(Rank::Admin, Rank::Owner));
        assert!(!may_act(Rank::Admin, Rank::Admin));
    }
}
