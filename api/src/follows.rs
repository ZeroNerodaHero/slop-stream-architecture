//! Follows: a login follows a name, and the panel in the corner says which of them are
//! streaming, and how the rest are. See docs/follows.md.
//!
//! One table of edges, `follows (follower_id, followed_id)`, both row ids (docs/ids.md): a
//! renamed name keeps its followers, and the routes still speak names like everything else.
//! The follower is a login (an edge needs an id with a person behind it); the followed is
//! any valid name, claimed or free, and a name with no row gets a bare one so there is an
//! id to point at, the way a bio does. Counts are public, the list is the login's own.
//!
//! `GET /api/search?q=` finds names to follow: every streamers row whose name contains the
//! letters, the exact one first, then the ones that start with them.

use std::collections::{HashMap, HashSet};

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{bump, Me};
use crate::presence::{self, Presence, Status, SEEN_WINDOW_MS};
use crate::{redis_live, video_live, ApiError, ApiResult, AppState, Name};

/// Names one login may follow. More than anyone watches.
const FOLLOWS_PER_LOGIN: i64 = 500;
/// Follows and unfollows per login per hour: a loop on one button must not write a row a second.
const CHURN_PER_HOUR: i64 = 120;
const CHURN_WINDOW_SECS: i64 = 3600;
/// Search answers this many at most: the box is for finding one person, not listing everyone.
const SEARCH_LIMIT: i64 = 20;
/// Home's people: this many rows looked at (accounts first, newest change first), this many shown
/// after the live ones are taken out and the rest sorted online first.
const PEOPLE_SCAN: i64 = 300;
const PEOPLE_LIMIT: usize = 100;

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

// ---- what the rest of the api asks ------------------------------------------------------------

/// How many follow `name`, and does `me` (a login's row id, or nobody): the two fields every
/// profile read carries. One round trip.
pub(crate) async fn stats(db: &PgPool, name: &str, me: Option<Uuid>) -> Result<(i64, bool), sqlx::Error> {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM follows f JOIN streamers s ON s.id = f.followed_id WHERE s.name = $1),
                EXISTS (SELECT 1 FROM follows f JOIN streamers s ON s.id = f.followed_id WHERE s.name = $1 AND f.follower_id = $2)",
    )
    .bind(name)
    .bind(me)
    .fetch_one(db)
    .await
}

// ---- the words, for a list of names ----------------------------------------------------------

/// `live` and the presence word of every name in one go: video's set once (else the keys), one
/// pipelined `ZCOUNT` per name, one `SELECT` for every status. The rule is presence.rs's; this
/// is the same answer `GET /api/streamers/:name` gives, n times for the price of three round trips.
async fn words(s: &AppState, names: &[String]) -> Result<HashMap<String, (bool, Presence)>, ApiError> {
    let mut out = HashMap::new();
    if names.is_empty() {
        return Ok(out);
    }
    let live: HashSet<String> = match video_live(s).await {
        Some(connected) => connected,
        None => redis_live(s).await?.into_iter().collect(),
    };
    let mut r = s.redis.clone();
    let floor = presence::now_ms() - SEEN_WINDOW_MS;
    let mut pipe = redis::pipe();
    for name in names {
        pipe.zcount(presence::seen_key(name), floor, "+inf");
    }
    let here: Vec<i64> = pipe.query_async(&mut r).await?;
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT name, status FROM streamers WHERE name = ANY($1)")
        .bind(names)
        .fetch_all(&s.db)
        .await?;
    let status: HashMap<String, Status> = rows.into_iter().map(|(n, raw)| (n, Status::parse(&raw).unwrap_or_default())).collect();
    for (i, name) in names.iter().enumerate() {
        let is_live = live.contains(name);
        let is_here = here.get(i).copied().unwrap_or(0) > 0;
        let word = presence::derive(is_live, is_here, status.get(name).copied().unwrap_or_default());
        out.insert(name.clone(), (is_live, word));
    }
    Ok(out)
}

/// Streaming first, then online, do not disturb, offline; inside a word, as the rows came.
fn rank(word: Presence) -> u8 {
    match word {
        Presence::Streaming => 0,
        Presence::Online => 1,
        Presence::Dnd => 2,
        Presence::Offline => 3,
    }
}

/// name, verified, avatar, bio, followed_at, mutual (that name follows this login back: a friend)
type FollowedRow = (String, bool, Option<i64>, String, DateTime<Utc>, bool);

// ---- the routes -------------------------------------------------------------------------------

/// `POST /api/streamers/:name/follow`: 204, also when already. The followed name's row is made
/// bare when it has none, in the one statement with the edge.
async fn follow(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    if name == me.name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that is you"));
    }
    if bump(&s, &format!("rl:follow:name:{}", me.name), CHURN_WINDOW_SECS).await? > CHURN_PER_HOUR {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many changes. wait an hour"));
    }
    let (_, already) = stats(&s.db, &name, Some(me.id)).await?;
    if already {
        return Ok(StatusCode::NO_CONTENT);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM follows WHERE follower_id = $1").bind(me.id).fetch_one(&s.db).await?;
    if count >= FOLLOWS_PER_LOGIN {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("you follow {FOLLOWS_PER_LOGIN} names already. unfollow one first")));
    }
    // the DO UPDATE is the idiom that makes RETURNING answer for a row already there
    let made: Option<Uuid> = sqlx::query_scalar(
        "WITH named AS (
            INSERT INTO streamers (name) VALUES ($2)
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
         )
         INSERT INTO follows (follower_id, followed_id) SELECT $1, id FROM named ON CONFLICT DO NOTHING RETURNING followed_id",
    )
    .bind(me.id)
    .bind(&name)
    .fetch_optional(&s.db)
    .await?;
    if made.is_some() {
        log::info!("{}: follows {name}", me.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/streamers/:name/unfollow`: 204, also when not following.
async fn unfollow(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    if bump(&s, &format!("rl:follow:name:{}", me.name), CHURN_WINDOW_SECS).await? > CHURN_PER_HOUR {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many changes. wait an hour"));
    }
    let done = sqlx::query("DELETE FROM follows f USING streamers s WHERE s.id = f.followed_id AND f.follower_id = $1 AND s.name = $2")
        .bind(me.id)
        .bind(&name)
        .execute(&s.db)
        .await?;
    if done.rows_affected() > 0 {
        log::info!("{}: unfollows {name}", me.name);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn followed_json((name, verified, avatar, bio, followed_at, mutual): &FollowedRow, live: bool, word: Presence) -> Value {
    json!({ "name": name, "verified": verified, "avatar": avatar, "bio": bio, "live": live, "presence": word, "followed_at": followed_at, "mutual": mutual })
}

/// `GET /api/following`: the login's, streaming first, then by how they are, then newest follow first.
/// `mutual` is the other edge: they follow this login too. Nothing stores "friends"; the join is the list.
async fn following(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let rows: Vec<FollowedRow> = sqlx::query_as(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio, f.followed_at,
                EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = s.id AND b.followed_id = $1)
         FROM follows f JOIN streamers s ON s.id = f.followed_id
         WHERE f.follower_id = $1
         ORDER BY f.followed_at DESC",
    )
    .bind(me.id)
    .fetch_all(&s.db)
    .await?;
    let names: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let words = words(&s, &names).await?;
    let mut list: Vec<(u8, usize, Value)> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let (live, word) = words.get(&row.0).copied().unwrap_or((false, Presence::Offline));
            (rank(word), i, followed_json(row, live, word))
        })
        .collect();
    list.sort_by_key(|(r, i, _)| (*r, *i));
    Ok(Json(Value::Array(list.into_iter().map(|(_, _, v)| v).collect())))
}

#[derive(Deserialize, Default)]
struct SearchQuery {
    #[serde(default)]
    q: String,
}

/// The letters a search may hold: the name rule's, lowercased. Anything else is dropped, so
/// `Alice!` finds `alice` and nothing is a wildcard (`position`, not `LIKE`, so `_` is a letter).
fn clean_query(raw: &str) -> String {
    raw.trim().to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-').take(32).collect()
}

/// name, verified, avatar, bio, following
type HitRow = (String, bool, Option<i64>, String, bool);

/// `GET /api/search?q=ali`: names holding the letters, the exact name first, then the ones that
/// start with them, accounts before free names, 20 at most. `following` is for the login.
async fn search(State(s): State<AppState>, Me(me): Me, q: Result<Query<SearchQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let q = clean_query(&q.q);
    if q.is_empty() {
        return Ok(Json(json!([])));
    }
    let rows: Vec<HitRow> = sqlx::query_as(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followed_id = s.id)
         FROM streamers s
         WHERE position($1 in s.name) > 0
         ORDER BY s.name = $1 DESC, starts_with(s.name, $1) DESC, (s.password_hash IS NOT NULL) DESC, s.name
         LIMIT $3",
    )
    .bind(&q)
    .bind(me.as_ref().map(|a| a.id))
    .bind(SEARCH_LIMIT)
    .fetch_all(&s.db)
    .await?;
    let names: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let words = words(&s, &names).await?;
    let out = rows.into_iter().map(|(name, verified, avatar, bio, following)| {
        let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
        json!({ "name": name, "verified": verified, "avatar": avatar, "bio": bio, "live": live, "presence": word, "following": following })
    });
    Ok(Json(Value::Array(out.collect())))
}

/// `GET /api/people`: everyone with a row who is not live right now, as home's second half
/// (the live ones are its cards). Online first, then do not disturb, then offline; inside a
/// word, accounts before free names, the newest change first. The fake streams are people
/// too, when they are not live. 100 at most. `following` is for the login.
async fn people(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<HitRow> = sqlx::query_as(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id)
         FROM streamers s
         ORDER BY (s.password_hash IS NOT NULL) DESC, s.updated_at DESC
         LIMIT $2",
    )
    .bind(me.as_ref().map(|a| a.id))
    .bind(PEOPLE_SCAN)
    .fetch_all(&s.db)
    .await?;
    let names: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let words = words(&s, &names).await?;
    let mut list: Vec<(u8, usize, Value)> = rows
        .into_iter()
        .enumerate()
        .filter_map(|(i, (name, verified, avatar, bio, following))| {
            let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
            if live {
                return None;
            }
            Some((rank(word), i, json!({ "name": name, "verified": verified, "avatar": avatar, "bio": bio, "presence": word, "following": following })))
        })
        .collect();
    list.sort_by_key(|(r, i, _)| (*r, *i));
    list.truncate(PEOPLE_LIMIT);
    Ok(Json(Value::Array(list.into_iter().map(|(_, _, v)| v).collect())))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/streamers/{name}/follow", post(follow))
        .route("/api/streamers/{name}/unfollow", post(unfollow))
        .route("/api/following", get(following))
        .route("/api/search", get(search))
        .route("/api/people", get(people))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_keep_the_name_letters() {
        assert_eq!(clean_query(" Ali ce! "), "alice");
        assert_eq!(clean_query("a_b-c"), "a_b-c");
        assert_eq!(clean_query("%"), "");
        assert_eq!(clean_query(&"x".repeat(40)).len(), 32);
    }

    #[test]
    fn streaming_sorts_first() {
        assert!(rank(Presence::Streaming) < rank(Presence::Online));
        assert!(rank(Presence::Online) < rank(Presence::Dnd));
        assert!(rank(Presence::Dnd) < rank(Presence::Offline));
    }
}
