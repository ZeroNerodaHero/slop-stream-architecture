//! An owner's powers, and the custom roles under them. See docs/groups.md.
//!
//! The maker of a group is an owner. An owner can do everything, including name another owner.
//! Only an owner can do that. The picture and the banner are the owner's too: no role carries
//! them. A custom role is a name, a colour and a set of the powers below. It cannot grant
//! owner, it cannot touch an owner, and it reaches only the powers its holder has: whoever
//! makes, changes, deletes, gives or takes a role must hold every power on it. A role is
//! known by a uuid postgres made (schema.sql, docs/ids.md), so a rename is a save like any
//! other, and a page holds a role open while its name changes under it.

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, JsonRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Me;
use crate::chat::clean_text;
use crate::groups::{self, BOT_GROUP};
use crate::s3;
use crate::{ApiError, ApiResult, AppState};

/// Edit the about line, the colour, public or private, and the member order. Not the pictures: those are the owner's.
pub(crate) const APPEARANCE: i32 = 1;
/// Make, edit, delete and hand out custom roles. Not owner.
pub(crate) const ROLES: i32 = 2;
/// Add a channel, rename one, and delete one that is not the home channel (`general`).
pub(crate) const CHANNELS: i32 = 4;
/// Remove a member who is not an owner.
pub(crate) const KICK: i32 = 8;
/// The same, and they cannot join again until the ban is lifted.
pub(crate) const BAN: i32 = 16;
/// In a voice channel: server mute, deafen, disconnect, and move someone to another voice channel.
pub(crate) const VOICE: i32 = 32;

const ALL: i32 = APPEARANCE | ROLES | CHANNELS | KICK | BAN | VOICE;
const MAX_ROLES: i64 = 20;
const MAX_ICON: usize = 256 * 1024;
/// The banner is 2560x640, the room's width on a sharp screen; a photo at that size needs the room.
const MAX_BANNER: usize = 1024 * 1024;
const JPEG: [u8; 3] = [0xFF, 0xD8, 0xFF];

struct Held {
    owner: bool,
    perms: i32,
}

fn bits_of(appearance: bool, roles: bool, channels: bool, kick: bool, ban: bool, voice: bool) -> i32 {
    let mut bits = 0;
    if appearance {
        bits |= APPEARANCE;
    }
    if roles {
        bits |= ROLES;
    }
    if channels {
        bits |= CHANNELS;
    }
    if kick {
        bits |= KICK;
    }
    if ban {
        bits |= BAN;
    }
    if voice {
        bits |= VOICE;
    }
    bits
}

fn perms_json(bits: i32) -> Value {
    json!({
        "appearance": bits & APPEARANCE != 0,
        "roles": bits & ROLES != 0,
        "channels": bits & CHANNELS != 0,
        "kick": bits & KICK != 0,
        "ban": bits & BAN != 0,
        "voice": bits & VOICE != 0,
    })
}

/// What this login may do here. An owner may do all of it. A site admin may do the listed
/// powers too, and still cannot name an owner: that check does not call this.
pub(crate) async fn allows(s: &AppState, user: uuid::Uuid, group: &str, bit: i32) -> Result<bool, sqlx::Error> {
    let held = held(&s.db, user, group).await?;
    let admin = s.admins.iter().any(|a| a.id == user);
    Ok(held.owner || admin || held.perms & bit != 0)
}

async fn held(db: &sqlx::PgPool, user: uuid::Uuid, group: &str) -> Result<Held, sqlx::Error> {
    let owner: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2 AND owner)")
        .bind(user)
        .bind(group)
        .fetch_one(db)
        .await?;
    let perms: i32 = sqlx::query_scalar(
        "SELECT COALESCE(bit_or(r.perms), 0)::int FROM role_members rm
         JOIN roles r ON r.id = rm.role_id
         WHERE rm.user_id = $1 AND r.group_name = $2",
    )
    .bind(user)
    .bind(group)
    .fetch_one(db)
    .await?;
    Ok(Held { owner, perms })
}

async fn is_owner(db: &sqlx::PgPool, user: uuid::Uuid, group: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2 AND owner)")
        .bind(user)
        .bind(group)
        .fetch_one(db)
        .await
}

async fn owner_count(db: &sqlx::PgPool, group: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE group_name = $1 AND owner").bind(group).fetch_one(db).await
}

/// Who is shaping a role, and what they hold. See `shaper`.
struct Shaper {
    owner: bool,
    admin: bool,
    perms: i32,
}

impl Shaper {
    /// Whether a role with these powers is within reach. An owner and a site admin reach every
    /// power. Anyone else reaches the powers they hold: the roles power makes, changes, deletes,
    /// gives and takes roles that carry nothing more than the shaper has, so nobody writes
    /// themselves a power they were not given.
    fn reaches(&self, bits: i32) -> bool {
        self.owner || self.admin || bits & !self.perms == 0
    }
}

/// The login shaping a role: an owner, a site admin, or the roles power. 403 for anyone else.
async fn shaper(s: &AppState, who: uuid::Uuid, group: &str) -> Result<Shaper, ApiError> {
    let held = held(&s.db, who, group).await?;
    let admin = s.admins.iter().any(|a| a.id == who);
    if !(held.owner || admin || held.perms & ROLES != 0) {
        return Err(no_power());
    }
    Ok(Shaper { owner: held.owner, admin, perms: held.perms })
}

fn out_of_reach() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "that role carries a power you don't hold")
}

/// A role cannot touch an owner: only an owner gives one a role, or takes one back.
fn not_an_owner(me: &Shaper, target_is_owner: bool) -> Result<(), ApiError> {
    if target_is_owner && !me.owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "a role can't touch an owner"));
    }
    Ok(())
}

/// A role's powers, by id, in this group. 404 `no such role`.
async fn role_perms(db: &sqlx::PgPool, group: &str, id: uuid::Uuid) -> Result<i32, ApiError> {
    let perms: Option<i32> = sqlx::query_scalar("SELECT perms FROM roles WHERE id = $1 AND group_name = $2").bind(id).bind(group).fetch_optional(db).await?;
    perms.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such role"))
}

/// The picture and the banner are the owner's: no role carries them. A site admin may too,
/// as with everything here but naming an owner.
async fn need_owner(s: &AppState, who: uuid::Uuid, group: &str) -> Result<(), ApiError> {
    if is_owner(&s.db, who, group).await? || s.admins.iter().any(|a| a.id == who) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, "only an owner changes the pictures"))
    }
}

fn login() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn missing() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such group")
}

fn no_power() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "you can't do that here")
}

pub(crate) async fn server(db: &sqlx::PgPool, raw: &str) -> Result<String, ApiError> {
    let name = groups::group_name(raw)?;
    if name == BOT_GROUP {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "bot is not a server"));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&name).fetch_one(db).await?;
    if exists {
        Ok(name)
    } else {
        Err(missing())
    }
}

async fn account(db: &sqlx::PgPool, name: &str) -> Result<uuid::Uuid, ApiError> {
    let id: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NOT NULL")
        .bind(name)
        .fetch_optional(db)
        .await?;
    id.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such account"))
}

async fn member_id(db: &sqlx::PgPool, group: &str, name: &str) -> Result<(uuid::Uuid, bool), ApiError> {
    let row: Option<(uuid::Uuid, bool)> = sqlx::query_as(
        "SELECT m.user_id, m.owner FROM memberships m JOIN streamers s ON s.id = m.user_id
         WHERE m.group_name = $1 AND s.name = $2",
    )
    .bind(group)
    .bind(name)
    .fetch_optional(db)
    .await?;
    row.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "they are not in the group"))
}

/// The member a body names (a role given, an owner named, kick, timeout, ban, a transfer): the
/// name rule, so a 400 `bad name` and not a lookup of whatever was sent.
fn target_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if crate::valid_name(&name) {
        Ok(name)
    } else {
        Err(ApiError::bad_name())
    }
}

fn role_name(raw: &str) -> Result<String, ApiError> {
    let name: String = clean_text(raw).split_whitespace().collect::<Vec<_>>().join(" ");
    let n = name.chars().count();
    if !(1..=32).contains(&n) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "role name: 1 to 32 characters"));
    }
    Ok(name)
}

/// What the group calls its owner role (docs/groups.md): `owner` until an owner renames it.
async fn owner_role_of(db: &sqlx::PgPool, group: &str) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT owner_role FROM groups WHERE name = $1").bind(group).fetch_one(db).await
}

/// A custom role cannot be called what the owner role is: that word is the owners' on the roster.
async fn not_the_owner_role(db: &sqlx::PgPool, group: &str, name: &str) -> Result<(), ApiError> {
    if owner_role_of(db, group).await?.eq_ignore_ascii_case(name) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that name is reserved"));
    }
    Ok(())
}

#[derive(Deserialize, Default)]
struct PermsIn {
    #[serde(default)]
    appearance: bool,
    #[serde(default)]
    roles: bool,
    #[serde(default)]
    channels: bool,
    #[serde(default)]
    kick: bool,
    #[serde(default)]
    ban: bool,
    #[serde(default)]
    voice: bool,
}

impl PermsIn {
    fn bits(&self) -> i32 {
        bits_of(self.appearance, self.roles, self.channels, self.kick, self.ban, self.voice) & ALL
    }
}

#[derive(Deserialize)]
struct RoleIn {
    name: String,
    color: String,
    #[serde(default)]
    perms: PermsIn,
    /// The channels kept to this role (docs/groups.md): its holders see them, whoever else
    /// cannot. Absent: none.
    #[serde(default)]
    channels: Vec<String>,
    /// Seconds its holders wait between lines (docs/groups.md). Absent, or 0: no cooldown.
    #[serde(default)]
    cooldown: i32,
}

/// A role's cooldown is seconds, none to an hour.
const MAX_COOLDOWN_SECS: i32 = 3600;
/// A timeout is seconds, ten to a week.
const MIN_TIMEOUT_SECS: i64 = 10;
const MAX_TIMEOUT_SECS: i64 = 7 * 86400;

fn cooldown_of(raw: i32) -> Result<i32, ApiError> {
    if !(0..=MAX_COOLDOWN_SECS).contains(&raw) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("cooldown: 0 to {MAX_COOLDOWN_SECS} seconds")));
    }
    Ok(raw)
}

#[derive(Deserialize)]
struct ChannelRolesIn {
    /// The roles a channel is kept to, by id. Empty: everyone's.
    roles: Vec<uuid::Uuid>,
}

#[derive(Deserialize)]
struct TimeoutIn {
    name: String,
    seconds: i64,
    /// The moderator's words, a ban's rule (`clean_about`). Absent: none.
    #[serde(default)]
    reason: String,
}

#[derive(Deserialize)]
struct NameIn {
    name: String,
}

#[derive(Deserialize)]
struct BanIn {
    name: String,
    #[serde(default)]
    reason: String,
}

#[derive(Deserialize)]
struct AboutIn {
    #[serde(default)]
    about: String,
}

#[derive(Deserialize)]
struct ColorIn {
    color: String,
}

#[derive(Deserialize)]
struct AccessIn {
    public: bool,
}

#[derive(Deserialize)]
struct OrderIn {
    order: String,
}

/// `name`, `newest`, or `oldest`. Owners stay first either way.
fn member_order(raw: &str) -> Result<&'static str, ApiError> {
    match raw.trim() {
        "newest" => Ok("newest"),
        "oldest" => Ok("oldest"),
        "name" => Ok("name"),
        _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "order is name, newest, or oldest")),
    }
}

pub(crate) fn routes() -> Router<AppState> {
    // no DELETE: there is no remove. a group with a picture keeps one, or changes it for another
    let pictures = Router::new()
        .route("/api/groups/{group}/icon", get(get_icon).put(put_icon))
        .route("/api/groups/{group}/banner", get(get_banner).put(put_banner))
        .layer(DefaultBodyLimit::max(MAX_BANNER));
    Router::new()
        .route("/api/groups/{group}/about", axum::routing::put(put_about))
        .route("/api/groups/{group}/color", axum::routing::put(put_color))
        .route("/api/groups/{group}/access", axum::routing::put(set_access))
        .route("/api/groups/{group}/order", axum::routing::put(set_order))
        .route("/api/groups/{group}/roles", get(list_roles).post(create_role))
        .route("/api/groups/{group}/roles/{id}", axum::routing::put(update_role).delete(delete_role))
        .route("/api/groups/{group}/roles/{id}/members", post(give_role))
        .route("/api/groups/{group}/roles/{id}/members/{name}", axum::routing::delete(take_role))
        .route("/api/groups/{group}/channels/{channel}/roles", axum::routing::put(set_channel_roles))
        .route("/api/groups/{group}/owners", post(grant_owner))
        .route("/api/groups/{group}/owners/{name}", axum::routing::delete(revoke_owner))
        .route("/api/groups/{group}/owner-role", axum::routing::put(rename_owner_role))
        .route("/api/groups/{group}/transfer", post(transfer_ownership))
        .route("/api/groups/{group}/members", get(list_members))
        .route("/api/groups/{group}/members/{name}", get(one_member))
        .route("/api/groups/{group}/members/{name}/messages", get(member_messages))
        .route("/api/groups/{group}/channels/{channel}/messages/{id}", axum::routing::delete(delete_message))
        .route("/api/groups/{group}/kick", post(kick))
        .route("/api/groups/{group}/timeout", post(timeout))
        .route("/api/groups/{group}/timeout/{name}", axum::routing::delete(lift_timeout))
        .route("/api/groups/{group}/timeouts", get(list_timeouts))
        .route("/api/groups/{group}/ban", post(ban))
        .route("/api/groups/{group}/bans", get(list_bans))
        .route("/api/groups/{group}/bans/{name}", axum::routing::delete(unban))
        .merge(pictures)
}

/// `GET /api/groups/:group`: the whole room in one answer. The group, its roles, what the
/// login may do, its channels, who in it is live, who is in which voice channel, the roster (anyone's on a public group; a
/// member's or a site admin's on a private one), and (for the ban power) the bans. `roster`,
/// `holders` (who holds each role) and `bans` are null for someone who may not see them. `?roster=<n>` cuts the roster to its
/// first page, `roster_next` the cursor for `GET .../members?after=`. The page loads this once and then
/// follows the `group` facts on the events socket (docs/groups.md); nothing here is asked
/// again on a channel change.
pub(crate) async fn room(State(s): State<AppState>, Path(group): Path<String>, Query(q): Query<RoomQuery>, Me(me): Me) -> ApiResult {
    let group = server(&s.db, &group).await?;
    let user = me.as_ref().map(|a| a.id);
    #[allow(clippy::type_complexity)]
    let row: (String, String, String, i64, Option<i64>, Option<i64>, bool, Option<String>, Option<i32>, String, String) = sqlx::query_as(
        "SELECT g.badge, g.color, g.about,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                (EXTRACT(EPOCH FROM g.icon_at))::bigint,
                (EXTRACT(EPOCH FROM g.banner_at))::bigint,
                g.public, g.title, g.tag, g.member_order, g.owner_role
         FROM groups g WHERE g.name = $1",
    )
    .bind(&group)
    .fetch_one(&s.db)
    .await?;
    let (badge, color, about, members, icon, banner, public, title, tag, member_order, owner_role) = row;
    let mine = match user {
        Some(id) => groups::member(&s.db, id, &group).await?,
        None => false,
    };
    let held = match user {
        Some(id) => held(&s.db, id, &group).await?,
        None => Held { owner: false, perms: 0 },
    };
    let admin = user.is_some_and(|id| s.admins.iter().any(|a| a.id == id));
    let powers = if held.owner { ALL } else { held.perms | if admin { ALL } else { 0 } };
    let roles = roles_of(&s.db, &group).await?;
    let channels = groups::channels_of(&s, &group, user, admin).await?;
    let live = groups::live_in(&s, &group).await?;
    // the channels this login has muted (docs/notifications.md): its own, so the list can say so
    let muted = groups::muted_in(&s.db, user, &group).await?;
    // the lines pinned in each channel this login sees, by id (pins.rs): the header's count and the lines' marks
    let seen = groups::visible_channels(&s.db, &group, user, admin).await?;
    let pins = crate::pins::pinned_ids(&s.db, &group, &seen).await?;
    // who is in voice, in the channels this login sees (voice.rs). An extra and not the room: redis down reads as nobody
    let voice = voice_in(&s, &group, &seen).await;
    // the roster is anyone's on a public group (the lines say who talks there anyway), and a member's or a
    // site admin's on a private one, whose people chose not to be listed; the bans are the ban power's. null otherwise
    // `?roster=` asks for its first page alone (`limit`, as `GET .../members` reads it), and
    // `roster_next` is where the next one starts: null when the roster came whole
    let first = page_of(q.roster, None, None)?;
    // `holders` is the roster's too: who holds which role, the whole group's
    let (roster, roster_next, holders) = if public || mine || admin {
        let (list, next) = members_of(&s.db, &group, &member_order, first.as_ref()).await?;
        (Some(list), next, Some(holders_of(&s.db, &group).await?))
    } else {
        (None, None, None)
    };
    let bans = if powers & BAN != 0 { Some(bans_of(&s.db, &group).await?) } else { None };
    Ok(Json(json!({
        "name": group,
        "badge": badge,
        "color": color,
        "about": about,
        "members": members,
        "mine": mine,
        "owner": held.owner,
        "owner_role": owner_role,
        "admin": admin,
        "public": public,
        "title": title,
        "tag": tag,
        "member_order": member_order,
        "icon": icon,
        "banner": banner,
        "perms": perms_json(powers),
        "roles": roles,
        "channels": channels,
        "muted": muted,
        "pins": pins,
        "live": live,
        "voice": voice,
        "roster": roster,
        "roster_next": roster_next,
        "holders": holders,
        "bans": bans,
    })))
}

/// Who is in voice: `{"<channel>": [{name, uid, since}]}` from `voice:<server>` (voice.rs),
/// each channel in order of who came first. Only the channels in `seen`, so a hidden channel's
/// people stay hidden with it. `{}` when redis cannot be asked: the room still opens, and the
/// `voice` and `voice_left` facts fill it in from there.
async fn voice_in(s: &AppState, group: &str, seen: &[String]) -> Value {
    let fields: Result<(std::collections::HashMap<String, String>, std::collections::HashSet<String>), redis::RedisError> = redis::pipe()
        .cmd("HGETALL")
        .arg(format!("voice:{group}"))
        .cmd("SMEMBERS")
        .arg(crate::voice::muted_key(group))
        .query_async(&mut s.redis.clone())
        .await;
    match fields {
        Ok((fields, muted)) => seated_by_channel(&fields, seen, &muted),
        Err(e) => {
            log::warn!("voice in {group}: {e}");
            json!({})
        }
    }
}

/// The fields of `voice:<server>` (user id to `{name, channel, since, ...}`) as the room's
/// `voice`. A field that does not read, or sits in a channel not in `seen`, is left out. Someone
/// in `muted` (a moderator's mute, voice.rs `server_mute`) says `muted: true`.
fn seated_by_channel(fields: &std::collections::HashMap<String, String>, seen: &[String], muted: &std::collections::HashSet<String>) -> Value {
    let mut by: std::collections::BTreeMap<&str, Vec<(i64, &str, String)>> = std::collections::BTreeMap::new();
    for (uid, raw) in fields {
        let Ok(v) = serde_json::from_str::<Value>(raw) else { continue };
        let (Some(channel), Some(name), Some(since)) = (v["channel"].as_str(), v["name"].as_str(), v["since"].as_i64()) else {
            continue;
        };
        let Some(channel) = seen.iter().find(|c| *c == channel) else { continue };
        by.entry(channel).or_default().push((since, uid, name.to_string()));
    }
    let mut out = serde_json::Map::new();
    for (channel, mut people) in by {
        people.sort();
        let list = people
            .into_iter()
            .map(|(since, uid, name)| {
                let mut one = json!({ "name": name, "uid": uid, "since": since });
                if muted.contains(uid) {
                    one["muted"] = json!(true);
                }
                one
            })
            .collect();
        out.insert(channel.to_string(), Value::Array(list));
    }
    Value::Object(out)
}

async fn need(s: &AppState, who: uuid::Uuid, group: &str, bit: i32) -> Result<(), ApiError> {
    if allows(s, who, group, bit).await? {
        Ok(())
    } else {
        Err(no_power())
    }
}

async fn set_access(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<AccessIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, APPEARANCE).await?;
    sqlx::query("UPDATE groups SET public = $2 WHERE name = $1").bind(&group).bind(body.public).execute(&s.db).await?;
    groups::tell(&s, &group, "access", json!({ "public": body.public })).await;
    Ok(Json(json!({ "public": body.public })))
}

/// `PUT /api/groups/:group/order` `{order}`: how the member list sorts after the owners. Appearance.
async fn set_order(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<OrderIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, APPEARANCE).await?;
    let order = member_order(&body.order)?;
    sqlx::query("UPDATE groups SET member_order = $2 WHERE name = $1").bind(&group).bind(order).execute(&s.db).await?;
    groups::tell(&s, &group, "order", json!({ "order": order })).await;
    Ok(Json(json!({ "order": order })))
}

async fn put_about(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<AboutIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, APPEARANCE).await?;
    let about = groups::clean_about(&body.about);
    sqlx::query("UPDATE groups SET about = $2 WHERE name = $1").bind(&group).bind(&about).execute(&s.db).await?;
    groups::tell(&s, &group, "about", json!({ "about": about })).await;
    Ok(Json(json!({ "about": about })))
}

/// `PUT /api/groups/:group/color` `{color}`: the group's colour, `#rrggbb` as the create form
/// takes it (`groups::clean_color`). Appearance, like the about line. The `color` fact repaints
/// the room, and the lists the page has, at once.
async fn put_color(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<ColorIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, APPEARANCE).await?;
    let color = groups::clean_color(&body.color)?;
    sqlx::query("UPDATE groups SET color = $2 WHERE name = $1").bind(&group).bind(&color).execute(&s.db).await?;
    groups::tell(&s, &group, "color", json!({ "color": color })).await;
    Ok(Json(json!({ "color": color })))
}

/// One role as the room, the list and the `role` fact say it. `channels` is the ones kept to it,
/// `cooldown` the seconds its holders wait between lines (0: none).
fn role_json(id: uuid::Uuid, name: &str, color: &str, perms: i32, channels: &[String], cooldown: i32) -> Value {
    json!({ "id": id, "name": name, "color": color, "perms": perms_json(perms), "channels": channels, "cooldown": cooldown })
}

/// The group's roles, oldest first: the id is a uuid and says nothing about the order. Each
/// with the channels kept to it, by name, and its cooldown.
async fn roles_of(db: &sqlx::PgPool, group: &str) -> Result<Vec<Value>, sqlx::Error> {
    let roles: Vec<(uuid::Uuid, String, String, i32, Vec<String>, i32)> = sqlx::query_as(
        "SELECT r.id, r.name, r.color, r.perms,
                COALESCE((SELECT array_agg(cr.channel ORDER BY cr.channel) FROM channel_roles cr WHERE cr.role_id = r.id), '{}'),
                r.cooldown
         FROM roles r WHERE r.group_name = $1 ORDER BY r.created_at, r.name",
    )
    .bind(group)
    .fetch_all(db)
    .await?;
    Ok(roles.into_iter().map(|(id, name, color, perms, channels, cooldown)| role_json(id, &name, &color, perms, &channels, cooldown)).collect())
}

/// Who holds each role, by the name they have now: `{"<role id>": [name, …]}`, a role nobody
/// holds left out. The whole group's, not a roster page's, so a line's speaker past the pages
/// loaded so far still wears their role's colour in the chat (docs/groups.md).
async fn holders_of(db: &sqlx::PgPool, group: &str) -> Result<Value, sqlx::Error> {
    let rows: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT rm.role_id, s.name FROM role_members rm
         JOIN roles r ON r.id = rm.role_id
         JOIN streamers s ON s.id = rm.user_id
         WHERE r.group_name = $1 ORDER BY s.name",
    )
    .bind(group)
    .fetch_all(db)
    .await?;
    let mut holders: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for (id, name) in rows {
        holders.entry(id.to_string()).or_default().push(name);
    }
    Ok(json!(holders))
}

/// The channels a role's body names, cleaned, as the shaper may put them: each a channel of the
/// group the shaper sees (`groups::may_see`; a hidden one and a missing one are both `no such
/// channel`, so the roles power cannot unlock for itself what it cannot see), never the home
/// channel (`general` until renamed: everyone's), each once. Sorted, as `roles_of` lists them.
async fn kept_channels(s: &AppState, group: &str, me: &Shaper, who: uuid::Uuid, raw: &[String]) -> Result<Vec<String>, ApiError> {
    let mut channels: Vec<String> = Vec::with_capacity(raw.len());
    for name in raw {
        let name = name.trim().to_lowercase();
        if groups::is_home(&s.db, group, &name).await? {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("#{name} is everyone's")));
        }
        if channels.contains(&name) {
            continue;
        }
        if !groups::may_see(&s.db, group, &name, Some(who), me.admin).await? {
            return Err(ApiError::new(StatusCode::NOT_FOUND, format!("no such channel: {name}")));
        }
        channels.push(name);
    }
    channels.sort();
    Ok(channels)
}

/// The channels kept to a role, replaced by `channels` as far as the shaper sees: a channel kept
/// to the role that the shaper cannot see stays kept, since the body could not have named it.
/// → the role's channels as they stand after. Within the caller's transaction.
async fn keep_channels(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    group: &str,
    id: uuid::Uuid,
    who: uuid::Uuid,
    admin: bool,
    channels: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let seen = format!("DELETE FROM channel_roles cr0 WHERE cr0.role_id = $1 AND EXISTS (SELECT 1 FROM channels c WHERE c.server = cr0.server AND c.name = cr0.channel AND {})", groups::sees_sql("$2", "$3"));
    sqlx::query(&seen).bind(id).bind(who).bind(admin).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO channel_roles (server, channel, role_id) SELECT $1, unnest($2::text[]), $3 ON CONFLICT DO NOTHING")
        .bind(group)
        .bind(channels)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query_scalar("SELECT channel FROM channel_roles WHERE role_id = $1 ORDER BY channel").bind(id).fetch_all(&mut **tx).await
}

async fn list_roles(State(s): State<AppState>, Path(group): Path<String>) -> ApiResult {
    let group = server(&s.db, &group).await?;
    Ok(Json(Value::Array(roles_of(&s.db, &group).await?)))
}

async fn create_role(
    State(s): State<AppState>,
    Path(group): Path<String>,
    Me(me): Me,
    body: Result<Json<RoleIn>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    let me = shaper(&s, who.id, &group).await?;
    let name = role_name(&body.name)?;
    not_the_owner_role(&s.db, &group, &name).await?;
    let color = groups::clean_color(&body.color)?;
    let perms = body.perms.bits();
    let cooldown = cooldown_of(body.cooldown)?;
    if !me.reaches(perms) {
        return Err(out_of_reach());
    }
    let channels = kept_channels(&s, &group, &me, who.id, &body.channels).await?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM roles WHERE group_name = $1 AND lower(name) = lower($2))")
        .bind(&group)
        .bind(&name)
        .fetch_one(&s.db)
        .await?;
    if taken {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE group_name = $1").bind(&group).fetch_one(&s.db).await?;
    if n >= MAX_ROLES {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("this group has {MAX_ROLES} roles already")));
    }
    // the id is postgres's (gen_random_uuid, the column's default), read back here
    let mut tx = s.db.begin().await?;
    let id: Option<uuid::Uuid> = sqlx::query_scalar(
        "INSERT INTO roles (group_name, name, color, perms, cooldown) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id",
    )
    .bind(&group)
    .bind(&name)
    .bind(&color)
    .bind(perms)
    .bind(cooldown)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    };
    let channels = keep_channels(&mut tx, &group, id, who.id, me.admin, &channels).await?;
    tx.commit().await?;
    log::info!("{}: role {name} in {group}", who.name);
    let role = role_json(id, &name, &color, perms, &channels, cooldown);
    groups::tell(&s, &group, "role", json!({ "role": role })).await;
    Ok((StatusCode::CREATED, Json(role)))
}

/// `PUT /api/groups/:group/roles/:id`: the role replaced whole, name included: a rename is
/// this, since the id is what the role is known by. The same reach as making it. `channels`
/// replaces the channels kept to the role, as far as the shaper sees them (`keep_channels`).
async fn update_role(
    State(s): State<AppState>,
    Path((group, id)): Path<(String, uuid::Uuid)>,
    Me(me): Me,
    body: Result<Json<RoleIn>, JsonRejection>,
) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    let me = shaper(&s, who.id, &group).await?;
    let name = role_name(&body.name)?;
    not_the_owner_role(&s.db, &group, &name).await?;
    let color = groups::clean_color(&body.color)?;
    let perms = body.perms.bits();
    let cooldown = cooldown_of(body.cooldown)?;
    // the role as it is, and as it would be: both within reach
    if !me.reaches(role_perms(&s.db, &group, id).await?) || !me.reaches(perms) {
        return Err(out_of_reach());
    }
    let channels = kept_channels(&s, &group, &me, who.id, &body.channels).await?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM roles WHERE group_name = $1 AND lower(name) = lower($2) AND id <> $3)")
        .bind(&group)
        .bind(&name)
        .bind(id)
        .fetch_one(&s.db)
        .await?;
    if taken {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    let mut tx = s.db.begin().await?;
    let done = sqlx::query("UPDATE roles SET name = $3, color = $4, perms = $5, cooldown = $6 WHERE id = $1 AND group_name = $2")
        .bind(id)
        .bind(&group)
        .bind(&name)
        .bind(&color)
        .bind(perms)
        .bind(cooldown)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such role"));
    }
    let channels = keep_channels(&mut tx, &group, id, who.id, me.admin, &channels).await?;
    tx.commit().await?;
    let role = role_json(id, &name, &color, perms, &channels, cooldown);
    groups::tell(&s, &group, "role", json!({ "role": role })).await;
    Ok(Json(role))
}

async fn delete_role(State(s): State<AppState>, Path((group, id)): Path<(String, uuid::Uuid)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    let me = shaper(&s, who.id, &group).await?;
    if !me.reaches(role_perms(&s.db, &group, id).await?) {
        return Err(out_of_reach());
    }
    let done = sqlx::query("DELETE FROM roles WHERE id = $1 AND group_name = $2").bind(id).bind(&group).execute(&s.db).await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such role"));
    }
    log::info!("{}: removed a role from {group}", who.name);
    groups::tell(&s, &group, "unrole", json!({ "id": id })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// The roles in one list and not the other: the ones a channel's save keeps it to, or lets go.
fn changed_roles(was: &[uuid::Uuid], now: &[uuid::Uuid]) -> Vec<uuid::Uuid> {
    let mut changed: Vec<uuid::Uuid> = was.iter().filter(|id| !now.contains(id)).chain(now.iter().filter(|id| !was.contains(id))).copied().collect();
    changed.sort();
    changed.dedup();
    changed
}

/// `PUT /api/groups/:group/channels/:channel/roles` `{ roles: [id, …] }`: who sees the channel
/// (docs/groups.md), from the channel's side. The channel is kept to exactly these roles, in
/// one transaction; an empty list is everyone's (no `channel_roles` rows). The channels power,
/// and a member. Each role kept or let go must be within the caller's reach, as with a role's
/// own save: nobody hands a channel to, or takes one from, a role carrying a power they do not
/// hold. → `{ channel, roles }`, and a `role` fact for each role whose channels changed, so an
/// open room asks again who sees what. 400 for the home channel (everyone's), 404 for no such channel
/// or a role not of this group, 403 without the power or out of reach.
async fn set_channel_roles(
    State(s): State<AppState>,
    Path((group, channel)): Path<(String, String)>,
    Me(me): Me,
    body: Result<Json<ChannelRolesIn>, JsonRejection>,
) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let (group, channel) = groups::channel_names(&group, &channel)?;
    let group = server(&s.db, &group).await?;
    if groups::is_home(&s.db, &group, &channel).await? {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("#{channel} is everyone's")));
    }
    if !groups::member(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the server first"));
    }
    let held = held(&s.db, who.id, &group).await?;
    let admin = s.admins.iter().any(|a| a.id == who.id);
    if !(held.owner || admin || held.perms & CHANNELS != 0) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you can't say who sees a channel"));
    }
    let me = Shaper { owner: held.owner, admin, perms: held.perms };
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM channels WHERE server = $1 AND name = $2)")
        .bind(&group)
        .bind(&channel)
        .fetch_one(&s.db)
        .await?;
    if !exists {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    let mut roles = body.roles;
    roles.sort();
    roles.dedup();
    let mut tx = s.db.begin().await?;
    let known: Vec<(uuid::Uuid, i32)> = sqlx::query_as("SELECT id, perms FROM roles WHERE group_name = $1 AND id = ANY($2)")
        .bind(&group)
        .bind(&roles)
        .fetch_all(&mut *tx)
        .await?;
    if known.len() != roles.len() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such role"));
    }
    let was: Vec<(uuid::Uuid, i32)> = sqlx::query_as(
        "SELECT cr.role_id, r.perms FROM channel_roles cr JOIN roles r ON r.id = cr.role_id WHERE cr.server = $1 AND cr.channel = $2",
    )
    .bind(&group)
    .bind(&channel)
    .fetch_all(&mut *tx)
    .await?;
    let changed = changed_roles(&was.iter().map(|(id, _)| *id).collect::<Vec<_>>(), &roles);
    // every role kept or let go, as it is: within reach
    let reach = known.iter().chain(was.iter()).filter(|(id, _)| changed.contains(id)).all(|(_, perms)| me.reaches(*perms));
    if !reach {
        return Err(out_of_reach());
    }
    sqlx::query("DELETE FROM channel_roles WHERE server = $1 AND channel = $2").bind(&group).bind(&channel).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO channel_roles (server, channel, role_id) SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING")
        .bind(&group)
        .bind(&channel)
        .bind(&roles)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    log::info!("{}: #{channel} in {group} is kept to {} role(s)", who.name, roles.len());
    if !changed.is_empty() {
        // each changed role whole, as the role save says it: the rooms open ask again who sees what
        for role in roles_of(&s.db, &group).await? {
            if role["id"].as_str().and_then(|id| id.parse::<uuid::Uuid>().ok()).is_some_and(|id| changed.contains(&id)) {
                groups::tell(&s, &group, "role", json!({ "role": role })).await;
            }
        }
    }
    Ok(Json(json!({ "channel": channel, "roles": roles })))
}

async fn give_role(
    State(s): State<AppState>,
    Path((group, id)): Path<(String, uuid::Uuid)>,
    Me(me): Me,
    body: Result<Json<NameIn>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    let me = shaper(&s, who.id, &group).await?;
    let name = target_name(&body.name)?;
    let (user, owner) = member_id(&s.db, &group, &name).await?;
    not_an_owner(&me, owner)?;
    let role: Option<(String, String, i32)> =
        sqlx::query_as("SELECT name, color, perms FROM roles WHERE id = $1 AND group_name = $2").bind(id).bind(&group).fetch_optional(&s.db).await?;
    let Some((role_name, color, perms)) = role else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such role"));
    };
    if !me.reaches(perms) {
        return Err(out_of_reach());
    }
    let given = sqlx::query("INSERT INTO role_members (role_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(id).bind(user).execute(&s.db).await?;
    if given.rows_affected() > 0 {
        groups::tell(&s, &group, "held", json!({ "who": name, "role": { "id": id, "name": role_name, "color": color } })).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn take_role(State(s): State<AppState>, Path((group, id, name)): Path<(String, uuid::Uuid, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    let me = shaper(&s, who.id, &group).await?;
    let name = name.trim().to_lowercase();
    let (user, owner) = member_id(&s.db, &group, &name).await?;
    not_an_owner(&me, owner)?;
    if !me.reaches(role_perms(&s.db, &group, id).await?) {
        return Err(out_of_reach());
    }
    let taken = sqlx::query("DELETE FROM role_members WHERE role_id = $1 AND user_id = $2").bind(id).bind(user).execute(&s.db).await?;
    if taken.rows_affected() > 0 {
        groups::tell(&s, &group, "unheld", json!({ "who": name, "id": id })).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn grant_owner(
    State(s): State<AppState>,
    Path(group): Path<String>,
    Me(me): Me,
    body: Result<Json<NameIn>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    if !is_owner(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only an owner can name another owner"));
    }
    let name = target_name(&body.name)?;
    let (user, already) = member_id(&s.db, &group, &name).await?;
    if already {
        return Ok(StatusCode::NO_CONTENT);
    }
    // the cap on owning counts this too: one who owns as many as it allows is not named an owner of another
    if groups::groups_owned(&s.db, user).await? >= s.groups_per_owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("{name} owns {}", groups::owned_cap_words(s.groups_per_owner))));
    }
    sqlx::query("UPDATE memberships SET owner = true WHERE user_id = $1 AND group_name = $2").bind(user).bind(&group).execute(&s.db).await?;
    log::info!("{}: named {name} an owner of {group}", who.name);
    groups::tell(&s, &group, "owner", json!({ "who": name, "owner": true })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/groups/:group/transfer` `{ name }`: the group is `name`'s from now on, and not
/// this login's (docs/groups.md): they are made an owner and the caller stops being one, in one
/// transaction, so the group has an owner throughout. An owner, for a member who is not one
/// (an owner already is 409), not themselves (400); the cap on owning counts for them as it
/// does for a naming. Two `owner` facts, theirs then the caller's. 204. The caller keeps their
/// roles and stays in the group; the members tab asks before this.
async fn transfer_ownership(
    State(s): State<AppState>,
    Path(group): Path<String>,
    Me(me): Me,
    body: Result<Json<NameIn>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    if !is_owner(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only an owner hands the group on"));
    }
    let name = target_name(&body.name)?;
    if name == who.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that is you"));
    }
    let (user, already) = member_id(&s.db, &group, &name).await?;
    if already {
        return Err(ApiError::new(StatusCode::CONFLICT, format!("{name} is an owner already")));
    }
    if groups::groups_owned(&s.db, user).await? >= s.groups_per_owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("{name} owns {}", groups::owned_cap_words(s.groups_per_owner))));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("UPDATE memberships SET owner = true WHERE user_id = $1 AND group_name = $2").bind(user).bind(&group).execute(&mut *tx).await?;
    sqlx::query("UPDATE memberships SET owner = false WHERE user_id = $1 AND group_name = $2").bind(who.id).bind(&group).execute(&mut *tx).await?;
    tx.commit().await?;
    log::info!("{}: handed {group} on to {name}", who.name);
    groups::tell(&s, &group, "owner", json!({ "who": name, "owner": true })).await;
    groups::tell(&s, &group, "owner", json!({ "who": who.name, "owner": false })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/groups/:group/owner-role` `{ name }`: what the owner role is called from now on
/// (docs/groups.md): the word on the roster's crown and the roles tab's first row. An owner
/// (or a site admin). A role's name rule; not a custom role's name (409). → `{ name }`, and an
/// `owner_role` fact to every room open. Owning itself is untouched: the owners stay the owners.
async fn rename_owner_role(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<NameIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    if !is_owner(&s.db, who.id, &group).await? && !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only an owner names the owner role"));
    }
    let name = role_name(&body.name)?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM roles WHERE group_name = $1 AND lower(name) = lower($2))")
        .bind(&group)
        .bind(&name)
        .fetch_one(&s.db)
        .await?;
    if taken {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    sqlx::query("UPDATE groups SET owner_role = $2 WHERE name = $1").bind(&group).bind(&name).execute(&s.db).await?;
    log::info!("{}: the owner role of {group} is {name}", who.name);
    groups::tell(&s, &group, "owner_role", json!({ "name": name })).await;
    Ok(Json(json!({ "name": name })))
}

async fn revoke_owner(State(s): State<AppState>, Path((group, name)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    if !is_owner(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only an owner can name another owner"));
    }
    let name = name.trim().to_lowercase();
    let (user, owner) = member_id(&s.db, &group, &name).await?;
    if !owner {
        return Ok(StatusCode::NO_CONTENT);
    }
    if owner_count(&s.db, &group).await? <= 1 {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "a group keeps one owner"));
    }
    sqlx::query("UPDATE memberships SET owner = false WHERE user_id = $1 AND group_name = $2").bind(user).bind(&group).execute(&s.db).await?;
    log::info!("{}: {name} is no longer an owner of {group}", who.name);
    groups::tell(&s, &group, "owner", json!({ "who": name, "owner": false })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// The most of the roster one page carries (`GET .../members?limit=`, the room's `?roster=`).
const MEMBERS_PAGE_MAX: i64 = 100;
/// A page's size when `limit` is left out but `after` or `q` asks for a page.
const MEMBERS_PAGE_DEFAULT: i64 = 50;

/// One page of the roster: at most `limit`, after the row `after` names (`Cursor`), and with
/// `q`, only the members whose name, or a role they hold, has it in it.
struct Page {
    limit: i64,
    after: Option<Cursor>,
    q: Option<String>,
}

/// Where a page left off: the last row's sort key (owner, when they joined in microseconds,
/// name), so the next page goes on from there however many joined or left in between. Written
/// `<0|1>.<micros>.<name>`; the page hands it out as `next`, opaque to the client.
struct Cursor {
    owner: bool,
    joined: i64,
    name: String,
}

impl Cursor {
    fn text(&self) -> String {
        format!("{}.{}.{}", u8::from(self.owner), self.joined, self.name)
    }

    fn read(raw: &str) -> Result<Cursor, ApiError> {
        let bad = || ApiError::new(StatusCode::BAD_REQUEST, "bad cursor");
        let mut parts = raw.splitn(3, '.');
        let owner = match parts.next() {
            Some("1") => true,
            Some("0") => false,
            _ => return Err(bad()),
        };
        let joined = parts.next().and_then(|j| j.parse::<i64>().ok()).ok_or_else(bad)?;
        let name = parts.next().filter(|n| !n.is_empty()).ok_or_else(bad)?.to_owned();
        Ok(Cursor { owner, joined, name })
    }
}

#[derive(Deserialize)]
pub(crate) struct RoomQuery {
    roster: Option<i64>,
}

#[derive(Deserialize)]
struct MembersQuery {
    limit: Option<i64>,
    after: Option<String>,
    q: Option<String>,
}

/// A page's `limit`, `after` and `q` read; none of them is the whole roster (`None`), the
/// answer from before there were pages. `limit` is held to 1..=MEMBERS_PAGE_MAX. `q` is the
/// room's search box (history.rs `SEARCH_CHARS`): 400 past that, or with a control character
/// (postgres refuses a \0).
fn page_of(limit: Option<i64>, after: Option<&str>, q: Option<&str>) -> Result<Option<Page>, ApiError> {
    let q = q.map(str::trim).filter(|w| !w.is_empty()).map(str::to_lowercase);
    if let Some(q) = &q {
        if q.chars().count() > crate::history::SEARCH_CHARS {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("search: {} characters at most", crate::history::SEARCH_CHARS)));
        }
        if q.chars().any(char::is_control) {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad search"));
        }
    }
    if limit.is_none() && after.is_none() && q.is_none() {
        return Ok(None);
    }
    let after = after.map(Cursor::read).transpose()?;
    Ok(Some(Page { limit: limit.unwrap_or(MEMBERS_PAGE_DEFAULT).clamp(1, MEMBERS_PAGE_MAX), after, q }))
}

/// The words as a `LIKE` pattern that means them: a `%` or `_` typed is not a wildcard.
fn like_pattern(words: &str) -> String {
    let mut out = String::from("%");
    for c in words.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The roster: every member with their picture, when they joined (unix seconds, so a room
/// keeps the order right as people come and go), whether they own the group, and the roles
/// they hold. Owners first, then `order` (`name`, `newest`, `oldest`), the name breaking a tie.
/// With a `page`, that page alone and the cursor of the one after it (`None` at the end);
/// without, all of it and `None`.
async fn members_of(db: &sqlx::PgPool, group: &str, order: &str, page: Option<&Page>) -> Result<(Vec<Value>, Option<String>), sqlx::Error> {
    members_where(db, group, order, page, None).await
}

/// `members_of`, or with `only`, that one member's row alone (none when they are not in it).
async fn members_where(db: &sqlx::PgPool, group: &str, order: &str, page: Option<&Page>, only: Option<&str>) -> Result<(Vec<Value>, Option<String>), sqlx::Error> {
    let after = page.and_then(|p| p.after.as_ref());
    // `timeout`: unix seconds until a timeout that is still running ends, else null. `j`: when
    // they joined in microseconds, the key a cursor carries (seconds would tie)
    #[allow(clippy::type_complexity)]
    let mut rows: Vec<(String, bool, Option<i64>, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT name, owner, avatar, joined, timeout, j FROM (
             SELECT s.name, m.owner, (EXTRACT(EPOCH FROM s.avatar_at))::bigint AS avatar, (EXTRACT(EPOCH FROM m.joined_at))::bigint AS joined,
                    (SELECT (EXTRACT(EPOCH FROM t.until))::bigint FROM timeouts t WHERE t.group_name = m.group_name AND t.user_id = m.user_id AND t.until > now()) AS timeout,
                    (EXTRACT(EPOCH FROM m.joined_at) * 1000000)::bigint AS j
             FROM memberships m JOIN streamers s ON s.id = m.user_id
             WHERE m.group_name = $1
               AND ($9::text IS NULL OR s.name = $9)
               AND ($7::text IS NULL OR s.name ILIKE $7 OR EXISTS (
                    SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                    WHERE rm.user_id = m.user_id AND r.group_name = m.group_name AND r.name ILIKE $7))
         ) x
         WHERE NOT $3 OR owner < $4 OR (owner = $4 AND CASE
                   WHEN $2 = 'newest' THEN j < $5 OR (j = $5 AND name > $6)
                   WHEN $2 = 'oldest' THEN j > $5 OR (j = $5 AND name > $6)
                   ELSE name > $6 END)
         ORDER BY owner DESC,
                  CASE WHEN $2 = 'newest' THEN j END DESC,
                  CASE WHEN $2 = 'oldest' THEN j END ASC,
                  name
         LIMIT $8",
    )
    .bind(group)
    .bind(order)
    .bind(after.is_some())
    .bind(after.is_some_and(|c| c.owner))
    .bind(after.map_or(0, |c| c.joined))
    .bind(after.map_or("", |c| c.name.as_str()))
    .bind(page.and_then(|p| p.q.as_deref()).map(like_pattern))
    // one past the page says whether there is another
    .bind(page.map_or(i64::MAX, |p| p.limit + 1))
    .bind(only)
    .fetch_all(db)
    .await?;
    let next = match page {
        Some(p) if rows.len() as i64 > p.limit => {
            rows.truncate(p.limit as usize);
            rows.last().map(|(name, owner, _, _, _, j)| Cursor { owner: *owner, joined: *j, name: name.clone() }.text())
        }
        _ => None,
    };
    let names: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let roles: Vec<(String, uuid::Uuid, String, String)> = sqlx::query_as(
        "SELECT s.name, r.id, r.name, r.color FROM role_members rm
         JOIN roles r ON r.id = rm.role_id
         JOIN streamers s ON s.id = rm.user_id
         WHERE r.group_name = $1 AND s.name = ANY($2) ORDER BY r.created_at, r.name",
    )
    .bind(group)
    .bind(&names)
    .fetch_all(db)
    .await?;
    let out = rows.into_iter().map(|(name, owner, avatar, joined, timeout, _)| {
        let mine: Vec<Value> = roles
            .iter()
            .filter(|(n, _, _, _)| n == &name)
            .map(|(_, id, role, color)| json!({ "id": id, "name": role, "color": color }))
            .collect();
        json!({ "name": name, "owner": owner, "avatar": avatar, "joined": joined, "roles": mine, "timeout": timeout })
    });
    Ok((out.collect(), next))
}

/// `GET /api/groups/:group/members`: the roster on its own, the room's rule: anyone's on a
/// public group; on a private one a member's or a site admin's (401 for nobody, 403 otherwise).
/// Bare, the whole roster as an array, as before there were pages. With `limit` (1..=100; 50
/// when only `after` or `q` is given), `after` (the page before's `next`) or `q` (words in a
/// member's name or a role they hold), one page: `{ members, next }`, `next` null at the end.
/// 400 `bad cursor`.
async fn list_members(State(s): State<AppState>, Path(group): Path<String>, Query(q): Query<MembersQuery>, Me(me): Me) -> ApiResult {
    let group = server(&s.db, &group).await?;
    let page = page_of(q.limit, q.after.as_deref(), q.q.as_deref())?;
    let (public, order): (bool, String) = sqlx::query_as("SELECT public, member_order FROM groups WHERE name = $1").bind(&group).fetch_one(&s.db).await?;
    if !public {
        let who = me.ok_or_else(login)?;
        if !groups::member(&s.db, who.id, &group).await? && !s.admins.iter().any(|a| a.id == who.id) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "join the group first"));
        }
    }
    let (members, next) = members_of(&s.db, &group, &order, page.as_ref()).await?;
    Ok(Json(match page {
        Some(_) => json!({ "members": members, "next": next }),
        None => Value::Array(members),
    }))
}

pub(crate) async fn drop_roles(db: &sqlx::PgPool, group: &str, user: uuid::Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM role_members WHERE user_id = $1 AND role_id IN (SELECT id FROM roles WHERE group_name = $2)")
        .bind(user)
        .bind(group)
        .execute(db)
        .await?;
    Ok(())
}

async fn kick(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<NameIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, KICK).await?;
    let name = target_name(&body.name)?;
    if name == who.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "leave, instead of kicking yourself"));
    }
    let (user, owner) = member_id(&s.db, &group, &name).await?;
    if owner && !is_owner(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "an owner stays"));
    }
    if owner && owner_count(&s.db, &group).await? <= 1 {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "a group keeps one owner"));
    }
    drop_roles(&s.db, &group, user).await?;
    sqlx::query("DELETE FROM memberships WHERE user_id = $1 AND group_name = $2").bind(user).bind(&group).execute(&s.db).await?;
    let members = groups::member_count(&s.db, &group).await?;
    groups::tell(&s, &group, "left", json!({ "who": name, "by": "kick", "members": members })).await;
    crate::voice::drop_from_voice(&s, &group, user).await;
    groups::delete_if_empty(&s, &group).await?;
    log::info!("{}: kicked {name} from {group}", who.name);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/groups/:group/timeout` `{ name, seconds, reason? }`: no line of `name`'s in the group's
/// channels for that long (docs/groups.md): the chat refuses them with `timed out` and the wait.
/// The kick power; a member (404), not yourself (400), an owner only by an owner (403); ten
/// seconds to a week (400). Set again, the new end stands. A row of its own (`timeouts`), so
/// leaving and joining again does not end it; the expired rows of the group are swept here.
/// `reason` is kept with it, a ban's rule. They are out of voice too, and kept out until it ends
/// (voice.rs). A `timeout` fact carries `until`, unix seconds. 204.
async fn timeout(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<TimeoutIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, KICK).await?;
    let name = target_name(&body.name)?;
    if name == who.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "you can't time yourself out"));
    }
    if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&body.seconds) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("time out: {MIN_TIMEOUT_SECS} seconds to a week")));
    }
    let (user, owner) = member_id(&s.db, &group, &name).await?;
    if owner && !is_owner(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "an owner is not timed out by a role"));
    }
    let reason = groups::clean_about(&body.reason);
    sqlx::query("DELETE FROM timeouts WHERE group_name = $1 AND until < now()").bind(&group).execute(&s.db).await?;
    let until: i64 = sqlx::query_scalar(
        "INSERT INTO timeouts (group_name, user_id, until, by_id, reason) VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)
         ON CONFLICT (group_name, user_id) DO UPDATE SET until = EXCLUDED.until, by_id = EXCLUDED.by_id, reason = EXCLUDED.reason
         RETURNING (EXTRACT(EPOCH FROM until))::bigint",
    )
    .bind(&group)
    .bind(user)
    .bind(body.seconds as f64)
    .bind(who.id)
    .bind(&reason)
    .fetch_one(&s.db)
    .await?;
    log::info!("{}: timed {name} out of {group} for {}s", who.name, body.seconds);
    groups::tell(&s, &group, "timeout", json!({ "who": name, "until": until })).await;
    // out of voice too, and `may_talk` keeps them out until it ends (voice.rs)
    crate::voice::drop_from_voice(&s, &group, user).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/groups/:group/timeout/:name`: the timeout lifted, early. The kick power. 204,
/// also when there was none; the name needs an account (404), not a membership, since a timeout
/// outlives a leave. A `timeout` fact with `until` null.
async fn lift_timeout(State(s): State<AppState>, Path((group, name)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, KICK).await?;
    let name = name.trim().to_lowercase();
    let user = account(&s.db, &name).await?;
    let lifted = sqlx::query("DELETE FROM timeouts WHERE group_name = $1 AND user_id = $2").bind(&group).bind(user).execute(&s.db).await?;
    if lifted.rows_affected() > 0 {
        log::info!("{}: lifted the timeout on {name} in {group}", who.name);
        groups::tell(&s, &group, "timeout", json!({ "who": name, "until": Value::Null })).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/groups/:group/timeouts`: every timeout still running, the soonest to end first:
/// `[{ name, avatar, until, reason, by, member }]`. `until` is unix seconds; `by` is null when
/// whoever set it is gone; `member` is false for one who left while timed out, since it
/// outlives a leave. The kick power, the one that sets and lifts them, as the bans list is the
/// ban power's.
async fn list_timeouts(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, KICK).await?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, Option<i64>, i64, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT s.name, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, (EXTRACT(EPOCH FROM t.until))::bigint, t.reason, b.name,
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = t.group_name AND m.user_id = t.user_id)
         FROM timeouts t JOIN streamers s ON s.id = t.user_id LEFT JOIN streamers b ON b.id = t.by_id
         WHERE t.group_name = $1 AND t.until > now()
         ORDER BY t.until, s.name",
    )
    .bind(&group)
    .fetch_all(&s.db)
    .await?;
    let out = rows.into_iter().map(|(name, avatar, until, reason, by, member)| {
        json!({ "name": name, "avatar": avatar, "until": until, "reason": reason, "by": by, "member": member })
    });
    Ok(Json(Value::Array(out.collect())))
}

async fn ban(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<BanIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, BAN).await?;
    let name = target_name(&body.name)?;
    if name == who.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "you can't ban yourself"));
    }
    let user = account(&s.db, &name).await?;
    let owner = is_owner(&s.db, user, &group).await?;
    if owner && !is_owner(&s.db, who.id, &group).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "an owner stays"));
    }
    if owner && owner_count(&s.db, &group).await? <= 1 {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "a group keeps one owner"));
    }
    let reason = groups::clean_about(&body.reason);
    drop_roles(&s.db, &group, user).await?;
    sqlx::query("DELETE FROM memberships WHERE user_id = $1 AND group_name = $2").bind(user).bind(&group).execute(&s.db).await?;
    sqlx::query(
        "INSERT INTO bans (group_name, user_id, by_id, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_name, user_id) DO UPDATE SET by_id = $3, reason = $4, banned_at = now()",
    )
    .bind(&group)
    .bind(user)
    .bind(who.id)
    .bind(&reason)
    .execute(&s.db)
    .await?;
    let members = groups::member_count(&s.db, &group).await?;
    groups::tell(&s, &group, "banned", json!({ "who": name, "reason": reason, "members": members })).await;
    crate::voice::drop_from_voice(&s, &group, user).await;
    groups::delete_if_empty(&s, &group).await?;
    log::info!("{}: banned {name} from {group}", who.name);
    Ok(StatusCode::NO_CONTENT)
}

/// Who is banned, newest ban first, with the reason given.
async fn bans_of(db: &sqlx::PgPool, group: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT s.name, b.reason FROM bans b JOIN streamers s ON s.id = b.user_id WHERE b.group_name = $1 ORDER BY b.banned_at DESC",
    )
    .bind(group)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(name, reason)| json!({ "name": name, "reason": reason })).collect())
}

async fn list_bans(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, BAN).await?;
    Ok(Json(Value::Array(bans_of(&s.db, &group).await?)))
}

async fn unban(State(s): State<AppState>, Path((group, name)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, BAN).await?;
    let name = name.trim().to_lowercase();
    let user = account(&s.db, &name).await?;
    let lifted = sqlx::query("DELETE FROM bans WHERE group_name = $1 AND user_id = $2").bind(&group).bind(user).execute(&s.db).await?;
    if lifted.rows_affected() > 0 {
        groups::tell(&s, &group, "unbanned", json!({ "who": name })).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// True when this account is banned from the group. Join asks.
pub(crate) async fn banned(db: &sqlx::PgPool, user: uuid::Uuid, group: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM bans WHERE group_name = $1 AND user_id = $2)").bind(group).bind(user).fetch_one(db).await
}

// ---- moderating a member: one member, their lines, a line deleted ------------------------------

/// The powers that moderate a member: kick (and with it a timeout, a line's delete, a voice
/// mute and a disconnect) and ban. A member's lines (`member_messages`) are for either.
pub(crate) const MODERATE: i32 = KICK | BAN;
/// Moderation actions one login may take a minute here, on top of the route's tier (ratelimit.rs
/// `MODERATE`): the jannies' number (janny.rs), so a hijacked login cannot wipe a channel.
const ACTIONS_PER_MINUTE: i64 = 30;
/// The most of a member's lines one page carries.
const LOG_PAGE_MAX: i64 = 50;
/// How far back redis is read for a member's lines: a room's stream keeps its last 500 (chat.rs).
const LOG_REDIS_SCAN: usize = 500;

/// Whether `actor` may act on `target` (kick, timeout, ban, a line's delete, a voice mute or
/// disconnect): never on themselves, and on an owner only as an owner. The rule kick, timeout and
/// ban have always had; a custom role has no rank above another's.
pub(crate) fn may_touch(actor: uuid::Uuid, actor_owner: bool, target: uuid::Uuid, target_owner: bool) -> bool {
    actor != target && (!target_owner || actor_owner)
}

/// Whether `actor` may delete a line by `author` (None: no account behind it). Their own always;
/// anyone else's with the kick power (`moderates`), an owner's only as an owner (`may_touch`).
fn may_delete(actor: uuid::Uuid, actor_owner: bool, moderates: bool, author: Option<uuid::Uuid>, author_owner: bool) -> bool {
    match author {
        Some(a) if a == actor => true,
        Some(a) => moderates && may_touch(actor, actor_owner, a, author_owner),
        None => moderates,
    }
}

async fn paced(s: &AppState, who: uuid::Uuid) -> Result<(), ApiError> {
    crate::auth::limit(s, &format!("rl:groupmod:{who}"), 60, ACTIONS_PER_MINUTE, "slow down: too many moderation actions").await
}

/// The member a moderation names, for `who` with any power of `bits`: 403 without, 400 for
/// themselves, 404 for no member, 403 for an owner unless `who` is one. Paced. → (id, name).
pub(crate) async fn moderated(s: &AppState, who: &crate::auth::Account, group: &str, bits: i32, raw: &str) -> Result<(uuid::Uuid, String), ApiError> {
    need(s, who.id, group, bits).await?;
    let name = target_name(raw)?;
    if name == who.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not yourself"));
    }
    let (user, owner) = member_id(&s.db, group, &name).await?;
    if !may_touch(who.id, is_owner(&s.db, who.id, group).await?, user, owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "an owner stays"));
    }
    paced(s, who.id).await?;
    Ok((user, name))
}

/// The roster's rule (`list_members`): anyone on a public group, a member or a site admin on a private one.
async fn sees_roster(s: &AppState, group: &str, me: Option<&crate::auth::Account>) -> Result<(), ApiError> {
    let public: bool = sqlx::query_scalar("SELECT public FROM groups WHERE name = $1").bind(group).fetch_one(&s.db).await?;
    if public {
        return Ok(());
    }
    let who = me.ok_or_else(login)?;
    if !groups::member(&s.db, who.id, group).await? && !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the group first"));
    }
    Ok(())
}

/// `GET /api/groups/:group/members/:name`: one member as the roster has them (name, owner,
/// avatar, joined, roles, timeout), for the member info modal: the roster's pages may not have
/// reached them yet. The roster's rule. 404 `they are not in the group`.
async fn one_member(State(s): State<AppState>, Path((group, name)): Path<(String, String)>, Me(me): Me) -> ApiResult {
    let group = server(&s.db, &group).await?;
    sees_roster(&s, &group, me.as_ref()).await?;
    let name = target_name(&name)?;
    let (rows, _) = members_where(&s.db, &group, "name", None, Some(&name)).await?;
    rows.into_iter().next().map(Json).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "they are not in the group"))
}

#[derive(Deserialize)]
struct LogQuery {
    before: Option<String>,
    limit: Option<i64>,
}

/// Where a member's log left off: its last line's id and channel, `<ms>-<seq>.<channel>` (an id
/// has no dot, so the first one splits them). The lines go newest first by (ms, seq, channel).
#[derive(Debug, PartialEq)]
struct LogCursor {
    ms: u64,
    seq: u64,
    channel: String,
}

impl LogCursor {
    fn text(&self) -> String {
        format!("{}-{}.{}", self.ms, self.seq, self.channel)
    }

    fn read(raw: &str) -> Result<LogCursor, ApiError> {
        let bad = || ApiError::new(StatusCode::BAD_REQUEST, "bad cursor");
        let (id, channel) = raw.split_once('.').ok_or_else(bad)?;
        crate::history::stream_id(id).map_err(|_| bad())?;
        if channel.is_empty() {
            return Err(bad());
        }
        let (ms, seq) = crate::socket::id_parts(id);
        Ok(LogCursor { ms, seq, channel: channel.to_owned() })
    }

    /// The order key: a line comes after the cursor in the log when its key is below this one's.
    fn key(&self) -> (u64, u64, &str) {
        (self.ms, self.seq, self.channel.as_str())
    }
}

/// The log's order key of a line in `channel`: (ms, seq, channel), compared the other way round.
fn log_key<'a>(line: &crate::chat::Line, channel: &'a str) -> (u64, u64, &'a str) {
    let (ms, seq) = crate::socket::id_parts(&line.id);
    (ms, seq, channel)
}

/// The two sides of a member's lines into one page: by (room, id) once, newest first, `limit`
/// at most, the rest saying where the next page starts. `room` is `server/channel` on the way
/// in; the channel alone on the way out.
fn merge_log(server: &str, found: Vec<(String, crate::chat::Line)>, limit: usize) -> (Vec<(String, crate::chat::Line)>, Option<String>) {
    let prefix = format!("{server}/");
    let mut seen = std::collections::HashSet::new();
    let mut lines: Vec<(String, crate::chat::Line)> = found
        .into_iter()
        .filter_map(|(room, line)| room.strip_prefix(&prefix).map(|c| (c.to_owned(), line)))
        .filter(|(channel, line)| seen.insert((channel.clone(), line.id.clone())))
        .collect();
    lines.sort_by(|(a_ch, a), (b_ch, b)| log_key(b, b_ch).cmp(&log_key(a, a_ch)));
    let next = if lines.len() > limit {
        lines.truncate(limit);
        lines.last().map(|(channel, line)| {
            let (ms, seq) = crate::socket::id_parts(&line.id);
            LogCursor { ms, seq, channel: channel.clone() }.text()
        })
    } else {
        None
    };
    (lines, next)
}

/// `GET /api/groups/:group/members/:name/messages?before=&limit=`: one account's lines in this
/// group, newest first (docs/groups.md), for the member info modal: in the text channels the
/// caller sees, each with its `channel`, and with what it answered (`reply`) as it was said.
/// The kick or ban power (an owner, a site admin). A past member's lines too: the name needs an
/// account, not a membership. `limit` 1..=50 (50 left out); `before` the page before's `next`,
/// null at the end. Kept rows and the redis tail together, so a line not yet kept (or a chat
/// that keeps none) is there too. 401, 403, 404 `no such account`, 400 `bad cursor`.
async fn member_messages(State(s): State<AppState>, Path((group, name)): Path<(String, String)>, Query(q): Query<LogQuery>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, MODERATE).await?;
    let user = account(&s.db, &target_name(&name)?).await?;
    let limit = q.limit.unwrap_or(LOG_PAGE_MAX).clamp(1, LOG_PAGE_MAX);
    let before = q.before.as_deref().map(LogCursor::read).transpose()?;
    let admin = s.admins.iter().any(|a| a.id == who.id);
    let channels = groups::visible_text_channels(&s.db, &group, Some(who.id), admin).await?;
    let rooms: Vec<String> = channels.iter().map(|c| format!("{group}/{c}")).collect();
    let before_room = before.as_ref().map(|c| format!("{group}/{}", c.channel));
    let pg_before = before.as_ref().zip(before_room.as_deref()).map(|(c, room)| (c.ms as i64, c.seq as i64, room));
    let mut found = crate::history::by_account(&s.db, &rooms, user, pg_before, limit + 1).await?;
    // the redis tail of every channel: a line said a moment ago may not be kept yet, and a chat
    // without CHAT_PERSIST keeps nothing
    let mut pipe = redis::pipe();
    for room in &rooms {
        pipe.cmd("XREVRANGE").arg(crate::chat::room_key(room)).arg("+").arg("-").arg("COUNT").arg(LOG_REDIS_SCAN);
    }
    let tails: Vec<redis::streams::StreamRangeReply> = pipe.query_async(&mut s.redis.clone()).await?;
    for ((room, channel), tail) in rooms.iter().zip(&channels).zip(tails) {
        for line in tail.ids.into_iter().filter_map(crate::chat::line_from) {
            if line.user_id != Some(user) || !line.verified {
                continue;
            }
            if before.as_ref().is_some_and(|c| log_key(&line, channel) >= c.key()) {
                continue;
            }
            found.push((room.clone(), line));
        }
    }
    let (mut lines, next) = merge_log(&group, found, limit as usize);
    crate::chat::with_faces(&s.db, lines.iter_mut().map(|(_, line)| line)).await;
    let out: Vec<Value> = lines
        .into_iter()
        .map(|(channel, line)| {
            let mut v = json!(line);
            v["channel"] = json!(channel);
            v
        })
        .collect();
    Ok(Json(json!({ "lines": out, "next": next })))
}

/// `DELETE /api/groups/:group/channels/:channel/messages/:id`: the line goes, from redis and
/// postgres with its reactions (chat.rs `remove_line`), and off the channel's pins. Its author
/// may delete it; anyone else's takes the kick power (an owner, a site admin), and an owner's
/// line an owner. Every room open hears it on the chat socket (`delete`, with the channel) and
/// drops it. 204. 401, 404 `no such channel` (or one the caller does not see), 400 `bad id`,
/// 404 `no such line`, 403.
async fn delete_message(State(s): State<AppState>, Path((group, channel, id)): Path<(String, String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let (group, channel) = groups::channel_names(&group, &channel)?;
    let group = server(&s.db, &group).await?;
    let admin = s.admins.iter().any(|a| a.id == who.id);
    if !groups::may_see_text(&s.db, &group, &channel, Some(who.id), admin).await? {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    let id = crate::history::stream_id(&id)?;
    let room = format!("{group}/{channel}");
    let mut r = s.redis.clone();
    let Some(line) = crate::history::line_at(&s.db, &mut r, &room, &id).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, crate::chat::NO_SUCH_LINE));
    };
    let author = line.user_id.filter(|_| line.verified);
    let author_owner = match author {
        Some(a) => is_owner(&s.db, a, &group).await?,
        None => false,
    };
    let actor_owner = is_owner(&s.db, who.id, &group).await?;
    let moderates = allows(&s, who.id, &group, KICK).await?;
    if !may_delete(who.id, actor_owner, moderates, author, author_owner) {
        return Err(no_power());
    }
    paced(&s, who.id).await?;
    let unpinned = sqlx::query("DELETE FROM channel_pins WHERE server = $1 AND channel = $2 AND message_id = $3")
        .bind(&group)
        .bind(&channel)
        .bind(&id)
        .execute(&s.db)
        .await?;
    crate::chat::remove_line(&s.db, &mut r, &room, &id).await?;
    if unpinned.rows_affected() > 0 {
        groups::tell(&s, &group, "unpin", json!({ "channel": channel, "id": id })).await;
    }
    log::info!("{}: deleted {}'s line {id} in #{channel} of {group}", who.name, line.from);
    Ok(StatusCode::NO_CONTENT)
}

fn icon_key(group: &str) -> String {
    format!("groups/{group}/icon.jpg")
}

fn banner_key(group: &str) -> String {
    format!("groups/{group}/banner.jpg")
}

fn jpeg_in(body: Result<Bytes, BytesRejection>, max: usize) -> Result<Bytes, ApiError> {
    let body = match body {
        Ok(body) => body,
        Err(BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_))) => {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big"));
        }
        Err(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad body")),
    };
    if body.len() > max {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture too big"));
    }
    if !body.starts_with(&JPEG) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a jpeg"));
    }
    Ok(body)
}

fn jpeg_out(bytes: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "public, max-age=86400")], bytes).into_response()
}

async fn read_picture(s: &AppState, group: &str, key: &str, column: &str) -> Result<Response, ApiError> {
    let group = server(&s.db, group).await?;
    let set: bool = sqlx::query_scalar(&format!("SELECT {column} IS NOT NULL FROM groups WHERE name = $1")).bind(&group).fetch_one(&s.db).await?;
    if !set {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no picture"));
    }
    match s3::get(&s.s3, key).await {
        Ok(Some(bytes)) => Ok(jpeg_out(bytes)),
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, "no picture")),
        Err(e) => {
            log::error!("s3 group picture {group}: {e}");
            Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not load the picture"))
        }
    }
}

async fn write_picture(s: &AppState, who: crate::auth::Account, group: &str, key: &str, column: &str, body: Bytes) -> Result<i64, ApiError> {
    if let Err(e) = s3::put(&s.s3, key, &body, "image/jpeg").await {
        log::error!("s3 group picture {group}: {e}");
        return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not save the picture"));
    }
    let version: i64 = sqlx::query_scalar(&format!("UPDATE groups SET {column} = now() WHERE name = $1 RETURNING (EXTRACT(EPOCH FROM {column}))::bigint"))
        .bind(group)
        .fetch_one(&s.db)
        .await?;
    log::info!("{}: new {column} for {group}, {} bytes", who.name, body.len());
    Ok(version)
}

async fn get_icon(State(s): State<AppState>, Path(group): Path<String>) -> Result<Response, ApiError> {
    let group = server(&s.db, &group).await?;
    read_picture(&s, &group, &icon_key(&group), "icon_at").await
}

/// `PUT /api/groups/:group/icon`: a jpeg, from an owner. The new version goes out as `icon`.
async fn put_icon(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need_owner(&s, who.id, &group).await?;
    let body = jpeg_in(body, MAX_ICON)?;
    let version = write_picture(&s, who, &group, &icon_key(&group), "icon_at", body).await?;
    groups::tell(&s, &group, "icon", json!({ "icon": version })).await;
    Ok(Json(json!({ "icon": version })))
}

async fn get_banner(State(s): State<AppState>, Path(group): Path<String>) -> Result<Response, ApiError> {
    let group = server(&s.db, &group).await?;
    read_picture(&s, &group, &banner_key(&group), "banner_at").await
}

/// `PUT /api/groups/:group/banner`: the same, 1 mb, as `banner`.
async fn put_banner(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need_owner(&s, who.id, &group).await?;
    let body = jpeg_in(body, MAX_BANNER)?;
    let version = write_picture(&s, who, &group, &banner_key(&group), "banner_at", body).await?;
    groups::tell(&s, &group, "banner", json!({ "banner": version })).await;
    Ok(Json(json!({ "banner": version })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_reads_back_what_it_wrote() {
        let c = Cursor { owner: true, joined: 1_763_500_000_123_456, name: "a.b".to_owned() };
        let back = Cursor::read(&c.text()).unwrap();
        assert!(back.owner);
        assert_eq!(back.joined, 1_763_500_000_123_456);
        // the name is the rest, dots and all
        assert_eq!(back.name, "a.b");
        for bad in ["", "2.1.x", "1.x.x", "1.5", "1.5.", "0..x"] {
            assert!(Cursor::read(bad).is_err(), "{bad:?} read as a cursor");
        }
    }

    #[test]
    fn a_page_is_asked_for_by_any_of_its_words() {
        assert!(page_of(None, None, None).unwrap().is_none(), "bare is the whole roster");
        assert!(page_of(None, None, Some("  ")).unwrap().is_none(), "blank words ask nothing");
        assert_eq!(page_of(Some(0), None, None).unwrap().unwrap().limit, 1);
        assert_eq!(page_of(Some(10_000), None, None).unwrap().unwrap().limit, MEMBERS_PAGE_MAX);
        let q = page_of(None, None, Some(" Mod ")).unwrap().unwrap();
        assert_eq!((q.limit, q.q.as_deref()), (MEMBERS_PAGE_DEFAULT, Some("mod")));
        assert!(page_of(Some(5), Some("nope"), None).is_err());
    }

    #[test]
    fn a_roster_search_has_the_boxs_cap_and_no_control_characters() {
        let cap = crate::history::SEARCH_CHARS;
        assert!(page_of(None, None, Some(&"é".repeat(cap))).is_ok());
        let long = page_of(None, None, Some(&"x".repeat(cap + 1))).err().unwrap();
        assert_eq!((long.0, long.1.as_str()), (StatusCode::BAD_REQUEST, "search: 200 characters at most"));
        assert_eq!(page_of(None, None, Some("a\u{0}b")).err().unwrap().1, "bad search");
    }

    #[test]
    fn a_member_named_in_a_body_follows_the_name_rule() {
        assert_eq!(target_name("  Alice_1 ").unwrap(), "alice_1");
        for bad in ["", "   ", "al ice", "alice!", "a\u{0}", &"a".repeat(33)] {
            let e = target_name(bad).unwrap_err();
            assert_eq!(e.0, StatusCode::BAD_REQUEST, "{bad:?}");
        }
    }

    #[test]
    fn like_means_the_words() {
        assert_eq!(like_pattern("bob"), "%bob%");
        assert_eq!(like_pattern("50%_\\"), "%50\\%\\_\\\\%");
    }

    #[test]
    fn powers_pack() {
        assert_eq!(bits_of(true, false, true, false, false, false), APPEARANCE | CHANNELS);
        assert_eq!(bits_of(false, false, false, false, false, true), VOICE);
        assert_eq!(PermsIn { kick: true, ban: true, ..PermsIn::default() }.bits(), KICK | BAN);
        assert_eq!(perms_json(ROLES)["roles"], json!(true));
        assert_eq!(perms_json(ROLES)["kick"], json!(false));
        assert_eq!(perms_json(ROLES)["voice"], json!(false));
    }

    #[test]
    fn voice_goes_round() {
        let back = |bits: i32| {
            let p: PermsIn = serde_json::from_value(perms_json(bits)).unwrap();
            p.bits()
        };
        assert_eq!(back(VOICE), VOICE);
        assert_eq!(back(VOICE | KICK), VOICE | KICK);
        assert_eq!(back(ALL), ALL);
        assert_eq!(perms_json(VOICE)["voice"], json!(true));
        assert_eq!(perms_json(VOICE)["ban"], json!(false));
        // an older client that never heard of voice gives none
        let old: PermsIn = serde_json::from_value(json!({ "kick": true })).unwrap();
        assert_eq!(old.bits(), KICK);
    }

    #[test]
    fn voice_shows_only_the_seen_channels() {
        let mut fields = std::collections::HashMap::new();
        let seat = |name: &str, channel: &str, since: i64| {
            json!({ "name": name, "channel": channel, "seat": 0, "since": since, "beat": since, "session": 1 }).to_string()
        };
        fields.insert("u1".to_string(), seat("bo", "lounge", 20));
        fields.insert("u2".to_string(), seat("al", "lounge", 10));
        fields.insert("u3".to_string(), seat("cy", "secret", 5));
        fields.insert("u4".to_string(), "not json".to_string());
        let seen = vec!["general".to_string(), "lounge".to_string()];
        let none = std::collections::HashSet::new();
        assert_eq!(
            seated_by_channel(&fields, &seen, &none),
            json!({ "lounge": [{ "name": "al", "uid": "u2", "since": 10 }, { "name": "bo", "uid": "u1", "since": 20 }] })
        );
        assert_eq!(seated_by_channel(&fields, &[], &none), json!({}));
        // a moderator's mute shows on their seat, and only theirs
        let muted: std::collections::HashSet<String> = ["u1".to_string(), "u3".to_string()].into();
        assert_eq!(
            seated_by_channel(&fields, &seen, &muted),
            json!({ "lounge": [{ "name": "al", "uid": "u2", "since": 10 }, { "name": "bo", "uid": "u1", "since": 20, "muted": true }] })
        );
    }

    #[test]
    fn a_role_reaches_what_its_shaper_holds() {
        let shaper = Shaper { owner: false, admin: false, perms: ROLES | KICK };
        assert!(shaper.reaches(0));
        assert!(shaper.reaches(ROLES));
        assert!(shaper.reaches(ROLES | KICK));
        assert!(!shaper.reaches(BAN));
        assert!(!shaper.reaches(VOICE));
        assert!(!shaper.reaches(ROLES | KICK | APPEARANCE));
        assert!(Shaper { owner: true, admin: false, perms: 0 }.reaches(ALL));
        assert!(Shaper { owner: false, admin: true, perms: 0 }.reaches(ALL));
    }

    #[test]
    fn nobody_acts_on_themselves_and_only_an_owner_on_an_owner() {
        let [me, them] = [uuid::Uuid::from_u128(1), uuid::Uuid::from_u128(2)];
        assert!(may_touch(me, false, them, false));
        assert!(!may_touch(me, false, me, false), "not yourself");
        assert!(!may_touch(me, true, me, true), "not even an owner on themselves");
        assert!(!may_touch(me, false, them, true), "a role does not touch an owner");
        assert!(may_touch(me, true, them, true), "an owner may another owner");
    }

    #[test]
    fn a_line_is_its_authors_to_delete_and_the_kick_powers() {
        let [me, them] = [uuid::Uuid::from_u128(1), uuid::Uuid::from_u128(2)];
        // my own, with no power at all
        assert!(may_delete(me, false, false, Some(me), false));
        // someone else's needs the power
        assert!(!may_delete(me, false, false, Some(them), false));
        assert!(may_delete(me, false, true, Some(them), false));
        // an owner's line is an owner's to delete
        assert!(!may_delete(me, false, true, Some(them), true));
        assert!(may_delete(me, true, true, Some(them), true));
        // a line with no account behind it: the power
        assert!(!may_delete(me, false, false, None, false));
        assert!(may_delete(me, false, true, None, false));
    }

    #[test]
    fn the_moderation_powers_are_kick_and_ban() {
        assert_eq!(MODERATE, KICK | BAN);
        assert_eq!(MODERATE & (APPEARANCE | ROLES | CHANNELS | VOICE), 0);
    }

    #[test]
    fn a_log_cursor_reads_back_what_it_wrote() {
        let c = LogCursor { ms: 1_729_000_000_123, seq: 4, channel: "general".to_owned() };
        assert_eq!(c.text(), "1729000000123-4.general");
        assert_eq!(LogCursor::read(&c.text()).unwrap(), c);
        for bad in ["", "1-0", "1-0.", "x-0.general", "1.general", "1-0-0.general", ".general"] {
            let e = LogCursor::read(bad).unwrap_err();
            assert_eq!((e.0, e.1.as_str()), (StatusCode::BAD_REQUEST, "bad cursor"), "{bad:?}");
        }
    }

    fn line(id: &str, text: &str) -> crate::chat::Line {
        serde_json::from_value(json!({
            "id": id, "from": "al", "text": text, "streamer": false, "verified": true, "groups": [],
            "avatar": null, "oauth_verified": false, "at": 0
        }))
        .unwrap()
    }

    #[test]
    fn a_members_log_is_newest_first_once_each_and_paged() {
        let found = vec![
            ("g/general".to_owned(), line("100-0", "a")),
            ("g/clips".to_owned(), line("300-0", "b")),
            // the same line from redis and from postgres: once
            ("g/clips".to_owned(), line("300-0", "b")),
            // the same id in another channel is another line
            ("g/general".to_owned(), line("300-0", "c")),
            ("g/general".to_owned(), line("200-1", "d")),
            // not this group's
            ("other/general".to_owned(), line("900-0", "e")),
        ];
        let (page, next) = merge_log("g", found.clone(), 3);
        let got: Vec<(&str, &str)> = page.iter().map(|(c, l)| (c.as_str(), l.text.as_str())).collect();
        // (ms, seq, channel) down: general sorts after clips at the same id
        assert_eq!(got, vec![("general", "c"), ("clips", "b"), ("general", "d")]);
        assert_eq!(next.as_deref(), Some("200-1.general"));
        let after = LogCursor::read(next.as_deref().unwrap()).unwrap();
        // what comes after the cursor is what the next page holds
        let rest: Vec<&str> = found.iter().filter(|(room, l)| room.starts_with("g/") && log_key(l, &room[2..]) < after.key()).map(|(_, l)| l.text.as_str()).collect();
        assert_eq!(rest, vec!["a"]);
        let (whole, end) = merge_log("g", found, 50);
        assert_eq!(whole.len(), 4);
        assert_eq!(end, None, "the last page says there is no next");
    }

    #[test]
    fn a_channel_save_touches_the_roles_kept_or_let_go() {
        let [a, b, c] = [uuid::Uuid::from_u128(1), uuid::Uuid::from_u128(2), uuid::Uuid::from_u128(3)];
        assert_eq!(changed_roles(&[a, b], &[b, c]), vec![a, c]);
        assert_eq!(changed_roles(&[a], &[a]), Vec::<uuid::Uuid>::new());
        assert_eq!(changed_roles(&[], &[c, a]), vec![a, c]);
        assert_eq!(changed_roles(&[b], &[]), vec![b]);
    }
}
