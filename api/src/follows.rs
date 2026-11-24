use std::collections::HashMap;
use std::time::{Duration, Instant};

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
use crate::test_streamers::shown_sql;
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
const RECENT_ANON_FRESH: Duration = Duration::from_secs(10);

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

async fn following_rows(db: &PgPool, me: Uuid, hide: bool) -> Result<Vec<FollowedRow>, sqlx::Error> {
    sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio, f.followed_at,
                EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = s.id AND b.followed_id = $1), s.status, ",
        crate::oauth::linked_sql!("s"),
        " FROM follows f JOIN streamers s ON s.id = f.followed_id
         WHERE f.follower_id = $1 AND ",
        shown_sql!("s", "$2"),
        " ORDER BY f.followed_at DESC",
    ))
    .bind(me)
    .bind(hide)
    .fetch_all(db)
    .await
}

async fn following(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let me = me.ok_or_else(not_logged_in)?;
    let rows = following_rows(&s.db, me.id, s.hide_test).await?;
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

async fn search_rows(db: &PgPool, q: &str, me: Option<Uuid>, hide: bool) -> Result<Vec<HitRow>, sqlx::Error> {
    sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followed_id = s.id), s.status, ",
        crate::oauth::linked_sql!("s"),
        " FROM streamers s
         WHERE s.name LIKE $4 AND ",
        shown_sql!("s", "$5"),
        " ORDER BY s.name = $1 DESC, starts_with(s.name, $1) DESC, (s.password_hash IS NOT NULL) DESC, s.name
         LIMIT $3",
    ))
    .bind(q)
    .bind(me)
    .bind(SEARCH_LIMIT)
    .bind(search_pattern(q))
    .bind(hide)
    .fetch_all(db)
    .await
}

async fn people_rows(db: &PgPool, me: Option<Uuid>, hide: bool) -> Result<Vec<HitRow>, sqlx::Error> {
    sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id), s.status, ",
        crate::oauth::linked_sql!("s"),
        " FROM streamers s
         WHERE ",
        shown_sql!("s", "$3"),
        " ORDER BY (s.password_hash IS NOT NULL) DESC, s.updated_at DESC
         LIMIT $2",
    ))
    .bind(me)
    .bind(PEOPLE_SCAN)
    .bind(hide)
    .fetch_all(db)
    .await
}

async fn search(State(s): State<AppState>, Me(me): Me, headers: HeaderMap, q: Result<Query<SearchQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let q = clean_query(&q.q);
    if q.is_empty() {
        return Ok(Json(json!([])));
    }
    crate::auth::limit(&s, &format!("rl:search:ip:{}", client_ip(&headers)), SEARCH_WINDOW_SECS, SEARCH_PER_MINUTE, "too many searches. wait a minute").await?;
    let rows = search_rows(&s.db, &q, me.as_ref().map(|a| a.id), s.hide_test).await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(&s, &people).await?;
    let out = rows.into_iter().map(|(name, verified, avatar, bio, following, _, oauth_verified)| {
        let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
        json!({ "name": name, "verified": verified, "oauth_verified": oauth_verified, "avatar": avatar, "bio": bio, "live": live, "presence": word, "following": following })
    });
    Ok(Json(Value::Array(out.collect())))
}

async fn people(State(s): State<AppState>, Me(me): Me) -> ApiResult {
    let rows = people_rows(&s.db, me.as_ref().map(|a| a.id), s.hide_test).await?;
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
    if me.is_some() {
        return Ok(Json(recent_list(&s, me.map(|a| a.id)).await?));
    }
    if let Some((at, list)) = s.recent_cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < RECENT_ANON_FRESH {
            return Ok(Json(list.clone()));
        }
    }
    let list = recent_list(&s, None).await?;
    *s.recent_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), list.clone()));
    Ok(Json(list))
}

async fn recent_rows(db: &PgPool, me: Option<Uuid>, hide: bool) -> Result<Vec<RecentRow>, sqlx::Error> {
    sqlx::query_as(concat!(
        "SELECT s.name, s.password_hash IS NOT NULL, (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.bio,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.id), s.status, last.ended_at,
                (SELECT count(*) FROM follows f WHERE f.followed_id = s.id), ",
        crate::oauth::linked_sql!("s"),
        " FROM (
             SELECT ended.id, max(ended.ended_at) AS ended_at
             FROM (
                 SELECT se.user_id AS id, se.ended_at
                 FROM sessions se
                 WHERE se.user_id IS NOT NULL AND se.ended_at IS NOT NULL
                 UNION ALL
                 SELECT s.id, se.ended_at
                 FROM sessions se
                 JOIN streamers s ON s.name = se.name AND s.password_hash IS NULL
                 WHERE se.user_id IS NULL AND se.ended_at IS NOT NULL
             ) ended
             GROUP BY ended.id
         ) last
         JOIN streamers s ON s.id = last.id
         WHERE ",
        shown_sql!("s", "$3"),
        " ORDER BY last.ended_at DESC
         LIMIT $2",
    ))
    .bind(me)
    .bind(RECENT_SCAN)
    .bind(hide)
    .fetch_all(db)
    .await
}

async fn recent_list(s: &AppState, me: Option<Uuid>) -> Result<Value, ApiError> {
    let rows = recent_rows(&s.db, me, s.hide_test).await?;
    let people: Vec<(String, Status)> = rows.iter().map(|r| choice(&r.0, &r.5)).collect();
    let words = words(s, &people).await?;
    let out = rows.into_iter().filter_map(|(name, verified, avatar, bio, following, _, ended_at, followers, oauth_verified)| {
        let (live, word) = words.get(&name).copied().unwrap_or((false, Presence::Offline));
        if live {
            return None;
        }
        Some(json!({ "name": name, "verified": verified, "oauth_verified": oauth_verified, "avatar": avatar, "bio": bio, "presence": word, "following": following, "ended_at": ended_at, "followers": followers }))
    });
    Ok(Value::Array(out.take(RECENT_LIMIT).collect()))
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

    async fn a_dummy(pool: &PgPool, name: &str) -> Uuid {
        crate::test_streamers::mark(pool, name).await.unwrap();
        sqlx::query_scalar("SELECT id FROM streamers WHERE name = $1").bind(name).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn the_following_list_hides_a_test_streamer_only_when_asked() {
        let pool = test_db().await;
        let run = std::process::id();
        let fan = row(&pool, &format!("fan7-{run}"), Some("fan-hash")).await;
        let human = row(&pool, &format!("human7-{run}"), Some("h")).await;
        let dummy_name = format!("dummy-f{run}");
        let dummy = a_dummy(&pool, &dummy_name).await;
        for followed in [human, dummy] {
            sqlx::query("INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)").bind(fan).bind(followed).execute(&pool).await.unwrap();
        }
        let names = |rows: Vec<FollowedRow>| rows.into_iter().map(|r| r.0).collect::<Vec<_>>();
        assert!(names(following_rows(&pool, fan, false).await.unwrap()).contains(&dummy_name));
        assert_eq!(names(following_rows(&pool, fan, true).await.unwrap()), vec![format!("human7-{run}")]);
        sqlx::query("DELETE FROM streamers WHERE id = ANY($1)").bind(vec![fan, human, dummy]).execute(&pool).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn search_and_people_hide_a_test_streamer_only_when_asked() {
        let pool = test_db().await;
        let run = std::process::id();
        let dummy_name = format!("dummy-s{run}");
        let dummy = a_dummy(&pool, &dummy_name).await;
        sqlx::query("UPDATE streamers SET updated_at = now() + interval '1 day' WHERE id = $1").bind(dummy).execute(&pool).await.unwrap();
        let names = |rows: Vec<HitRow>| rows.into_iter().map(|r| r.0).collect::<Vec<_>>();
        assert_eq!(names(search_rows(&pool, &dummy_name, None, false).await.unwrap()), vec![dummy_name.clone()]);
        assert!(search_rows(&pool, &dummy_name, None, true).await.unwrap().is_empty());
        let shown = names(people_rows(&pool, None, false).await.unwrap());
        let hidden = names(people_rows(&pool, None, true).await.unwrap());
        let bare_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM streamers WHERE password_hash IS NULL AND NOT is_test").fetch_one(&pool).await.unwrap();
        let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM streamers WHERE password_hash IS NOT NULL").fetch_one(&pool).await.unwrap();
        if accounts + bare_rows < PEOPLE_SCAN {
            assert!(shown.contains(&dummy_name), "{shown:?}");
        }
        assert!(!hidden.contains(&dummy_name));
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(dummy).execute(&pool).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn recent_hides_a_test_streamer_only_when_asked() {
        let pool = test_db().await;
        let dummy_name = format!("dummy-r{}", std::process::id());
        let dummy = a_dummy(&pool, &dummy_name).await;
        sqlx::query("INSERT INTO sessions (name, token, verified, started_at, ended_at) VALUES ($1, 1, false, now() + interval '1 day', now() + interval '2 days')")
            .bind(&dummy_name)
            .execute(&pool)
            .await
            .unwrap();
        let names = |rows: Vec<RecentRow>| rows.into_iter().map(|r| r.0).collect::<Vec<_>>();
        assert_eq!(names(recent_rows(&pool, None, false).await.unwrap()).first(), Some(&dummy_name));
        assert!(!names(recent_rows(&pool, None, true).await.unwrap()).contains(&dummy_name));
        sqlx::query("DELETE FROM sessions WHERE name = $1").bind(&dummy_name).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM streamers WHERE id = $1").bind(dummy).execute(&pool).await.unwrap();
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
