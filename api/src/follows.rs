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

use crate::auth::{self, bump, Me};
use crate::notify;
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
/// Home's recently offline: this many of the names whose last stream ended most recently looked
/// at, this many shown after the ones live again are taken out.
const RECENT_SCAN: i64 = 40;
const RECENT_LIMIT: usize = 12;

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

// ---- what the rest of the api asks ------------------------------------------------------------

/// Do `a` and `b` follow each other: friends, in the sidebar's word. What a direct message
/// (dms.rs) asks before a line is kept. One probe of each index.
pub(crate) async fn friends(db: &PgPool, a: Uuid, b: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2)
            AND EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followed_id = $1)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(db)
    .await
}

/// The follow facts of one name as a reader sees them: `stats`'s answer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Stats {
    /// How many follow the name. Public.
    pub(crate) followers: i64,
    /// The asking login follows it. False for nobody.
    pub(crate) following: bool,
    /// The name follows the asking login: with `following`, a friend. False for nobody.
    pub(crate) follows_you: bool,
}

/// How many follow `name`, does `me` (a login's row id, or nobody) follow it, and does it
/// follow `me`: what every profile read carries. One round trip.
pub(crate) async fn stats(db: &PgPool, name: &str, me: Option<Uuid>) -> Result<Stats, sqlx::Error> {
    let (followers, following, follows_you) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM follows f JOIN streamers s ON s.id = f.followed_id WHERE s.name = $1),
                EXISTS (SELECT 1 FROM follows f JOIN streamers s ON s.id = f.followed_id WHERE s.name = $1 AND f.follower_id = $2),
                EXISTS (SELECT 1 FROM follows f JOIN streamers s ON s.id = f.follower_id WHERE s.name = $1 AND f.followed_id = $2)",
    )
    .bind(name)
    .bind(me)
    .fetch_one(db)
    .await?;
    Ok(Stats { followers, following, follows_you })
}

// ---- the words, for a list of names ----------------------------------------------------------

/// `live` and the presence word of every name in one go. Each name comes with the choice its
/// row holds, read by the caller's own query (the list already joins `streamers`; nothing reads
/// it twice). Then video's set once (else the keys) and one pipelined `ZCOUNT` per name, the two
/// asked at the same time. The rule is presence.rs's; this is the same answer
/// `GET /api/streamers/:name` gives, n times for the price of one round trip. The list of
/// direct message threads (dms.rs) draws its faces with the same call.
pub(crate) async fn words(s: &AppState, people: &[(String, Status)]) -> Result<HashMap<String, (bool, Presence)>, ApiError> {
    let mut out = HashMap::new();
    if people.is_empty() {
        return Ok(out);
    }
    let live = async {
        Ok::<HashSet<String>, ApiError>(match video_live(s).await {
            Some(connected) => connected,
            None => redis_live(s).await?.into_iter().collect(),
        })
    };
    let here = async {
        let mut r = s.redis.clone();
        let floor = presence::now_ms() - SEEN_WINDOW_MS;
        let mut pipe = redis::pipe();
        for (name, _) in people {
            pipe.zcount(presence::seen_key(name), floor, "+inf");
        }
        let here: Vec<i64> = pipe.query_async(&mut r).await?;
        Ok::<_, ApiError>(here)
    };
    let (live, here) = tokio::join!(live, here);
    let (live, here) = (live?, here?);
    for (i, (name, status)) in people.iter().enumerate() {
        let is_live = live.contains(name);
        let is_here = here.get(i).copied().unwrap_or(0) > 0;
        out.insert(name.clone(), (is_live, presence::derive(is_live, is_here, *status)));
    }
    Ok(out)
}

/// A row's status column as the choice it names: `online` for a row older than the column (its
/// default), `status_of`'s rule. With the name, what `words` wants.
pub(crate) fn choice(name: &str, raw: &str) -> (String, Status) {
    (name.to_owned(), Status::parse(raw).unwrap_or_default())
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

/// name, verified, avatar, bio, followed_at, mutual (that name follows this login back: a friend), status
type FollowedRow = (String, bool, Option<i64>, String, DateTime<Utc>, bool, String);

// ---- the routes -------------------------------------------------------------------------------

/// `POST /api/streamers/:name/follow`: 204, also when already. A name held after a rename is
/// followed as the account that holds it. The followed name's row is made bare when it has
/// none, in the one statement with the edge.
async fn follow(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    if bump(&s, &format!("rl:follow:name:{}", me.name), CHURN_WINDOW_SECS).await? > CHURN_PER_HOUR {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many changes. wait an hour"));
    }
    // a new edge is news to the one followed, when they are a login (docs/notifications.md)
    if let Some((followed, followed_name)) = follow_as(&s.db, me.id, &me.name, name).await? {
        notify::followed(&s, followed, &followed_name, &me).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The follow itself, for the login `me_id` named `me_name`: all of it but the churn limit,
/// which needs redis. On the pool alone so a test can run it. The followed row's id and the
/// name it has now when the edge is new; None when it was there already.
async fn follow_as(db: &PgPool, me_id: Uuid, me_name: &str, name: String) -> Result<Option<(Uuid, String)>, ApiError> {
    // a name held after a rename is the account that left it: the edge goes to the person, as
    // the watch grant does (docs/ids.md). a name with no row and no hold gets a bare one below
    let name = auth::renamed_to(db, &name).await?.unwrap_or(name);
    if name == me_name {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "that is you"));
    }
    if stats(db, &name, Some(me_id)).await?.following {
        return Ok(None);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM follows WHERE follower_id = $1").bind(me_id).fetch_one(db).await?;
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
    .bind(me_id)
    .bind(&name)
    .fetch_optional(db)
    .await?;
    if made.is_some() {
        log::info!("{me_name}: follows {name}");
    }
    Ok(made.map(|id| (id, name)))
}

/// `POST /api/streamers/:name/unfollow`: 204, also when not following.
async fn unfollow(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    // the name the follow went to: a stale unfollow of a held name ends the edge to the account
    let name = auth::renamed_to(&s.db, &name).await?.unwrap_or(name);
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

fn followed_json((name, verified, avatar, bio, followed_at, mutual, _): &FollowedRow, live: bool, word: Presence) -> Value {
    json!({ "name": name, "verified": verified, "avatar": avatar, "bio": bio, "live": live, "presence": word, "followed_at": followed_at, "mutual": mutual })
}

/// `GET /api/following`: the login's, streaming first, then by how they are, then newest follow first.
/// `mutual` is the other edge: they follow this login too. Nothing stores "friends"; the join is the list.
async fn following(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let rows: Vec<FollowedRow> = sqlx::query_as(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio, f.followed_at,
                EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = s.id AND b.followed_id = $1), s.status
         FROM follows f JOIN streamers s ON s.id = f.followed_id
         WHERE f.follower_id = $1
         ORDER BY f.followed_at DESC",
    )
    .bind(me.id)
    .fetch_all(&s.db)
    .await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.6)).collect();
    let words = words(&s, &people).await?;
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

/// name, verified, avatar, bio, following, status
type HitRow = (String, bool, Option<i64>, String, bool, String);

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
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followed_id = s.id), s.status
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
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let out = rows.into_iter().map(|(name, verified, avatar, bio, following, _)| {
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
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id), s.status
         FROM streamers s
         ORDER BY (s.password_hash IS NOT NULL) DESC, s.updated_at DESC
         LIMIT $2",
    )
    .bind(me.as_ref().map(|a| a.id))
    .bind(PEOPLE_SCAN)
    .fetch_all(&s.db)
    .await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let mut list: Vec<(u8, usize, Value)> = rows
        .into_iter()
        .enumerate()
        .filter_map(|(i, (name, verified, avatar, bio, following, _))| {
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

/// name, verified, avatar, bio, following, status, ended_at
type RecentRow = (String, bool, Option<i64>, String, bool, String, DateTime<Utc>);

/// `GET /api/recent`: the names whose last stream ended most recently, as home's recently
/// offline (under the live cards, before the people), newest end first, 12 at most. A row's
/// streams are its account's (`user_id`, so a rename keeps them under the name it has now) or,
/// for a free name, the name's; a stranger's stream under a name an account took later is
/// nobody's, `list_sessions`'s rule. One live again is not offline and is left out. `ended_at`
/// is when the last stream ended; `following` is for the login.
async fn recent(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<RecentRow> = sqlx::query_as(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id), s.status, last.ended_at
         FROM (
             SELECT s.id, max(se.ended_at) AS ended_at
             FROM sessions se
             JOIN streamers s ON s.id = se.user_id OR (se.user_id IS NULL AND s.name = se.name AND s.password_hash IS NULL)
             WHERE se.ended_at IS NOT NULL
             GROUP BY s.id
         ) last
         JOIN streamers s ON s.id = last.id
         ORDER BY last.ended_at DESC
         LIMIT $2",
    )
    .bind(me.as_ref().map(|a| a.id))
    .bind(RECENT_SCAN)
    .fetch_all(&s.db)
    .await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let out = rows.into_iter().filter_map(|(name, verified, avatar, bio, following, _, ended_at)| {
        let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
        if live {
            return None;
        }
        Some(json!({ "name": name, "verified": verified, "avatar": avatar, "bio": bio, "presence": word, "following": following, "ended_at": ended_at }))
    });
    Ok(Json(Value::Array(out.take(RECENT_LIMIT).collect())))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/streamers/{name}/follow", post(follow))
        .route("/api/streamers/{name}/unfollow", post(unfollow))
        .route("/api/following", get(following))
        .route("/api/search", get(search))
        .route("/api/people", get(people))
        .route("/api/recent", get(recent))
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;

    use super::*;
    use crate::auth::tests::{edges_of, row, test_db};

    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored follows_the_account` against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn following_a_held_name_follows_the_account_that_holds_it() {
        let pool = test_db().await;
        let run = std::process::id();
        let old = format!("alice4-{run}");
        let new = format!("nova4-{run}");
        let alice = row(&pool, &old, Some("alice-hash")).await;
        let fan_name = format!("fan4-{run}");
        let fan = row(&pool, &fan_name, Some("fan-hash")).await;
        let other_name = format!("other4-{run}");
        let other = row(&pool, &other_name, Some("other-hash")).await;
        // what change_name does: the row takes the new name, and the old one is held for the account
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(alice).bind(&new).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&old)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();

        // fan follows the old name, as a stale list offers it: the edge goes to the account,
        // and no row is made under the held name
        follow_as(&pool, fan, &fan_name, old.clone()).await.expect("a follow");
        let followed: Vec<Uuid> = edges_of(&pool, fan).await.into_iter().map(|(id, _)| id).collect();
        assert_eq!(followed, vec![alice], "the edge points at the account, not a row under the held name");
        let ghosts: i64 = sqlx::query_scalar("SELECT count(*) FROM streamers WHERE name = $1").bind(&old).fetch_one(&pool).await.unwrap();
        assert_eq!(ghosts, 0, "no bare row under a held name");
        assert_eq!(stats(&pool, &new, Some(fan)).await.unwrap(), Stats { followers: 1, following: true, follows_you: false });

        // the holder following her own old name is following herself
        let err = follow_as(&pool, alice, &new, old.clone()).await.expect_err("that is you");
        assert_eq!(err.message(), "that is you");
        assert_eq!(err.into_response().status(), StatusCode::BAD_REQUEST);
        assert_eq!(edges_of(&pool, alice).await, vec![]);

        // the hold runs out: the name is free, and a follow makes the bare row any free name gets
        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&old).execute(&pool).await.unwrap();
        follow_as(&pool, other, &other_name, old.clone()).await.expect("a follow");
        let bare: Uuid = sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1 AND password_hash IS NULL")
            .bind(&old)
            .fetch_one(&pool)
            .await
            .expect("a bare row under the free name");
        assert_ne!(bare, alice);
        let followed: Vec<Uuid> = edges_of(&pool, other).await.into_iter().map(|(id, _)| id).collect();
        assert_eq!(followed, vec![bare]);
        assert_eq!(stats(&pool, &new, Some(other)).await.unwrap(), Stats { followers: 1, following: false, follows_you: false });
    }

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
