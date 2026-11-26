use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use crate::timings::Redis;
use redis::streams::{StreamId, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::{mpsc, watch, Mutex, Notify};
use uuid::Uuid;

use crate::auth::{is_claimed, whoami, NICK_HAS_ACCOUNT};
use crate::chat::{clean_nick, valid_nick};
use crate::presence::{self, Presence, Status, EVENTS_KEEP, EVENTS_KEY, SEEN_TTL_SECS, SEEN_WINDOW_MS};
use crate::socket::{first_text, frame_of, locked, ping, send, send_frame, Beat, Heartbeat, IpSlots, DRAIN_LIMIT, MAX_FRAME_BYTES, READ_BLOCK_MS, SEND_TIMEOUT};
use crate::{live_key, valid_name};

const REPLAY_MS: i64 = 10_000;
const RECHECK_EVERY: Duration = Duration::from_secs(30);
const EVERYONE: &str = "*";
const MAX_SOCKETS_PER_IP: usize = 20;
pub(crate) const OUT_QUEUE: usize = 1024;
const MAX_WATCHES: usize = 1000;
const MAX_WATCH_FRAMES_PER_MIN: u32 = 2000;
const GROUP_TOPIC: &str = "group:";

fn group_topic(watch: &str) -> Option<&str> {
    watch.strip_prefix(GROUP_TOPIC).filter(|name| valid_name(name))
}

fn is_topic(watch: &str) -> bool {
    watch == EVERYONE || watch.starts_with(GROUP_TOPIC)
}

type SocketId = u64;

struct GroupGate {
    public: bool,
    adult: bool,
    members: Vec<Uuid>,
}

fn may_watch(gate: Option<&GroupGate>, account: Option<Uuid>, admins: &[Uuid]) -> bool {
    let Some(g) = gate else { return false };
    match account {
        Some(id) => crate::moderate::sees_group(g.public, g.adult, g.members.contains(&id), admins.contains(&id)),
        None => crate::moderate::roster_public(g.public, g.adult),
    }
}

fn regate_around(what: &str) -> (bool, bool) {
    match what {
        "access" | "adult" | "joined" => (true, false),
        "left" | "banned" | "deleted" => (false, true),
        _ => (false, false),
    }
}

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
    redis: Redis,
    client: redis::Client,
    shutdown: watch::Receiver<bool>,
    dummy_prefix: String,
    host: Arc<str>,
    next: Arc<AtomicU64>,
    registry: Registry,
    refresh: Arc<Notify>,
    per_ip: IpSlots,
    admins: Arc<[Uuid]>,
    gate: Arc<Mutex<()>>,
    leaves: mpsc::UnboundedSender<Left>,
}

type Left = (String, String);

#[derive(Clone, Default)]
pub(crate) struct Registry(Arc<std::sync::Mutex<Sockets>>);

pub(crate) struct Seat {
    registry: Registry,
    leaves: mpsc::UnboundedSender<Left>,
    id: SocketId,
    sid: String,
    going: bool,
}

impl Seat {
    pub(crate) fn restarting(&mut self) {
        self.going = true;
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let name = self.registry.remove(self.id);
        if let (Some(name), false) = (name, self.going) {
            let _ = self.leaves.send((std::mem::take(&mut self.sid), name));
        }
    }
}

#[derive(Default)]
struct Sockets {
    by_id: HashMap<SocketId, Entry>,
    own: HashMap<String, HashSet<SocketId>>,
    watchers: HashMap<String, HashSet<SocketId>>,
}

struct Entry {
    tx: mpsc::Sender<Frame>,
    kick: Arc<Notify>,
    name: Option<String>,
    account: Option<Uuid>,
    watching: HashSet<String>,
    told: HashMap<String, Presence>,
    me: Option<(Presence, Status)>,
}

pub(crate) type Frame = Utf8Bytes;

impl Entry {
    fn put(&self, out: Out) {
        self.put_frame(frame_of(&out));
    }

    fn put_frame(&self, f: Frame) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(f) {
            self.kick.notify_one();
        }
    }
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
    Live {
        name: String,
        since: i64,
        #[serde(flatten)]
        card: serde_json::Map<String, Value>,
    },
    Ended { name: String },
    Viewers { name: String, viewers: usize },
    Renamed { name: String, to: String },
    Dm {
        id: i64,
        from: String,
        to: String,
        text: String,
        at: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        from_id: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        video: Option<crate::chat::Video>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Value>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        mentions: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        call: Option<Value>,
    },
    #[serde(rename = "dm_react")]
    DmReact { id: i64, from: String, to: String, emoji: String, on: bool },
    #[serde(rename = "dm_read")]
    DmRead {
        name: String,
        peer: String,
        id: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
    },
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
        #[serde(skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    #[serde(rename = "notify_read")]
    NotifyRead { name: String, id: i64 },
    #[serde(rename = "notify_removed")]
    NotifyRemoved { name: String, id: i64 },
    #[serde(rename = "chat_read")]
    ChatRead { name: String, room: String },
    Group {
        group: String,
        what: String,
        #[serde(flatten)]
        data: serde_json::Map<String, Value>,
    },
    Call {
        caller: String,
        callee: String,
        what: String,
        #[serde(flatten)]
        data: serde_json::Map<String, Value>,
    },
    Error { error: &'static str },
}

struct Refused(&'static str);

impl Registry {
    fn lock(&self) -> std::sync::MutexGuard<'_, Sockets> {
        locked(&self.0)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.lock().by_id.is_empty()
    }

    fn insert(&self, id: SocketId, tx: mpsc::Sender<Frame>, kick: Arc<Notify>, name: Option<String>, account: Option<Uuid>) {
        let mut s = self.lock();
        if let Some(n) = &name {
            s.own.entry(n.clone()).or_default().insert(id);
        }
        s.by_id.insert(id, Entry { tx, kick, name, account, watching: HashSet::new(), told: HashMap::new(), me: None });
    }

    fn remove(&self, id: SocketId) -> Option<String> {
        let mut s = self.lock();
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
}

pub(crate) async fn run(db: PgPool, redis_url: &str, port: u16) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let redis = crate::connect_redis(redis_url).await;
    let (stop, shutdown) = watch::channel(false);
    let dummy_prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let limits = crate::ratelimit::ByIp { redis: redis.clone(), rule: crate::ratelimit::events_rule };
    let admin_names: Vec<String> = std::env::var("ADMIN_NAMES")
        .unwrap_or_default()
        .split(',')
        .map(|n| n.trim().to_lowercase())
        .filter(|n| valid_name(n))
        .collect();
    let admins: Vec<Uuid> = crate::debug::admins_with_accounts(&db, admin_names).await?.into_iter().map(|a| a.id).collect();
    let gateway = Gateway::new(db, redis, client, shutdown, dummy_prefix, admins);
    let sockets = gateway.registry();

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(routes(gateway))
        .route_layer(axum::middleware::from_fn_with_state(limits, crate::ratelimit::by_ip))
        .layer(axum::middleware::from_fn(crate::timings::http));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("events on {addr}");
    crate::timings::serve();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            crate::wait_for_signal().await;
            let _ = stop.send(true);
        })
        .await?;
    let deadline = Instant::now() + DRAIN_LIMIT;
    while !sockets.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

impl Gateway {
    pub(crate) fn new(db: PgPool, redis: Redis, client: redis::Client, shutdown: watch::Receiver<bool>, dummy_prefix: String, admins: Vec<Uuid>) -> Self {
        let host = std::env::var("HOSTNAME").ok().filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "events".into());
        let (leaves, left) = mpsc::unbounded_channel();
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
            per_ip: IpSlots::new(MAX_SOCKETS_PER_IP),
            admins: admins.into(),
            gate: Arc::default(),
            leaves,
        };
        tokio::spawn(tail(g.clone()));
        tokio::spawn(recheck(g.clone()));
        tokio::spawn(unmark(g.clone(), left));
        g
    }

    fn seat(&self, id: SocketId, sid: String, tx: mpsc::Sender<Frame>, kick: Arc<Notify>, name: Option<String>, account: Option<Uuid>) -> Seat {
        self.registry.insert(id, tx, kick, name, account);
        Seat { registry: self.registry.clone(), leaves: self.leaves.clone(), id, sid, going: false }
    }

    pub(crate) async fn sit(&self, tx: mpsc::Sender<Frame>, kick: Arc<Notify>, name: Option<String>, account: Option<Uuid>) -> Seat {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let sid = format!("{}:{id}", self.host);
        let seat = self.seat(id, sid.clone(), tx, kick, name.clone(), account);
        self.announce(id, &sid, name.as_deref()).await;
        seat
    }

    async fn announce(&self, id: SocketId, sid: &str, name: Option<&str>) {
        match name {
            Some(n) => {
                self.mark_first(sid, n).await;
                self.tell_me(id, n).await;
            }
            None => {
                if let Some(e) = self.registry.lock().by_id.get(&id) {
                    e.put(Out::Me { name: None, presence: Presence::Offline, status: Status::default() });
                }
            }
        }
    }

    pub(crate) async fn reseat(&self, seat: &Seat, name: Option<String>, account: Option<Uuid>) {
        let id = seat.id;
        let (old, groups) = {
            let mut s = self.registry.lock();
            let Some(e) = s.by_id.get_mut(&id) else { return };
            let old = std::mem::replace(&mut e.name, name.clone());
            e.account = account;
            e.me = None;
            let groups: Vec<String> = e.watching.iter().filter_map(|w| group_topic(w)).map(str::to_owned).collect();
            if let Some(o) = &old {
                if let Some(set) = s.own.get_mut(o) {
                    set.remove(&id);
                    if set.is_empty() {
                        s.own.remove(o);
                    }
                }
            }
            if let Some(n) = &name {
                s.own.entry(n.clone()).or_default().insert(id);
            }
            (old, groups)
        };
        if let Some(o) = old.as_deref().filter(|o| Some(*o) != name.as_deref()) {
            self.mark_last(&seat.sid, o).await;
        }
        self.announce(id, &seat.sid, name.as_deref()).await;
        for group in groups {
            self.regate(&group, Some(id)).await;
        }
    }

    pub(crate) async fn retell(&self, seat: &Seat) {
        let (names, me) = {
            let mut s = self.registry.lock();
            let Some(e) = s.by_id.get_mut(&seat.id) else { return };
            e.told.clear();
            e.me = None;
            let names: Vec<String> = e.watching.iter().filter(|w| !is_topic(w)).cloned().collect();
            (names, e.name.clone())
        };
        self.announce(seat.id, &seat.sid, me.as_deref()).await;
        for name in names {
            self.tell_word(seat.id, &name).await;
        }
    }

    pub(crate) async fn keep_alive(&self, seat: &Seat) {
        if let Some(n) = self.name_of(seat.id).await {
            self.touch(&seat.sid, &n).await;
        }
    }

    pub(crate) fn admitted(&self, seat: &Seat, key: &str) -> bool {
        self.registry.lock().watchers.get(key).is_some_and(|set| set.contains(&seat.id))
    }

    pub(crate) fn refreshes(&self) -> Arc<Notify> {
        self.refresh.clone()
    }

    pub(crate) async fn subscribe(&self, seat: &Seat, key: &str) {
        self.watch(seat.id, key).await;
    }

    pub(crate) async fn unsubscribe(&self, seat: &Seat, key: &str) {
        self.unwatch(seat.id, key).await;
    }

    pub(crate) async fn identity(&self, me: Result<Option<crate::auth::Account>, ()>, nick: Option<&str>) -> Result<(Option<String>, Option<Uuid>), &'static str> {
        identify_as(self, me, nick).await.map_err(|Refused(why)| why)
    }

    pub(crate) fn registry(&self) -> Registry {
        self.registry.clone()
    }

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

    async fn push(&self, name: &str) {
        let (word, status) = self.word(name, true).await;
        let mut s = self.registry.lock();
        let watchers: Vec<SocketId> = s.watchers.get(name).into_iter().flatten().copied().collect();
        let own: Vec<SocketId> = s.own.get(name).into_iter().flatten().copied().collect();
        for id in watchers {
            if let Some(e) = s.by_id.get_mut(&id) {
                if e.told.get(name) != Some(&word) {
                    e.told.insert(name.to_owned(), word);
                    e.put(Out::Presence { name: name.to_owned(), presence: word });
                }
            }
        }
        for id in own {
            if let Some(e) = s.by_id.get_mut(&id) {
                if e.me != Some((word, status)) {
                    e.me = Some((word, status));
                    e.put(Out::Me { name: Some(name.to_owned()), presence: word, status });
                }
            }
        }
    }

    async fn tell(&self, names: &[&str], out: Out) {
        let f = frame_of(&out);
        let s = self.registry.lock();
        let mut told: HashSet<SocketId> = HashSet::new();
        for name in names {
            for id in s.own.get(*name).into_iter().flatten() {
                if told.insert(*id) {
                    if let Some(e) = s.by_id.get(id) {
                        e.put_frame(f.clone());
                    }
                }
            }
        }
    }

    async fn fan(&self, name: &str, out: Out) {
        let f = frame_of(&out);
        let s = self.registry.lock();
        let named = s.watchers.get(name).into_iter().flatten();
        let all = s.watchers.get(EVERYONE).into_iter().flatten().filter(|id| !s.watchers.get(name).is_some_and(|set| set.contains(id)));
        for id in named.chain(all) {
            if let Some(e) = s.by_id.get(id) {
                e.put_frame(f.clone());
            }
        }
    }

    async fn tell_topic(&self, topic: &str, out: Out) {
        let f = frame_of(&out);
        let s = self.registry.lock();
        for id in s.watchers.get(topic).into_iter().flatten() {
            if let Some(e) = s.by_id.get(id) {
                e.put_frame(f.clone());
            }
        }
    }

    async fn watched_groups_of(&self, name: &str) -> Vec<String> {
        let watched: Vec<String> = {
            let s = self.registry.lock();
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

    async fn fan_groups(&self, name: &str, what: &str) {
        for group in self.watched_groups_of(name).await {
            let mut data = serde_json::Map::new();
            data.insert("who".into(), Value::String(name.to_owned()));
            self.tell_topic(&format!("{GROUP_TOPIC}{group}"), Out::Group { group, what: what.to_owned(), data }).await;
        }
    }

    async fn group_gate(&self, group: &str, accounts: &[Uuid]) -> Option<GroupGate> {
        let row: Result<Option<(bool, bool, Vec<Uuid>)>, sqlx::Error> = sqlx::query_as(
            "SELECT g.public, g.adult_content,
                    ARRAY(SELECT m.user_id FROM memberships m WHERE m.group_name = g.name AND m.user_id = ANY($2))
             FROM groups g WHERE g.name = $1",
        )
        .bind(group)
        .bind(accounts)
        .fetch_optional(&self.db)
        .await;
        match row {
            Ok(row) => row.map(|(public, adult, members)| GroupGate { public, adult, members }),
            Err(e) => {
                log::warn!("events: cannot read who may watch {group}: {e}");
                None
            }
        }
    }

    async fn regate(&self, group: &str, only: Option<SocketId>) {
        let _gate = self.gate.lock().await;
        let topic = format!("{GROUP_TOPIC}{group}");
        let wanting: Vec<(SocketId, Option<Uuid>)> = {
            let s = self.registry.lock();
            match only {
                Some(id) => s.by_id.get(&id).filter(|e| e.watching.contains(&topic)).map(|e| (id, e.account)).into_iter().collect(),
                None => s.by_id.iter().filter(|(_, e)| e.watching.contains(&topic)).map(|(id, e)| (*id, e.account)).collect(),
            }
        };
        if wanting.is_empty() {
            return;
        }
        let accounts: Vec<Uuid> = wanting.iter().filter_map(|(_, a)| *a).collect::<HashSet<_>>().into_iter().collect();
        let gate = self.group_gate(group, &accounts).await;
        let mut s = self.registry.lock();
        for (id, account) in wanting {
            let still = s.by_id.get(&id).is_some_and(|e| e.watching.contains(&topic));
            if still && may_watch(gate.as_ref(), account, &self.admins) {
                s.watchers.entry(topic.clone()).or_default().insert(id);
            } else if let Some(set) = s.watchers.get_mut(&topic) {
                set.remove(&id);
                if set.is_empty() {
                    s.watchers.remove(&topic);
                }
            }
        }
    }

    async fn name_of(&self, id: SocketId) -> Option<String> {
        self.registry.lock().by_id.get(&id).and_then(|e| e.name.clone())
    }

    async fn renamed(&self, old: &str, new: &str) {
        let f = frame_of(&Out::Renamed { name: old.to_owned(), to: new.to_owned() });
        let moved: Vec<SocketId> = {
            let mut s = self.registry.lock();
            let ids: Vec<SocketId> = s.own.remove(old).into_iter().flatten().collect();
            for id in &ids {
                if let Some(e) = s.by_id.get_mut(id) {
                    e.name = Some(new.to_owned());
                    e.me = None;
                    e.put_frame(f.clone());
                }
            }
            if !ids.is_empty() {
                s.own.entry(new.to_owned()).or_default().extend(ids.iter().copied());
            }
            let watchers: Vec<SocketId> = s.watchers.get(old).into_iter().flatten().copied().collect();
            for id in watchers.into_iter().filter(|id| !ids.contains(id)) {
                if let Some(e) = s.by_id.get(&id) {
                    e.put_frame(f.clone());
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

    async fn watch(&self, id: SocketId, name: &str) {
        let group = group_topic(name);
        {
            let mut s = self.registry.lock();
            let Some(e) = s.by_id.get_mut(&id) else { return };
            if !e.watching.contains(name) && e.watching.len() >= MAX_WATCHES {
                return;
            }
            if !e.watching.insert(name.to_owned()) {
                return;
            }
            if group.is_none() {
                s.watchers.entry(name.to_owned()).or_default().insert(id);
            }
        }
        if let Some(group) = group {
            self.regate(group, Some(id)).await;
            return;
        }
        if is_topic(name) {
            return;
        }
        self.tell_word(id, name).await;
    }

    async fn tell_word(&self, id: SocketId, name: &str) {
        let (word, _) = self.word(name, false).await;
        let mut s = self.registry.lock();
        if let Some(e) = s.by_id.get_mut(&id) {
            if e.watching.contains(name) && e.told.get(name) != Some(&word) {
                e.told.insert(name.to_owned(), word);
                e.put(Out::Presence { name: name.to_owned(), presence: word });
            }
        }
    }

    async fn unwatch(&self, id: SocketId, name: &str) {
        let mut s = self.registry.lock();
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

    async fn tell_me(&self, id: SocketId, name: &str) {
        let (word, status) = self.word(name, true).await;
        let mut s = self.registry.lock();
        if let Some(e) = s.by_id.get_mut(&id) {
            if e.me != Some((word, status)) {
                e.me = Some((word, status));
                e.put(Out::Me { name: Some(name.to_owned()), presence: word, status });
            }
        }
    }

    async fn deliver(&self, entry: StreamId) {
        let (Some(kind), Some(name)): (Option<String>, Option<String>) = (entry.get("type"), entry.get("name")) else { return };
        match kind.as_str() {
            "live" => {
                let since: i64 = entry.get("since").unwrap_or(0);
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
            "dm" => {
                let (Some(from), Some(id), Some(text)): (Option<String>, Option<i64>, Option<String>) = (entry.get("from"), entry.get("id"), entry.get("text")) else { return };
                let at: i64 = entry.get("at").unwrap_or(0);
                let from_id: Option<String> = entry.get("from_id").filter(|id: &String| !id.is_empty());
                let images = crate::chat::split_pictures(entry.get("images"));
                let video = crate::chat::Video::parse(entry.get::<String>("video").as_deref());
                let reply: Option<Value> = entry.get::<String>("reply").and_then(|r| serde_json::from_str(&r).ok());
                let mentions = crate::mentions::from_field(entry.get("mentions"));
                let call: Option<Value> = entry.get::<String>("call").and_then(|c| serde_json::from_str(&c).ok());
                self.tell(&[&from, &name], Out::Dm { id, from: from.clone(), to: name.clone(), text, at, from_id, images, video, reply, mentions, call }).await;
            }
            "dm_react" => {
                let (Some(from), Some(id), Some(emoji)): (Option<String>, Option<i64>, Option<String>) = (entry.get("from"), entry.get("id"), entry.get("emoji")) else { return };
                let on = entry.get::<String>("on").as_deref() == Some("1");
                self.tell(&[&from, &name], Out::DmReact { id, from: from.clone(), to: name.clone(), emoji, on }).await;
            }
            "dm_read" => {
                let (Some(peer), Some(id)): (Option<String>, Option<i64>) = (entry.get("peer"), entry.get("id")) else { return };
                let peer_id: Option<String> = entry.get("peer_id").filter(|id: &String| !id.is_empty());
                self.tell(&[&name], Out::DmRead { name: name.clone(), peer, id, peer_id }).await;
            }
            "notify" => {
                let (Some(kind), Some(to)): (Option<String>, Option<String>) = (entry.get("kind"), entry.get("to")) else { return };
                let Ok(Value::Object(to)) = serde_json::from_str::<Value>(&to) else { return };
                let at: i64 = entry.get("at").unwrap_or(0);
                let text: String = entry.get("text").unwrap_or_default();
                let verified = entry.get::<i64>("verified") == Some(1);
                let avatar: Option<i64> = entry.get("avatar");
                let session: Option<i64> = entry.get("session");
                let actor: Option<String> = entry.get("actor").filter(|id: &String| !id.is_empty());
                let room: Option<String> = entry.get("room").filter(|room: &String| !room.is_empty());
                for (login, id) in to {
                    let Some(id) = id.as_i64() else { continue };
                    let frame = Out::Notification {
                        id,
                        kind: kind.clone(),
                        name: name.clone(),
                        verified,
                        avatar,
                        at,
                        text: text.clone(),
                        session,
                        actor: actor.clone(),
                        room: room.clone(),
                    };
                    self.tell(&[&login], frame).await;
                }
            }
            "notify_read" => {
                let Some(id): Option<i64> = entry.get("id") else { return };
                self.tell(&[&name], Out::NotifyRead { name: name.clone(), id }).await;
            }
            "notify_removed" => {
                let Some(id): Option<i64> = entry.get("id") else { return };
                self.tell(&[&name], Out::NotifyRemoved { name: name.clone(), id }).await;
            }
            "chat_read" => {
                let Some(room): Option<String> = entry.get("room") else { return };
                self.tell(&[&name], Out::ChatRead { name: name.clone(), room }).await;
            }
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
                let (before, after) = regate_around(&what);
                if before {
                    self.regate(&name, None).await;
                }
                self.tell_topic(&format!("{GROUP_TOPIC}{name}"), Out::Group { group: name.clone(), what, data }).await;
                if after {
                    self.regate(&name, None).await;
                }
            }
            "call" => {
                let (Some(caller), Some(what)): (Option<String>, Option<String>) = (entry.get("caller"), entry.get("what")) else { return };
                let Some(data) = entry.get::<String>("data").and_then(|data| match serde_json::from_str::<Value>(&data) {
                    Ok(Value::Object(map)) => Some(map),
                    _ => None,
                }) else {
                    return;
                };
                self.tell(&[&caller, &name], Out::Call { caller: caller.clone(), callee: name.clone(), what, data }).await;
            }
            other => log::debug!("events: unknown entry type {other}"),
        }
    }
}

pub(crate) fn routes(g: Gateway) -> Router {
    Router::new().route("/events", get(ws)).route("/online", get(online)).with_state(g)
}

async fn ws(State(g): State<Gateway>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> axum::response::Response {
    let slot = match crate::ratelimit::forwarded_ip(&headers) {
        Some(ip) => match g.per_ip.take(ip) {
            Some(slot) => Some(slot),
            None => return crate::ratelimit::too_many(30, "too many event sockets from here"),
        },
        None => None,
    };
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| crate::timings::session("ws", "/events", async move {
            let _slot = slot;
            handle(g, headers, socket).await
        }))
        .into_response()
}

async fn online(State(g): State<Gateway>) -> Json<Value> {
    Json(g.online())
}

impl Gateway {
    pub(crate) fn online(&self) -> Value {
        let s = self.registry.lock();
        let mut names: Vec<(&String, usize)> = s.own.iter().map(|(n, set)| (n, set.len())).collect();
        names.sort();
        Value::Object(names.into_iter().map(|(n, count)| (n.clone(), json!(count))).collect())
    }
}

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

async fn identify(g: &Gateway, headers: &HeaderMap, nick: Option<&str>) -> Result<(Option<String>, Option<Uuid>), Refused> {
    let me = whoami(&g.db, headers).await.map_err(|e| log::warn!("events: cannot read the login: {e}"));
    identify_as(g, me, nick).await
}

async fn identify_as(g: &Gateway, me: Result<Option<crate::auth::Account>, ()>, nick: Option<&str>) -> Result<(Option<String>, Option<Uuid>), Refused> {
    match me {
        Ok(Some(me)) => return Ok((Some(me.name), Some(me.id))),
        Ok(None) => {}
        Err(()) => return Ok((None, None)),
    }
    let Some(name) = guest_name(nick, &g.dummy_prefix)? else { return Ok((None, None)) };
    match is_claimed(&g.db, &name).await {
        Ok(false) => Ok((Some(name), None)),
        Ok(true) => Err(Refused(NICK_HAS_ACCOUNT)),
        Err(e) => {
            log::warn!("events: cannot check whether {name} is claimed: {e}");
            Ok((None, None))
        }
    }
}

async fn handle(g: Gateway, headers: HeaderMap, mut socket: WebSocket) {
    let Some(first) = first_text(&mut socket).await else { return };
    let Ok(In::Hello { nick }) = serde_json::from_str::<In>(&first) else {
        let _ = send(&mut socket, &Out::Error { error: "say hello first" }).await;
        return;
    };
    let (name, account) = match identify(&g, &headers, nick.as_deref()).await {
        Ok(who) => who,
        Err(Refused(why)) => {
            let _ = send(&mut socket, &Out::Error { error: why }).await;
            return;
        }
    };

    let id = g.next.fetch_add(1, Ordering::Relaxed);
    let sid = format!("{}:{id}", g.host);
    let (tx, mut rx) = mpsc::channel::<Frame>(OUT_QUEUE);
    let kick = Arc::new(Notify::new());
    let mut seat = g.seat(id, sid.clone(), tx, kick.clone(), name.clone(), account);
    match &name {
        Some(n) => {
            g.mark_first(&sid, n).await;
            g.tell_me(id, n).await;
        }
        None => {
            if send(&mut socket, &Out::Me { name: None, presence: Presence::Offline, status: Status::default() }).await.is_err() {
                return;
            }
        }
    }
    log::info!("events: {} joined", name.as_deref().unwrap_or("nobody"));
    let named = name.is_some();
    drop(name);

    let mut beat = Heartbeat::standard();
    let mut shutdown = g.shutdown.clone();
    let refresh = g.refresh.clone();
    let mut frames = (Instant::now(), 0u32);
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(out) => if send_frame(&mut socket, out).await.is_err() { break; },
                None => break,
            },
            _ = kick.notified() => {
                log::info!("events: {} fell {OUT_QUEUE} frames behind, dropping", g.name_of(id).await.as_deref().unwrap_or("nobody"));
                let behind = Message::Close(Some(CloseFrame { code: 1013, reason: "behind".into() }));
                let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(behind)).await;
                break;
            }
            incoming = socket.recv() => {
                beat.heard();
                crate::timings::heard(&incoming);
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => continue,
                };
                if frames.0.elapsed() >= Duration::from_secs(60) {
                    frames = (Instant::now(), 0);
                }
                frames.1 += 1;
                if frames.1 > MAX_WATCH_FRAMES_PER_MIN {
                    continue;
                }
                match serde_json::from_str::<In>(&text) {
                    Ok(In::Watch { name: n }) => {
                        let n = n.trim().to_lowercase();
                        if n == EVERYONE || valid_name(&n) || group_topic(&n).is_some() { g.watch(id, &n).await; }
                    }
                    Ok(In::Unwatch { name: n }) => g.unwatch(id, &n.trim().to_lowercase()).await,
                    _ => {}
                }
            }
            b = beat.next() => {
                if b == Beat::Silent {
                    log::info!("events: {} went silent, dropping", g.name_of(id).await.as_deref().unwrap_or("nobody"));
                    break;
                }
                if !ping(&mut socket).await { break; }
                if named { if let Some(n) = g.name_of(id).await { g.touch(&sid, &n).await; } }
            }
            _ = refresh.notified() => {
                if named { if let Some(n) = g.name_of(id).await { g.touch(&sid, &n).await; } }
            }
            _ = shutdown.changed() => {
                seat.going = true;
                let goodbye = Message::Close(Some(CloseFrame { code: 1001, reason: "events restarting".into() }));
                let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(goodbye)).await;
                break;
            }
        }
    }

    log::info!("events: {} left", g.name_of(id).await.as_deref().unwrap_or("nobody"));
}

async fn unmark(g: Gateway, mut left: mpsc::UnboundedReceiver<Left>) {
    while let Some((sid, name)) = left.recv().await {
        g.mark_last(&sid, &name).await;
    }
}

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
            let s = g.registry.lock();
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

    fn seated(registry: &Registry, leaves: &mpsc::UnboundedSender<Left>, id: SocketId, name: Option<&str>) -> (Seat, mpsc::Receiver<Frame>, Arc<Notify>) {
        let (tx, rx) = mpsc::channel(OUT_QUEUE);
        let kick = Arc::new(Notify::new());
        registry.insert(id, tx, kick.clone(), name.map(str::to_owned), None);
        (Seat { registry: registry.clone(), leaves: leaves.clone(), id, sid: format!("h:{id}"), going: false }, rx, kick)
    }

    fn watch_raw(registry: &Registry, id: SocketId, topic: &str) {
        let mut s = registry.lock();
        s.by_id.get_mut(&id).unwrap().watching.insert(topic.to_owned());
        s.watchers.entry(topic.to_owned()).or_default().insert(id);
    }

    #[test]
    fn a_seat_gives_back_its_registry_entry_and_its_presence_when_dropped() {
        let registry = Registry::default();
        let (leaves, mut left) = mpsc::unbounded_channel();
        let (seat, _rx, _) = seated(&registry, &leaves, 1, Some("ann"));
        watch_raw(&registry, 1, "bob");
        watch_raw(&registry, 1, EVERYONE);
        drop(seat);
        assert!(registry.is_empty());
        let s = registry.lock();
        assert!(s.own.is_empty() && s.watchers.is_empty(), "no index keeps a socket that is gone");
        drop(s);
        assert_eq!(left.try_recv().unwrap(), ("h:1".to_owned(), "ann".to_owned()));
    }

    #[test]
    fn a_seat_left_by_a_restart_does_not_say_gone_and_a_nameless_one_says_nothing() {
        let registry = Registry::default();
        let (leaves, mut left) = mpsc::unbounded_channel();
        let (mut seat, _rx, _) = seated(&registry, &leaves, 1, Some("ann"));
        seat.going = true;
        drop(seat);
        let (seat, _rx, _) = seated(&registry, &leaves, 2, None);
        drop(seat);
        assert!(registry.is_empty());
        assert!(left.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_handler_that_panics_or_is_killed_is_unseated() {
        let registry = Registry::default();
        let (leaves, mut left) = mpsc::unbounded_channel();
        let (r, l) = (registry.clone(), leaves.clone());
        let died = tokio::spawn(async move {
            let _seat = seated(&r, &l, 1, Some("ann"));
            watch_raw(&r, 1, "bob");
            tokio::task::yield_now().await;
            panic!("a handler fell over mid join");
        })
        .await;
        assert!(died.is_err());
        assert!(registry.is_empty());
        assert_eq!(left.recv().await.unwrap().1, "ann");

        let (r, l) = (registry.clone(), leaves.clone());
        let (sat, told) = tokio::sync::oneshot::channel();
        let killed = tokio::spawn(async move {
            let _seat = seated(&r, &l, 2, Some("bob"));
            let _ = sat.send(());
            std::future::pending::<()>().await;
        });
        told.await.unwrap();
        assert!(!registry.is_empty());
        killed.abort();
        let _ = killed.await;
        assert!(registry.is_empty());
        assert_eq!(left.recv().await.unwrap().1, "bob");
    }

    #[test]
    fn a_thousand_sockets_flapping_leave_an_empty_registry() {
        let registry = Registry::default();
        let (leaves, mut left) = mpsc::unbounded_channel();
        for id in 0..1000 {
            let (seat, _rx, _) = seated(&registry, &leaves, id, Some(if id % 2 == 0 { "ann" } else { "bob" }));
            watch_raw(&registry, id, "carol");
            drop(seat);
        }
        assert!(registry.is_empty());
        assert!(registry.lock().watchers.is_empty());
        let mut n = 0;
        while left.try_recv().is_ok() {
            n += 1;
        }
        assert_eq!(n, 1000);
    }

    #[test]
    fn a_socket_that_stops_reading_is_kicked_not_buffered_forever() {
        let registry = Registry::default();
        let (leaves, _left) = mpsc::unbounded_channel();
        let (_seat, mut rx, kick) = seated(&registry, &leaves, 1, None);
        let s = registry.lock();
        let e = s.by_id.get(&1).unwrap();
        for _ in 0..OUT_QUEUE {
            e.put(Out::Ended { name: "ann".into() });
        }
        let kicked = kick.notified();
        tokio::pin!(kicked);
        assert!(futures_poll(kicked.as_mut()).is_pending(), "a full queue is not yet a kick");
        e.put(Out::Ended { name: "ann".into() });
        assert!(futures_poll(kicked.as_mut()).is_ready(), "one past the queue is");
        drop(s);
        let mut queued = 0;
        while rx.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, OUT_QUEUE, "the queue holds what it holds and no more");
    }

    fn futures_poll<F: std::future::Future>(f: std::pin::Pin<&mut F>) -> std::task::Poll<F::Output> {
        let waker = std::task::Waker::noop();
        f.poll(&mut std::task::Context::from_waker(waker))
    }

    fn named(nick: Option<&str>) -> Result<Option<String>, &'static str> {
        guest_name(nick, "dummy-").map_err(|Refused(why)| why)
    }

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

    #[test]
    fn only_members_and_site_admins_watch_a_closed_group() {
        let (member, admin, stranger) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let admins = [admin];
        let gate = |public, adult| GroupGate { public, adult, members: vec![member] };
        let open = gate(true, false);
        for who in [None, Some(member), Some(admin), Some(stranger)] {
            assert!(may_watch(Some(&open), who, &admins), "{who:?}");
        }
        for (public, adult) in [(true, true), (false, false), (false, true)] {
            let closed = gate(public, adult);
            assert!(!may_watch(Some(&closed), None, &admins), "{public} {adult}");
            assert!(!may_watch(Some(&closed), Some(stranger), &admins), "{public} {adult}");
            assert!(may_watch(Some(&closed), Some(member), &admins), "{public} {adult}");
            assert!(may_watch(Some(&closed), Some(admin), &admins), "{public} {adult}");
        }
        assert!(!may_watch(None, Some(admin), &admins), "a group that is gone or unreadable lets nobody watch");
    }

    #[test]
    fn a_change_of_who_may_watch_is_checked_on_the_right_side_of_its_fact() {
        assert_eq!(regate_around("adult"), (true, false));
        assert_eq!(regate_around("access"), (true, false));
        assert_eq!(regate_around("joined"), (true, false));
        assert_eq!(regate_around("left"), (false, true));
        assert_eq!(regate_around("banned"), (false, true));
        assert_eq!(regate_around("deleted"), (false, true));
        assert_eq!(regate_around("voice"), (false, false));
        assert_eq!(regate_around("held"), (false, false));
    }

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
