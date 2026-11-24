use std::collections::HashSet;
use std::time::Duration;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{self, Me};
use crate::follows::clean_query;
use crate::groups::{channel_names, sees_sql};
use crate::oauth::linked_sql;
use crate::test_streamers::shown_sql;
use crate::{valid_name, ApiError, AppState};

const MAX_MENTIONS: usize = 5;
const NAME_CHARS: usize = 32;
const DEFAULT_LIMIT: i64 = 6;
const MAX_LIMIT: i64 = 8;
const CHATTER_SCAN: i64 = 300;
const PER_MINUTE: i64 = 240;
const WINDOW_SECS: i64 = 60;
const RESOLVE_WAIT: Duration = Duration::from_millis(500);
const CACHE: &str = "private, max-age=10";
const NOT_FRIENDS: &str = "not friends";
const NOT_SEEN: &str = "you can't see that channel";

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

pub(crate) fn tokens(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() && out.len() < MAX_MENTIONS {
        if chars[i] != '@' || (i > 0 && is_name_char(chars[i - 1])) {
            i += 1;
            continue;
        }
        let run = chars[i + 1..].iter().take_while(|c| is_name_char(**c)).count();
        if (1..=NAME_CHARS).contains(&run) {
            let name: String = chars[i + 1..i + 1 + run].iter().map(char::to_ascii_lowercase).collect();
            if !out.contains(&name) {
                out.push(name);
            }
        }
        i += 1 + run;
    }
    out
}

async fn known(db: &PgPool, hide: bool, names: &[String]) -> Result<HashSet<String>, sqlx::Error> {
    let rows: Vec<String> = sqlx::query_scalar(concat!(
        "SELECT s.name FROM streamers s WHERE s.name = ANY($1) AND s.password_hash IS NOT NULL AND ",
        shown_sql!("s", "$2"),
    ))
    .bind(names)
    .bind(hide)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

pub(crate) async fn resolve(db: &PgPool, hide: bool, text: &str) -> Vec<String> {
    if !text.contains('@') {
        return Vec::new();
    }
    let asked = tokens(text);
    if asked.is_empty() {
        return Vec::new();
    }
    match tokio::time::timeout(RESOLVE_WAIT, known(db, hide, &asked)).await {
        Ok(Ok(found)) => asked.into_iter().filter(|name| found.contains(name)).collect(),
        Ok(Err(e)) => {
            log::warn!("mentions: {e}");
            Vec::new()
        }
        Err(_) => {
            log::warn!("mentions: resolve timed out");
            Vec::new()
        }
    }
}

pub(crate) fn from_field(raw: Option<String>) -> Vec<String> {
    raw.map(|m| m.split(',').filter(|name| valid_name(name)).map(str::to_owned).collect()).unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub(crate) enum Ctx {
    Stream(String),
    Channel(String, String),
    Dm(String),
}

pub(crate) fn parse_ctx(raw: &str) -> Option<Ctx> {
    let raw = raw.trim().to_ascii_lowercase();
    if let Some(name) = raw.strip_prefix("dm:") {
        return valid_name(name).then(|| Ctx::Dm(name.to_owned()));
    }
    let rest = raw.strip_prefix("chat:")?;
    match rest.split_once('/') {
        Some((server, channel)) => channel_names(server, channel).ok().map(|(server, channel)| Ctx::Channel(server, channel)),
        None => valid_name(rest).then(|| Ctx::Stream(rest.to_owned())),
    }
}

fn limit_of(asked: Option<i64>) -> i64 {
    asked.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub(crate) struct Hit {
    pub(crate) name: String,
    pub(crate) verified: bool,
    pub(crate) oauth_verified: bool,
    pub(crate) avatar: Option<i64>,
}

type HitRow = (String, bool, bool, Option<i64>);

fn fit(row: &str) -> String {
    format!(
        "{row}.password_hash IS NOT NULL AND {row}.id <> $2 AND {row}.name ~>=~ $3 AND {row}.name ~<~ ($3 || '~') AND NOT ($4::boolean AND {row}.is_test)"
    )
}

fn recent_chatters() -> &'static str {
    "SELECT n.user_id, min(n.ord) AS ord
     FROM (SELECT l.user_id, row_number() OVER (ORDER BY l.at DESC, l.seq DESC) AS ord
           FROM (SELECT user_id, at, seq FROM chat_lines WHERE room = $1 ORDER BY at DESC, seq DESC LIMIT $6) l) n
     WHERE n.user_id IS NOT NULL
     GROUP BY n.user_id"
}

fn picked_sql(picked: &str) -> String {
    format!(
        "WITH picked AS ({picked})
         SELECT s.name, s.password_hash IS NOT NULL, {}, (EXTRACT(EPOCH FROM s.avatar_at))::bigint
         FROM picked p JOIN streamers s ON s.id = p.id
         ORDER BY p.tier, p.ord, s.name USING ~<~",
        linked_sql!("s"),
    )
}

fn stream_sql() -> String {
    let fit = fit("s");
    let chatters = recent_chatters();
    picked_sql(&format!(
        "(SELECT s.id, 0 AS tier, 0::bigint AS ord FROM streamers s WHERE s.name = $1 AND {fit})
         UNION ALL
         (SELECT s.id, 1, c.ord FROM ({chatters}) c JOIN streamers s ON s.id = c.user_id WHERE {fit} ORDER BY c.ord LIMIT $5)
         UNION ALL
         (SELECT s.id, 2, 0::bigint FROM follows a
              JOIN follows b ON b.follower_id = a.followed_id AND b.followed_id = a.follower_id
              JOIN streamers s ON s.id = a.followed_id
          WHERE a.follower_id = $2 AND {fit} ORDER BY s.name USING ~<~ LIMIT $5)
         UNION ALL
         (SELECT s.id, 3, 0::bigint FROM streamers s WHERE $7 AND {fit} ORDER BY s.name USING ~<~ LIMIT $5)"
    ))
}

fn channel_sql() -> String {
    let fit = fit("s");
    let chatters = recent_chatters();
    let sees = sees_sql("s.id", "false");
    picked_sql(&format!(
        "(SELECT s.id, 1 AS tier, said.ord FROM ({chatters}) said JOIN streamers s ON s.id = said.user_id
              JOIN channels c ON c.server = $8 AND c.name = $9
          WHERE {fit} AND {sees} ORDER BY said.ord LIMIT $5)
         UNION ALL
         (SELECT s.id, 2, 0::bigint FROM memberships m JOIN streamers s ON s.id = m.user_id
              JOIN channels c ON c.server = $8 AND c.name = $9
          WHERE $7 AND m.group_name = $8 AND {fit} AND {sees} ORDER BY s.name USING ~<~ LIMIT $5)"
    ))
}

fn ranked(rows: Vec<HitRow>, limit: i64) -> Vec<Hit> {
    let mut seen: HashSet<String> = HashSet::new();
    rows.into_iter()
        .filter(|(name, ..)| seen.insert(name.clone()))
        .take(limit as usize)
        .map(|(name, verified, oauth_verified, avatar)| Hit { name, verified, oauth_verified, avatar })
        .collect()
}

type PeerRow = (String, bool, Option<i64>, bool, bool);

async fn dm_hits(db: &PgPool, me: Uuid, hide: bool, name: &str, q: &str) -> Result<Vec<Hit>, ApiError> {
    let name = auth::renamed_to(db, name).await?.unwrap_or_else(|| name.to_owned());
    let peer: Option<PeerRow> = sqlx::query_as(concat!(
        "SELECT s.name, ",
        linked_sql!("s"),
        ", (EXTRACT(EPOCH FROM s.avatar_at))::bigint, s.is_test,
                s.id <> $2
                AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followed_id = s.id)
                AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = s.id AND f.followed_id = $2)
         FROM streamers s WHERE s.name = $1 AND s.password_hash IS NOT NULL",
    ))
    .bind(&name)
    .bind(me)
    .fetch_optional(db)
    .await?;
    let Some((name, oauth_verified, avatar, is_test, _)) = peer.filter(|p| p.4) else {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NOT_FRIENDS));
    };
    if !crate::test_streamers::shown(hide, is_test) || !name.starts_with(q) {
        return Ok(Vec::new());
    }
    Ok(vec![Hit { name, verified: true, oauth_verified, avatar }])
}

pub(crate) async fn suggest(db: &PgPool, me: Uuid, admin: bool, hide: bool, ctx: &Ctx, q: &str, limit: i64) -> Result<Vec<Hit>, ApiError> {
    let take = limit * 2;
    let everyone = !q.is_empty();
    let rows: Vec<HitRow> = match ctx {
        Ctx::Dm(name) => return dm_hits(db, me, hide, name, q).await,
        Ctx::Stream(streamer) => {
            sqlx::query_as(&stream_sql())
                .bind(streamer)
                .bind(me)
                .bind(q)
                .bind(hide)
                .bind(take)
                .bind(CHATTER_SCAN)
                .bind(everyone)
                .fetch_all(db)
                .await?
        }
        Ctx::Channel(server, channel) => {
            if !crate::groups::may_see_text(db, server, channel, Some(me), admin).await? {
                return Err(ApiError::new(StatusCode::FORBIDDEN, NOT_SEEN));
            }
            sqlx::query_as(&channel_sql())
                .bind(format!("{server}/{channel}"))
                .bind(me)
                .bind(q)
                .bind(hide)
                .bind(take)
                .bind(CHATTER_SCAN)
                .bind(everyone)
                .bind(server)
                .bind(channel)
                .fetch_all(db)
                .await?
        }
    };
    Ok(ranked(rows, limit))
}

#[derive(Deserialize, Default)]
struct MentionQuery {
    #[serde(default)]
    ctx: String,
    #[serde(default)]
    q: String,
    limit: Option<i64>,
}

async fn mentions(State(s): State<AppState>, Me(me): Me, q: Result<Query<MentionQuery>, QueryRejection>) -> Result<impl IntoResponse, ApiError> {
    let me = me.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let Query(q) = q?;
    auth::limit(&s, &format!("rl:mention:{}", me.id), WINDOW_SECS, PER_MINUTE, "too many lookups. wait a minute").await?;
    let ctx = parse_ctx(&q.ctx).ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "no such place"))?;
    let admin = s.admins.iter().any(|a| a.id == me.id);
    let hits = suggest(&s.db, me.id, admin, s.hide_test, &ctx, &clean_query(&q.q), limit_of(q.limit)).await?;
    Ok(([(header::CACHE_CONTROL, CACHE)], Json(hits)))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/mentions", get(mentions))
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;

    use super::*;
    use crate::auth::tests::{row, test_db};

    fn names(hits: Vec<Hit>) -> Vec<String> {
        hits.into_iter().map(|h| h.name).collect()
    }

    fn status_of(err: ApiError) -> StatusCode {
        err.into_response().status()
    }

    #[test]
    fn a_mention_is_an_at_and_name_letters_after_a_break() {
        assert_eq!(tokens("@bob hi"), vec!["bob"]);
        assert_eq!(tokens("hi @bob"), vec!["bob"]);
        assert_eq!(tokens("hi\n@bob"), vec!["bob"]);
        assert_eq!(tokens("@bob-the_1st!"), vec!["bob-the_1st"]);
        assert_eq!(tokens("a@b.com"), Vec::<String>::new());
        assert_eq!(tokens("mail me at bob@example.com"), Vec::<String>::new());
        assert_eq!(tokens("x@bob _@bob 9@bob -@bob"), Vec::<String>::new());
        assert_eq!(tokens("é@bob"), vec!["bob"]);
        assert_eq!(tokens("@"), Vec::<String>::new());
        assert_eq!(tokens("@ bob"), Vec::<String>::new());
        assert_eq!(tokens("@@"), Vec::<String>::new());
        assert_eq!(tokens("@@bob"), vec!["bob"]);
        assert_eq!(tokens("@.bob"), Vec::<String>::new());
    }

    #[test]
    fn punctuation_ends_a_mention() {
        assert_eq!(tokens("@bob,"), vec!["bob"]);
        assert_eq!(tokens("(@bob)"), vec!["bob"]);
        assert_eq!(tokens("@bob. @carol? @dave: [@erin]"), vec!["bob", "carol", "dave", "erin"]);
        assert_eq!(tokens("@bob’s"), vec!["bob"]);
        assert_eq!(tokens("\"@bob\""), vec!["bob"]);
    }

    #[test]
    fn mentions_are_lowercase_once_each_in_order_and_five_at_most() {
        assert_eq!(tokens("@Bob @BOB @bob"), vec!["bob"]);
        assert_eq!(tokens("@carol @bob @carol"), vec!["carol", "bob"]);
        assert_eq!(tokens("@a @b @c @d @e @f @g"), vec!["a", "b", "c", "d", "e"]);
        assert_eq!(tokens("@a @a @b @c @d @e @f"), vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn a_name_is_thirty_two_letters_at_most() {
        let long = "x".repeat(32);
        assert_eq!(tokens(&format!("@{long}")), vec![long.clone()]);
        assert_eq!(tokens(&format!("@{long}y")), Vec::<String>::new());
        assert_eq!(tokens(&format!("@{long}y @bob")), vec!["bob"]);
    }

    #[test]
    fn a_frame_field_reads_back_as_names() {
        assert_eq!(from_field(None), Vec::<String>::new());
        assert_eq!(from_field(Some(String::new())), Vec::<String>::new());
        assert_eq!(from_field(Some("bob,carol".into())), vec!["bob", "carol"]);
        assert_eq!(from_field(Some("bob,,Bad Name,carol".into())), vec!["bob", "carol"]);
    }

    #[test]
    fn a_context_is_a_stream_a_channel_or_a_dm() {
        assert_eq!(parse_ctx("chat:alice"), Some(Ctx::Stream("alice".into())));
        assert_eq!(parse_ctx("chat:VIP/General"), Some(Ctx::Channel("vip".into(), "general".into())));
        assert_eq!(parse_ctx("dm:bob"), Some(Ctx::Dm("bob".into())));
        assert_eq!(parse_ctx("chat:"), None);
        assert_eq!(parse_ctx("dm:"), None);
        assert_eq!(parse_ctx("chat:a b"), None);
        assert_eq!(parse_ctx("chat:vip/"), None);
        assert_eq!(parse_ctx("chat:vip/general/x"), None);
        assert_eq!(parse_ctx("chat:bot/general"), None);
        assert_eq!(parse_ctx("room:alice"), None);
        assert_eq!(parse_ctx("alice"), None);
    }

    #[test]
    fn the_limit_is_six_unless_asked_and_one_to_eight() {
        assert_eq!(limit_of(None), 6);
        assert_eq!(limit_of(Some(0)), 1);
        assert_eq!(limit_of(Some(-3)), 1);
        assert_eq!(limit_of(Some(3)), 3);
        assert_eq!(limit_of(Some(50)), 8);
    }

    #[test]
    fn a_name_is_kept_at_its_first_tier_and_the_list_is_cut_at_the_limit() {
        let row = |n: &str| (n.to_owned(), true, false, None);
        let got = ranked(vec![row("s"), row("a"), row("b"), row("a"), row("f"), row("s"), row("o")], 4);
        assert_eq!(names(got), vec!["s", "a", "b", "f"]);
    }

    #[test]
    fn a_hit_is_the_four_fields() {
        let hit = Hit { name: "bob".into(), verified: true, oauth_verified: false, avatar: Some(7) };
        assert_eq!(serde_json::to_value(hit).unwrap(), serde_json::json!({ "name": "bob", "verified": true, "oauth_verified": false, "avatar": 7 }));
    }

    #[test]
    fn the_queries_bind_what_they_use() {
        let stream = stream_sql();
        for n in 1..=7 {
            assert!(stream.contains(&format!("${n}")), "${n} in {stream}");
        }
        assert!(!stream.contains("$8"));
        let channel = channel_sql();
        for n in 1..=9 {
            assert!(channel.contains(&format!("${n}")), "${n} in {channel}");
        }
        assert!(channel.contains("c.server = $8 AND c.name = $9"));
    }

    async fn says(pool: &PgPool, room: &str, n: i64, speaker: &str, user: Option<Uuid>) {
        let id = format!("{}-0", 1_729_000_000_000i64 + n);
        crate::history::store(pool, room, &id, speaker, user, "hi", None, None, false, user.is_some(), &[], None, &[]).await.unwrap();
    }

    async fn follow(pool: &PgPool, from: Uuid, to: Uuid) {
        sqlx::query("INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(from).bind(to).execute(pool).await.unwrap();
    }

    async fn befriend(pool: &PgPool, a: Uuid, b: Uuid) {
        follow(pool, a, b).await;
        follow(pool, b, a).await;
    }

    async fn a_test_account(pool: &PgPool, name: &str) -> Uuid {
        let id = row(pool, name, Some("h")).await;
        sqlx::query("UPDATE streamers SET is_test = true WHERE id = $1").bind(id).execute(pool).await.unwrap();
        id
    }

    async fn forget(pool: &PgPool, ids: &[Uuid], rooms: &[String]) {
        sqlx::query("DELETE FROM chat_lines WHERE room = ANY($1)").bind(rooms).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM streamers WHERE id = ANY($1)").bind(ids).execute(pool).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn a_streams_list_is_the_streamer_then_chatters_then_friends_then_everyone() {
        let pool = test_db().await;
        let p = format!("ms{}-", std::process::id());
        let n = |x: &str| format!("{p}{x}");
        let streamer = row(&pool, &n("s"), Some("h")).await;
        let me = row(&pool, &n("c"), Some("h")).await;
        let a = row(&pool, &n("a"), Some("h")).await;
        let b = row(&pool, &n("b"), Some("h")).await;
        let f = row(&pool, &n("f"), Some("h")).await;
        let o = row(&pool, &n("o"), Some("h")).await;
        let u = row(&pool, &n("u"), None).await;
        let t = a_test_account(&pool, &n("t")).await;
        let room = n("s");
        says(&pool, &room, 1, &n("a"), Some(a)).await;
        says(&pool, &room, 2, &n("b"), Some(b)).await;
        says(&pool, &room, 3, &n("a"), Some(a)).await;
        says(&pool, &room, 4, &n("c"), Some(me)).await;
        says(&pool, &room, 5, &n("u"), None).await;
        says(&pool, &room, 6, &n("t"), Some(t)).await;
        befriend(&pool, me, f).await;
        befriend(&pool, me, a).await;
        befriend(&pool, me, u).await;
        follow(&pool, me, o).await;
        let ctx = Ctx::Stream(room.clone());
        let ask = |q: String, hide: bool, limit: i64| {
            let (pool, ctx) = (pool.clone(), ctx.clone());
            async move { names(suggest(&pool, me, false, hide, &ctx, &q, limit).await.unwrap()) }
        };

        assert_eq!(ask(String::new(), true, 6).await, vec![n("s"), n("a"), n("b"), n("f")], "no one else on an empty q");
        assert_eq!(ask(String::new(), false, 6).await, vec![n("s"), n("t"), n("a"), n("b"), n("f")], "a test account shows when hiding is off");
        assert_eq!(ask(p.clone(), true, 8).await, vec![n("s"), n("a"), n("b"), n("f"), n("o")]);
        assert_eq!(ask(p.clone(), false, 8).await, vec![n("s"), n("t"), n("a"), n("b"), n("f"), n("o")]);
        assert_eq!(ask(String::new(), true, 2).await, vec![n("s"), n("a")]);
        assert_eq!(ask(n("b"), true, 6).await, vec![n("b")]);
        assert_eq!(ask(n("a"), true, 6).await, vec![n("a")], "a chatter who is a friend is listed once");
        assert_eq!(ask(n("c"), true, 6).await, Vec::<String>::new(), "never the caller");
        assert_eq!(ask(n("u"), true, 6).await, Vec::<String>::new(), "never an unverified name");
        assert_eq!(ask(n("t"), true, 6).await, Vec::<String>::new(), "never a hidden test account");
        assert_eq!(ask(n("zz"), true, 6).await, Vec::<String>::new());

        let own = names(suggest(&pool, streamer, false, true, &ctx, "", 6).await.unwrap());
        assert_eq!(own, vec![n("c"), n("a"), n("b")], "a streamer never sees themself");

        forget(&pool, &[streamer, me, a, b, f, o, u, t], &[room]).await;
    }

    async fn a_member(pool: &PgPool, group: &str, user: Uuid) {
        sqlx::query("INSERT INTO memberships (name, group_name, user_id) SELECT name, $1, id FROM streamers WHERE id = $2")
            .bind(group)
            .bind(user)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn a_channels_list_is_its_chatters_then_its_members_and_only_who_can_see_it() {
        let pool = test_db().await;
        let run = std::process::id();
        let p = format!("mc{run}-");
        let n = |x: &str| format!("{p}{x}");
        let group = format!("mcg{run}");
        sqlx::query("INSERT INTO groups (name, badge, color) VALUES ($1, 'MEN', '#5865f2')").bind(&group).execute(&pool).await.unwrap();
        for channel in ["secret", "general"] {
            sqlx::query("INSERT INTO channels (server, name) VALUES ($1, $2)").bind(&group).bind(channel).execute(&pool).await.unwrap();
        }
        let role: Uuid = sqlx::query_scalar("INSERT INTO roles (group_name, name, color) VALUES ($1, 'inner', '#ffffff') RETURNING id")
            .bind(&group)
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_roles (server, channel, role_id) VALUES ($1, 'secret', $2)").bind(&group).bind(role).execute(&pool).await.unwrap();
        let me = row(&pool, &n("c"), Some("h")).await;
        let a = row(&pool, &n("a"), Some("h")).await;
        let b = row(&pool, &n("b"), Some("h")).await;
        let m = row(&pool, &n("m"), Some("h")).await;
        let x = row(&pool, &n("x"), Some("h")).await;
        let outside = row(&pool, &n("o"), Some("h")).await;
        let t = a_test_account(&pool, &n("t")).await;
        for user in [me, a, b, m, x, t] {
            a_member(&pool, &group, user).await;
        }
        for user in [me, a, m, t] {
            sqlx::query("INSERT INTO role_members (user_id, role_id) VALUES ($1, $2)").bind(user).bind(role).execute(&pool).await.unwrap();
        }
        let secret = format!("{group}/secret");
        says(&pool, &secret, 1, &n("b"), Some(b)).await;
        says(&pool, &secret, 2, &n("a"), Some(a)).await;
        says(&pool, &secret, 3, &n("c"), Some(me)).await;
        let in_secret = Ctx::Channel(group.clone(), "secret".into());
        let in_general = Ctx::Channel(group.clone(), "general".into());

        let got = |who: Uuid, ctx: Ctx, q: String, hide: bool| {
            let pool = pool.clone();
            async move { suggest(&pool, who, false, hide, &ctx, &q, 8).await }
        };
        assert_eq!(names(got(me, in_secret.clone(), String::new(), true).await.unwrap()), vec![n("a")], "a chatter who lost the channel is left out");
        assert_eq!(names(got(me, in_secret.clone(), p.clone(), true).await.unwrap()), vec![n("a"), n("m")], "members who see it, never one who can't or an outsider");
        assert_eq!(names(got(me, in_secret.clone(), p.clone(), false).await.unwrap()), vec![n("a"), n("m"), n("t")]);
        assert_eq!(names(got(me, in_secret.clone(), n("b"), true).await.unwrap()), Vec::<String>::new());
        assert_eq!(names(got(x, in_general.clone(), p.clone(), true).await.unwrap()), vec![n("a"), n("b"), n("c"), n("m")]);
        assert_eq!(names(got(x, in_general.clone(), String::new(), true).await.unwrap()), Vec::<String>::new(), "no members on an empty q");

        assert_eq!(status_of(got(x, in_secret.clone(), String::new(), true).await.unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status_of(got(outside, in_secret.clone(), String::new(), true).await.unwrap_err()), StatusCode::FORBIDDEN);
        let nowhere = Ctx::Channel(group.clone(), "nowhere".into());
        assert_eq!(status_of(got(me, nowhere, String::new(), true).await.unwrap_err()), StatusCode::FORBIDDEN);
        assert!(suggest(&pool, x, true, true, &in_secret, "", 8).await.is_ok(), "a site admin sees every channel");

        sqlx::query("DELETE FROM groups WHERE name = $1").bind(&group).execute(&pool).await.unwrap();
        forget(&pool, &[me, a, b, m, x, outside, t], &[secret]).await;
    }

    #[tokio::test]
    #[ignore]
    async fn a_dms_list_is_the_friend_alone() {
        let pool = test_db().await;
        let p = format!("md{}-", std::process::id());
        let n = |x: &str| format!("{p}{x}");
        let me = row(&pool, &n("c"), Some("h")).await;
        let f = row(&pool, &n("f"), Some("h")).await;
        let o = row(&pool, &n("o"), Some("h")).await;
        let u = row(&pool, &n("u"), None).await;
        let t = a_test_account(&pool, &n("t")).await;
        befriend(&pool, me, f).await;
        befriend(&pool, me, u).await;
        befriend(&pool, me, t).await;
        follow(&pool, me, o).await;
        let dm = |name: String, q: String, hide: bool| {
            let pool = pool.clone();
            async move { suggest(&pool, me, false, hide, &Ctx::Dm(name), &q, 6).await }
        };

        assert_eq!(names(dm(n("f"), String::new(), true).await.unwrap()), vec![n("f")]);
        assert_eq!(names(dm(n("f"), p.clone(), true).await.unwrap()), vec![n("f")]);
        assert_eq!(names(dm(n("f"), "zz".into(), true).await.unwrap()), Vec::<String>::new());
        assert_eq!(names(dm(n("t"), String::new(), true).await.unwrap()), Vec::<String>::new());
        assert_eq!(names(dm(n("t"), String::new(), false).await.unwrap()), vec![n("t")]);
        for stranger in [n("o"), n("u"), n("c"), n("nobody")] {
            assert_eq!(status_of(dm(stranger.clone(), String::new(), true).await.unwrap_err()), StatusCode::FORBIDDEN, "{stranger}");
        }

        forget(&pool, &[me, f, o, u, t], &[]).await;
    }

    #[tokio::test]
    #[ignore]
    async fn a_said_mention_resolves_to_known_accounts_and_is_kept_on_the_line() {
        let pool = test_db().await;
        let p = format!("mp{}-", std::process::id());
        let n = |x: &str| format!("{p}{x}");
        let me = row(&pool, &n("c"), Some("h")).await;
        let a = row(&pool, &n("a"), Some("h")).await;
        let u = row(&pool, &n("u"), None).await;
        let t = a_test_account(&pool, &n("t")).await;
        let text = format!("hey @{} and @{} and @{} and @{} x@{}.com @{}", n("a").to_uppercase(), n("u"), n("t"), n("nobody"), n("a"), n("a"));

        assert_eq!(resolve(&pool, true, &text).await, vec![n("a")]);
        assert_eq!(resolve(&pool, false, &text).await, vec![n("a"), n("t")]);
        assert_eq!(resolve(&pool, false, "no at sign here").await, Vec::<String>::new());

        let room = n("room");
        let mentions = resolve(&pool, true, &text).await;
        crate::history::store(&pool, &room, "1729000000000-0", &n("c"), Some(me), &text, None, None, false, true, &[], None, &mentions).await.unwrap();
        crate::history::store(&pool, &room, "1729000000001-0", &n("c"), Some(me), "plain", None, None, false, true, &[], None, &[]).await.unwrap();
        let kept: Vec<String> = sqlx::query_scalar("SELECT mentions FROM chat_lines WHERE room = $1 AND id = '1729000000000-0'").bind(&room).fetch_one(&pool).await.unwrap();
        assert_eq!(kept, vec![n("a")]);
        let lines = crate::history::by_account(&pool, std::slice::from_ref(&room), me, None, 10).await.unwrap();
        let json: Vec<serde_json::Value> = lines.iter().map(|(_, line)| serde_json::to_value(line).unwrap()).collect();
        assert_eq!(json[0]["text"], "plain");
        assert!(json[0].get("mentions").is_none(), "no key when no one is named");
        assert_eq!(json[1]["mentions"], serde_json::json!([n("a")]));

        forget(&pool, &[me, a, u, t], &[room]).await;
    }
}
