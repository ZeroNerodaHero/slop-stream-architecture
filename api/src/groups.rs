//! Groups: a login joins one, and its chat lines wear the group's badge. See docs/groups.md.
//!
//! A group is a name, a short badge, a colour and a line about it. Any login may make a
//! few, be in a few, and delete the ones it made. One is built in and automatic: `bot`.
//! Nobody joins it; a chat socket whose hello says `bot: true` wears it (chat.rs), so the
//! pretend chatters of the fake streams can be told apart, and hidden, in the panel.
//!
//! Every other group is also a server. It starts with a channel called `general`, and a
//! member can add more. The explorer lists them; the room is `/chat/<server>/<channel>`.
//!
//! Badges travel on the chat line itself (`groups`: name, badge, colour, as they were when
//! the line was said), so drawing a room needs no lookup here.

use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Me;
use crate::chat::clean_text;
use crate::{valid_name, ApiError, ApiResult, AppState};

/// The automatic group. Seeded by the schema, joined by nobody, worn by a bot's socket.
pub(crate) const BOT_GROUP: &str = "bot";
/// A badge is a word, not a sentence: `BOT`, `VIP`, `mod`. The panel shows it in capitals.
const MAX_BADGE_CHARS: usize = 12;
const MAX_ABOUT_CHARS: usize = 200;
/// Groups one login may make, and be in. Every badge goes on every line, so both are capped.
const GROUPS_PER_MAKER: i64 = 10;
const GROUPS_PER_MEMBER: i64 = 8;
/// Channels on one server, `general` included.
const CHANNELS_PER_SERVER: i64 = 20;
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
fn group_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_lowercase();
    if valid_name(&name) {
        Ok(name)
    } else {
        Err(ApiError::bad_name())
    }
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
fn clean_color(raw: &str) -> Result<String, ApiError> {
    let color = raw.trim().to_lowercase();
    let hex = color.strip_prefix('#').unwrap_or("");
    if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(color)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "color: #rrggbb"))
    }
}

fn clean_about(raw: &str) -> String {
    clean_text(raw).chars().take(MAX_ABOUT_CHARS).collect()
}

/// How many groups an account is in. The cap says when joining one more is one too many.
async fn member_of(db: &PgPool, user: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE user_id = $1").bind(user).fetch_one(db).await
}

fn too_many_groups() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, format!("you are in {GROUPS_PER_MEMBER} groups already. leave one first"))
}

// ---- routes ----------------------------------------------------------------------------

/// name, badge, color, about, made_by, members, mine
type GroupRow = (String, String, String, String, Option<String>, i64, bool);

fn group_json((name, badge, color, about, made_by, members, mine): GroupRow) -> Value {
    json!({
        "name": name,
        "badge": badge,
        "color": color,
        "about": about,
        "made_by": made_by,
        "members": members,
        "mine": mine,
        "automatic": name == BOT_GROUP,
    })
}

/// `GET /api/groups`: every group, `bot` first, then oldest first; how many are in each
/// and, for a login, whether it is one of them. `made_by` is the maker's name as it is
/// now, by the id: a renamed maker reads right everywhere.
async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<GroupRow> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color, g.about, maker.name,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1)
         FROM groups g
         LEFT JOIN streamers maker ON maker.id = g.created_by_id
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
}

/// `POST /api/groups`: a login makes a group and is in it. 201 with the group as the list
/// shows it. 400 for a bad name, badge or colour; 409 `name taken` (`bot` included).
async fn create(State(s): State<AppState>, Me(me): Me, body: Result<Json<NewGroup>, JsonRejection>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let maker = me.ok_or_else(not_logged_in)?;
    let Json(body) = body?;
    let name = group_name(&body.name)?;
    let badge = clean_badge(&body.badge)?;
    let color = clean_color(&body.color)?;
    let about = clean_about(&body.about);
    let made: i64 = sqlx::query_scalar("SELECT count(*) FROM groups WHERE created_by_id = $1").bind(maker.id).fetch_one(&s.db).await?;
    if made >= GROUPS_PER_MAKER {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("you have made {GROUPS_PER_MAKER} groups already. delete one first")));
    }
    if member_of(&s.db, maker.id).await? >= GROUPS_PER_MEMBER {
        return Err(too_many_groups());
    }
    // the group, its first member, and its first channel in one statement: no server
    // without `general`, and no group without its maker in it.
    // the id is the key; the name columns are written while they exist (docs/ids.md)
    let made: Option<String> = sqlx::query_scalar(
        "WITH g AS (
            INSERT INTO groups (name, badge, color, about, created_by, created_by_id) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (name) DO NOTHING RETURNING name
         ),
         c AS (
            INSERT INTO channels (server, name, about, created_by_id)
            SELECT name, 'general', '', $6 FROM g RETURNING server
         )
         INSERT INTO memberships (name, group_name, user_id)
         SELECT $5, g.name, $6 FROM g JOIN c ON c.server = g.name RETURNING group_name",
    )
    .bind(&name)
    .bind(&badge)
    .bind(&color)
    .bind(&about)
    .bind(&maker.name)
    .bind(maker.id)
    .fetch_optional(&s.db)
    .await?;
    if made.is_none() {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    log::info!("{}: made the group {name} ({badge})", maker.name);
    Ok((StatusCode::CREATED, Json(group_json((name, badge, color, about, Some(maker.name), 1, true)))))
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
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/groups/:group/leave`: 204, also when not in it. 401 for nobody.
async fn leave(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    let done = sqlx::query("DELETE FROM memberships WHERE user_id = $1 AND group_name = $2")
        .bind(me.id)
        .bind(&group)
        .execute(&s.db)
        .await?;
    if done.rows_affected() > 0 {
        log::info!("{}: left {group}", me.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/groups/:group`: the one who made it, or an admin (`ADMIN_NAMES`). 204; its
/// members are out with it. 401 for nobody, 403 `not your group` and for `bot`, 404.
async fn remove(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    if group == BOT_GROUP {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "bot is built in"));
    }
    let made_by: Option<Option<Uuid>> = sqlx::query_scalar("SELECT created_by_id FROM groups WHERE name = $1").bind(&group).fetch_optional(&s.db).await?;
    let Some(made_by) = made_by else { return Err(no_such_group()) };
    if made_by != Some(who.id) && !s.admins.iter().any(|a| a.id == who.id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your group"));
    }
    sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&s.db).await?;
    log::info!("{}: deleted the group {group}", who.name);
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
struct ChannelView {
    name: String,
    about: String,
    can_delete: bool,
}

#[derive(Serialize)]
struct ServerView {
    name: String,
    badge: String,
    color: String,
    about: String,
    members: i64,
    mine: bool,
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

/// `GET /api/explore`: every server (not `bot`), split into the ones this login is in and
/// the rest. Inside each, a server with someone live comes first. `live` is those members'
/// names. Channels oldest first, `general` first because it was made with the group.
async fn explore(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let user = me.as_ref().map(|a| a.id);
    let admin = me.as_ref().is_some_and(|a| s.admins.iter().any(|admin| admin.id == a.id));
    let mut living = live_members(&s.db, &live_names(&s).await?).await?;
    // name, badge, color, about, members, mine, channel, channel about, can delete
    let rows: Vec<(String, String, String, String, i64, bool, Option<String>, Option<String>, bool)> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color, g.about,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.user_id = $1),
                c.name, c.about,
                COALESCE(c.name IS NOT NULL AND c.name <> 'general'
                    AND (c.created_by_id = $1 OR g.created_by_id = $1 OR $2), false)
         FROM groups g
         LEFT JOIN channels c ON c.server = g.name
         WHERE g.name <> $3
         ORDER BY g.created_at, g.name, c.created_at NULLS LAST, c.name",
    )
    .bind(user)
    .bind(admin)
    .bind(BOT_GROUP)
    .fetch_all(&s.db)
    .await?;
    let mut servers: Vec<ServerView> = Vec::new();
    for (name, badge, color, about, members, mine, channel, channel_about, can_delete) in rows {
        if servers.last().is_none_or(|server| server.name != name) {
            let live = living.remove(&name).unwrap_or_default();
            servers.push(ServerView { name, badge, color, about, members, mine, live, channels: Vec::new() });
        }
        if let Some(name) = channel {
            servers.last_mut().unwrap().channels.push(ChannelView { name, about: channel_about.unwrap_or_default(), can_delete });
        }
    }
    let (yours, discover): (Vec<ServerView>, Vec<ServerView>) = servers.into_iter().partition(|server| server.mine);
    Ok(Json(json!({ "yours": live_first(yours), "discover": live_first(discover) })))
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
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM channels WHERE server = $1").bind(&server).fetch_one(&s.db).await?;
    if n >= CHANNELS_PER_SERVER {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("this server has {CHANNELS_PER_SERVER} channels already")));
    }
    let added = sqlx::query(
        "INSERT INTO channels (server, name, about, created_by_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
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
    Ok((StatusCode::CREATED, Json(json!({ "name": channel, "about": about, "can_delete": channel != GENERAL }))))
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
    let Some((made_channel, made_server)) = row else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such channel"));
    };
    let admin = s.admins.iter().any(|a| a.id == who.id);
    if made_channel != Some(who.id) && made_server != Some(who.id) && !admin {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your channel"));
    }
    sqlx::query("DELETE FROM channels WHERE server = $1 AND name = $2").bind(&server).bind(&channel).execute(&s.db).await?;
    log::info!("{}: removed #{channel} from {server}", who.name);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/explore", get(explore))
        .route("/api/groups", get(list).post(create))
        .route("/api/groups/{group}", delete(remove))
        .route("/api/groups/{group}/join", post(join))
        .route("/api/groups/{group}/leave", post(leave))
        .route("/api/groups/{group}/channels", post(create_channel))
        .route("/api/groups/{group}/channels/{channel}", delete(delete_channel))
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
