//! Groups: a login joins one, and its chat lines wear the group's badge. See docs/groups.md.
//!
//! A group is a name, a short badge, a colour and a line about it. A login owns a couple of
//! groups at most (`GROUPS_PER_OWNER`, two unless `.env` says otherwise), is in a few, and
//! deletes the ones it owns. One is built in and automatic: `bot`.
//! Nobody joins it; a chat socket whose hello says `bot: true` wears it (chat.rs), so the
//! pretend chatters of the fake streams can be told apart, and hidden, in the panel.
//!
//! Every other group is also a server. It starts with a channel called `general`. The
//! maker is its owner and can do everything, including name another owner. A custom role
//! (group_mod.rs) is a name, a colour and some of those powers, never owner itself.
//! The explorer lists them; the room is `/chat/<server>/<channel>`.
//!
//! Badges travel on the chat line itself (`groups`: name, badge, colour, as they were when
//! the line was said), so drawing a room needs no lookup here.
//!
//! Every change to a group is also a `group` fact on the `events` stream (presence.rs), which
//! the gateway pushes to the sockets watching `group:<name>`: a room on screen loads once
//! (`GET /api/groups/:group` with the roster and the channels, `GET .../messages` with the last
//! lines of every channel) and then follows the facts, never asking again.

use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use redis::streams::StreamRangeReply;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Me;
use crate::chat::{clean_text, line_from, room_key, with_faces, Line};
use crate::notify;
use crate::presence;
use crate::{valid_name, ApiError, ApiResult, AppState};

/// The automatic group. Seeded by the schema, joined by nobody, worn by a bot's socket.
pub(crate) const BOT_GROUP: &str = "bot";
/// A badge is a word, not a sentence: `BOT`, `VIP`, `mod`. The panel shows it in capitals.
const MAX_BADGE_CHARS: usize = 12;
const MAX_ABOUT_CHARS: usize = 200;
/// Groups one login may be in. Every badge goes on every line, so it is capped. Owning has its
/// own cap, `AppState::groups_per_owner`, read from `.env` (`groups_per_owner_from_env`).
const GROUPS_PER_MEMBER: i64 = 8;
/// Groups one login may own when `GROUPS_PER_OWNER` is not set: the ones it made plus the
/// ones it was named owner of.
pub(crate) const DEFAULT_GROUPS_PER_OWNER: i64 = 2;
/// Channels on one server, `general` included. The pages hold the same number, so the add
/// form goes at the cap; and it bounds what `GET .../messages` answers for one room.
const CHANNELS_PER_SERVER: i64 = 20;
/// Lines of each channel in `GET /api/groups/:group/messages`: what a room draws before its
/// socket says more. The socket fills from the newest of these, so nothing falls between.
const MESSAGES_PER_CHANNEL: usize = 100;
/// The channel a group starts with. It is not deleted.
const GENERAL: &str = "general";
/// Words the chat history routes already use, so a channel cannot be one of them.
const RESERVED_CHANNELS: &[&str] = &["before", "search", "by", "around"];

/// What a chat line carries for each group its speaker is in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Badge {
    pub(crate) name: String,
    pub(crate) badge: String,
    pub(crate) color: String,
}

/// The badges an account wears: its groups' in the order joined, with `bot` first when the
/// socket said so. One query. `None` (an anonymous nick) matches no membership.
pub(crate) async fn badges_of(db: &PgPool, user: Option<Uuid>, bot: bool) -> Result<Vec<Badge>, sqlx::Error> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color FROM groups g
         LEFT JOIN memberships m ON m.group_name = g.name AND m.user_id = $1
         WHERE (g.name = $2 AND $3) OR m.user_id IS NOT NULL
         ORDER BY g.name = $2 DESC, m.joined_at",
    )
    .bind(user)
    .bind(BOT_GROUP)
    .bind(bot)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(name, badge, color)| Badge { name, badge, color }).collect())
}

// ---- rules -----------------------------------------------------------------------------

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn no_such_group() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such group")
}

/// A group's name follows the name rule, from the path or the body.
pub(crate) fn group_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if valid_name(&name) {
        Ok(name)
    } else {
        Err(ApiError::bad_name())
    }
}

/// The address: the title, then `-` and four digits. A long title is cut so the whole
/// thing still fits the name rule (32).
fn tagged(title: &str, tag: i32) -> String {
    let suffix = format!("-{tag:04}");
    let keep = 32usize.saturating_sub(suffix.len());
    let head: String = title.chars().take(keep).collect();
    format!("{head}{suffix}")
}

fn random_tag() -> i32 {
    let mut buf = [0u8; 2];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut buf);
    i32::from(u16::from_le_bytes(buf) % 10_000)
}

/// Cleaned like a chat line (no control or invisible characters, no zalgo), on one line,
/// 1 to 12 characters.
fn clean_badge(raw: &str) -> Result<String, ApiError> {
    let badge: String = clean_text(raw).split_whitespace().collect::<Vec<_>>().join(" ");
    if (1..=MAX_BADGE_CHARS).contains(&badge.chars().count()) {
        Ok(badge)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "badge: 1 to 12 characters"))
    }
}

/// `#rrggbb`, lowercased.
pub(crate) fn clean_color(raw: &str) -> Result<String, ApiError> {
    let color = raw.trim().to_lowercase();
    let hex = color.strip_prefix('#').unwrap_or("");
    if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(color)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "color: #rrggbb"))
    }
}

pub(crate) fn clean_about(raw: &str) -> String {
    clean_text(raw).chars().take(MAX_ABOUT_CHARS).collect()
}

/// How many groups an account is in. The cap says when joining one more is one too many.
async fn member_of(db: &PgPool, user: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE user_id = $1").bind(user).fetch_one(db).await
}

fn too_many_groups() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, format!("you are in {GROUPS_PER_MEMBER} groups already. leave one first"))
}

/// `GROUPS_PER_OWNER` from the environment: how many groups one login may own. Unset or
/// empty is the default; anything that is not a count of one or more is said in the log and
/// the default is used, since a cap of zero would let nobody make a group. Never above
/// `GROUPS_PER_MEMBER`: every group a login owns is one it is in, so a higher cap could not
/// be reached, and the pages would offer `create` for a group the api refuses. More is said
/// in the log and `GROUPS_PER_MEMBER` is used.
pub(crate) fn groups_per_owner_from_env() -> i64 {
    groups_per_owner_from(std::env::var("GROUPS_PER_OWNER").ok().as_deref())
}

/// The rule behind `groups_per_owner_from_env`, on the raw value, so it can be tested.
fn groups_per_owner_from(raw: Option<&str>) -> i64 {
    let Some(raw) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return DEFAULT_GROUPS_PER_OWNER;
    };
    match raw.parse::<i64>() {
        Ok(n) if n > GROUPS_PER_MEMBER => {
            log::warn!("GROUPS_PER_OWNER={raw:?} is more than the {GROUPS_PER_MEMBER} groups a login may be in, using {GROUPS_PER_MEMBER}");
            GROUPS_PER_MEMBER
        }
        Ok(n) if n >= 1 => n,
        _ => {
            log::warn!("GROUPS_PER_OWNER={raw:?} is not a count of 1 or more, using {DEFAULT_GROUPS_PER_OWNER}");
            DEFAULT_GROUPS_PER_OWNER
        }
    }
}

/// How many groups this account owns: the ones it made, and the ones it was named owner of.
/// Making another, or being named owner of another, is refused at `groups_per_owner`.
pub(crate) async fn groups_owned(db: &PgPool, user: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE user_id = $1 AND owner").bind(user).fetch_one(db).await
}

/// The words for the cap on owning, as the create and the naming of an owner say it: `a
/// group already. one each` for a cap of one, `2 groups already. that is the cap` above it.
pub(crate) fn owned_cap_words(cap: i64) -> String {
    if cap == 1 {
        "a group already. one each".into()
    } else {
        format!("{cap} groups already. that is the cap")
    }
}

/// How many are in the group now: on every `joined`, `left` and `banned` fact, so a room
/// never counts on its own.
pub(crate) async fn member_count(db: &PgPool, group: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE group_name = $1").bind(group).fetch_one(db).await
}

/// One change of a group, to whoever has its room open (docs/groups.md). After the row is
/// written, never before: a watcher patches what it has, and must not run ahead of the api.
pub(crate) async fn tell(s: &AppState, group: &str, what: &str, data: Value) {
    presence::publish_group(&mut s.redis.clone(), group, what, &data).await;
}

// ---- routes ----------------------------------------------------------------------------

/// name, badge, color, about, made_by, members, mine, public, title, tag
type GroupRow = (String, String, String, String, Option<String>, i64, bool, bool, Option<String>, Option<i32>);

fn group_json((name, badge, color, about, made_by, members, mine, public, title, tag): GroupRow) -> Value {
    json!({
        "name": name,
        "badge": badge,
        "color": color,
        "about": about,
        "made_by": made_by,
        "members": members,
        "mine": mine,
        "public": public,
        "title": title,
        "tag": tag,
        "automatic": name == BOT_GROUP,
    })
}

/// `GET /api/groups`: every group a stranger may see, `bot` first, then oldest first.
/// A private group is here only for someone in it (and `bot` always). `made_by` is the
/// maker's name as it is now, by the id: a renamed maker reads right everywhere.
async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<GroupRow> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color, g.about, maker.name,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1),
                g.public, g.title, g.tag
         FROM groups g
         LEFT JOIN streamers maker ON maker.id = g.created_by_id
         WHERE g.public OR g.name = $2
            OR EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1)
         ORDER BY g.name = $2 DESC, g.created_at, g.name",
    )
    .bind(me.as_ref().map(|a| a.id))
    .bind(BOT_GROUP)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(Value::Array(rows.into_iter().map(group_json).collect())))
}

#[derive(Deserialize)]
struct NewGroup {
    name: String,
    badge: String,
    color: String,
    #[serde(default)]
    about: String,
    /// Left off the lists when false. Absent means public, so an older page still makes one.
    #[serde(default = "default_public")]
    public: bool,
}

fn default_public() -> bool {
    true
}

/// `POST /api/groups`: a login makes a group and is in it, as its owner. 201 with the group as
/// the list shows it. The body's `name` is the title. The stored `name` is that title plus `-`
/// and four random digits, so the same title can be made again. 400 for a bad name, badge or
/// colour; 403 while the login owns as many groups as `GROUPS_PER_OWNER` allows; 409 `name
/// taken` for `bot`, or when eight draws of the digits were all taken.
async fn create(State(s): State<AppState>, Me(me): Me, body: Result<Json<NewGroup>, JsonRejection>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let maker = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let title = group_name(&body.name)?;
    let badge = clean_badge(&body.badge)?;
    let color = clean_color(&body.color)?;
    let about = clean_about(&body.about);
    if title == BOT_GROUP {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    if groups_owned(&s.db, maker.id).await? >= s.groups_per_owner {
        let one = s.groups_per_owner == 1;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("you own {}: delete {}, or name another owner and step down first", owned_cap_words(s.groups_per_owner), if one { "it" } else { "one" }),
        ));
    }
    if member_of(&s.db, maker.id).await? >= GROUPS_PER_MEMBER {
        return Err(too_many_groups());
    }
    // the group, its first member, and its first channel in one statement: no server
    // without `general`, and no group without its maker in it.
    // the id is the key; the name columns are written while they exist (docs/ids.md).
    // a taken address (the digits collided) inserts nothing, and we draw again.
    let mut slug = String::new();
    let mut tag = 0i32;
    let mut inserted = false;
    for _ in 0..8 {
        tag = random_tag();
        slug = tagged(&title, tag);
        let made: Option<String> = sqlx::query_scalar(
            "WITH g AS (
                INSERT INTO groups (name, badge, color, about, created_by, created_by_id, public, title, tag)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (name) DO NOTHING RETURNING name
             ),
             c AS (
                INSERT INTO channels (server, name, about, created_by_id)
                SELECT name, 'general', '', $6 FROM g RETURNING server
             )
             INSERT INTO memberships (name, group_name, user_id, owner)
             SELECT $5, g.name, $6, true FROM g JOIN c ON c.server = g.name RETURNING group_name",
        )
        .bind(&slug)
        .bind(&badge)
        .bind(&color)
        .bind(&about)
        .bind(&maker.name)
        .bind(maker.id)
        .bind(body.public)
        .bind(&title)
        .bind(tag)
        .fetch_optional(&s.db)
        .await?;
        if made.is_some() {
            inserted = true;
            break;
        }
    }
    if !inserted {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    log::info!("{}: made the group {slug} ({badge})", maker.name);
    Ok((StatusCode::CREATED, Json(group_json((slug, badge, color, about, Some(maker.name.clone()), 1, true, body.public, Some(title), Some(tag))))))
}

/// `POST /api/groups/:group/join`: 204, also when already in it. 401 for nobody, 404 for no
/// such group, 403 for `bot` (automatic) and past the cap.
async fn join(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    if group == BOT_GROUP {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "bot is automatic: a bot's chat socket says so. nobody joins it"));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&group).fetch_one(&s.db).await?;
    if !exists {
        return Err(no_such_group());
    }
    let already: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2)")
        .bind(me.id)
        .bind(&group)
        .fetch_one(&s.db)
        .await?;
    if already {
        return Ok(StatusCode::NO_CONTENT);
    }
    if crate::group_mod::banned(&s.db, me.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you are banned"));
    }
    if member_of(&s.db, me.id).await? >= GROUPS_PER_MEMBER {
        return Err(too_many_groups());
    }
    sqlx::query("INSERT INTO memberships (name, group_name, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(&me.name)
        .bind(&group)
        .bind(me.id)
        .execute(&s.db)
        .await?;
    log::info!("{}: joined {group}", me.name);
    // the row as the roster draws it, so a room adds it without asking
    let row: Option<(Option<i64>, i64)> = sqlx::query_as(
        "SELECT (EXTRACT(EPOCH FROM st.avatar_at))::bigint, (EXTRACT(EPOCH FROM m.joined_at))::bigint
         FROM memberships m JOIN streamers st ON st.id = m.user_id WHERE m.user_id = $1 AND m.group_name = $2",
    )
    .bind(me.id)
    .bind(&group)
    .fetch_optional(&s.db)
    .await?;
    let (avatar, joined) = row.unwrap_or((None, 0));
    let members = member_count(&s.db, &group).await?;
    tell(&s, &group, "joined", json!({ "who": me.name, "avatar": avatar, "joined": joined, "members": members })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/groups/:group/leave`: 204, also when not in it. 401 for nobody. 403 when this
/// login is the only owner and someone else is still in it: name another one first. The last
/// person out deletes the group. Their roles in this group go with them.
async fn leave(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    let owner: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2 AND owner)")
        .bind(me.id)
        .bind(&group)
        .fetch_one(&s.db)
        .await?;
    if owner {
        let owners: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE group_name = $1 AND owner").bind(&group).fetch_one(&s.db).await?;
        let members: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE group_name = $1").bind(&group).fetch_one(&s.db).await?;
        if owners <= 1 && members > 1 {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "name another owner first"));
        }
    }
    crate::group_mod::drop_roles(&s.db, &group, me.id).await?;
    let done = sqlx::query("DELETE FROM memberships WHERE user_id = $1 AND group_name = $2")
        .bind(me.id)
        .bind(&group)
        .execute(&s.db)
        .await?;
    if done.rows_affected() > 0 {
        log::info!("{}: left {group}", me.name);
        let members = member_count(&s.db, &group).await?;
        tell(&s, &group, "left", json!({ "who": me.name, "by": "leave", "members": members })).await;
    }
    delete_if_empty(&s, &group).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A group with nobody in it is gone, pictures included. `bot` stays. Whoever still has
/// the room open hears `deleted`.
pub(crate) async fn delete_if_empty(s: &AppState, group: &str) -> Result<(), sqlx::Error> {
    if group == BOT_GROUP {
        return Ok(());
    }
    if member_count(&s.db, group).await? > 0 {
        return Ok(());
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(group).fetch_one(&s.db).await?;
    if !exists {
        return Ok(());
    }
    let _ = crate::s3::delete(&s.s3, &format!("groups/{group}/icon.jpg")).await;
    let _ = crate::s3::delete(&s.s3, &format!("groups/{group}/banner.jpg")).await;
    sqlx::query("DELETE FROM groups WHERE name = $1").bind(group).execute(&s.db).await?;
    log::info!("deleted {group}: nobody left");
    tell(s, group, "deleted", json!({})).await;
    Ok(())
}

/// `DELETE /api/groups/:group`: an owner, the one who made it, or an admin (`ADMIN_NAMES`).
/// 204; its members are out with it. 401 for nobody, 403 `not your group` and for `bot`, 404.
async fn remove(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    if group == BOT_GROUP {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "bot is built in"));
    }
    let made_by: Option<Option<Uuid>> = sqlx::query_scalar("SELECT created_by_id FROM groups WHERE name = $1").bind(&group).fetch_optional(&s.db).await?;
    let Some(made_by) = made_by else { return Err(no_such_group()) };
    let owner: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2 AND owner)")
        .bind(who.id)
        .bind(&group)
        .fetch_one(&s.db)
        .await?;
    if made_by != Some(who.id) && !owner && !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your group"));
    }
    let _ = crate::s3::delete(&s.s3, &format!("groups/{group}/icon.jpg")).await;
    let _ = crate::s3::delete(&s.s3, &format!("groups/{group}/banner.jpg")).await;
    sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&s.db).await?;
    log::info!("{}: deleted the group {group}", who.name);
    tell(&s, &group, "deleted", json!({})).await;
    Ok(StatusCode::NO_CONTENT)
}

/// A server and a channel, cleaned. `bot` is not a server. The history words are not channels,
/// or `/chat/vip/by/alice` would be a room and a search at once.
pub(crate) fn channel_names(server: &str, channel: &str) -> Result<(String, String), ApiError> {
    let server = group_name(server)?;
    let channel = group_name(channel)?;
    if server == BOT_GROUP {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "bot is not a server"));
    }
    if RESERVED_CHANNELS.contains(&channel.as_str()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that name is reserved"));
    }
    Ok((server, channel))
}

/// The room key `server/channel` once the channel is really there.
pub(crate) async fn channel_room(db: &PgPool, server: &str, channel: &str) -> Result<(String, String), ApiError> {
    let (server, channel) = channel_names(server, channel)?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM channels WHERE server = $1 AND name = $2)")
        .bind(&server)
        .bind(&channel)
        .fetch_one(db)
        .await?;
    if !exists {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    let room = format!("{server}/{channel}");
    Ok((server, room))
}

/// Whether this account is in the group. Speaking in a channel asks; reading does not.
pub(crate) async fn member(db: &PgPool, user: Uuid, group: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2)")
        .bind(user)
        .bind(group)
        .fetch_one(db)
        .await
}

#[derive(Serialize)]
pub(crate) struct ChannelView {
    name: String,
    about: String,
    /// The login may delete it: they made it, or they hold the channels power. Never `general`.
    can_delete: bool,
    /// Who made it, by the name they have now. Null for `general` (made with the group) and
    /// for a maker whose account is gone. A room keeps `can_delete` right as the facts come.
    made_by: Option<String>,
}

/// The channels of one server in their order (`position`, as the channels power last put them;
/// oldest first until then, `general` first because it was made with the group), as the room
/// answers them for `user`. The same rule as the explorer's: `can_delete` is who made the
/// channel, or anyone with the channels power (an owner, that role, a site admin).
pub(crate) async fn channels_of(s: &AppState, server: &str, user: Option<Uuid>, admin: bool) -> Result<Vec<ChannelView>, sqlx::Error> {
    let may_manage = match user {
        Some(id) => crate::group_mod::allows(s, id, server, crate::group_mod::CHANNELS).await?,
        None => false,
    };
    let rows: Vec<(String, String, Option<Uuid>, Option<String>)> = sqlx::query_as(
        "SELECT c.name, c.about, c.created_by_id, maker.name FROM channels c
         LEFT JOIN streamers maker ON maker.id = c.created_by_id
         WHERE c.server = $1 ORDER BY c.position, c.created_at, c.name",
    )
    .bind(server)
    .fetch_all(&s.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(name, about, made_by_id, made_by)| {
            let mine = user.is_some() && made_by_id == user;
            let can_delete = name != GENERAL && (mine || may_manage || admin);
            // `general` was made with the group: nobody's channel in particular
            ChannelView { can_delete, made_by: made_by.filter(|_| name != GENERAL), name, about }
        })
        .collect())
}

/// The members of `group` who are streaming right now, by the name they have now.
pub(crate) async fn live_in(s: &AppState, group: &str) -> Result<Vec<String>, ApiError> {
    let mut living = live_members(&s.db, &live_names(s).await?).await?;
    Ok(living.remove(group).unwrap_or_default())
}

#[derive(Serialize)]
struct ServerView {
    name: String,
    badge: String,
    color: String,
    about: String,
    members: i64,
    mine: bool,
    /// This login owns it. Counted against `groups_per_owner`, so a page knows whether to offer `create`.
    owner: bool,
    /// On the lists for someone who has not joined. A private group is only in `yours`.
    public: bool,
    /// The words they typed. Null for a group made before the digits.
    title: Option<String>,
    /// Four digits, 0 to 9999. Null for a group made before the digits.
    tag: Option<i32>,
    /// Unix seconds, the `?v=` of the picture. Null: none.
    icon: Option<i64>,
    banner: Option<i64>,
    /// This login may add a channel: an owner, the channels bit, or a site admin.
    can_channels: bool,
    /// Members streaming right now, by the name they have now. Not the roster.
    live: Vec<String>,
    channels: Vec<ChannelView>,
}

/// Names video says are connected, or the `live:` keys when video cannot be asked.
async fn live_names(s: &AppState) -> Result<Vec<String>, ApiError> {
    if let Some(set) = crate::video_live(s).await {
        return Ok(set.into_iter().collect());
    }
    crate::redis_live(s).await.map_err(Into::into)
}

/// Which groups have which of these names in them. A name not live is never asked.
async fn live_members(db: &PgPool, names: &[String]) -> Result<HashMap<String, Vec<String>>, sqlx::Error> {
    let mut by_group: HashMap<String, Vec<String>> = HashMap::new();
    if names.is_empty() {
        return Ok(by_group);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT m.group_name, s.name FROM memberships m
         JOIN streamers s ON s.id = m.user_id
         WHERE s.name = ANY($1) AND m.group_name <> $2
         ORDER BY s.name",
    )
    .bind(names)
    .bind(BOT_GROUP)
    .fetch_all(db)
    .await?;
    for (group, name) in rows {
        by_group.entry(group).or_default().push(name);
    }
    Ok(by_group)
}

/// Someone live first, then the order the rows came in (oldest server first).
fn live_first(mut servers: Vec<ServerView>) -> Vec<ServerView> {
    servers.sort_by(|a, b| a.live.is_empty().cmp(&b.live.is_empty()));
    servers
}

/// `GET /api/explore`: every server (not `bot`) this login may see, split into the ones
/// it is in and the public ones it is not. A private group it has not joined is left out.
/// Inside each, a server with someone live comes first. `live` is those members'
/// names. Channels in their order (`position`), as the room lists them.
/// `groups_per_owner` is the cap on owning, so a page offers `create` only under it.
async fn explore(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let user = me.as_ref().map(|a| a.id);
    let admin = me.as_ref().is_some_and(|a| s.admins.iter().any(|admin| admin.id == a.id));
    let mut living = live_members(&s.db, &live_names(&s).await?).await?;
    // the groups this login owns: up to the cap, the set so the page counts them
    let owned: Vec<String> = sqlx::query_scalar("SELECT group_name FROM memberships WHERE user_id = $1 AND owner").bind(user).fetch_all(&s.db).await?;
    // name, badge, color, about, members, mine, public, title, tag, icon, banner,
    // can add a channel, channel, channel about, can delete, channel maker
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, String, i64, bool, bool, Option<String>, Option<i32>, Option<i64>, Option<i64>, bool, Option<String>, Option<String>, bool, Option<String>)> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color, g.about,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1),
                g.public, g.title, g.tag,
                (EXTRACT(EPOCH FROM g.icon_at))::bigint,
                (EXTRACT(EPOCH FROM g.banner_at))::bigint,
                (
                    EXISTS (SELECT 1 FROM memberships om WHERE om.group_name = g.name AND om.user_id = $1 AND om.owner)
                    OR $2
                    OR EXISTS (
                        SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                        WHERE r.group_name = g.name AND rm.user_id = $1 AND (r.perms & 4) <> 0
                    )
                ),
                c.name, c.about,
                COALESCE(c.name IS NOT NULL AND c.name <> 'general' AND (
                    c.created_by_id = $1 OR $2
                    OR EXISTS (SELECT 1 FROM memberships om WHERE om.group_name = g.name AND om.user_id = $1 AND om.owner)
                    OR EXISTS (
                        SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                        WHERE r.group_name = g.name AND rm.user_id = $1 AND (r.perms & 4) <> 0
                    )
                ), false),
                cm.name
         FROM groups g
         LEFT JOIN channels c ON c.server = g.name
         LEFT JOIN streamers cm ON cm.id = c.created_by_id
         WHERE g.name <> $3
           AND (g.public OR EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1))
         ORDER BY g.created_at, g.name, c.position NULLS LAST, c.created_at, c.name",
    )
    .bind(user)
    .bind(admin)
    .bind(BOT_GROUP)
    .fetch_all(&s.db)
    .await?;
    let mut servers: Vec<ServerView> = Vec::new();
    for (name, badge, color, about, members, mine, public, title, tag, icon, banner, can_channels, channel, channel_about, can_delete, made_by) in rows {
        if servers.last().is_none_or(|server| server.name != name) {
            let live = living.remove(&name).unwrap_or_default();
            let owner = owned.contains(&name);
            servers.push(ServerView { name, badge, color, about, members, mine, owner, public, title, tag, icon, banner, can_channels, live, channels: Vec::new() });
        }
        if let Some(name) = channel {
            let made_by = made_by.filter(|_| name != GENERAL);
            servers.last_mut().unwrap().channels.push(ChannelView { name, about: channel_about.unwrap_or_default(), can_delete, made_by });
        }
    }
    let (yours, discover): (Vec<ServerView>, Vec<ServerView>) = servers.into_iter().partition(|server| server.mine);
    Ok(Json(json!({ "yours": live_first(yours), "discover": live_first(discover), "groups_per_owner": s.groups_per_owner })))
}

#[derive(Deserialize)]
struct NewChannel {
    name: String,
    #[serde(default)]
    about: String,
}

/// `POST /api/groups/:group/channels`: a member adds one. 201. `general` already exists.
async fn create_channel(
    State(s): State<AppState>,
    Path(group): Path<String>,
    Me(me): Me,
    body: Result<Json<NewChannel>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let who = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let (server, channel) = channel_names(&group, &body.name)?;
    let about = clean_about(&body.about);
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&server).fetch_one(&s.db).await?;
    if !exists {
        return Err(no_such_group());
    }
    if !member(&s.db, who.id, &server).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the server first"));
    }
    if !crate::group_mod::allows(&s, who.id, &server, crate::group_mod::CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you can't add a channel"));
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM channels WHERE server = $1").bind(&server).fetch_one(&s.db).await?;
    if n >= CHANNELS_PER_SERVER {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("this server has {CHANNELS_PER_SERVER} channels already")));
    }
    // after the last: the list is in the order it was put in, and a new channel joins its end
    let added = sqlx::query(
        "INSERT INTO channels (server, name, about, created_by_id, position)
         SELECT $1, $2, $3, $4, COALESCE(max(position), -1) + 1 FROM channels WHERE server = $1
         ON CONFLICT DO NOTHING",
    )
    .bind(&server)
    .bind(&channel)
    .bind(&about)
    .bind(who.id)
    .execute(&s.db)
    .await?;
    if added.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    log::info!("{}: added #{channel} to {server}", who.name);
    tell(&s, &server, "channel", json!({ "channel": { "name": channel, "about": about, "made_by": who.name } })).await;
    Ok((StatusCode::CREATED, Json(json!({ "name": channel, "about": about, "can_delete": channel != GENERAL, "made_by": who.name }))))
}

#[derive(Deserialize)]
struct ChannelOrder {
    order: Vec<String>,
}

/// `PUT /api/groups/:group/channels` `{ order: [name, …] }`: the channels in this order, from
/// the top. The channels power, and a member. Every name must be a channel of the server, once;
/// a channel not named (one added since the page read the list) keeps its place after the
/// named ones. → `{ order }`, the whole list as it now stands, which the `channel_order` fact
/// carries too. 400 for a name that is not a channel or a name twice, 403 without the power.
async fn reorder_channels(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<ChannelOrder>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let server = group_name(&group)?;
    if server == BOT_GROUP {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "bot is not a server"));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&server).fetch_one(&s.db).await?;
    if !exists {
        return Err(no_such_group());
    }
    if !member(&s.db, who.id, &server).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the server first"));
    }
    if !crate::group_mod::allows(&s, who.id, &server, crate::group_mod::CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you can't move the channels"));
    }
    let current: Vec<String> = sqlx::query_scalar("SELECT name FROM channels WHERE server = $1 ORDER BY position, created_at, name").bind(&server).fetch_all(&s.db).await?;
    let mut order: Vec<String> = Vec::with_capacity(current.len());
    for raw in &body.order {
        let name = raw.trim().to_lowercase();
        if !current.contains(&name) {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("no such channel: {raw}")));
        }
        if order.contains(&name) {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("{name} is named twice")));
        }
        order.push(name);
    }
    // the rest as they stand, after the named ones
    let rest: Vec<String> = current.into_iter().filter(|name| !order.contains(name)).collect();
    order.extend(rest);
    let positions: Vec<i32> = (0..order.len() as i32).collect();
    sqlx::query(
        "UPDATE channels c SET position = o.position
         FROM unnest($2::text[], $3::int[]) AS o(name, position)
         WHERE c.server = $1 AND c.name = o.name",
    )
    .bind(&server)
    .bind(&order)
    .bind(&positions)
    .execute(&s.db)
    .await?;
    log::info!("{}: put the channels of {server} in order: {}", who.name, order.join(", "));
    tell(&s, &server, "channel_order", json!({ "order": order })).await;
    Ok(Json(json!({ "order": order })))
}

/// `DELETE /api/groups/:group/channels/:channel`: who made the channel, who made the server,
/// or an admin. `general` stays.
async fn delete_channel(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(not_logged_in)?;
    let (server, channel) = channel_names(&group, &channel)?;
    if channel == GENERAL {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "general stays"));
    }
    let row: Option<(Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        "SELECT c.created_by_id, g.created_by_id FROM channels c
         JOIN groups g ON g.name = c.server WHERE c.server = $1 AND c.name = $2",
    )
    .bind(&server)
    .bind(&channel)
    .fetch_optional(&s.db)
    .await?;
    let Some((made_channel, _)) = row else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    };
    // who made the channel, or anyone with the channels bit: an owner, that role, a site admin
    if made_channel != Some(who.id) && !crate::group_mod::allows(&s, who.id, &server, crate::group_mod::CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your channel"));
    }
    sqlx::query("DELETE FROM channels WHERE server = $1 AND name = $2").bind(&server).bind(&channel).execute(&s.db).await?;
    log::info!("{}: removed #{channel} from {server}", who.name);
    tell(&s, &server, "unchannel", json!({ "channel": channel })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// The channels of `server` this account has muted (docs/notifications.md): none of their
/// lines is a row in its inbox. In the room's answer, so the list can say so. Empty for nobody.
pub(crate) async fn muted_in(db: &PgPool, user: Option<Uuid>, server: &str) -> Result<Vec<String>, sqlx::Error> {
    let Some(user) = user else { return Ok(Vec::new()) };
    sqlx::query_scalar("SELECT channel FROM channel_mutes WHERE user_id = $1 AND server = $2 ORDER BY channel")
        .bind(user)
        .bind(server)
        .fetch_all(db)
        .await
}

/// `PUT /api/groups/:group/channels/:channel/mute`: no inbox row for this channel's lines, for
/// this login, from now on. 204, also when it already was. What is in the inbox stays, the way
/// a kind switched off leaves it. 401 for nobody, 404 `no such channel`. Not only a member's:
/// a mute outlives a leave, so joining again finds the channel as it was left.
async fn mute_channel(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let (server, channel) = channel_names(&group, &channel)?;
    channel_room(&s.db, &server, &channel).await?;
    sqlx::query("INSERT INTO channel_mutes (user_id, server, channel) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(me.id)
        .bind(&server)
        .bind(&channel)
        .execute(&s.db)
        .await?;
    log::info!("{}: muted #{channel} in {server}", me.name);
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/groups/:group/channels/:channel/mute`: the channel's lines reach this login's
/// bell again. 204, also when it was not muted. 401 for nobody, 404 `no such channel`.
async fn unmute_channel(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let (server, channel) = channel_names(&group, &channel)?;
    channel_room(&s.db, &server, &channel).await?;
    let lifted = sqlx::query("DELETE FROM channel_mutes WHERE user_id = $1 AND server = $2 AND channel = $3")
        .bind(me.id)
        .bind(&server)
        .bind(&channel)
        .execute(&s.db)
        .await?;
    if lifted.rows_affected() > 0 {
        log::info!("{}: unmuted #{channel} in {server}", me.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/groups/:group/channels/:channel/read`: the login has the channel on screen, so
/// what was said in it is not news any more: its `chat` rows for the room are read. 204. A
/// `chat_read` fact tells the login's other devices when anything was still unread. No check
/// that the channel is still there: a row for one since deleted is read the same.
async fn read_channel(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let (server, channel) = channel_names(&group, &channel)?;
    let room = notify::room_of(&server, &channel);
    if notify::channel_read(&s.db, me.id, &room).await? {
        presence::publish_chat_read(&mut s.redis.clone(), &me.name, &room).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/groups/:group/messages`: the last MESSAGES_PER_CHANNEL lines of every channel,
/// oldest first, keyed by channel: `{ "general": [line, …], "clips": [...] }`. One answer for
/// the whole server, so a room draws every channel at once and switching between them asks
/// nothing. Redis only, like the socket's history: the room's stream holds the last 500 of
/// each. Anyone may read a server (chat.md). 404 for `bot` and for no such group.
async fn messages(State(s): State<AppState>, Path(group): Path<String>) -> ApiResult {
    let server = group_name(&group)?;
    if server == BOT_GROUP {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "bot is not a server"));
    }
    let channels: Vec<String> = sqlx::query_scalar("SELECT name FROM channels WHERE server = $1 ORDER BY created_at, name").bind(&server).fetch_all(&s.db).await?;
    if channels.is_empty() {
        // a group without `general` is no group: it was deleted (or never was)
        return Err(no_such_group());
    }
    // every channel's newest page in one round trip
    let mut pipe = redis::pipe();
    for channel in &channels {
        pipe.cmd("XREVRANGE").arg(room_key(&format!("{server}/{channel}"))).arg("+").arg("-").arg("COUNT").arg(MESSAGES_PER_CHANNEL);
    }
    let replies: Vec<StreamRangeReply> = pipe.query_async(&mut s.redis.clone()).await?;
    let mut pages: Vec<(String, Vec<Line>)> = channels
        .into_iter()
        .zip(replies)
        .map(|(channel, reply)| {
            let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
            lines.reverse();
            (channel, lines)
        })
        .collect();
    // the faces as they are now, every channel's in the one query
    with_faces(&s.db, pages.iter_mut().flat_map(|(_, lines)| lines.iter_mut())).await;
    let out: serde_json::Map<String, Value> = pages.into_iter().map(|(channel, lines)| (channel, json!(lines))).collect();
    Ok(Json(Value::Object(out)))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/explore", get(explore))
        .route("/api/groups", get(list).post(create))
        .route("/api/groups/{group}", get(crate::group_mod::room).delete(remove))
        .route("/api/groups/{group}/join", post(join))
        .route("/api/groups/{group}/leave", post(leave))
        .route("/api/groups/{group}/channels", post(create_channel).put(reorder_channels))
        .route("/api/groups/{group}/channels/{channel}", delete(delete_channel))
        .route("/api/groups/{group}/channels/{channel}/mute", put(mute_channel).delete(unmute_channel))
        .route("/api/groups/{group}/channels/{channel}/read", put(read_channel))
        .route("/api/groups/{group}/messages", get(messages))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badges() {
        assert_eq!(clean_badge(" vip ").unwrap(), "vip");
        assert_eq!(clean_badge("og\nfan").unwrap(), "og fan");
        assert_eq!(clean_badge("\u{200B}x\u{7}").unwrap(), "x");
        assert!(clean_badge("").is_err());
        assert!(clean_badge("   ").is_err());
        assert!(clean_badge(&"x".repeat(13)).is_err());
        assert_eq!(clean_badge("\u{1F916}").unwrap(), "\u{1F916}");
    }

    #[test]
    fn colors() {
        assert_eq!(clean_color("#5865F2").unwrap(), "#5865f2");
        assert_eq!(clean_color(" #abcdef ").unwrap(), "#abcdef");
        assert!(clean_color("5865f2").is_err());
        assert!(clean_color("#fff").is_err());
        assert!(clean_color("#12345g").is_err());
        assert!(clean_color("").is_err());
    }

    #[test]
    fn group_names_follow_the_name_rule() {
        assert_eq!(group_name(" VIP ").unwrap(), "vip");
        assert!(group_name("").is_err());
        assert!(group_name("a b").is_err());
        assert!(group_name(&"a".repeat(33)).is_err());
    }

    #[test]
    fn the_digits_fit_the_name() {
        assert_eq!(tagged("gaming", 42), "gaming-0042");
        let slug = tagged(&"a".repeat(32), 7);
        assert_eq!(slug.len(), 32);
        assert!(slug.ends_with("-0007"));
        assert!(valid_name(&slug));
    }

    #[test]
    fn the_cap_on_owning_is_said_by_its_size() {
        assert_eq!(owned_cap_words(1), "a group already. one each");
        assert_eq!(owned_cap_words(2), "2 groups already. that is the cap");
        assert_eq!(owned_cap_words(5), "5 groups already. that is the cap");
    }

    #[test]
    fn the_cap_on_owning_stays_within_the_cap_on_being_in() {
        // every group a login owns is one it is in, so a cap above GROUPS_PER_MEMBER could
        // never be reached: it is read as GROUPS_PER_MEMBER
        assert_eq!(groups_per_owner_from(Some("10")), GROUPS_PER_MEMBER);
        assert_eq!(groups_per_owner_from(Some("8")), 8);
        assert_eq!(groups_per_owner_from(Some("2")), 2);
        assert_eq!(groups_per_owner_from(Some("1")), 1);
        assert_eq!(groups_per_owner_from(Some(" 3 ")), 3);
        for raw in [None, Some(""), Some("  "), Some("0"), Some("-3"), Some("x")] {
            assert_eq!(groups_per_owner_from(raw), DEFAULT_GROUPS_PER_OWNER, "{raw:?}");
        }
    }

    #[test]
    fn about_is_capped() {
        assert_eq!(clean_about("  hi  "), "hi");
        assert_eq!(clean_about(&"x".repeat(300)).chars().count(), MAX_ABOUT_CHARS);
    }

    #[test]
    fn channel_names_keep_the_history_words_free() {
        assert!(channel_names("vip", "before").is_err());
        assert!(channel_names("vip", "search").is_err());
        assert!(channel_names("vip", "by").is_err());
        assert!(channel_names("vip", "around").is_err());
        assert!(channel_names("bot", "general").is_err());
        assert_eq!(channel_names("VIP", "General").unwrap(), ("vip".into(), "general".into()));
    }

    #[test]
    fn a_badge_serialises_plainly() {
        let b = Badge { name: "bot".into(), badge: "BOT".into(), color: "#5865f2".into() };
        let text = serde_json::to_string(&vec![b.clone()]).unwrap();
        assert_eq!(text, r##"[{"name":"bot","badge":"BOT","color":"#5865f2"}]"##);
        assert_eq!(serde_json::from_str::<Vec<Badge>>(&text).unwrap(), vec![b]);
    }
}
