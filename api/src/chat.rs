//! `api chat`: the text chat next to a stream. See docs/chat.md.
//!
//! One websocket per viewer at /chat/<stream name>. Messages live in a redis
//! stream per room (`chat:<name>`, last 500 kept). One task per room with
//! viewers tails that stream with XREAD BLOCK and pushes new lines to every
//! socket in the room; sending is just XADD, so everyone sees the same order.
//! `CHAT_PERSIST` also inserts each line into postgres (history.rs): the scroll
//! past this window, the search, and the jump to one line.
//! A group's channel is the same room with two names: `/chat/<server>/<channel>`.
//! Anyone may read it. Speaking takes a login that has joined the server. The room
//! page opens `/chat/<server>/*` instead: every channel of the server on one socket,
//! each line tagged with its channel, so switching channels opens nothing (`handle_server`).
//! A line in a channel is also a row in the other members' inboxes (notify.rs
//! `channel_line`, docs/notifications.md), written from here on a task of its own.
//! The database is asked two things: is this socket really the streamer, and
//! who does its login cookie say it is (auth.rs). A login names you; without
//! one you pick a nick, as long as nobody owns that name. A login's groups
//! (groups.rs) ride on its lines as badges; a hello that says `bot: true` wears
//! the `bot` badge, whoever it is, so the panel can hide those lines. The picture
//! of a login, or of the streamer, rides along too (`avatar`, its upload time),
//! so the panel can draw a face by each line: the picture the row has *now*, read
//! at the say and again whenever lines come back out of redis (`with_faces`), the
//! way history.rs joins it for a line from postgres. A login's line carries its
//! account (`uid`), so the face follows a rename the way the badges do not.

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
use tokio::sync::{broadcast, mpsc, watch, Mutex};

use uuid::Uuid;

use crate::auth::{client_ip, is_claimed, whoami, NICK_HAS_ACCOUNT};
use crate::groups::{badges_of, Badge, BOT_GROUP};
use crate::history;
use crate::socket::{first_text, id_parts, send, send_within, DRAIN_LIMIT, IDLE_LIMIT, MAX_FRAME_BYTES, PING_EVERY, READ_BLOCK_MS, SEND_TIMEOUT};
use crate::{owns_session, Name, Owner};

const HISTORY_LINES: usize = 200;
const KEEP_LINES: usize = 500;
/// A line's length, in unicode scalars. A direct message (dms.rs) has the same.
pub(crate) const MAX_TEXT_CHARS: usize = 500;
const MAX_NICK_CHARS: usize = 24;
const ROOM_TTL_SECS: i64 = 7 * 24 * 3600;
/// The token bucket a line is paid from (`Limiter`), by who is speaking. Without an account:
/// two lines at once, then one every thirty seconds. A login, or the one who went live (the
/// grant is as good as a name in their own room): three at once, then one every 3⅓ seconds.
/// The pages hold the same two numbers (chat-atoms.ts `TIERS`) and refuse a line over them
/// before it is sent; the bucket itself is here, and the chat has the last word.
const ANON_TIER: Tier = Tier { burst: 2.0, window: Duration::from_secs(60) };
const LOGIN_TIER: Tier = Tier { burst: 3.0, window: Duration::from_secs(10) };
/// How often the buckets that have refilled are forgotten: a full bucket is the same as none.
const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// The words of a refused line. The frame carries the wait too (`slow`).
const SLOW_DOWN: &str = "slow down";
/// Sockets one ip may hold in one room. The count is per socket; this keeps "open
/// fifty tabs" from being fifty of it. (The rate is per speaker, so tabs share that.)
const MAX_SOCKETS_PER_IP: usize = 8;
/// The history is up to 200 lines in one frame: a slow link gets longer for that one.
const HISTORY_TIMEOUT: Duration = Duration::from_secs(60);
/// The channel of `/chat/<server>/<channel>` that means every channel of the server: one socket
/// for the whole room page (docs/groups.md). Not a name, so no channel can be called it.
const EVERY_CHANNEL: &str = "*";
/// Lines sent after a `since` id, per channel. The page holds about this many per channel
/// to begin with (`GET /api/groups/:group/messages`); a gap wider than this is a page that
/// was away for a while, and older lines still scroll in through history.rs.
const FILL_LIMIT: usize = 100;

#[derive(Clone)]
pub(crate) struct ChatState {
    pub(crate) db: PgPool,
    pub(crate) redis: ConnectionManager,
    client: redis::Client,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    /// The token buckets, one per speaker per room, shared by every socket.
    limiter: Arc<Limiter>,
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
    /// the speaker's picture: its upload time (the `?v=` the pages fetch it by), the same
    /// `avatar` as everywhere in the api. only a `verified` or `streamer` line can have one.
    /// as it is now, not as it was when the line was said: `with_faces` on the way out of redis
    pub(crate) avatar: Option<i64>,
    /// the account behind a `verified` line (`uid` in the stream, `user_id` on the row): what its
    /// face is looked up by, so a rename keeps it. not on the wire: no page reads an id (docs/ids.md)
    #[serde(skip)]
    pub(crate) user_id: Option<Uuid>,
    /// unix ms, from the stream id
    pub(crate) at: u64,
    /// the first picture on the line. absent when there is none. `images` is the whole set
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) image: Option<String>,
    /// every picture on the line, the ids `POST /api/chat-images` handed back. absent when there are none
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) images: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum In {
    Hello(Hello),
    Say {
        text: String,
        /// The first id, so a page that sends one picture still does. A line may be pictures with no words.
        #[serde(default)]
        image: Option<String>,
        /// Every id, when the page sent more than one. Empty means use `image`.
        #[serde(default)]
        images: Vec<String>,
        /// On a server socket (`/chat/<server>/*`): which channel the line is for. Ignored elsewhere.
        #[serde(default)]
        channel: Option<String>,
    },
    /// A server socket: follow one more channel, added since the socket opened (docs/groups.md).
    Join { channel: String },
    /// A server socket: the newest line id the page has, per channel. Every line after each
    /// is sent, so the page's picture of a channel has no hole between what the api gave it and
    /// what this socket brings (`GET /api/groups/:group/messages`, then this).
    Since { since: HashMap<String, String> },
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
    /// A server socket's line: the same `message`, with the channel it is in.
    #[serde(rename = "message")]
    ChannelMessage {
        channel: &'a str,
        #[serde(flatten)]
        line: &'a Line,
    },
    /// A server socket's count: how many sockets are in that channel's room.
    #[serde(rename = "count")]
    ChannelCount { channel: &'a str, count: usize },
    Error { error: &'a str },
    /// `slow down`, with how long until the next line may go, in ms: the same `error` frame,
    /// so a page that does not read `wait` sees the words alone. The panel's countdown is this.
    #[serde(rename = "error")]
    Slow { error: &'a str, wait: u64 },
}

/// The frame for a line the bucket refused: `slow down`, and the wait rounded up to the ms.
fn slow(wait: Duration) -> Out<'static> {
    Out::Slow { error: SLOW_DOWN, wait: (wait.as_secs_f64() * 1000.0).ceil() as u64 }
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
        limiter: Arc::new(Limiter::new()),
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
/// error into a 500 before the upgrade, and reading a room does not need the database (the
/// faces on its history are looked up there, and stay as written when it does not answer).
async fn ws(State(s): State<ChatState>, Name(name): Name, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let ip = client_ip(&headers);
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(s, name, None, ip, headers, socket))
}

/// `/chat/<server>/<channel>`. Same room as a stream, named `server/channel`. A missing
/// channel is said on the socket and the socket stops, so the panel does not reconnect.
/// `/chat/<server>/*` is every channel of the server on one socket (`handle_server`).
async fn ws_channel(State(s): State<ChatState>, Path((server, channel)): Path<(String, String)>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let upgrade = upgrade.max_message_size(MAX_FRAME_BYTES).max_frame_size(MAX_FRAME_BYTES);
    let ip = client_ip(&headers);
    if channel == EVERY_CHANNEL {
        return match server_of(&s.db, &server).await {
            Ok(server) => upgrade.on_upgrade(move |socket| handle_server(s, server, ip, headers, socket)),
            Err(err) => refuse(upgrade, err),
        };
    }
    match crate::groups::channel_room(&s.db, &server, &channel).await {
        Ok((server, room)) => upgrade.on_upgrade(move |socket| handle(s, room, Some(server), ip, headers, socket)),
        Err(err) => refuse(upgrade, err),
    }
}

/// The room cannot be: said on the socket once it is open, and nothing more. The panel
/// reads these words as a reason not to reconnect.
fn refuse(upgrade: WebSocketUpgrade, err: crate::ApiError) -> Response {
    let message = err.message().to_owned();
    upgrade.on_upgrade(move |mut socket| async move {
        let _ = send(&mut socket, &Out::Error { error: &message }).await;
    })
}

/// The server a `/chat/<server>/*` socket is for: a group that is there, and not `bot`.
async fn server_of(db: &PgPool, raw: &str) -> Result<String, crate::ApiError> {
    let (server, _) = crate::groups::channel_names(raw, "general")?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&server).fetch_one(db).await?;
    if !exists {
        return Err(crate::ApiError::new(axum::http::StatusCode::NOT_FOUND, "not a server"));
    }
    Ok(server)
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
    /// The account, when `verified`. Null on the row otherwise. The picture is not here: it
    /// is read at each say (`face_now`), so one changed mid-chat is on the next line.
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

/// The picture of the name on the line, as it is now (its upload time, the `?v=`): the account's
/// for a login (by id, so a rename keeps it), the room's for its streamer, nobody's for a nick,
/// whoever's name it happens to be. Read at the say, not the hello, so a picture changed
/// mid-chat is on the next line. The database not answering, or not in 2 s (awaited on the
/// socket: bounded like `remember`'s insert), is a line with no face until it is read back
/// (`with_faces`): a say does not fail for a picture.
async fn face_now(db: &PgPool, room: &str, w: &Who) -> Option<i64> {
    let query = match (w.user_id, w.streamer) {
        (Some(id), _) => sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM avatar_at))::bigint FROM streamers WHERE id = $1").bind(id),
        (None, true) => sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM avatar_at))::bigint FROM streamers WHERE name = $1").bind(&w.from),
        (None, false) => return None,
    };
    let looked: Result<Result<Option<Option<i64>>, sqlx::Error>, _> = tokio::time::timeout(Duration::from_secs(2), query.fetch_optional(db)).await;
    match looked {
        Ok(Ok(version)) => version.flatten(),
        Ok(Err(e)) => {
            log::warn!("{room}: cannot read the picture of {}: {e}", w.from);
            None
        }
        Err(_) => {
            log::warn!("{room}: reading the picture of {} timed out", w.from);
            None
        }
    }
}

/// Whose picture a line wears: the account's for a login (`uid`, which every login's line in
/// every stream has: scripts/migrate-scripts/migrate-1.sh filled the ones from before), the
/// name's for the room's streamer, nobody's for a nick.
enum FaceKey<'a> {
    Id(Uuid),
    Name(&'a str),
}

fn face_key(line: &Line) -> Option<FaceKey<'_>> {
    match (line.verified, line.user_id, line.streamer) {
        (true, Some(id), _) => Some(FaceKey::Id(id)),
        (false, _, true) => Some(FaceKey::Name(&line.from)),
        _ => None,
    }
}

/// The faces on lines read back out of redis, as they are now. A line keeps who said it, not
/// what they looked like: the picture is the row's today, the way history.rs joins `streamers`
/// for a line from postgres, so a new picture shows on every old line and a rename keeps a
/// login's for the hold's length; after it, the letter: the name leads elsewhere, and the page
/// fetches the picture by it. One query for the batch, none for a batch of nicks. A row that is
/// gone is no face, as the join would have it. The database not answering, or not in 2 s (the
/// history frame and a `since` fill await this on the socket), leaves what each line was written
/// with: faces a little behind, and the history still comes with the database down.
pub(crate) async fn with_faces<'a>(db: &PgPool, lines: impl IntoIterator<Item = &'a mut Line>) {
    let lines: Vec<&mut Line> = lines.into_iter().collect();
    let mut ids: Vec<Uuid> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for line in &lines {
        match face_key(line) {
            Some(FaceKey::Id(id)) if !ids.contains(&id) => ids.push(id),
            Some(FaceKey::Name(name)) if !names.iter().any(|n| n == name) => names.push(name.to_owned()),
            _ => {}
        }
    }
    if ids.is_empty() && names.is_empty() {
        return;
    }
    // each row with the names still held for it: a login's line wears the row's face only while
    // `from` leads to the row, which is for as long as `/api/streamers/<from>/avatar` answers for it
    let rows: Vec<(Uuid, String, Option<i64>, Vec<String>)> = match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query_as(
            "SELECT s.id, s.name, (EXTRACT(EPOCH FROM s.avatar_at))::bigint,
                    ARRAY(SELECT h.name FROM held_names h WHERE h.user_id = s.id AND h.until > now())::text[]
             FROM streamers s WHERE s.id = ANY($1::uuid[]) OR s.name = ANY($2::text[])",
        )
        .bind(&ids)
        .bind(&names)
        .fetch_all(db),
    )
    .await
    {
        Ok(Ok(rows)) => rows,
        Ok(Err(e)) => {
            log::warn!("cannot read the pictures for {} lines: {e}", lines.len());
            return;
        }
        Err(_) => {
            log::warn!("reading the pictures for {} lines timed out", lines.len());
            return;
        }
    };
    for line in lines {
        let face = match face_key(line) {
            Some(FaceKey::Id(id)) => rows
                .iter()
                .find(|(row, _, _, _)| *row == id)
                .filter(|(_, name, _, held)| *name == line.from || held.iter().any(|h| *h == line.from))
                .and_then(|(_, _, v, _)| *v),
            Some(FaceKey::Name(name)) => rows.iter().find(|(_, row, _, _)| row == name).and_then(|(_, _, v, _)| *v),
            None => continue,
        };
        line.avatar = face;
    }
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
    let mut speaker = Speaker::of(who.as_ref(), &hello, &ip);
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
                let Ok(In::Say { text, image, images, .. }) = serde_json::from_str::<In>(&text) else { continue };
                let (text, images) = match parse_say(text, image, images) {
                    Ok(Some(say)) => say,
                    Ok(None) => continue,
                    Err(why) => {
                        let _ = send(&mut socket, &Out::Error { error: why }).await;
                        continue;
                    }
                };
                if let Err(wait) = s.limiter.take(&speaker, &name) {
                    let _ = send(&mut socket, &slow(wait)).await;
                    continue;
                }
                // admitted while the database was down: whose line this would be is asked now
                if who.is_none() {
                    match identify(&s, &name, &headers, &hello).await {
                        Ok(w) => {
                            who = Some(w);
                            speaker = Speaker::of(who.as_ref(), &hello, &ip);
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
                if let Err(why) = accept(&s, &name, server.as_deref(), w, &text, &images).await {
                    let _ = send(&mut socket, &Out::Error { error: why }).await;
                    continue;
                }
            }
        }
    }

    s.leave(&name, &ip).await;
    log::info!("{name}: {} left", shown(&who));
}

/// A token bucket's size and pace: `burst` lines at once, refilling at `burst` per `window`,
/// one token every `window / burst`. Not a sliding window: three said at once are three gone,
/// and the next goes when one token is back, not when the oldest of the three is a window old.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Tier {
    burst: f64,
    window: Duration,
}

impl Tier {
    fn per_sec(self) -> f64 {
        self.burst / self.window.as_secs_f64()
    }
}

/// One bucket: the tokens in it as of `at`. Refilled by the time passed whenever it is read.
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(tier: Tier, now: Instant) -> Self {
        Bucket { tokens: tier.burst, at: now }
    }

    fn refill(&mut self, tier: Tier, now: Instant) {
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f64() * tier.per_sec()).min(tier.burst);
        self.at = now;
    }

    /// A token out, or how long until there is one.
    fn take(&mut self, tier: Tier, now: Instant) -> Result<(), Duration> {
        self.refill(tier, now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return Ok(());
        }
        Err(Duration::from_secs_f64((1.0 - self.tokens) / tier.per_sec()))
    }

    /// Would be full if read now: the same as no bucket at all.
    fn is_full(&self, tier: Tier, now: Instant) -> bool {
        self.tokens + now.duration_since(self.at).as_secs_f64() * tier.per_sec() >= tier.burst
    }
}

/// Whose bucket a line is paid from. The speaker, not the socket: another tab, or a reconnect,
/// draws on the same one, so neither is a fresh burst.
#[derive(Hash, PartialEq, Eq, Clone, Debug)]
enum Speaker {
    /// A login, by account, so a rename keeps the bucket.
    Account(Uuid),
    /// The one who went live with no login: the room's name.
    Streamer(String),
    /// A nick: the ip and the nick, lowercased. One browser's tabs share the nick (localstorage),
    /// and a household shares the ip, so two people behind one router with two nicks are two.
    Nick(String, String),
}

impl Speaker {
    /// Before the database has said who this is (`who` is None), the hello's nick on the anonymous
    /// tier; a login whose cookie could not be read is that until its first accepted line.
    fn of(who: Option<&Who>, hello: &Hello, ip: &str) -> Speaker {
        match who {
            Some(Who { user_id: Some(id), .. }) => Speaker::Account(*id),
            Some(w) if w.streamer => Speaker::Streamer(w.from.clone()),
            Some(w) => Speaker::Nick(ip.to_owned(), w.from.to_lowercase()),
            None => Speaker::Nick(ip.to_owned(), hello.nick.as_deref().map(clean_nick).unwrap_or_default().to_lowercase()),
        }
    }

    fn tier(&self) -> Tier {
        match self {
            Speaker::Account(_) | Speaker::Streamer(_) => LOGIN_TIER,
            Speaker::Nick(..) => ANON_TIER,
        }
    }
}

/// The buckets, one per speaker per room, shared by every socket in the process. A token is paid
/// before the database or redis is asked anything about the line: a `say` the database cannot
/// vouch for yet costs like any other dropped line, so a socket admitted read-only cannot turn
/// every frame into a query, and a refused line costs nothing but this lock. Nothing awaits under
/// it, so it is std's. A bucket that has refilled is the same as none, so those are forgotten
/// once a minute (`SWEEP_EVERY`): the map is the speakers of the last minute or so.
struct Limiter {
    inner: std::sync::Mutex<Buckets>,
}

struct Buckets {
    by_speaker: HashMap<(Speaker, String), Bucket>,
    swept: Instant,
}

impl Limiter {
    fn new() -> Self {
        Limiter { inner: std::sync::Mutex::new(Buckets { by_speaker: HashMap::new(), swept: Instant::now() }) }
    }

    /// A token out of this speaker's bucket in this room, or how long until there is one.
    fn take(&self, speaker: &Speaker, room: &str) -> Result<(), Duration> {
        self.take_at(speaker, room, Instant::now())
    }

    fn take_at(&self, speaker: &Speaker, room: &str, now: Instant) -> Result<(), Duration> {
        let tier = speaker.tier();
        let mut inner = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Buckets { by_speaker, swept } = &mut *inner;
        if now.duration_since(*swept) >= SWEEP_EVERY {
            *swept = now;
            by_speaker.retain(|(speaker, _), bucket| !bucket.is_full(speaker.tier(), now));
        }
        by_speaker.entry((speaker.clone(), room.to_owned())).or_insert_with(|| Bucket::new(tier, now)).take(tier, now)
    }
}

/// A `say` as it came: the words cleaned, the pictures' ids checked for shape. `Ok(None)` is
/// an empty line, dropped without a word. `Err` is what the socket hears. Nothing here asks
/// redis or the database, so it costs no token.
fn parse_say(text: String, image: Option<String>, images: Vec<String>) -> Result<Option<(String, Vec<String>)>, &'static str> {
    let text = clean_text(&text);
    let images = picture_ids(image, images)?;
    let chars = text.chars().count();
    if chars == 0 && images.is_empty() {
        return Ok(None);
    }
    if chars > MAX_TEXT_CHARS {
        return Err("too long");
    }
    Ok(Some((text, images)))
}

/// An identified socket's line into `room`: in a server's channel only a member may speak;
/// the pictures must be ones the api kept; then the line and the room's ttl in one atomic
/// round trip (a room whose first line landed but whose expire did not would otherwise live
/// forever), and the row for history on its own task. `Err` is what the socket hears, and
/// the line is not kept.
async fn accept(s: &ChatState, room: &str, server: Option<&str>, w: &Who, text: &str, images: &[String]) -> Result<(), &'static str> {
    // a channel is open to read. talking is for people in the server.
    if let Some(server) = server {
        let allowed = match w.user_id {
            Some(id) => match crate::groups::member(&s.db, id, server).await {
                Ok(yes) => yes,
                Err(e) => {
                    log::warn!("{room}: membership: {e}");
                    return Err("chat is busy, try again");
                }
            },
            None => false,
        };
        if !allowed {
            return Err("join the server first");
        }
    }
    pictures_exist(&s.db, room, images).await?;
    // the face as the row has it this moment, so the line fanned out now wears the right one
    let avatar = face_now(&s.db, room, w).await.map(|v| v.to_string());
    let mut r = s.redis.clone();
    // the badges as json, the picture's version and the account as text, and no field at
    // all for the common case of none
    let groups = if w.groups.is_empty() { String::new() } else { serde_json::to_string(&w.groups).unwrap_or_default() };
    let uid = w.user_id.map(|id| id.to_string());
    let mut fields = vec![("from", w.from.as_str()), ("text", text), ("streamer", if w.streamer { "1" } else { "0" }), ("v", if w.verified { "1" } else { "0" })];
    if !groups.is_empty() {
        fields.push(("g", groups.as_str()));
    }
    if let Some(avatar) = &avatar {
        fields.push(("a", avatar.as_str()));
    }
    if let Some(uid) = &uid {
        fields.push(("uid", uid.as_str()));
    }
    if let Some(image) = images.first() {
        fields.push(("img", image.as_str()));
    }
    let rest = if images.len() > 1 { Some(images[1..].join(",")) } else { None };
    if let Some(rest) = &rest {
        fields.push(("imgs", rest.as_str()));
    }
    let key = room_key(room);
    let added: Result<(Option<String>, bool), _> = redis::pipe()
        .atomic()
        .xadd_maxlen(&key, StreamMaxlen::Approx(KEEP_LINES), "*", &fields)
        .expire(&key, ROOM_TTL_SECS)
        .query_async(&mut r)
        .await;
    let id = match added {
        Ok((id, _)) => id,
        Err(e) => {
            log::warn!("{room}: xadd: {e}");
            return Err("chat is down, try again");
        }
    };
    // redis already has the line, and the room will fan it out. the insert
    // follows on its own, so a slow database does not hold this socket.
    if s.persist {
        if let Some(id) = id {
            remember(s, room, &id, w, text, images);
        }
    }
    // a channel's line is news to the server's other members (docs/notifications.md): their
    // inbox rows, on a task of their own like the row above. the speaker is a member, so a login
    if let (Some(server), Some(actor)) = (server, w.user_id) {
        notify_members(s, server, room, actor, text);
    }
    Ok(())
}

/// The inbox rows for a channel's line are written within this long, or not at all.
const NOTIFY_LIMIT: Duration = Duration::from_secs(5);

/// The inbox rows for a line in a server's channel (notify.rs `channel_line`), once redis has it:
/// one unread row a channel for every other member who keeps the kind and has not muted the
/// channel, and the fact that pushes them. Its own task, bounded like `remember`'s insert: a
/// database that is slow or away costs the members a row, never the room its line.
fn notify_members(s: &ChatState, server: &str, room: &str, actor: Uuid, text: &str) {
    // the room is `<server>/<channel>` (groups.rs `channel_room`); the writer wants the two apart
    let Some(channel) = room.strip_prefix(server).and_then(|rest| rest.strip_prefix('/')) else { return };
    let db = s.db.clone();
    let redis = s.redis.clone();
    let server = server.to_owned();
    let channel = channel.to_owned();
    let text = text.to_owned();
    tokio::spawn(async move {
        if tokio::time::timeout(NOTIFY_LIMIT, crate::notify::channel_line(&db, &redis, &server, &channel, actor, &text)).await.is_err() {
            log::warn!("{server}/{channel}: the inbox rows for a line timed out");
        }
    });
}

/// What one of a server socket's channels says, tagged with the channel, into the socket's one
/// queue. `Err(n)` is a room that ran ahead of this socket by n events.
type Tagged = (Arc<str>, Result<Event, u64>);

/// A server socket follows one more channel: its room joined (counted, capped per ip like
/// any socket) and a task forwarding its events, tagged, into the socket's queue. The task
/// ends with the socket (the queue's receiver dropped) or with the room. False at the cap.
async fn follow(s: &ChatState, server: &str, channel: &str, ip: &str, tx: &mpsc::UnboundedSender<Tagged>, joined: &mut Vec<Arc<str>>) -> bool {
    if joined.iter().any(|c| c.as_ref() == channel) {
        return true;
    }
    let Some(mut rx) = s.join(&format!("{server}/{channel}"), ip).await else { return false };
    let channel: Arc<str> = channel.into();
    joined.push(channel.clone());
    let tx = tx.clone();
    tokio::spawn(async move {
        loop {
            let event = tokio::select! {
                // the socket is gone: let go of the room's receiver, so a quiet room's reader can end too
                _ = tx.closed() => return,
                event = rx.recv() => match event {
                    Ok(event) => Ok(event),
                    Err(broadcast::error::RecvError::Lagged(n)) => Err(n),
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            };
            if tx.send((channel.clone(), event)).is_err() {
                return;
            }
        }
    });
    true
}

/// `digits-digits`, a redis stream id, so a `since` the page sends cannot be anything else.
fn is_stream_id(id: &str) -> bool {
    let mut parts = id.split('-');
    let (Some(ms), Some(seq), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    !ms.is_empty() && !seq.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) && seq.bytes().all(|b| b.is_ascii_digit())
}

/// The lines of a channel after `id`, oldest first, FILL_LIMIT at most: what the page missed
/// between the api's answer and this socket, or across a drop. Taken after the room is joined,
/// so a line in both arrives twice and is dropped by id, never in neither.
async fn after(s: &ChatState, room: &str, id: &str) -> Vec<Line> {
    let mut r = s.redis.clone();
    let reply: Result<StreamRangeReply, _> = r.xrange_count(room_key(room), format!("({id}"), "+", FILL_LIMIT).await;
    match reply {
        Ok(reply) => {
            let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
            with_faces(&s.db, &mut lines).await;
            lines
        }
        Err(e) => {
            log::warn!("{room}: xrange: {e}");
            Vec::new()
        }
    }
}

/// `/chat/<server>/*`: every channel of a server on one socket (docs/groups.md). The room page
/// opens this one and switches channels on screen, with no other socket and no history frame:
/// it drew every channel from `GET /api/groups/:group/messages`, and says in `since` the newest
/// id it has per channel, so the lines after each are sent and nothing falls between the api's
/// answer and this socket (or across a drop, on the reconnect). Lines go out as `message` with
/// `channel`, the count as `count` with `channel`; a `say` names its `channel`; `join` follows a
/// channel added since. Nobody is the streamer of a server, so the hello's grant means nothing here.
async fn handle_server(s: ChatState, server: String, ip: String, headers: HeaderMap, mut socket: WebSocket) {
    let name = format!("{server}/{EVERY_CHANNEL}");
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
    let shown = |who: &Option<Who>| match who {
        Some(w) => format!("{}{}", w.from, if w.is_bot() { " (bot)" } else { "" }),
        None => "somebody (database down, reading only)".to_owned(),
    };

    // 2. every channel of the server, joined. no history: the page has the api's
    let channels: Vec<String> = match sqlx::query_scalar("SELECT name FROM channels WHERE server = $1 ORDER BY created_at, name").bind(&server).fetch_all(&s.db).await {
        Ok(channels) => channels,
        Err(e) => {
            // a server with no channels to follow is no use: the panel is back in 3s
            log::warn!("{name}: cannot list the channels: {e}");
            let _ = send(&mut socket, &Out::Error { error: "chat is busy, try again" }).await;
            return;
        }
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<Tagged>();
    let mut joined: Vec<Arc<str>> = Vec::new();
    for channel in &channels {
        if !follow(&s, &server, channel, &ip, &tx, &mut joined).await {
            let _ = send(&mut socket, &Out::Error { error: "too many tabs" }).await;
            for channel in &joined {
                s.leave(&format!("{server}/{channel}"), &ip).await;
            }
            return;
        }
    }
    log::info!("{name}: {} joined, {} channels", shown(&who), joined.len());

    // 3. the loop: every channel's lines out with the channel on them, a say in for one of
    //    them, a ping now and then so a peer that vanished without a close frame is found out
    let mut last_seen: HashMap<Arc<str>, (u64, u64)> = HashMap::new();
    let mut speaker = Speaker::of(who.as_ref(), &hello, &ip);
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut shutdown = s.shutdown.clone();
    loop {
        tokio::select! {
            tagged = rx.recv() => match tagged {
                Some((channel, Ok(Event::Line(line)))) => {
                    let id = id_parts(&line.id);
                    if last_seen.get(&channel).is_some_and(|seen| id <= *seen) { continue; }
                    last_seen.insert(channel.clone(), id);
                    if send(&mut socket, &Out::ChannelMessage { channel: &channel, line: &line }).await.is_err() { break; }
                }
                Some((channel, Ok(Event::Count(count)))) => {
                    if send(&mut socket, &Out::ChannelCount { channel: &channel, count }).await.is_err() { break; }
                }
                Some((_, Err(n))) => {
                    let missed = format!("missed {n} lines");
                    if send(&mut socket, &Out::Error { error: &missed }).await.is_err() { break; }
                }
                None => break,
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
                match serde_json::from_str::<In>(&text) {
                    Ok(In::Since { since }) => {
                        // the page's newest id per channel: the lines after each, in order, dropped
                        // again by id if the room already sent one of them
                        for (channel, id) in since {
                            let Some(channel) = joined.iter().find(|c| c.as_ref() == channel).cloned() else { continue };
                            if !is_stream_id(&id) { continue; }
                            let floor = id_parts(&id);
                            if last_seen.get(&channel).is_some_and(|seen| *seen >= floor) { continue; }
                            last_seen.insert(channel.clone(), floor);
                            let room = format!("{server}/{channel}");
                            let mut failed = false;
                            for line in after(&s, &room, &id).await {
                                let id = id_parts(&line.id);
                                if last_seen.get(&channel).is_some_and(|seen| id <= *seen) { continue; }
                                last_seen.insert(channel.clone(), id);
                                if send(&mut socket, &Out::ChannelMessage { channel: &channel, line: &line }).await.is_err() { failed = true; break; }
                            }
                            if failed { break; }
                        }
                    }
                    Ok(In::Join { channel }) => {
                        // a channel added since the socket opened (the events socket said so). it asks
                        // the database whether the channel is there, so it costs a token like a line
                        let channel = channel.trim().to_lowercase();
                        if joined.iter().any(|c| c.as_ref() == channel) { continue; }
                        if let Err(wait) = s.limiter.take(&speaker, &name) {
                            let _ = send(&mut socket, &slow(wait)).await;
                            continue;
                        }
                        if crate::groups::channel_room(&s.db, &server, &channel).await.is_ok() && !follow(&s, &server, &channel, &ip, &tx, &mut joined).await {
                            let _ = send(&mut socket, &Out::Error { error: "too many tabs" }).await;
                        }
                    }
                    Ok(In::Say { text, image, images, channel }) => {
                        let Some(channel) = channel.map(|c| c.trim().to_lowercase()).filter(|c| joined.iter().any(|j| j.as_ref() == c)) else {
                            let _ = send(&mut socket, &Out::Error { error: "say which channel" }).await;
                            continue;
                        };
                        let (text, images) = match parse_say(text, image, images) {
                            Ok(Some(say)) => say,
                            Ok(None) => continue,
                            Err(why) => {
                                let _ = send(&mut socket, &Out::Error { error: why }).await;
                                continue;
                            }
                        };
                        if let Err(wait) = s.limiter.take(&speaker, &name) {
                            let _ = send(&mut socket, &slow(wait)).await;
                            continue;
                        }
                        if who.is_none() {
                            match identify(&s, &name, &headers, &hello).await {
                                Ok(w) => {
                                    who = Some(w);
                                    speaker = Speaker::of(who.as_ref(), &hello, &ip);
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
                        let room = format!("{server}/{channel}");
                        if let Err(why) = accept(&s, &room, Some(&server), w, &text, &images).await {
                            let _ = send(&mut socket, &Out::Error { error: why }).await;
                            continue;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    for channel in &joined {
        s.leave(&format!("{server}/{channel}"), &ip).await;
    }
    log::info!("{name}: {} left", shown(&who));
}

/// The row for a line redis already accepted. Its own task: the socket goes back to the room.
fn remember(s: &ChatState, room: &str, id: &str, w: &Who, text: &str, images: &[String]) {
    let db = s.db.clone();
    let room = room.to_owned();
    let id = id.to_owned();
    let speaker = w.from.clone();
    let user_id = w.user_id;
    let text = text.to_owned();
    let image = if images.is_empty() { None } else { Some(images.join(",")) };
    let streamer = w.streamer;
    let verified = w.verified;
    let groups = w.groups.clone();
    tokio::spawn(async move {
        let inserted = tokio::time::timeout(
            Duration::from_secs(2),
            history::store(&db, &room, &id, &speaker, user_id, &text, image.as_deref(), streamer, verified, &groups),
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

/// The last lines of a room, oldest first, with the faces as they are now.
async fn history(s: &ChatState, name: &str) -> Result<Vec<Line>, redis::RedisError> {
    let mut r = s.redis.clone();
    let reply: StreamRangeReply = r.xrevrange_count(room_key(name), "+", "-", HISTORY_LINES).await?;
    let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
    lines.reverse();
    with_faces(&s.db, &mut lines).await;
    Ok(lines)
}

/// Ten pictures on one line. The bytes stay in the bucket; the line names the ids.
const MAX_IMAGES: usize = 10;

/// The ids a say named. `images` when it sent the set, otherwise the one `image`.
fn picture_ids(image: Option<String>, images: Vec<String>) -> Result<Vec<String>, &'static str> {
    let raw = if images.is_empty() { image.into_iter().collect::<Vec<_>>() } else { images };
    if raw.len() > MAX_IMAGES {
        return Err("too many pictures");
    }
    let mut out = Vec::new();
    for raw in raw {
        let Ok(id) = Uuid::parse_str(raw.trim()) else { return Err("bad picture") };
        let id = id.to_string();
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

async fn pictures_exist(db: &sqlx::PgPool, name: &str, ids: &[String]) -> Result<(), &'static str> {
    for id in ids {
        match crate::chat_images::exists(db, id).await {
            Ok(true) => {}
            Ok(false) => return Err("no such picture"),
            Err(e) => {
                log::warn!("{name}: picture: {e}");
                return Err("chat is busy, try again");
            }
        }
    }
    Ok(())
}

/// Ids in a stored field: one id, or several joined by commas.
pub(crate) fn split_pictures(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else { return Vec::new() };
    raw.split(',').map(|part| part.trim().to_string()).filter(|part| !part.is_empty()).collect()
}

pub(crate) fn line_from(entry: StreamId) -> Option<Line> {
    let from: String = entry.get("from")?;
    let text: String = entry.get("text")?;
    let streamer: String = entry.get("streamer").unwrap_or_else(|| "0".to_owned());
    let verified: String = entry.get("v").unwrap_or_else(|| "0".to_owned());
    // no `g` field, or one this build cannot read, is a line with no badges
    let groups: Vec<Badge> = entry.get::<String>("g").and_then(|g| serde_json::from_str(&g).ok()).unwrap_or_default();
    // no `a` field is a line with no picture (as written; `with_faces` has the last word)
    let avatar: Option<i64> = entry.get::<String>("a").and_then(|a| a.parse().ok());
    // the account behind a login's line: what its face is looked up by
    let user_id: Option<Uuid> = entry.get::<String>("uid").and_then(|u| Uuid::parse_str(&u).ok());
    let images = {
        let mut images = split_pictures(entry.get::<String>("img"));
        for part in split_pictures(entry.get::<String>("imgs")) {
            if !images.iter().any(|id| id == &part) {
                images.push(part);
            }
        }
        images
    };
    let image = images.first().cloned();
    Some(Line {
        at: id_parts(&entry.id).0,
        id: entry.id,
        from,
        text,
        streamer: streamer == "1",
        verified: verified == "1",
        groups,
        avatar,
        user_id,
        image,
        images,
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

    /// A server socket's line is the same `message`, with `channel` beside the line's own fields.
    #[test]
    fn a_server_sockets_line_carries_its_channel() {
        let line = Line {
            id: "1729000000000-0".into(),
            from: "bob".into(),
            text: "hi".into(),
            streamer: false,
            verified: true,
            groups: Vec::new(),
            avatar: None,
            user_id: Some(Uuid::nil()),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
        };
        let text = serde_json::to_string(&Out::ChannelMessage { channel: "general", line: &line }).unwrap();
        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(frame["type"], "message");
        assert_eq!(frame["channel"], "general");
        assert_eq!(frame["id"], "1729000000000-0");
        assert_eq!(frame["from"], "bob");
        assert_eq!(frame["verified"], true);
        // the account is the face's key, not a thing a page reads
        assert!(frame.get("user_id").is_none());
        assert_eq!(serde_json::to_string(&Out::ChannelCount { channel: "general", count: 3 }).unwrap(), r#"{"type":"count","channel":"general","count":3}"#);
        // the channel of `*` is no channel: the name rule keeps it free
        assert!(!crate::valid_name(EVERY_CHANNEL));
    }

    #[test]
    fn a_since_id_is_a_stream_id() {
        assert!(is_stream_id("1729000000000-0"));
        assert!(is_stream_id("0-0"));
        assert!(!is_stream_id("garbage"));
        assert!(!is_stream_id("1-2-3"));
        assert!(!is_stream_id("-1"));
        assert!(!is_stream_id("1-"));
        assert!(!is_stream_id(""));
    }

    /// The words are cleaned and the pictures' ids checked before a line costs a token.
    #[test]
    fn a_say_is_cleaned_before_it_costs() {
        assert_eq!(parse_say("  hi  ".into(), None, Vec::new()), Ok(Some(("hi".into(), Vec::new()))));
        assert_eq!(parse_say("   ".into(), None, Vec::new()), Ok(None));
        assert_eq!(parse_say("x".repeat(MAX_TEXT_CHARS + 1), None, Vec::new()), Err("too long"));
        assert_eq!(parse_say(String::new(), Some("not-an-id".into()), Vec::new()), Err("bad picture"));
        let id = "6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e";
        assert_eq!(parse_say(String::new(), Some(id.into()), Vec::new()), Ok(Some((String::new(), vec![id.into()]))));
    }

    fn about(wait: Duration, secs: f64) -> bool {
        (wait.as_secs_f64() - secs).abs() < 0.01
    }

    /// Without an account: two at once, then one every thirty seconds, and a token is a token: the
    /// third waits for the next one back, not for the first of the two to be a minute old.
    #[test]
    fn a_nick_has_two_lines_then_one_every_thirty_seconds() {
        let now = Instant::now();
        let at = |secs: u64| now + Duration::from_secs(secs);
        let mut b = Bucket::new(ANON_TIER, now);
        assert!(b.take(ANON_TIER, now).is_ok());
        assert!(b.take(ANON_TIER, now).is_ok());
        assert!(about(b.take(ANON_TIER, now).unwrap_err(), 30.0));
        // ten seconds on: still no, and the wait has come down by that much
        assert!(about(b.take(ANON_TIER, at(10)).unwrap_err(), 20.0));
        // one is back at thirty seconds, and one only
        assert!(b.take(ANON_TIER, at(30)).is_ok());
        assert!(about(b.take(ANON_TIER, at(30)).unwrap_err(), 30.0));
        // a long quiet is a full bucket again, and not more than full
        assert!(b.take(ANON_TIER, at(600)).is_ok());
        assert!(b.take(ANON_TIER, at(600)).is_ok());
        assert!(b.take(ANON_TIER, at(600)).is_err());
    }

    /// A login: three at once, then one every 3⅓ seconds.
    #[test]
    fn a_login_has_three_lines_then_one_every_three_and_a_third_seconds() {
        let now = Instant::now();
        let mut b = Bucket::new(LOGIN_TIER, now);
        for _ in 0..3 {
            assert!(b.take(LOGIN_TIER, now).is_ok());
        }
        assert!(about(b.take(LOGIN_TIER, now).unwrap_err(), 10.0 / 3.0));
        assert!(b.take(LOGIN_TIER, now + Duration::from_millis(3334)).is_ok());
        assert!(b.take(LOGIN_TIER, now + Duration::from_millis(3334)).is_err());
    }

    /// The bucket is the speaker's in the room, whatever socket the line came on.
    #[test]
    fn the_bucket_is_the_speakers_not_the_sockets() {
        let limiter = Limiter::new();
        let now = Instant::now();
        let alice = Speaker::Nick("1.2.3.4".into(), "alice".into());
        assert!(limiter.take_at(&alice, "room", now).is_ok());
        assert!(limiter.take_at(&alice, "room", now).is_ok());
        // the same nick from another socket, spelled with a capital: the same bucket, empty
        assert!(limiter.take_at(&Speaker::of(None, &Hello { nick: Some("Alice".into()), session: None, token: None, bot: None }, "1.2.3.4"), "room", now).is_err());
        // another room is another bucket, and so is another nick behind the same ip
        assert!(limiter.take_at(&alice, "other", now).is_ok());
        assert!(limiter.take_at(&Speaker::Nick("1.2.3.4".into(), "bob".into()), "room", now).is_ok());
        // a login's is by account, so two tabs of one login are one speaker
        let bob = Speaker::Account(Uuid::nil());
        for _ in 0..3 {
            assert!(limiter.take_at(&bob, "room", now).is_ok());
        }
        assert!(limiter.take_at(&bob, "room", now).is_err());
    }

    /// Once a minute the buckets that have refilled go; one still owed a token stays.
    #[test]
    fn full_buckets_are_forgotten() {
        let limiter = Limiter::new();
        let now = Instant::now();
        let alice = Speaker::Nick("1.2.3.4".into(), "alice".into());
        let bob = Speaker::Account(Uuid::nil());
        for _ in 0..2 {
            limiter.take_at(&alice, "room", now).unwrap();
        }
        limiter.take_at(&bob, "room", now).unwrap();
        // alice spends the one she got back at thirty seconds, so at the sweep she has one, not two
        limiter.take_at(&alice, "room", now + Duration::from_secs(30)).unwrap();
        assert_eq!(limiter.inner.lock().unwrap().by_speaker.len(), 2);
        // the sweep rides on the next take, a minute after the first
        let carol = Speaker::Nick("5.6.7.8".into(), "carol".into());
        limiter.take_at(&carol, "room", now + SWEEP_EVERY).unwrap();
        let kept: Vec<Speaker> = limiter.inner.lock().unwrap().by_speaker.keys().map(|(s, _)| s.clone()).collect();
        assert_eq!(kept.len(), 2, "{kept:?}");
        assert!(kept.contains(&alice) && kept.contains(&carol), "{kept:?}");
    }

    /// Who draws on which bucket: a login by account, the streamer by the room, a nick by ip and nick,
    /// and somebody the database has not named yet by the hello's nick.
    #[test]
    fn who_draws_on_which_bucket() {
        let hello = Hello { nick: Some(" Bob ".into()), session: None, token: None, bot: None };
        let id = Uuid::nil();
        let login = Who { from: "bob".into(), streamer: false, verified: true, groups: Vec::new(), user_id: Some(id) };
        assert_eq!(Speaker::of(Some(&login), &hello, "1.2.3.4"), Speaker::Account(id));
        // the one who went live while logged in as somebody else, or as nobody: the room's
        let streamer = Who { from: "room".into(), streamer: true, verified: false, groups: Vec::new(), user_id: None };
        assert_eq!(Speaker::of(Some(&streamer), &hello, "1.2.3.4"), Speaker::Streamer("room".into()));
        // the streamer logged in as the room's name: the account, like any login
        let own = Who { from: "room".into(), streamer: true, verified: true, groups: Vec::new(), user_id: Some(id) };
        assert_eq!(Speaker::of(Some(&own), &hello, "1.2.3.4"), Speaker::Account(id));
        let nick = Who { from: "Bob".into(), streamer: false, verified: false, groups: Vec::new(), user_id: None };
        assert_eq!(Speaker::of(Some(&nick), &hello, "1.2.3.4"), Speaker::Nick("1.2.3.4".into(), "bob".into()));
        assert_eq!(Speaker::of(None, &hello, "1.2.3.4"), Speaker::Nick("1.2.3.4".into(), "bob".into()));
        assert_eq!(Speaker::of(None, &Hello { nick: None, session: None, token: None, bot: None }, "1.2.3.4"), Speaker::Nick("1.2.3.4".into(), String::new()));
        assert_eq!(Speaker::Account(id).tier(), LOGIN_TIER);
        assert_eq!(Speaker::Streamer("room".into()).tier(), LOGIN_TIER);
        assert_eq!(Speaker::Nick("1.2.3.4".into(), "bob".into()).tier(), ANON_TIER);
    }

    /// The refusal is the `error` frame every page knows, with the wait beside the words, rounded up.
    #[test]
    fn a_refused_line_says_how_long() {
        assert_eq!(serde_json::to_string(&slow(Duration::from_micros(1_234_500))).unwrap(), r#"{"type":"error","error":"slow down","wait":1235}"#);
        assert_eq!(serde_json::to_string(&slow(Duration::from_secs(30))).unwrap(), r#"{"type":"error","error":"slow down","wait":30000}"#);
    }

    /// The server socket's frames parse beside the stream's: a say names its channel, and
    /// `join` and `since` are only its.
    #[test]
    fn server_socket_frames_parse() {
        match serde_json::from_str::<In>(r#"{"type":"say","text":"hi","channel":"clips"}"#).unwrap() {
            In::Say { text, channel, .. } => {
                assert_eq!(text, "hi");
                assert_eq!(channel.as_deref(), Some("clips"));
            }
            _ => panic!("not a say"),
        }
        match serde_json::from_str::<In>(r#"{"type":"say","text":"hi"}"#).unwrap() {
            In::Say { channel, .. } => assert_eq!(channel, None),
            _ => panic!("not a say"),
        }
        assert!(matches!(serde_json::from_str::<In>(r#"{"type":"join","channel":"clips"}"#).unwrap(), In::Join { channel } if channel == "clips"));
        match serde_json::from_str::<In>(r#"{"type":"since","since":{"general":"1729000000000-0"}}"#).unwrap() {
            In::Since { since } => assert_eq!(since.get("general").map(String::as_str), Some("1729000000000-0")),
            _ => panic!("not a since"),
        }
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

    /// A pool that can never connect. sqlx retries a refused connection until the pool's
    /// acquire timeout (5 s, as in main.rs), so a lookup with no bound of its own takes all of it.
    fn pool_that_never_answers() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_secs(5))
            .connect_lazy("postgres://u:p@127.0.0.1:1/x")
            .expect("a pool that is never connected")
    }

    /// `face_now` is awaited on the socket at each say: a database that does not answer is a
    /// line with no face within 2 s, like `remember`'s insert, not the pool's 5 s.
    #[tokio::test]
    async fn a_face_at_the_say_waits_two_seconds_at_most() {
        let pool = pool_that_never_answers();
        let who = Who { from: "bob".to_owned(), streamer: false, verified: true, groups: Vec::new(), user_id: Some(Uuid::nil()) };
        let started = Instant::now();
        let face = face_now(&pool, "room", &who).await;
        let took = started.elapsed();
        assert_eq!(face, None);
        assert!(took < Duration::from_secs(3), "face_now held the socket for {took:?}");
    }

    /// `with_faces` is awaited on the socket before the history frame and a `since` fill: a
    /// database that does not answer leaves the lines as written, within 2 s, not the pool's 5 s.
    #[tokio::test]
    async fn faces_on_the_way_out_wait_two_seconds_at_most() {
        let pool = pool_that_never_answers();
        let mut lines = vec![Line {
            id: "1729000000000-0".into(),
            from: "bob".into(),
            text: "hi".into(),
            streamer: false,
            verified: true,
            groups: Vec::new(),
            avatar: Some(7),
            user_id: Some(Uuid::nil()),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
        }];
        let started = Instant::now();
        with_faces(&pool, &mut lines).await;
        let took = started.elapsed();
        assert_eq!(lines[0].avatar, Some(7), "a line the database did not answer for is left as written");
        assert!(took < Duration::from_secs(3), "with_faces held the socket for {took:?}");
    }

    /// A login's old lines keep its face through a rename for the hold's length, while
    /// `/api/streamers/<old>/avatar` still answers for the account (profile.rs). After it the
    /// old name leads elsewhere, and the page fetches by `from`: the letter, not the account's
    /// current version (a 404 on the page) and not whoever took the name.
    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored for_the_hold_and_then` against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn a_face_follows_a_rename_for_the_hold_and_then_is_the_letter() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let alice_name = format!("alice5-{run}");
        let alice = row(&pool, &alice_name, Some("alice-hash")).await;
        sqlx::query("UPDATE streamers SET avatar_at = to_timestamp(1690000000) WHERE id = $1").bind(alice).execute(&pool).await.unwrap();
        let mut lines = vec![Line {
            id: "1729000000000-0".into(),
            from: alice_name.clone(),
            text: "hi".into(),
            streamer: false,
            verified: true,
            groups: Vec::new(),
            avatar: None,
            user_id: Some(alice),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
        }];
        // her own name: her picture
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, Some(1690000000));

        // what change_name leaves behind: the row is bob, and alice is held for it. the face follows
        let bob_name = format!("bob5-{run}");
        sqlx::query("UPDATE streamers SET name = $2, renamed_at = now() WHERE id = $1").bind(alice).bind(&bob_name).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO held_names (name, user_id, until) VALUES ($1, $2, now() + interval '30 days')")
            .bind(&alice_name)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();
        lines[0].avatar = None;
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, Some(1690000000), "the face follows a rename for the hold's length");

        // the hold runs out: the old name is nobody's, so the line is the letter, not an <img> that 404s
        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&alice_name).execute(&pool).await.unwrap();
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, None, "after the hold the old name is not the account's: the letter");

        // a stranger signs up as alice and uploads a picture: still the letter, not theirs and not bob's.
        // the line comes out of redis with the `a` the say wrote, and must be overwritten
        let stranger = row(&pool, &alice_name, Some("stranger-hash")).await;
        sqlx::query("UPDATE streamers SET avatar_at = to_timestamp(1700000000) WHERE id = $1").bind(stranger).execute(&pool).await.unwrap();
        lines[0].avatar = Some(1690000000);
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, None, "a stranger on the freed name is nobody's picture on the account's words");
    }
}
