//! `/events`: the gateway. One websocket per browser, open on every page. A process of its
//! own, `api events` on :4100, the `events` container: the chat is a different socket in a
//! different container, and the two share only the plumbing in socket.rs. See docs/status.md.
//!
//! A socket says hello as a name (the cookie's login, else the nick lowercased when nobody
//! owns that name, else nobody) and from then on the name is *here*: a member of the sorted
//! set `seen:<name>` scored by the time this socket last refreshed it, which it does on its own
//! 30s ping. The first socket in and the last one out of a name are atomic EVALs that also put
//! a `seen` fact on the `events` stream. A socket may `watch` names: it is told their word
//! (`presence`) when it changes, and `live` / `ended` as they happen. Every socket watches its
//! own name without asking: `me` carries the word and the choice.
//!
//! Facts come from one redis stream, `events`, written by the api (`live`, `ended`, `viewers`,
//! `status`, `renamed`, and `dm` / `dm_read` for the direct messages of docs/dms.md and
//! `notify` / `notify_read` for the inbox of docs/notifications.md, which go to the sockets
//! that *are* a name rather than to its watchers) and by this module (`seen`).
//! One task per process tails it and routes
//! each entry to the sockets that care; the word is derived here, on delivery, from the inputs
//! (the `live:` key, the set, the column), never carried in a fact, so two writers cannot race
//! a stale word past a fresh one. The pages never write through this socket: the choice is an
//! http PUT. A socket may also `watch` `*`: every name's `live`, `ended` and `viewers`, the
//! home page's feed behind its one `GET /api/streams` (home.rs). And it may `watch`
//! `group:<name>`: every change to that group (`group` facts from groups.rs, forwarded whole),
//! plus `live` and `ended` for its members, so a room on screen follows without asking again.
//!
//! A `renamed` fact (docs/ids.md) re-keys the sockets of the old name to the new one: they
//! leave `seen:<old>` at once and enter `seen:<new>`, and they, and the old name's watchers,
//! get a `renamed` frame. A socket's name lives in the registry, not in its task, so the
//! ping that keeps it here reads the current one.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use redis::aio::ConnectionManager;
use redis::streams::{StreamId, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::{mpsc, watch, Mutex, Notify};

use crate::auth::{is_claimed, whoami, NICK_HAS_ACCOUNT};
use crate::chat::{clean_nick, valid_nick};
use crate::presence::{self, Presence, Status, EVENTS_KEEP, EVENTS_KEY, SEEN_TTL_SECS, SEEN_WINDOW_MS};
use crate::socket::{first_text, send, DRAIN_LIMIT, IDLE_LIMIT, MAX_FRAME_BYTES, PING_EVERY, READ_BLOCK_MS, SEND_TIMEOUT};
use crate::{live_key, valid_name};

/// How far back the tail starts after a (re)start: the gap of a deploy, replayed. Deliveries
/// are idempotent (the word is recomputed from the truth; `live` and `ended` make the page ask
/// `watch` again), so a replayed entry costs nothing.
const REPLAY_MS: i64 = 10_000;
/// Every watched name's word again, pushed on change: notices a gateway that died without its
/// drain (its members go stale and nobody published `seen 0`) and heals an entry a watcher missed.
const RECHECK_EVERY: Duration = Duration::from_secs(30);
/// The `watch` that means every name: the home page's. Not a name (names are letters, digits, `_ -`).
const EVERYONE: &str = "*";
/// The `watch` that means one group's room: `group:<name>`. Not a name either (the colon).
const GROUP_TOPIC: &str = "group:";

/// `group:<name>` → the group, when the rest is a name. None for anything else.
fn group_topic(watch: &str) -> Option<&str> {
    watch.strip_prefix(GROUP_TOPIC).filter(|name| valid_name(name))
}

/// A `watch` that is a topic, not a name: no word to compute or recheck for it.
fn is_topic(watch: &str) -> bool {
    watch == EVERYONE || watch.starts_with(GROUP_TOPIC)
}

type SocketId = u64;

/// The first socket of a name: trim the stale, add mine, keep the set alive, and say `seen 1`
/// if the set was empty. One EVAL, so two gateways cannot race a last-out against a first-in.
/// KEYS: seen:<name>, events. ARGV: socket id, now ms, name, window ms, ttl secs, maxlen.
const FIRST_IN: &str = r#"
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. (tonumber(ARGV[2]) - tonumber(ARGV[4])))
local was = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[5])
if was == 0 then
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[6], '*', 'type', 'seen', 'name', ARGV[3], 'here', '1')
  return 1
end
return 0
"#;

/// The mirror: remove mine, trim the stale, and say `seen 0` if nobody is left.
const LAST_OUT: &str = r#"
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. (tonumber(ARGV[2]) - tonumber(ARGV[4])))
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[6], '*', 'type', 'seen', 'name', ARGV[3], 'here', '0')
  return 0
end
return 1
"#;

#[derive(Clone)]
pub(crate) struct Gateway {
    db: PgPool,
    redis: ConnectionManager,
    client: redis::Client,
    shutdown: watch::Receiver<bool>,
    dummy_prefix: String,
    /// `<hostname>:<n>` is a socket's member in `seen:<name>`: a stale one names the process that left it.
    host: Arc<str>,
    next: Arc<AtomicU64>,
    registry: Registry,
    /// Pinged when redis is back: every socket re-marks its name at once rather than at its next tick.
    refresh: Arc<Notify>,
}

/// Every open socket of this process, and two indexes over them: which sockets are a name,
/// which sockets watch it. Behind one lock; nothing in here waits on the network.
#[derive(Clone, Default)]
pub(crate) struct Registry(Arc<Mutex<Sockets>>);

#[derive(Default)]
struct Sockets {
    by_id: HashMap<SocketId, Entry>,
    own: HashMap<String, HashSet<SocketId>>,
    watchers: HashMap<String, HashSet<SocketId>>,
}

struct Entry {
    tx: mpsc::UnboundedSender<Out>,
    name: Option<String>,
    watching: HashSet<String>,
    /// The last word each watched name was told. Pushed only on change.
    told: HashMap<String, Presence>,
    /// The last `me`: my word and my choice. Pushed only on change.
    me: Option<(Presence, Status)>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum In {
    Hello { nick: Option<String> },
    Watch { name: String },
    Unwatch { name: String },
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Out {
    Me { name: Option<String>, presence: Presence, status: Status },
    Presence { name: String, presence: Presence },
    /// A stream started. `card` is what the api put in the fact for a home card (`verified`,
    /// `avatar`, `bio`, `thumbs`), spread into the frame as it came; empty from an older api.
    Live {
        name: String,
        since: i64,
        #[serde(flatten)]
        card: serde_json::Map<String, Value>,
    },
    Ended { name: String },
    /// How many are receiving a stream now, as video counts them (docs/viewers.md).
    Viewers { name: String, viewers: usize },
    /// `name` became `to`. To the account's own sockets and to `name`'s watchers.
    Renamed { name: String, to: String },
    /// A direct message (docs/dms.md), to the sockets of both names: every device of either sees the same line.
    /// `from_id` is the writer's account. Absent when an older api wrote the fact.
    Dm {
        id: i64,
        from: String,
        to: String,
        text: String,
        at: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        from_id: Option<String>,
    },
    /// `name` read its thread with `peer` up to `id` on some device. To `name`'s sockets: the others drop their count.
    /// `peer_id` is that account. Absent when an older api wrote the fact.
    #[serde(rename = "dm_read")]
    DmRead {
        name: String,
        peer: String,
        id: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
    },
    /// A row of the login's inbox (docs/notifications.md), to its own sockets: `name` is who did
    /// it, as the list draws them; `actor` is that account's id (absent when an older api wrote
    /// the fact); `id` the row, so a replayed fact is the same row.
    Notification {
        id: i64,
        kind: String,
        name: String,
        verified: bool,
        avatar: Option<i64>,
        at: i64,
        text: String,
        session: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        actor: Option<String>,
    },
    /// `name` saw its inbox up to `id` on some device. To `name`'s sockets: the others drop their count.
    #[serde(rename = "notify_read")]
    NotifyRead { name: String, id: i64 },
    /// A group changed (docs/groups.md), to the sockets watching `group:<group>`. `what` says
    /// how; `data` is the change as the api wrote it, spread into the frame as it came
    /// (`joined` carries `who`, `avatar`, `joined`, `members`; `channel` the channel; and so on).
    /// This process knows no more about it than that, so a new kind of change is the api's alone.
    Group {
        group: String,
        what: String,
        #[serde(flatten)]
        data: serde_json::Map<String, Value>,
    },
    Error { error: &'static str },
}

/// A hello that can never do. Said once, and the socket is closed, as in the chat.
struct Refused(&'static str);

impl Registry {
    pub(crate) async fn is_empty(&self) -> bool {
        self.0.lock().await.by_id.is_empty()
    }
}

/// `api events`: the gateway on a listener of its own. `GET /health` for the container's
/// check, `/events` for the browsers, `/online` for the tests inside the network. On SIGTERM
/// every socket gets a close frame and up to DRAIN_LIMIT to leave, like the chat's rooms.
pub(crate) async fn run(db: PgPool, redis_url: &str, port: u16) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let redis = crate::connect_redis(redis_url).await;
    let (stop, shutdown) = watch::channel(false);
    let dummy_prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let gateway = Gateway::new(db, redis, client, shutdown, dummy_prefix);
    let sockets = gateway.registry();

    let router = Router::new().route("/health", get(|| async { "ok" })).merge(routes(gateway));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("events on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            crate::wait_for_signal().await;
            // axum does not wait for upgraded sockets: tell every handle to say goodbye
            let _ = stop.send(true);
        })
        .await?;
    // ...and give them a moment to send the close frame, instead of being cut mid-send
    let deadline = Instant::now() + DRAIN_LIMIT;
    while !sockets.is_empty().await && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

impl Gateway {
    pub(crate) fn new(db: PgPool, redis: ConnectionManager, client: redis::Client, shutdown: watch::Receiver<bool>, dummy_prefix: String) -> Self {
        // docker sets HOSTNAME to the container id; a box without it is "events"
        let host = std::env::var("HOSTNAME").ok().filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "events".into());
        let g = Gateway {
            db,
            redis,
            client,
            shutdown,
            dummy_prefix,
            host: host.into(),
            next: Arc::new(AtomicU64::new(1)),
            registry: Registry::default(),
            refresh: Arc::new(Notify::new()),
        };
        tokio::spawn(tail(g.clone()));
        tokio::spawn(recheck(g.clone()));
        g
    }

    /// For the drain: `run` waits until this is empty, like the rooms.
    pub(crate) fn registry(&self) -> Registry {
        self.registry.clone()
    }

    // ---- redis: here or not ------------------------------------------------------------------

    /// One of the two scripts, with its keys and arguments. Raw EVAL like `DEL_IF_HELD_BY` in
    /// main.rs: the crate's `Script` is behind a feature this binary does not carry.
    async fn eval(&self, script: &str, sid: &str, name: &str) -> Result<i64, redis::RedisError> {
        let mut r = self.redis.clone();
        redis::cmd("EVAL")
            .arg(script)
            .arg(2)
            .arg(presence::seen_key(name))
            .arg(EVENTS_KEY)
            .arg(sid)
            .arg(presence::now_ms())
            .arg(name)
            .arg(SEEN_WINDOW_MS)
            .arg(SEEN_TTL_SECS)
            .arg(EVENTS_KEEP)
            .query_async(&mut r)
            .await
    }

    async fn mark_first(&self, sid: &str, name: &str) {
        match self.eval(FIRST_IN, sid, name).await {
            Ok(1) => log::info!("{name}: here"),
            Ok(_) => {}
            Err(e) => log::warn!("{name}: cannot mark here: {e}"),
        }
    }

    async fn mark_last(&self, sid: &str, name: &str) {
        match self.eval(LAST_OUT, sid, name).await {
            Ok(0) => log::info!("{name}: gone"),
            Ok(_) => {}
            Err(e) => log::warn!("{name}: cannot unmark: {e}"),
        }
    }

    /// Every 30s, and when redis is back: my member fresh again, the set alive. A set redis
    /// lost (a restart) comes back from this; the word watchers hold is then recomputed as
    /// what they already have and nothing is pushed.
    async fn touch(&self, sid: &str, name: &str) {
        let mut r = self.redis.clone();
        let key = presence::seen_key(name);
        let res: Result<(), redis::RedisError> = redis::pipe()
            .atomic()
            .zadd(&key, sid, presence::now_ms())
            .ignore()
            .expire(&key, SEEN_TTL_SECS)
            .ignore()
            .query_async(&mut r)
            .await;
        if let Err(e) = res {
            log::warn!("{name}: cannot refresh: {e}");
        }
    }

    // ---- the word ----------------------------------------------------------------------------

    /// The rule of presence.rs, from the key (not video: one http call per event per watcher
    /// would be the wrong price; phase 5 of docs/status.md makes the key honest within seconds).
    /// The choice is read only when it decides the word, or when a `me` needs it.
    async fn word(&self, name: &str, want_status: bool) -> (Presence, Status) {
        let mut r = self.redis.clone();
        let live: bool = r.exists(live_key(name)).await.unwrap_or(false);
        let here = if live { false } else { presence::here(&mut r, name).await.unwrap_or(false) };
        let status = if want_status || (here && !live) {
            presence::status_of(&self.db, name).await.unwrap_or_default()
        } else {
            Status::default()
        };
        (presence::derive(live, here, status), status)
    }

    /// The word of `name` again, to everyone it concerns, on change only.
    async fn push(&self, name: &str) {
        let (word, status) = self.word(name, true).await;
        let mut s = self.registry.0.lock().await;
        let watchers: Vec<SocketId> = s.watchers.get(name).into_iter().flatten().copied().collect();
        let own: Vec<SocketId> = s.own.get(name).into_iter().flatten().copied().collect();
        for id in watchers {
            if let Some(e) = s.by_id.get_mut(&id) {
                if e.told.get(name) != Some(&word) {
                    e.told.insert(name.to_owned(), word);
                    let _ = e.tx.send(Out::Presence { name: name.to_owned(), presence: word });
                }
            }
        }
        for id in own {
            if let Some(e) = s.by_id.get_mut(&id) {
                if e.me != Some((word, status)) {
                    e.me = Some((word, status));
                    let _ = e.tx.send(Out::Me { name: Some(name.to_owned()), presence: word, status });
                }
            }
        }
    }

    /// A frame to every socket that *is* one of `names` (not their watchers): what a login's
    /// own devices hear, a direct message, a read mark. Once each, whichever names it wears.
    async fn tell(&self, names: &[&str], out: Out) {
        let s = self.registry.0.lock().await;
        let mut told: HashSet<SocketId> = HashSet::new();
        for name in names {
            for id in s.own.get(*name).into_iter().flatten() {
                if told.insert(*id) {
                    if let Some(e) = s.by_id.get(id) {
                        let _ = e.tx.send(out.clone());
                    }
                }
            }
        }
    }

    /// A fact as it is, to the name's watchers and to everyone watching `*` (the home pages:
    /// every stream's `live`, `ended` and `viewers`, whoever it is). Once each, to a socket that is both.
    async fn fan(&self, name: &str, out: Out) {
        let s = self.registry.0.lock().await;
        let named = s.watchers.get(name).into_iter().flatten();
        let all = s.watchers.get(EVERYONE).into_iter().flatten().filter(|id| !s.watchers.get(name).is_some_and(|set| set.contains(id)));
        for id in named.chain(all) {
            if let Some(e) = s.by_id.get(id) {
                let _ = e.tx.send(out.clone());
            }
        }
    }

    /// A frame to the sockets watching one topic (`group:<name>`), and nobody else: not the
    /// home pages, a group's change is not a stream's.
    async fn tell_topic(&self, topic: &str, out: Out) {
        let s = self.registry.0.lock().await;
        for id in s.watchers.get(topic).into_iter().flatten() {
            if let Some(e) = s.by_id.get(id) {
                let _ = e.tx.send(out.clone());
            }
        }
    }

    /// The groups of `name` that somebody here has the room of open. One query, and only when
    /// some socket watches some group at all: a quiet gateway asks postgres nothing.
    async fn watched_groups_of(&self, name: &str) -> Vec<String> {
        let watched: Vec<String> = {
            let s = self.registry.0.lock().await;
            s.watchers.keys().filter_map(|k| group_topic(k)).map(str::to_owned).collect()
        };
        if watched.is_empty() {
            return Vec::new();
        }
        let groups: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
            "SELECT m.group_name FROM memberships m JOIN streamers s ON s.id = m.user_id
             WHERE s.name = $1 AND m.group_name = ANY($2)",
        )
        .bind(name)
        .bind(&watched)
        .fetch_all(&self.db)
        .await;
        match groups {
            Ok(groups) => groups,
            Err(e) => {
                log::warn!("events: cannot read the groups of {name}: {e}");
                Vec::new()
            }
        }
    }

    /// `name` went live or ended: the rooms of its groups show its face (or stop), so each
    /// group's watchers hear it as a `group` frame, `what` `live` or `ended`, `who` the name.
    async fn fan_groups(&self, name: &str, what: &str) {
        for group in self.watched_groups_of(name).await {
            let mut data = serde_json::Map::new();
            data.insert("who".into(), Value::String(name.to_owned()));
            self.tell_topic(&format!("{GROUP_TOPIC}{group}"), Out::Group { group, what: what.to_owned(), data }).await;
        }
    }

    // ---- the registry ------------------------------------------------------------------------

    async fn insert(&self, id: SocketId, tx: mpsc::UnboundedSender<Out>, name: Option<String>) {
        let mut s = self.registry.0.lock().await;
        if let Some(n) = &name {
            s.own.entry(n.clone()).or_default().insert(id);
        }
        s.by_id.insert(id, Entry { tx, name, watching: HashSet::new(), told: HashMap::new(), me: None });
    }

    /// Takes the socket out and says which name it was, at that moment: the one to unmark.
    async fn remove(&self, id: SocketId) -> Option<String> {
        let mut s = self.registry.0.lock().await;
        let e = s.by_id.remove(&id)?;
        if let Some(n) = &e.name {
            if let Some(set) = s.own.get_mut(n) {
                set.remove(&id);
                if set.is_empty() {
                    s.own.remove(n);
                }
            }
        }
        for n in &e.watching {
            if let Some(set) = s.watchers.get_mut(n) {
                set.remove(&id);
                if set.is_empty() {
                    s.watchers.remove(n);
                }
            }
        }
        e.name
    }

    /// The socket's name right now: the hello's, or what a `renamed` fact made it since.
    async fn name_of(&self, id: SocketId) -> Option<String> {
        self.registry.0.lock().await.by_id.get(&id).and_then(|e| e.name.clone())
    }

    /// An account changed its name (docs/ids.md). Its sockets here are the new name from now:
    /// re-keyed in the registry, out of `seen:<old>` and into `seen:<new>` at once (not the 90s
    /// lapse, so the old name reads offline the moment it is nobody's), and told, as are the
    /// old name's watchers (pages on `/watch/<old>`, which move). Then a `me` with the new name.
    async fn renamed(&self, old: &str, new: &str) {
        let frame = Out::Renamed { name: old.to_owned(), to: new.to_owned() };
        let moved: Vec<SocketId> = {
            let mut s = self.registry.0.lock().await;
            let ids: Vec<SocketId> = s.own.remove(old).into_iter().flatten().collect();
            for id in &ids {
                if let Some(e) = s.by_id.get_mut(id) {
                    e.name = Some(new.to_owned());
                    e.me = None; // the next `me` carries the new name, whatever the word
                    let _ = e.tx.send(frame.clone());
                }
            }
            if !ids.is_empty() {
                s.own.entry(new.to_owned()).or_default().extend(ids.iter().copied());
            }
            let watchers: Vec<SocketId> = s.watchers.get(old).into_iter().flatten().copied().collect();
            for id in watchers.into_iter().filter(|id| !ids.contains(id)) {
                if let Some(e) = s.by_id.get(&id) {
                    let _ = e.tx.send(frame.clone());
                }
            }
            ids
        };
        for id in &moved {
            let sid = format!("{}:{id}", self.host);
            self.mark_last(&sid, old).await;
            self.mark_first(&sid, new).await;
        }
        if !moved.is_empty() {
            self.push(new).await;
        }
    }

    /// `watch`: from now on the word of `name` as it changes, and its word right now. `*` is
    /// the home page's topic: every name's `live`, `ended` and `viewers` from now on, no word
    /// (there is none for everyone; the list itself is `GET /api/streams`, the home service's).
    /// `group:<name>` is a room's topic: that group's changes from now on, no word either (the
    /// room itself is `GET /api/groups/:group`, asked once).
    async fn watch(&self, id: SocketId, name: &str) {
        {
            let mut s = self.registry.0.lock().await;
            let Some(e) = s.by_id.get_mut(&id) else { return };
            if !e.watching.insert(name.to_owned()) {
                return;
            }
            s.watchers.entry(name.to_owned()).or_default().insert(id);
        }
        if is_topic(name) {
            return;
        }
        let (word, _) = self.word(name, false).await;
        let mut s = self.registry.0.lock().await;
        if let Some(e) = s.by_id.get_mut(&id) {
            if e.watching.contains(name) && e.told.get(name) != Some(&word) {
                e.told.insert(name.to_owned(), word);
                let _ = e.tx.send(Out::Presence { name: name.to_owned(), presence: word });
            }
        }
    }

    async fn unwatch(&self, id: SocketId, name: &str) {
        let mut s = self.registry.0.lock().await;
        let Some(e) = s.by_id.get_mut(&id) else { return };
        if !e.watching.remove(name) {
            return;
        }
        e.told.remove(name);
        if let Some(set) = s.watchers.get_mut(name) {
            set.remove(&id);
            if set.is_empty() {
                s.watchers.remove(name);
            }
        }
    }

    /// The `me` for a named socket, right after hello and whenever it changes.
    async fn tell_me(&self, id: SocketId, name: &str) {
        let (word, status) = self.word(name, true).await;
        let mut s = self.registry.0.lock().await;
        if let Some(e) = s.by_id.get_mut(&id) {
            if e.me != Some((word, status)) {
                e.me = Some((word, status));
                let _ = e.tx.send(Out::Me { name: Some(name.to_owned()), presence: word, status });
            }
        }
    }

    // ---- the stream ----------------------------------------------------------------------------

    /// One entry of `events`, routed. Unknown types are dropped, like unknown frames.
    async fn deliver(&self, entry: StreamId) {
        let (Some(kind), Some(name)): (Option<String>, Option<String>) = (entry.get("type"), entry.get("name")) else { return };
        match kind.as_str() {
            "live" => {
                let since: i64 = entry.get("since").unwrap_or(0);
                // the card as the api wrote it, json in one field; an older api wrote none
                let card = entry
                    .get::<String>("card")
                    .and_then(|card| serde_json::from_str::<Value>(&card).ok())
                    .and_then(|card| match card {
                        Value::Object(map) => Some(map),
                        _ => None,
                    })
                    .unwrap_or_default();
                self.fan(&name, Out::Live { name: name.clone(), since, card }).await;
                self.push(&name).await;
                self.fan_groups(&name, "live").await;
            }
            "ended" => {
                self.fan(&name, Out::Ended { name: name.clone() }).await;
                self.push(&name).await;
                self.fan_groups(&name, "ended").await;
            }
            "viewers" => {
                if let Some(viewers) = entry.get::<usize>("viewers") {
                    self.fan(&name, Out::Viewers { name: name.clone(), viewers }).await;
                }
            }
            "status" | "seen" => self.push(&name).await,
            "renamed" => {
                let to: Option<String> = entry.get("to");
                if let Some(to) = to.filter(|to| valid_name(to) && *to != name) {
                    self.renamed(&name, &to).await;
                }
            }
            // a direct message: `name` is who it is to. both names' own sockets, so the writer's other devices hear it too
            "dm" => {
                let (Some(from), Some(id), Some(text)): (Option<String>, Option<i64>, Option<String>) = (entry.get("from"), entry.get("id"), entry.get("text")) else { return };
                let at: i64 = entry.get("at").unwrap_or(0);
                let from_id: Option<String> = entry.get("from_id").filter(|id: &String| !id.is_empty());
                self.tell(&[&from, &name], Out::Dm { id, from: from.clone(), to: name.clone(), text, at, from_id }).await;
            }
            // `name` read a thread somewhere: its other devices drop their count
            "dm_read" => {
                let (Some(peer), Some(id)): (Option<String>, Option<i64>) = (entry.get("peer"), entry.get("id")) else { return };
                let peer_id: Option<String> = entry.get("peer_id").filter(|id: &String| !id.is_empty());
                self.tell(&[&name], Out::DmRead { name: name.clone(), peer, id, peer_id }).await;
            }
            // a notification (docs/notifications.md): `name` is who did it, `to` the logins it reached
            // and their row ids. one frame per login, to that login's own sockets
            "notify" => {
                let (Some(kind), Some(to)): (Option<String>, Option<String>) = (entry.get("kind"), entry.get("to")) else { return };
                let Ok(Value::Object(to)) = serde_json::from_str::<Value>(&to) else { return };
                let at: i64 = entry.get("at").unwrap_or(0);
                let text: String = entry.get("text").unwrap_or_default();
                let verified = entry.get::<i64>("verified") == Some(1);
                let avatar: Option<i64> = entry.get("avatar");
                let session: Option<i64> = entry.get("session");
                let actor: Option<String> = entry.get("actor").filter(|id: &String| !id.is_empty());
                for (login, id) in to {
                    let Some(id) = id.as_i64() else { continue };
                    let frame = Out::Notification { id, kind: kind.clone(), name: name.clone(), verified, avatar, at, text: text.clone(), session, actor: actor.clone() };
                    self.tell(&[&login], frame).await;
                }
            }
            // `name` saw its inbox somewhere: its other devices drop their count
            "notify_read" => {
                let Some(id): Option<i64> = entry.get("id") else { return };
                self.tell(&[&name], Out::NotifyRead { name: name.clone(), id }).await;
            }
            // a group changed (docs/groups.md): `name` is the group, `data` the change as json,
            // forwarded whole to whoever has the room open
            "group" => {
                let Some(what): Option<String> = entry.get("what") else { return };
                let data = entry
                    .get::<String>("data")
                    .and_then(|data| serde_json::from_str::<Value>(&data).ok())
                    .and_then(|data| match data {
                        Value::Object(map) => Some(map),
                        _ => None,
                    })
                    .unwrap_or_default();
                self.tell_topic(&format!("{GROUP_TOPIC}{name}"), Out::Group { group: name.clone(), what, data }).await;
            }
            other => log::debug!("events: unknown entry type {other}"),
        }
    }
}

// ---- the routes ----------------------------------------------------------------------------

pub(crate) fn routes(g: Gateway) -> Router {
    Router::new().route("/events", get(ws)).route("/online", get(online)).with_state(g)
}

/// The login cookie came with the handshake; `handle` reads it. Not the `Me` extractor: a
/// database error would be a 500 before the upgrade, and a nameless socket may still watch.
async fn ws(State(g): State<Gateway>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(g, headers, socket))
}

/// `{ "<name>": <open sockets in this process> }`, like video's `GET /live`. Inside the compose
/// network only (no caddy route); the tests read it locally, the truth for everyone else is
/// `presence` on `GET /api/streamers/:name`.
async fn online(State(g): State<Gateway>) -> Json<Value> {
    let s = g.registry.0.lock().await;
    let mut names: Vec<(&String, usize)> = s.own.iter().map(|(n, set)| (n, set.len())).collect();
    names.sort();
    Json(Value::Object(names.into_iter().map(|(n, count)| (n.clone(), json!(count))).collect()))
}

/// A guest's nick to the name it would be, the chat's way: cut to 24, letters digits `_` `-`,
/// then lowercased, so the two sockets of one browser land on the same name. No nick, or a
/// blank one, is nobody. Pure: `identify` adds the one check that needs the database.
fn guest_name(nick: Option<&str>, dummy_prefix: &str) -> Result<Option<String>, Refused> {
    let Some(nick) = nick.map(clean_nick).filter(|n| !n.is_empty()) else { return Ok(None) };
    if !valid_nick(&nick) {
        return Err(Refused("bad nick. 1 to 24 letters, digits, _ -"));
    }
    let name = nick.to_lowercase();
    if name.starts_with(dummy_prefix) {
        return Err(Refused("that nick belongs to the fake streams. pick another"));
    }
    Ok(Some(name))
}

/// Who the socket is: the cookie's login; else the nick cleaned the chat's way and lowercased,
/// when it is a name nobody owns; else nobody (a hello with neither, or a database that did not
/// answer: admitted, it may still watch, it marks nothing). A claimed or reserved nick is
/// refused outright, in the chat's words: wearing somebody's name would be a lie.
async fn identify(g: &Gateway, headers: &HeaderMap, nick: Option<&str>) -> Result<Option<String>, Refused> {
    match whoami(&g.db, headers).await {
        Ok(Some(me)) => return Ok(Some(me.name)),
        Ok(None) => {}
        Err(e) => {
            log::warn!("events: cannot read the login: {e}");
            return Ok(None);
        }
    }
    let Some(name) = guest_name(nick, &g.dummy_prefix)? else { return Ok(None) };
    match is_claimed(&g.db, &name).await {
        Ok(false) => Ok(Some(name)),
        Ok(true) => Err(Refused(NICK_HAS_ACCOUNT)),
        Err(e) => {
            // fail closed: with the database down a claimed name must not be wearable
            log::warn!("events: cannot check whether {name} is claimed: {e}");
            Ok(None)
        }
    }
}

async fn handle(g: Gateway, headers: HeaderMap, mut socket: WebSocket) {
    // 1. hello: who is here
    let Some(first) = first_text(&mut socket).await else { return };
    let Ok(In::Hello { nick }) = serde_json::from_str::<In>(&first) else {
        let _ = send(&mut socket, &Out::Error { error: "say hello first" }).await;
        return;
    };
    let name = match identify(&g, &headers, nick.as_deref()).await {
        Ok(name) => name,
        Err(Refused(why)) => {
            let _ = send(&mut socket, &Out::Error { error: why }).await;
            return;
        }
    };

    // 2. in the registry, in redis, and told who it is
    let id = g.next.fetch_add(1, Ordering::Relaxed);
    let sid = format!("{}:{id}", g.host);
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    g.insert(id, tx, name.clone()).await;
    match &name {
        Some(n) => {
            g.mark_first(&sid, n).await;
            g.tell_me(id, n).await;
        }
        None => {
            if send(&mut socket, &Out::Me { name: None, presence: Presence::Offline, status: Status::default() }).await.is_err() {
                g.remove(id).await;
                return;
            }
        }
    }
    log::info!("events: {} joined", name.as_deref().unwrap_or("nobody"));
    // from here the name is the registry's: a `renamed` fact may change it under the socket
    let named = name.is_some();
    drop(name);

    // 3. the loop: frames out, watch/unwatch in, a ping now and then that also keeps the name here
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // the first tick is immediate
    let mut shutdown = g.shutdown.clone();
    let refresh = g.refresh.clone();
    let mut going = false;
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(out) => if send(&mut socket, &out).await.is_err() { break; },
                None => break,
            },
            incoming = socket.recv() => {
                last_heard = Instant::now();
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => continue,
                };
                // unknown frames are dropped, on both sides (docs/transition.md)
                match serde_json::from_str::<In>(&text) {
                    Ok(In::Watch { name: n }) => {
                        let n = n.trim().to_lowercase();
                        if n == EVERYONE || valid_name(&n) || group_topic(&n).is_some() { g.watch(id, &n).await; }
                    }
                    Ok(In::Unwatch { name: n }) => g.unwatch(id, &n.trim().to_lowercase()).await,
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > IDLE_LIMIT {
                    log::info!("events: {} went silent, dropping", g.name_of(id).await.as_deref().unwrap_or("nobody"));
                    break;
                }
                if !matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Ping(Bytes::new()))).await, Ok(Ok(()))) { break; }
                if named { if let Some(n) = g.name_of(id).await { g.touch(&sid, &n).await; } }
            }
            _ = refresh.notified() => {
                if named { if let Some(n) = g.name_of(id).await { g.touch(&sid, &n).await; } }
            }
            _ = shutdown.changed() => {
                going = true;
                let goodbye = Message::Close(Some(CloseFrame { code: 1001, reason: "events restarting".into() }));
                let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(goodbye)).await;
                break;
            }
        }
    }

    let name = g.remove(id).await;
    // on SIGTERM the member is left to go stale: the browser is back with a new one in ~3s,
    // and an unmark here would flicker every name offline and online on every deploy
    if let Some(n) = &name {
        if !going {
            g.mark_last(&sid, n).await;
        }
    }
    log::info!("events: {} left", name.as_deref().unwrap_or("nobody"));
}

/// One tail of `events` per process, on its own connection. Starts REPLAY_MS back, continues
/// from the last id across redis blips, and when redis is back tells every socket to re-mark.
async fn tail(g: Gateway) {
    let config = crate::socket::blocking_config(READ_BLOCK_MS);
    let mut last = format!("{}-0", presence::now_ms() - REPLAY_MS);
    loop {
        if *g.shutdown.borrow() {
            return;
        }
        let mut con = match g.client.get_multiplexed_async_connection_with_config(&config).await {
            Ok(con) => con,
            Err(e) => {
                log::warn!("events: redis: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        // redis is here (again): every open socket marks its name now, not at its next tick
        g.refresh.notify_waiters();
        let options = StreamReadOptions::default().block(READ_BLOCK_MS).count(100);
        loop {
            if *g.shutdown.borrow() {
                return;
            }
            let reply: Option<StreamReadReply> = match con.xread_options(&[EVENTS_KEY], &[&last], &options).await {
                Ok(reply) => reply,
                Err(e) => {
                    log::warn!("events: xread: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    break;
                }
            };
            let Some(reply) = reply else { continue };
            for stream in reply.keys {
                for entry in stream.ids {
                    last = entry.id.clone();
                    g.deliver(entry).await;
                }
            }
        }
    }
}

/// Every RECHECK_EVERY, the word of every name somebody here is or watches, pushed on change.
async fn recheck(g: Gateway) {
    let mut tick = tokio::time::interval(RECHECK_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tick.tick().await;
        if *g.shutdown.borrow() {
            return;
        }
        let names: Vec<String> = {
            let s = g.registry.0.lock().await;
            s.watchers.keys().filter(|n| !is_topic(n)).chain(s.own.keys()).cloned().collect::<HashSet<_>>().into_iter().collect()
        };
        for name in names {
            g.push(&name).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pure half of `identify`, with a refusal as its text.
    fn named(nick: Option<&str>) -> Result<Option<String>, &'static str> {
        guest_name(nick, "dummy-").map_err(|Refused(why)| why)
    }

    /// The gateway used to keep a nick of up to 32 characters (the stream-name rule) while
    /// the chat cuts it to 24: one browser, two names. Both sockets now compute the same one.
    #[test]
    fn a_guest_nick_is_cleaned_the_chats_way() {
        let long = "A".repeat(30);
        assert_eq!(named(Some(&long)), Ok(Some("a".repeat(24))));
        assert_eq!(named(Some(&long)), Ok(Some(clean_nick(&long).to_lowercase())));
        let full = "AbCdEfGhIjKlMnOpQrStUv_-";
        assert_eq!(full.chars().count(), 24);
        assert_eq!(named(Some(full)), Ok(Some(full.to_lowercase())));
        assert_eq!(named(Some("bad nick!")), Err("bad nick. 1 to 24 letters, digits, _ -"));
        assert_eq!(named(Some("   ")), Ok(None));
        assert_eq!(named(None), Ok(None));
        assert_eq!(named(Some("Dummy-x")), Err("that nick belongs to the fake streams. pick another"));
    }

    /// A room watches `group:<name>`: a topic like `*`, never a name, never given a word.
    #[test]
    fn a_group_topic_is_not_a_name() {
        assert_eq!(group_topic("group:gaming-0042"), Some("gaming-0042"));
        assert_eq!(group_topic("group:"), None);
        assert_eq!(group_topic("group:Has Space"), None);
        assert_eq!(group_topic("gaming-0042"), None);
        assert!(is_topic("*"));
        assert!(is_topic("group:gaming-0042"));
        assert!(!is_topic("billy"));
        assert!(!valid_name("group:gaming-0042"));
    }

    /// The change rides whole: the api's json spread into the frame beside `group` and `what`.
    #[test]
    fn a_group_frame_spreads_the_change() {
        let mut data = serde_json::Map::new();
        data.insert("who".into(), Value::String("alice".into()));
        data.insert("members".into(), Value::from(3));
        let text = serde_json::to_string(&Out::Group { group: "vip-0001".into(), what: "joined".into(), data }).unwrap();
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back["type"], "group");
        assert_eq!(back["group"], "vip-0001");
        assert_eq!(back["what"], "joined");
        assert_eq!(back["who"], "alice");
        assert_eq!(back["members"], 3);
    }
}
