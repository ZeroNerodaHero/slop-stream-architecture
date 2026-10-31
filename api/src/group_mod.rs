//! An owner's powers, and the custom roles under them. See docs/groups.md.
//!
//! The maker of a group is an owner. An owner can do everything, including name another owner.
//! Only an owner can do that. The picture and the banner are the owner's too: no role carries
//! them. A custom role is a name, a colour and a set of the powers below. It cannot grant
//! owner, it cannot touch an owner, and it reaches only the powers its holder has: whoever
//! makes, changes, deletes, gives or takes a role must hold every power on it. A role is
//! known by a uuid postgres made (migrate-23, docs/ids.md), so a rename is a save like any
//! other, and a page holds a role open while its name changes under it.

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, JsonRejection};
use axum::extract::{DefaultBodyLimit, Path, State};
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

/// Edit the about line, public or private, and the member order. Not the pictures: those are the owner's.
pub(crate) const APPEARANCE: i32 = 1;
/// Make, edit, delete and hand out custom roles. Not owner.
pub(crate) const ROLES: i32 = 2;
/// Add a channel, and delete one that is not `general`.
pub(crate) const CHANNELS: i32 = 4;
/// Remove a member who is not an owner.
pub(crate) const KICK: i32 = 8;
/// The same, and they cannot join again until the ban is lifted.
pub(crate) const BAN: i32 = 16;

const ALL: i32 = APPEARANCE | ROLES | CHANNELS | KICK | BAN;
const MAX_ROLES: i64 = 20;
const MAX_ICON: usize = 256 * 1024;
/// The banner is 2560x640, the room's width on a sharp screen; a photo at that size needs the room.
const MAX_BANNER: usize = 1024 * 1024;
const JPEG: [u8; 3] = [0xFF, 0xD8, 0xFF];

struct Held {
    owner: bool,
    perms: i32,
}

fn bits_of(appearance: bool, roles: bool, channels: bool, kick: bool, ban: bool) -> i32 {
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
    bits
}

fn perms_json(bits: i32) -> Value {
    json!({
        "appearance": bits & APPEARANCE != 0,
        "roles": bits & ROLES != 0,
        "channels": bits & CHANNELS != 0,
        "kick": bits & KICK != 0,
        "ban": bits & BAN != 0,
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

async fn server(db: &sqlx::PgPool, raw: &str) -> Result<String, ApiError> {
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
}

impl PermsIn {
    fn bits(&self) -> i32 {
        bits_of(self.appearance, self.roles, self.channels, self.kick, self.ban) & ALL
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
struct TimeoutIn {
    name: String,
    seconds: i64,
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
        .route("/api/groups/{group}/access", axum::routing::put(set_access))
        .route("/api/groups/{group}/order", axum::routing::put(set_order))
        .route("/api/groups/{group}/roles", get(list_roles).post(create_role))
        .route("/api/groups/{group}/roles/{id}", axum::routing::put(update_role).delete(delete_role))
        .route("/api/groups/{group}/roles/{id}/members", post(give_role))
        .route("/api/groups/{group}/roles/{id}/members/{name}", axum::routing::delete(take_role))
        .route("/api/groups/{group}/owners", post(grant_owner))
        .route("/api/groups/{group}/owners/{name}", axum::routing::delete(revoke_owner))
        .route("/api/groups/{group}/owner-role", axum::routing::put(rename_owner_role))
        .route("/api/groups/{group}/transfer", post(transfer_ownership))
        .route("/api/groups/{group}/members", get(list_members))
        .route("/api/groups/{group}/kick", post(kick))
        .route("/api/groups/{group}/timeout", post(timeout))
        .route("/api/groups/{group}/timeout/{name}", axum::routing::delete(lift_timeout))
        .route("/api/groups/{group}/ban", post(ban))
        .route("/api/groups/{group}/bans", get(list_bans))
        .route("/api/groups/{group}/bans/{name}", axum::routing::delete(unban))
        .merge(pictures)
}

/// `GET /api/groups/:group`: the whole room in one answer. The group, its roles, what the
/// login may do, its channels, who in it is live, and (for a member or a site admin) the
/// roster, and (for the ban power) the bans. `roster` and `bans` are null for someone who
/// may not see them. The page loads this once and then follows the `group` facts on the
/// events socket (docs/groups.md); nothing here is asked again on a channel change.
pub(crate) async fn room(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> ApiResult {
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
    // the roster is for members and site admins, the bans for the ban power: null otherwise
    let roster = if mine || admin { Some(members_of(&s.db, &group, &member_order).await?) } else { None };
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
        "live": live,
        "roster": roster,
        "bans": bans,
    })))
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

/// The channels a role's body names, cleaned, as the shaper may put them: each a channel of the
/// group the shaper sees (`groups::may_see`; a hidden one and a missing one are both `no such
/// channel`, so the roles power cannot unlock for itself what it cannot see), never `general`
/// (everyone's), each once. Sorted, as `roles_of` lists them.
async fn kept_channels(s: &AppState, group: &str, me: &Shaper, who: uuid::Uuid, raw: &[String]) -> Result<Vec<String>, ApiError> {
    let mut channels: Vec<String> = Vec::with_capacity(raw.len());
    for name in raw {
        let name = name.trim().to_lowercase();
        if name == groups::GENERAL {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "general is everyone's"));
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
    let name = body.name.trim().to_lowercase();
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
    let name = body.name.trim().to_lowercase();
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
    let name = body.name.trim().to_lowercase();
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

/// The roster: every member with their picture, when they joined (unix seconds, so a room
/// keeps the order right as people come and go), whether they own the group, and the roles
/// they hold. Owners first, then `order` (`name`, `newest`, `oldest`).
async fn members_of(db: &sqlx::PgPool, group: &str, order: &str) -> Result<Vec<Value>, sqlx::Error> {
    // `timeout`: unix seconds until a timeout that is still running ends, else null
    let rows: Vec<(String, bool, Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT s.name, m.owner, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, (EXTRACT(EPOCH FROM m.joined_at))::bigint,
                (SELECT (EXTRACT(EPOCH FROM t.until))::bigint FROM timeouts t WHERE t.group_name = m.group_name AND t.user_id = m.user_id AND t.until > now())
         FROM memberships m JOIN streamers s ON s.id = m.user_id
         WHERE m.group_name = $1
         ORDER BY m.owner DESC,
                  CASE WHEN $2 = 'newest' THEN m.joined_at END DESC NULLS LAST,
                  CASE WHEN $2 = 'oldest' THEN m.joined_at END ASC NULLS LAST,
                  s.name",
    )
    .bind(group)
    .bind(order)
    .fetch_all(db)
    .await?;
    let roles: Vec<(String, uuid::Uuid, String, String)> = sqlx::query_as(
        "SELECT s.name, r.id, r.name, r.color FROM role_members rm
         JOIN roles r ON r.id = rm.role_id
         JOIN streamers s ON s.id = rm.user_id
         WHERE r.group_name = $1 ORDER BY r.created_at, r.name",
    )
    .bind(group)
    .fetch_all(db)
    .await?;
    let out = rows.into_iter().map(|(name, owner, avatar, joined, timeout)| {
        let mine: Vec<Value> = roles
            .iter()
            .filter(|(n, _, _, _)| n == &name)
            .map(|(_, id, role, color)| json!({ "id": id, "name": role, "color": color }))
            .collect();
        json!({ "name": name, "owner": owner, "avatar": avatar, "joined": joined.unwrap_or(0), "roles": mine, "timeout": timeout })
    });
    Ok(out.collect())
}

async fn list_members(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    if !groups::member(&s.db, who.id, &group).await? && !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the group first"));
    }
    let order: String = sqlx::query_scalar("SELECT member_order FROM groups WHERE name = $1").bind(&group).fetch_one(&s.db).await?;
    Ok(Json(Value::Array(members_of(&s.db, &group, &order).await?)))
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
    let name = body.name.trim().to_lowercase();
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
    groups::delete_if_empty(&s, &group).await?;
    log::info!("{}: kicked {name} from {group}", who.name);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/groups/:group/timeout` `{ name, seconds }`: no line of `name`'s in the group's
/// channels for that long (docs/groups.md): the chat refuses them with `timed out` and the wait.
/// The kick power; a member (404), not yourself (400), an owner only by an owner (403); ten
/// seconds to a week (400). Set again, the new end stands. A row of its own (`timeouts`), so
/// leaving and joining again does not end it; the expired rows of the group are swept here.
/// A `timeout` fact carries `until`, unix seconds. 204.
async fn timeout(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<TimeoutIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, KICK).await?;
    let name = body.name.trim().to_lowercase();
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
    sqlx::query("DELETE FROM timeouts WHERE group_name = $1 AND until < now()").bind(&group).execute(&s.db).await?;
    let until: i64 = sqlx::query_scalar(
        "INSERT INTO timeouts (group_name, user_id, until, by_id) VALUES ($1, $2, now() + make_interval(secs => $3), $4)
         ON CONFLICT (group_name, user_id) DO UPDATE SET until = EXCLUDED.until, by_id = EXCLUDED.by_id
         RETURNING (EXTRACT(EPOCH FROM until))::bigint",
    )
    .bind(&group)
    .bind(user)
    .bind(body.seconds as f64)
    .bind(who.id)
    .fetch_one(&s.db)
    .await?;
    log::info!("{}: timed {name} out of {group} for {}s", who.name, body.seconds);
    groups::tell(&s, &group, "timeout", json!({ "who": name, "until": until })).await;
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

async fn ban(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<BanIn>, JsonRejection>) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    need(&s, who.id, &group, BAN).await?;
    let name = body.name.trim().to_lowercase();
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
    fn powers_pack() {
        assert_eq!(bits_of(true, false, true, false, false), APPEARANCE | CHANNELS);
        assert_eq!(PermsIn { kick: true, ban: true, ..PermsIn::default() }.bits(), KICK | BAN);
        assert_eq!(perms_json(ROLES)["roles"], json!(true));
        assert_eq!(perms_json(ROLES)["kick"], json!(false));
    }

    #[test]
    fn a_role_reaches_what_its_shaper_holds() {
        let shaper = Shaper { owner: false, admin: false, perms: ROLES | KICK };
        assert!(shaper.reaches(0));
        assert!(shaper.reaches(ROLES));
        assert!(shaper.reaches(ROLES | KICK));
        assert!(!shaper.reaches(BAN));
        assert!(!shaper.reaches(ROLES | KICK | APPEARANCE));
        assert!(Shaper { owner: true, admin: false, perms: 0 }.reaches(ALL));
        assert!(Shaper { owner: false, admin: true, perms: 0 }.reaches(ALL));
    }
}
