//! Groups: a login joins one, and its chat lines wear the group's badge. See docs/groups.md.
//!
//! A group is a name, a short badge, a colour and a line about it. Any login may make a
//! few, be in a few, and delete the ones it made. One is built in and automatic: `bot`.
//! Nobody joins it; a chat socket whose hello says `bot: true` wears it (chat.rs), so the
//! pretend chatters of the fake streams can be told apart, and hidden, in the panel.
//!
//! Badges travel on the chat line itself (`groups`: name, badge, colour, as they were when
//! the line was said), so drawing a room needs no lookup here.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;

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

/// What a chat line carries for each group its speaker is in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Badge {
    pub(crate) name: String,
    pub(crate) badge: String,
    pub(crate) color: String,
}

/// The badges `name` wears: its groups' in the order joined, with `bot` first when the
/// socket said so. One query. An anonymous nick passes "" and matches no membership.
pub(crate) async fn badges_of(db: &PgPool, name: &str, bot: bool) -> Result<Vec<Badge>, sqlx::Error> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color FROM groups g
         LEFT JOIN memberships m ON m.group_name = g.name AND m.name = $1
         WHERE (g.name = $2 AND $3) OR m.name IS NOT NULL
         ORDER BY g.name = $2 DESC, m.joined_at",
    )
    .bind(name)
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

/// How many groups `name` is in. The cap says when joining one more is one too many.
async fn member_of(db: &PgPool, name: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM memberships WHERE name = $1").bind(name).fetch_one(db).await
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
/// and, for a login, whether it is one of them.
async fn list(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<GroupRow> = sqlx::query_as(
        "SELECT g.name, g.badge, g.color, g.about, g.created_by,
                (SELECT count(*) FROM memberships m WHERE m.group_name = g.name),
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_name = g.name AND m.name = $1)
         FROM groups g
         ORDER BY g.name = $2 DESC, g.created_at, g.name",
    )
    .bind(me.as_deref().unwrap_or(""))
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
    let made: i64 = sqlx::query_scalar("SELECT count(*) FROM groups WHERE created_by = $1").bind(&maker).fetch_one(&s.db).await?;
    if made >= GROUPS_PER_MAKER {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("you have made {GROUPS_PER_MAKER} groups already. delete one first")));
    }
    if member_of(&s.db, &maker).await? >= GROUPS_PER_MEMBER {
        return Err(too_many_groups());
    }
    // the group and its first member in one statement: no group without its maker in it
    let made: Option<String> = sqlx::query_scalar(
        "WITH g AS (
            INSERT INTO groups (name, badge, color, about, created_by) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (name) DO NOTHING RETURNING name
         )
         INSERT INTO memberships (name, group_name) SELECT $5, name FROM g RETURNING group_name",
    )
    .bind(&name)
    .bind(&badge)
    .bind(&color)
    .bind(&about)
    .bind(&maker)
    .fetch_optional(&s.db)
    .await?;
    if made.is_none() {
        return Err(ApiError::new(StatusCode::CONFLICT, "name taken"));
    }
    log::info!("{maker}: made the group {name} ({badge})");
    Ok((StatusCode::CREATED, Json(group_json((name, badge, color, about, Some(maker), 1, true)))))
}

/// `POST /api/groups/:group/join`: 204, also when already in it. 401 for nobody, 404 for no
/// such group, 403 for `bot` (automatic) and past the cap.
async fn join(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let name = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    if group == BOT_GROUP {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "bot is automatic: a bot's chat socket says so. nobody joins it"));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&group).fetch_one(&s.db).await?;
    if !exists {
        return Err(no_such_group());
    }
    let already: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE name = $1 AND group_name = $2)")
        .bind(&name)
        .bind(&group)
        .fetch_one(&s.db)
        .await?;
    if already {
        return Ok(StatusCode::NO_CONTENT);
    }
    if member_of(&s.db, &name).await? >= GROUPS_PER_MEMBER {
        return Err(too_many_groups());
    }
    sqlx::query("INSERT INTO memberships (name, group_name) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&name)
        .bind(&group)
        .execute(&s.db)
        .await?;
    log::info!("{name}: joined {group}");
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/groups/:group/leave`: 204, also when not in it. 401 for nobody.
async fn leave(State(s): State<AppState>, Path(group): Path<String>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let name = me.ok_or_else(not_logged_in)?;
    let group = group_name(&group)?;
    let done = sqlx::query("DELETE FROM memberships WHERE name = $1 AND group_name = $2")
        .bind(&name)
        .bind(&group)
        .execute(&s.db)
        .await?;
    if done.rows_affected() > 0 {
        log::info!("{name}: left {group}");
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
    let made_by: Option<Option<String>> = sqlx::query_scalar("SELECT created_by FROM groups WHERE name = $1").bind(&group).fetch_optional(&s.db).await?;
    let Some(made_by) = made_by else { return Err(no_such_group()) };
    if made_by.as_deref() != Some(who.as_str()) && !s.admin_names.contains(&who) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not your group"));
    }
    sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&s.db).await?;
    log::info!("{who}: deleted the group {group}");
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/groups", get(list).post(create))
        .route("/api/groups/{group}", delete(remove))
        .route("/api/groups/{group}/join", post(join))
        .route("/api/groups/{group}/leave", post(leave))
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
    fn a_badge_serialises_plainly() {
        let b = Badge { name: "bot".into(), badge: "BOT".into(), color: "#5865f2".into() };
        let text = serde_json::to_string(&vec![b.clone()]).unwrap();
        assert_eq!(text, r##"[{"name":"bot","badge":"BOT","color":"#5865f2"}]"##);
        assert_eq!(serde_json::from_str::<Vec<Badge>>(&text).unwrap(), vec![b]);
    }
}
