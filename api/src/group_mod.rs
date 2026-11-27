use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, JsonRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, RawQuery, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Me;
use crate::chat::clean_text;
use crate::groups::{self, BOT_GROUP};
use crate::s3;
use crate::{ApiError, ApiResult, AppState};

pub(crate) const APPEARANCE: i32 = 1;
pub(crate) const ROLES: i32 = 2;
pub(crate) const CHANNELS: i32 = 4;
pub(crate) const KICK: i32 = 8;
pub(crate) const BAN: i32 = 16;
pub(crate) const VOICE: i32 = 32;
pub(crate) const EMOTES: i32 = 64;

const ALL: i32 = APPEARANCE | ROLES | CHANNELS | KICK | BAN | VOICE | EMOTES;
const MAX_ROLES: i64 = 20;
const MAX_ICON: usize = 256 * 1024;
const MAX_BANNER: usize = 1024 * 1024;
const JPEG: [u8; 3] = [0xFF, 0xD8, 0xFF];
const BANNER_WIDTHS: [u32; 3] = [640, 1280, 1920];
const BANNER_SQUARES: [u32; 2] = [320, 640];
const BANNER_QUALITY: u8 = 80;
const BANNER_MAX_SOURCE_SIDE: u32 = 8192;

struct Held {
    owner: bool,
    perms: i32,
}

fn bits_of(appearance: bool, roles: bool, channels: bool, kick: bool, ban: bool, voice: bool, emotes: bool) -> i32 {
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
    if emotes {
        bits |= EMOTES;
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
        "emotes": bits & EMOTES != 0,
    })
}

pub(crate) async fn allows(s: &AppState, user: uuid::Uuid, group: &str, bit: i32) -> Result<bool, sqlx::Error> {
    let held = held(&s.db, user, group).await?;
    let admin = s.admins.iter().any(|a| a.id == user);
    Ok(grants(held.owner, admin, held.perms, bit))
}

fn grants(owner: bool, admin: bool, perms: i32, bit: i32) -> bool {
    owner || admin || perms & bit != 0
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

struct Shaper {
    owner: bool,
    admin: bool,
    perms: i32,
}

impl Shaper {
    fn reaches(&self, bits: i32) -> bool {
        self.owner || self.admin || bits & !self.perms == 0
    }
}

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

fn not_an_owner(me: &Shaper, target_is_owner: bool) -> Result<(), ApiError> {
    if target_is_owner && !me.owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "a role can't touch an owner"));
    }
    Ok(())
}

async fn role_perms(db: &sqlx::PgPool, group: &str, id: uuid::Uuid) -> Result<i32, ApiError> {
    let perms: Option<i32> = sqlx::query_scalar("SELECT perms FROM roles WHERE id = $1 AND group_name = $2").bind(id).bind(group).fetch_optional(db).await?;
    perms.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such role"))
}

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

async fn owner_role_of(db: &sqlx::PgPool, group: &str) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT owner_role FROM groups WHERE name = $1").bind(group).fetch_one(db).await
}

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
    #[serde(default)]
    emotes: bool,
}

impl PermsIn {
    fn bits(&self) -> i32 {
        bits_of(self.appearance, self.roles, self.channels, self.kick, self.ban, self.voice, self.emotes) & ALL
    }
}

#[derive(Deserialize)]
struct RoleIn {
    name: String,
    color: String,
    #[serde(default)]
    perms: PermsIn,
    #[serde(default)]
    channels: Vec<String>,
    #[serde(default)]
    cooldown: i32,
}

const MAX_COOLDOWN_SECS: i32 = 3600;
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
    roles: Vec<uuid::Uuid>,
}

#[derive(Deserialize)]
struct TimeoutIn {
    name: String,
    seconds: i64,
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
struct AdultIn {
    adult: bool,
}

#[derive(Deserialize)]
struct OrderIn {
    order: String,
}

fn member_order(raw: &str) -> Result<&'static str, ApiError> {
    match raw.trim() {
        "newest" => Ok("newest"),
        "oldest" => Ok("oldest"),
        "name" => Ok("name"),
        _ => Err(ApiError::new(StatusCode::BAD_REQUEST, "order is name, newest, or oldest")),
    }
}

pub(crate) fn routes() -> Router<AppState> {
    let pictures = Router::new()
        .route("/api/groups/{group}/icon", get(get_icon).put(put_icon))
        .route("/api/groups/{group}/banner", get(get_banner).put(put_banner))
        .layer(DefaultBodyLimit::max(MAX_BANNER));
    Router::new()
        .route("/api/groups/{group}/about", axum::routing::put(put_about))
        .route("/api/groups/{group}/color", axum::routing::put(put_color))
        .route("/api/groups/{group}/access", axum::routing::put(set_access))
        .route("/api/groups/{group}/adult", axum::routing::put(set_adult))
        .route("/api/groups/{group}/adult/lock", axum::routing::delete(lift_adult_lock))
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
        .route("/api/groups/{group}/channels/{channel}/messages/{id}/embed/hide", post(hide_embed))
        .route("/api/groups/{group}/kick", post(kick))
        .route("/api/groups/{group}/timeout", post(timeout))
        .route("/api/groups/{group}/timeout/{name}", axum::routing::delete(lift_timeout))
        .route("/api/groups/{group}/timeouts", get(list_timeouts))
        .route("/api/groups/{group}/ban", post(ban))
        .route("/api/groups/{group}/bans", get(list_bans))
        .route("/api/groups/{group}/bans/{name}", axum::routing::delete(unban))
        .merge(pictures)
}

pub(crate) async fn room(State(s): State<AppState>, Path(group): Path<String>, Query(q): Query<RoomQuery>, Me(me): Me) -> ApiResult {
    let group = server(&s.db, &group).await?;
    let user = me.as_ref().map(|a| a.id);
    #[allow(clippy::type_complexity)]
    let row: (String, String, String, i64, Option<i64>, Option<i64>, bool, Option<String>, Option<i32>, String, String, bool, bool) = sqlx::query_as(
        "SELECT g.badge, g.color, g.about,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                (EXTRACT(EPOCH FROM g.icon_at))::bigint,
                (EXTRACT(EPOCH FROM g.banner_at))::bigint,
                g.public, g.title, g.tag, g.member_order, g.owner_role, g.adult_content, g.adult_locked_by IS NOT NULL
         FROM groups g WHERE g.name = $1",
    )
    .bind(&group)
    .fetch_one(&s.db)
    .await?;
    let (badge, color, about, members, icon, banner, public, title, tag, member_order, owner_role, adult, adult_locked) = row;
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
    let sees = crate::moderate::sees_group(public, adult, mine, admin);
    let live = if sees { groups::live_in(&s, &group).await? } else { Vec::new() };
    let muted = groups::muted_in(&s.db, user, &group).await?;
    let seen = groups::visible_channels(&s.db, &group, user, admin).await?;
    let pins = crate::pins::pinned_ids(&s.db, &group, &seen).await?;
    let voice = if sees { voice_in(&s, &group, &seen).await } else { json!({}) };
    let first = page_of(q.roster, None, None)?;
    let (roster, roster_next, holders) = if sees {
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
        "adult": adult,
        "adult_locked": adult_locked,
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

async fn set_adult(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, body: Result<Json<AdultIn>, JsonRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let Json(body) = body?;
    let group = server(&s.db, &group).await?;
    let owner = is_owner(&s.db, who.id, &group).await?;
    let site_admin = s.admins.iter().any(|a| a.id == who.id);
    let locked: bool = sqlx::query_scalar("SELECT adult_locked_by IS NOT NULL FROM groups WHERE name = $1").bind(&group).fetch_one(&s.db).await?;
    let lock = crate::moderate::adult_change(body.adult, owner, site_admin, locked).map_err(|why| ApiError::new(StatusCode::FORBIDDEN, why))?;
    let Some(locked) = write_adult(&s.db, &group, body.adult, lock.then_some(who.id)).await? else {
        return Err(ApiError::new(StatusCode::FORBIDDEN, crate::moderate::ADULT_LOCKED));
    };
    log::info!("{}: adult content {} in {group}{}", who.name, if body.adult { "on" } else { "off" }, if lock { " (site admin, locked)" } else { "" });
    groups::tell(&s, &group, "adult", json!({ "adult": body.adult, "locked": locked })).await;
    Ok(Json(json!({ "adult": body.adult, "locked": locked })))
}

async fn write_adult(db: &sqlx::PgPool, group: &str, adult: bool, lock_by: Option<uuid::Uuid>) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE groups SET adult_content = $2, adult_locked_by = COALESCE($3, adult_locked_by)
         WHERE name = $1 AND (NOT $2 OR adult_locked_by IS NULL)
         RETURNING adult_locked_by IS NOT NULL",
    )
    .bind(group)
    .bind(adult)
    .bind(lock_by)
    .fetch_optional(db)
    .await
}

async fn unlock_adult(db: &sqlx::PgPool, group: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("UPDATE groups SET adult_locked_by = NULL WHERE name = $1 RETURNING adult_content").bind(group).fetch_one(db).await
}

async fn lift_adult_lock(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    if !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, crate::moderate::ONLY_ADMIN_UNLOCKS));
    }
    let adult = unlock_adult(&s.db, &group).await?;
    log::info!("{}: lifted the adult content lock in {group}", who.name);
    groups::tell(&s, &group, "adult", json!({ "adult": adult, "locked": false })).await;
    Ok(Json(json!({ "adult": adult, "locked": false })))
}

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

fn role_json(id: uuid::Uuid, name: &str, color: &str, perms: i32, channels: &[String], cooldown: i32) -> Value {
    json!({ "id": id, "name": name, "color": color, "perms": perms_json(perms), "channels": channels, "cooldown": cooldown })
}

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

fn changed_roles(was: &[uuid::Uuid], now: &[uuid::Uuid]) -> Vec<uuid::Uuid> {
    let mut changed: Vec<uuid::Uuid> = was.iter().filter(|id| !now.contains(id)).chain(now.iter().filter(|id| !was.contains(id))).copied().collect();
    changed.sort();
    changed.dedup();
    changed
}

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
    if groups::groups_owned(&s.db, user).await? >= s.groups_per_owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("{name} owns {}", groups::owned_cap_words(s.groups_per_owner))));
    }
    sqlx::query("UPDATE memberships SET owner = true WHERE user_id = $1 AND group_name = $2").bind(user).bind(&group).execute(&s.db).await?;
    log::info!("{}: named {name} an owner of {group}", who.name);
    groups::tell(&s, &group, "owner", json!({ "who": name, "owner": true })).await;
    Ok(StatusCode::NO_CONTENT)
}

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

const MEMBERS_PAGE_MAX: i64 = 100;
const MEMBERS_PAGE_DEFAULT: i64 = 50;

struct Page {
    limit: i64,
    after: Option<Cursor>,
    q: Option<String>,
}

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

async fn members_of(db: &sqlx::PgPool, group: &str, order: &str, page: Option<&Page>) -> Result<(Vec<Value>, Option<String>), sqlx::Error> {
    members_where(db, group, order, page, None).await
}

async fn members_where(db: &sqlx::PgPool, group: &str, order: &str, page: Option<&Page>, only: Option<&str>) -> Result<(Vec<Value>, Option<String>), sqlx::Error> {
    let after = page.and_then(|p| p.after.as_ref());
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

async fn list_members(State(s): State<AppState>, Path(group): Path<String>, Query(q): Query<MembersQuery>, Me(me): Me) -> ApiResult {
    let group = server(&s.db, &group).await?;
    let page = page_of(q.limit, q.after.as_deref(), q.q.as_deref())?;
    let (public, adult, order): (bool, bool, String) =
        sqlx::query_as("SELECT public, adult_content, member_order FROM groups WHERE name = $1").bind(&group).fetch_one(&s.db).await?;
    if !crate::moderate::roster_public(public, adult) {
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
    crate::voice::drop_from_voice(&s, &group, user).await;
    Ok(StatusCode::NO_CONTENT)
}

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

pub(crate) async fn banned(db: &sqlx::PgPool, user: uuid::Uuid, group: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM bans WHERE group_name = $1 AND user_id = $2)").bind(group).bind(user).fetch_one(db).await
}

pub(crate) const MODERATE: i32 = KICK | BAN;
const ACTIONS_PER_MINUTE: i64 = 30;
const LOG_PAGE_MAX: i64 = 50;
const LOG_REDIS_SCAN: usize = 500;

pub(crate) fn may_touch(actor: uuid::Uuid, actor_owner: bool, target: uuid::Uuid, target_owner: bool) -> bool {
    actor != target && (!target_owner || actor_owner)
}

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

async fn sees_roster(s: &AppState, group: &str, me: Option<&crate::auth::Account>) -> Result<(), ApiError> {
    let (public, adult): (bool, bool) = sqlx::query_as("SELECT public, adult_content FROM groups WHERE name = $1").bind(group).fetch_one(&s.db).await?;
    if crate::moderate::roster_public(public, adult) {
        return Ok(());
    }
    let who = me.ok_or_else(login)?;
    if !groups::member(&s.db, who.id, group).await? && !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the group first"));
    }
    Ok(())
}

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

    fn key(&self) -> (u64, u64, &str) {
        (self.ms, self.seq, self.channel.as_str())
    }
}

fn log_key<'a>(line: &crate::chat::Line, channel: &'a str) -> (u64, u64, &'a str) {
    let (ms, seq) = crate::socket::id_parts(&line.id);
    (ms, seq, channel)
}

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

struct Removable {
    group: String,
    channel: String,
    room: String,
    id: String,
    line: crate::chat::Line,
}

async fn removable(s: &AppState, who: &crate::auth::Account, group: &str, channel: &str, id: &str) -> Result<Removable, ApiError> {
    let (group, channel) = groups::channel_names(group, channel)?;
    let group = server(&s.db, &group).await?;
    let admin = s.admins.iter().any(|a| a.id == who.id);
    if !groups::may_see_text(&s.db, &group, &channel, Some(who.id), admin).await? {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    let id = crate::history::stream_id(id)?;
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
    let moderates = allows(s, who.id, &group, KICK).await?;
    if !may_delete(who.id, actor_owner, moderates, author, author_owner) {
        return Err(no_power());
    }
    paced(s, who.id).await?;
    Ok(Removable { group, channel, room, id, line })
}

async fn hide_embed(State(s): State<AppState>, Path((group, channel, id)): Path<(String, String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Removable { group, channel, room, id, line } = removable(&s, &who, &group, &channel, &id).await?;
    crate::unfurl::hide_line(&s.db, &mut s.redis.clone(), &room, &id).await?;
    log::info!("{}: hid the embed on {}'s line {id} in #{channel} of {group}", who.name, line.from);
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_message(State(s): State<AppState>, Path((group, channel, id)): Path<(String, String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(login)?;
    let Removable { group, channel, room, id, line } = removable(&s, &who, &group, &channel, &id).await?;
    let mut r = s.redis.clone();
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
    ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, crate::media::PUBLIC_CACHE)], bytes).into_response()
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

#[allow(clippy::too_many_arguments)]
async fn write_picture(s: &AppState, who: crate::auth::Account, headers: &HeaderMap, kind: crate::moderate::UploadKind, group: &str, key: &str, column: &str, body: Bytes) -> Result<i64, ApiError> {
    let ip = crate::ratelimit::forwarded_ip(headers);
    crate::moderate::check(s, crate::moderate::Upload { kind, who: Some(who.id), ip: ip.as_deref(), mime: "image/jpeg", key: Some(key), sha: None }, &body).await?;
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

async fn get_icon(State(s): State<AppState>, Path(group): Path<String>, RawQuery(q): RawQuery) -> Result<Response, ApiError> {
    let group = server(&s.db, &group).await?;
    crate::media::versioned_cache(read_picture(&s, &group, &icon_key(&group), "icon_at").await, q.as_deref())
}

async fn put_icon(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need_owner(&s, who.id, &group).await?;
    let body = jpeg_in(body, MAX_ICON)?;
    let version = write_picture(&s, who, &headers, crate::moderate::UploadKind::GroupIcon, &group, &icon_key(&group), "icon_at", body).await?;
    groups::tell(&s, &group, "icon", json!({ "icon": version })).await;
    Ok(Json(json!({ "icon": version })))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum BannerCut {
    Wide(u32),
    Square(u32),
}

impl BannerCut {
    fn all() -> impl Iterator<Item = BannerCut> {
        BANNER_WIDTHS.into_iter().map(BannerCut::Wide).chain(BANNER_SQUARES.into_iter().map(BannerCut::Square))
    }

    fn from_query(q: Option<&str>) -> Result<Option<BannerCut>, ApiError> {
        let bad = || ApiError::new(StatusCode::BAD_REQUEST, "no such banner size");
        let mut cut = None;
        for (name, value) in q.unwrap_or("").split('&').filter_map(|pair| pair.split_once('=')) {
            let make = match name {
                "w" => BannerCut::Wide,
                "sq" => BannerCut::Square,
                _ => continue,
            };
            let wanted = make(value.parse().map_err(|_| bad())?);
            if cut.is_some() || !BannerCut::all().any(|known| known == wanted) {
                return Err(bad());
            }
            cut = Some(wanted);
        }
        Ok(cut)
    }

    fn key(self, group: &str, version: i64) -> String {
        match self {
            BannerCut::Wide(w) => format!("groups/{group}/banner-{version}-w{w}.jpg"),
            BannerCut::Square(side) => format!("groups/{group}/banner-{version}-sq{side}.jpg"),
        }
    }

    fn draw(self, bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
        let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), ImageFormat::Jpeg);
        let mut limits = Limits::default();
        limits.max_image_width = Some(BANNER_MAX_SOURCE_SIDE);
        limits.max_image_height = Some(BANNER_MAX_SOURCE_SIDE);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let img = reader.decode().map_err(|_| "not a jpeg")?;
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            return Err("empty picture");
        }
        let drawn = match self {
            BannerCut::Wide(want) => {
                let width = want.min(w);
                let height = ((u64::from(h) * u64::from(width) + u64::from(w) / 2) / u64::from(w)).max(1) as u32;
                img.resize_exact(width, height, FilterType::Lanczos3)
            }
            BannerCut::Square(want) => {
                let side = w.min(h);
                img.crop_imm((w - side) / 2, (h - side) / 2, side, side).resize_exact(want.min(side), want.min(side), FilterType::Lanczos3)
            }
        };
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, BANNER_QUALITY).encode_image(&drawn.to_rgb8()).map_err(|_| "could not encode")?;
        Ok(out)
    }
}

async fn banner_version(db: &sqlx::PgPool, group: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM banner_at))::bigint FROM groups WHERE name = $1").bind(group).fetch_optional(db).await.map(Option::flatten)
}

async fn drop_banner_cuts(s: &AppState, group: &str, version: i64) {
    for cut in BannerCut::all() {
        let _ = s3::delete(&s.s3, &cut.key(group, version)).await;
    }
}

pub(crate) async fn drop_banner(s: &AppState, group: &str) {
    if let Ok(Some(version)) = banner_version(&s.db, group).await {
        drop_banner_cuts(s, group, version).await;
    }
    let _ = s3::delete(&s.s3, &banner_key(group)).await;
}

async fn read_banner_cut(s: &AppState, group: &str, cut: BannerCut) -> Result<Response, ApiError> {
    let Some(version) = banner_version(&s.db, group).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no picture"));
    };
    let key = cut.key(group, version);
    match s3::get(&s.s3, &key).await {
        Ok(Some(bytes)) => return Ok(jpeg_out(bytes)),
        Ok(None) => {}
        Err(e) => log::warn!("s3 banner cut {key}: {e}"),
    }
    let original = match s3::get(&s.s3, &banner_key(group)).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(ApiError::new(StatusCode::NOT_FOUND, "no picture")),
        Err(e) => {
            log::error!("s3 group picture {group}: {e}");
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not load the picture"));
        }
    };
    let (original, drawn) = tokio::task::spawn_blocking(move || {
        let drawn = cut.draw(&original);
        (original, drawn)
    })
    .await
    .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not load the picture"))?;
    match drawn {
        Ok(bytes) => {
            if let Err(e) = s3::put(&s.s3, &key, &bytes, "image/jpeg").await {
                log::warn!("s3 banner cut {key}: {e}");
            }
            Ok(jpeg_out(bytes))
        }
        Err(why) => {
            log::warn!("banner cut {key}: {why}");
            Ok(jpeg_out(original))
        }
    }
}

async fn get_banner(State(s): State<AppState>, Path(group): Path<String>, RawQuery(q): RawQuery) -> Result<Response, ApiError> {
    let group = server(&s.db, &group).await?;
    let read = match BannerCut::from_query(q.as_deref())? {
        Some(cut) => read_banner_cut(&s, &group, cut).await,
        None => read_picture(&s, &group, &banner_key(&group), "banner_at").await,
    };
    crate::media::versioned_cache(read, q.as_deref())
}

async fn put_banner(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me, headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> ApiResult {
    let who = me.ok_or_else(login)?;
    let group = server(&s.db, &group).await?;
    need_owner(&s, who.id, &group).await?;
    let body = jpeg_in(body, MAX_BANNER)?;
    let before = banner_version(&s.db, &group).await?;
    let version = write_picture(&s, who, &headers, crate::moderate::UploadKind::GroupBanner, &group, &banner_key(&group), "banner_at", body).await?;
    for old in before.into_iter().chain([version]) {
        drop_banner_cuts(&s, &group, old).await;
    }
    groups::tell(&s, &group, "banner", json!({ "banner": version })).await;
    Ok(Json(json!({ "banner": version })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn banner_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x ^ y) % 256) as u8]));
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 80).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn a_banner_size_is_one_of_the_known_ones() {
        assert_eq!(BannerCut::from_query(None).unwrap(), None);
        assert_eq!(BannerCut::from_query(Some("v=17")).unwrap(), None);
        assert_eq!(BannerCut::from_query(Some("v=17&w=640")).unwrap(), Some(BannerCut::Wide(640)));
        assert_eq!(BannerCut::from_query(Some("sq=320&v=17")).unwrap(), Some(BannerCut::Square(320)));
        for bad in ["w=641", "w=", "w=abc", "sq=1280", "w=640&sq=320", "w=640&w=640"] {
            assert_eq!(BannerCut::from_query(Some(bad)).unwrap_err().into_response().status(), StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    #[test]
    fn each_version_has_its_own_cut() {
        assert_eq!(BannerCut::Wide(1280).key("vips", 1_700_000_000), "groups/vips/banner-1700000000-w1280.jpg");
        assert_eq!(BannerCut::Square(320).key("vips", 1_700_000_001), "groups/vips/banner-1700000001-sq320.jpg");
        assert_ne!(BannerCut::Wide(640).key("vips", 1), BannerCut::Wide(640).key("vips", 2));
    }

    #[test]
    fn a_banner_shrinks_to_its_box() {
        let original = banner_jpeg(2560, 640);
        for (cut, w, h) in [
            (BannerCut::Wide(640), 640, 160),
            (BannerCut::Wide(1920), 1920, 480),
            (BannerCut::Square(320), 320, 320),
            (BannerCut::Square(640), 640, 640),
        ] {
            let drawn = cut.draw(&original).unwrap();
            assert!(drawn.starts_with(&JPEG));
            assert!(drawn.len() < original.len(), "{cut:?}");
            let back = image::load_from_memory_with_format(&drawn, ImageFormat::Jpeg).unwrap();
            assert_eq!((back.width(), back.height()), (w, h), "{cut:?}");
        }
    }

    #[test]
    fn a_small_banner_is_never_blown_up() {
        let original = banner_jpeg(800, 200);
        let wide = image::load_from_memory(&BannerCut::Wide(1920).draw(&original).unwrap()).unwrap();
        assert_eq!((wide.width(), wide.height()), (800, 200));
        let square = image::load_from_memory(&BannerCut::Square(640).draw(&original).unwrap()).unwrap();
        assert_eq!((square.width(), square.height()), (200, 200));
        assert!(BannerCut::Wide(640).draw(b"not a jpeg").is_err());
    }

    #[test]
    fn a_cursor_reads_back_what_it_wrote() {
        let c = Cursor { owner: true, joined: 1_763_500_000_123_456, name: "a.b".to_owned() };
        let back = Cursor::read(&c.text()).unwrap();
        assert!(back.owner);
        assert_eq!(back.joined, 1_763_500_000_123_456);
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
        assert_eq!(bits_of(true, false, true, false, false, false, false), APPEARANCE | CHANNELS);
        assert_eq!(bits_of(false, false, false, false, false, true, false), VOICE);
        assert_eq!(bits_of(false, false, false, false, false, false, true), EMOTES);
        assert_eq!(perms_json(EMOTES)["emotes"], json!(true));
        assert_eq!(PermsIn { kick: true, ban: true, ..PermsIn::default() }.bits(), KICK | BAN);
        assert_eq!(perms_json(ROLES)["roles"], json!(true));
        assert_eq!(perms_json(ROLES)["kick"], json!(false));
        assert_eq!(perms_json(ROLES)["voice"], json!(false));
    }

    #[test]
    fn the_emotes_power_is_the_owners_and_a_role_s_that_has_it() {
        assert!(grants(true, false, 0, EMOTES), "an owner always manages emotes");
        assert!(grants(false, true, 0, EMOTES), "a site admin too");
        assert!(!grants(false, false, 0, EMOTES), "a plain member does not");
        assert!(!grants(false, false, ALL & !EMOTES, EMOTES), "every other power is not the emotes power");
        assert!(grants(false, false, EMOTES, EMOTES), "a role with the power has it");
        assert!(grants(false, false, KICK | EMOTES, EMOTES));
        assert_eq!(PermsIn::default().bits() & EMOTES, 0, "a new role starts without it");
        let old: PermsIn = serde_json::from_value(json!({ "kick": true, "ban": true })).unwrap();
        assert_eq!(old.bits() & EMOTES, 0, "a body that leaves it out gives none");
        assert_eq!(perms_json(ALL)["emotes"], json!(true));
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
        assert!(may_delete(me, false, false, Some(me), false));
        assert!(!may_delete(me, false, false, Some(them), false));
        assert!(may_delete(me, false, true, Some(them), false));
        assert!(!may_delete(me, false, true, Some(them), true));
        assert!(may_delete(me, true, true, Some(them), true));
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
            ("g/clips".to_owned(), line("300-0", "b")),
            ("g/general".to_owned(), line("300-0", "c")),
            ("g/general".to_owned(), line("200-1", "d")),
            ("other/general".to_owned(), line("900-0", "e")),
        ];
        let (page, next) = merge_log("g", found.clone(), 3);
        let got: Vec<(&str, &str)> = page.iter().map(|(c, l)| (c.as_str(), l.text.as_str())).collect();
        assert_eq!(got, vec![("general", "c"), ("clips", "b"), ("general", "d")]);
        assert_eq!(next.as_deref(), Some("200-1.general"));
        let after = LogCursor::read(next.as_deref().unwrap()).unwrap();
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

    #[tokio::test]
    #[ignore]
    async fn the_adult_lock_holds_and_hides_old_pictures() {
        let pool = crate::auth::tests::test_db().await;
        let run = std::process::id();
        let owner = crate::auth::tests::row(&pool, &format!("adult-owner-{run}"), Some("hash")).await;
        let admin = crate::auth::tests::row(&pool, &format!("adult-admin-{run}"), Some("hash")).await;
        let group = format!("adult-{run}");
        sqlx::query("INSERT INTO groups (name, badge, color, created_by_id) VALUES ($1, 'A', '#ffffff', $2)").bind(&group).bind(owner).execute(&pool).await.unwrap();
        let picture: uuid::Uuid = sqlx::query_scalar("SELECT gen_random_uuid()").fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO chat_images (id, mime, created_by, nsfw, posted_kind, posted_group) VALUES ($1, 'image/png', $2, true, 'group', $3)")
            .bind(picture)
            .bind(owner)
            .bind(&group)
            .execute(&pool)
            .await
            .unwrap();
        let hidden_to = |facts: crate::chat_images::ShownFacts, viewer: uuid::Uuid| {
            let (_, nsfw, _, by, in_group, adult_now) = facts;
            crate::moderate::hidden(nsfw, in_group, adult_now.unwrap_or(false), by == Some(viewer) || viewer == admin)
        };
        let stranger = uuid::Uuid::from_u128(1);

        assert_eq!(write_adult(&pool, &group, true, None).await.unwrap(), Some(false));
        let facts = crate::chat_images::shown_facts(&pool, picture).await.unwrap().unwrap();
        assert!(!hidden_to(facts, stranger));

        assert_eq!(write_adult(&pool, &group, false, Some(admin)).await.unwrap(), Some(true));
        let facts = crate::chat_images::shown_facts(&pool, picture).await.unwrap().unwrap();
        assert!(hidden_to(facts.clone(), stranger));
        assert!(!hidden_to(facts.clone(), owner));
        assert!(!hidden_to(facts, admin));
        let by: Option<uuid::Uuid> = sqlx::query_scalar("SELECT adult_locked_by FROM groups WHERE name = $1").bind(&group).fetch_one(&pool).await.unwrap();
        assert_eq!(by, Some(admin));

        assert_eq!(write_adult(&pool, &group, true, None).await.unwrap(), None);
        assert_eq!(write_adult(&pool, &group, false, None).await.unwrap(), Some(true));
        let adult: bool = sqlx::query_scalar("SELECT adult_content FROM groups WHERE name = $1").bind(&group).fetch_one(&pool).await.unwrap();
        assert!(!adult);

        assert!(!unlock_adult(&pool, &group).await.unwrap());
        assert_eq!(write_adult(&pool, &group, true, None).await.unwrap(), Some(false));
        let facts = crate::chat_images::shown_facts(&pool, picture).await.unwrap().unwrap();
        assert!(!hidden_to(facts, stranger));

        sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&pool).await.unwrap();
        let facts = crate::chat_images::shown_facts(&pool, picture).await.unwrap().unwrap();
        assert!(hidden_to(facts, stranger));

        sqlx::query("DELETE FROM chat_images WHERE id = $1").bind(picture).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM streamers WHERE id = ANY($1)").bind(vec![owner, admin]).execute(&pool).await.unwrap();
    }
}
