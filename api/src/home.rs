//! `api home`: the home page's list. One process that holds, in memory, every stream that is
//! live and how many are watching it, fed by the facts on the `events` stream (`live`,
//! `viewers`, `ended`), and answers `GET /api/streams` from that table: a snapshot, in the
//! order the streams came (first on, first shown). The pages take the snapshot once and then
//! the same facts over the events socket (`watch *`), so nothing polls. The ranking of the
//! home page, when there is one, lives here: this is the one place that sees every stream
//! and every count at once, and the pages already take their order from it. See docs/status.md.
//!
//! The table is honest without trusting every fact to arrive: it is built from video's own
//! word at boot (`GET /viewers`, with postgres for `since` and the ✓) and reconciled against
//! it every HEAL_EVERY, so a fact missed, a video restart, or a stream the sweeper has not
//! ended yet is put right within that. What the streamer edits (bio, picture, the pictures
//! on the card) is not held here: joined from postgres per answer, so an edit mid-stream is
//! on the next load. This process reads redis and the database and asks video; it writes
//! nothing anywhere, and keeps no state a restart cannot rebuild in one `GET /viewers`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, TimeZone, Utc};
use redis::streams::{StreamId, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::presence::{self, EVENTS_KEY};
use crate::profile;
use crate::socket::READ_BLOCK_MS;
use crate::{video_viewers, ApiResult, OPTIONAL_PROBE};

/// How far back the tail starts after a (re)start: the facts of the gap, replayed onto a table
/// that was just rebuilt from video, so a stream that started as the process did is not missed.
/// Every fact applies the same way twice.
const REPLAY_MS: i64 = 10_000;
/// Video's word against the table, this often. The facts are the fast lane; this is what makes them true.
const HEAL_EVERY: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct Home {
    db: PgPool,
    client: redis::Client,
    http: reqwest::Client,
    video_url: String,
    table: Arc<Mutex<HashMap<String, Live>>>,
}

/// One live stream as the facts describe it. The card's editable parts are not here.
#[derive(Clone)]
struct Live {
    /// The go-live session, when a fact or a row said. An `ended` or a count for another session is not this stream's.
    session: Option<i64>,
    /// When they went live: the order of the page. None when nobody said (goes last).
    since: Option<DateTime<Utc>>,
    /// The session's ✓, off the `live` fact's card or the row.
    verified: bool,
    /// Different addresses receiving it, as video last said. None until it has.
    viewers: Option<usize>,
    /// When the table took it in: a heal that began before then must not drop it on a snapshot older than it.
    added: Instant,
}

/// `api home`: the table from video's word, the tail, the heal, and the listener.
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
    // the table before the first answer: video's word now, the facts from here on
    home.heal().await;
    tokio::spawn(tail(home.clone()));
    tokio::spawn(heal_every(home.clone()));

    let router = Router::new().route("/health", get(|| async { "ok" })).route("/api/streams", get(list)).with_state(home);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("home on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).with_graceful_shutdown(crate::wait_for_signal()).await?;
    Ok(())
}

/// The snapshot: every live stream, first on first, with what the streamer put on the card.
/// `viewers` is null until video has said (a stream seconds old), as the pages expect.
async fn list(State(h): State<Home>) -> ApiResult {
    let mut live: Vec<(String, Live)> = h.table.lock().await.iter().map(|(n, l)| (n.clone(), l.clone())).collect();
    if live.is_empty() {
        return Ok(Json(json!([])));
    }
    // first come, first shown: by when they went live, the name to settle a tie; a stream
    // whose start nobody said goes last. the place for a ranking, when there is one
    live.sort_by(|a, b| match (a.1.since, b.1.since) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.0.cmp(&b.0)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.0.cmp(&b.0),
    });
    let names: Vec<String> = live.iter().map(|(n, _)| n.clone()).collect();
    let cards = cards_of(&h.db, &names).await?;
    // oldest first. empty means the card shows the camera, which is what a stream with none has always done
    let thumbs = profile::thumb_ids(&h.db, &names).await?;
    let out = live.into_iter().map(|(name, l)| {
        let (bio, avatar) = cards.get(&name).cloned().unwrap_or_default();
        let pictures = thumbs.get(&name).cloned().unwrap_or_default();
        json!({ "name": name, "bio": bio, "since": l.since, "verified": l.verified, "avatar": avatar, "thumbs": pictures, "viewers": l.viewers })
    });
    Ok(Json(Value::Array(out.collect())))
}

/// The editable half of a card, per name: bio and the picture's version. A name with no row has neither.
async fn cards_of(db: &PgPool, names: &[String]) -> Result<HashMap<String, (String, Option<i64>)>, sqlx::Error> {
    let rows: Vec<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT name, bio, (EXTRACT(EPOCH FROM avatar_at))::bigint FROM streamers WHERE name = ANY($1)")
            .bind(names)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(n, b, a)| (n, (b, a))).collect())
}

/// The open session of each name, newest where there are two: its id, start and ✓.
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
    /// Video's word against the table: names it does not have go, names it has that the table
    /// lacks come in (postgres for `since` and the ✓), every count is its. Nothing when video
    /// does not answer: a table kept is better than one emptied by a blip. A stream the table
    /// took in after this began is left alone: the snapshot may be older than its fact.
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

    /// One fact. `live` puts the name in (or refreshes its session and start), `ended` takes it
    /// out, `viewers` sets its count. A fact that names another session than the table's is an
    /// old stream's, late, and is dropped (a stop that came after the restart's `live`).
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
                    // another session took the name: the count was the old stream's
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

/// One tail of `events`, on its own connection. Starts REPLAY_MS back and continues from the
/// last id across redis blips, the gateway's shape (events.rs).
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
    tick.tick().await; // the first tick is immediate, and `run` healed already
    loop {
        tick.tick().await;
        home.heal().await;
    }
}
