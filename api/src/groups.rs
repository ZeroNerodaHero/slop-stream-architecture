use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
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

pub(crate) const BOT_GROUP: &str = "bot";
const MAX_BADGE_CHARS: usize = 12;
const MAX_ABOUT_CHARS: usize = 200;
const GROUPS_PER_MEMBER: i64 = 8;
pub(crate) const DEFAULT_GROUPS_PER_OWNER: i64 = 2;
const TEXT_CHANNELS_PER_SERVER: i64 = 20;
const VOICE_CHANNELS_PER_SERVER: i64 = 4;
const MESSAGES_PER_CHANNEL: usize = 100;
pub(crate) const GENERAL: &str = "general";
const VOICE_CHANNEL: &str = "voice";
const CHANNEL_KINDS: [&str; 2] = ["text", "voice"];
const RESERVED_CHANNELS: &[&str] = &["before", "search", "by", "around"];
const MAX_CHANNEL_COOLDOWN_SECS: i32 = 3600;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Badge {
    pub(crate) name: String,
    pub(crate) badge: String,
    pub(crate) color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) icon: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) about: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) members: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) banner: Option<i64>,
}

type BadgeRow = (String, String, String, Option<i64>, String, i64, Option<i64>);

const BADGE_COLUMNS: &str = "g.name, g.badge, g.color, (EXTRACT(EPOCH FROM g.icon_at))::bigint, g.about,
        (SELECT count(*) FROM memberships c WHERE c.group_name = g.name),
        (EXTRACT(EPOCH FROM g.banner_at))::bigint";

impl From<BadgeRow> for Badge {
    fn from((name, badge, color, icon, about, members, banner): BadgeRow) -> Self {
        let about = Some(about).filter(|a| !a.is_empty());
        Badge { name, badge, color, icon, about, members: Some(members), banner }
    }
}

pub(crate) async fn badges_of(db: &PgPool, user: Option<Uuid>, bot: bool) -> Result<Vec<Badge>, sqlx::Error> {
    let rows: Vec<BadgeRow> = sqlx::query_as(&format!(
        "SELECT {BADGE_COLUMNS} FROM groups g
         LEFT JOIN memberships m ON m.group_name = g.name AND m.user_id = $1
         WHERE (g.name = $2 AND $3)
            OR g.name = (SELECT p.group_name FROM memberships p JOIN groups pg ON pg.name = p.group_name
                         WHERE p.user_id = $1 AND NOT pg.adult_content
                         ORDER BY p.is_primary DESC, p.joined_at LIMIT 1)
         ORDER BY g.name = $2 DESC"
    ))
    .bind(user)
    .bind(BOT_GROUP)
    .bind(bot)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Badge::from).collect())
}

pub(crate) async fn badge_of(db: &PgPool, name: &str) -> Result<Option<Badge>, sqlx::Error> {
    Ok(badges_by_name(db, &[name.to_owned()]).await?.remove(name))
}

pub(crate) async fn badges_by_name(db: &PgPool, names: &[String]) -> Result<HashMap<String, Badge>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, Option<i64>, String, i64, Option<i64>)> = sqlx::query_as(&format!(
        "SELECT DISTINCT ON (st.name) st.name, {BADGE_COLUMNS} FROM streamers st
         JOIN memberships m ON m.user_id = st.id
         JOIN groups g ON g.name = m.group_name
         WHERE st.name = ANY($1) AND st.password_hash IS NOT NULL AND NOT g.adult_content
         ORDER BY st.name, m.is_primary DESC, m.joined_at"
    ))
    .bind(names)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(who, name, badge, color, icon, about, members, banner)| (who, Badge::from((name, badge, color, icon, about, members, banner))))
        .collect())
}

pub(crate) async fn badges_named(db: &PgPool, names: &[String]) -> Result<Vec<Badge>, sqlx::Error> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<BadgeRow> = sqlx::query_as(&format!("SELECT {BADGE_COLUMNS} FROM groups g WHERE g.name = ANY($1)")).bind(names).fetch_all(db).await?;
    Ok(rows.into_iter().map(Badge::from).collect())
}

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn no_such_group() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such group")
}

pub(crate) fn group_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if valid_name(&name) {
        Ok(name)
    } else {
        Err(ApiError::bad_name())
    }
}

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

fn clean_badge(raw: &str) -> Result<String, ApiError> {
    let badge: String = clean_text(raw).split_whitespace().collect::<Vec<_>>().join(" ");
    if (1..=MAX_BADGE_CHARS).contains(&badge.chars().count()) {
        Ok(badge)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "badge: 1 to 12 characters"))
    }
}

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

async fn member_of(db: &PgPool, user: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE user_id = $1").bind(user).fetch_one(db).await
}

fn too_many_groups() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, format!("you are in {GROUPS_PER_MEMBER} groups already. leave one first"))
}

pub(crate) fn groups_per_owner_from_env() -> i64 {
    groups_per_owner_from(std::env::var("GROUPS_PER_OWNER").ok().as_deref())
}

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

pub(crate) async fn groups_owned(db: &PgPool, user: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE user_id = $1 AND owner").bind(user).fetch_one(db).await
}

pub(crate) fn owned_cap_words(cap: i64) -> String {
    if cap == 1 {
        "a group already. one each".into()
    } else {
        format!("{cap} groups already. that is the cap")
    }
}

pub(crate) async fn member_count(db: &PgPool, group: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE group_name = $1").bind(group).fetch_one(db).await
}

pub(crate) async fn tell(s: &AppState, group: &str, what: &str, data: Value) {
    presence::publish_group(&mut s.redis.clone(), group, what, &data).await;
}

type GroupRow = (String, String, String, String, Option<String>, i64, bool, bool, Option<String>, Option<i32>, Option<i64>, bool);

fn group_json((name, badge, color, about, made_by, members, mine, public, title, tag, icon, primary): GroupRow) -> Value {
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
        "icon": icon,
        "primary": primary,
        "automatic": name == BOT_GROUP,
    })
}

async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<GroupRow> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color, g.about, maker.name,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1),
                g.public, g.title, g.tag, (EXTRACT(EPOCH FROM g.icon_at))::bigint,
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1 AND m.is_primary)
         FROM groups g
         LEFT JOIN streamers maker ON maker.id = g.created_by_id
         WHERE (g.public AND NOT g.adult_content) OR g.name = $2
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
    #[serde(default = "default_public")]
    public: bool,
}

fn default_public() -> bool {
    true
}

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
                INSERT INTO channels (server, name, about, created_by_id, home)
                SELECT name, $11, '', $6, true FROM g RETURNING server
             ),
             v AS (
                INSERT INTO channels (server, name, about, created_by_id, position, kind)
                SELECT name, $10, '', $6, 1, 'voice' FROM g
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
        .bind(VOICE_CHANNEL)
        .bind(GENERAL)
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
    Ok((StatusCode::CREATED, Json(group_json((slug, badge, color, about, Some(maker.name.clone()), 1, true, body.public, Some(title), Some(tag), None, false)))))
}

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
        crate::voice::drop_from_voice(&s, &group, me.id).await;
        let members = member_count(&s.db, &group).await?;
        tell(&s, &group, "left", json!({ "who": me.name, "by": "leave", "members": members })).await;
    }
    delete_if_empty(&s, &group).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_primary(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    let done = sqlx::query(
        "UPDATE memberships SET is_primary = (group_name = $2)
         WHERE user_id = $1 AND EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2)",
    )
    .bind(me.id)
    .bind(&group)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join it first"));
    }
    log::info!("{}: primary group {group}", me.name);
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_primary(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    sqlx::query("UPDATE memberships SET is_primary = false WHERE user_id = $1 AND group_name = $2 AND is_primary")
        .bind(me.id)
        .bind(&group)
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

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
    crate::emotes::drop_group(s, group).await;
    let _ = crate::s3::delete(&s.s3, &format!("groups/{group}/icon.jpg")).await;
    crate::group_mod::drop_banner(s, group).await;
    sqlx::query("DELETE FROM groups WHERE name = $1").bind(group).execute(&s.db).await?;
    log::info!("deleted {group}: nobody left");
    tell(s, group, "deleted", json!({})).await;
    Ok(())
}

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
    crate::voice::drop_channel_from_voice(&s, &group, None).await;
    crate::emotes::drop_group(&s, &group).await;
    let _ = crate::s3::delete(&s.s3, &format!("groups/{group}/icon.jpg")).await;
    crate::group_mod::drop_banner(&s, &group).await;
    sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&s.db).await?;
    log::info!("{}: deleted the group {group}", who.name);
    tell(&s, &group, "deleted", json!({})).await;
    Ok(StatusCode::NO_CONTENT)
}

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

pub(crate) async fn member(db: &PgPool, user: Uuid, group: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND group_name = $2)")
        .bind(user)
        .bind(group)
        .fetch_one(db)
        .await
}

pub(crate) fn sees_sql(user: &str, admin: &str) -> String {
    let channels_bit = crate::group_mod::CHANNELS;
    format!(
        "({admin}
          OR EXISTS (SELECT 1 FROM memberships om WHERE om.group_name = c.server AND om.user_id = {user} AND om.owner)
          OR EXISTS (SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                     WHERE r.group_name = c.server AND rm.user_id = {user} AND (r.perms & {channels_bit}) <> 0)
          OR NOT EXISTS (SELECT 1 FROM channel_roles cr WHERE cr.server = c.server AND cr.channel = c.name)
          OR EXISTS (SELECT 1 FROM channel_roles cr JOIN role_members rm ON rm.role_id = cr.role_id
                     WHERE cr.server = c.server AND cr.channel = c.name AND rm.user_id = {user}))"
    )
}

pub(crate) async fn visible_channels(db: &PgPool, server: &str, user: Option<Uuid>, admin: bool) -> Result<Vec<String>, sqlx::Error> {
    let sql = format!("SELECT c.name FROM channels c WHERE c.server = $1 AND {} ORDER BY c.position, c.created_at, c.name", sees_sql("$2", "$3"));
    sqlx::query_scalar(&sql).bind(server).bind(user).bind(admin).fetch_all(db).await
}

pub(crate) async fn may_see(db: &PgPool, server: &str, channel: &str, user: Option<Uuid>, admin: bool) -> Result<bool, sqlx::Error> {
    let sql = format!("SELECT EXISTS (SELECT 1 FROM channels c WHERE c.server = $1 AND c.name = $4 AND {})", sees_sql("$2", "$3"));
    sqlx::query_scalar(&sql).bind(server).bind(user).bind(admin).bind(channel).fetch_one(db).await
}

pub(crate) async fn is_home(db: &PgPool, server: &str, channel: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM channels WHERE server = $1 AND name = $2 AND home)").bind(server).bind(channel).fetch_one(db).await
}

pub(crate) async fn visible_text_channels(db: &PgPool, server: &str, user: Option<Uuid>, admin: bool) -> Result<Vec<String>, sqlx::Error> {
    let sql = format!(
        "SELECT c.name FROM channels c WHERE c.server = $1 AND c.kind = 'text' AND {} ORDER BY c.position, c.created_at, c.name",
        sees_sql("$2", "$3")
    );
    sqlx::query_scalar(&sql).bind(server).bind(user).bind(admin).fetch_all(db).await
}

pub(crate) async fn may_see_text(db: &PgPool, server: &str, channel: &str, user: Option<Uuid>, admin: bool) -> Result<bool, sqlx::Error> {
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM channels c WHERE c.server = $1 AND c.name = $4 AND c.kind = 'text' AND {})",
        sees_sql("$2", "$3")
    );
    sqlx::query_scalar(&sql).bind(server).bind(user).bind(admin).bind(channel).fetch_one(db).await
}

#[derive(Serialize)]
pub(crate) struct ChannelView {
    name: String,
    about: String,
    home: bool,
    can_delete: bool,
    can_edit: bool,
    made_by: Option<String>,
    cooldown: i32,
    kind: String,
    user_limit: i32,
}

type ChannelRow = (String, String, Option<Uuid>, Option<String>, i32, String, i32, bool);

pub(crate) async fn channels_of(s: &AppState, server: &str, user: Option<Uuid>, admin: bool) -> Result<Vec<ChannelView>, sqlx::Error> {
    let may_manage = match user {
        Some(id) => crate::group_mod::allows(s, id, server, crate::group_mod::CHANNELS).await?,
        None => false,
    };
    let sql = format!(
        "SELECT c.name, c.about, c.created_by_id, maker.name, c.cooldown, c.kind, c.user_limit, c.home FROM channels c
         LEFT JOIN streamers maker ON maker.id = c.created_by_id
         WHERE c.server = $1 AND {} ORDER BY c.position, c.created_at, c.name",
        sees_sql("$2", "$3")
    );
    let rows: Vec<ChannelRow> = sqlx::query_as(&sql).bind(server).bind(user).bind(admin).fetch_all(&s.db).await?;
    Ok(rows
        .into_iter()
        .map(|(name, about, made_by_id, made_by, cooldown, kind, user_limit, home)| {
            let mine = user.is_some() && made_by_id == user;
            let can_edit = mine || may_manage || admin;
            let can_delete = !home && can_edit;
            ChannelView { home, can_delete, can_edit, made_by: made_by.filter(|_| !home), name, about, cooldown, kind, user_limit }
        })
        .collect())
}

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
    owner: bool,
    public: bool,
    title: Option<String>,
    tag: Option<i32>,
    icon: Option<i64>,
    banner: Option<i64>,
    can_channels: bool,
    live: Vec<String>,
    channels: Vec<ChannelView>,
}

async fn live_names(s: &AppState) -> Result<Vec<String>, ApiError> {
    Ok(crate::live_set(s).await?.iter().cloned().collect())
}

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

struct ExploreRow {
    name: String,
    badge: String,
    color: String,
    about: String,
    members: i64,
    mine: bool,
    public: bool,
    title: Option<String>,
    tag: Option<i32>,
    icon: Option<i64>,
    banner: Option<i64>,
    can_channels: bool,
    channel: Option<String>,
    channel_about: Option<String>,
    can_edit: bool,
    home: Option<bool>,
    made_by: Option<String>,
    cooldown: Option<i32>,
    kind: Option<String>,
    user_limit: Option<i32>,
}

impl<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> for ExploreRow {
    fn from_row(row: &'r sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(Self {
            name: row.try_get("name")?,
            badge: row.try_get("badge")?,
            color: row.try_get("color")?,
            about: row.try_get("about")?,
            members: row.try_get("members")?,
            mine: row.try_get("mine")?,
            public: row.try_get("public")?,
            title: row.try_get("title")?,
            tag: row.try_get("tag")?,
            icon: row.try_get("icon")?,
            banner: row.try_get("banner")?,
            can_channels: row.try_get("can_channels")?,
            channel: row.try_get("channel")?,
            channel_about: row.try_get("channel_about")?,
            can_edit: row.try_get("can_edit")?,
            home: row.try_get("home")?,
            made_by: row.try_get("made_by")?,
            cooldown: row.try_get("cooldown")?,
            kind: row.try_get("kind")?,
            user_limit: row.try_get("user_limit")?,
        })
    }
}

fn live_first(mut servers: Vec<ServerView>) -> Vec<ServerView> {
    servers.sort_by(|a, b| a.live.is_empty().cmp(&b.live.is_empty()));
    servers
}

async fn explore(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let user = me.as_ref().map(|a| a.id);
    let admin = me.as_ref().is_some_and(|a| s.admins.iter().any(|admin| admin.id == a.id));
    let mut living = live_members(&s.db, &live_names(&s).await?).await?;
    let owned: Vec<String> = sqlx::query_scalar("SELECT group_name FROM memberships WHERE user_id = $1 AND owner").bind(user).fetch_all(&s.db).await?;
    let sql = format!(
        "SELECT g.name, g.badge, g.color, g.about,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name) AS members,
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1) AS mine,
                g.public, g.title, g.tag,
                (EXTRACT(EPOCH FROM g.icon_at))::bigint AS icon,
                (EXTRACT(EPOCH FROM g.banner_at))::bigint AS banner,
                (
                    EXISTS (SELECT 1 FROM memberships om WHERE om.group_name = g.name AND om.user_id = $1 AND om.owner)
                    OR $2
                    OR EXISTS (
                        SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                        WHERE r.group_name = g.name AND rm.user_id = $1 AND (r.perms & 4) <> 0
                    )
                ) AS can_channels,
                c.name AS channel, c.about AS channel_about,
                COALESCE(c.name IS NOT NULL AND (
                    c.created_by_id = $1 OR $2
                    OR EXISTS (SELECT 1 FROM memberships om WHERE om.group_name = g.name AND om.user_id = $1 AND om.owner)
                    OR EXISTS (
                        SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                        WHERE r.group_name = g.name AND rm.user_id = $1 AND (r.perms & 4) <> 0
                    )
                ), false) AS can_edit,
                c.home, cm.name AS made_by, c.cooldown, c.kind, c.user_limit
         FROM groups g
         LEFT JOIN channels c ON c.server = g.name AND {}
         LEFT JOIN streamers cm ON cm.id = c.created_by_id
         WHERE g.name <> $3
           AND ((g.public AND NOT g.adult_content) OR EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1))
         ORDER BY g.created_at, g.name, c.position NULLS LAST, c.created_at, c.name",
        sees_sql("$1", "$2")
    );
    let rows: Vec<ExploreRow> = sqlx::query_as(&sql).bind(user).bind(admin).bind(BOT_GROUP).fetch_all(&s.db).await?;
    let mut servers: Vec<ServerView> = Vec::new();
    for row in rows {
        if servers.last().is_none_or(|server| server.name != row.name) {
            let live = living.remove(&row.name).unwrap_or_default();
            let owner = owned.contains(&row.name);
            servers.push(ServerView {
                name: row.name,
                badge: row.badge,
                color: row.color,
                about: row.about,
                members: row.members,
                mine: row.mine,
                owner,
                public: row.public,
                title: row.title,
                tag: row.tag,
                icon: row.icon,
                banner: row.banner,
                can_channels: row.can_channels,
                live,
                channels: Vec::new()
            });
        }
        if let Some(name) = row.channel {
            let home = row.home.unwrap_or(false);
            let made_by = row.made_by.filter(|_| !home);
            servers.last_mut().unwrap().channels.push(ChannelView {
                name,
                about: row.channel_about.unwrap_or_default(),
                home,
                can_delete: !home && row.can_edit,
                can_edit: row.can_edit,
                made_by,
                cooldown: row.cooldown.unwrap_or(0),
                kind: row.kind.unwrap_or_else(|| "text".into()),
                user_limit: row.user_limit.unwrap_or(0)
            });
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
    #[serde(default)]
    kind: Option<String>,
}

fn channel_kind(raw: Option<&str>) -> Result<&'static str, ApiError> {
    match raw {
        None => Ok(CHANNEL_KINDS[0]),
        Some(kind) => CHANNEL_KINDS
            .into_iter()
            .find(|k| *k == kind)
            .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "kind is text or voice")),
    }
}

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
    let kind = channel_kind(body.kind.as_deref())?;
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
    add_channel(&s.db, &server, &channel, &about, who.id, kind).await?;
    log::info!("{}: added {kind} #{channel} to {server}", who.name);
    tell(&s, &server, "channel", json!({ "channel": { "name": channel, "about": about, "made_by": who.name, "cooldown": 0, "kind": kind, "user_limit": 0, "home": false } })).await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "name": channel, "about": about, "home": false, "can_delete": true, "can_edit": true, "made_by": who.name, "cooldown": 0, "kind": kind, "user_limit": 0 })),
    ))
}

fn channels_cap(kind: &str) -> i64 {
    if kind == CHANNEL_KINDS[1] {
        VOICE_CHANNELS_PER_SERVER
    } else {
        TEXT_CHANNELS_PER_SERVER
    }
}

fn channels_full(kind: &str, n: i64) -> Option<String> {
    let cap = channels_cap(kind);
    (n >= cap).then(|| format!("{kind} channels: {cap} at most"))
}

async fn add_channel(db: &PgPool, server: &str, channel: &str, about: &str, by: Uuid, kind: &str) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT 1 FROM groups WHERE name = $1 FOR UPDATE").bind(server).execute(&mut *tx).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM channels WHERE server = $1 AND kind = $2").bind(server).bind(kind).fetch_one(&mut *tx).await?;
    if let Some(full) = channels_full(kind, n) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, full));
    }
    let added = sqlx::query(
        "INSERT INTO channels (server, name, about, created_by_id, position, kind)
         SELECT $1, $2, $3, $4, COALESCE(max(position), -1) + 1, $5 FROM channels WHERE server = $1
         ON CONFLICT DO NOTHING",
    )
    .bind(server)
    .bind(channel)
    .bind(about)
    .bind(by)
    .bind(kind)
    .execute(&mut *tx)
    .await?;
    if added.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
struct ChannelCooldown {
    seconds: i32,
}

async fn set_channel_cooldown(
    State(s): State<AppState>,
    Path((group, channel)): Path<(String, String)>,
    Me(me): Me,
    body: Result<Json<ChannelCooldown>, JsonRejection>,
) -> ApiResult {
    let who = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let (server, channel) = channel_names(&group, &channel)?;
    if !(0..=MAX_CHANNEL_COOLDOWN_SECS).contains(&body.seconds) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("cooldown: 0 to {MAX_CHANNEL_COOLDOWN_SECS} seconds")));
    }
    if !member(&s.db, who.id, &server).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "join the server first"));
    }
    if !crate::group_mod::allows(&s, who.id, &server, crate::group_mod::CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you can't set a channel's cooldown"));
    }
    let done = sqlx::query("UPDATE channels SET cooldown = $3 WHERE server = $1 AND name = $2").bind(&server).bind(&channel).bind(body.seconds).execute(&s.db).await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    }
    log::info!("{}: the cooldown of #{channel} in {server} is {}s", who.name, body.seconds);
    tell(&s, &server, "channel_cooldown", json!({ "channel": channel, "cooldown": body.seconds })).await;
    Ok(Json(json!({ "cooldown": body.seconds })))
}

#[derive(Deserialize)]
struct ChannelOrder {
    order: Vec<String>,
}

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

#[derive(Deserialize)]
struct ChannelEdit {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    about: Option<String>,
}

async fn edit_channel(
    State(s): State<AppState>,
    Path((group, channel)): Path<(String, String)>,
    Me(me): Me,
    body: Result<Json<ChannelEdit>, JsonRejection>,
) -> ApiResult {
    let who = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let (server, channel) = channel_names(&group, &channel)?;
    if body.name.is_none() && body.about.is_none() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "a name or an about"));
    }
    let name = match &body.name {
        Some(raw) => channel_names(&server, raw)?.1,
        None => channel.clone(),
    };
    let row: Option<ChannelRow> = sqlx::query_as(
        "SELECT c.name, c.about, c.created_by_id, maker.name, c.cooldown, c.kind, c.user_limit, c.home FROM channels c
         LEFT JOIN streamers maker ON maker.id = c.created_by_id
         WHERE c.server = $1 AND c.name = $2",
    )
    .bind(&server)
    .bind(&channel)
    .fetch_optional(&s.db)
    .await?;
    let Some((_, was_about, made_by_id, made_by, cooldown, kind, user_limit, home)) = row else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    };
    if made_by_id != Some(who.id) && !crate::group_mod::allows(&s, who.id, &server, crate::group_mod::CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your channel"));
    }
    let about = body.about.as_deref().map_or(was_about.clone(), clean_about);
    let view = json!(ChannelView {
        name: name.clone(),
        about: about.clone(),
        home,
        can_delete: !home,
        can_edit: true,
        made_by: made_by.filter(|_| !home),
        cooldown,
        kind: kind.clone(),
        user_limit,
    });
    let renaming = name != channel;
    if !renaming && about == was_about {
        return Ok(Json(view));
    }
    let old_room = format!("{server}/{channel}");
    let new_room = format!("{server}/{name}");
    let mut tx = s.db.begin().await?;
    let done = sqlx::query("UPDATE channels SET name = $3, about = $4 WHERE server = $1 AND name = $2")
        .bind(&server)
        .bind(&channel)
        .bind(&name)
        .bind(&about)
        .execute(&mut *tx)
        .await;
    match done {
        Ok(done) if done.rows_affected() == 0 => return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel")),
        Ok(_) => {}
        Err(e) if crate::unique_violation(&e) => return Err(ApiError::new(StatusCode::CONFLICT, "name taken")),
        Err(e) => return Err(e.into()),
    }
    if renaming {
        sqlx::query("UPDATE notifications SET room = $2 WHERE kind IN ('chat', 'mention') AND room = $1").bind(&old_room).bind(&new_room).execute(&mut *tx).await?;
        sqlx::query("UPDATE chat_lines SET room = $2 WHERE room = $1").bind(&old_room).bind(&new_room).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    if renaming {
        if kind == CHANNEL_KINDS[1] {
            if let Err(e) = crate::voice::follow_rename(&s, &server, &channel, &name).await {
                log::warn!("{old_room}: the seats were not moved to {new_room}: {}", e.message());
            }
        } else {
            let moved: Result<(), redis::RedisError> = redis::cmd("RENAME").arg(room_key(&old_room)).arg(room_key(&new_room)).query_async(&mut s.redis.clone()).await;
            if let Err(e) = moved {
                if e.to_string().contains("no such key") {
                    log::debug!("{old_room}: no lines to move");
                } else {
                    log::warn!("{old_room}: the stream was not moved to {new_room}: {e}");
                }
            }
        }
        log::info!("{}: renamed #{channel} in {server} to #{name}", who.name);
        tell(&s, &server, "channel_renamed", json!({ "channel": channel, "name": name })).await;
    }
    if about != was_about {
        log::info!("{}: changed the about of #{name} in {server}", who.name);
        tell(&s, &server, "channel_about", json!({ "channel": name, "about": about })).await;
    }
    Ok(Json(view))
}

async fn delete_channel(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(not_logged_in)?;
    let (server, channel) = channel_names(&group, &channel)?;
    let row: Option<(Option<Uuid>, bool)> = sqlx::query_as("SELECT created_by_id, home FROM channels WHERE server = $1 AND name = $2")
        .bind(&server)
        .bind(&channel)
        .fetch_optional(&s.db)
        .await?;
    let Some((made_channel, home)) = row else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    };
    if home {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "the home channel stays"));
    }
    if made_channel != Some(who.id) && !crate::group_mod::allows(&s, who.id, &server, crate::group_mod::CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your channel"));
    }
    let deleted = sqlx::query(
        "DELETE FROM channels c WHERE c.server = $1 AND c.name = $2
         AND (c.kind <> 'voice' OR EXISTS (SELECT 1 FROM channels o WHERE o.server = $1 AND o.name <> $2 AND o.kind = 'voice'))",
    )
    .bind(&server)
    .bind(&channel)
    .execute(&s.db)
    .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "the last voice channel stays"));
    }
    log::info!("{}: removed #{channel} from {server}", who.name);
    crate::voice::drop_channel_from_voice(&s, &server, Some(&channel)).await;
    tell(&s, &server, "unchannel", json!({ "channel": channel })).await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn muted_in(db: &PgPool, user: Option<Uuid>, server: &str) -> Result<Vec<String>, sqlx::Error> {
    let Some(user) = user else { return Ok(Vec::new()) };
    sqlx::query_scalar("SELECT channel FROM channel_mutes WHERE user_id = $1 AND server = $2 ORDER BY channel")
        .bind(user)
        .bind(server)
        .fetch_all(db)
        .await
}

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

async fn read_channel(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let (server, channel) = channel_names(&group, &channel)?;
    let room = notify::room_of(&server, &channel);
    if notify::channel_read(&s.db, me.id, &room).await? {
        presence::publish_chat_read(&mut s.redis.clone(), &me.name, &room).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn messages(State(s): State<AppState>, Path(group): Path<String>, Query(q): Query<MessagesQuery>, Me(me): Me) -> ApiResult {
    let server = group_name(&group)?;
    if server == BOT_GROUP {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "bot is not a server"));
    }
    let limit = q.limit.unwrap_or(MESSAGES_PER_CHANNEL).clamp(1, MESSAGES_PER_CHANNEL);
    let before = match (&q.before, &q.channel) {
        (Some(_), None) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "before needs a channel")),
        (Some(id), Some(_)) => Some(crate::history::stream_id(id)?),
        (None, _) => None,
    };
    let user = me.as_ref().map(|a| a.id);
    let admin = me.as_ref().is_some_and(|a| s.admins.iter().any(|admin| admin.id == a.id));
    let mut channels = visible_text_channels(&s.db, &server, user, admin).await?;
    if channels.is_empty() {
        return Err(no_such_group());
    }
    if let Some(one) = &q.channel {
        if !channels.contains(one) {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
        }
        channels = vec![one.clone()];
    }
    let top = before.map_or_else(|| "+".to_owned(), |id| format!("({id}"));
    let mut pipe = redis::pipe();
    for channel in &channels {
        pipe.cmd("XREVRANGE").arg(room_key(&format!("{server}/{channel}"))).arg(&top).arg("-").arg("COUNT").arg(limit);
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
    with_faces(&s.db, pages.iter_mut().flat_map(|(_, lines)| lines.iter_mut())).await;
    let rooms: Vec<String> = pages.iter().map(|(channel, _)| format!("{server}/{channel}")).collect();
    let mut all: Vec<(&str, &mut Line)> = Vec::new();
    for (room, (_, lines)) in rooms.iter().zip(pages.iter_mut()) {
        all.extend(lines.iter_mut().map(|l| (room.as_str(), l)));
    }
    crate::reactions::with_reactions(&s.db, user, all).await;
    let out: serde_json::Map<String, Value> = pages.into_iter().map(|(channel, lines)| (channel, json!(lines))).collect();
    Ok(Json(Value::Object(out)))
}

#[derive(Deserialize)]
struct MessagesQuery {
    limit: Option<usize>,
    channel: Option<String>,
    before: Option<String>,
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/explore", get(explore))
        .route("/api/groups", get(list).post(create))
        .route("/api/groups/{group}", get(crate::group_mod::room).delete(remove))
        .route("/api/groups/{group}/join", post(join))
        .route("/api/groups/{group}/leave", post(leave))
        .route("/api/groups/{group}/primary", put(set_primary).delete(clear_primary))
        .route("/api/groups/{group}/channels", post(create_channel).put(reorder_channels))
        .route("/api/groups/{group}/channels/{channel}", put(edit_channel).delete(delete_channel))
        .route("/api/groups/{group}/channels/{channel}/cooldown", put(set_channel_cooldown))
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
    fn a_channel_is_text_unless_it_asks_for_voice() {
        assert_eq!(channel_kind(None).unwrap(), "text");
        assert_eq!(channel_kind(Some("text")).unwrap(), "text");
        assert_eq!(channel_kind(Some("voice")).unwrap(), "voice");
        assert!(channel_kind(Some("video")).is_err());
        assert!(channel_kind(Some("Voice")).is_err());
        assert!(channel_kind(Some("")).is_err());
    }

    #[test]
    fn each_kind_has_its_own_cap() {
        assert_eq!(channels_full("voice", 3), None);
        assert_eq!(channels_full("voice", 4).as_deref(), Some("voice channels: 4 at most"));
        assert_eq!(channels_full("voice", 6).as_deref(), Some("voice channels: 4 at most"));
        assert_eq!(channels_full("text", 19), None);
        assert_eq!(channels_full("text", 20).as_deref(), Some("text channels: 20 at most"));
    }

    async fn group_with(pool: &PgPool, who: Uuid, name: &str, text: usize, voice: usize) {
        sqlx::query("INSERT INTO groups (name, badge, color, created_by_id) VALUES ($1, 'T', '#ffffff', $2)").bind(name).bind(who).execute(pool).await.unwrap();
        let kinds = std::iter::repeat("text").take(text).chain(std::iter::repeat("voice").take(voice));
        for (i, kind) in kinds.enumerate() {
            let channel = if i == 0 { GENERAL.to_string() } else { format!("{kind}-{i}") };
            sqlx::query("INSERT INTO channels (server, name, created_by_id, position, kind, home) VALUES ($1, $2, $3, $4, $5, $6)")
                .bind(name)
                .bind(&channel)
                .bind(who)
                .bind(i as i32)
                .bind(kind)
                .bind(i == 0)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    async fn count_of(pool: &PgPool, server: &str, kind: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM channels WHERE server = $1 AND kind = $2").bind(server).bind(kind).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn voice_channels_stop_at_four() {
        use axum::response::IntoResponse;
        let pool = crate::auth::tests::test_db().await;
        let run = std::process::id();
        let who = crate::auth::tests::row(&pool, &format!("vcap-{run}"), Some("hash")).await;

        let fresh = format!("vcap-new-{run}");
        group_with(&pool, who, &fresh, 1, 1).await;
        for i in 2..=4 {
            add_channel(&pool, &fresh, &format!("talk-{i}"), "", who, "voice").await.expect("under the cap");
        }
        let err = add_channel(&pool, &fresh, "talk-5", "", who, "voice").await.expect_err("past the cap");
        assert_eq!(err.message(), "voice channels: 4 at most");
        assert_eq!(err.into_response().status(), StatusCode::FORBIDDEN);
        assert_eq!(count_of(&pool, &fresh, "voice").await, 4);
        add_channel(&pool, &fresh, "clips", "", who, "text").await.expect("text is counted alone");
        let last: String = sqlx::query_scalar("SELECT name FROM channels WHERE server = $1 ORDER BY position DESC LIMIT 1").bind(&fresh).fetch_one(&pool).await.unwrap();
        assert_eq!(last, "clips");

        let old = format!("vcap-old-{run}");
        group_with(&pool, who, &old, 1, 6).await;
        let err = add_channel(&pool, &old, "talk-7", "", who, "voice").await.expect_err("over the cap already");
        assert_eq!(err.message(), "voice channels: 4 at most");
        assert_eq!(count_of(&pool, &old, "voice").await, 6, "nothing is deleted");

        let text = format!("vcap-text-{run}");
        group_with(&pool, who, &text, 19, 4).await;
        add_channel(&pool, &text, "twentieth", "", who, "text").await.expect("the 20th text channel");
        let err = add_channel(&pool, &text, "one-more", "", who, "text").await.expect_err("past 20 text");
        assert_eq!(err.message(), "text channels: 20 at most");
        assert_eq!(count_of(&pool, &text, "text").await, 20);

        let err = add_channel(&pool, &old, GENERAL, "", who, "text").await.expect_err("taken");
        assert_eq!(err.into_response().status(), StatusCode::CONFLICT);

        sqlx::query("DELETE FROM groups WHERE name = ANY($1)").bind(vec![fresh, old, text]).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(who).execute(&pool).await.unwrap();
    }

    #[test]
    fn a_badge_serialises_plainly() {
        let b = Badge { name: "bot".into(), badge: "BOT".into(), color: "#5865f2".into(), icon: None, about: None, members: None, banner: None };
        let text = serde_json::to_string(&vec![b.clone()]).unwrap();
        assert_eq!(text, r##"[{"name":"bot","badge":"BOT","color":"#5865f2"}]"##);
        assert_eq!(serde_json::from_str::<Vec<Badge>>(&text).unwrap(), vec![b]);
        let vip = Badge { name: "vip".into(), badge: "VIP".into(), color: "#ff00aa".into(), icon: Some(1_700_000_000), about: None, members: None, banner: None };
        let text = serde_json::to_string(&vip).unwrap();
        assert_eq!(text, r##"{"name":"vip","badge":"VIP","color":"#ff00aa","icon":1700000000}"##);
        assert_eq!(serde_json::from_str::<Badge>(&text).unwrap(), vip);
        let card = Badge { about: Some("the vips".into()), members: Some(12), banner: Some(1_700_000_001), ..vip };
        let text = serde_json::to_string(&card).unwrap();
        assert_eq!(text, r##"{"name":"vip","badge":"VIP","color":"#ff00aa","icon":1700000000,"about":"the vips","members":12,"banner":1700000001}"##);
        assert_eq!(serde_json::from_str::<Badge>(&text).unwrap(), card);
        let row: BadgeRow = ("x".into(), "X".into(), "#000000".into(), None, String::new(), 3, None);
        assert_eq!(Badge::from(row).about, None);
    }
}
