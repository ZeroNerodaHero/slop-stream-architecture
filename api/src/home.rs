use std::cmp::Ordering;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, TimeZone, Utc};
use redis::streams::{StreamId, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::groups;
use crate::presence::{self, EVENTS_KEY};
use crate::profile;
use crate::socket::READ_BLOCK_MS;
use crate::{video_viewers, ApiError, ApiResult, OPTIONAL_PROBE};

const REPLAY_MS: i64 = 10_000;
const HEAL_EVERY: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct Home {
    db: PgPool,
    client: redis::Client,
    http: reqwest::Client,
    video_url: String,
    table: Arc<Mutex<HashMap<String, Live>>>,
}

#[derive(Clone)]
struct Live {
    session: Option<i64>,
    since: Option<DateTime<Utc>>,
    verified: bool,
    viewers: Option<usize>,
    added: Instant,
}

pub(crate) async fn run(db: PgPool, redis_url: &str, video_url: &str, port: u16) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let http = reqwest::Client::builder().timeout(OPTIONAL_PROBE).build()?;
    let home = Home {
        db,
        client,
        http,
        video_url: video_url.trim_end_matches('/').to_owned(),
        table: Arc::new(Mutex::new(HashMap::new())),
    };
    home.heal().await;
    tokio::spawn(tail(home.clone()));
    tokio::spawn(heal_every(home.clone()));

    let limits = crate::ratelimit::ByIp { redis: crate::connect_redis(redis_url).await, rule: crate::ratelimit::home_rule };
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/streams", get(list))
        .route_layer(axum::middleware::from_fn_with_state(limits, crate::ratelimit::by_ip))
        .layer(axum::middleware::map_response(crate::media::no_store_by_default))
        .with_state(home);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("home on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).with_graceful_shutdown(crate::wait_for_signal()).await?;
    Ok(())
}

async fn list(State(h): State<Home>) -> Result<impl IntoResponse, ApiError> {
    Ok(([(header::CACHE_CONTROL, crate::media::PRIVATE_CACHE)], snapshot(&h).await?))
}

async fn snapshot(h: &Home) -> ApiResult {
    let mut live: Vec<(String, Live)> = h.table.lock().await.iter().map(|(n, l)| (n.clone(), l.clone())).collect();
    if live.is_empty() {
        return Ok(Json(json!([])));
    }
    live.sort_by(|a, b| match (a.1.since, b.1.since) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.0.cmp(&b.0)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.0.cmp(&b.0),
    });
    let names: Vec<String> = live.iter().map(|(n, _)| n.clone()).collect();
    let cards = cards_of(&h.db, &names).await?;
    let thumbs = profile::thumb_ids(&h.db, &names).await?;
    let mut badges = groups::badges_by_name(&h.db, &names).await?;
    let out = live.into_iter().map(|(name, l)| {
        let (bio, avatar) = cards.get(&name).cloned().unwrap_or_default();
        let pictures = thumbs.get(&name).cloned().unwrap_or_default();
        let badge = if l.verified { badges.remove(&name) } else { None };
        json!({ "name": name, "bio": bio, "since": l.since, "verified": l.verified, "avatar": avatar, "thumbs": pictures, "viewers": l.viewers, "badge": badge })
    });
    Ok(Json(Value::Array(out.collect())))
}

async fn cards_of(db: &PgPool, names: &[String]) -> Result<HashMap<String, (String, Option<i64>)>, sqlx::Error> {
    let rows: Vec<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT name, bio, (EXTRACT(EPOCH FROM avatar_at))::bigint FROM streamers WHERE name = ANY($1)")
            .bind(names)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(n, b, a)| (n, (b, a))).collect())
}

async fn open_sessions(db: &PgPool, names: &[String]) -> Result<HashMap<String, (i64, DateTime<Utc>, bool)>, sqlx::Error> {
    let rows: Vec<(String, i64, DateTime<Utc>, bool)> = sqlx::query_as(
        "SELECT DISTINCT ON (name) name, id, started_at, verified FROM sessions
         WHERE name = ANY($1) AND ended_at IS NULL ORDER BY name, started_at DESC",
    )
    .bind(names)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(n, id, at, v)| (n, (id, at, v))).collect())
}

impl Home {
    async fn heal(&self) {
        let began = Instant::now();
        let Some(counts) = video_viewers(&self.http, &self.video_url).await else {
            log::info!("home: video unreachable, the table stands");
            return;
        };
        let missing: Vec<String> = {
            let table = self.table.lock().await;
            counts.keys().filter(|n| !table.contains_key(*n)).cloned().collect()
        };
        let rows = if missing.is_empty() {
            HashMap::new()
        } else {
            match open_sessions(&self.db, &missing).await {
                Ok(rows) => rows,
                Err(e) => {
                    log::warn!("home: postgres: {e}");
                    HashMap::new()
                }
            }
        };
        let mut table = self.table.lock().await;
        let before = table.len();
        table.retain(|name, live| counts.contains_key(name) || live.added > began);
        for (name, count) in counts {
            let entry = table.entry(name.clone()).or_insert_with(|| {
                let row = rows.get(&name);
                Live {
                    session: row.map(|r| r.0),
                    since: row.map(|r| r.1),
                    verified: row.is_some_and(|r| r.2),
                    viewers: None,
                    added: Instant::now(),
                }
            });
            entry.viewers = Some(count);
        }
        if table.len() != before || !missing.is_empty() {
            log::info!("home: {} live after video's word ({before} before, {} came in)", table.len(), missing.len());
        }
    }

    async fn apply(&self, entry: StreamId) {
        let (Some(kind), Some(name)): (Option<String>, Option<String>) = (entry.get("type"), entry.get("name")) else { return };
        let session: Option<i64> = entry.get("session");
        let mut table = self.table.lock().await;
        let same_session = |live: &Live| session.is_none() || live.session.is_none() || live.session == session;
        match kind.as_str() {
            "live" => {
                let since: Option<i64> = entry.get("since");
                let since = since.and_then(|ms| Utc.timestamp_millis_opt(ms).single());
                let verified = entry
                    .get::<String>("card")
                    .and_then(|card| serde_json::from_str::<Value>(&card).ok())
                    .and_then(|card| card.get("verified")?.as_bool())
                    .unwrap_or(false);
                let live = table.entry(name).or_insert(Live { session: None, since: None, verified: false, viewers: None, added: Instant::now() });
                if session.is_some() && live.session.is_some() && live.session != session {
                    live.viewers = None;
                }
                live.session = session.or(live.session);
                live.since = since.or(live.since);
                live.verified = verified;
            }
            "ended" => {
                if table.get(&name).is_some_and(same_session) {
                    table.remove(&name);
                }
            }
            "viewers" => {
                let count: Option<usize> = entry.get("viewers");
                if let (Some(live), Some(count)) = (table.get_mut(&name), count) {
                    if same_session(live) {
                        live.viewers = Some(count);
                    }
                }
            }
            _ => {}
        }
    }
}

async fn tail(home: Home) {
    let config = crate::socket::blocking_config(READ_BLOCK_MS);
    let mut last = format!("{}-0", presence::now_ms() - REPLAY_MS);
    loop {
        let mut con = match home.client.get_multiplexed_async_connection_with_config(&config).await {
            Ok(con) => con,
            Err(e) => {
                log::warn!("home: redis: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let options = StreamReadOptions::default().block(READ_BLOCK_MS).count(100);
        loop {
            let reply: Option<StreamReadReply> = match con.xread_options(&[EVENTS_KEY], &[&last], &options).await {
                Ok(reply) => reply,
                Err(e) => {
                    log::warn!("home: xread: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    break;
                }
            };
            let Some(reply) = reply else { continue };
            for stream in reply.keys {
                for entry in stream.ids {
                    last = entry.id.clone();
                    home.apply(entry).await;
                }
            }
        }
    }
}

async fn heal_every(home: Home) {
    let mut tick = tokio::time::interval(HEAL_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tick.tick().await;
        home.heal().await;
    }
}
