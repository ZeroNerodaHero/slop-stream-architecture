use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{broadcast, mpsc, Notify};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use uuid::Uuid;

use crate::auth::{whoami, whoami_readonly, Account};
use crate::chat::{self, ChatState, Event, Hello, Joined, Lease, Line, React, Speaker, Unknown, Who};
use crate::events::{frame, Frame, Seat};
use crate::socket::{first_text, ping, send, send_text, Beat, Heartbeat, PING_EVERY, SEND_TIMEOUT};
use crate::valid_name;

pub(crate) const VERSION: u32 = 1;
pub(crate) const MAX_SOCKETS_PER_IP: usize = 20;
pub(crate) const MAX_FRAME_BYTES: usize = 64 * 1024;
pub(crate) const OUT_QUEUE: usize = 1024;
pub(crate) const MAX_CHAT_TOPICS: usize = 16;
pub(crate) const MAX_PER_WILDCARD: usize = 64;
pub(crate) const MAX_PRESENCE: usize = 1000;
pub(crate) const NEW_TOPICS_PER_MIN: u32 = 60;
pub(crate) const SUB_FRAMES_PER_MIN: u32 = 120;
pub(crate) const RATE_WINDOW: Duration = Duration::from_secs(60);
const WILDCARD_FRESH: Duration = Duration::from_secs(60);
pub(crate) const TICKET_TTL_SECS: u64 = 30;

pub(crate) const NO_SUCH_TOPIC: &str = "no such topic";
pub(crate) const NO_SUCH_CHANNEL: &str = "no such channel";
pub(crate) const NO_SUCH_GROUP: &str = "no such group";
pub(crate) const TOO_MANY: &str = "too many topics";
pub(crate) const SLOW: &str = "slow down";
const BUSY: &str = "chat is busy, try again";
const NOT_JOINED: &str = "subscribe to the topic first";
const TOO_MANY_TABS: &str = "too many tabs";
const BAD_TICKET: &str = "bad ticket";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Topic {
    Stream(String),
    Channel(String, String),
    Every(String),
    Presence(String),
    Streams,
    Group(String),
}

impl Topic {
    pub(crate) fn parse(raw: &str) -> Option<Topic> {
        let raw = raw.trim().to_lowercase();
        let (kind, rest) = raw.split_once(':')?;
        match kind {
            "chat" => match rest.split_once('/') {
                None => valid_name(rest).then(|| Topic::Stream(rest.to_owned())),
                Some((server, "*")) => crate::groups::channel_names(server, "general").ok().map(|(server, _)| Topic::Every(server)),
                Some((server, channel)) => crate::groups::channel_names(server, channel).ok().map(|(server, channel)| Topic::Channel(server, channel)),
            },
            "presence" => valid_name(rest).then(|| Topic::Presence(rest.to_owned())),
            "streams" => (rest == "*").then_some(Topic::Streams),
            "group" => valid_name(rest).then(|| Topic::Group(rest.to_owned())),
            _ => None,
        }
    }

    pub(crate) fn key(&self) -> String {
        match self {
            Topic::Stream(name) => chat_topic(name),
            Topic::Channel(server, channel) => chat_topic(&format!("{server}/{channel}")),
            Topic::Every(server) => chat_topic(&format!("{server}/*")),
            Topic::Presence(name) => format!("presence:{name}"),
            Topic::Streams => "streams:*".to_owned(),
            Topic::Group(group) => format!("group:{group}"),
        }
    }

    pub(crate) fn is_chat(&self) -> bool {
        matches!(self, Topic::Stream(_) | Topic::Channel(..) | Topic::Every(_))
    }

    fn watch_key(&self) -> Option<String> {
        match self {
            Topic::Presence(name) => Some(name.clone()),
            Topic::Streams => Some("*".to_owned()),
            Topic::Group(group) => Some(format!("group:{group}")),
            _ => None,
        }
    }

    fn room(&self) -> Option<RoomRef> {
        match self {
            Topic::Stream(name) => Some(RoomRef { room: name.clone(), server: None }),
            Topic::Channel(server, channel) => Some(RoomRef { room: format!("{server}/{channel}"), server: Some(server.clone()) }),
            _ => None,
        }
    }
}

pub(crate) fn chat_topic(room: &str) -> String {
    format!("chat:{room}")
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct RoomRef {
    pub(crate) room: String,
    pub(crate) server: Option<String>,
}

pub(crate) fn wildcard_rooms(server: &str, channels: Vec<String>) -> Vec<RoomRef> {
    channels.into_iter().take(MAX_PER_WILDCARD).map(|channel| RoomRef { room: format!("{server}/{channel}"), server: Some(server.to_owned()) }).collect()
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub(crate) struct Refusal {
    pub(crate) topic: String,
    pub(crate) error: &'static str,
}

impl Refusal {
    fn of(topic: &Topic, error: &'static str) -> Refusal {
        Refusal { topic: topic.key(), error }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum RtOut<'a> {
    Ready {
        v: u32,
        beat: u64,
    },
    Subbed {
        rev: u64,
        topics: Vec<String>,
        refused: &'a [Refusal],
        evicted: Vec<String>,
    },
    Message {
        topic: &'a str,
        #[serde(flatten)]
        line: &'a Line,
    },
    Count {
        topic: &'a str,
        count: usize,
    },
    React {
        topic: &'a str,
        #[serde(flatten)]
        react: &'a React,
    },
    Delete {
        topic: &'a str,
        id: &'a str,
    },
    Gap {
        topic: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        missed: Option<u64>,
    },
    Behind,
    Beat {
        at: u64,
    },
    Ack {
        rid: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<&'a str>,
    },
    Nack {
        rid: &'a str,
        error: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        wait: Option<u64>,
    },
    Authed {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
    Error {
        error: &'a str,
    },
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct SubFrame {
    pub(crate) rev: u64,
    pub(crate) topics: Vec<String>,
    #[serde(default)]
    pub(crate) since: HashMap<String, String>,
    #[serde(default)]
    pub(crate) fresh: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum In {
    Hello(Hello),
    Sub(SubFrame),
    Say {
        rid: String,
        topic: String,
        text: String,
        #[serde(default)]
        image: Option<String>,
        #[serde(default)]
        images: Vec<String>,
        #[serde(default)]
        video: Option<String>,
        #[serde(default)]
        reply: Option<String>,
    },
    React {
        rid: String,
        topic: String,
        id: String,
        emoji: String,
        on: bool,
    },
    Auth {
        ticket: String,
        #[serde(default)]
        nick: Option<String>,
    },
    Beat,
}

pub(crate) struct Window {
    start: Instant,
    used: u32,
    limit: u32,
}

impl Window {
    pub(crate) fn new(limit: u32, now: Instant) -> Window {
        Window { start: now, used: 0, limit }
    }

    pub(crate) fn take(&mut self, now: Instant) -> bool {
        if now.duration_since(self.start) >= RATE_WINDOW {
            self.start = now;
            self.used = 0;
        }
        if self.used >= self.limit {
            return false;
        }
        self.used += 1;
        true
    }

    fn reopens(&self) -> Instant {
        self.start + RATE_WINDOW
    }
}

pub(crate) struct SubGate {
    window: Window,
    pending: Option<SubFrame>,
    applied: u64,
}

impl SubGate {
    pub(crate) fn new(now: Instant) -> SubGate {
        SubGate { window: Window::new(SUB_FRAMES_PER_MIN, now), pending: None, applied: 0 }
    }

    pub(crate) fn offer(&mut self, sub: SubFrame, now: Instant) -> Option<SubFrame> {
        if sub.rev <= self.applied || self.pending.as_ref().is_some_and(|p| p.rev >= sub.rev) {
            return None;
        }
        if self.window.take(now) {
            self.pending = None;
            self.applied = sub.rev;
            return Some(sub);
        }
        self.pending = Some(sub);
        None
    }

    pub(crate) fn due(&mut self, now: Instant) -> Option<SubFrame> {
        if self.pending.is_none() || !self.window.take(now) {
            return None;
        }
        let sub = self.pending.take()?;
        self.applied = sub.rev;
        Some(sub)
    }

    pub(crate) fn wake(&self) -> Option<Instant> {
        self.pending.as_ref().map(|_| self.window.reopens())
    }

    pub(crate) fn applied(&self) -> u64 {
        self.applied
    }
}

struct ChatEntry {
    seq: u64,
    rooms: Vec<RoomRef>,
    resolved: Instant,
}

pub(crate) struct Topics {
    chat: HashMap<Topic, ChatEntry>,
    events: HashSet<Topic>,
    evicted: HashSet<Topic>,
    seq: u64,
    new_topics: Window,
}

#[derive(Debug, Default)]
pub(crate) struct Plan {
    pub(crate) unwatch: Vec<Topic>,
    pub(crate) watch: Vec<Topic>,
    pub(crate) join: Vec<Topic>,
    pub(crate) refused: Vec<Refusal>,
}

impl Topics {
    pub(crate) fn new(now: Instant) -> Topics {
        Topics { chat: HashMap::new(), events: HashSet::new(), evicted: HashSet::new(), seq: 0, new_topics: Window::new(NEW_TOPICS_PER_MIN, now) }
    }

    pub(crate) fn plan(&mut self, wanted: &[String], now: Instant) -> Plan {
        let mut plan = Plan::default();
        let mut order: Vec<Topic> = Vec::new();
        let mut seen: HashSet<Topic> = HashSet::new();
        for raw in wanted {
            match Topic::parse(raw) {
                Some(t) => {
                    if seen.insert(t.clone()) {
                        order.push(t);
                    }
                }
                None => plan.refused.push(Refusal { topic: raw.clone(), error: NO_SUCH_TOPIC }),
            }
        }
        self.evicted.retain(|t| seen.contains(t));
        self.chat.retain(|t, _| seen.contains(t));
        let gone: Vec<Topic> = self.events.iter().filter(|t| !seen.contains(*t)).cloned().collect();
        for t in &gone {
            self.events.remove(t);
        }
        plan.unwatch = gone;
        let mut presence = self.events.iter().filter(|t| matches!(t, Topic::Presence(_))).count();
        let mut returning = Vec::new();
        for t in order {
            if t.is_chat() {
                if self.chat.contains_key(&t) {
                    continue;
                }
                if self.evicted.contains(&t) {
                    returning.push(t);
                    continue;
                }
                if !self.new_topics.take(now) {
                    plan.refused.push(Refusal::of(&t, SLOW));
                    continue;
                }
                plan.join.push(t);
                continue;
            }
            if self.events.contains(&t) {
                continue;
            }
            if matches!(t, Topic::Presence(_)) {
                if presence >= MAX_PRESENCE {
                    plan.refused.push(Refusal::of(&t, TOO_MANY));
                    continue;
                }
                presence += 1;
            } else if !self.new_topics.take(now) {
                plan.refused.push(Refusal::of(&t, SLOW));
                continue;
            }
            self.events.insert(t.clone());
            plan.watch.push(t);
        }
        plan.join.extend(returning);
        plan
    }

    pub(crate) fn is_evicted(&self, t: &Topic) -> bool {
        self.evicted.contains(t)
    }

    pub(crate) fn has_room(&self) -> bool {
        self.chat.len() < MAX_CHAT_TOPICS
    }

    pub(crate) fn admit(&mut self, t: Topic, rooms: Vec<RoomRef>, now: Instant) -> Vec<Topic> {
        self.seq += 1;
        self.evicted.remove(&t);
        self.chat.insert(t, ChatEntry { seq: self.seq, rooms, resolved: now });
        let mut out = Vec::new();
        while self.chat.len() > MAX_CHAT_TOPICS {
            let Some(oldest) = self.chat.iter().min_by_key(|(_, e)| e.seq).map(|(t, _)| t.clone()) else { break };
            self.chat.remove(&oldest);
            self.evicted.insert(oldest.clone());
            out.push(oldest);
        }
        out
    }

    pub(crate) fn drop_chat(&mut self, t: &Topic) {
        self.chat.remove(t);
    }

    fn set_rooms(&mut self, t: &Topic, rooms: Vec<RoomRef>, now: Instant) {
        if let Some(e) = self.chat.get_mut(t) {
            e.rooms = rooms;
            e.resolved = now;
        }
    }

    fn stale_wildcards(&self, now: Instant, fresh: &[String]) -> Vec<Topic> {
        let asked: HashSet<Topic> = fresh.iter().filter_map(|raw| Topic::parse(raw)).collect();
        self.chat
            .iter()
            .filter(|(t, e)| matches!(t, Topic::Every(_)) && (asked.contains(t) || now.duration_since(e.resolved) >= WILDCARD_FRESH))
            .map(|(t, _)| t.clone())
            .collect()
    }

    fn gated(&self) -> Vec<Topic> {
        self.chat.keys().filter(|t| !matches!(t, Topic::Stream(_))).cloned().collect()
    }

    pub(crate) fn rooms(&self) -> HashMap<String, RoomRef> {
        self.chat.values().flat_map(|e| e.rooms.iter()).map(|r| (r.room.clone(), r.clone())).collect()
    }

    pub(crate) fn covers(&self, room: &str) -> bool {
        self.chat.values().any(|e| e.rooms.iter().any(|r| r.room == room))
    }

    pub(crate) fn subscribed(&self) -> Vec<Topic> {
        self.chat.keys().chain(self.events.iter()).cloned().collect()
    }

    fn groups(&self) -> Vec<Topic> {
        self.events.iter().filter(|t| matches!(t, Topic::Group(_))).cloned().collect()
    }

    pub(crate) fn evicted(&self) -> Vec<String> {
        let mut out: Vec<String> = self.evicted.iter().map(Topic::key).collect();
        out.sort();
        out
    }

    pub(crate) fn chat_count(&self) -> usize {
        self.chat.len()
    }
}

#[derive(Clone)]
pub(crate) struct Outbox {
    tx: mpsc::Sender<Frame>,
    behind: Arc<Notify>,
}

impl Outbox {
    pub(crate) fn new() -> (Outbox, mpsc::Receiver<Frame>) {
        let (tx, rx) = mpsc::channel(OUT_QUEUE);
        (Outbox { tx, behind: Arc::new(Notify::new()) }, rx)
    }

    pub(crate) fn put(&self, f: Frame) -> bool {
        match self.tx.try_send(f) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.behind.notify_one();
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
}

struct Forward(JoinHandle<()>);

impl Drop for Forward {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn forward(topic: Arc<str>, mut rx: broadcast::Receiver<Event>, out: Outbox) -> Forward {
    Forward(tokio::spawn(async move {
        loop {
            let f = match rx.recv().await {
                Ok(Event::Line(_, f) | Event::React(_, f) | Event::Delete(_, f)) => f,
                Ok(Event::Count(count)) => frame(&RtOut::Count { topic: &topic, count }),
                Err(broadcast::error::RecvError::Lagged(n)) => frame(&RtOut::Gap { topic: &topic, missed: Some(n) }),
                Err(broadcast::error::RecvError::Closed) => return,
            };
            out.put(f);
        }
    }))
}

struct Held {
    _forward: Forward,
    _lease: Lease,
}

struct Speaking {
    who: Who,
    speaker: Speaker,
}

struct Conn {
    s: ChatState,
    out: Outbox,
    seat: Seat,
    ip: String,
    headers: HeaderMap,
    hello: Hello,
    me: Result<Option<Account>, ()>,
    speaking: HashMap<String, Speaking>,
    topics: Topics,
    rooms: HashMap<String, Held>,
    gate: SubGate,
}

type Broken = ();

pub(crate) fn routes() -> Router<ChatState> {
    Router::new().route("/rt", get(ws)).route("/rt/ticket", post(ticket))
}

fn ticket_key(ticket: &str) -> String {
    format!("rtticket:{ticket}")
}

fn valid_ticket(ticket: &str) -> bool {
    ticket.len() == 32 && ticket.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn ticket(State(s): State<ChatState>, headers: HeaderMap) -> Response {
    let me = match whoami_readonly(&s.db, &headers).await {
        Ok(me) => me,
        Err(e) => {
            log::warn!("rt: ticket: cannot read the login: {e}");
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": BUSY }))).into_response();
        }
    };
    let ticket: String = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
    let value = me.map(|a| a.id.to_string()).unwrap_or_default();
    let set: Result<(), redis::RedisError> =
        redis::cmd("SET").arg(ticket_key(&ticket)).arg(value).arg("EX").arg(TICKET_TTL_SECS).arg("NX").query_async(&mut s.redis.clone()).await;
    if let Err(e) = set {
        log::warn!("rt: ticket: {e}");
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "chat is down, try again" }))).into_response();
    }
    Json(json!({ "ticket": ticket, "ttl": TICKET_TTL_SECS })).into_response()
}

async fn redeem(s: &ChatState, ticket: &str) -> Result<Option<Account>, &'static str> {
    if !valid_ticket(ticket) {
        return Err(BAD_TICKET);
    }
    let got: Result<Option<String>, redis::RedisError> = redis::cmd("GETDEL").arg(ticket_key(ticket)).query_async(&mut s.redis.clone()).await;
    let raw = match got {
        Ok(Some(raw)) => raw,
        Ok(None) => return Err(BAD_TICKET),
        Err(e) => {
            log::warn!("rt: redeem: {e}");
            return Err(BUSY);
        }
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let Ok(id) = Uuid::parse_str(&raw) else { return Err(BAD_TICKET) };
    let row: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as("SELECT id, name FROM streamers WHERE id = $1").bind(id).fetch_optional(&s.db).await;
    match row {
        Ok(row) => Ok(row.map(|(id, name)| Account { id, name })),
        Err(e) => {
            log::warn!("rt: redeem: {e}");
            Err(BUSY)
        }
    }
}

async fn ws(State(s): State<ChatState>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let slot = match chat::socket_slot(&s.rt_sockets, &headers) {
        Ok(slot) => slot,
        Err(refused) => return refused,
    };
    let ip = crate::auth::client_ip(&headers);
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            let _slot = slot;
            handle(s, ip, headers, socket).await
        })
        .into_response()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

async fn handle(s: ChatState, ip: String, headers: HeaderMap, mut socket: WebSocket) {
    let Some(first) = first_text(&mut socket).await else { return };
    let Ok(In::Hello(hello)) = serde_json::from_str::<In>(&first) else {
        let _ = send(&mut socket, &RtOut::Error { error: "say hello first" }).await;
        return;
    };
    let me = whoami(&s.db, &headers).await.map_err(|e| log::warn!("rt: cannot read the login: {e}"));
    let (name, account) = match s.gateway.identity(me.clone(), hello.nick.as_deref()).await {
        Ok(who) => who,
        Err(why) => {
            let _ = send(&mut socket, &RtOut::Error { error: why }).await;
            return;
        }
    };
    if send(&mut socket, &RtOut::Ready { v: VERSION, beat: PING_EVERY.as_millis() as u64 }).await.is_err() {
        return;
    }
    let (out, mut rx) = Outbox::new();
    let seat = s.gateway.sit(out.tx.clone(), out.behind.clone(), name.clone(), account).await;
    log::info!("rt: {} joined", name.as_deref().unwrap_or("nobody"));
    let now = Instant::now();
    let behind = out.behind.clone();
    let refresh = s.gateway.refreshes();
    let mut shutdown = s.shutdown.clone();
    let mut conn = Conn {
        s,
        out,
        seat,
        ip,
        headers,
        hello,
        me,
        speaking: HashMap::new(),
        topics: Topics::new(now),
        rooms: HashMap::new(),
        gate: SubGate::new(now),
    };
    let mut beat = Heartbeat::standard();
    loop {
        let wake = conn.gate.wake();
        tokio::select! {
            f = rx.recv() => match f {
                Some(f) => if send_text(&mut socket, f.to_string(), SEND_TIMEOUT).await.is_err() { break; },
                None => break,
            },
            _ = behind.notified() => {
                while rx.try_recv().is_ok() {}
                if send(&mut socket, &RtOut::Behind).await.is_err() { break; }
                conn.retell().await;
            }
            b = beat.next() => {
                if b == Beat::Silent {
                    log::info!("rt: went silent, dropping");
                    break;
                }
                if !ping(&mut socket).await { break; }
                if send(&mut socket, &RtOut::Beat { at: now_ms() }).await.is_err() { break; }
                conn.s.gateway.keep_alive(&conn.seat).await;
            }
            _ = refresh.notified() => conn.s.gateway.keep_alive(&conn.seat).await,
            _ = shutdown.changed() => {
                conn.seat.restarting();
                let goodbye = Message::Close(Some(CloseFrame { code: 1001, reason: "restarting".into() }));
                let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(goodbye)).await;
                break;
            }
            _ = tokio::time::sleep_until(wake.unwrap_or_else(Instant::now)), if wake.is_some() => {
                if let Some(sub) = conn.gate.due(Instant::now()) {
                    if conn.apply(&mut socket, sub).await.is_err() { break; }
                }
            }
            incoming = socket.recv() => {
                beat.heard();
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => continue,
                };
                if conn.on_text(&mut socket, &text).await.is_err() { break; }
            }
        }
    }
    log::info!("rt: left with {} chat topics", conn.topics.chat_count());
}

impl Conn {
    async fn on_text(&mut self, socket: &mut WebSocket, text: &str) -> Result<(), Broken> {
        match serde_json::from_str::<In>(text) {
            Ok(In::Sub(sub)) => {
                if let Some(sub) = self.gate.offer(sub, Instant::now()) {
                    self.apply(socket, sub).await?;
                }
            }
            Ok(In::Say { rid, topic, text, image, images, video, reply }) => {
                let answer = self.say(&topic, text, image, images, video, reply).await;
                self.answer(socket, &rid, answer).await?;
            }
            Ok(In::React { rid, topic, id, emoji, on }) => {
                let answer = self.react(&topic, &id, &emoji, on).await.map(|()| None);
                self.answer(socket, &rid, answer).await?;
            }
            Ok(In::Auth { ticket, nick }) => self.auth(socket, &ticket, nick).await?,
            Ok(In::Hello(_)) | Ok(In::Beat) => {}
            Err(_) => send(socket, &RtOut::Error { error: "bad frame" }).await.map_err(|_| ())?,
        }
        Ok(())
    }

    async fn answer(&self, socket: &mut WebSocket, rid: &str, answer: Result<Option<String>, (&'static str, Option<u64>)>) -> Result<(), Broken> {
        let sent = match &answer {
            Ok(id) => send(socket, &RtOut::Ack { rid, id: id.as_deref() }).await,
            Err((error, wait)) => send(socket, &RtOut::Nack { rid, error, wait: *wait }).await,
        };
        sent.map_err(|_| ())
    }

    fn account(&self) -> Option<&Account> {
        self.me.as_ref().ok().and_then(Option::as_ref)
    }

    fn viewer(&self) -> (Option<Uuid>, bool) {
        let user = self.account().map(|a| a.id);
        (user, user.is_some_and(|id| self.s.is_admin_id(id)))
    }

    async fn me(&self) -> Result<Option<Account>, sqlx::Error> {
        match &self.me {
            Ok(me) => Ok(me.clone()),
            Err(()) => whoami(&self.s.db, &self.headers).await,
        }
    }

    async fn resolve(&self, t: &Topic) -> Result<Vec<RoomRef>, &'static str> {
        let (user, admin) = self.viewer();
        match t {
            Topic::Stream(_) => Ok(t.room().into_iter().collect()),
            Topic::Channel(server, channel) => {
                let (server, room) = crate::groups::channel_room(&self.s.db, server, channel).await.map_err(|_| NO_SUCH_CHANNEL)?;
                let channel = room.strip_prefix(server.as_str()).and_then(|rest| rest.strip_prefix('/')).unwrap_or("").to_owned();
                match crate::groups::may_see_text(&self.s.db, &server, &channel, user, admin).await {
                    Ok(true) => Ok(vec![RoomRef { room, server: Some(server) }]),
                    Ok(false) => Err(NO_SUCH_CHANNEL),
                    Err(e) => {
                        log::warn!("rt: {room}: cannot read the channel's roles: {e}");
                        Err(BUSY)
                    }
                }
            }
            Topic::Every(server) => {
                let server = chat::server_of(&self.s.db, server).await.map_err(|_| "not a server")?;
                match crate::groups::visible_text_channels(&self.s.db, &server, user, admin).await {
                    Ok(channels) => Ok(wildcard_rooms(&server, channels)),
                    Err(e) => {
                        log::warn!("rt: {server}: cannot list the channels: {e}");
                        Err(BUSY)
                    }
                }
            }
            _ => Err(NO_SUCH_TOPIC),
        }
    }

    async fn enter(&mut self, rooms: &[RoomRef]) -> Result<(), &'static str> {
        for r in rooms {
            if self.rooms.contains_key(&r.room) {
                continue;
            }
            let Some(Joined { rx, lease }) = self.s.join(&r.room, &self.ip).await else { return Err(TOO_MANY_TABS) };
            let topic: Arc<str> = chat_topic(&r.room).into();
            self.rooms.insert(r.room.clone(), Held { _forward: forward(topic, rx, self.out.clone()), _lease: lease });
        }
        Ok(())
    }

    fn prune(&mut self) {
        let needed = self.topics.rooms();
        self.rooms.retain(|room, _| needed.contains_key(room));
        self.speaking.retain(|room, _| needed.contains_key(room));
    }

    async fn join(&mut self, t: Topic, refused: &mut Vec<Refusal>) {
        let returning = self.topics.is_evicted(&t);
        if returning && !self.topics.has_room() {
            return;
        }
        let rooms = match self.resolve(&t).await {
            Ok(rooms) => rooms,
            Err(why) => {
                refused.push(Refusal::of(&t, why));
                return;
            }
        };
        if let Err(why) = self.enter(&rooms).await {
            refused.push(Refusal::of(&t, why));
            self.prune();
            return;
        }
        self.topics.admit(t, rooms, Instant::now());
    }

    async fn refresh_wildcards(&mut self, refused: &mut Vec<Refusal>, fresh: &[String]) {
        for t in self.topics.stale_wildcards(Instant::now(), fresh) {
            self.recheck(t, refused).await;
        }
    }

    async fn recheck(&mut self, t: Topic, refused: &mut Vec<Refusal>) {
        match self.resolve(&t).await {
            Ok(rooms) => {
                if self.enter(&rooms).await.is_err() {
                    self.topics.drop_chat(&t);
                    refused.push(Refusal::of(&t, TOO_MANY_TABS));
                } else {
                    self.topics.set_rooms(&t, rooms, Instant::now());
                }
            }
            Err(BUSY) => {}
            Err(why) => {
                self.topics.drop_chat(&t);
                refused.push(Refusal::of(&t, why));
            }
        }
    }

    async fn apply(&mut self, socket: &mut WebSocket, sub: SubFrame) -> Result<(), Broken> {
        let plan = self.topics.plan(&sub.topics, Instant::now());
        let mut refused = plan.refused;
        for t in &plan.unwatch {
            if let Some(key) = t.watch_key() {
                self.s.gateway.unsubscribe(&self.seat, &key).await;
            }
        }
        for t in &plan.watch {
            if let Some(key) = t.watch_key() {
                self.s.gateway.subscribe(&self.seat, &key).await;
            }
        }
        for t in plan.join {
            self.join(t, &mut refused).await;
        }
        self.refresh_wildcards(&mut refused, &sub.fresh).await;
        self.prune();
        self.replay(socket, &sub.since).await?;
        self.subbed(socket, refused).await
    }

    async fn subbed(&self, socket: &mut WebSocket, mut refused: Vec<Refusal>) -> Result<(), Broken> {
        let shut: HashSet<Topic> = self
            .topics
            .groups()
            .into_iter()
            .filter(|t| !t.watch_key().is_some_and(|key| self.s.gateway.admitted(&self.seat, &key)))
            .collect();
        for t in &shut {
            refused.push(Refusal::of(t, NO_SUCH_GROUP));
        }
        let mut topics: Vec<String> = self.topics.subscribed().into_iter().filter(|t| !shut.contains(t)).map(|t| t.key()).collect();
        topics.sort();
        let reply = RtOut::Subbed { rev: self.gate.applied(), topics, refused: &refused, evicted: self.topics.evicted() };
        send(socket, &reply).await.map_err(|_| ())
    }

    async fn replay(&self, socket: &mut WebSocket, since: &HashMap<String, String>) -> Result<(), Broken> {
        let (viewer, _) = self.viewer();
        for (raw, id) in since {
            let Some(room) = Topic::parse(raw).and_then(|t| t.room()) else { continue };
            if !self.rooms.contains_key(&room.room) || !chat::is_stream_id(id) {
                continue;
            }
            let topic = chat_topic(&room.room);
            let lines = chat::after(&self.s, &room.room, id, viewer).await;
            for line in &lines {
                send(socket, &RtOut::Message { topic: &topic, line }).await.map_err(|_| ())?;
            }
            if lines.len() >= chat::FILL_LIMIT {
                send(socket, &RtOut::Gap { topic: &topic, missed: None }).await.map_err(|_| ())?;
            }
        }
        Ok(())
    }

    async fn retell(&mut self) {
        self.s.gateway.retell(&self.seat).await;
        for room in self.rooms.keys() {
            let topic = chat_topic(room);
            self.out.put(frame(&RtOut::Count { topic: &topic, count: self.s.rooms_viewers(room) }));
        }
    }

    fn joined_room(&self, topic: &str) -> Result<RoomRef, (&'static str, Option<u64>)> {
        let room = Topic::parse(topic).and_then(|t| t.room()).ok_or((NO_SUCH_TOPIC, None))?;
        if !self.rooms.contains_key(&room.room) || !self.topics.covers(&room.room) {
            return Err((NOT_JOINED, None));
        }
        Ok(room)
    }

    async fn speak(&mut self, r: &RoomRef) -> Result<(), (&'static str, Option<u64>)> {
        if self.speaking.contains_key(&r.room) {
            return Ok(());
        }
        let me = self.me().await;
        let who = match chat::identify_as(&self.s, &r.room, me, &self.hello).await {
            Ok(who) => who,
            Err(Unknown::Refused(why)) => return Err((why, None)),
            Err(Unknown::Busy) => return Err((BUSY, None)),
            Err(Unknown::Reader) => return Err((chat::READING_ONLY, None)),
        };
        let test_room = chat::test_room_of(&self.s, &r.room, r.server.as_deref()).await;
        let speaker = Speaker::of(Some(&who), &self.hello, &self.ip, test_room);
        self.speaking.insert(r.room.clone(), Speaking { who, speaker });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn say(
        &mut self,
        topic: &str,
        text: String,
        image: Option<String>,
        images: Vec<String>,
        video: Option<String>,
        reply: Option<String>,
    ) -> Result<Option<String>, (&'static str, Option<u64>)> {
        let r = self.joined_room(topic)?;
        let (text, images, video) = match chat::parse_say(text, image, images, video) {
            Ok(Some(say)) => say,
            Ok(None) => return Err(("say something", None)),
            Err(why) => return Err((why, None)),
        };
        self.speak(&r).await?;
        let Some(sp) = self.speaking.get(&r.room) else { return Err((BUSY, None)) };
        if let Err(wait) = self.s.limiter.take(&sp.speaker, &r.room) {
            return Err((chat::SLOW_DOWN, Some((wait.as_secs_f64() * 1000.0).ceil() as u64)));
        }
        chat::accept(&self.s, &r.room, r.server.as_deref(), &sp.who, &text, &images, video.as_deref(), reply.as_deref()).await.map_err(|why| why.parts())
    }

    async fn react(&mut self, topic: &str, id: &str, emoji: &str, on: bool) -> Result<(), (&'static str, Option<u64>)> {
        let r = self.joined_room(topic)?;
        if !chat::is_stream_id(id) {
            return Err((chat::NO_SUCH_LINE, None));
        }
        let Some(emoji) = crate::reactions::shaped(emoji) else { return Err((crate::reactions::NOT_A_REACTION, None)) };
        self.speak(&r).await?;
        let Some(sp) = self.speaking.get(&r.room) else { return Err((BUSY, None)) };
        if let Err(wait) = self.s.reacts.take(&sp.speaker, &r.room) {
            return Err((chat::SLOW_DOWN, Some((wait.as_secs_f64() * 1000.0).ceil() as u64)));
        }
        chat::react(&self.s, &r.room, r.server.as_deref(), &sp.who, id, &emoji, on).await.map_err(|why| (why, None))
    }

    async fn auth(&mut self, socket: &mut WebSocket, ticket: &str, nick: Option<String>) -> Result<(), Broken> {
        let account = match redeem(&self.s, ticket).await {
            Ok(account) => account,
            Err(why) => return send(socket, &RtOut::Authed { ok: false, name: None, error: Some(why) }).await.map_err(|_| ()),
        };
        if let Some(nick) = nick {
            self.hello.nick = Some(nick);
        }
        self.me = Ok(account.clone());
        self.speaking.clear();
        let (name, id) = self.s.gateway.identity(Ok(account), self.hello.nick.as_deref()).await.unwrap_or((None, None));
        self.s.gateway.reseat(&self.seat, name.clone(), id).await;
        let mut refused = Vec::new();
        for t in self.topics.gated() {
            self.recheck(t, &mut refused).await;
        }
        self.prune();
        send(socket, &RtOut::Authed { ok: true, name: name.as_deref(), error: None }).await.map_err(|_| ())?;
        self.subbed(socket, refused).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topics(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|t| (*t).to_owned()).collect()
    }

    fn streams(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("chat:room{i}")).collect()
    }

    fn admit_all(t: &mut Topics, plan: Plan, now: Instant) -> Vec<Topic> {
        let mut evicted = Vec::new();
        for topic in plan.join {
            if t.is_evicted(&topic) && !t.has_room() {
                continue;
            }
            let rooms = topic.room().into_iter().collect();
            evicted.extend(t.admit(topic, rooms, now));
        }
        evicted
    }

    #[test]
    fn topics_are_named_topics_and_parse_to_one_shape() {
        assert_eq!(Topic::parse(" Chat:Billy "), Some(Topic::Stream("billy".into())));
        assert_eq!(Topic::parse("chat:cats/general"), Some(Topic::Channel("cats".into(), "general".into())));
        assert_eq!(Topic::parse("chat:cats/*"), Some(Topic::Every("cats".into())));
        assert_eq!(Topic::parse("presence:ann"), Some(Topic::Presence("ann".into())));
        assert_eq!(Topic::parse("streams:*"), Some(Topic::Streams));
        assert_eq!(Topic::parse("group:cats"), Some(Topic::Group("cats".into())));
        for bad in ["", "chat:", "chat:has space", "presence:*", "streams:ann", "room:ann", "group:", "ann"] {
            assert_eq!(Topic::parse(bad), None, "{bad}");
        }
        for t in ["chat:billy", "chat:cats/general", "chat:cats/*", "presence:ann", "streams:*", "group:cats"] {
            assert_eq!(Topic::parse(t).unwrap().key(), t);
        }
        assert_eq!(chat_topic("cats/general"), "chat:cats/general");
    }

    #[test]
    fn a_full_set_is_applied_as_a_diff_and_a_repeat_changes_nothing() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let plan = t.plan(&topics(&["chat:a", "presence:ann", "streams:*", "nonsense"]), now);
        assert_eq!(plan.join, vec![Topic::Stream("a".into())]);
        assert_eq!(plan.watch.len(), 2);
        assert_eq!(plan.refused, vec![Refusal { topic: "nonsense".into(), error: NO_SUCH_TOPIC }]);
        admit_all(&mut t, plan, now);
        let again = t.plan(&topics(&["chat:a", "presence:ann", "streams:*"]), now);
        assert!(again.join.is_empty() && again.watch.is_empty() && again.unwatch.is_empty() && again.refused.is_empty());
        let fewer = t.plan(&topics(&["presence:ann"]), now);
        assert_eq!(fewer.unwatch, vec![Topic::Streams]);
        assert!(!t.covers("a"));
        let mut subscribed: Vec<String> = t.subscribed().iter().map(Topic::key).collect();
        subscribed.sort();
        assert_eq!(subscribed, vec!["presence:ann"]);
    }

    #[test]
    fn a_dropped_unsubscribe_cannot_leak_because_the_next_set_says_it_all() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let plan = t.plan(&topics(&["chat:a", "chat:b", "presence:ann"]), now);
        admit_all(&mut t, plan, now);
        let plan = t.plan(&topics(&["chat:b"]), now);
        assert_eq!(plan.unwatch, vec![Topic::Presence("ann".into())]);
        assert_eq!(t.rooms().keys().cloned().collect::<Vec<_>>(), vec!["b".to_owned()]);
    }

    #[test]
    fn sixteen_chat_topics_and_the_oldest_is_evicted_until_there_is_room() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let mut want = streams(MAX_CHAT_TOPICS);
        let plan = t.plan(&want, now);
        assert!(admit_all(&mut t, plan, now).is_empty());
        want.push("chat:late".into());
        let plan = t.plan(&want, now);
        assert_eq!(admit_all(&mut t, plan, now), vec![Topic::Stream("room0".into())]);
        assert_eq!(t.chat_count(), MAX_CHAT_TOPICS);
        assert_eq!(t.evicted(), vec!["chat:room0"]);
        assert!(t.covers("late") && !t.covers("room0"));
        let plan = t.plan(&want, now);
        assert!(admit_all(&mut t, plan, now).is_empty(), "a repeat of the same set does not flap");
        assert_eq!(t.evicted(), vec!["chat:room0"]);
        want.retain(|w| w != "chat:room5");
        let plan = t.plan(&want, now);
        admit_all(&mut t, plan, now);
        assert!(t.covers("room0"), "an evicted topic comes back when there is room");
        assert!(t.evicted().is_empty());
        want.retain(|w| w != "chat:room0");
        t.plan(&want, now);
        assert!(t.evicted().is_empty(), "a topic nobody wants is forgotten");
    }

    #[test]
    fn more_than_sixteen_in_one_set_keeps_the_last_sixteen() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let want = streams(20);
        let plan = t.plan(&want, now);
        let evicted = admit_all(&mut t, plan, now);
        assert_eq!(evicted.len(), 4);
        assert_eq!(t.chat_count(), MAX_CHAT_TOPICS);
        assert!(t.covers("room19") && !t.covers("room3") && t.covers("room4"));
    }

    #[test]
    fn a_wildcard_holds_at_most_sixty_four_channels() {
        let channels: Vec<String> = (0..100).map(|i| format!("c{i}")).collect();
        let rooms = wildcard_rooms("cats", channels);
        assert_eq!(rooms.len(), MAX_PER_WILDCARD);
        assert_eq!(rooms[0], RoomRef { room: "cats/c0".into(), server: Some("cats".into()) });
    }

    #[test]
    fn a_wildcard_is_resolved_again_when_asked_or_after_a_minute() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let every = Topic::parse("chat:cats/*").unwrap();
        t.admit(every.clone(), wildcard_rooms("cats", vec!["general".into()]), now);
        t.admit(Topic::parse("chat:dogs").unwrap(), vec![], now);
        assert!(t.stale_wildcards(now, &[]).is_empty());
        assert_eq!(t.stale_wildcards(now, &["chat:cats/*".into(), "chat:dogs".into(), "junk".into()]), vec![every.clone()]);
        assert_eq!(t.stale_wildcards(now + WILDCARD_FRESH, &[]), vec![every]);
    }

    #[test]
    fn a_thousand_presence_topics_and_no_more() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let want: Vec<String> = (0..MAX_PRESENCE + 5).map(|i| format!("presence:p{i}")).collect();
        let plan = t.plan(&want, now);
        assert_eq!(plan.watch.len(), MAX_PRESENCE);
        assert_eq!(plan.refused.len(), 5);
        assert!(plan.refused.iter().all(|r| r.error == TOO_MANY));
        let again = t.plan(&want, now);
        assert!(again.watch.is_empty());
        assert_eq!(again.refused.len(), 5, "refused again, so the page sees why");
        let plan = t.plan(&want[1..].to_vec(), now);
        assert_eq!(plan.watch.len(), 1, "a slot freed is a slot filled");
    }

    #[test]
    fn sixty_new_topics_a_minute() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let want: Vec<String> = (0..70).map(|i| format!("group:g{i}")).collect();
        let plan = t.plan(&want, now);
        assert_eq!(plan.watch.len(), NEW_TOPICS_PER_MIN as usize);
        assert_eq!(plan.refused.len(), 10);
        assert!(plan.refused.iter().all(|r| r.error == SLOW));
        let later = t.plan(&want, now + RATE_WINDOW);
        assert_eq!(later.watch.len(), 10, "the refused come in when the minute turns");
        let presence: Vec<String> = (0..500).map(|i| format!("presence:p{i}")).collect();
        assert_eq!(t.plan(&[want, presence].concat(), now + RATE_WINDOW).watch.len(), 500, "presence is capped by count, not by rate");
    }

    fn sub(rev: u64, raw: &[&str]) -> SubFrame {
        SubFrame { rev, topics: topics(raw), since: HashMap::new(), fresh: Vec::new() }
    }

    #[test]
    fn duplicated_and_out_of_order_sub_frames_are_ignored() {
        let now = Instant::now();
        let mut g = SubGate::new(now);
        assert_eq!(g.offer(sub(3, &["chat:a"]), now).map(|s| s.rev), Some(3));
        assert!(g.offer(sub(2, &["chat:b"]), now).is_none(), "older");
        assert!(g.offer(sub(3, &["chat:b"]), now).is_none(), "duplicate");
        assert_eq!(g.offer(sub(7, &["chat:c"]), now).map(|s| s.rev), Some(7));
        assert_eq!(g.applied(), 7);
    }

    #[test]
    fn past_a_hundred_and_twenty_frames_a_minute_the_last_set_wins() {
        let now = Instant::now();
        let mut g = SubGate::new(now);
        for rev in 1..=SUB_FRAMES_PER_MIN as u64 {
            assert!(g.offer(sub(rev, &["chat:a"]), now).is_some());
        }
        let first = SUB_FRAMES_PER_MIN as u64;
        for rev in first + 1..first + 500 {
            assert!(g.offer(sub(rev, &[if rev % 2 == 0 { "chat:a" } else { "chat:b" }]), now).is_none());
        }
        assert_eq!(g.wake(), Some(now + RATE_WINDOW));
        assert!(g.due(now + Duration::from_secs(30)).is_none());
        let last = g.due(now + RATE_WINDOW).unwrap();
        assert_eq!(last.rev, first + 499);
        assert_eq!(last.topics, topics(&["chat:b"]));
        assert_eq!(g.wake(), None);
        assert!(g.offer(sub(first + 10, &["chat:a"]), now + RATE_WINDOW).is_none(), "nothing older than what was applied");
    }

    #[test]
    fn flapping_a_thousand_times_leaves_nothing() {
        let now = Instant::now();
        let mut t = Topics::new(now);
        let mut later = now;
        for n in 0..1000u32 {
            later += Duration::from_secs(2);
            let want = if n % 2 == 0 { topics(&["chat:a", "presence:ann", "group:cats"]) } else { Vec::new() };
            let plan = t.plan(&want, later);
            admit_all(&mut t, plan, later);
        }
        assert!(t.subscribed().is_empty());
        assert!(t.rooms().is_empty());
        assert!(t.evicted().is_empty());
    }

    #[tokio::test]
    async fn a_full_outbox_says_behind_and_keeps_what_it_holds() {
        let (out, mut rx) = Outbox::new();
        for _ in 0..OUT_QUEUE {
            assert!(out.put("{}".into()));
        }
        assert!(!out.put("{}".into()));
        tokio::time::timeout(Duration::from_secs(1), out.behind.notified()).await.expect("behind");
        let mut n = 0;
        while rx.try_recv().is_ok() {
            n += 1;
        }
        assert_eq!(n, OUT_QUEUE);
        assert!(out.put("{}".into()), "drained, it takes frames again");
    }

    #[tokio::test]
    async fn one_line_is_serialized_once_for_every_subscriber() {
        let (tx, _) = broadcast::channel::<Event>(16);
        let mut held = Vec::new();
        let mut outs = Vec::new();
        for _ in 0..3 {
            let (out, rx) = Outbox::new();
            held.push(forward("chat:a".into(), tx.subscribe(), out));
            outs.push(rx);
        }
        let f: Frame = frame(&RtOut::Delete { topic: "chat:a", id: "1-0" });
        assert!(tx.send(Event::Delete("1-0".into(), f.clone())).is_ok());
        for rx in &mut outs {
            let got = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();
            assert!(Arc::ptr_eq(&got, &f), "the same bytes, not a copy per socket");
        }
        drop(held);
    }

    #[tokio::test]
    async fn a_socket_killed_mid_join_gives_its_rooms_back_and_stops_its_forwarders() {
        let rooms = chat::Rooms::default();
        let (out, _rx) = Outbox::new();
        let mut held: HashMap<String, Held> = HashMap::new();
        let mut handles = Vec::new();
        for room in ["a", "b", "c"] {
            let Joined { rx, lease } = rooms.enter_for_test(room, "1.1.1.1");
            let f = forward(chat_topic(room).into(), rx, out.clone());
            handles.push(f.0.abort_handle());
            held.insert(room.to_owned(), Held { _forward: f, _lease: lease });
        }
        let task = tokio::spawn(async move {
            let _held = held;
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        assert_eq!(rooms.viewers("a"), 1);
        task.abort();
        let _ = task.await;
        assert!(rooms.is_empty(), "every lease came back");
        tokio::task::yield_now().await;
        assert!(handles.iter().all(|h| h.is_finished()), "and no forwarder outlives its socket");
    }

    #[tokio::test]
    async fn a_lagged_subscriber_is_told_there_is_a_gap() {
        let (tx, _) = broadcast::channel::<Event>(4);
        let (out, mut rx) = Outbox::new();
        let sub = tx.subscribe();
        for i in 0..10 {
            assert!(tx.send(Event::Count(i)).is_ok());
        }
        let _held = forward("chat:a".into(), sub, out);
        let first = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(v["type"], "gap");
        assert_eq!(v["topic"], "chat:a");
        assert_eq!(v["missed"], 6);
    }

    #[test]
    fn frames_on_the_wire() {
        let refused = [Refusal { topic: "chat:x".into(), error: NO_SUCH_CHANNEL }];
        let subbed = serde_json::to_value(RtOut::Subbed { rev: 4, topics: vec!["chat:a".into()], refused: &refused, evicted: vec!["chat:b".into()] }).unwrap();
        assert_eq!(subbed, json!({"type":"subbed","rev":4,"topics":["chat:a"],"refused":[{"topic":"chat:x","error":"no such channel"}],"evicted":["chat:b"]}));
        assert_eq!(serde_json::to_value(RtOut::Ack { rid: "r1", id: Some("1-0") }).unwrap(), json!({"type":"ack","rid":"r1","id":"1-0"}));
        assert_eq!(serde_json::to_value(RtOut::Nack { rid: "r1", error: "slow down", wait: Some(900) }).unwrap(), json!({"type":"nack","rid":"r1","error":"slow down","wait":900}));
        assert_eq!(serde_json::to_value(RtOut::Behind).unwrap(), json!({"type":"behind"}));
        assert_eq!(serde_json::to_value(RtOut::Gap { topic: "chat:a", missed: None }).unwrap(), json!({"type":"gap","topic":"chat:a"}));
        match serde_json::from_str::<In>(r#"{"type":"sub","rev":2,"topics":["chat:a"],"since":{"chat:a":"1-0"}}"#).unwrap() {
            In::Sub(s) => assert_eq!((s.rev, s.since.get("chat:a").map(String::as_str)), (2, Some("1-0"))),
            _ => panic!("a sub"),
        }
        assert!(matches!(serde_json::from_str::<In>(r#"{"type":"say","rid":"r","topic":"chat:a","text":"hi"}"#).unwrap(), In::Say { .. }));
        assert!(matches!(serde_json::from_str::<In>(r#"{"type":"auth","ticket":"00"}"#).unwrap(), In::Auth { .. }));
        assert!(matches!(serde_json::from_str::<In>(r#"{"type":"hello","nick":"ann","v":1}"#).unwrap(), In::Hello(_)));
    }

    #[test]
    fn a_ticket_is_thirty_two_hex() {
        assert!(valid_ticket(&"a".repeat(32)));
        assert!(!valid_ticket(&"a".repeat(31)));
        assert!(!valid_ticket(&"g".repeat(32)));
        assert!(!valid_ticket("../../etc"));
        assert_ne!(ticket_key("x"), "x");
    }
}
