//! `api chat`: the text chat next to a stream. See docs/chat.md.
//!
//! One websocket per viewer at /chat/<stream name>. Messages live in a redis
//! stream per room (`chat:<name>`, last 500 kept). One task per room with
//! viewers tails that stream with XREAD BLOCK and pushes new lines to every
//! socket in the room; sending is just XADD, so everyone sees the same order.
//! The database is asked one thing: is this socket really the streamer.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use redis::aio::ConnectionManager;
use redis::streams::{StreamId, StreamMaxlen, StreamRangeReply, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{broadcast, Mutex};

use crate::{owns_session, Name, Owner};

const HISTORY_LINES: usize = 200;
const KEEP_LINES: usize = 500;
const MAX_TEXT_CHARS: usize = 500;
const MAX_NICK_CHARS: usize = 24;
const MAX_FRAME_BYTES: usize = 8 * 1024;
const ROOM_TTL_SECS: i64 = 7 * 24 * 3600;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const READ_BLOCK_MS: usize = 5000;
/// Token bucket per socket: this many lines at once, then one per second.
const RATE_BURST: f64 = 5.0;
const RATE_PER_SEC: f64 = 1.0;

#[derive(Clone)]
struct ChatState {
    db: PgPool,
    redis: ConnectionManager,
    client: redis::Client,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
}

struct Room {
    tx: broadcast::Sender<Event>,
    count: usize,
}

#[derive(Clone)]
enum Event {
    Line(Arc<Line>),
    Count(usize),
}

#[derive(Serialize, Clone)]
struct Line {
    id: String,
    from: String,
    text: String,
    streamer: bool,
    /// unix ms, from the stream id
    at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum In {
    Hello {
        nick: Option<String>,
        session: Option<i64>,
        token: Option<i64>,
    },
    Say {
        text: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Out<'a> {
    History { messages: &'a [Line] },
    Message(&'a Line),
    Count { count: usize },
    Error { error: &'a str },
}

pub async fn run(db: PgPool, redis_url: &str, port: u16) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let redis = crate::connect_redis(redis_url).await;
    let state = ChatState {
        db,
        redis,
        client,
        rooms: Arc::new(Mutex::new(HashMap::new())),
    };

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/chat/{name}", get(ws))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("chat on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(crate::wait_for_signal())
        .await?;
    Ok(())
}

async fn ws(State(s): State<ChatState>, Name(name): Name, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(s, name, socket))
}

async fn handle(s: ChatState, name: String, mut socket: WebSocket) {
    // 1. hello: who is talking
    let first = match tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        _ => return,
    };
    let Ok(In::Hello { nick, session, token }) = serde_json::from_str::<In>(&first) else {
        let _ = send(&mut socket, &Out::Error { error: "say hello first" }).await;
        return;
    };
    let streamer = match (session, token) {
        (Some(session), Some(token)) => owns_session(&s.db, &name, &Owner { session, token }).await.unwrap_or(false),
        _ => false,
    };
    let from = if streamer {
        name.clone()
    } else {
        match nick.as_deref().map(clean_nick).filter(|n| valid_nick(n)) {
            Some(nick) => nick,
            None => {
                let _ = send(&mut socket, &Out::Error { error: "bad nick. 1 to 24 letters, digits, _ -" }).await;
                return;
            }
        }
    };

    // 2. subscribe first, then load history, so nothing can fall between the two.
    //    Lines the history already covers are dropped from the live feed by id.
    let mut rx = s.join(&name).await;
    let history = history(&s, &name).await.unwrap_or_default();
    let mut last_seen = history.last().map(|l| id_parts(&l.id)).unwrap_or((0, 0));
    if send(&mut socket, &Out::History { messages: &history }).await.is_err() {
        s.leave(&name).await;
        return;
    }
    log::info!("{name}: {from} joined{}", if streamer { " (streamer)" } else { "" });

    // 3. the loop: lines from the room out, lines from the viewer in
    let key = room_key(&name);
    let mut bucket = RATE_BURST;
    let mut last_refill = Instant::now();
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(Event::Line(line)) => {
                    let id = id_parts(&line.id);
                    if id <= last_seen { continue; }
                    last_seen = id;
                    if send(&mut socket, &Out::Message(&line)).await.is_err() { break; }
                }
                Ok(Event::Count(count)) => {
                    if send(&mut socket, &Out::Count { count }).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => continue,
                };
                let Ok(In::Say { text }) = serde_json::from_str::<In>(&text) else { continue };
                let text = clean_text(&text);
                let chars = text.chars().count();
                if chars == 0 { continue; }
                if chars > MAX_TEXT_CHARS {
                    let _ = send(&mut socket, &Out::Error { error: "too long" }).await;
                    continue;
                }
                let now = Instant::now();
                bucket = (bucket + now.duration_since(last_refill).as_secs_f64() * RATE_PER_SEC).min(RATE_BURST);
                last_refill = now;
                if bucket < 1.0 {
                    let _ = send(&mut socket, &Out::Error { error: "slow down" }).await;
                    continue;
                }
                bucket -= 1.0;
                let mut r = s.redis.clone();
                let fields = [("from", from.as_str()), ("text", text.as_str()), ("streamer", if streamer { "1" } else { "0" })];
                let added: Result<Option<String>, _> = r.xadd_maxlen(&key, StreamMaxlen::Approx(KEEP_LINES), "*", &fields).await;
                if let Err(e) = added {
                    log::warn!("{name}: xadd: {e}");
                    let _ = send(&mut socket, &Out::Error { error: "chat is down, try again" }).await;
                    continue;
                }
                let _: Result<bool, _> = r.expire(&key, ROOM_TTL_SECS).await;
            }
        }
    }

    s.leave(&name).await;
    log::info!("{name}: {from} left");
}

impl ChatState {
    /// Subscribe to a room. The first viewer starts the room's reader task.
    async fn join(&self, name: &str) -> broadcast::Receiver<Event> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.entry(name.to_owned()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(256);
            tokio::spawn(reader(self.client.clone(), name.to_owned(), tx.clone()));
            Room { tx, count: 0 }
        });
        room.count += 1;
        let rx = room.tx.subscribe();
        let _ = room.tx.send(Event::Count(room.count));
        rx
    }

    async fn leave(&self, name: &str) {
        let mut rooms = self.rooms.lock().await;
        let Some(room) = rooms.get_mut(name) else { return };
        room.count = room.count.saturating_sub(1);
        if room.count == 0 {
            // dropping the last sender ends the reader task on its next loop
            rooms.remove(name);
        } else {
            let _ = room.tx.send(Event::Count(room.count));
        }
    }
}

/// Tails one room's stream and fans every new line out to the room's sockets.
/// Own connection: XREAD BLOCK would stall the shared multiplexed one, and the
/// default 500ms response timeout would cut every block short.
async fn reader(client: redis::Client, name: String, tx: broadcast::Sender<Event>) {
    let key = room_key(&name);
    let config = redis::AsyncConnectionConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(Duration::from_millis(READ_BLOCK_MS as u64 + 2000)));
    let mut con = match client.get_multiplexed_async_connection_with_config(&config).await {
        Ok(con) => con,
        Err(e) => {
            log::error!("{name}: reader cannot reach redis: {e}");
            return;
        }
    };
    // Start just before now. Anything older is in the viewers' history; anything
    // between this and the first XREAD arrives twice and is dropped by id.
    let mut last = match con.xrevrange_count::<_, _, _, _, StreamRangeReply>(&key, "+", "-", 1).await {
        Ok(reply) => reply.ids.first().map(|id| id.id.clone()).unwrap_or_else(|| "0-0".to_owned()),
        Err(_) => "0-0".to_owned(),
    };
    let options = StreamReadOptions::default().block(READ_BLOCK_MS).count(100);
    while tx.receiver_count() > 0 {
        let reply: Option<StreamReadReply> = match con.xread_options(&[&key], &[&last], &options).await {
            Ok(reply) => reply,
            Err(e) => {
                log::warn!("{name}: xread: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(fresh) = client.get_multiplexed_async_connection_with_config(&config).await {
                    con = fresh;
                }
                continue;
            }
        };
        let Some(reply) = reply else { continue };
        for stream in reply.keys {
            for entry in stream.ids {
                last = entry.id.clone();
                if let Some(line) = line_from(entry) {
                    let _ = tx.send(Event::Line(Arc::new(line)));
                }
            }
        }
    }
    log::info!("{name}: room empty, reader done");
}

/// The last lines of a room, oldest first.
async fn history(s: &ChatState, name: &str) -> Result<Vec<Line>, redis::RedisError> {
    let mut r = s.redis.clone();
    let reply: StreamRangeReply = r.xrevrange_count(room_key(name), "+", "-", HISTORY_LINES).await?;
    let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
    lines.reverse();
    Ok(lines)
}

fn line_from(entry: StreamId) -> Option<Line> {
    let from: String = entry.get("from")?;
    let text: String = entry.get("text")?;
    let streamer: String = entry.get("streamer").unwrap_or_else(|| "0".to_owned());
    Some(Line {
        at: id_parts(&entry.id).0,
        id: entry.id,
        from,
        text,
        streamer: streamer == "1",
    })
}

fn room_key(name: &str) -> String {
    format!("chat:{name}")
}

/// "1729000000000-3" -> (1729000000000, 3). Orders the same way redis does.
fn id_parts(id: &str) -> (u64, u64) {
    let mut parts = id.splitn(2, '-');
    let ms = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let seq = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (ms, seq)
}

fn clean_nick(raw: &str) -> String {
    raw.trim().chars().take(MAX_NICK_CHARS).collect()
}

fn valid_nick(nick: &str) -> bool {
    !nick.is_empty() && nick.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Trim, keep newlines, drop other control characters.
fn clean_text(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect::<String>()
        .trim()
        .to_owned()
}

async fn send(socket: &mut WebSocket, out: &Out<'_>) -> Result<(), axum::Error> {
    let text = serde_json::to_string(out).unwrap_or_default();
    socket.send(Message::Text(text.into())).await
}
