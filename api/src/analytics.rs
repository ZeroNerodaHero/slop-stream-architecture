use std::collections::HashMap;
use std::time::Duration;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Me;
use crate::{video_viewers, ApiError, ApiResult, AppState, Name};

const WATCH_GAP_SECS: f64 = 150.0;
const LIST_LIMIT: i64 = 50;
const DAYS: [i64; 2] = [7, 30];

pub(crate) async fn open(db: &PgPool, session: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO stream_sessions (id, streamer, started_at)
         SELECT id, user_id, started_at FROM sessions WHERE id = $1 AND user_id IS NOT NULL
         ON CONFLICT DO NOTHING",
    )
    .bind(session)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn ended(db: &PgPool, session: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE stream_sessions ss SET ended_at = s.ended_at FROM sessions s
         WHERE ss.id = $1 AND s.id = ss.id AND ss.ended_at IS NULL AND s.ended_at IS NOT NULL",
    )
    .bind(session)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn peak(db: &PgPool, session: i64, viewers: usize) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE stream_sessions SET peak_viewers = $2 WHERE id = $1 AND ended_at IS NULL AND peak_viewers < $2")
        .bind(session)
        .bind(clamp(viewers))
        .execute(db)
        .await?;
    Ok(())
}

fn clamp(viewers: usize) -> i32 {
    i32::try_from(viewers).unwrap_or(i32::MAX)
}

pub(crate) async fn sync(db: &PgPool) -> Result<u64, sqlx::Error> {
    sqlx::query(
        "INSERT INTO stream_sessions (id, streamer, started_at)
         SELECT id, user_id, started_at FROM sessions WHERE ended_at IS NULL AND user_id IS NOT NULL
         ON CONFLICT DO NOTHING",
    )
    .execute(db)
    .await?;
    let ended = sqlx::query(
        "UPDATE stream_sessions ss SET ended_at = s.ended_at FROM sessions s
         WHERE ss.ended_at IS NULL AND s.id = ss.id AND s.ended_at IS NOT NULL",
    )
    .execute(db)
    .await?;
    Ok(ended.rows_affected())
}

pub(crate) async fn sample(db: &PgPool, counts: &HashMap<String, usize>, at: DateTime<Utc>) -> Result<u64, sqlx::Error> {
    if counts.is_empty() {
        return Ok(0);
    }
    let (names, viewers): (Vec<String>, Vec<i32>) = counts.iter().map(|(n, v)| (n.clone(), clamp(*v))).unzip();
    let wrote = sqlx::query(
        "INSERT INTO viewer_samples (session_id, ts, viewers)
         SELECT ss.id, date_trunc('minute', $3::timestamptz), c.viewers
         FROM stream_sessions ss
         JOIN sessions s ON s.id = ss.id AND s.ended_at IS NULL
         JOIN unnest($1::text[], $2::int[]) AS c(name, viewers) ON c.name = s.name
         WHERE ss.ended_at IS NULL
         ON CONFLICT DO NOTHING",
    )
    .bind(&names)
    .bind(&viewers)
    .bind(at)
    .execute(db)
    .await?;
    sqlx::query(
        "UPDATE stream_sessions ss SET peak_viewers = v.viewers FROM viewer_samples v
         WHERE ss.ended_at IS NULL AND v.session_id = ss.id AND v.ts = date_trunc('minute', $1::timestamptz) AND v.viewers > ss.peak_viewers",
    )
    .bind(at)
    .execute(db)
    .await?;
    Ok(wrote.rows_affected())
}

pub(crate) async fn sampler(s: AppState) {
    match sync(&s.db).await {
        Ok(0) => {}
        Ok(n) => log::info!("analytics: {n} streams ended while the api was down"),
        Err(e) => log::warn!("analytics sync: {e}"),
    }
    loop {
        let now = Utc::now();
        let into = now.timestamp().rem_euclid(60) as u64;
        tokio::time::sleep(Duration::from_secs(61 - into)).await;
        if let Err(e) = sync(&s.db).await {
            log::warn!("analytics sync: {e}");
            continue;
        }
        let Some(counts) = video_viewers(&s.http, &s.video_url).await else { continue };
        if let Err(e) = sample(&s.db, &counts, Utc::now()).await {
            log::warn!("analytics sample: {e}");
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Viewer {
    pub(crate) id: Uuid,
    pub(crate) anon: bool,
}

pub(crate) async fn beat(db: &PgPool, name: &str, viewer: Viewer, leave: bool) -> Result<bool, sqlx::Error> {
    let stream: Option<(i64, Uuid)> = sqlx::query_as(
        "SELECT ss.id, ss.streamer FROM stream_sessions ss JOIN sessions s ON s.id = ss.id
         WHERE s.name = $1 AND s.ended_at IS NULL AND ss.ended_at IS NULL
         ORDER BY ss.started_at DESC LIMIT 1",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    let Some((session, streamer)) = stream else { return Ok(false) };
    if !viewer.anon && viewer.id == streamer {
        return Ok(false);
    }
    let goes_on = sqlx::query(
        "UPDATE watch_sessions SET left_at = now()
         WHERE session_id = $1 AND viewer = $2 AND left_at > now() - make_interval(secs => $3)
           AND joined_at = (SELECT max(joined_at) FROM watch_sessions WHERE session_id = $1 AND viewer = $2)",
    )
    .bind(session)
    .bind(viewer.id)
    .bind(WATCH_GAP_SECS)
    .execute(db)
    .await?;
    if goes_on.rows_affected() > 0 {
        return Ok(true);
    }
    if leave {
        return Ok(false);
    }
    let started = sqlx::query(
        "INSERT INTO watch_sessions (session_id, viewer, joined_at, left_at, anon) VALUES ($1, $2, now(), now(), $3)
         ON CONFLICT DO NOTHING",
    )
    .bind(session)
    .bind(viewer.id)
    .bind(viewer.anon)
    .execute(db)
    .await?;
    Ok(started.rows_affected() > 0)
}

#[derive(Deserialize)]
struct WatchingQuery {
    anon: Option<String>,
    leave: Option<String>,
}

async fn watching(State(s): State<AppState>, Name(name): Name, me: Me, q: Result<Query<WatchingQuery>, QueryRejection>) -> ApiResult {
    let Query(q) = q?;
    let viewer = match (&me.0, q.anon.as_deref().map(Uuid::parse_str)) {
        (Some(a), _) => Viewer { id: a.id, anon: false },
        (None, Some(Ok(id))) => Viewer { id, anon: true },
        (None, _) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "anon: the browser's id, a uuid")),
    };
    let leave = matches!(q.leave.as_deref(), Some("1" | "true"));
    let counted = beat(&s.db, &name, viewer, leave).await?;
    Ok(Json(json!({ "ok": true, "counted": counted })))
}

fn owner(me: &Me) -> Result<Uuid, ApiError> {
    me.0.as_ref().map(|a| a.id).ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "make an account to see your stream stats"))
}

type StreamRow = (i64, String, DateTime<Utc>, Option<DateTime<Utc>>, i32, Option<f64>, f64, i64);

const STREAM_COLUMNS: &str = "SELECT ss.id, s.name, ss.started_at, ss.ended_at,
       GREATEST(ss.peak_viewers, COALESCE(v.peak, 0)), v.avg, COALESCE(w.secs, 0), COALESCE(w.uniq, 0)
     FROM stream_sessions ss
     JOIN sessions s ON s.id = ss.id
     LEFT JOIN LATERAL (SELECT max(viewers) AS peak, avg(viewers)::float8 AS avg FROM viewer_samples WHERE session_id = ss.id) v ON true
     LEFT JOIN LATERAL (SELECT sum(EXTRACT(EPOCH FROM left_at - joined_at))::float8 AS secs, count(DISTINCT viewer) AS uniq
                        FROM watch_sessions WHERE session_id = ss.id) w ON true";

fn stream_json(r: &StreamRow, now: DateTime<Utc>) -> Value {
    let (id, name, started_at, ended_at, peak, avg, watch_secs, unique) = r;
    let duration = (ended_at.unwrap_or(now) - *started_at).num_seconds().max(0);
    json!({
        "id": id, "name": name, "started_at": started_at, "ended_at": ended_at, "live": ended_at.is_none(),
        "duration_secs": duration, "peak_viewers": peak, "avg_viewers": avg.map(|a| (a * 10.0).round() / 10.0),
        "watch_secs": watch_secs.round() as i64, "unique_viewers": unique,
    })
}

async fn stream_detail(db: &PgPool, streamer: Uuid, id: i64) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<StreamRow> = sqlx::query_as(&format!("{STREAM_COLUMNS} WHERE ss.id = $1 AND ss.streamer = $2"))
        .bind(id)
        .bind(streamer)
        .fetch_optional(db)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let now = Utc::now();
    let (_, name, started_at, ended_at, ..) = &row;
    let until = ended_at.unwrap_or(now);
    let points: Vec<(DateTime<Utc>, i32)> = sqlx::query_as("SELECT ts, viewers FROM viewer_samples WHERE session_id = $1 ORDER BY ts")
        .bind(id)
        .fetch_all(db)
        .await?;
    let (accounts, anon): (i64, i64) = sqlx::query_as(
        "SELECT count(DISTINCT viewer) FILTER (WHERE NOT anon), count(DISTINCT viewer) FILTER (WHERE anon)
         FROM watch_sessions WHERE session_id = $1",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    let follows: i64 = sqlx::query_scalar("SELECT count(*) FROM follows WHERE followed_id = $1 AND followed_at >= $2 AND followed_at < $3")
        .bind(streamer)
        .bind(started_at)
        .bind(until)
        .fetch_one(db)
        .await?;
    let (lines, chatters): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(DISTINCT COALESCE(user_id::text, speaker)) FROM chat_lines
         WHERE room = $1 AND at >= $2 AND at < $3 AND NOT streamer",
    )
    .bind(name)
    .bind(started_at)
    .bind(until)
    .fetch_one(db)
    .await?;
    let mut out = stream_json(&row, now);
    let points: Vec<Value> = points.into_iter().map(|(ts, v)| json!([ts.timestamp_millis(), v])).collect();
    out["points"] = Value::Array(points);
    out["account_viewers"] = json!(accounts);
    out["anon_viewers"] = json!(anon);
    out["new_follows"] = json!(follows);
    out["chat_messages"] = json!(lines);
    out["chatters"] = json!(chatters);
    Ok(Some(out))
}

type SummaryRow = (i64, f64, Option<f64>, Option<i32>, f64, i64);

async fn summary(db: &PgPool, streamer: Uuid, days: i64) -> Result<Value, sqlx::Error> {
    let since = Utc::now() - chrono::Duration::days(days);
    let (streams, live_secs, avg, peak, watch_secs, unique): SummaryRow = sqlx::query_as(
        "WITH mine AS (SELECT id, started_at, ended_at, peak_viewers FROM stream_sessions WHERE streamer = $1 AND started_at >= $2)
         SELECT (SELECT count(*) FROM mine),
                (SELECT COALESCE(sum(EXTRACT(EPOCH FROM COALESCE(ended_at, now()) - started_at)), 0)::float8 FROM mine),
                (SELECT avg(viewers)::float8 FROM viewer_samples WHERE session_id IN (SELECT id FROM mine)),
                (SELECT GREATEST(max(m.peak_viewers), max(v.viewers)) FROM mine m LEFT JOIN viewer_samples v ON v.session_id = m.id),
                (SELECT COALESCE(sum(EXTRACT(EPOCH FROM left_at - joined_at)), 0)::float8 FROM watch_sessions WHERE session_id IN (SELECT id FROM mine)),
                (SELECT count(DISTINCT viewer) FROM watch_sessions WHERE session_id IN (SELECT id FROM mine))",
    )
    .bind(streamer)
    .bind(since)
    .fetch_one(db)
    .await?;
    let follows: i64 = sqlx::query_scalar("SELECT count(*) FROM follows WHERE followed_id = $1 AND followed_at >= $2")
        .bind(streamer)
        .bind(since)
        .fetch_one(db)
        .await?;
    Ok(json!({
        "days": days, "streams": streams, "live_secs": live_secs.round() as i64,
        "avg_viewers": avg.map(|a| (a * 10.0).round() / 10.0), "peak_viewers": peak.unwrap_or(0),
        "watch_secs": watch_secs.round() as i64, "unique_viewers": unique, "new_follows": follows,
    }))
}

#[derive(Deserialize)]
struct StatsQuery {
    days: Option<i64>,
}

async fn stats(State(s): State<AppState>, me: Me, q: Result<Query<StatsQuery>, QueryRejection>) -> ApiResult {
    let streamer = owner(&me)?;
    let Query(q) = q?;
    let days = q.days.unwrap_or(7);
    if !DAYS.contains(&days) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "days: 7 or 30"));
    }
    let since = Utc::now() - chrono::Duration::days(days);
    let rows: Vec<StreamRow> = sqlx::query_as(&format!(
        "{STREAM_COLUMNS} WHERE ss.streamer = $1 AND ss.started_at >= $2 ORDER BY ss.started_at DESC LIMIT $3"
    ))
    .bind(streamer)
    .bind(since)
    .bind(LIST_LIMIT)
    .fetch_all(&s.db)
    .await?;
    let now = Utc::now();
    let last_id: Option<i64> = sqlx::query_scalar("SELECT id FROM stream_sessions WHERE streamer = $1 ORDER BY started_at DESC LIMIT 1")
        .bind(streamer)
        .fetch_optional(&s.db)
        .await?;
    let last = match last_id {
        Some(id) => stream_detail(&s.db, streamer, id).await?,
        None => None,
    };
    Ok(Json(json!({
        "summary": summary(&s.db, streamer, days).await?,
        "streams": rows.iter().map(|r| stream_json(r, now)).collect::<Vec<_>>(),
        "last": last,
    })))
}

async fn stream(State(s): State<AppState>, me: Me, Path(id): Path<i64>) -> ApiResult {
    let streamer = owner(&me)?;
    match stream_detail(&s.db, streamer, id).await? {
        Some(v) => Ok(Json(v)),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "no such stream")),
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/streams/{name}/watching", post(watching))
        .route("/api/stats", get(stats))
        .route("/api/stats/streams/{id}", get(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::tests::{row, test_db};
    use crate::auth::Account;

    async fn go_live(pool: &PgPool, name: &str, user: Option<Uuid>) -> i64 {
        let id: i64 = sqlx::query_scalar("INSERT INTO sessions (name, verified, user_id) VALUES ($1, $2, $3) RETURNING id")
            .bind(name)
            .bind(user.is_some())
            .bind(user)
            .fetch_one(pool)
            .await
            .unwrap();
        open(pool, id).await.unwrap();
        id
    }

    async fn end(pool: &PgPool, id: i64) {
        sqlx::query("UPDATE sessions SET ended_at = now(), ended_by = 'sweep' WHERE id = $1").bind(id).execute(pool).await.unwrap();
    }

    async fn samples(pool: &PgPool, id: i64) -> Vec<i32> {
        sqlx::query_scalar("SELECT viewers FROM viewer_samples WHERE session_id = $1 ORDER BY ts").bind(id).fetch_all(pool).await.unwrap()
    }

    fn at(minute: u32, second: u32) -> DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(2026, 11, 23, 20, minute, second).unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn analytics_a_stream_is_opened_sampled_once_a_minute_and_closed_by_its_session() {
        let pool = test_db().await;
        let run = std::process::id();
        let name = format!("ana1-{run}");
        let free = format!("ana1free-{run}");
        let user = row(&pool, &name, Some("hash")).await;
        let id = go_live(&pool, &name, Some(user)).await;
        let anon = go_live(&pool, &free, None).await;
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM stream_sessions WHERE id = ANY($1)").bind(vec![id, anon]).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 1);

        let counts = HashMap::from([(name.clone(), 3usize), (free.clone(), 9)]);
        assert_eq!(sample(&pool, &counts, at(1, 1)).await.unwrap(), 1);
        assert_eq!(sample(&pool, &HashMap::from([(name.clone(), 5usize)]), at(1, 40)).await.unwrap(), 0);
        sample(&pool, &HashMap::from([(name.clone(), 7usize)]), at(2, 1)).await.unwrap();
        sample(&pool, &HashMap::from([("someone-else".to_string(), 1usize)]), at(3, 1)).await.unwrap();
        assert_eq!(samples(&pool, id).await, vec![3, 7]);

        peak(&pool, id, 12).await.unwrap();
        peak(&pool, id, 4).await.unwrap();
        let p: i32 = sqlx::query_scalar("SELECT peak_viewers FROM stream_sessions WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(p, 12);

        end(&pool, id).await;
        assert!(sync(&pool).await.unwrap() >= 1);
        let (ended, session_end): (Option<DateTime<Utc>>, Option<DateTime<Utc>>) =
            sqlx::query_as("SELECT ss.ended_at, s.ended_at FROM stream_sessions ss JOIN sessions s ON s.id = ss.id WHERE ss.id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(ended.is_some());
        assert_eq!(ended, session_end);
        sample(&pool, &HashMap::from([(name.clone(), 2usize)]), at(4, 1)).await.unwrap();
        assert_eq!(samples(&pool, id).await, vec![3, 7]);
    }

    #[tokio::test]
    #[ignore]
    async fn analytics_sync_heals_what_happened_while_the_api_was_down() {
        let pool = test_db().await;
        let run = std::process::id();
        let name = format!("ana2-{run}");
        let user = row(&pool, &name, Some("hash")).await;
        let unseen: i64 = sqlx::query_scalar("INSERT INTO sessions (name, verified, user_id) VALUES ($1, true, $2) RETURNING id")
            .bind(&name)
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
        sync(&pool).await.unwrap();
        let open_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM stream_sessions WHERE id = $1 AND ended_at IS NULL")
            .bind(unseen)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(open_rows, 1);
        end(&pool, unseen).await;
        ended(&pool, unseen).await.unwrap();
        sync(&pool).await.unwrap();
        let still_open: i64 = sqlx::query_scalar("SELECT count(*) FROM stream_sessions WHERE id = $1 AND ended_at IS NULL")
            .bind(unseen)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(still_open, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn analytics_watch_beats_make_one_stretch_per_viewer() {
        let pool = test_db().await;
        let run = std::process::id();
        let name = format!("ana3-{run}");
        let streamer = row(&pool, &name, Some("hash")).await;
        let fan_name = format!("ana3fan-{run}");
        let fan = row(&pool, &fan_name, Some("hash")).await;
        let stranger = Viewer { id: Uuid::from_u128(rand::random()), anon: true };

        assert!(!beat(&pool, &name, stranger, false).await.unwrap());
        let id = go_live(&pool, &name, Some(streamer)).await;

        assert!(beat(&pool, &name, stranger, false).await.unwrap());
        assert!(beat(&pool, &name, stranger, false).await.unwrap(), "the next beat goes on the same stretch");
        assert!(beat(&pool, &name, Viewer { id: fan, anon: false }, false).await.unwrap());
        assert!(!beat(&pool, &name, Viewer { id: streamer, anon: false }, false).await.unwrap());
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM watch_sessions WHERE session_id = $1").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 2);

        sqlx::query("UPDATE watch_sessions SET joined_at = joined_at - interval '20 minutes', left_at = left_at - interval '10 minutes' WHERE viewer = $1")
            .bind(stranger.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(!beat(&pool, &name, stranger, true).await.unwrap());
        assert!(beat(&pool, &name, stranger, false).await.unwrap());
        let theirs: i64 = sqlx::query_scalar("SELECT count(*) FROM watch_sessions WHERE session_id = $1 AND viewer = $2")
            .bind(id)
            .bind(stranger.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(theirs, 2);

        let detail = stream_detail(&pool, streamer, id).await.unwrap().expect("their stream");
        assert_eq!(detail["unique_viewers"], 2);
        assert_eq!(detail["account_viewers"], 1);
        assert_eq!(detail["anon_viewers"], 1);
        assert!(detail["watch_secs"].as_i64().unwrap() >= 600);
        assert_eq!(detail["live"], true);
    }

    #[tokio::test]
    #[ignore]
    async fn analytics_stats_are_the_owners_alone() {
        let pool = test_db().await;
        let run = std::process::id();
        let name = format!("ana4-{run}");
        let streamer = row(&pool, &name, Some("hash")).await;
        let other_name = format!("ana4other-{run}");
        let other = row(&pool, &other_name, Some("hash")).await;
        let id = go_live(&pool, &name, Some(streamer)).await;
        sample(&pool, &HashMap::from([(name.clone(), 4usize)]), Utc::now()).await.unwrap();
        sqlx::query("INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)").bind(other).bind(streamer).execute(&pool).await.unwrap();

        let err = owner(&Me(None)).expect_err("a guest");
        assert_eq!(axum::response::IntoResponse::into_response(err).status(), StatusCode::UNAUTHORIZED);
        assert_eq!(owner(&Me(Some(Account { id: streamer, name: name.clone() }))).unwrap(), streamer);

        assert!(stream_detail(&pool, other, id).await.unwrap().is_none());
        let mine = stream_detail(&pool, streamer, id).await.unwrap().expect("my stream");
        assert_eq!(mine["points"].as_array().unwrap().len(), 1);
        assert_eq!(mine["peak_viewers"], 4);
        assert_eq!(mine["new_follows"], 1);

        let week = summary(&pool, streamer, 7).await.unwrap();
        assert_eq!(week["streams"], 1);
        assert_eq!(week["peak_viewers"], 4);
        assert_eq!(week["avg_viewers"], 4.0);
        assert_eq!(week["new_follows"], 1);
        let theirs = summary(&pool, other, 30).await.unwrap();
        assert_eq!(theirs["streams"], 0);
        assert_eq!(theirs["avg_viewers"], Value::Null);
    }
}
