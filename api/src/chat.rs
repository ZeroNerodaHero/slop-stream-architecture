//! `api chat`: the text chat next to a stream. See docs/chat.md.
//!
//! One websocket per viewer at /chat/<stream name>. Messages live in a redis
//! stream per room (`chat:<name>`, last 500 kept). One task per room with
//! viewers tails that stream with XREAD BLOCK and pushes new lines to every
//! socket in the room; sending is just XADD, so everyone sees the same order.
//! The database is asked two things: is this socket really the streamer, and
//! who does its login cookie say it is (auth.rs). A login names you; without
//! one you pick a nick, as long as nobody owns that name.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRef, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use redis::aio::ConnectionManager;
use redis::streams::{StreamId, StreamMaxlen, StreamRangeReply, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{broadcast, watch, Mutex};

use crate::auth::{client_ip, is_claimed, Me};
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
/// Sockets one ip may hold in one room. The rate limit and the count are per
/// socket; this keeps "open fifty tabs" from being fifty of each.
const MAX_SOCKETS_PER_IP: usize = 8;
/// A ping this often. A socket that sent nothing back (pong, text, anything)
/// for IDLE_LIMIT is a vanished peer and is dropped, so it stops being counted.
const PING_EVERY: Duration = Duration::from_secs(30);
const IDLE_LIMIT: Duration = Duration::from_secs(90);
/// After SIGTERM: how long `run` waits for the sockets to say goodbye.
const DRAIN_LIMIT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct ChatState {
    db: PgPool,
    redis: ConnectionManager,
    client: redis::Client,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    /// Flips to true on SIGTERM. Every socket then sends a close frame and leaves.
    shutdown: watch::Receiver<bool>,
}

impl FromRef<ChatState> for PgPool {
    fn from_ref(s: &ChatState) -> PgPool {
        s.db.clone()
    }
}

struct Room {
    tx: broadcast::Sender<Event>,
    count: usize,
    /// Sockets per client ip, for MAX_SOCKETS_PER_IP.
    per_ip: HashMap<String, usize>,
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
    /// said by a login, so `from` really is that account
    verified: bool,
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
    let (stop, shutdown) = watch::channel(false);
    let state = ChatState {
        db,
        redis,
        client,
        rooms: Arc::new(Mutex::new(HashMap::new())),
        shutdown,
    };
    let rooms = state.rooms.clone();

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/chat/{name}", get(ws))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("chat on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            crate::wait_for_signal().await;
            // axum does not wait for upgraded sockets: tell every handle to say goodbye
            let _ = stop.send(true);
        })
        .await?;
    // ...and give them a moment to send the close frame and leave their rooms,
    // instead of being cut mid-send when the runtime goes
    let deadline = Instant::now() + DRAIN_LIMIT;
    while !rooms.lock().await.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

/// The browser sends the login cookie with the websocket handshake, so `Me` works here too.
async fn ws(State(s): State<ChatState>, Name(name): Name, Me(me): Me, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let ip = client_ip(&headers);
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(s, name, ip, me, socket))
}

async fn handle(s: ChatState, name: String, ip: String, me: Option<String>, mut socket: WebSocket) {
    // 1. hello: who is talking
    let first = match tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        _ => return,
    };
    let Ok(In::Hello { nick, session, token }) = serde_json::from_str::<In>(&first) else {
        let _ = send(&mut socket, &Out::Error { error: "say hello first" }).await;
        return;
    };
    let owns = match (session, token) {
        (Some(session), Some(token)) => owns_session(&s.db, &name, &Owner { session, token }).await.unwrap_or_else(|e| {
            // database down: this socket talks as a viewer, not as the streamer
            log::warn!("{name}: cannot check the streamer's session: {e}");
            false
        }),
        _ => false,
    };
    // the one who went live, or the account the room is named after
    let streamer = owns || me.as_deref() == Some(name.as_str());
    let from = if streamer {
        name.clone()
    } else if let Some(me) = me.clone() {
        me
    } else {
        match nick.as_deref().map(clean_nick).filter(|n| valid_nick(n)) {
            Some(nick) => {
                match is_claimed(&s.db, &nick.to_lowercase()).await {
                    Ok(false) => {}
                    Ok(true) => {
                        let _ = send(&mut socket, &Out::Error { error: "that name has an account. log in as it, or pick another" }).await;
                        return;
                    }
                    Err(e) => {
                        // fail closed: with the database down a claimed name must not be borrowable
                        log::warn!("{name}: cannot check whether {nick} is claimed: {e}");
                        let _ = send(&mut socket, &Out::Error { error: "chat is busy, try again" }).await;
                        return;
                    }
                }
                nick
            }
            None => {
                let _ = send(&mut socket, &Out::Error { error: "bad nick. 1 to 24 letters, digits, _ -" }).await;
                return;
            }
        }
    };
    // the login behind this socket is the name it speaks as. not just "logged in": the
    // one who went live speaks as the room while logged in as somebody else, or as nobody
    let verified = me.as_deref() == Some(from.as_str());

    // 2. subscribe first, then load history, so nothing can fall between the two.
    //    Lines the history already covers are dropped from the live feed by id.
    let Some(mut rx) = s.join(&name, &ip).await else {
        let _ = send(&mut socket, &Out::Error { error: "too many tabs" }).await;
        return;
    };
    let history = history(&s, &name).await.unwrap_or_default();
    let mut last_seen = history.last().map(|l| id_parts(&l.id)).unwrap_or((0, 0));
    if send(&mut socket, &Out::History { messages: &history }).await.is_err() {
        s.leave(&name, &ip).await;
        return;
    }
    log::info!("{name}: {from} joined{}", if streamer { " (streamer)" } else { "" });

    // 3. the loop: lines from the room out, lines from the viewer in, a ping now
    //    and then so a peer that vanished without a close frame is found out
    let key = room_key(&name);
    let mut bucket = RATE_BURST;
    let mut last_refill = Instant::now();
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay); // never a burst of pings
    ping.tick().await; // the first tick is immediate
    let mut shutdown = s.shutdown.clone();
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
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // this socket is slower than the room: n events went by unseen. say so
                    // rather than hide it; the next count event sets the number right again
                    let missed = format!("missed {n} lines");
                    if send(&mut socket, &Out::Error { error: &missed }).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = ping.tick() => {
                if last_heard.elapsed() > IDLE_LIMIT {
                    log::info!("{name}: {from} went silent, dropping");
                    break;
                }
                if socket.send(Message::Ping(Bytes::new())).await.is_err() { break; }
            }
            _ = shutdown.changed() => {
                let _ = socket.send(Message::Close(Some(CloseFrame { code: 1001, reason: "chat restarting".into() }))).await;
                break;
            }
            incoming = socket.recv() => {
                last_heard = Instant::now();
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
                let fields = [
                    ("from", from.as_str()),
                    ("text", text.as_str()),
                    ("streamer", if streamer { "1" } else { "0" }),
                    ("v", if verified { "1" } else { "0" }),
                ];
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

    s.leave(&name, &ip).await;
    log::info!("{name}: {from} left");
}

impl ChatState {
    /// Subscribe to a room. The first viewer starts the room's reader task. None
    /// when this ip already has MAX_SOCKETS_PER_IP sockets in the room.
    async fn join(&self, name: &str, ip: &str) -> Option<broadcast::Receiver<Event>> {
        if let Some(room) = self.rooms.lock().await.get_mut(name) {
            return room.subscribe(ip);
        }
        // First viewer, most likely. The reader's start id is taken here, before the
        // history this viewer loads next, so no line can fall between the two: one
        // in both arrives twice and is dropped by id. Not under the lock: a slow
        // redis must not stall every other room's join and leave.
        let start = last_id(&mut self.redis.clone(), &room_key(name)).await;
        let mut rooms = self.rooms.lock().await;
        let room = rooms.entry(name.to_owned()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(256);
            tokio::spawn(reader(self.client.clone(), name.to_owned(), start, tx.clone()));
            Room { tx, count: 0, per_ip: HashMap::new() }
        });
        room.subscribe(ip)
    }

    async fn leave(&self, name: &str, ip: &str) {
        let mut rooms = self.rooms.lock().await;
        let Some(room) = rooms.get_mut(name) else { return };
        room.count = room.count.saturating_sub(1);
        if let Some(mine) = room.per_ip.get_mut(ip) {
            *mine = mine.saturating_sub(1);
            if *mine == 0 {
                room.per_ip.remove(ip);
            }
        }
        if room.count == 0 {
            // dropping the last sender ends the reader task on its next loop
            rooms.remove(name);
        } else {
            let _ = room.tx.send(Event::Count(room.count));
        }
    }
}

impl Room {
    fn subscribe(&mut self, ip: &str) -> Option<broadcast::Receiver<Event>> {
        let mine = self.per_ip.entry(ip.to_owned()).or_insert(0);
        if *mine >= MAX_SOCKETS_PER_IP {
            return None;
        }
        *mine += 1;
        self.count += 1;
        let rx = self.tx.subscribe();
        let _ = self.tx.send(Event::Count(self.count));
        Some(rx)
    }
}

/// The newest id in a room's stream, "0-0" for an empty room, None when redis does not answer.
async fn last_id<C: AsyncCommands>(r: &mut C, key: &str) -> Option<String> {
    let reply: StreamRangeReply = r.xrevrange_count(key, "+", "-", 1).await.ok()?;
    Some(reply.ids.first().map(|id| id.id.clone()).unwrap_or_else(|| "0-0".to_owned()))
}

/// Tails one room's stream and fans every new line out to the room's sockets.
/// Own connection: XREAD BLOCK would stall the shared multiplexed one, and the
/// default 500ms response timeout would cut every block short.
async fn reader(client: redis::Client, name: String, start: Option<String>, tx: broadcast::Sender<Event>) {
    let key = room_key(&name);
    let config = redis::AsyncConnectionConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(Duration::from_millis(READ_BLOCK_MS as u64 + 2000)));
    // Keep trying while the room has viewers. Giving up on the first failure
    // would leave a room that gets history but never a live line.
    let mut con = loop {
        match client.get_multiplexed_async_connection_with_config(&config).await {
            Ok(con) => break con,
            Err(e) => {
                log::warn!("{name}: reader cannot reach redis: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                if tx.receiver_count() == 0 {
                    log::info!("{name}: room empty, reader done");
                    return;
                }
            }
        }
    };
    // Start where join() looked, just before the first viewer's history. Anything
    // between that and the first XREAD arrives twice and is dropped by id. When
    // join() could not look (redis was down), start at the newest line now.
    let mut last = match start {
        Some(id) => id,
        None => last_id(&mut con, &key).await.unwrap_or_else(|| "0-0".to_owned()),
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
    let verified: String = entry.get("v").unwrap_or_else(|| "0".to_owned());
    Some(Line {
        at: id_parts(&entry.id).0,
        id: entry.id,
        from,
        text,
        streamer: streamer == "1",
        verified: verified == "1",
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

/// A run of combining marks longer than this is "zalgo", not spelling.
const MAX_COMBINING: usize = 4;

/// Trim; keep newlines, but at most two between visible characters; drop control
/// characters and the invisible format ones (zero-width space, bidi marks and
/// overrides, word joiner, byte order mark); cap a run of combining marks.
/// No unicode tables in this binary, so the sets are the explicit code points
/// that make a line lie about its direction, pad it invisibly, or climb the screen.
fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut newlines = 0; // since the last visible character
    let mut marks = 0; // combining marks in a row
    for c in raw.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines > 2 {
                continue;
            }
        } else if c.is_control() || is_invisible(c) {
            continue;
        } else if !c.is_whitespace() {
            newlines = 0;
        }
        if is_combining(c) {
            marks += 1;
            if marks > MAX_COMBINING {
                continue;
            }
        } else {
            marks = 0;
        }
        out.push(c);
    }
    out.trim().to_owned()
}

/// Soft hyphen, zero-width space, the bidi marks (200E 200F), bidi embeddings and
/// overrides (202A-202E), word joiner and invisible operators (2060-2064), bidi
/// isolates (2066-2069), byte order mark. Not the zero-width (non-)joiner: emoji
/// sequences and several scripts spell with those.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}' | '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// The combining diacritical mark blocks.
fn is_combining(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036F}' | '\u{1AB0}'..='\u{1AFF}' | '\u{1DC0}'..='\u{1DFF}' | '\u{20D0}'..='\u{20FF}' | '\u{FE20}'..='\u{FE2F}')
}

async fn send(socket: &mut WebSocket, out: &Out<'_>) -> Result<(), axum::Error> {
    let text = serde_json::to_string(out).unwrap_or_default();
    socket.send(Message::Text(text.into())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_trimmed_and_control_free() {
        assert_eq!(clean_text("  hi  "), "hi");
        assert_eq!(clean_text("a\tb\u{7}c"), "abc");
        assert_eq!(clean_text("a\r\nb"), "a\nb");
        assert_eq!(clean_text("\n\n\nhi\n\n\n"), "hi");
        assert_eq!(clean_text("\u{1F600} ok"), "\u{1F600} ok");
    }

    #[test]
    fn text_newlines_are_capped_at_two() {
        assert_eq!(clean_text("a\n\n\n\n\nb"), "a\n\nb");
        // blank lines made of spaces do not reset the count
        assert_eq!(clean_text("a\n \n \n \nb").matches('\n').count(), 2);
        let tall = format!("a{}b", "\n".repeat(498));
        assert_eq!(clean_text(&tall), "a\n\nb");
    }

    #[test]
    fn text_invisible_format_characters_go() {
        assert_eq!(clean_text("\u{202E}abc\u{200B}\u{FEFF}"), "abc");
        assert_eq!(clean_text("\u{200F}\u{2066}x\u{2069}\u{00AD}"), "x");
        // the zero-width joiner stays: that is how this family is spelled
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        assert_eq!(clean_text(family), family);
    }

    #[test]
    fn text_combining_marks_are_capped() {
        let zalgo = format!("e{}x", "\u{0301}".repeat(40));
        assert_eq!(clean_text(&zalgo), format!("e{}x", "\u{0301}".repeat(MAX_COMBINING)));
        // two marks on each of two letters are spelling, not zalgo
        assert_eq!(clean_text("e\u{0301}\u{0308}a\u{0300}\u{0302}"), "e\u{0301}\u{0308}a\u{0300}\u{0302}");
    }

    #[test]
    fn nicks() {
        assert!(valid_nick("bob"));
        assert!(valid_nick("Bob_1-x"));
        assert!(!valid_nick(""));
        assert!(!valid_nick("bob smith"));
        assert!(!valid_nick("b\u{f6}b"));
        assert!(!valid_nick("bob!"));
        assert_eq!(clean_nick("  bob  "), "bob");
        assert_eq!(clean_nick(&"x".repeat(40)).chars().count(), MAX_NICK_CHARS);
    }

    #[test]
    fn stream_ids_order_like_redis() {
        assert_eq!(id_parts("1729000000000-3"), (1729000000000, 3));
        assert_eq!(id_parts("0-0"), (0, 0));
        assert_eq!(id_parts("garbage"), (0, 0));
        assert_eq!(id_parts(""), (0, 0));
        // numeric, not lexicographic: "-10" comes after "-9"
        assert!(id_parts("1729000000000-10") > id_parts("1729000000000-9"));
        assert!(id_parts("1729000000001-0") > id_parts("1729000000000-99"));
    }
}
