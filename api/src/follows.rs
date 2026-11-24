use std::collections::HashMap;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{self, client_ip, Me};
use crate::notify;
use crate::presence::{self, Presence, Status, SEEN_WINDOW_MS};
use crate::{live_set, ApiError, ApiResult, AppState, Name};

const FOLLOWS_PER_LOGIN: i64 = 500;
const CHURN_PER_HOUR: i64 = 120;
const CHURN_WINDOW_SECS: i64 = 3600;
const SEARCH_LIMIT: i64 = 20;
const SEARCH_ANYWHERE_FROM: usize = 3;
const SEARCH_PER_MINUTE: i64 = 180;
const SEARCH_WINDOW_SECS: i64 = 60;
const PEOPLE_SCAN: i64 = 300;
const PEOPLE_LIMIT: usize = 100;
const RECENT_SCAN: i64 = 40;
const RECENT_LIMIT: usize = 12;

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

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

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Stats {
    pub(crate) followers: i64,
    pub(crate) following: bool,
    pub(crate) follows_you: bool,
}

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

pub(crate) async fn words(s: &AppState, people: &[(String, Status)]) -> Result<HashMap<String, (bool, Presence)>, ApiError> {
    let mut out = HashMap::new();
    if people.is_empty() {
        return Ok(out);
    }
    let live = live_set(s);
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

pub(crate) fn choice(name: &str, raw: &str) -> (String, Status) {
    (name.to_owned(), Status::parse(raw).unwrap_or_default())
}

fn rank(word: Presence) -> u8 {
    match word {
        Presence::Streaming => 0,
        Presence::Online => 1,
        Presence::Dnd => 2,
        Presence::Offline => 3,
    }
}

type FollowedRow = (String, bool, Option<i64>, String, DateTime<Utc>, bool, String, bool);

async fn follow(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    crate::auth::limit(&s, &format!("rl:follow:name:{}", me.name), CHURN_WINDOW_SECS, CHURN_PER_HOUR, "too many changes. wait an hour").await?;
    if let Some((followed, followed_name)) = follow_as(&s.db, me.id, &me.name, name).await? {
        notify::followed(&s, followed, &followed_name, &me).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn follow_as(db: &PgPool, me_id: Uuid, me_name: &str, name: String) -> Result<Option<(Uuid, String)>, ApiError> {
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
    let made: Option<Uuid> = sqlx::query_scalar(
        "WITH named AS (
            INSERT INTO streamers (name) VALUES ($2)
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
         )
         INSERT INTO follows (follower_id, followed_id) SELECT $1, id FROM named WHERE id <> $1 ON CONFLICT DO NOTHING RETURNING followed_id",
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

async fn unfollow(State(s): State<AppState>, Name(name): Name, Me(me): Me) -> Result<StatusCode, ApiError> {
    let me = me.ok_or_else(not_logged_in)?;
    let name = auth::renamed_to(&s.db, &name).await?.unwrap_or(name);
    crate::auth::limit(&s, &format!("rl:follow:name:{}", me.name), CHURN_WINDOW_SECS, CHURN_PER_HOUR, "too many changes. wait an hour").await?;
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

fn followed_json((name, verified, avatar, bio, followed_at, mutual, _, oauth_verified): &FollowedRow, live: bool, word: Presence) -> Value {
    json!({ "name": name, "verified": verified, "oauth_verified": oauth_verified, "avatar": avatar, "bio": bio, "live": live, "presence": word, "followed_at": followed_at, "mutual": mutual })
}

async fn following(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let rows: Vec<FollowedRow> = sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio, f.followed_at,
                EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = s.id AND b.followed_id = $1), s.status, ",
        crate::oauth::linked_sql!("s"),
        " FROM follows f JOIN streamers s ON s.id = f.followed_id
         WHERE f.follower_id = $1
         ORDER BY f.followed_at DESC",
    ))
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

fn clean_query(raw: &str) -> String {
    raw.trim().to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-').take(32).collect()
}

fn search_pattern(q: &str) -> String {
    let letters = q.replace('_', "\\_");
    if q.len() < SEARCH_ANYWHERE_FROM {
        format!("{letters}%")
    } else {
        format!("%{letters}%")
    }
}

type HitRow = (String, bool, Option<i64>, String, bool, String, bool);

async fn search(State(s): State<AppState>, Me(me): Me, headers: HeaderMap, q: Result<Query<SearchQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let q = clean_query(&q.q);
    if q.is_empty() {
        return Ok(Json(json!([])));
    }
    crate::auth::limit(&s, &format!("rl:search:ip:{}", client_ip(&headers)), SEARCH_WINDOW_SECS, SEARCH_PER_MINUTE, "too many searches. wait a minute").await?;
    let rows: Vec<HitRow> = sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followed_id = s.id), s.status, ",
        crate::oauth::linked_sql!("s"),
        " FROM streamers s
         WHERE s.name LIKE $4
         ORDER BY s.name = $1 DESC, starts_with(s.name, $1) DESC, (s.password_hash IS NOT NULL) DESC, s.name
         LIMIT $3",
    ))
    .bind(&q)
    .bind(me.as_ref().map(|a| a.id))
    .bind(SEARCH_LIMIT)
    .bind(search_pattern(&q))
    .fetch_all(&s.db)
    .await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let out = rows.into_iter().map(|(name, verified, avatar, bio, following, _, oauth_verified)| {
        let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
        json!({ "name": name, "verified": verified, "oauth_verified": oauth_verified, "avatar": avatar, "bio": bio, "live": live, "presence": word, "following": following })
    });
    Ok(Json(Value::Array(out.collect())))
}

async fn people(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<HitRow> = sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id), s.status, ",
        crate::oauth::linked_sql!("s"),
        " FROM streamers s
         ORDER BY (s.password_hash IS NOT NULL) DESC, s.updated_at DESC
         LIMIT $2",
    ))
    .bind(me.as_ref().map(|a| a.id))
    .bind(PEOPLE_SCAN)
    .fetch_all(&s.db)
    .await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let mut list: Vec<(u8, usize, Value)> = rows
        .into_iter()
        .enumerate()
        .filter_map(|(i, (name, verified, avatar, bio, following, _, oauth_verified))| {
            let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
            if live {
                return None;
            }
            Some((rank(word), i, json!({ "name": name, "verified": verified, "oauth_verified": oauth_verified, "avatar": avatar, "bio": bio, "presence": word, "following": following })))
        })
        .collect();
    list.sort_by_key(|(r, i, _)| (*r, *i));
    list.truncate(PEOPLE_LIMIT);
    Ok(Json(Value::Array(list.into_iter().map(|(_, _, v)| v).collect())))
}

type RecentRow = (String, bool, Option<i64>, String, bool, String, DateTime<Utc>, i64, bool);

async fn recent(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows: Vec<RecentRow> = sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id), s.status, last.ended_at,
                (SELECT count(*) FROM follows f WHERE f.followed_id = s.id), ",
        crate::oauth::linked_sql!("s"),
        " FROM (
             SELECT s.id, max(se.ended_at) AS ended_at
             FROM sessions se
             JOIN streamers s ON s.id = se.user_id OR (se.user_id IS NULL AND s.name = se.name AND s.password_hash IS NULL)
             WHERE se.ended_at IS NOT NULL
             GROUP BY s.id
         ) last
         JOIN streamers s ON s.id = last.id
         ORDER BY last.ended_at DESC
         LIMIT $2",
    ))
    .bind(me.as_ref().map(|a| a.id))
    .bind(RECENT_SCAN)
    .fetch_all(&s.db)
    .await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let out = rows.into_iter().filter_map(|(name, verified, avatar, bio, following, _, ended_at, followers, oauth_verified)| {
        let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
        if live {
            return None;
        }
        Some(json!({ "name": name, "verified": verified, "oauth_verified": oauth_verified, "avatar": avatar, "bio": bio, "presence": word, "following": following, "ended_at": ended_at, "followers": followers }))
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
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(alice).bind(&new).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&old)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();

        follow_as(&pool, fan, &fan_name, old.clone()).await.expect("a follow");
        let followed: Vec<Uuid> = edges_of(&pool, fan).await.into_iter().map(|(id, _)| id).collect();
        assert_eq!(followed, vec![alice], "the edge points at the account, not a row under the held name");
        let ghosts: i64 = sqlx::query_scalar("SELECT count(*) FROM streamers WHERE name = $1").bind(&old).fetch_one(&pool).await.unwrap();
        assert_eq!(ghosts, 0, "no bare row under a held name");
        assert_eq!(stats(&pool, &new, Some(fan)).await.unwrap(), Stats { followers: 1, following: true, follows_you: false });

        let err = follow_as(&pool, alice, &new, old.clone()).await.expect_err("that is you");
        assert_eq!(err.message(), "that is you");
        assert_eq!(err.into_response().status(), StatusCode::BAD_REQUEST);
        assert_eq!(edges_of(&pool, alice).await, vec![]);

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
        assert_eq!(clean_query("a\\b"), "ab");
        assert_eq!(clean_query(&"x".repeat(40)).len(), 32);
    }

    #[test]
    fn few_letters_start_a_name_and_more_are_anywhere_in_it() {
        assert_eq!(search_pattern("a"), "a%");
        assert_eq!(search_pattern("al"), "al%");
        assert_eq!(search_pattern("ali"), "%ali%");
        assert_eq!(search_pattern("a_"), "a\\_%");
        assert_eq!(search_pattern("a_b_"), "%a\\_b\\_%");
    }

    #[test]
    fn streaming_sorts_first() {
        assert!(rank(Presence::Streaming) < rank(Presence::Online));
        assert!(rank(Presence::Online) < rank(Presence::Dnd));
        assert!(rank(Presence::Dnd) < rank(Presence::Offline));
    }
}
