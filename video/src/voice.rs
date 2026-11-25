use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::udp_mux::{UDPMuxDefault, UDPMuxParams};
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::ice_transport::ice_candidate_pair::RTCIceCandidatePair;
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::track::track_remote::TrackRemote;

use crate::media::{opus_voice_capability, voice_media_setup, vp8_capability};
use crate::{env_port, forwarded_ip, limits, media_socket, valid_name};

const MAX_SEATS: usize = 16;
const MAX_SDP_BYTES: usize = 128 * 1024;
const MAX_MEDIA_LINES: usize = 16;
const MAX_VIDEO_LINES: usize = 2 + 2 * (MAX_SEATS - 1);
const KEYFRAME_GAP: Duration = Duration::from_millis(300);
const MAX_PEERS_PER_IP: usize = 4;
const MAX_USER_CHARS: usize = 32;
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
const API_TIMEOUT: Duration = Duration::from_millis(1500);
const BEAT_EVERY: Duration = Duration::from_secs(15);
const ATTACH_RETRY: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];
const PING_EVERY: Duration = Duration::from_secs(30);
const IDLE_LIMIT: Duration = Duration::from_secs(90);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Voice {
    public_ip: String,
    udp_port: u16,
    mux: Arc<UDPMuxDefault>,
    open: bool,
    api: Api,
    state: Arc<Mutex<Rooms>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Clone)]
struct Api {
    url: String,
    secret: Option<Arc<str>>,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct Redeemed {
    user_id: String,
    name: String,
    server: String,
    channel: String,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    tab: Option<String>,
}

impl Api {
    async fn post(&self, path: &str, body: &serde_json::Value) -> Result<reqwest::Response, ()> {
        let Some(secret) = &self.secret else { return Err(()) };
        let req = self.http.post(format!("{}{path}", self.url)).header("x-voice-secret", &**secret).json(body);
        crate::timings::call("POST", path, req)
            .await
            .map_err(|e| log::warn!("voice: api unreachable for {path}: {}", e.without_url()))
    }

    async fn redeem(&self, grant: &str) -> Result<Redeemed, &'static str> {
        let res = self
            .post("/api/voice/redeem", &serde_json::json!({ "grant": grant }))
            .await
            .map_err(|()| "api unreachable")?;
        let status = res.status();
        if !status.is_success() {
            if !status.is_client_error() {
                log::warn!("voice: api answered {status} to redeem");
            }
            return Err("bad grant");
        }
        let who = res.json::<Redeemed>().await.map_err(|e| {
            log::warn!("voice: redeem reply: {}", e.without_url());
            "bad grant"
        })?;
        if !valid_room(&format!("{}/{}", who.server, who.channel)) || !valid_user(&who.name) {
            log::warn!("voice: redeem named a room or person we cannot seat");
            return Err("bad grant");
        }
        Ok(who)
    }

    async fn tell(&self, path: &str, body: serde_json::Value) {
        match self.post(path, &body).await {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => log::warn!("voice: api answered {} to {path}", res.status()),
            Err(()) => {}
        }
    }

    async fn beat(&self, peers: Vec<serde_json::Value>) -> Vec<(String, String)> {
        #[derive(Deserialize)]
        struct Missing {
            user_id: String,
            server: String,
        }
        #[derive(Deserialize)]
        struct Beat {
            #[serde(default)]
            missing: Vec<Missing>,
        }
        match self.post("/api/voice/beat", &serde_json::json!({ "peers": peers })).await {
            Ok(res) if res.status().is_success() => match res.json::<Beat>().await {
                Ok(beat) => beat.missing.into_iter().map(|m| (m.user_id, m.server)).collect(),
                Err(e) => {
                    log::warn!("voice: beat reply: {}", e.without_url());
                    Vec::new()
                }
            },
            Ok(res) => {
                log::warn!("voice: api answered {} to /api/voice/beat", res.status());
                Vec::new()
            }
            Err(()) => Vec::new(),
        }
    }
}

struct Presence {
    api: Api,
    user_id: String,
    server: String,
    channel: Mutex<String>,
    gone: AtomicBool,
    bye: Notify,
    refused: AtomicBool,
    turn: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

impl Presence {
    fn new(api: Api, user_id: String, server: String, channel: String) -> Self {
        Presence { api, user_id, server, channel: Mutex::new(channel), gone: AtomicBool::new(false), bye: Notify::new(), refused: AtomicBool::new(false), turn: Default::default() }
    }

    async fn attached(self: Arc<Self>, seat: usize, since: Option<tokio::time::Instant>) {
        let mut last = self.turn.lock().await;
        if since.is_some_and(|since| last.is_some_and(|at| at >= since)) {
            return;
        }
        let channel = self.channel.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let body = serde_json::json!({ "user_id": self.user_id, "server": self.server, "channel": channel, "seat": seat });
        let mut waits = ATTACH_RETRY.iter();
        loop {
            if self.gone.load(Ordering::SeqCst) || self.refused.load(Ordering::SeqCst) {
                return;
            }
            match self.api.post("/api/voice/attached", &body).await {
                Ok(res) if res.status().is_success() => {
                    *last = Some(tokio::time::Instant::now());
                    return;
                }
                Ok(res) if res.status().is_client_error() => {
                    log::warn!("voice: api answered {} to attached, not trying again", res.status());
                    self.refused.store(true, Ordering::SeqCst);
                    return;
                }
                Ok(res) => log::warn!("voice: api answered {} to attached", res.status()),
                Err(()) => {}
            }
            let Some(&wait) = waits.next() else {
                log::warn!("voice: attached failed {} times; a beat that misses them tries again", ATTACH_RETRY.len() + 1);
                return;
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.bye.notified() => return,
            }
        }
    }

    async fn left(&self, voice: &Voice) {
        self.gone.store(true, Ordering::SeqCst);
        self.bye.notify_one();
        let _turn = self.turn.lock().await;
        if !voice.sits_in(&self.user_id, &self.server) {
            let body = serde_json::json!({ "user_id": self.user_id, "server": self.server });
            self.api.tell("/api/voice/left", body).await;
        }
    }
}

#[derive(Default)]
struct Rooms {
    rooms: HashMap<String, Room>,
    per_ip: HashMap<IpAddr, usize>,
}

struct Room {
    seats: Seats<Sitter>,
    tx: watch::Sender<Snapshot>,
}

type Snapshot = Arc<Vec<Option<Sitter>>>;

#[derive(Clone)]
struct Sitter {
    user: String,
    uid: Option<String>,
    tab: Option<String>,
    presence: Option<Arc<Presence>>,
    id: u64,
    mic: Arc<TrackLocalStaticRTP>,
    muted: Arc<AtomicBool>,
    kick: Arc<Notify>,
    replaced: Arc<Notify>,
    show: Show,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Kind {
    Camera,
    Screen,
}

impl Kind {
    const ALL: [Kind; 2] = [Kind::Camera, Kind::Screen];

    fn word(self) -> &'static str {
        match self {
            Kind::Camera => "camera",
            Kind::Screen => "screen",
        }
    }

    fn of(word: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.word() == word)
    }
}

#[derive(Clone)]
struct Show {
    tracks: [Arc<TrackLocalStaticRTP>; 2],
    keys: [Arc<Notify>; 2],
    on: [bool; 2],
    mute: bool,
    deaf: bool,
}

impl Show {
    fn new(id: u64) -> Self {
        let track = |kind: Kind| Arc::new(TrackLocalStaticRTP::new(vp8_capability(), format!("{}{id}", kind.word()), format!("seat{id}")));
        Show {
            tracks: [track(Kind::Camera), track(Kind::Screen)],
            keys: [Arc::new(Notify::new()), Arc::new(Notify::new())],
            on: [false; 2],
            mute: false,
            deaf: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Mute,
    Unmute,
    Disconnect,
    Count,
    Rename,
}

#[derive(Deserialize)]
struct Order {
    action: Action,
    #[serde(default)]
    user_id: String,
    server: String,
    #[serde(default)]
    tab: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    to: Option<String>,
}

impl Rooms {
    fn moderate(&self, uid: &str, server: &str, action: Action, tab: Option<&str>) -> usize {
        let mut n = 0;
        for (name, room) in &self.rooms {
            if name.split_once('/').is_none_or(|(s, _)| s != server) {
                continue;
            }
            let theirs = room.seats.0.iter().flatten().filter(|s| s.uid.as_deref() == Some(uid));
            for sitter in theirs.filter(|s| tab.is_none() || s.tab.as_deref() != tab) {
                match action {
                    Action::Mute => sitter.muted.store(true, Ordering::SeqCst),
                    Action::Unmute => sitter.muted.store(false, Ordering::SeqCst),
                    Action::Disconnect => sitter.kick.notify_one(),
                    Action::Count | Action::Rename => {}
                }
                n += 1;
            }
        }
        n
    }

    fn rename(&mut self, server: &str, from: &str, to: &str) -> usize {
        let (old, new) = (format!("{server}/{from}"), format!("{server}/{to}"));
        if old == new || !self.rooms.contains_key(&old) {
            return 0;
        }
        if self.rooms.contains_key(&new) {
            log::warn!("voice {old}: renamed to {new}, which already has seats; both stay as they are");
            return 0;
        }
        let Some(room) = self.rooms.remove(&old) else { return 0 };
        for presence in room.seats.0.iter().flatten().filter_map(|s| s.presence.as_ref()) {
            *presence.channel.lock().unwrap_or_else(|e| e.into_inner()) = to.to_owned();
        }
        let n = room.seats.taken();
        self.rooms.insert(new, room);
        n
    }

    fn let_go(&mut self, seat: usize, id: u64) {
        let Some(name) = self.rooms.iter().find(|(_, r)| r.seats.0.get(seat).is_some_and(|s| s.as_ref().is_some_and(|s| s.id == id))).map(|(n, _)| n.clone()) else {
            return;
        };
        let Some(room) = self.rooms.get_mut(&name) else { return };
        room.seats.free(seat);
        if room.seats.taken() == 0 {
            self.rooms.remove(&name);
        } else {
            room.tx.send_replace(Arc::new(room.seats.snapshot()));
        }
    }

    fn holding(&mut self, seat: usize, id: u64) -> Option<&mut Room> {
        self.rooms.values_mut().find(|r| r.seats.0.get(seat).is_some_and(|s| s.as_ref().is_some_and(|s| s.id == id)))
    }

    fn replace(&mut self, uid: &str, tab: &str, into: &str) -> usize {
        let mut n = 0;
        let mut emptied = Vec::new();
        for (name, room) in &mut self.rooms {
            let mut took = false;
            for slot in &mut room.seats.0 {
                if slot.as_ref().is_some_and(|s| s.uid.as_deref() == Some(uid) && s.tab.as_deref() == Some(tab)) {
                    if let Some(old) = slot.take() {
                        old.replaced.notify_one();
                        took = true;
                        n += 1;
                    }
                }
            }
            if !took || name == into {
                continue;
            }
            if room.seats.taken() == 0 {
                emptied.push(name.clone());
            } else {
                room.tx.send_replace(Arc::new(room.seats.snapshot()));
            }
        }
        for name in emptied {
            self.rooms.remove(&name);
        }
        n
    }
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn inside(headers: &HeaderMap, secret: Option<&str>) -> Result<(), StatusCode> {
    if headers.contains_key("x-forwarded-for") {
        return Err(StatusCode::NOT_FOUND);
    }
    let secret = secret.ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let given = headers.get("x-voice-secret").and_then(|v| v.to_str().ok()).unwrap_or("");
    if given.is_empty() || !same(given, secret) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

struct Seats<T>(Vec<Option<T>>);

impl<T> Seats<T> {
    fn new() -> Self {
        Seats((0..MAX_SEATS).map(|_| None).collect())
    }

    fn take(&mut self, who: T) -> Option<usize> {
        let seat = self.0.iter().position(Option::is_none)?;
        self.0[seat] = Some(who);
        Some(seat)
    }

    fn free(&mut self, seat: usize) -> Option<T> {
        self.0.get_mut(seat)?.take()
    }

    fn taken(&self) -> usize {
        self.0.iter().filter(|s| s.is_some()).count()
    }
}

impl<T: Clone> Seats<T> {
    fn snapshot(&self) -> Vec<Option<T>> {
        self.0.clone()
    }
}

fn line_of(seat: usize, own: usize) -> usize {
    if seat < own {
        seat + 1
    } else {
        seat
    }
}

#[derive(Default)]
struct Numbering {
    dropped: u16,
}

impl Numbering {
    fn skip(&mut self) {
        self.dropped = self.dropped.wrapping_add(1);
    }

    fn of(&self, seq: u16) -> u16 {
        seq.wrapping_sub(self.dropped)
    }
}

#[derive(Deserialize)]
struct Join {
    role: String,
    grant: Option<String>,
    room: Option<String>,
    user: Option<String>,
    sdp: String,
}

#[derive(Debug, PartialEq)]
enum Claim {
    Grant(String),
    Open { room: String, user: String },
}

fn read_join(text: &str, open: bool, granting: bool) -> Result<(Claim, String), &'static str> {
    let join = serde_json::from_str::<Join>(text).map_err(|_| "bad json")?;
    if join.role != "voice" {
        return Err("bad join");
    }
    let claim = match (join.grant, join.room, join.user) {
        (Some(_), _, _) if !granting => return Err("voice is not open"),
        (Some(grant), _, _) if valid_grant(&grant) => Claim::Grant(grant),
        (Some(_), _, _) => return Err("bad grant"),
        (None, _, _) if !open => return Err("bad grant"),
        (None, Some(room), Some(user)) if valid_room(&room) && valid_user(&user) => Claim::Open { room, user },
        (None, _, _) => return Err("bad join"),
    };
    Ok((claim, join.sdp))
}

fn valid_grant(grant: &str) -> bool {
    grant.len() == 64 && grant.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_labels(text: &str) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Labels {
        #[serde(default)]
        video: HashMap<String, String>,
    }
    serde_json::from_str::<Labels>(text).map(|l| l.video).unwrap_or_default()
}

fn sending_kinds(offer: &[Section], labels: &HashMap<String, String>) -> Option<HashMap<String, Kind>> {
    let mut kinds = HashMap::new();
    for s in offer.iter().filter(|s| s.kind == Media::Video && s.sends) {
        let mid = s.mid.clone()?;
        let kind = Kind::of(labels.get(&mid)?)?;
        if kinds.values().any(|&k| k == kind) {
            return None;
        }
        kinds.insert(mid, kind);
    }
    Some(kinds)
}

#[derive(Deserialize)]
struct Said {
    sdp: Option<String>,
    state: Option<SelfState>,
}

#[derive(Deserialize)]
struct SelfState {
    #[serde(default)]
    mute: bool,
    #[serde(default)]
    deaf: bool,
}

#[derive(Serialize)]
struct SeatInfo<'a> {
    seat: usize,
    user: &'a str,
    line: usize,
    mute: bool,
    deaf: bool,
    video: Vec<Shown>,
}

#[derive(Serialize, Debug, PartialEq)]
struct Shown {
    kind: &'static str,
    mid: Option<String>,
}

pub async fn run() -> anyhow::Result<()> {
    let public_ip = std::env::var("PUBLIC_IP").unwrap_or_else(|_| "127.0.0.1".into());
    let ws_port = env_port("VOICE_WS_PORT", 7881);
    let udp_port = env_port("VOICE_UDP_PORT", 7883);
    let open = std::env::var("VOICE_DEV_OPEN").is_ok_and(|v| v.trim() == "1");
    let api_url = std::env::var("API_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "http://api:4000".into())
        .trim_end_matches('/')
        .to_owned();
    let secret = std::env::var("VOICE_SECRET").ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());

    if public_ip.parse::<Ipv4Addr>().is_err() {
        anyhow::bail!("PUBLIC_IP={public_ip:?} is not an ipv4 address");
    }
    let mux = UDPMuxDefault::new(UDPMuxParams::new(media_socket(udp_port)?));
    log::info!("voice: media on udp {udp_port}, advertising {public_ip}");
    if secret.is_some() {
        log::info!("voice: grants are redeemed with the api at {api_url}");
    }
    if open {
        log::warn!("voice: VOICE_DEV_OPEN=1, anyone may join any room");
    } else if secret.is_none() {
        log::info!("voice: closed (VOICE_SECRET is empty; VOICE_DEV_OPEN=1 opens it)");
    }

    let voice = Voice {
        public_ip,
        udp_port,
        mux,
        open,
        api: Api {
            url: api_url,
            secret: secret.map(Arc::from),
            http: reqwest::Client::builder().timeout(API_TIMEOUT).build()?,
        },
        state: Arc::default(),
        next_id: Arc::default(),
    };
    if voice.api.secret.is_some() {
        tokio::spawn(beat(voice.clone()));
    }
    let router = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws))
        .route_layer(axum::middleware::from_fn_with_state(limits::Limits::default(), limits::layer))
        .route("/internal/voice", post(moderate))
        .with_state(voice)
        .layer(axum::middleware::from_fn(crate::timings::http));

    let addr = SocketAddr::from(([0, 0, 0, 0], ws_port));
    log::info!("voice: websocket on {addr}/ws");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
            let mut int = signal(SignalKind::interrupt()).expect("sigint handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
            log::info!("voice: shutting down");
        })
        .await?;
    Ok(())
}

async fn moderate(State(voice): State<Voice>, headers: HeaderMap, body: Result<Json<Order>, axum::extract::rejection::JsonRejection>) -> Result<Json<serde_json::Value>, StatusCode> {
    inside(&headers, voice.api.secret.as_deref())?;
    let Json(order) = body.map_err(|_| StatusCode::BAD_REQUEST)?;
    if order.action == Action::Rename {
        let (Some(from), Some(to)) = (order.channel.as_deref(), order.to.as_deref()) else { return Err(StatusCode::BAD_REQUEST) };
        if !valid_room(&format!("{}/{from}", order.server)) || !valid_room(&format!("{}/{to}", order.server)) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let n = voice.state.lock().unwrap_or_else(|e| e.into_inner()).rename(&order.server, from, to);
        log::info!("voice: {}/{from} is {}/{to} now, {n} seat(s) moved", order.server, order.server);
        return Ok(Json(serde_json::json!({ "seats": n })));
    }
    if order.user_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let n = voice.state.lock().unwrap_or_else(|e| e.into_inner()).moderate(&order.user_id, &order.server, order.action, order.tab.as_deref());
    if order.action == Action::Count {
        log::info!("voice: count, {n} seat(s) in {} but this tab's", order.server);
    } else {
        log::info!("voice: {:?} on {n} seat(s) in {}", order.action, order.server);
    }
    Ok(Json(serde_json::json!({ "seats": n })))
}

async fn health(State(voice): State<Voice>) -> Json<serde_json::Value> {
    let state = voice.state.lock().unwrap_or_else(|e| e.into_inner());
    let peers: usize = state.rooms.values().map(|r| r.seats.taken()).sum();
    Json(serde_json::json!({ "ok": true, "rooms": state.rooms.len(), "peers": peers }))
}

async fn beat(voice: Voice) {
    let mut tick = tokio::time::interval(BEAT_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let peers = voice.seated();
        if peers.is_empty() {
            continue;
        }
        let asked = tokio::time::Instant::now();
        for (uid, server) in voice.api.beat(peers).await {
            if let Some((presence, seat)) = voice.presence_of(&uid, &server) {
                log::info!("voice {server}: the api has no seat for someone seated, attaching again");
                tokio::spawn(presence.attached(seat, Some(asked)));
            }
        }
    }
}

async fn ws(
    State(voice): State<Voice>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    let ip = forwarded_ip(&headers).unwrap_or(from.ip());
    upgrade
        .max_message_size(2 * MAX_SDP_BYTES)
        .max_frame_size(2 * MAX_SDP_BYTES)
        .on_upgrade(move |socket| handle(voice, socket, ip))
}

struct Sat {
    seat: usize,
    mic: Arc<TrackLocalStaticRTP>,
    seats: watch::Receiver<Snapshot>,
    muted: Arc<AtomicBool>,
    kick: Arc<Notify>,
    replaced: Arc<Notify>,
}

struct Held {
    voice: Voice,
    ip: IpAddr,
    seat: Option<(usize, u64)>,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut state = self.voice.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((seat, id)) = self.seat.take() {
            state.let_go(seat, id);
        }
        if let Some(n) = state.per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                state.per_ip.remove(&self.ip);
            }
        }
    }
}

impl Voice {
    fn hold_ip(&self, ip: IpAddr) -> Option<Held> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let n = state.per_ip.entry(ip).or_default();
        if *n >= MAX_PEERS_PER_IP {
            return None;
        }
        *n += 1;
        Some(Held { voice: self.clone(), ip, seat: None })
    }

    fn sit(&self, held: &mut Held, name: &str, user: &str, presence: Option<&Arc<Presence>>, tab: Option<&str>, muted: bool) -> Option<Sat> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let uid = presence.map(|p| p.user_id.as_str());
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let (Some(uid), Some(tab)) = (uid, tab) {
            let n = state.replace(uid, tab, name);
            if n > 0 {
                log::info!("voice {name}: {user} joined again from the same tab, {n} old seat(s) let go");
            }
        }
        let room = state.rooms.entry(name.to_owned()).or_insert_with(|| Room {
            seats: Seats::new(),
            tx: watch::Sender::new(Arc::new(Vec::new())),
        });
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic{id}"), "voice".to_owned()));
        let (muted, kick, replaced) = (Arc::new(AtomicBool::new(muted)), Arc::new(Notify::new()), Arc::new(Notify::new()));
        let sitter = Sitter {
            user: user.to_owned(),
            uid: uid.map(str::to_owned),
            tab: tab.map(str::to_owned),
            presence: presence.cloned(),
            id,
            mic: mic.clone(),
            muted: muted.clone(),
            kick: kick.clone(),
            replaced: replaced.clone(),
            show: Show::new(id),
        };
        let Some(seat) = room.seats.take(sitter) else {
            if room.seats.taken() == 0 {
                state.rooms.remove(name);
            }
            return None;
        };
        held.seat = Some((seat, id));
        let snapshot = Arc::new(room.seats.snapshot());
        room.tx.send_replace(snapshot);
        Some(Sat { seat, mic, seats: room.tx.subscribe(), muted, kick, replaced })
    }

    fn show(&self, seat: usize, id: u64, change: impl FnOnce(&mut Show)) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(room) = state.holding(seat, id) else { return };
        let Some(Some(sitter)) = room.seats.0.get_mut(seat).filter(|s| s.as_ref().is_some_and(|s| s.id == id)) else { return };
        let was = (sitter.show.on, sitter.show.mute, sitter.show.deaf);
        change(&mut sitter.show);
        if was != (sitter.show.on, sitter.show.mute, sitter.show.deaf) {
            let snapshot = Arc::new(room.seats.snapshot());
            room.tx.send_replace(snapshot);
        }
    }

    fn seated(&self) -> Vec<serde_json::Value> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .rooms
            .iter()
            .flat_map(|(name, room)| {
                let server = name.split_once('/').map_or(name.as_str(), |(server, _)| server);
                room.seats.0.iter().flatten().filter_map(move |s| {
                    s.uid.as_ref().map(|uid| serde_json::json!({ "user_id": uid, "server": server }))
                })
            })
            .collect()
    }

    fn presence_of(&self, uid: &str, server: &str) -> Option<(Arc<Presence>, usize)> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.rooms.iter().filter(|(name, _)| name.split_once('/').is_some_and(|(s, _)| s == server)).find_map(|(_, room)| {
            room.seats.0.iter().enumerate().find_map(|(seat, s)| {
                let p = s.as_ref()?.presence.as_ref()?;
                (p.user_id == uid && !p.gone.load(Ordering::SeqCst)).then(|| (p.clone(), seat))
            })
        })
    }

    fn sits_in(&self, uid: &str, server: &str) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.rooms.iter().any(|(name, room)| {
            name.split_once('/').is_some_and(|(s, _)| s == server) && room.seats.0.iter().flatten().any(|s| s.uid.as_deref() == Some(uid))
        })
    }
}

async fn refuse(socket: &mut WebSocket, error: &str) {
    let _ = send(socket, &serde_json::json!({ "error": error })).await;
    let _ = socket.send(Message::Close(None)).await;
}

async fn send(socket: &mut WebSocket, msg: &serde_json::Value) -> anyhow::Result<()> {
    let text = Message::Text(serde_json::to_string(msg)?.into());
    tokio::time::timeout(SEND_TIMEOUT, socket.send(text)).await??;
    Ok(())
}

fn valid_room(room: &str) -> bool {
    room.split_once('/').is_some_and(|(server, channel)| valid_name(server) && valid_name(channel))
}

fn valid_user(user: &str) -> bool {
    !user.trim().is_empty() && user.chars().count() <= MAX_USER_CHARS && !user.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Media {
    Audio,
    Video,
    Other,
}

#[derive(Debug)]
struct Section {
    kind: Media,
    mid: Option<String>,
    sends: bool,
    receives: bool,
}

fn sections(sdp: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for line in sdp.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("m=") {
            let kind = match rest.split(' ').next() {
                Some("audio") => Media::Audio,
                Some("video") => Media::Video,
                _ => Media::Other,
            };
            sections.push(Section { kind, mid: None, sends: true, receives: true });
        } else if let Some(section) = sections.last_mut() {
            if let Some(mid) = line.strip_prefix("a=mid:") {
                section.mid = Some(mid.trim().to_owned());
            } else if line == "a=sendonly" {
                section.receives = false;
            } else if line == "a=recvonly" {
                section.sends = false;
            } else if line == "a=inactive" {
                section.sends = false;
                section.receives = false;
            }
        }
    }
    sections
}

fn check_offer(sdp: &str) -> Option<Vec<Section>> {
    if sdp.len() > MAX_SDP_BYTES {
        return None;
    }
    let sections = sections(sdp);
    let count = |kind: Media| sections.iter().filter(|s| s.kind == kind).count();
    let ok = sections.first().is_some_and(|s| s.kind == Media::Audio && s.sends)
        && count(Media::Audio) <= MAX_MEDIA_LINES
        && count(Media::Video) <= MAX_VIDEO_LINES
        && count(Media::Other) == 0
        && sections.iter().filter(|s| s.kind == Media::Video && s.sends).count() <= 2
        && sections.iter().all(|s| s.mid.is_some());
    ok.then_some(sections)
}

fn same_audio(first: &[Section], next: &[Section]) -> bool {
    let mids = |offer: &[Section]| offer.iter().filter(|s| s.kind == Media::Audio).map(|s| s.mid.clone()).collect::<Vec<_>>();
    mids(first) == mids(next) && next[0].sends
}

async fn handle(voice: Voice, mut socket: WebSocket, ip: IpAddr) {
    let text = match tokio::time::timeout(JOIN_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        _ => return,
    };
    if !voice.open && voice.api.secret.is_none() {
        return refuse(&mut socket, "voice is not open").await;
    }
    let (claim, sdp) = match read_join(&text, voice.open, voice.api.secret.is_some()) {
        Ok(join) => join,
        Err(e) => return refuse(&mut socket, e).await,
    };
    let Some(offer) = check_offer(&sdp) else {
        return refuse(&mut socket, "bad offer").await;
    };
    let Some(mut held) = voice.hold_ip(ip) else {
        return refuse(&mut socket, "too many voice peers from this address").await;
    };
    let (room, user, presence, muted, tab) = match claim {
        Claim::Open { room, user } => (room, user, None, false, None),
        Claim::Grant(grant) => match voice.api.redeem(&grant).await {
            Ok(who) => {
                let room = format!("{}/{}", who.server, who.channel);
                let presence = Presence::new(voice.api.clone(), who.user_id, who.server, who.channel);
                (room, who.name, Some(Arc::new(presence)), who.muted, who.tab)
            }
            Err(e) => return refuse(&mut socket, e).await,
        },
    };
    let Some(mut sat) = voice.sit(&mut held, &room, &user, presence.as_ref(), tab.as_deref(), muted) else {
        return refuse(&mut socket, "room full").await;
    };
    let tag = format!("voice {room} seat {}", sat.seat);
    log::info!("{tag}: {user} joined");
    let mut attached = None;
    let joined = Joined { labels: read_labels(&text) };
    talk(&voice, &mut socket, &tag, sdp, &offer, &mut sat, presence.clone(), &mut attached, joined).await;
    log::info!("{tag}: {user} left");
    drop(held);
    if let (Some(presence), Some(_)) = (presence, attached) {
        presence.left(&voice).await;
    }
}

struct Line {
    sender: Arc<RTCRtpSender>,
    idle: Arc<TrackLocalStaticRTP>,
    bound: Option<u64>,
}

struct Joined {
    labels: HashMap<String, String>,
}

#[allow(clippy::too_many_arguments)]
async fn talk(
    voice: &Voice,
    socket: &mut WebSocket,
    tag: &str,
    sdp: String,
    offer: &[Section],
    sat: &mut Sat,
    presence: Option<Arc<Presence>>,
    attached: &mut Option<tokio::task::JoinHandle<()>>,
    joined: Joined,
) {
    let (seat, seats) = (sat.seat, &mut sat.seats);
    let Some(me) = seats.borrow().get(seat).cloned().flatten() else {
        return refuse(socket, "server error").await;
    };
    let Some(kinds) = sending_kinds(offer, &joined.labels) else {
        return refuse(socket, "bad offer").await;
    };
    let session = crate::timings::Session::open("webrtc", "call");
    let connecting = Arc::new(crate::timings::Setup::start("webrtc", "call"));
    let dead = Arc::new(Notify::new());
    let linked = Arc::new(AtomicBool::new(false));
    let peer = match voice_peer(voice, tag, dead.clone(), linked.clone(), connecting.clone()).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("{tag}: peer setup: {e}");
            return refuse(socket, "server error").await;
        }
    };

    let mut idles = Vec::new();
    let mut video = Video::default();
    let setup = async {
        peer.add_transceiver_from_kind(
            RTPCodecType::Audio,
            Some(RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Recvonly, send_encodings: vec![] }),
        )
        .await?;
        let heard = offer.iter().filter(|s| s.kind == Media::Audio && s.receives && !s.sends).count();
        for i in 1..heard + 1 {
            let idle = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("line{i}"), "voice".to_owned()));
            add_line(&peer, idle.clone()).await?;
            idles.push(idle);
        }
        anyhow::Ok(video.add_lines(&peer, offer).await?)
    };
    let video_idles = match setup.await {
        Ok(video_idles) => video_idles,
        Err(e) => {
            log::error!("{tag}: transceivers: {e}");
            let _ = peer.close().await;
            return refuse(socket, "server error").await;
        }
    };

    let mic_mid = offer[0].mid.clone();
    let writer = sat.mic.clone();
    let muted = sat.muted.clone();
    let shown = Shower { kinds: Arc::new(Mutex::new(kinds.clone())), show: me.show.clone(), peer: Arc::downgrade(&peer) };
    let showing = shown.clone();
    let ingest = crate::timings::line("session", "webrtc", "call", crate::timings::Dir::In);
    let delivery = crate::timings::line("session", "webrtc", "call", crate::timings::Dir::Out);
    peer.on_track(Box::new(move |track, _, transceiver| {
        let (ingest, delivery) = (ingest.clone(), delivery.clone());
        let mic = writer.clone();
        let mic_mid = mic_mid.clone();
        let muted = muted.clone();
        let showing = showing.clone();
        tokio::spawn(async move {
            if transceiver.mid().map(|m| m.to_string()) != mic_mid {
                return showing.forward(track, transceiver.mid().map(|m| m.to_string())).await;
            }
            let mut numbering = Numbering::default();
            while let Ok((mut packet, _)) = track.read_rtp().await {
                let size = crate::timings::packet_bytes(packet.payload.len());
                ingest.count(1, size);
                if muted.load(Ordering::SeqCst) {
                    numbering.skip();
                    continue;
                }
                packet.header.sequence_number = numbering.of(packet.header.sequence_number);
                packet.header.extension = false;
                packet.header.extensions.clear();
                if let Ok(written) = mic.write_rtp(&packet).await {
                    crate::timings::delivered(&delivery, written, size);
                }
            }
        });
        Box::pin(async {})
    }));

    let answer = match negotiate(&peer, sdp).await {
        Ok(answer) => answer,
        Err(e) => {
            log::warn!("{tag}: negotiate: {e}");
            let _ = peer.close().await;
            return refuse(socket, "could not negotiate").await;
        }
    };

    let mut lines: Vec<Option<Line>> = (0..offer.len()).map(|_| None).collect();
    for t in peer.get_transceivers().await {
        let Some(mid) = t.mid() else { continue };
        let Some(i) = offer.iter().position(|s| s.mid.as_deref() == Some(mid.as_str())) else { continue };
        if i == 0 || offer[i].kind != Media::Audio || t.direction() != RTCRtpTransceiverDirection::Sendonly {
            continue;
        }
        let sender = t.sender().await;
        let Some(id) = sender.track().await.map(|t| t.id().to_owned()) else { continue };
        let Some(idle) = idles.iter().find(|idle| idle.id() == id) else { continue };
        lines[i] = Some(Line { sender, idle: idle.clone(), bound: None });
    }
    video.collect(&peer, offer, &video_idles).await;
    voice.show(seat, me.id, |s| s.on = on_of(&kinds));

    if send(socket, &serde_json::json!({ "sdp": answer })).await.is_ok() {
        *attached = presence.map(|p| tokio::spawn(p.attached(seat, None)));
        let mut current = seats.borrow_and_update().clone();
        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
        let mut heard = tokio::time::Instant::now();
        let mut tell = true;
        loop {
            if tell {
                rebind(tag, &mut lines, &current, seat).await;
                let mids = video.rebind(tag, &current, seat).await;
                if send(socket, &seats_event(&current, seat, &mids)).await.is_err() {
                    break;
                }
            }
            tell = true;
            tokio::select! {
                _ = ping.tick() => {
                    tell = false;
                    if heard.elapsed() > IDLE_LIMIT {
                        log::info!("{tag}: the page went silent, dropping");
                        break;
                    }
                    if !matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Ping(Default::default()))).await, Ok(Ok(()))) {
                        break;
                    }
                }
                msg = socket.recv() => match { heard = tokio::time::Instant::now(); msg } {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(Message::Text(text))) => {
                        let Ok(said) = serde_json::from_str::<Said>(&text) else { continue };
                        if let Some(state) = said.state {
                            voice.show(seat, me.id, |s| (s.mute, s.deaf) = (state.mute, state.deaf));
                        }
                        let Some(sdp) = said.sdp else { continue };
                        match renegotiate(tag, &peer, offer, &text, sdp, &shown, &mut video).await {
                            Ok((answer, kinds)) => {
                                voice.show(seat, me.id, |s| s.on = on_of(&kinds));
                                if send(socket, &serde_json::json!({ "sdp": answer })).await.is_err() {
                                    break;
                                }
                            }
                            Err(why) => {
                                refuse(socket, why).await;
                                break;
                            }
                        }
                    }
                    _ => tell = false,
                },
                _ = sat.kick.notified() => {
                    log::info!("{tag}: disconnected by a moderator");
                    refuse(socket, "disconnected").await;
                    break;
                }
                _ = sat.replaced.notified() => {
                    log::info!("{tag}: replaced by a newer join from the same tab");
                    let _ = tokio::time::timeout(Duration::from_secs(1), refuse(socket, "replaced")).await;
                    break;
                }
                _ = dead.notified() => {
                    let why = gone_word(linked.load(Ordering::SeqCst), voice.udp_port);
                    session.fail(&why);
                    log::info!("{tag}: peer gone: {why}");
                    refuse(socket, &why).await;
                    break;
                }
                changed = seats.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    current = seats.borrow_and_update().clone();
                }
            }
        }
    }
    connecting.done(false);
    let _ = peer.close().await;
    drop(session);
}

fn on_of(kinds: &HashMap<String, Kind>) -> [bool; 2] {
    Kind::ALL.map(|k| kinds.values().any(|&v| v == k))
}

async fn renegotiate(
    tag: &str,
    peer: &RTCPeerConnection,
    first: &[Section],
    text: &str,
    sdp: String,
    shown: &Shower,
    video: &mut Video,
) -> Result<(String, HashMap<String, Kind>), &'static str> {
    let offer = check_offer(&sdp).filter(|next| same_audio(first, next)).ok_or("bad offer")?;
    let kinds = sending_kinds(&offer, &read_labels(text)).ok_or("bad offer")?;
    *shown.kinds.lock().unwrap_or_else(|e| e.into_inner()) = kinds.clone();
    let idles = video.add_lines(peer, &offer).await.map_err(|e| {
        log::error!("{tag}: video transceivers: {e}");
        "server error"
    })?;
    let answer = negotiate(peer, sdp).await.map_err(|e| {
        log::warn!("{tag}: renegotiate: {e}");
        "could not negotiate"
    })?;
    video.collect(peer, &offer, &idles).await;
    Ok((answer, kinds))
}

#[derive(Clone)]
struct Shower {
    kinds: Arc<Mutex<HashMap<String, Kind>>>,
    show: Show,
    peer: Weak<RTCPeerConnection>,
}

impl Shower {
    async fn forward(self, track: Arc<TrackRemote>, mid: Option<String>) {
        let kind = mid.and_then(|mid| self.kinds.lock().unwrap_or_else(|e| e.into_inner()).get(&mid).copied());
        let Some(kind) = kind.filter(|_| track.kind() == RTPCodecType::Video) else { return };
        let out = self.show.tracks[kind as usize].clone();
        let key = self.show.keys[kind as usize].clone();
        let (peer, ssrc) = (self.peer.clone(), track.ssrc());
        let asking = tokio::spawn(async move {
            loop {
                key.notified().await;
                let Some(peer) = peer.upgrade() else { break };
                let pli = PictureLossIndication { sender_ssrc: 0, media_ssrc: ssrc };
                let _ = peer.write_rtcp(&[Box::new(pli)]).await;
                drop(peer);
                tokio::time::sleep(KEYFRAME_GAP).await;
            }
        });
        let ingest = crate::timings::line("session", "webrtc", "screen", crate::timings::Dir::In);
        let delivery = crate::timings::line("session", "webrtc", "screen", crate::timings::Dir::Out);
        while let Ok((mut packet, _)) = track.read_rtp().await {
            packet.header.extension = false;
            packet.header.extensions.clear();
            let size = crate::timings::packet_bytes(packet.payload.len());
            ingest.count(1, size);
            if let Ok(written) = out.write_rtp(&packet).await {
                crate::timings::delivered(&delivery, written, size);
            }
        }
        asking.abort();
    }
}

struct Screen {
    mid: String,
    sender: Arc<RTCRtpSender>,
    idle: Arc<TrackLocalStaticRTP>,
    bound: Option<(u64, Kind)>,
    key: Arc<Mutex<Option<Arc<Notify>>>>,
}

#[derive(Default)]
struct Video {
    lines: Vec<Screen>,
    made: usize,
}

impl Video {
    async fn add_lines(&mut self, peer: &RTCPeerConnection, offer: &[Section]) -> anyhow::Result<Vec<Arc<TrackLocalStaticRTP>>> {
        let new = offer
            .iter()
            .filter(|s| s.kind == Media::Video && s.receives && !s.sends)
            .filter(|s| !self.lines.iter().any(|l| s.mid.as_deref() == Some(l.mid.as_str())))
            .count();
        let mut idles = Vec::new();
        for _ in 0..new {
            self.made += 1;
            let idle = Arc::new(TrackLocalStaticRTP::new(vp8_capability(), format!("video{}", self.made), "voice".to_owned()));
            add_line(peer, idle.clone()).await?;
            idles.push(idle);
        }
        Ok(idles)
    }

    async fn collect(&mut self, peer: &RTCPeerConnection, offer: &[Section], idles: &[Arc<TrackLocalStaticRTP>]) {
        for t in peer.get_transceivers().await {
            let Some(mid) = t.mid().map(|m| m.to_string()) else { continue };
            if self.lines.iter().any(|l| l.mid == mid) || !offer.iter().any(|s| s.kind == Media::Video && s.mid.as_deref() == Some(mid.as_str())) {
                continue;
            }
            let sender = t.sender().await;
            let Some(id) = sender.track().await.map(|t| t.id().to_owned()) else { continue };
            let Some(idle) = idles.iter().find(|idle| idle.id() == id) else { continue };
            let key: Arc<Mutex<Option<Arc<Notify>>>> = Arc::default();
            let (reader, bell) = (sender.clone(), key.clone());
            tokio::spawn(async move {
                while let Ok((packets, _)) = reader.read_rtcp().await {
                    let wants = packets.iter().any(|p| {
                        let any = p.as_any();
                        any.downcast_ref::<PictureLossIndication>().is_some() || any.downcast_ref::<FullIntraRequest>().is_some()
                    });
                    if let Some(bell) = wants.then(|| bell.lock().unwrap_or_else(|e| e.into_inner()).clone()).flatten() {
                        bell.notify_one();
                    }
                }
            });
            self.lines.push(Screen { mid, sender, idle: idle.clone(), bound: None, key });
        }
    }

    async fn rebind(&mut self, tag: &str, seats: &[Option<Sitter>], own: usize) -> HashMap<(u64, Kind), String> {
        let wanted: Vec<(u64, Kind, &Show)> = seats
            .iter()
            .enumerate()
            .filter(|&(seat, _)| seat != own)
            .filter_map(|(_, s)| s.as_ref())
            .flat_map(|s| Kind::ALL.into_iter().filter(|&k| s.show.on[k as usize]).map(move |k| (s.id, k, &s.show)))
            .collect();
        for line in &mut self.lines {
            let Some(bound) = line.bound else { continue };
            if wanted.iter().any(|&(id, kind, _)| (id, kind) == bound) {
                continue;
            }
            match line.sender.replace_track(Some(line.idle.clone() as Arc<dyn TrackLocal + Send + Sync>)).await {
                Ok(()) => {
                    line.bound = None;
                    *line.key.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
                Err(e) => log::warn!("{tag}: video {}: replace track: {e}", line.mid),
            }
        }
        for &(id, kind, show) in &wanted {
            if self.lines.iter().any(|l| l.bound == Some((id, kind))) {
                continue;
            }
            let Some(line) = self.lines.iter_mut().find(|l| l.bound.is_none()) else { break };
            let track = show.tracks[kind as usize].clone();
            match line.sender.replace_track(Some(track as Arc<dyn TrackLocal + Send + Sync>)).await {
                Ok(()) => {
                    line.bound = Some((id, kind));
                    let key = show.keys[kind as usize].clone();
                    key.notify_one();
                    *line.key.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
                }
                Err(e) => log::warn!("{tag}: video {}: replace track: {e}", line.mid),
            }
        }
        self.lines.iter().filter_map(|l| Some((l.bound?, l.mid.clone()))).collect()
    }
}

async fn add_line(peer: &RTCPeerConnection, idle: Arc<TrackLocalStaticRTP>) -> anyhow::Result<()> {
    let t = peer
        .add_transceiver_from_track(
            idle as Arc<dyn TrackLocal + Send + Sync>,
            Some(RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Sendonly, send_encodings: vec![] }),
        )
        .await?;
    t.sender().await.enable_seq_transformer()?;
    Ok(())
}

async fn rebind(tag: &str, lines: &mut [Option<Line>], seats: &[Option<Sitter>], own: usize) {
    for (seat, sitter) in seats.iter().enumerate() {
        if seat == own {
            continue;
        }
        let Some(Some(line)) = lines.get_mut(line_of(seat, own)) else { continue };
        let want = sitter.as_ref().map(|s| s.id);
        if line.bound == want {
            continue;
        }
        let track: Arc<dyn TrackLocal + Send + Sync> = match sitter {
            Some(s) => s.mic.clone(),
            None => line.idle.clone(),
        };
        match line.sender.replace_track(Some(track)).await {
            Ok(()) => line.bound = want,
            Err(e) => log::warn!("{tag}: seat {seat}: replace track: {e}"),
        }
    }
}

fn seats_event(seats: &[Option<Sitter>], own: usize, mids: &HashMap<(u64, Kind), String>) -> serde_json::Value {
    let list: Vec<SeatInfo> = seats
        .iter()
        .enumerate()
        .filter(|&(seat, _)| seat != own)
        .filter_map(|(seat, s)| {
            let s = s.as_ref()?;
            let video = Kind::ALL
                .into_iter()
                .filter(|&k| s.show.on[k as usize])
                .map(|k| Shown { kind: k.word(), mid: mids.get(&(s.id, k)).cloned() })
                .collect();
            Some(SeatInfo { seat, user: &s.user, line: line_of(seat, own), mute: s.show.mute, deaf: s.show.deaf, video })
        })
        .collect();
    serde_json::json!({ "event": "seats", "seats": list })
}

async fn negotiate(peer: &RTCPeerConnection, sdp: String) -> anyhow::Result<String> {
    tokio::time::timeout(JOIN_TIMEOUT, async {
        peer.set_remote_description(RTCSessionDescription::offer(sdp)?).await?;
        let answer = peer.create_answer(None).await?;
        let mut gathered = peer.gathering_complete_promise().await;
        peer.set_local_description(answer).await?;
        let _ = gathered.recv().await;
        let local = peer.local_description().await.ok_or_else(|| anyhow::anyhow!("no local description"))?;
        Ok(local.sdp)
    })
    .await
    .map_err(|_| anyhow::anyhow!("negotiation timed out"))?
}

fn gone_word(linked: bool, udp_port: u16) -> String {
    if linked {
        "voice lost its connection".to_owned()
    } else {
        format!("no audio path: nothing reached the voice server over udp {udp_port}, a firewall is closing it")
    }
}

async fn voice_peer(voice: &Voice, tag: &str, dead: Arc<Notify>, linked: Arc<AtomicBool>, setup: Arc<crate::timings::Setup>) -> anyhow::Result<RTCPeerConnection> {
    let (media, registry) = voice_media_setup()?;
    let mut setting = SettingEngine::default();
    setting.set_udp_network(UDPNetwork::Muxed(voice.mux.clone()));
    setting.set_network_types(vec![NetworkType::Udp4]);
    let taken = Arc::new(AtomicBool::new(false));
    setting.set_ip_filter(Box::new(move |ip: IpAddr| {
        ip.is_ipv4() && !ip.is_loopback() && !taken.swap(true, Ordering::SeqCst)
    }));
    setting.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    setting.set_nat_1to1_ips(vec![voice.public_ip.clone()], RTCIceCandidateType::Host);
    setting.set_ice_timeouts(
        Some(Duration::from_secs(5)),
        Some(Duration::from_secs(15)),
        Some(Duration::from_secs(2)),
    );
    let api = APIBuilder::new()
        .with_setting_engine(setting)
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let peer = api.new_peer_connection(RTCConfiguration::default()).await?;
    let ice_tag = tag.to_owned();
    peer.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        log::info!("{ice_tag}: ice {state}");
        Box::pin(async {})
    }));
    let pair_tag = tag.to_owned();
    peer.dtls_transport().ice_transport().on_selected_candidate_pair_change(Box::new(move |pair: RTCIceCandidatePair| {
        log::info!("{pair_tag}: ice pair {pair}");
        Box::pin(async {})
    }));
    let tag = tag.to_owned();
    peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        log::info!("{tag}: peer {state}");
        if state == RTCPeerConnectionState::Connected {
            setup.done(true);
            linked.store(true, Ordering::SeqCst);
        }
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            setup.fail(&format!("peer {state} before it connected"));
            dead.notify_one();
        }
        Box::pin(async {})
    }));
    Ok(peer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(lines: &[(&str, &str)]) -> String {
        let mut sdp = String::from("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
        for (i, (kind, dir)) in lines.iter().enumerate() {
            sdp += &format!("m={kind} 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:{i}\r\na={dir}\r\n");
        }
        sdp
    }

    fn voice_offer(recv: usize) -> String {
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("audio", "recvonly"), recv));
        offer(&lines)
    }

    fn sitter(user: &str, uid: Option<&str>) -> Sitter {
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic-{user}"), "voice".to_owned()));
        Sitter {
            user: user.to_owned(),
            uid: uid.map(str::to_owned),
            tab: None,
            presence: None,
            id: 0,
            mic,
            muted: Arc::default(),
            kick: Arc::new(Notify::new()),
            replaced: Arc::new(Notify::new()),
            show: Show::new(0),
        }
    }

    fn room_of(sitters: Vec<Sitter>) -> Room {
        let mut seats = Seats::new();
        for s in sitters {
            seats.take(s);
        }
        Room { seats, tx: watch::Sender::new(Arc::new(Vec::new())) }
    }

    #[test]
    fn a_long_mute_leaves_no_gap_in_the_numbers() {
        let mut numbering = Numbering::default();
        let mut seq: u16 = 60000;
        let mut sent = Vec::new();
        for i in 0..40100u32 {
            if (50..40050).contains(&i) {
                numbering.skip();
            } else {
                sent.push(numbering.of(seq));
            }
            seq = seq.wrapping_add(1);
        }
        assert_eq!(sent.len(), 100);
        assert!(sent.windows(2).all(|w| w[1] == w[0].wrapping_add(1)), "{sent:?}");
        assert_eq!(sent[0], 60000);
    }

    #[test]
    fn a_mute_reaches_every_seat_of_theirs_in_that_server_and_no_other() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![sitter("al", Some("u1")), sitter("bo", Some("u2"))]));
        rooms.rooms.insert("g/afk".into(), room_of(vec![sitter("al", Some("u1"))]));
        rooms.rooms.insert("h/lounge".into(), room_of(vec![sitter("al", Some("u1"))]));
        rooms.rooms.insert("g/dev".into(), room_of(vec![sitter("u1", None)]));
        let muted = |rooms: &Rooms, room: &str, seat: usize| rooms.rooms[room].seats.0[seat].as_ref().unwrap().muted.load(Ordering::SeqCst);

        assert_eq!(rooms.moderate("u1", "g", Action::Mute, None), 2);
        assert!(muted(&rooms, "g/lounge", 0) && muted(&rooms, "g/afk", 0));
        assert!(!muted(&rooms, "g/lounge", 1), "not bo");
        assert!(!muted(&rooms, "h/lounge", 0), "not another server");
        assert!(!muted(&rooms, "g/dev", 0), "not a name alone");
        assert_eq!(rooms.moderate("u1", "g", Action::Unmute, None), 2);
        assert!(!muted(&rooms, "g/lounge", 0));
        assert_eq!(rooms.moderate("nobody", "g", Action::Mute, None), 0);
    }

    fn tabbed(user: &str, uid: &str, tab: &str, id: u64) -> Sitter {
        Sitter { tab: Some(tab.to_owned()), id, ..sitter(user, Some(uid)) }
    }

    fn ids(room: &Room) -> Vec<Option<u64>> {
        room.seats.0.iter().map(|s| s.as_ref().map(|s| s.id)).filter(|s| s.is_some()).collect()
    }

    #[tokio::test]
    async fn a_join_from_the_same_tab_takes_that_tabs_seat_and_no_other() {
        let mut rooms = Rooms::default();
        let old = tabbed("a", "u1", "t1", 1);
        let bell = old.replaced.clone();
        let second = tabbed("a", "u1", "t2", 2);
        let quiet = second.replaced.clone();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![old, second, tabbed("b", "u2", "t1", 3)]));
        let mut seen = rooms.rooms["g/lounge"].tx.subscribe();
        assert_eq!(rooms.replace("u1", "t1", "g/lounge"), 1);
        assert_eq!(ids(&rooms.rooms["g/lounge"]), vec![Some(2), Some(3)], "the second tab and someone else's same-named tab stay");
        assert!(rooms.rooms["g/lounge"].seats.0[0].is_none(), "the old seat is free for the new join");
        tokio::time::timeout(Duration::from_millis(100), bell.notified()).await.expect("the old socket is told");
        assert!(tokio::time::timeout(Duration::from_millis(50), quiet.notified()).await.is_err(), "the second tab is not");
        assert!(!seen.has_changed().unwrap(), "the room the join sits in hears it from the join");
        assert_eq!(rooms.replace("u1", "t1", "g/lounge"), 0);
    }

    #[test]
    fn a_tab_that_moves_leaves_its_old_room() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![tabbed("a", "u1", "t1", 1)]));
        rooms.rooms.insert("g/back".into(), room_of(vec![tabbed("a", "u1", "t1", 2), tabbed("b", "u2", "x", 3)]));
        let mut back = rooms.rooms["g/back"].tx.subscribe();
        assert_eq!(rooms.replace("u1", "t1", "g/other"), 2);
        assert!(!rooms.rooms.contains_key("g/lounge"), "a room left empty goes");
        assert_eq!(ids(&rooms.rooms["g/back"]), vec![Some(3)]);
        assert!(back.has_changed().unwrap(), "a room it left hears its seats now");
        let now = back.borrow_and_update();
        assert_eq!(now.iter().flatten().map(|s| s.id).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn a_renamed_channel_keeps_its_room_and_everyone_in_it() {
        let api = Api { url: "http://127.0.0.1:9".into(), secret: None, http: reqwest::Client::new() };
        let presence = Arc::new(Presence::new(api, "u1".into(), "g".into(), "lounge".into()));
        let al = Sitter { presence: Some(presence.clone()), id: 7, ..sitter("al", Some("u1")) };
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![al, tabbed("bo", "u2", "t", 8)]));
        rooms.rooms.insert("h/lounge".into(), room_of(vec![sitter("cy", Some("u3"))]));
        let mut seen = rooms.rooms["g/lounge"].tx.subscribe();
        let order: Order = serde_json::from_str(r#"{"action":"rename","server":"g","channel":"lounge","to":"hall"}"#).unwrap();
        assert_eq!((order.action, order.channel.as_deref(), order.to.as_deref()), (Action::Rename, Some("lounge"), Some("hall")));

        assert_eq!(rooms.rename("g", "lounge", "hall"), 2);
        assert!(!rooms.rooms.contains_key("g/lounge"));
        assert_eq!(ids(&rooms.rooms["g/hall"]), vec![Some(7), Some(8)]);
        assert!(rooms.rooms.contains_key("h/lounge"), "another server's lounge stays");
        assert_eq!(*presence.channel.lock().unwrap(), "hall");
        assert!(!seen.has_changed().unwrap(), "the same room, so its peers keep listening");

        rooms.let_go(0, 7);
        assert_eq!(ids(&rooms.rooms["g/hall"]), vec![Some(8)], "a seat taken before the rename is still let go");
        assert!(seen.has_changed().unwrap());
        rooms.let_go(1, 8);
        assert!(!rooms.rooms.contains_key("g/hall"));
        assert_eq!(rooms.rename("g", "nothing", "x"), 0);
    }

    #[test]
    fn a_rename_onto_a_room_with_seats_leaves_both() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/a".into(), room_of(vec![tabbed("al", "u1", "t", 1)]));
        rooms.rooms.insert("g/b".into(), room_of(vec![tabbed("bo", "u2", "t", 2)]));
        assert_eq!(rooms.rename("g", "a", "b"), 0);
        assert_eq!(ids(&rooms.rooms["g/a"]), vec![Some(1)]);
        assert_eq!(ids(&rooms.rooms["g/b"]), vec![Some(2)]);
        rooms.let_go(0, 9);
        assert_eq!(ids(&rooms.rooms["g/a"]), vec![Some(1)], "another sitter's id frees nothing");
    }

    async fn scripted_api(statuses: Vec<u16>) -> (Api, Arc<Mutex<Vec<String>>>) {
        let calls: Arc<Mutex<Vec<String>>> = Arc::default();
        let script = Arc::new(Mutex::new(statuses.into_iter()));
        let (seen, next) = (calls.clone(), script.clone());
        let app = Router::new().route(
            "/api/voice/{what}",
            post(move |axum::extract::Path(what): axum::extract::Path<String>| {
                let (seen, next) = (seen.clone(), next.clone());
                async move {
                    seen.lock().unwrap().push(what);
                    StatusCode::from_u16(next.lock().unwrap().next().unwrap_or(200)).unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        let api = Api { url, secret: Some(Arc::from("s")), http: reqwest::Client::builder().timeout(API_TIMEOUT).build().unwrap() };
        (api, calls)
    }

    fn presence(api: Api) -> Arc<Presence> {
        Arc::new(Presence::new(api, "u1".into(), "g".into(), "lounge".into()))
    }

    #[tokio::test]
    async fn an_attached_the_api_did_not_take_is_tried_again() {
        let (api, calls) = scripted_api(vec![503]).await;
        let p = presence(api);
        tokio::time::timeout(Duration::from_secs(5), p.clone().attached(0, None)).await.unwrap();
        assert_eq!(*calls.lock().unwrap(), ["attached", "attached"], "a 503, then again 1s on");
        assert!(p.turn.lock().await.is_some(), "it went through");
        let before = tokio::time::Instant::now() - Duration::from_secs(1);
        p.clone().attached(0, Some(before)).await;
        assert_eq!(calls.lock().unwrap().len(), 2);
        p.clone().attached(0, Some(tokio::time::Instant::now())).await;
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn an_attached_the_api_refused_or_a_seat_let_go_is_not_tried() {
        let (api, calls) = scripted_api(vec![403]).await;
        let p = presence(api.clone());
        p.clone().attached(0, None).await;
        p.clone().attached(0, Some(tokio::time::Instant::now())).await;
        assert_eq!(*calls.lock().unwrap(), ["attached"], "a 4xx would come again");
        let (down, calls) = scripted_api(vec![503; 10]).await;
        let p = presence(down);
        let trying = tokio::spawn(p.clone().attached(0, None));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let voice_less = || async {
            let mux = UDPMuxDefault::new(UDPMuxParams::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap()));
            Voice { public_ip: "127.0.0.1".into(), udp_port: 0, mux, open: false, api: api.clone(), state: Arc::default(), next_id: Arc::default() }
        };
        let voice = voice_less().await;
        let t = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(3), p.left(&voice)).await.expect("left does not wait out the retries");
        assert!(t.elapsed() < Duration::from_millis(900), "{:?}", t.elapsed());
        trying.await.unwrap();
        assert_eq!(*calls.lock().unwrap(), ["attached", "left"]);
        p.clone().attached(0, Some(tokio::time::Instant::now())).await;
        assert_eq!(calls.lock().unwrap().len(), 2, "nothing after the seat is let go");
    }

    #[tokio::test]
    async fn a_disconnect_is_heard_even_before_the_socket_waits_for_it() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![sitter("al", Some("u1"))]));
        let kick = rooms.rooms["g/lounge"].seats.0[0].as_ref().unwrap().kick.clone();
        assert_eq!(rooms.moderate("u1", "g", Action::Disconnect, None), 1);
        tokio::time::timeout(Duration::from_millis(100), kick.notified()).await.expect("the disconnect was kept for the socket");
    }

    #[test]
    fn an_order_reads() {
        let o: Order = serde_json::from_str(r#"{"action":"disconnect","user_id":"u1","server":"g"}"#).unwrap();
        assert_eq!((o.action, o.user_id.as_str(), o.server.as_str()), (Action::Disconnect, "u1", "g"));
        assert!(serde_json::from_str::<Order>(r#"{"action":"ban","user_id":"u1","server":"g"}"#).is_err());
        let r: Redeemed = serde_json::from_str(r#"{"user_id":"u","name":"al","server":"g","channel":"lounge"}"#).unwrap();
        assert!(!r.muted, "an older api says nothing: not muted");
        let r: Redeemed = serde_json::from_str(r#"{"user_id":"u","name":"al","server":"g","channel":"lounge","muted":true}"#).unwrap();
        assert!(r.muted);
        assert_eq!(r.tab, None, "an older api names no tab");
        let r: Redeemed = serde_json::from_str(r#"{"user_id":"u","name":"al","server":"g","channel":"lounge","tab":"t1"}"#).unwrap();
        assert_eq!(r.tab.as_deref(), Some("t1"));
        let o: Order = serde_json::from_str(r#"{"action":"count","user_id":"u1","server":"g","tab":"t1"}"#).unwrap();
        assert_eq!((o.action, o.tab.as_deref()), (Action::Count, Some("t1")));
    }

    #[test]
    fn a_count_leaves_out_the_asking_tab_and_touches_nothing() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![tabbed("al", "u1", "t1", 1), tabbed("bo", "u2", "t9", 2)]));
        rooms.rooms.insert("g/afk".into(), room_of(vec![tabbed("al", "u1", "t2", 3)]));
        rooms.rooms.insert("h/lounge".into(), room_of(vec![tabbed("al", "u1", "t3", 4)]));
        assert_eq!(rooms.moderate("u1", "g", Action::Count, None), 2, "both tabs in g");
        assert_eq!(rooms.moderate("u1", "g", Action::Count, Some("t1")), 1, "t1 asks: its own seat is not another call, t2's is");
        assert_eq!(rooms.moderate("u1", "g", Action::Count, Some("t2")), 1);
        assert_eq!(rooms.moderate("u1", "g", Action::Count, Some("t3")), 2);
        assert_eq!(rooms.moderate("u1", "h", Action::Count, Some("t3")), 0, "a voice server that holds only this tab's seat");
        assert_eq!(rooms.moderate("u9", "g", Action::Count, None), 0, "a voice server that never saw them (restarted)");
        assert!(!rooms.rooms["g/lounge"].seats.0[0].as_ref().unwrap().muted.load(Ordering::SeqCst));
    }

    #[test]
    fn the_internal_gate() {
        let mut h = HeaderMap::new();
        assert_eq!(inside(&h, Some("s3cret")), Err(StatusCode::FORBIDDEN));
        h.insert("x-voice-secret", "nope".parse().unwrap());
        assert_eq!(inside(&h, Some("s3cret")), Err(StatusCode::FORBIDDEN));
        h.insert("x-voice-secret", "s3cret".parse().unwrap());
        assert_eq!(inside(&h, Some("s3cret")), Ok(()));
        assert_eq!(inside(&h, None), Err(StatusCode::SERVICE_UNAVAILABLE));
        h.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        assert_eq!(inside(&h, Some("s3cret")), Err(StatusCode::NOT_FOUND));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "abcd") && !same("", "a"));
    }

    #[test]
    fn seats_go_lowest_free_first() {
        let mut seats = Seats::new();
        assert_eq!(seats.take("a"), Some(0));
        assert_eq!(seats.take("b"), Some(1));
        assert_eq!(seats.take("c"), Some(2));
        assert_eq!(seats.free(1), Some("b"));
        assert_eq!(seats.take("d"), Some(1));
        assert_eq!(seats.take("e"), Some(3));
        assert_eq!(seats.free(0), Some("a"));
        assert_eq!(seats.free(0), None);
        assert_eq!(seats.take("f"), Some(0));
        assert_eq!(seats.taken(), 4);
    }

    #[test]
    fn full_at_sixteen() {
        let mut seats = Seats::new();
        for i in 0..16 {
            assert_eq!(seats.take(i), Some(i));
        }
        assert_eq!(seats.take(16), None);
        assert_eq!(seats.free(9), Some(9));
        assert_eq!(seats.take(17), Some(9));
        assert_eq!(seats.take(18), None);
    }

    #[test]
    fn own_seat_has_no_line() {
        assert_eq!((1..16).map(|s| line_of(s, 0)).collect::<Vec<_>>(), (1..16).collect::<Vec<_>>());
        assert_eq!(line_of(0, 3), 1);
        assert_eq!(line_of(2, 3), 3);
        assert_eq!(line_of(4, 3), 4);
        assert_eq!(line_of(14, 15), 15);
    }

    #[test]
    fn good_offers() {
        assert_eq!(check_offer(&voice_offer(15)).map(|s| s.len()), Some(16));
        assert_eq!(check_offer(&voice_offer(0)).map(|s| s.len()), Some(1));
        assert!(check_offer(&offer(&[("audio", "sendonly"), ("audio", "recvonly")])).is_some());
    }

    #[test]
    fn video_offers() {
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("audio", "recvonly"), 15));
        lines.extend([("video", "sendonly"), ("video", "sendonly")]);
        lines.extend(std::iter::repeat_n(("video", "recvonly"), 30));
        let sections = check_offer(&offer(&lines)).expect("a full video offer");
        assert_eq!(sections.iter().filter(|s| s.kind == Media::Video).count(), 32);
        assert!(check_offer(&offer(&[("audio", "sendrecv"), ("video", "inactive"), ("video", "sendonly"), ("video", "sendonly")])).is_some());
    }

    #[test]
    fn what_a_page_sends_is_named() {
        let sections = check_offer(&offer(&[("audio", "sendrecv"), ("video", "sendonly"), ("video", "sendonly"), ("video", "recvonly")])).unwrap();
        let labels = |v: serde_json::Value| read_labels(&serde_json::json!({ "sdp": "x", "video": v }).to_string());
        let kinds = sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera", "2": "screen", "3": "camera" }))).unwrap();
        assert_eq!(kinds, HashMap::from([("1".to_owned(), Kind::Camera), ("2".to_owned(), Kind::Screen)]));
        assert_eq!(on_of(&kinds), [true, true]);
        assert!(sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera" }))).is_none());
        assert!(sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera", "2": "face" }))).is_none());
        assert!(sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera", "2": "camera" }))).is_none());
        let audio = check_offer(&voice_offer(15)).unwrap();
        assert_eq!(sending_kinds(&audio, &read_labels(r#"{"role":"voice","sdp":"x"}"#)), Some(HashMap::new()));
        assert_eq!(on_of(&HashMap::new()), [false, false]);
    }

    #[test]
    fn a_later_offer_keeps_the_audio() {
        let first = check_offer(&voice_offer(3)).unwrap();
        let mut lines = vec![("audio", "sendrecv"), ("audio", "recvonly"), ("audio", "recvonly"), ("audio", "recvonly"), ("video", "sendonly")];
        assert!(same_audio(&first, &check_offer(&offer(&lines)).unwrap()));
        lines.push(("audio", "recvonly"));
        assert!(!same_audio(&first, &check_offer(&offer(&lines)).unwrap()));
        assert!(!same_audio(&first, &check_offer(&voice_offer(2)).unwrap()));
    }

    fn seated(user: &str, id: u64, on: [bool; 2]) -> Sitter {
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic{id}"), "voice".to_owned()));
        let mut show = Show::new(id);
        show.on = on;
        Sitter { show, id, mic, ..sitter(user, None) }
    }

    #[test]
    fn the_seats_frame_says_what_each_shows() {
        let seats = vec![Some(seated("a", 1, [true, false])), Some(seated("b", 2, [true, true])), None, Some(seated("c", 3, [false, false]))];
        let mids = HashMap::from([((2, Kind::Camera), "20".to_owned())]);
        let frame = seats_event(&seats, 0, &mids);
        assert_eq!(
            frame,
            serde_json::json!({ "event": "seats", "seats": [
                { "seat": 1, "user": "b", "line": 1, "mute": false, "deaf": false, "video": [{ "kind": "camera", "mid": "20" }, { "kind": "screen", "mid": null }] },
                { "seat": 3, "user": "c", "line": 3, "mute": false, "deaf": false, "video": [] },
            ] })
        );
    }

    #[test]
    fn bad_offers() {
        assert!(check_offer(&voice_offer(16)).is_none());
        assert!(check_offer(&offer(&[("video", "sendrecv")])).is_none());
        assert!(check_offer(&offer(&[("video", "sendonly"), ("audio", "sendrecv")])).is_none());
        assert!(check_offer(&offer(&[("audio", "sendrecv"), ("application", "sendrecv")])).is_none());
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("video", "sendonly"), 3));
        assert!(check_offer(&offer(&lines)).is_none());
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("video", "recvonly"), 33));
        assert!(check_offer(&offer(&lines)).is_none());
        assert!(check_offer(&offer(&[("audio", "recvonly"), ("audio", "recvonly")])).is_none());
        assert!(check_offer(&offer(&[("audio", "inactive")])).is_none());
        assert!(check_offer("v=0\r\n").is_none());
        assert!(check_offer("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n").is_none());
        let big = voice_offer(1) + &"a=x\r\n".repeat(MAX_SDP_BYTES / 5);
        assert!(check_offer(&big).is_none());
    }

    fn browser_offer(candidates: impl Fn(usize) -> usize) -> String {
        let audio = "a=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n".repeat(10);
        let video = "a=rtpmap:96 VP8/90000\r\na=rtcp-fb:96 nack pli\r\na=rtcp-fb:96 transport-cc\r\na=rtcp-fb:96 ccm fir\r\n".repeat(10);
        let lines = MAX_MEDIA_LINES + MAX_VIDEO_LINES;
        let mids = (0..lines).map(|i| i.to_string()).collect::<Vec<_>>().join(" ");
        let mut sdp = format!("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE {mids}\r\n");
        for i in 0..lines {
            let (kind, pt, body) = if i < MAX_MEDIA_LINES { ("audio", 111, &audio) } else { ("video", 96, &video) };
            let dir = if i == 0 { "sendrecv" } else { "recvonly" };
            sdp += &format!("m={kind} 9 UDP/TLS/RTP/SAVPF {pt}\r\nc=IN IP4 0.0.0.0\r\na=mid:{i}\r\na={dir}\r\n{body}");
            for c in 0..candidates(i) {
                sdp += &format!("a=candidate:4034045772 1 udp 2122197247 2001:db8:4b2c:1d00:58f1:{c:x}:9c2e:1a07 {} typ host generation 0 network-id 2 network-cost 10\r\n", 50000 + c);
            }
        }
        sdp
    }

    #[test]
    fn a_phones_offer_fits_once_trimmed() {
        let phone = browser_offer(|_| 24);
        assert!(phone.len() > MAX_SDP_BYTES, "{}", phone.len());
        assert!(check_offer(&phone).is_none());
        let trimmed = browser_offer(|i| if i == 0 { 24 } else { 0 });
        assert!(trimmed.len() < MAX_SDP_BYTES / 2, "{}", trimmed.len());
        assert_eq!(check_offer(&trimmed).map(|s| s.len()), Some(MAX_MEDIA_LINES + MAX_VIDEO_LINES));
    }

    const GRANT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn frame(v: serde_json::Value) -> String {
        v.to_string()
    }

    #[test]
    fn a_grant_frame() {
        let granted = frame(serde_json::json!({ "role": "voice", "grant": GRANT, "sdp": "x" }));
        assert_eq!(read_join(&granted, false, true), Ok((Claim::Grant(GRANT.into()), "x".into())));
        assert_eq!(read_join(&granted, true, true), Ok((Claim::Grant(GRANT.into()), "x".into())));
        let both = frame(serde_json::json!({ "role": "voice", "grant": GRANT, "room": "a/b", "user": "c", "sdp": "x" }));
        assert_eq!(read_join(&both, true, true), Ok((Claim::Grant(GRANT.into()), "x".into())));
        assert_eq!(read_join(&granted, true, false), Err("voice is not open"));
        for bad in ["", "abc", &GRANT[1..], &format!("{GRANT}0"), &GRANT.replace('a', "g")] {
            let f = frame(serde_json::json!({ "role": "voice", "grant": bad, "sdp": "x" }));
            assert_eq!(read_join(&f, true, true), Err("bad grant"), "{bad:?}");
        }
    }

    #[test]
    fn the_dev_open_frame() {
        let old = frame(serde_json::json!({ "role": "voice", "room": "spike/lounge", "user": "a", "sdp": "x" }));
        let open = Claim::Open { room: "spike/lounge".into(), user: "a".into() };
        assert_eq!(read_join(&old, true, false), Ok((open, "x".into())));
        assert_eq!(read_join(&old, false, true), Err("bad grant"));
        let bad_room = frame(serde_json::json!({ "role": "voice", "room": "Spike", "user": "a", "sdp": "x" }));
        assert_eq!(read_join(&bad_room, true, false), Err("bad join"));
        let no_user = frame(serde_json::json!({ "role": "voice", "room": "spike/lounge", "sdp": "x" }));
        assert_eq!(read_join(&no_user, true, false), Err("bad join"));
    }

    #[test]
    fn frames_that_are_not_joins() {
        assert_eq!(read_join("nope", true, true), Err("bad json"));
        assert_eq!(read_join(&frame(serde_json::json!({ "role": "voice", "grant": GRANT })), true, true), Err("bad json"));
        let watch = frame(serde_json::json!({ "role": "watch", "grant": GRANT, "sdp": "x" }));
        assert_eq!(read_join(&watch, true, true), Err("bad join"));
    }

    #[test]
    fn why_a_peer_went() {
        assert_eq!(gone_word(true, 7883), "voice lost its connection");
        assert!(gone_word(false, 7883).contains("udp 7883"));
    }

    #[test]
    fn rooms_and_users() {
        assert!(valid_room("axiom/general"));
        assert!(!valid_room("axiom"));
        assert!(!valid_room("axiom/"));
        assert!(!valid_room("a/b/c"));
        assert!(!valid_room("Axiom/general"));
        assert!(valid_user("Billy"));
        assert!(!valid_user(" "));
        assert!(!valid_user("a\nb"));
        assert!(!valid_user(&"x".repeat(33)));
    }
}
