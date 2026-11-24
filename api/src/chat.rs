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
use crate::timings::Redis;
use redis::streams::{StreamId, StreamMaxlen, StreamRangeReply, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{broadcast, mpsc, watch, Mutex};

use uuid::Uuid;

use crate::auth::{client_ip, is_claimed, whoami, NICK_HAS_ACCOUNT};
use crate::groups::{badges_of, Badge, BOT_GROUP};
use crate::history;
use crate::reactions::{self, Reaction};
use crate::socket::{first_text, id_parts, send, send_within, DRAIN_LIMIT, IDLE_LIMIT, MAX_FRAME_BYTES, PING_EVERY, READ_BLOCK_MS, SEND_TIMEOUT};
use crate::{owns_session, Name, Owner};

const HISTORY_LINES: usize = 200;
const KEEP_LINES: usize = 500;
pub(crate) const MAX_TEXT_CHARS: usize = 500;
const MAX_NICK_CHARS: usize = 24;
const ROOM_TTL_SECS: i64 = 7 * 24 * 3600;
const ANON_TIER: Tier = Tier { burst: 2.0, window: Duration::from_secs(60) };
const LOGIN_TIER: Tier = Tier { burst: 3.0, window: Duration::from_secs(10) };
const REACT_TIER: Tier = Tier { burst: 10.0, window: Duration::from_secs(10) };
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const SLOW_DOWN: &str = "slow down";
const MAX_SOCKETS_PER_IP: usize = 8;
const HISTORY_TIMEOUT: Duration = Duration::from_secs(60);
const EVERY_CHANNEL: &str = "*";
const FILL_LIMIT: usize = 100;

#[derive(Clone)]
pub(crate) struct ChatState {
    pub(crate) db: PgPool,
    pub(crate) redis: Redis,
    client: redis::Client,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    limiter: Arc<Limiter>,
    reacts: Arc<Limiter>,
    shutdown: watch::Receiver<bool>,
    dummy_prefix: String,
    pub(crate) persist: bool,
    admins: Vec<Uuid>,
}

impl ChatState {
    fn is_admin(&self, who: Option<&Who>) -> bool {
        who.and_then(|w| w.user_id).is_some_and(|id| self.is_admin_id(id))
    }

    pub(crate) fn is_admin_id(&self, id: Uuid) -> bool {
        self.admins.contains(&id)
    }
}

impl FromRef<ChatState> for PgPool {
    fn from_ref(s: &ChatState) -> PgPool {
        s.db.clone()
    }
}

struct Room {
    tx: broadcast::Sender<Event>,
    count: usize,
    per_ip: HashMap<String, usize>,
}

#[derive(Clone)]
enum Event {
    Line(Arc<Line>),
    Count(usize),
    React(Arc<React>),
    Delete(Arc<str>),
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Line {
    pub(crate) id: String,
    pub(crate) from: String,
    pub(crate) text: String,
    pub(crate) streamer: bool,
    pub(crate) verified: bool,
    pub(crate) groups: Vec<Badge>,
    pub(crate) avatar: Option<i64>,
    pub(crate) oauth_verified: bool,
    #[serde(skip)]
    pub(crate) user_id: Option<Uuid>,
    pub(crate) at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) image: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) images: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) video: Option<Video>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reply: Option<Reply>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) reactions: Vec<Reaction>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct React {
    pub(crate) id: String,
    pub(crate) emoji: String,
    pub(crate) who: String,
    pub(crate) on: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Video {
    pub(crate) id: String,
    pub(crate) poster: String,
}

impl Video {
    pub(crate) fn parse(raw: Option<&str>) -> Option<Video> {
        let (id, poster) = raw?.split_once(',')?;
        let (id, poster) = (Uuid::parse_str(id.trim()).ok()?, Uuid::parse_str(poster.trim()).ok()?);
        Some(Video { id: id.to_string(), poster: poster.to_string() })
    }

    pub(crate) fn stored(&self) -> String {
        format!("{},{}", self.id, self.poster)
    }
}

const REPLY_QUOTE_CHARS: usize = 120;
pub(crate) const NO_SUCH_LINE: &str = "no such line";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Reply {
    pub(crate) id: String,
    pub(crate) from: String,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) streamer: bool,
    #[serde(default)]
    pub(crate) verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) avatar: Option<i64>,
    #[serde(default)]
    pub(crate) images: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) video: bool,
}

impl Reply {
    pub(crate) fn of(line: &Line) -> Reply {
        Reply {
            id: line.id.clone(),
            from: line.from.clone(),
            text: line.text.chars().take(REPLY_QUOTE_CHARS).collect(),
            streamer: line.streamer,
            verified: line.verified,
            avatar: line.avatar,
            images: line.images.len(),
            video: line.video.is_some(),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum In {
    Hello(Hello),
    Say {
        text: String,
        #[serde(default)]
        image: Option<String>,
        #[serde(default)]
        images: Vec<String>,
        #[serde(default)]
        video: Option<String>,
        #[serde(default)]
        channel: Option<String>,
        #[serde(default)]
        reply: Option<String>,
    },
    Join { channel: String },
    Since { since: HashMap<String, String> },
    React {
        id: String,
        emoji: String,
        on: bool,
        #[serde(default)]
        channel: Option<String>,
    },
}

#[derive(Deserialize)]
struct Hello {
    nick: Option<String>,
    session: Option<i64>,
    token: Option<i64>,
    bot: Option<bool>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Out<'a> {
    History { messages: &'a [Line] },
    Message(&'a Line),
    Count { count: usize },
    #[serde(rename = "message")]
    ChannelMessage {
        channel: &'a str,
        #[serde(flatten)]
        line: &'a Line,
    },
    #[serde(rename = "count")]
    ChannelCount { channel: &'a str, count: usize },
    Error { error: &'a str },
    #[serde(rename = "error")]
    Slow { error: &'a str, wait: u64 },
    React(&'a React),
    Delete { id: &'a str },
    #[serde(rename = "delete")]
    ChannelDelete { channel: &'a str, id: &'a str },
    #[serde(rename = "react")]
    ChannelReact {
        channel: &'a str,
        #[serde(flatten)]
        react: &'a React,
    },
    #[serde(rename = "error")]
    ReactRefused {
        error: &'a str,
        react: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        wait: Option<u64>,
    },
}

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
    let admin_names: Vec<String> = std::env::var("ADMIN_NAMES")
        .unwrap_or_default()
        .split(',')
        .map(|n| n.trim().to_lowercase())
        .filter(|n| crate::valid_name(n))
        .collect();
    let admins: Vec<Uuid> = crate::debug::admins_with_accounts(&db, admin_names).await?.into_iter().map(|a| a.id).collect();
    let limits = crate::ratelimit::ByIp { redis: redis.clone(), rule: crate::ratelimit::chat_rule };
    let state = ChatState {
        db,
        redis,
        client,
        rooms: Arc::new(Mutex::new(HashMap::new())),
        limiter: Arc::new(Limiter::new()),
        reacts: Arc::new(Limiter::for_reactions()),
        shutdown,
        dummy_prefix,
        persist,
        admins,
    };
    let rooms = state.rooms.clone();

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/chat/{name}", get(ws))
        .route("/chat/{server}/{channel}", get(ws_channel))
        .merge(history::routes())
        .route_layer(axum::middleware::from_fn_with_state(limits, crate::ratelimit::by_ip))
        .layer(axum::middleware::map_response(crate::media::no_store_by_default))
        .layer(axum::middleware::from_fn(crate::timings::http))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!("chat on {addr}");
    crate::timings::serve();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            crate::wait_for_signal().await;
            let _ = stop.send(true);
        })
        .await?;
    let deadline = Instant::now() + DRAIN_LIMIT;
    while !rooms.lock().await.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

async fn ws(State(s): State<ChatState>, Name(name): Name, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let ip = client_ip(&headers);
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(s, name, None, ip, headers, socket))
}

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

fn refuse(upgrade: WebSocketUpgrade, err: crate::ApiError) -> Response {
    let message = err.message().to_owned();
    upgrade.on_upgrade(move |mut socket| async move {
        let _ = send(&mut socket, &Out::Error { error: &message }).await;
    })
}

async fn server_of(db: &PgPool, raw: &str) -> Result<String, crate::ApiError> {
    let (server, _) = crate::groups::channel_names(raw, "general")?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE name = $1)").bind(&server).fetch_one(db).await?;
    if !exists {
        return Err(crate::ApiError::new(axum::http::StatusCode::NOT_FOUND, "not a server"));
    }
    Ok(server)
}

struct Who {
    from: String,
    streamer: bool,
    verified: bool,
    groups: Vec<Badge>,
    user_id: Option<Uuid>,
}

impl Who {
    fn is_bot(&self) -> bool {
        self.groups.iter().any(|g| g.name == BOT_GROUP)
    }
}

enum Unknown {
    Refused(&'static str),
    Busy,
}

async fn identify(s: &ChatState, room: &str, headers: &HeaderMap, hello: &Hello) -> Result<Who, Unknown> {
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
        if lower.starts_with(&s.dummy_prefix) {
            return Err(Unknown::Refused("that nick belongs to the fake streams. pick another"));
        }
        match is_claimed(&s.db, &lower).await {
            Ok(false) => nick,
            Ok(true) => return Err(Unknown::Refused(NICK_HAS_ACCOUNT)),
            Err(e) => {
                log::warn!("{room}: cannot check whether {nick} is claimed: {e}");
                return Err(Unknown::Busy);
            }
        }
    };
    let verified = me.as_ref().is_some_and(|a| a.name == from);
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

async fn face_now(db: &PgPool, room: &str, w: &Who) -> Face {
    const BY_ID: &str = concat!("SELECT (EXTRACT(EPOCH FROM s.avatar_at))::bigint, ", crate::oauth::linked_sql!("s"), " FROM streamers s WHERE s.id = $1");
    const BY_NAME: &str = concat!("SELECT (EXTRACT(EPOCH FROM s.avatar_at))::bigint, ", crate::oauth::linked_sql!("s"), " FROM streamers s WHERE s.name = $1");
    let query = match (w.user_id, w.streamer) {
        (Some(id), _) => sqlx::query_as(BY_ID).bind(id),
        (None, true) => sqlx::query_as(BY_NAME).bind(&w.from),
        (None, false) => return Face::default(),
    };
    let looked: Result<Result<Option<FaceRow>, sqlx::Error>, _> = tokio::time::timeout(Duration::from_secs(2), query.fetch_optional(db)).await;
    match looked {
        Ok(Ok(row)) => row.map(|(avatar, oauth_verified)| Face { avatar, oauth_verified }).unwrap_or_default(),
        Ok(Err(e)) => {
            log::warn!("{room}: cannot read the picture of {}: {e}", w.from);
            Face::default()
        }
        Err(_) => {
            log::warn!("{room}: reading the picture of {} timed out", w.from);
            Face::default()
        }
    }
}

type FaceRow = (Option<i64>, bool);

type FacesRow = (Uuid, String, Option<i64>, Vec<String>, bool);

#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
struct Face {
    avatar: Option<i64>,
    oauth_verified: bool,
}

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
    let rows: Vec<FacesRow> = match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query_as(concat!(
            "SELECT s.id, s.name, (EXTRACT(EPOCH FROM s.avatar_at))::bigint,
                    ARRAY(SELECT h.name FROM held_names h WHERE h.user_id = s.id AND h.until > now())::text[], ",
            crate::oauth::linked_sql!("s"),
            " FROM streamers s WHERE s.id = ANY($1::uuid[]) OR s.name = ANY($2::text[])",
        ))
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
        let row = match face_key(line) {
            Some(FaceKey::Id(id)) => rows
                .iter()
                .find(|(row, _, _, _, _)| *row == id)
                .filter(|(_, name, _, held, _)| *name == line.from || held.iter().any(|h| *h == line.from)),
            Some(FaceKey::Name(name)) => rows.iter().find(|(_, row, _, _, _)| row == name),
            None => continue,
        };
        line.avatar = row.and_then(|(_, _, v, _, _)| *v);
        line.oauth_verified = row.is_some_and(|(_, _, _, _, linked)| *linked);
    }
}

async fn handle(s: ChatState, name: String, server: Option<String>, ip: String, headers: HeaderMap, mut socket: WebSocket) {
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
    if let Some(server) = &server {
        let channel = name.strip_prefix(server.as_str()).and_then(|rest| rest.strip_prefix('/')).unwrap_or("");
        let user = who.as_ref().and_then(|w| w.user_id);
        match crate::groups::may_see_text(&s.db, server, channel, user, s.is_admin(who.as_ref())).await {
            Ok(true) => {}
            Ok(false) => {
                let _ = send(&mut socket, &Out::Error { error: "no such channel" }).await;
                return;
            }
            Err(e) => {
                log::warn!("{name}: cannot read the channel's roles: {e}");
                let _ = send(&mut socket, &Out::Error { error: "chat is busy, try again" }).await;
                return;
            }
        }
    }

    let Some(mut rx) = s.join(&name, &ip).await else {
        let _ = send(&mut socket, &Out::Error { error: "too many tabs" }).await;
        return;
    };
    let history = history(&s, &name, viewer_of(&who)).await.unwrap_or_default();
    let mut last_seen = history.last().map(|l| id_parts(&l.id)).unwrap_or((0, 0));
    if send_within(&mut socket, &Out::History { messages: &history }, HISTORY_TIMEOUT).await.is_err() {
        s.leave(&name, &ip).await;
        return;
    }
    let shown = |who: &Option<Who>| match who {
        Some(w) => format!("{}{}{}", w.from, if w.streamer { " (streamer)" } else { "" }, if w.is_bot() { " (bot)" } else { "" }),
        None => "somebody (database down, reading only)".to_owned(),
    };
    log::info!("{name}: {} joined", shown(&who));

    let mut speaker = Speaker::of(who.as_ref(), &hello, &ip);
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
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
                Ok(Event::React(react)) => {
                    if send(&mut socket, &Out::React(&react)).await.is_err() { break; }
                }
                Ok(Event::Delete(id)) => {
                    if send(&mut socket, &Out::Delete { id: &id }).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
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
                let (text, image, images, video, reply) = match serde_json::from_str::<In>(&text) {
                    Ok(In::Say { text, image, images, video, reply, .. }) => (text, image, images, video, reply),
                    Ok(In::React { id, emoji, on, .. }) => {
                        let reacted = on_react(&s, &name, &name, server.as_deref(), &mut who, &mut speaker, (&headers, &hello, &ip), (&id, &emoji, on)).await;
                        if let Err((error, wait)) = reacted {
                            let _ = send(&mut socket, &Out::ReactRefused { error, react: &id, wait }).await;
                        }
                        continue;
                    }
                    _ => continue,
                };
                let (text, images, video) = match parse_say(text, image, images, video) {
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
                if let Err(why) = accept(&s, &name, server.as_deref(), w, &text, &images, video.as_deref(), reply.as_deref()).await {
                    let _ = send(&mut socket, &why.frame()).await;
                    continue;
                }
            }
        }
    }

    s.leave(&name, &ip).await;
    log::info!("{name}: {} left", shown(&who));
}

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

    fn take(&mut self, tier: Tier, now: Instant) -> Result<(), Duration> {
        self.refill(tier, now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return Ok(());
        }
        Err(Duration::from_secs_f64((1.0 - self.tokens) / tier.per_sec()))
    }

    fn is_full(&self, tier: Tier, now: Instant) -> bool {
        self.tokens + now.duration_since(self.at).as_secs_f64() * tier.per_sec() >= tier.burst
    }
}

#[derive(Hash, PartialEq, Eq, Clone, Debug)]
enum Speaker {
    Account(Uuid),
    Streamer(String),
    Nick(String, String),
}

impl Speaker {
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

struct Limiter {
    inner: std::sync::Mutex<Buckets>,
    tier: fn(&Speaker) -> Tier,
}

struct Buckets {
    by_speaker: HashMap<(Speaker, String), Bucket>,
    swept: Instant,
}

impl Limiter {
    fn new() -> Self {
        Limiter { inner: std::sync::Mutex::new(Buckets { by_speaker: HashMap::new(), swept: Instant::now() }), tier: Speaker::tier }
    }

    fn for_reactions() -> Self {
        Limiter { tier: |_| REACT_TIER, ..Limiter::new() }
    }

    fn take(&self, speaker: &Speaker, room: &str) -> Result<(), Duration> {
        self.take_at(speaker, room, Instant::now())
    }

    fn take_at(&self, speaker: &Speaker, room: &str, now: Instant) -> Result<(), Duration> {
        let tier = (self.tier)(speaker);
        let mut inner = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Buckets { by_speaker, swept } = &mut *inner;
        if now.duration_since(*swept) >= SWEEP_EVERY {
            *swept = now;
            by_speaker.retain(|(speaker, _), bucket| !bucket.is_full((self.tier)(speaker), now));
        }
        by_speaker.entry((speaker.clone(), room.to_owned())).or_insert_with(|| Bucket::new(tier, now)).take(tier, now)
    }
}

#[allow(clippy::type_complexity)]
fn parse_say(text: String, image: Option<String>, images: Vec<String>, video: Option<String>) -> Result<Option<(String, Vec<String>, Option<String>)>, &'static str> {
    let text = clean_text(&text);
    let images = picture_ids(image, images)?;
    let video = video_id(video)?;
    let chars = crate::emotes::shown_chars(&text);
    if chars == 0 && images.is_empty() && video.is_none() {
        return Ok(None);
    }
    if chars > MAX_TEXT_CHARS || text.chars().count() > crate::emotes::max_raw_chars(MAX_TEXT_CHARS) {
        return Err("too long");
    }
    Ok(Some((text, images, video)))
}

pub(crate) fn video_id(video: Option<String>) -> Result<Option<String>, &'static str> {
    match video.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(raw) => Uuid::parse_str(raw).map(|id| Some(id.to_string())).map_err(|_| "bad video"),
    }
}

async fn video_of(db: &sqlx::PgPool, name: &str, id: Option<&str>, who: Option<Uuid>) -> Result<Option<Video>, &'static str> {
    let Some(id) = id else { return Ok(None) };
    let busy = |e: sqlx::Error| {
        log::warn!("{name}: video: {e}");
        "chat is busy, try again"
    };
    match crate::media::check(db, crate::media::Kind::Video, id, who).await.map_err(busy)? {
        Ok(()) => {}
        Err(crate::media::Refusal::Missing) => return Err("no such video"),
        Err(crate::media::Refusal::NotYours) => return Err(NOT_YOUR_VIDEO),
    }
    match crate::chat_videos::poster_of(db, id).await.map_err(busy)? {
        Some(poster) => Ok(Some(Video { id: id.to_owned(), poster: poster.to_string() })),
        None => Err("no such video"),
    }
}

pub(crate) const NOT_YOUR_PICTURE: &str = "not your picture";
pub(crate) const NOT_YOUR_VIDEO: &str = "not your video";

const STREAM_CHAT_VIDEO: bool = false;
const NO_STREAM_VIDEO: &str = "videos are off in stream chat for now";

fn stream_video_refusal(server: Option<&str>, video: Option<&str>, on: bool) -> Option<&'static str> {
    (server.is_none() && video.is_some() && !on).then_some(NO_STREAM_VIDEO)
}

pub(crate) async fn mark_posted(db: &sqlx::PgPool, place: &crate::media::Place, images: &[String], video: Option<&Video>) -> Result<(), sqlx::Error> {
    use crate::media::{mark_posted, Kind};
    let mut pictures: Vec<&str> = images.iter().map(String::as_str).collect();
    if let Some(video) = video {
        pictures.push(&video.poster);
        mark_posted(db, Kind::Video, &[&video.id], place).await?;
    }
    mark_posted(db, Kind::Image, &pictures, place).await
}

enum Refused {
    Words(&'static str),
    Wait(&'static str, u64),
}

impl Refused {
    fn frame(&self) -> Out<'static> {
        match self {
            Refused::Words(error) => Out::Error { error },
            Refused::Wait(error, wait) => Out::Slow { error, wait: *wait },
        }
    }
}

impl From<&'static str> for Refused {
    fn from(words: &'static str) -> Self {
        Refused::Words(words)
    }
}

const TIMED_OUT: &str = "timed out";
const COOLDOWN: &str = "cooldown";
const CHANNEL_COOLDOWN: &str = "channel cooldown";

type Standing = (bool, bool, Option<i64>, i32, i32);

#[allow(clippy::too_many_arguments)]
async fn accept(s: &ChatState, room: &str, server: Option<&str>, w: &Who, text: &str, images: &[String], video: Option<&str>, reply: Option<&str>) -> Result<(), Refused> {
    let mut cooldowns: Vec<(String, i64, &'static str)> = Vec::new();
    if let Some(server) = server {
        let Some(id) = w.user_id else { return Err("join the server first".into()) };
        let channel = room.strip_prefix(server).and_then(|rest| rest.strip_prefix('/')).unwrap_or("");
        let standing: Result<Option<Standing>, sqlx::Error> = sqlx::query_as(
            "SELECT m.owner,
                    EXISTS (SELECT 1 FROM role_members rm JOIN roles r ON r.id = rm.role_id
                             WHERE rm.user_id = $1 AND r.group_name = $2 AND (r.perms & 4) <> 0),
                    (SELECT (EXTRACT(EPOCH FROM (t.until - now())) * 1000)::bigint FROM timeouts t
                      WHERE t.group_name = $2 AND t.user_id = $1 AND t.until > now()),
                    (SELECT COALESCE(max(r.cooldown), 0) FROM role_members rm JOIN roles r ON r.id = rm.role_id
                      WHERE rm.user_id = $1 AND r.group_name = $2),
                    COALESCE((SELECT c.cooldown FROM channels c WHERE c.server = $2 AND c.name = $3 AND c.kind = 'text'), 0)
             FROM memberships m WHERE m.user_id = $1 AND m.group_name = $2",
        )
        .bind(id)
        .bind(server)
        .bind(channel)
        .fetch_optional(&s.db)
        .await;
        let (owner, manages, timed_out, role_secs, channel_secs) = match standing {
            Ok(Some(standing)) => standing,
            Ok(None) => return Err("join the server first".into()),
            Err(e) => {
                log::warn!("{room}: membership: {e}");
                return Err("chat is busy, try again".into());
            }
        };
        if let Some(ms) = timed_out {
            return Err(Refused::Wait(TIMED_OUT, ms.max(1) as u64));
        }
        let free = owner || s.is_admin(Some(w));
        if role_secs > 0 && !free {
            cooldowns.push((format!("cd:{server}:{id}"), i64::from(role_secs) * 1000, COOLDOWN));
        }
        if channel_secs > 0 && !free && !manages {
            cooldowns.push((format!("cdc:{room}:{id}"), i64::from(channel_secs) * 1000, CHANNEL_COOLDOWN));
        }
    }
    if server.is_none() {
        if let Some(refused) = stream_refusal(s, room, w).await {
            return Err(refused);
        }
    }
    if let Some(words) = stream_video_refusal(server, video, STREAM_CHAT_VIDEO) {
        return Err(words.into());
    }
    let uploader = w.user_id.filter(|_| w.verified);
    pictures_exist(&s.db, room, images, uploader).await?;
    let video = video_of(&s.db, room, video, uploader).await?;
    pictures_allowed(&s.db, room, server, images, video.as_ref()).await?;
    let settled = crate::emotes::settle(&s.db, w.user_id.filter(|_| w.verified), text).await;
    let text = settled.as_str();
    let reply = match reply {
        Some(id) => Some(reply_to(s, room, id).await?),
        None => None,
    };
    let face = face_now(&s.db, room, w).await;
    let avatar = face.avatar.map(|v| v.to_string());
    let mut r = s.redis.clone();
    if !cooldowns.is_empty() {
        let mut look = redis::pipe();
        for (key, _, _) in &cooldowns {
            look.cmd("PTTL").arg(key);
        }
        let left: Vec<i64> = match look.query_async(&mut r).await {
            Ok(left) => left,
            Err(e) => {
                log::warn!("{room}: cooldown: {e}");
                return Err("chat is down, try again".into());
            }
        };
        if let Some((ms, words)) = cooldowns.iter().zip(&left).filter(|(_, ms)| **ms > 0).map(|((_, _, words), ms)| (*ms, *words)).max() {
            return Err(Refused::Wait(words, ms as u64));
        }
        let mut set = redis::pipe();
        for (key, ms, _) in &cooldowns {
            set.cmd("SET").arg(key).arg("1").arg("PX").arg(*ms).ignore();
        }
        if let Err(e) = set.query_async::<()>(&mut r).await {
            log::warn!("{room}: cooldown: {e}");
            return Err("chat is down, try again".into());
        }
    }
    if !images.is_empty() || video.is_some() {
        if let Err(e) = mark_posted(&s.db, &crate::media::Place::room(room, server), images, video.as_ref()).await {
            log::warn!("{room}: posted: {e}");
            return Err("chat is busy, try again".into());
        }
    }
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
    if face.oauth_verified {
        fields.push(("o", "1"));
    }
    if let Some(image) = images.first() {
        fields.push(("img", image.as_str()));
    }
    let rest = if images.len() > 1 { Some(images[1..].join(",")) } else { None };
    if let Some(rest) = &rest {
        fields.push(("imgs", rest.as_str()));
    }
    let vid = video.as_ref().map(Video::stored);
    if let Some(vid) = &vid {
        fields.push(("vid", vid.as_str()));
    }
    let quoted = reply.as_ref().and_then(|r| serde_json::to_string(r).ok());
    if let Some(quoted) = &quoted {
        fields.push(("r", quoted.as_str()));
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
            return Err("chat is down, try again".into());
        }
    };
    if s.persist {
        if let Some(id) = id {
            remember(s, room, &id, w, text, images, vid.as_deref(), reply);
        }
    }
    if let (Some(server), Some(actor)) = (server, w.user_id) {
        notify_members(s, server, room, actor, text);
    }
    Ok(())
}

const BANNED: &str = "you are banned from this chat";

async fn stream_refusal(s: &ChatState, room: &str, w: &Who) -> Option<Refused> {
    let user = w.user_id.filter(|_| w.verified && !w.streamer)?;
    let standing: Result<(bool, Option<i64>), sqlx::Error> = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM stream_bans b JOIN streamers r ON r.id = b.stream_id WHERE r.name = $1 AND b.user_id = $2),
                (SELECT (EXTRACT(EPOCH FROM (t.until - now())) * 1000)::bigint FROM stream_timeouts t JOIN streamers r ON r.id = t.stream_id
                  WHERE r.name = $1 AND t.user_id = $2 AND t.until > now())",
    )
    .bind(room)
    .bind(user)
    .fetch_one(&s.db)
    .await;
    match standing {
        Ok((true, _)) => Some(BANNED.into()),
        Ok((false, Some(ms))) => Some(Refused::Wait(TIMED_OUT, ms.max(1) as u64)),
        Ok((false, None)) => None,
        Err(e) => {
            log::warn!("{room}: bans: {e}");
            Some("chat is busy, try again".into())
        }
    }
}

pub(crate) async fn remove_line(db: &PgPool, r: &mut Redis, room: &str, id: &str) -> Result<(), crate::ApiError> {
    let _: i64 = r.xdel(room_key(room), &[id]).await?;
    sqlx::query("DELETE FROM chat_lines WHERE room = $1 AND id = $2").bind(room).bind(id).execute(db).await?;
    sqlx::query("DELETE FROM chat_reactions WHERE room = $1 AND line_id = $2").bind(room).bind(id).execute(db).await?;
    let key = react_key(room);
    let _: (Option<String>, bool) = redis::pipe()
        .atomic()
        .xadd_maxlen(&key, StreamMaxlen::Approx(KEEP_REACTS), "*", &[("del", id)])
        .expire(&key, ROOM_TTL_SECS)
        .query_async(r)
        .await?;
    Ok(())
}

async fn reply_to(s: &ChatState, room: &str, id: &str) -> Result<Reply, Refused> {
    if !is_stream_id(id) {
        return Err(NO_SUCH_LINE.into());
    }
    match history::line_at(&s.db, &mut s.redis.clone(), room, id).await {
        Ok(Some(line)) => Ok(Reply::of(&line)),
        Ok(None) => Err(NO_SUCH_LINE.into()),
        Err(_) => Err("chat is busy, try again".into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn on_react(
    s: &ChatState,
    at: &str,
    room: &str,
    server: Option<&str>,
    who: &mut Option<Who>,
    speaker: &mut Speaker,
    (headers, hello, ip): (&HeaderMap, &Hello, &str),
    (id, emoji, on): (&str, &str, bool),
) -> Result<(), (&'static str, Option<u64>)> {
    if !is_stream_id(id) {
        return Err((NO_SUCH_LINE, None));
    }
    let Some(emoji) = reactions::shaped(emoji) else {
        return Err((reactions::NOT_A_REACTION, None));
    };
    if let Err(wait) = s.reacts.take(speaker, at) {
        return Err((SLOW_DOWN, Some((wait.as_secs_f64() * 1000.0).ceil() as u64)));
    }
    if who.is_none() {
        if let Ok(w) = identify(s, at, headers, hello).await {
            *speaker = Speaker::of(Some(&w), hello, ip);
            *who = Some(w);
        }
    }
    let Some(w) = who.as_ref() else { return Err(("chat is busy, try again", None)) };
    react(s, room, server, w, id, &emoji, on).await.map_err(|why| (why, None))
}

async fn react(s: &ChatState, room: &str, server: Option<&str>, w: &Who, id: &str, emoji: &str, on: bool) -> Result<(), &'static str> {
    let Some(user) = w.user_id.filter(|_| w.verified) else { return Err(reactions::LOG_IN) };
    if let Some(server) = server {
        let timed_out: Result<Option<bool>, sqlx::Error> = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM timeouts t WHERE t.group_name = $2 AND t.user_id = $1 AND t.until > now())
             FROM memberships m WHERE m.user_id = $1 AND m.group_name = $2",
        )
        .bind(user)
        .bind(server)
        .fetch_optional(&s.db)
        .await;
        match timed_out {
            Ok(Some(false)) => {}
            Ok(Some(true)) => return Err(TIMED_OUT),
            Ok(None) => return Err("join the server first"),
            Err(e) => {
                log::warn!("{room}: membership: {e}");
                return Err("chat is busy, try again");
            }
        }
    }
    if server.is_none() {
        match stream_refusal(s, room, w).await {
            None => {}
            Some(Refused::Wait(words, _) | Refused::Words(words)) => return Err(words),
        }
    }
    if on {
        match reactions::may_put(&s.db, user, emoji).await {
            Ok(true) => {}
            Ok(false) => return Err(reactions::NOT_YOURS),
            Err(e) => {
                log::warn!("{room}: reaction emote: {e}");
                return Err("chat is busy, try again");
            }
        }
    }
    if on {
        match history::line_at(&s.db, &mut s.redis.clone(), room, id).await {
            Ok(Some(_)) => {}
            Ok(None) => return Err(NO_SUCH_LINE),
            Err(_) => return Err("chat is busy, try again"),
        }
    }
    match reactions::set_line(&s.db, room, id, user, emoji, on).await {
        Ok(reactions::Set::Changed) => {}
        Ok(reactions::Set::Same) => return Ok(()),
        Ok(reactions::Set::TooMany) => return Err(reactions::TOO_MANY),
        Err(e) => {
            log::warn!("{room}: reaction: {e}");
            return Err("chat is busy, try again");
        }
    }
    let key = react_key(room);
    let fields = [("l", id), ("e", emoji), ("w", w.from.as_str()), ("on", if on { "1" } else { "0" })];
    let added: Result<(Option<String>, bool), _> = redis::pipe()
        .atomic()
        .xadd_maxlen(&key, StreamMaxlen::Approx(KEEP_REACTS), "*", &fields)
        .expire(&key, ROOM_TTL_SECS)
        .query_async(&mut s.redis.clone())
        .await;
    if let Err(e) = added {
        log::warn!("{room}: reaction xadd: {e}");
    }
    Ok(())
}

const NOTIFY_LIMIT: Duration = Duration::from_secs(5);

fn notify_members(s: &ChatState, server: &str, room: &str, actor: Uuid, text: &str) {
    let Some(channel) = room.strip_prefix(server).and_then(|rest| rest.strip_prefix('/')) else { return };
    let db = s.db.clone();
    let redis = s.redis.clone();
    let admins = s.admins.clone();
    let server = server.to_owned();
    let channel = channel.to_owned();
    let text = text.to_owned();
    tokio::spawn(async move {
        if tokio::time::timeout(NOTIFY_LIMIT, crate::notify::channel_line(&db, &redis, &server, &channel, actor, &text, &admins)).await.is_err() {
            log::warn!("{server}/{channel}: the inbox rows for a line timed out");
        }
    });
}

type Tagged = (Arc<str>, Result<Event, u64>);

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

fn is_stream_id(id: &str) -> bool {
    let mut parts = id.split('-');
    let (Some(ms), Some(seq), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    !ms.is_empty() && !seq.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) && seq.bytes().all(|b| b.is_ascii_digit())
}

async fn after(s: &ChatState, room: &str, id: &str, viewer: Option<Uuid>) -> Vec<Line> {
    let mut r = s.redis.clone();
    let reply: Result<StreamRangeReply, _> = r.xrange_count(room_key(room), format!("({id}"), "+", FILL_LIMIT).await;
    match reply {
        Ok(reply) => {
            let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
            with_faces(&s.db, &mut lines).await;
            reactions::with_reactions(&s.db, viewer, lines.iter_mut().map(|l| (room, l))).await;
            lines
        }
        Err(e) => {
            log::warn!("{room}: xrange: {e}");
            Vec::new()
        }
    }
}

async fn handle_server(s: ChatState, server: String, ip: String, headers: HeaderMap, mut socket: WebSocket) {
    let name = format!("{server}/{EVERY_CHANNEL}");
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

    let channels: Vec<String> = match crate::groups::visible_text_channels(&s.db, &server, who.as_ref().and_then(|w| w.user_id), s.is_admin(who.as_ref())).await {
        Ok(channels) => channels,
        Err(e) => {
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
                Some((channel, Ok(Event::React(react)))) => {
                    if send(&mut socket, &Out::ChannelReact { channel: &channel, react: &react }).await.is_err() { break; }
                }
                Some((channel, Ok(Event::Delete(id)))) => {
                    if send(&mut socket, &Out::ChannelDelete { channel: &channel, id: &id }).await.is_err() { break; }
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
                        for (channel, id) in since {
                            let Some(channel) = joined.iter().find(|c| c.as_ref() == channel).cloned() else { continue };
                            if !is_stream_id(&id) { continue; }
                            let floor = id_parts(&id);
                            if last_seen.get(&channel).is_some_and(|seen| *seen >= floor) { continue; }
                            last_seen.insert(channel.clone(), floor);
                            let room = format!("{server}/{channel}");
                            let mut failed = false;
                            for line in after(&s, &room, &id, viewer_of(&who)).await {
                                let id = id_parts(&line.id);
                                if last_seen.get(&channel).is_some_and(|seen| id <= *seen) { continue; }
                                last_seen.insert(channel.clone(), id);
                                if send(&mut socket, &Out::ChannelMessage { channel: &channel, line: &line }).await.is_err() { failed = true; break; }
                            }
                            if failed { break; }
                        }
                    }
                    Ok(In::Join { channel }) => {
                        let channel = channel.trim().to_lowercase();
                        if joined.iter().any(|c| c.as_ref() == channel) { continue; }
                        if let Err(wait) = s.limiter.take(&speaker, &name) {
                            let _ = send(&mut socket, &slow(wait)).await;
                            continue;
                        }
                        let user = who.as_ref().and_then(|w| w.user_id);
                        let seen = crate::groups::channel_names(&server, &channel).is_ok()
                            && crate::groups::may_see_text(&s.db, &server, &channel, user, s.is_admin(who.as_ref())).await.unwrap_or(false);
                        if seen && !follow(&s, &server, &channel, &ip, &tx, &mut joined).await {
                            let _ = send(&mut socket, &Out::Error { error: "too many tabs" }).await;
                        }
                    }
                    Ok(In::React { id, emoji, on, channel }) => {
                        let Some(channel) = channel.map(|c| c.trim().to_lowercase()).filter(|c| joined.iter().any(|j| j.as_ref() == c)) else {
                            let _ = send(&mut socket, &Out::ReactRefused { error: "say which channel", react: &id, wait: None }).await;
                            continue;
                        };
                        let room = format!("{server}/{channel}");
                        let reacted = on_react(&s, &name, &room, Some(&server), &mut who, &mut speaker, (&headers, &hello, &ip), (&id, &emoji, on)).await;
                        if let Err((error, wait)) = reacted {
                            let _ = send(&mut socket, &Out::ReactRefused { error, react: &id, wait }).await;
                        }
                    }
                    Ok(In::Say { text, image, images, video, channel, reply }) => {
                        let Some(channel) = channel.map(|c| c.trim().to_lowercase()).filter(|c| joined.iter().any(|j| j.as_ref() == c)) else {
                            let _ = send(&mut socket, &Out::Error { error: "say which channel" }).await;
                            continue;
                        };
                        let (text, images, video) = match parse_say(text, image, images, video) {
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
                        if let Err(why) = accept(&s, &room, Some(&server), w, &text, &images, video.as_deref(), reply.as_deref()).await {
                            let _ = send(&mut socket, &why.frame()).await;
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

#[allow(clippy::too_many_arguments)]
fn remember(s: &ChatState, room: &str, id: &str, w: &Who, text: &str, images: &[String], video: Option<&str>, reply: Option<Reply>) {
    let db = s.db.clone();
    let room = room.to_owned();
    let id = id.to_owned();
    let speaker = w.from.clone();
    let user_id = w.user_id;
    let text = text.to_owned();
    let image = if images.is_empty() { None } else { Some(images.join(",")) };
    let video = video.map(str::to_owned);
    let streamer = w.streamer;
    let verified = w.verified;
    let groups = w.groups.clone();
    tokio::spawn(async move {
        let inserted = tokio::time::timeout(
            Duration::from_secs(2),
            history::store(&db, &room, &id, &speaker, user_id, &text, image.as_deref(), video.as_deref(), streamer, verified, &groups, reply.as_ref()),
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
    async fn join(&self, name: &str, ip: &str) -> Option<broadcast::Receiver<Event>> {
        if let Some(room) = self.rooms.lock().await.get_mut(name) {
            return room.subscribe(ip);
        }
        let start = last_id(&mut self.redis.clone(), &room_key(name)).await;
        let react_start = last_id(&mut self.redis.clone(), &react_key(name)).await;
        let mut rooms = self.rooms.lock().await;
        let room = rooms.entry(name.to_owned()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(256);
            tokio::spawn(reader(self.client.clone(), name.to_owned(), start, react_start, tx.clone()));
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

async fn last_id<C: AsyncCommands>(r: &mut C, key: &str) -> Option<String> {
    let reply: StreamRangeReply = r.xrevrange_count(key, "+", "-", 1).await.ok()?;
    Some(reply.ids.first().map(|id| id.id.clone()).unwrap_or_else(|| "0-0".to_owned()))
}

async fn reader(client: redis::Client, name: String, start: Option<String>, react_start: Option<String>, tx: broadcast::Sender<Event>) {
    let key = room_key(&name);
    let rkey = react_key(&name);
    let config = crate::socket::blocking_config(READ_BLOCK_MS);
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
    let mut last = match start {
        Some(id) => id,
        None => last_id(&mut con, &key).await.unwrap_or_else(|| "0-0".to_owned()),
    };
    let mut rlast = match react_start {
        Some(id) => id,
        None => last_id(&mut con, &rkey).await.unwrap_or_else(|| "0-0".to_owned()),
    };
    let options = StreamReadOptions::default().block(READ_BLOCK_MS).count(100);
    while tx.receiver_count() > 0 {
        let reply: Option<StreamReadReply> = match con.xread_options(&[&key, &rkey], &[&last, &rlast], &options).await {
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
            let reactions = stream.key == rkey;
            for entry in stream.ids {
                if reactions {
                    rlast = entry.id.clone();
                    if let Some(id) = entry.get::<String>("del") {
                        let _ = tx.send(Event::Delete(id.into()));
                    } else if let Some(react) = react_from(&entry) {
                        let _ = tx.send(Event::React(Arc::new(react)));
                    }
                    continue;
                }
                last = entry.id.clone();
                if let Some(line) = line_from(entry) {
                    let _ = tx.send(Event::Line(Arc::new(line)));
                }
            }
        }
    }
    log::info!("{name}: room empty, reader done");
}

fn viewer_of(who: &Option<Who>) -> Option<Uuid> {
    who.as_ref().and_then(|w| w.user_id.filter(|_| w.verified))
}

async fn history(s: &ChatState, name: &str, viewer: Option<Uuid>) -> Result<Vec<Line>, redis::RedisError> {
    let mut r = s.redis.clone();
    let reply: StreamRangeReply = r.xrevrange_count(room_key(name), "+", "-", HISTORY_LINES).await?;
    let mut lines: Vec<Line> = reply.ids.into_iter().filter_map(line_from).collect();
    lines.reverse();
    with_faces(&s.db, &mut lines).await;
    reactions::with_reactions(&s.db, viewer, lines.iter_mut().map(|l| (name, l))).await;
    Ok(lines)
}

const MAX_IMAGES: usize = 10;

pub(crate) fn picture_ids(image: Option<String>, images: Vec<String>) -> Result<Vec<String>, &'static str> {
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

async fn pictures_exist(db: &sqlx::PgPool, name: &str, ids: &[String], who: Option<Uuid>) -> Result<(), &'static str> {
    for id in ids {
        match crate::media::check(db, crate::media::Kind::Image, id, who).await {
            Ok(Ok(())) => {}
            Ok(Err(crate::media::Refusal::Missing)) => return Err("no such picture"),
            Ok(Err(crate::media::Refusal::NotYours)) => return Err(NOT_YOUR_PICTURE),
            Err(e) => {
                log::warn!("{name}: picture: {e}");
                return Err("chat is busy, try again");
            }
        }
    }
    Ok(())
}

async fn pictures_allowed(db: &sqlx::PgPool, name: &str, server: Option<&str>, ids: &[String], video: Option<&Video>) -> Result<(), &'static str> {
    use crate::moderate::{group_place, may_post, PlaceKind};
    let mut all: Vec<&str> = ids.iter().map(String::as_str).collect();
    if let Some(video) = video {
        all.push(&video.poster);
    }
    if all.is_empty() {
        return Ok(());
    }
    let place = match server {
        Some(server) => group_place(db, server).await,
        None => Ok(PlaceKind::Stream),
    };
    let verdict = match place {
        Ok(place) => may_post(db, &all, place).await,
        Err(e) => Err(e),
    };
    match verdict {
        Ok(verdict) => verdict,
        Err(e) => {
            log::warn!("{name}: picture verdicts: {e}");
            Err("chat is busy, try again")
        }
    }
}

pub(crate) fn split_pictures(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else { return Vec::new() };
    raw.split(',').map(|part| part.trim().to_string()).filter(|part| !part.is_empty()).collect()
}

pub(crate) fn line_from(entry: StreamId) -> Option<Line> {
    let from: String = entry.get("from")?;
    let text: String = entry.get("text")?;
    let streamer: String = entry.get("streamer").unwrap_or_else(|| "0".to_owned());
    let verified: String = entry.get("v").unwrap_or_else(|| "0".to_owned());
    let groups: Vec<Badge> = entry.get::<String>("g").and_then(|g| serde_json::from_str(&g).ok()).unwrap_or_default();
    let avatar: Option<i64> = entry.get::<String>("a").and_then(|a| a.parse().ok());
    let user_id: Option<Uuid> = entry.get::<String>("uid").and_then(|u| Uuid::parse_str(&u).ok());
    let oauth_verified = entry.get::<String>("o").as_deref() == Some("1");
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
    let video = Video::parse(entry.get::<String>("vid").as_deref());
    let reply: Option<Reply> = entry.get::<String>("r").and_then(|r| serde_json::from_str(&r).ok());
    Some(Line {
        at: id_parts(&entry.id).0,
        id: entry.id,
        from,
        text,
        streamer: streamer == "1",
        verified: verified == "1",
        groups,
        avatar,
        oauth_verified,
        user_id,
        image,
        images,
        video,
        reply,
        reactions: Vec::new(),
    })
}

pub(crate) fn room_key(name: &str) -> String {
    format!("chat:{name}")
}

fn react_key(name: &str) -> String {
    format!("chatr:{name}")
}

const KEEP_REACTS: usize = 200;

fn react_from(entry: &StreamId) -> Option<React> {
    let id: String = entry.get("l")?;
    let emoji: String = entry.get("e")?;
    let who: String = entry.get("w")?;
    let on: String = entry.get("on")?;
    Some(React { id, emoji, who, on: on == "1" })
}

pub(crate) fn clean_nick(raw: &str) -> String {
    raw.trim().chars().take(MAX_NICK_CHARS).collect()
}

pub(crate) fn valid_nick(nick: &str) -> bool {
    !nick.is_empty() && nick.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

const MAX_COMBINING: usize = 4;

pub(crate) fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut newlines = 0;
    let mut marks = 0;
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

fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}' | '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

fn is_combining(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036F}' | '\u{1AB0}'..='\u{1AFF}' | '\u{1DC0}'..='\u{1DFF}' | '\u{20D0}'..='\u{20FF}' | '\u{FE20}'..='\u{FE2F}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_channel_sits_beside_a_stream_room() {
        let _ = Router::<ChatState>::new()
            .route("/chat/{name}", get(|| async { "stream" }))
            .route("/chat/{server}/{channel}", get(|| async { "channel" }))
            .merge(history::routes());
    }

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
            oauth_verified: false,
            user_id: Some(Uuid::nil()),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
            video: None,
            reply: None,
            reactions: Vec::new(),
        };
        let text = serde_json::to_string(&Out::ChannelMessage { channel: "general", line: &line }).unwrap();
        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(frame["type"], "message");
        assert_eq!(frame["channel"], "general");
        assert_eq!(frame["id"], "1729000000000-0");
        assert_eq!(frame["from"], "bob");
        assert_eq!(frame["verified"], true);
        assert!(frame.get("user_id").is_none());
        assert_eq!(serde_json::to_string(&Out::ChannelCount { channel: "general", count: 3 }).unwrap(), r#"{"type":"count","channel":"general","count":3}"#);
        assert!(!crate::valid_name(EVERY_CHANNEL));
    }

    #[test]
    fn a_reply_carries_a_short_quote_of_its_line() {
        let long: String = "a".repeat(400);
        let line = Line {
            id: "1729000000000-0".into(),
            from: "ann".into(),
            text: long,
            streamer: false,
            verified: true,
            groups: Vec::new(),
            avatar: Some(1700000000),
            oauth_verified: false,
            user_id: Some(Uuid::nil()),
            at: 1729000000000,
            image: Some("6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e".into()),
            images: vec!["6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e".into()],
            video: None,
            reply: None,
            reactions: Vec::new(),
        };
        let quote = Reply::of(&line);
        assert_eq!(quote.text.chars().count(), REPLY_QUOTE_CHARS);
        assert_eq!((quote.id.as_str(), quote.from.as_str(), quote.images, quote.avatar), ("1729000000000-0", "ann", 1, Some(1700000000)));
        let answer = Line { id: "1729000000001-0".into(), text: "yes".into(), reply: Some(quote.clone()), ..line.clone() };
        let frame: serde_json::Value = serde_json::to_value(&answer).unwrap();
        assert_eq!(frame["reply"]["id"], "1729000000000-0");
        assert_eq!(frame["reply"]["from"], "ann");
        let plain: serde_json::Value = serde_json::to_value(&line).unwrap();
        assert!(plain.get("reply").is_none(), "a line that answers nothing has no reply key");
        let back: Line = serde_json::from_value(frame).unwrap();
        assert_eq!(back.reply, Some(quote));
        let old: Line = serde_json::from_str(r#"{"id":"1-0","from":"bob","text":"hi","streamer":false,"verified":false,"groups":[],"avatar":null,"oauth_verified":false,"at":1}"#).unwrap();
        assert!(old.reply.is_none());
        match serde_json::from_str::<In>(r#"{"type":"say","text":"yes","reply":"1729000000000-0"}"#).unwrap() {
            In::Say { reply, .. } => assert_eq!(reply.as_deref(), Some("1729000000000-0")),
            _ => panic!("a say"),
        }
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

    #[test]
    fn a_say_is_cleaned_before_it_costs() {
        assert_eq!(parse_say("  hi  ".into(), None, Vec::new(), None), Ok(Some(("hi".into(), Vec::new(), None))));
        assert_eq!(parse_say("   ".into(), None, Vec::new(), None), Ok(None));
        assert_eq!(parse_say("   ".into(), None, Vec::new(), Some(" ".into())), Ok(None), "an empty video is none");
        assert_eq!(parse_say("x".repeat(MAX_TEXT_CHARS + 1), None, Vec::new(), None), Err("too long"));
        assert_eq!(parse_say(String::new(), Some("not-an-id".into()), Vec::new(), None), Err("bad picture"));
        assert_eq!(parse_say(String::new(), None, Vec::new(), Some("not-an-id".into())), Err("bad video"));
        let id = "6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e";
        assert_eq!(parse_say(String::new(), Some(id.into()), Vec::new(), None), Ok(Some((String::new(), vec![id.into()], None))));
        assert_eq!(parse_say(String::new(), None, Vec::new(), Some(id.to_uppercase())), Ok(Some((String::new(), Vec::new(), Some(id.into())))));
    }

    #[test]
    fn videos_are_off_in_a_streams_chat() {
        let id = Some("6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e");
        assert!(!STREAM_CHAT_VIDEO, "videos stay off in a stream's chat until it has moderation");
        assert_eq!(stream_video_refusal(None, id, STREAM_CHAT_VIDEO), Some("videos are off in stream chat for now"));
        assert_eq!(stream_video_refusal(None, None, STREAM_CHAT_VIDEO), None, "a line with no video goes");
        assert_eq!(stream_video_refusal(Some("cats"), id, STREAM_CHAT_VIDEO), None, "a group channel keeps its videos");
        assert_eq!(stream_video_refusal(None, id, true), None, "the flag turns them back on");
        let refused: Refused = NO_STREAM_VIDEO.into();
        assert!(matches!(refused.frame(), Out::Error { error: "videos are off in stream chat for now" }), "the socket hears it as an error and stays open");
    }

    #[test]
    fn a_video_is_kept_as_its_id_and_its_posters() {
        let v = Video { id: "6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e".into(), poster: "7c2d0c3a-7c2d-4e5f-9a10-11b12c13d14e".into() };
        assert_eq!(Video::parse(Some(&v.stored())), Some(v.clone()));
        assert_eq!(Video::parse(Some("6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e")), None, "no poster, no video");
        assert_eq!(Video::parse(Some("x,y")), None);
        assert_eq!(Video::parse(None), None);
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["poster"], "7c2d0c3a-7c2d-4e5f-9a10-11b12c13d14e");
    }

    fn about(wait: Duration, secs: f64) -> bool {
        (wait.as_secs_f64() - secs).abs() < 0.01
    }

    #[test]
    fn a_nick_has_two_lines_then_one_every_thirty_seconds() {
        let now = Instant::now();
        let at = |secs: u64| now + Duration::from_secs(secs);
        let mut b = Bucket::new(ANON_TIER, now);
        assert!(b.take(ANON_TIER, now).is_ok());
        assert!(b.take(ANON_TIER, now).is_ok());
        assert!(about(b.take(ANON_TIER, now).unwrap_err(), 30.0));
        assert!(about(b.take(ANON_TIER, at(10)).unwrap_err(), 20.0));
        assert!(b.take(ANON_TIER, at(30)).is_ok());
        assert!(about(b.take(ANON_TIER, at(30)).unwrap_err(), 30.0));
        assert!(b.take(ANON_TIER, at(600)).is_ok());
        assert!(b.take(ANON_TIER, at(600)).is_ok());
        assert!(b.take(ANON_TIER, at(600)).is_err());
    }

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

    #[test]
    fn the_bucket_is_the_speakers_not_the_sockets() {
        let limiter = Limiter::new();
        let now = Instant::now();
        let alice = Speaker::Nick("1.2.3.4".into(), "alice".into());
        assert!(limiter.take_at(&alice, "room", now).is_ok());
        assert!(limiter.take_at(&alice, "room", now).is_ok());
        assert!(limiter.take_at(&Speaker::of(None, &Hello { nick: Some("Alice".into()), session: None, token: None, bot: None }, "1.2.3.4"), "room", now).is_err());
        assert!(limiter.take_at(&alice, "other", now).is_ok());
        assert!(limiter.take_at(&Speaker::Nick("1.2.3.4".into(), "bob".into()), "room", now).is_ok());
        let bob = Speaker::Account(Uuid::nil());
        for _ in 0..3 {
            assert!(limiter.take_at(&bob, "room", now).is_ok());
        }
        assert!(limiter.take_at(&bob, "room", now).is_err());
    }

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
        limiter.take_at(&alice, "room", now + Duration::from_secs(30)).unwrap();
        assert_eq!(limiter.inner.lock().unwrap().by_speaker.len(), 2);
        let carol = Speaker::Nick("5.6.7.8".into(), "carol".into());
        limiter.take_at(&carol, "room", now + SWEEP_EVERY).unwrap();
        let kept: Vec<Speaker> = limiter.inner.lock().unwrap().by_speaker.keys().map(|(s, _)| s.clone()).collect();
        assert_eq!(kept.len(), 2, "{kept:?}");
        assert!(kept.contains(&alice) && kept.contains(&carol), "{kept:?}");
    }

    #[test]
    fn who_draws_on_which_bucket() {
        let hello = Hello { nick: Some(" Bob ".into()), session: None, token: None, bot: None };
        let id = Uuid::nil();
        let login = Who { from: "bob".into(), streamer: false, verified: true, groups: Vec::new(), user_id: Some(id) };
        assert_eq!(Speaker::of(Some(&login), &hello, "1.2.3.4"), Speaker::Account(id));
        let streamer = Who { from: "room".into(), streamer: true, verified: false, groups: Vec::new(), user_id: None };
        assert_eq!(Speaker::of(Some(&streamer), &hello, "1.2.3.4"), Speaker::Streamer("room".into()));
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

    #[test]
    fn a_refused_line_says_how_long() {
        assert_eq!(serde_json::to_string(&slow(Duration::from_micros(1_234_500))).unwrap(), r#"{"type":"error","error":"slow down","wait":1235}"#);
        assert_eq!(serde_json::to_string(&slow(Duration::from_secs(30))).unwrap(), r#"{"type":"error","error":"slow down","wait":30000}"#);
    }

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
    fn a_delete_frame_names_the_line() {
        assert_eq!(serde_json::to_string(&Out::Delete { id: "1-0" }).unwrap(), r#"{"type":"delete","id":"1-0"}"#);
        assert_eq!(
            serde_json::to_string(&Out::ChannelDelete { channel: "general", id: "1-0" }).unwrap(),
            r#"{"type":"delete","channel":"general","id":"1-0"}"#
        );
        assert!(!BANNED.contains("nick") && !BANNED.contains("account"));
    }

    #[test]
    fn reaction_frames() {
        match serde_json::from_str::<In>(r#"{"type":"react","id":"1729000000000-0","emoji":"👍","on":true,"channel":"clips"}"#).unwrap() {
            In::React { id, emoji, on, channel } => {
                assert_eq!((id.as_str(), emoji.as_str(), on, channel.as_deref()), ("1729000000000-0", "👍", true, Some("clips")));
            }
            _ => panic!("not a react"),
        }
        assert!(matches!(serde_json::from_str::<In>(r#"{"type":"react","id":"1-0","emoji":"👍","on":false}"#).unwrap(), In::React { on: false, channel: None, .. }));
        let react = React { id: "1-0".into(), emoji: "🔥".into(), who: "bob".into(), on: true };
        assert_eq!(serde_json::to_string(&Out::React(&react)).unwrap(), r#"{"type":"react","id":"1-0","emoji":"🔥","who":"bob","on":true}"#);
        assert_eq!(
            serde_json::to_string(&Out::ChannelReact { channel: "general", react: &react }).unwrap(),
            r#"{"type":"react","channel":"general","id":"1-0","emoji":"🔥","who":"bob","on":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Out::ReactRefused { error: SLOW_DOWN, react: "1-0", wait: Some(900) }).unwrap(),
            r#"{"type":"error","error":"slow down","react":"1-0","wait":900}"#
        );
        let mut entry = StreamId { id: "5-0".into(), ..StreamId::default() };
        for (k, v) in [("l", "1-0"), ("e", "🔥"), ("w", "bob"), ("on", "0")] {
            entry.map.insert(k.into(), redis::Value::BulkString(v.as_bytes().to_vec()));
        }
        assert_eq!(react_from(&entry), Some(React { on: false, ..react.clone() }));
        assert_ne!(react_key("bob"), room_key("bob"));
        assert!(!react_key("bob").starts_with("chat:"));
    }

    #[test]
    fn a_reaction_has_its_own_bucket() {
        let limiter = Limiter::for_reactions();
        let me = Speaker::Account(Uuid::nil());
        let now = Instant::now();
        for _ in 0..10 {
            assert!(limiter.take_at(&me, "room", now).is_ok());
        }
        let wait = limiter.take_at(&me, "room", now).unwrap_err();
        assert!(about(wait, 1.0), "{wait:?}");
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
        assert_eq!(clean_text("a\n \n \n \nb").matches('\n').count(), 2);
        let tall = format!("a{}b", "\n".repeat(498));
        assert_eq!(clean_text(&tall), "a\n\nb");
    }

    #[test]
    fn text_invisible_format_characters_go() {
        assert_eq!(clean_text("\u{202E}abc\u{200B}\u{FEFF}"), "abc");
        assert_eq!(clean_text("\u{200F}\u{2066}x\u{2069}\u{00AD}"), "x");
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        assert_eq!(clean_text(family), family);
    }

    #[test]
    fn text_combining_marks_are_capped() {
        let zalgo = format!("e{}x", "\u{0301}".repeat(40));
        assert_eq!(clean_text(&zalgo), format!("e{}x", "\u{0301}".repeat(MAX_COMBINING)));
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
        assert!(id_parts("1729000000000-10") > id_parts("1729000000000-9"));
        assert!(id_parts("1729000000001-0") > id_parts("1729000000000-99"));
    }

    fn pool_that_never_answers() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_secs(5))
            .connect_lazy("postgres://u:p@127.0.0.1:1/x")
            .expect("a pool that is never connected")
    }

    #[tokio::test]
    async fn a_face_at_the_say_waits_two_seconds_at_most() {
        let pool = pool_that_never_answers();
        let who = Who { from: "bob".to_owned(), streamer: false, verified: true, groups: Vec::new(), user_id: Some(Uuid::nil()) };
        let started = Instant::now();
        let face = face_now(&pool, "room", &who).await;
        let took = started.elapsed();
        assert_eq!(face, Face::default());
        assert!(took < Duration::from_secs(3), "face_now held the socket for {took:?}");
    }

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
            oauth_verified: true,
            user_id: Some(Uuid::nil()),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
            video: None,
            reply: None,
            reactions: Vec::new(),
        }];
        let started = Instant::now();
        with_faces(&pool, &mut lines).await;
        let took = started.elapsed();
        assert_eq!(lines[0].avatar, Some(7), "a line the database did not answer for is left as written");
        assert!(lines[0].oauth_verified, "and so is its mark");
        assert!(took < Duration::from_secs(3), "with_faces held the socket for {took:?}");
    }

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
            oauth_verified: false,
            user_id: Some(alice),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
            video: None,
            reply: None,
            reactions: Vec::new(),
        }];
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, Some(1690000000));
        assert!(!lines[0].oauth_verified, "nothing linked: no oauth mark");
        sqlx::query("INSERT INTO oauth_identities (user_id, provider, provider_user_id) VALUES ($1, 'google', $2)")
            .bind(alice)
            .bind(format!("face-{run}"))
            .execute(&pool)
            .await
            .unwrap();
        with_faces(&pool, &mut lines).await;
        assert!(lines[0].oauth_verified, "linked: the mark, on her old lines too");

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
        assert!(lines[0].oauth_verified, "and the mark with it");

        sqlx::query("UPDATE held_names SET until = now() - interval '1 second' WHERE name = $1").bind(&alice_name).execute(&pool).await.unwrap();
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, None, "after the hold the old name is not the account's: the letter");
        assert!(!lines[0].oauth_verified, "nor the mark");

        let stranger = row(&pool, &alice_name, Some("stranger-hash")).await;
        sqlx::query("UPDATE streamers SET avatar_at = to_timestamp(1700000000) WHERE id = $1").bind(stranger).execute(&pool).await.unwrap();
        lines[0].avatar = Some(1690000000);
        with_faces(&pool, &mut lines).await;
        assert_eq!(lines[0].avatar, None, "a stranger on the freed name is nobody's picture on the account's words");
    }
}
