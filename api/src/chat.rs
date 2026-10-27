//! `api chat`: the text chat next to a stream. See docs/chat.md.
//!
//! One websocket per viewer at /chat/<stream name>. Messages live in a redis
//! stream per room (`chat:<name>`, last 500 kept). One task per room with
//! viewers tails that stream with XREAD BLOCK and pushes new lines to every
//! socket in the room; sending is just XADD, so everyone sees the same order.
//! `CHAT_PERSIST` also inserts each line into postgres (history.rs): the scroll
//! past this window, the search, and the jump to one line.
//! A group's channel is the same room with two names: `/chat/<server>/<channel>`.
//! Anyone may read it. Speaking takes a login that has joined the server.
//! The database is asked two things: is this socket really the streamer, and
//! who does its login cookie say it is (auth.rs). A login names you; without
//! one you pick a nick, as long as nobody owns that name. A login's groups
//! (groups.rs) ride on its lines as badges; a hello that says `bot: true` wears
//! the `bot` badge, whoever it is, so the panel can hide those lines.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRef, Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use redis::aio::ConnectionManager;
use redis::streams::{StreamId, StreamMaxlen, StreamRangeReply, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{broadcast, watch, Mutex};

use uuid::Uuid;

use crate::auth::{client_ip, is_claimed, whoami, NICK_HAS_ACCOUNT};
use crate::groups::{badges_of, Badge, BOT_GROUP};
use crate::history;
use crate::socket::{first_text, id_parts, send, send_within, DRAIN_LIMIT, IDLE_LIMIT, MAX_FRAME_BYTES, PING_EVERY, READ_BLOCK_MS, SEND_TIMEOUT};
use crate::{owns_session, Name, Owner};

const HISTORY_LINES: usize = 200;
const KEEP_LINES: usize = 500;
const MAX_TEXT_CHARS: usize = 500;
const MAX_NICK_CHARS: usize = 24;
const ROOM_TTL_SECS: i64 = 7 * 24 * 3600;
/// Token bucket per socket: this many lines at once, then one per second.
const RATE_BURST: f64 = 5.0;
const RATE_PER_SEC: f64 = 1.0;
/// Sockets one ip may hold in one room. The rate limit and the count are per
/// socket; this keeps "open fifty tabs" from being fifty of each.
const MAX_SOCKETS_PER_IP: usize = 8;
/// The history is up to 200 lines in one frame: a slow link gets longer for that one.
const HISTORY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct ChatState {
    pub(crate) db: PgPool,
    pub(crate) redis: ConnectionManager,
    client: redis::Client,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    /// Flips to true on SIGTERM. Every socket then sends a close frame and leaves.
    shutdown: watch::Receiver<bool>,
    /// Nicks starting with this are the fake streams' names: nobody's to wear.
    dummy_prefix: String,
    /// `CHAT_PERSIST`. Off: redis only. On: each line is also a row in `chat_lines`.
    pub(crate) persist: bool,
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
pub(crate) struct Line {
    pub(crate) id: String,
    pub(crate) from: String,
    pub(crate) text: String,
    pub(crate) streamer: bool,
    /// said by a login, so `from` really is that account
    pub(crate) verified: bool,
    /// the speaker's groups as badges, `bot` first when it is one. empty for most lines
    pub(crate) groups: Vec<Badge>,
    /// unix ms, from the stream id
    pub(crate) at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum In {
    Hello(Hello),
    Say { text: String },
}

/// The first frame: a nick for a viewer, the go-live grant for the streamer. Kept for the
/// socket's life, since a socket admitted with the database down is identified later.
#[derive(Deserialize)]
struct Hello {
    nick: Option<String>,
    session: Option<i64>,
    token: Option<i64>,
    /// "I am a program": the fake streams' chatters say so. Anyone may; it only ever
    /// costs the speaker (its lines can be hidden), so there is nothing to check.
    bot: Option<bool>,
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
    let dummy_prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let persist = history::enabled();
    log::info!("chat history {}", if persist { "on" } else { "off" });
    let state = ChatState {
        db,
        redis,
        client,
        rooms: Arc::new(Mutex::new(HashMap::new())),
        shutdown,
        dummy_prefix,
        persist,
    };
    let rooms = state.rooms.clone();

    // the rooms only. the gateway (/events, presence and the pushes) is `api events`, a
    // process and container of its own; see events.rs and docs/status.md
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/chat/{name}", get(ws))
        .route("/chat/{server}/{channel}", get(ws_channel))
        .merge(history::routes())
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

/// The browser sends the login cookie with the websocket handshake; `handle` reads it from
/// the headers when it needs it. Not through the `Me` extractor: that turns a database
/// error into a 500 before the upgrade, and reading a room needs no database at all.
async fn ws(State(s): State<ChatState>, Name(name): Name, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let ip = client_ip(&headers);
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(s, name, None, ip, headers, socket))
}

/// `/chat/<server>/<channel>`. Same room as a stream, named `server/channel`. A missing
/// channel is said on the socket and the socket stops, so the panel does not reconnect.
async fn ws_channel(State(s): State<ChatState>, Path((server, channel)): Path<(String, String)>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let upgrade = upgrade.max_message_size(MAX_FRAME_BYTES).max_frame_size(MAX_FRAME_BYTES);
    match crate::groups::channel_room(&s.db, &server, &channel).await {
        Ok((server, room)) => {
            let ip = client_ip(&headers);
            upgrade.on_upgrade(move |socket| handle(s, room, Some(server), ip, headers, socket))
        }
        Err(err) => {
            let message = err.message().to_owned();
            upgrade.on_upgrade(move |mut socket| async move {
                let _ = send(&mut socket, &Out::Error { error: &message }).await;
            })
        }
    }
}

/// Who a socket speaks as, once the database has said.
struct Who {
    from: String,
    /// The one who went live (session + token), or the account the room is named after.
    streamer: bool,
    /// Said by a login, so `from` really is that account.
    verified: bool,
    /// The account's groups (only when `verified`: the badges belong to the name on the
    /// line, not to whoever holds the socket), plus `bot` when the hello said so.
    groups: Vec<Badge>,
    /// The account, when `verified`. Null on the row otherwise.
    user_id: Option<Uuid>,
}

impl Who {
    fn is_bot(&self) -> bool {
        self.groups.iter().any(|g| g.name == BOT_GROUP)
    }
}

enum Unknown {
    /// A hello that can never do: said once, and the socket is closed.
    Refused(&'static str),
    /// The database did not answer. A viewer for now, asked again when it wants to speak.
    Busy,
}

/// The hello and the cookie against the database. Every question in here is about
/// speaking: whose line it would be and what marks it carries. Reading needs none of
/// them, so a database that does not answer is `Busy`, not a refusal: the socket gets the
/// room and its lines, and is asked again on its first `say` (docs/chat.md: a socket the
/// database cannot vouch for is a plain viewer). What would be a lie is refused outright:
/// a claimed name on an anonymous nick, a reserved one, a nick that is not one.
async fn identify(s: &ChatState, room: &str, headers: &HeaderMap, hello: &Hello) -> Result<Who, Unknown> {
    // (no cookie is `Ok(None)` without a query, so an error here is a cookie that could not be read)
    let me = match whoami(&s.db, headers).await {
        Ok(me) => me,
        Err(e) => {
            log::warn!("{room}: cannot read the login: {e}");
            return Err(Unknown::Busy);
        }
    };
    let owns = match (hello.session, hello.token) {
        (Some(session), Some(token)) => match owns_session(&s.db, room, &Owner { session, token }).await {
            Ok(owns) => owns,
            Err(e) => {
                log::warn!("{room}: cannot check the streamer's session: {e}");
                return Err(Unknown::Busy);
            }
        },
        _ => false,
    };
    let streamer = owns || me.as_ref().is_some_and(|a| a.name == room);
    let from = if streamer {
        room.to_owned()
    } else if let Some(me) = &me {
        me.name.clone()
    } else {
        let Some(nick) = hello.nick.as_deref().map(clean_nick).filter(|n| valid_nick(n)) else {
            return Err(Unknown::Refused("bad nick. 1 to 24 letters, digits, _ -"));
        };
        let lower = nick.to_lowercase();
        // the fake streams' names are nobody's: they can never be claimed, so the check
        // below would hand them to anyone, badge and all
        if lower.starts_with(&s.dummy_prefix) {
            return Err(Unknown::Refused("that nick belongs to the fake streams. pick another"));
        }
        match is_claimed(&s.db, &lower).await {
            Ok(false) => nick,
            Ok(true) => return Err(Unknown::Refused(NICK_HAS_ACCOUNT)),
            Err(e) => {
                // fail closed: with the database down a claimed name must not be borrowable
                log::warn!("{room}: cannot check whether {nick} is claimed: {e}");
                return Err(Unknown::Busy);
            }
        }
    };
    // the login behind this socket is the name it speaks as. not just "logged in": the
    // one who went live speaks as the room while logged in as somebody else, or as nobody
    let verified = me.as_ref().is_some_and(|a| a.name == from);
    // the badges: the account's groups when the line is really the account's, and `bot`
    // when asked for. read once, here; a group joined mid-chat shows after a reconnect
    let bot = hello.bot == Some(true);
    let groups = if verified || bot {
        match badges_of(&s.db, me.as_ref().filter(|_| verified).map(|a| a.id), bot).await {
            Ok(groups) => groups,
            Err(e) => {
                log::warn!("{room}: cannot read the groups of {from}: {e}");
                return Err(Unknown::Busy);
            }
        }
    } else {
        Vec::new()
    };
    let user_id = if verified { me.as_ref().map(|a| a.id) } else { None };
    Ok(Who { from, streamer, verified, groups, user_id })
}

async fn handle(s: ChatState, name: String, server: Option<String>, ip: String, headers: HeaderMap, mut socket: WebSocket) {
    // 1. hello: who is talking
    let Some(first) = first_text(&mut socket).await else { return };
    let Ok(In::Hello(hello)) = serde_json::from_str::<In>(&first) else {
        let _ = send(&mut socket, &Out::Error { error: "say hello first" }).await;
        return;
    };
    let mut who = match identify(&s, &name, &headers, &hello).await {
        Ok(who) => Some(who),
        Err(Unknown::Refused(why)) => {
            let _ = send(&mut socket, &Out::Error { error: why }).await;
            return;
        }
        Err(Unknown::Busy) => None,
    };

    // 2. subscribe first, then load history, so nothing can fall between the two.
    //    Lines the history already covers are dropped from the live feed by id.
    let Some(mut rx) = s.join(&name, &ip).await else {
        let _ = send(&mut socket, &Out::Error { error: "too many tabs" }).await;
        return;
    };
    let history = history(&s, &name).await.unwrap_or_default();
    let mut last_seen = history.last().map(|l| id_parts(&l.id)).unwrap_or((0, 0));
    // the one frame that can be big: 200 lines, so a slow link gets longer than for one line
    if send_within(&mut socket, &Out::History { messages: &history }, HISTORY_TIMEOUT).await.is_err() {
        s.leave(&name, &ip).await;
        return;
    }
    let shown = |who: &Option<Who>| match who {
        Some(w) => format!("{}{}{}", w.from, if w.streamer { " (streamer)" } else { "" }, if w.is_bot() { " (bot)" } else { "" }),
        None => "somebody (database down, reading only)".to_owned(),
    };
    log::info!("{name}: {} joined", shown(&who));

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
                    log::info!("{name}: {} went silent, dropping", shown(&who));
                    break;
                }
                if !matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Ping(Bytes::new()))).await, Ok(Ok(()))) { break; }
            }
            _ = shutdown.changed() => {
                let goodbye = Message::Close(Some(CloseFrame { code: 1001, reason: "chat restarting".into() }));
                let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(goodbye)).await;
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
                // paid here, before the database is asked below: a `say` the database cannot
                // vouch for yet costs its token like any other dropped line, so a socket
                // admitted read-only cannot turn every frame into a query
                bucket -= 1.0;
                // admitted while the database was down: whose line this would be is asked now
                if who.is_none() {
                    match identify(&s, &name, &headers, &hello).await {
                        Ok(w) => {
                            who = Some(w);
                            log::info!("{name}: the reader is {}", shown(&who));
                        }
                        Err(Unknown::Refused(why)) => {
                            let _ = send(&mut socket, &Out::Error { error: why }).await;
                            break;
                        }
                        Err(Unknown::Busy) => {
                            let _ = send(&mut socket, &Out::Error { error: "chat is busy, try again" }).await;
                            continue;
                        }
                    }
                }
                let Some(w) = who.as_ref() else { continue };
                // a channel is open to read. talking is for people in the server.
                if let Some(server) = &server {
                    let allowed = match w.user_id {
                        Some(id) => match crate::groups::member(&s.db, id, server).await {
                            Ok(yes) => yes,
                            Err(e) => {
                                log::warn!("{name}: membership: {e}");
                                let _ = send(&mut socket, &Out::Error { error: "chat is busy, try again" }).await;
                                continue;
                            }
                        },
                        None => false,
                    };
                    if !allowed {
                        let _ = send(&mut socket, &Out::Error { error: "join the server first" }).await;
                        continue;
                    }
                }
                let mut r = s.redis.clone();
                // the badges as json, and no field at all for the common case of none
                let groups = if w.groups.is_empty() { String::new() } else { serde_json::to_string(&w.groups).unwrap_or_default() };
                let mut fields = vec![
                    ("from", w.from.as_str()),
                    ("text", text.as_str()),
                    ("streamer", if w.streamer { "1" } else { "0" }),
                    ("v", if w.verified { "1" } else { "0" }),
                ];
                if !groups.is_empty() {
                    fields.push(("g", groups.as_str()));
                }
                // the line and the room's ttl in one atomic round trip: a room whose first
                // line landed but whose expire did not would otherwise live forever
                let added: Result<(Option<String>, bool), _> = redis::pipe()
                    .atomic()
                    .xadd_maxlen(&key, StreamMaxlen::Approx(KEEP_LINES), "*", &fields)
                    .expire(&key, ROOM_TTL_SECS)
                    .query_async(&mut r)
                    .await;
                let id = match added {
                    Ok((id, _)) => id,
                    Err(e) => {
                        log::warn!("{name}: xadd: {e}");
                        let _ = send(&mut socket, &Out::Error { error: "chat is down, try again" }).await;
                        continue;
                    }
                };
                // redis already has the line, and the room will fan it out. the insert
                // follows on its own, so a slow database does not hold this socket.
                if s.persist {
                    if let Some(id) = id {
                        remember(&s, &name, &id, w, &text);
                    }
                }
            }
        }
    }

    s.leave(&name, &ip).await;
    log::info!("{name}: {} left", shown(&who));
}

/// The row for a line redis already accepted. Its own task: the socket goes back to the room.
fn remember(s: &ChatState, room: &str, id: &str, w: &Who, text: &str) {
    let db = s.db.clone();
    let room = room.to_owned();
    let id = id.to_owned();
    let speaker = w.from.clone();
    let user_id = w.user_id;
    let text = text.to_owned();
    let streamer = w.streamer;
    let verified = w.verified;
    let groups = w.groups.clone();
    tokio::spawn(async move {
        let inserted = tokio::time::timeout(
            Duration::from_secs(2),
            history::store(&db, &room, &id, &speaker, user_id, &text, streamer, verified, &groups),
        )
        .await;
        match inserted {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::warn!("{room}: history: {e}"),
            Err(_) => log::warn!("{room}: history insert timed out"),
        }
    });
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
    let config = crate::socket::blocking_config(READ_BLOCK_MS);
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

pub(crate) fn line_from(entry: StreamId) -> Option<Line> {
    let from: String = entry.get("from")?;
    let text: String = entry.get("text")?;
    let streamer: String = entry.get("streamer").unwrap_or_else(|| "0".to_owned());
    let verified: String = entry.get("v").unwrap_or_else(|| "0".to_owned());
    // no `g` field, or one this build cannot read, is a line with no badges
    let groups: Vec<Badge> = entry.get::<String>("g").and_then(|g| serde_json::from_str(&g).ok()).unwrap_or_default();
    Some(Line {
        at: id_parts(&entry.id).0,
        id: entry.id,
        from,
        text,
        streamer: streamer == "1",
        verified: verified == "1",
        groups,
    })
}

pub(crate) fn room_key(name: &str) -> String {
    format!("chat:{name}")
}

pub(crate) fn clean_nick(raw: &str) -> String {
    raw.trim().chars().take(MAX_NICK_CHARS).collect()
}

pub(crate) fn valid_nick(nick: &str) -> bool {
    !nick.is_empty() && nick.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A run of combining marks longer than this is "zalgo", not spelling.
const MAX_COMBINING: usize = 4;

/// Trim; keep newlines, but at most two between visible characters; drop control
/// characters and the invisible format ones (zero-width space, bidi marks and
/// overrides, word joiner, byte order mark); cap a run of combining marks.
/// No unicode tables in this binary, so the sets are the explicit code points
/// that make a line lie about its direction, pad it invisibly, or climb the screen.
/// groups.rs cleans a badge and a group's description the same way.
pub(crate) fn clean_text(raw: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Building the router is what notices two patterns that can be the same url.
    #[test]
    fn a_channel_sits_beside_a_stream_room() {
        let _ = Router::<ChatState>::new()
            .route("/chat/{name}", get(|| async { "stream" }))
            .route("/chat/{server}/{channel}", get(|| async { "channel" }))
            .merge(history::routes());
    }

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
