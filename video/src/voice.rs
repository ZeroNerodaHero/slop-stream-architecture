//! `video voice`: a small voice sfu, same binary. who may talk where is the api's word: a page
//! brings a grant from `POST /api/groups/:group/voice/:channel/join`, and we redeem it once with
//! the api (`POST /api/voice/redeem`, X-Voice-Secret) for the person and the room. the room and
//! the name come from that reply, never from the page.
//!
//! websocket on :7881/ws (VOICE_WS_PORT), media on one udp port, 7883 (VOICE_UDP_PORT).
//! `GET /health` on the same port says {ok, rooms, peers}. the first frame, within 10s:
//!   {"role":"voice","grant":"<64 hex>","sdp":"<offer>"}
//! the offer is audio only: m-line 0 is your mic and must send, the rest (15 at most)
//! are recvonly and are where you hear the others. we answer {"sdp":"<answer>"} or
//! {"error":"..."}, then send
//!   {"event":"seats","seats":[{"seat":0,"user":"a","line":1},...]}
//! right after the answer and on every join and leave. a grant the api turns down (used,
//! older than 30s, no longer yours to use) is "bad grant"; an api that does not answer within
//! 1.5s is "api unreachable".
//!
//! env: API_URL (http://api:4000) and VOICE_SECRET, the api's own. with VOICE_SECRET unset or
//! empty no grant can be redeemed, and every join is "voice is not open". VOICE_DEV_OPEN=1 is
//! for the spike (test/voice-spike.js): it also takes the old frame,
//!   {"role":"voice","room":"<server>/<channel>","user":"<name>","sdp":"<offer>"}
//! from anyone, and those joins are never told to the api.
//!
//! a room has 16 seats and each person takes the lowest free one. your own seat is not
//! in the list and has no m-line: seat N is heard on m-line N+1 if N is below your seat
//! and on m-line N if it is above (`line` says which, so a page need not work it out).
//! joins and leaves only swap the track behind those m-lines (replace_track), so nobody
//! renegotiates. an empty seat's m-line gets an idle track nobody writes to: webrtc-rs
//! cannot put a track back on a sender once it was replaced with none.
//!
//! closing the socket, or the peer going failed/closed (the ice timeout), frees the seat. a
//! peer that fails is said first, as an error frame: one that never connected is "no audio
//! path" (nothing came over udp: the port is shut somewhere between, 7883 not open in the
//! cloud firewall), one that did is "voice lost its connection".
//! at most 4 voice peers per address, and /ws is rate limited per address like the stream's.
//!
//! who is in voice lives in the api (docs/voice.md), and we keep it current: `attached`
//! once a granted person has their answer, `left` when their seat frees, and every 15s one
//! `beat` naming everyone granted we have seated. a box that dies says nothing, and the api's
//! sweep drops its people within a minute. a call that fails is a warning in the log; nobody is
//! dropped for it. neither the secret nor a grant is ever logged.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::get;
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
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::media::{opus_voice_capability, voice_media_setup};
use crate::{env_port, forwarded_ip, limits, media_socket, valid_name};

const MAX_SEATS: usize = 16;
const MAX_SDP_BYTES: usize = 48 * 1024;
const MAX_MEDIA_LINES: usize = 16;
const MAX_PEERS_PER_IP: usize = 4;
const MAX_USER_CHARS: usize = 32;
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
/// how long any one call to the api may take, as the stream's (main.rs)
const API_TIMEOUT: Duration = Duration::from_millis(1500);
/// how often everyone seated is told to the api, a third of its sweep's 45s
const BEAT_EVERY: Duration = Duration::from_secs(15);

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

/// the api's internal voice routes. no Debug, so the secret cannot end up in a log line.
#[derive(Clone)]
struct Api {
    url: String,
    /// VOICE_SECRET, None while it is unset or empty: no grant can be redeemed
    secret: Option<Arc<str>>,
    http: reqwest::Client,
}

/// what a redeemed grant stands for, the api's reply
#[derive(Deserialize)]
struct Redeemed {
    user_id: String,
    name: String,
    server: String,
    channel: String,
}

impl Api {
    /// POST `path` with the secret. Err is already logged, as a warning.
    async fn post(&self, path: &str, body: &serde_json::Value) -> Result<reqwest::Response, ()> {
        let Some(secret) = &self.secret else { return Err(()) };
        self.http
            .post(format!("{}{path}", self.url))
            .header("x-voice-secret", &**secret)
            .json(body)
            .send()
            .await
            .map_err(|e| log::warn!("voice: api unreachable for {path}: {}", e.without_url()))
    }

    /// the grant, redeemed once. Err is the word for the page.
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

    /// a presence call (`attached`, `left`, `beat`): a failure is only a warning
    async fn tell(&self, path: &str, body: serde_json::Value) {
        match self.post(path, &body).await {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => log::warn!("voice: api answered {} to {path}", res.status()),
            Err(()) => {}
        }
    }
}

/// a granted person, as the api knows them: what `attached` and `left` say
struct Presence {
    api: Api,
    user_id: String,
    server: String,
    channel: String,
}

impl Presence {
    async fn attached(self: Arc<Self>, seat: usize) {
        let body = serde_json::json!({ "user_id": self.user_id, "server": self.server, "channel": self.channel, "seat": seat });
        self.api.tell("/api/voice/attached", body).await;
    }

    async fn left(&self) {
        let body = serde_json::json!({ "user_id": self.user_id, "server": self.server });
        self.api.tell("/api/voice/left", body).await;
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

/// who sits where, as every peer of the room sees it
type Snapshot = Arc<Vec<Option<Sitter>>>;

#[derive(Clone)]
struct Sitter {
    user: String,
    /// the api's user id for a granted person, None for a dev-open join
    uid: Option<String>,
    /// tells two people in the same seat apart, one after the other
    id: u64,
    mic: Arc<TrackLocalStaticRTP>,
}

/// the seats of a room. each comer takes the lowest free one.
struct Seats<T>(Vec<Option<T>>);

impl<T> Seats<T> {
    fn new() -> Self {
        Seats((0..MAX_SEATS).map(|_| None).collect())
    }

    /// the lowest free seat, or None when all 16 are taken
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

/// the m-line that carries `seat` to the person in `own`: theirs is skipped, and
/// m-line 0 is their mic
fn line_of(seat: usize, own: usize) -> usize {
    if seat < own {
        seat + 1
    } else {
        seat
    }
}

/// the first frame as it comes. `room` and `user` are the dev-open frame's.
#[derive(Deserialize)]
struct Join {
    role: String,
    grant: Option<String>,
    room: Option<String>,
    user: Option<String>,
    sdp: String,
}

/// who a join says it is: a grant to redeem, or (dev-open only) a room and a name
#[derive(Debug, PartialEq)]
enum Claim {
    Grant(String),
    Open { room: String, user: String },
}

/// the first frame read, with `open` (VOICE_DEV_OPEN=1) and `granting` (a secret to redeem
/// with). a grant wins over a room and name in the same frame. Err is the word for the page.
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

/// the shape of what join hands out: 32 bytes as hex. anything else is not worth a call.
fn valid_grant(grant: &str) -> bool {
    grant.len() == 64 && grant.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Serialize)]
struct SeatInfo<'a> {
    seat: usize,
    user: &'a str,
    line: usize,
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
        // per address, per minute, the stream's counts (limits.rs)
        .route_layer(axum::middleware::from_fn_with_state(limits::Limits::default(), limits::layer))
        .with_state(voice);

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

async fn health(State(voice): State<Voice>) -> Json<serde_json::Value> {
    let state = voice.state.lock().unwrap_or_else(|e| e.into_inner());
    let peers: usize = state.rooms.values().map(|r| r.seats.taken()).sum();
    Json(serde_json::json!({ "ok": true, "rooms": state.rooms.len(), "peers": peers }))
}

/// every `BEAT_EVERY`, one `beat` to the api naming everyone granted we have seated, so its
/// sweep keeps them. nothing is sent while nobody is.
async fn beat(voice: Voice) {
    let mut tick = tokio::time::interval(BEAT_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let peers = voice.seated();
        if !peers.is_empty() {
            voice.api.tell("/api/voice/beat", serde_json::json!({ "peers": peers })).await;
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

/// a seat and an address slot, given back on drop however the socket ends
struct Held {
    voice: Voice,
    ip: IpAddr,
    seat: Option<(String, usize)>,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut state = self.voice.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((name, seat)) = self.seat.take() {
            if let Some(room) = state.rooms.get_mut(&name) {
                room.seats.free(seat);
                if room.seats.taken() == 0 {
                    state.rooms.remove(&name);
                } else {
                    let snapshot = Arc::new(room.seats.snapshot());
                    room.tx.send_replace(snapshot);
                }
            }
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

    /// the lowest free seat in `name` with a new mic track, and the room's seats to follow
    fn sit(&self, held: &mut Held, name: &str, user: &str, uid: Option<&str>) -> Option<(usize, Arc<TrackLocalStaticRTP>, watch::Receiver<Snapshot>)> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let room = state.rooms.entry(name.to_owned()).or_insert_with(|| Room {
            seats: Seats::new(),
            tx: watch::Sender::new(Arc::new(Vec::new())),
        });
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic{id}"), "voice".to_owned()));
        let sitter = Sitter { user: user.to_owned(), uid: uid.map(str::to_owned), id, mic: mic.clone() };
        let Some(seat) = room.seats.take(sitter) else {
            if room.seats.taken() == 0 {
                state.rooms.remove(name);
            }
            return None;
        };
        held.seat = Some((name.to_owned(), seat));
        let snapshot = Arc::new(room.seats.snapshot());
        room.tx.send_replace(snapshot);
        Some((seat, mic, room.tx.subscribe()))
    }

    /// everyone granted we have seated, as `beat` names them: `[{user_id, server}]`
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

    /// whether `uid` still has a seat in `server` here (a second tab): their `left` waits for it
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
    socket.send(Message::Text(serde_json::to_string(msg)?.into())).await?;
    Ok(())
}

fn valid_room(room: &str) -> bool {
    room.split_once('/').is_some_and(|(server, channel)| valid_name(server) && valid_name(channel))
}

fn valid_user(user: &str) -> bool {
    !user.trim().is_empty() && user.chars().count() <= MAX_USER_CHARS && !user.chars().any(char::is_control)
}

/// one m= section of an offer, as far as voice cares
#[derive(Debug)]
struct Section {
    audio: bool,
    mid: Option<String>,
    sends: bool,
    receives: bool,
}

fn sections(sdp: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for line in sdp.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("m=") {
            let audio = rest.split(' ').next() == Some("audio");
            sections.push(Section { audio, mid: None, sends: true, receives: true });
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

/// the offer's sections if voice can take it: at most 48 KB, 1 to 16 m-lines, all
/// audio and all with a mid, the first one sending
fn check_offer(sdp: &str) -> Option<Vec<Section>> {
    if sdp.len() > MAX_SDP_BYTES {
        return None;
    }
    let sections = sections(sdp);
    let ok = !sections.is_empty()
        && sections.len() <= MAX_MEDIA_LINES
        && sections.iter().all(|s| s.audio && s.mid.is_some())
        && sections[0].sends;
    ok.then_some(sections)
}

async fn handle(voice: Voice, mut socket: WebSocket, ip: IpAddr) {
    let text = match tokio::time::timeout(JOIN_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        _ => return,
    };
    // no secret to redeem a grant with: closed unless a dev opened it
    if !voice.open && voice.api.secret.is_none() {
        return refuse(&mut socket, "voice is not open").await;
    }
    let (claim, sdp) = match read_join(&text, voice.open, voice.api.secret.is_some()) {
        Ok(join) => join,
        Err(e) => return refuse(&mut socket, e).await,
    };
    // the offer and the address are checked before the grant is spent on them
    let Some(offer) = check_offer(&sdp) else {
        return refuse(&mut socket, "bad offer").await;
    };
    let Some(mut held) = voice.hold_ip(ip) else {
        return refuse(&mut socket, "too many voice peers from this address").await;
    };
    let (room, user, presence) = match claim {
        Claim::Open { room, user } => (room, user, None),
        Claim::Grant(grant) => match voice.api.redeem(&grant).await {
            Ok(who) => {
                let room = format!("{}/{}", who.server, who.channel);
                let presence = Presence { api: voice.api.clone(), user_id: who.user_id, server: who.server, channel: who.channel };
                (room, who.name, Some(Arc::new(presence)))
            }
            Err(e) => return refuse(&mut socket, e).await,
        },
    };
    let uid = presence.as_ref().map(|p| p.user_id.as_str());
    let Some((seat, mic, mut seats)) = voice.sit(&mut held, &room, &user, uid) else {
        return refuse(&mut socket, "room full").await;
    };
    let tag = format!("voice {room} seat {seat}");
    log::info!("{tag}: {user} joined");
    let mut attached = None;
    talk(&voice, &mut socket, &tag, sdp, &offer, seat, mic, &mut seats, presence.clone(), &mut attached).await;
    log::info!("{tag}: {user} left");
    drop(held);
    // the seat is free: `left`, once `attached` is through so the two cannot cross
    if let (Some(presence), Some(attached)) = (presence, attached) {
        let _ = attached.await;
        if !voice.sits_in(&presence.user_id, &presence.server) {
            presence.left().await;
        }
    }
}

/// what one m-line that hears a seat is bound to
struct Line {
    sender: Arc<RTCRtpSender>,
    idle: Arc<TrackLocalStaticRTP>,
    /// the sitter whose mic it carries, None for idle
    bound: Option<u64>,
}

#[allow(clippy::too_many_arguments)]
async fn talk(
    voice: &Voice,
    socket: &mut WebSocket,
    tag: &str,
    sdp: String,
    offer: &[Section],
    seat: usize,
    mic: Arc<TrackLocalStaticRTP>,
    seats: &mut watch::Receiver<Snapshot>,
    presence: Option<Arc<Presence>>,
    attached: &mut Option<tokio::task::JoinHandle<()>>,
) {
    let dead = Arc::new(Notify::new());
    let linked = Arc::new(AtomicBool::new(false));
    let peer = match voice_peer(voice, tag, dead.clone(), linked.clone()).await {
        Ok(peer) => peer,
        Err(e) => {
            log::error!("{tag}: peer setup: {e}");
            return refuse(socket, "server error").await;
        }
    };

    // added before the offer is applied, webrtc-rs pairs them with its sections in order:
    // the mic's sending section takes the recvonly one, each recvonly section a sendonly one
    let mut idles = Vec::new();
    let setup = async {
        peer.add_transceiver_from_kind(
            RTPCodecType::Audio,
            Some(RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Recvonly, send_encodings: vec![] }),
        )
        .await?;
        for i in 1..offer.iter().filter(|s| s.receives && !s.sends).count() + 1 {
            let idle = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("line{i}"), "voice".to_owned()));
            peer.add_transceiver_from_track(
                idle.clone() as Arc<dyn TrackLocal + Send + Sync>,
                Some(RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Sendonly, send_encodings: vec![] }),
            )
            .await?;
            idles.push(idle);
        }
        anyhow::Ok(())
    };
    if let Err(e) = setup.await {
        log::error!("{tag}: transceivers: {e}");
        let _ = peer.close().await;
        return refuse(socket, "server error").await;
    }

    // packets from the mic's section go to the mic track, which other peers' seats carry.
    // header extensions carry ids from this peer's session, so drop them
    let mic_mid = offer[0].mid.clone();
    let writer = mic.clone();
    peer.on_track(Box::new(move |track, _, transceiver| {
        let mic = writer.clone();
        let mic_mid = mic_mid.clone();
        tokio::spawn(async move {
            if transceiver.mid().map(|m| m.to_string()) != mic_mid {
                return;
            }
            while let Ok((mut packet, _)) = track.read_rtp().await {
                packet.header.extension = false;
                packet.header.extensions.clear();
                let _ = mic.write_rtp(&packet).await;
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

    // each sendonly transceiver, by the index of the section it took
    let mut lines: Vec<Option<Line>> = (0..offer.len()).map(|_| None).collect();
    for t in peer.get_transceivers().await {
        let Some(mid) = t.mid() else { continue };
        let Some(i) = offer.iter().position(|s| s.mid.as_deref() == Some(mid.as_str())) else { continue };
        if i == 0 || t.direction() != RTCRtpTransceiverDirection::Sendonly {
            continue;
        }
        let sender = t.sender().await;
        // the track is still the idle one here: nothing was rebound yet
        let Some(id) = sender.track().await.map(|t| t.id().to_owned()) else { continue };
        let Some(idle) = idles.iter().find(|idle| idle.id() == id) else { continue };
        lines[i] = Some(Line { sender, idle: idle.clone(), bound: None });
    }

    if send(socket, &serde_json::json!({ "sdp": answer })).await.is_ok() {
        // spawned, so the first seats frame does not wait on the api
        *attached = presence.map(|p| tokio::spawn(p.attached(seat)));
        let mut current = seats.borrow_and_update().clone();
        loop {
            rebind(tag, &mut lines, &current, seat).await;
            if send(socket, &seats_event(&current, seat)).await.is_err() {
                break;
            }
            tokio::select! {
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // nothing is said after the join yet
                    _ => continue,
                },
                _ = dead.notified() => {
                    // the page hears why, rather than a socket that just closes
                    let why = gone_word(linked.load(Ordering::SeqCst), voice.udp_port);
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
    let _ = peer.close().await;
}

/// point every m-line at the mic of whoever sits in its seat now, or at its idle track
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

fn seats_event(seats: &[Option<Sitter>], own: usize) -> serde_json::Value {
    let list: Vec<SeatInfo> = seats
        .iter()
        .enumerate()
        .filter(|&(seat, _)| seat != own)
        .filter_map(|(seat, s)| s.as_ref().map(|s| SeatInfo { seat, user: &s.user, line: line_of(seat, own) }))
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

/// the word for a page whose peer failed: `linked`, it had connected once
fn gone_word(linked: bool, udp_port: u16) -> String {
    if linked {
        "voice lost its connection".to_owned()
    } else {
        format!("no audio path: nothing reached the voice server over udp {udp_port}, a firewall is closing it")
    }
}

/// the stream's ice settings (main.rs new_peer) with the voice codecs. `linked` is set once
/// the peer connects, `dead` told when it fails or closes
async fn voice_peer(voice: &Voice, tag: &str, dead: Arc<Notify>, linked: Arc<AtomicBool>) -> anyhow::Result<RTCPeerConnection> {
    let (media, registry) = voice_media_setup()?;
    let mut setting = SettingEngine::default();
    setting.set_udp_network(UDPNetwork::Muxed(voice.mux.clone()));
    setting.set_network_types(vec![NetworkType::Udp4]);
    // exactly one host candidate, see new_peer
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
    // what ice did and which pair won, so a call that never links says how far it got
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
            linked.store(true, Ordering::SeqCst);
        }
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
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
        // seat 0: everyone else on the m-line of their number
        assert_eq!((1..16).map(|s| line_of(s, 0)).collect::<Vec<_>>(), (1..16).collect::<Vec<_>>());
        // seat 3: 0,1,2 on 1,2,3; 4.. on 4..
        assert_eq!(line_of(0, 3), 1);
        assert_eq!(line_of(2, 3), 3);
        assert_eq!(line_of(4, 3), 4);
        // the last seat's others still fit in 15 lines
        assert_eq!(line_of(14, 15), 15);
    }

    #[test]
    fn good_offers() {
        assert_eq!(check_offer(&voice_offer(15)).map(|s| s.len()), Some(16));
        assert_eq!(check_offer(&voice_offer(0)).map(|s| s.len()), Some(1));
        assert!(check_offer(&offer(&[("audio", "sendonly"), ("audio", "recvonly")])).is_some());
    }

    #[test]
    fn bad_offers() {
        // 17 m-lines
        assert!(check_offer(&voice_offer(16)).is_none());
        // any video, or a data channel
        assert!(check_offer(&offer(&[("audio", "sendrecv"), ("video", "recvonly")])).is_none());
        assert!(check_offer(&offer(&[("video", "sendrecv")])).is_none());
        assert!(check_offer(&offer(&[("audio", "sendrecv"), ("application", "sendrecv")])).is_none());
        // m-line 0 must send
        assert!(check_offer(&offer(&[("audio", "recvonly"), ("audio", "recvonly")])).is_none());
        assert!(check_offer(&offer(&[("audio", "inactive")])).is_none());
        // no m-lines, no mid, too big
        assert!(check_offer("v=0\r\n").is_none());
        assert!(check_offer("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n").is_none());
        let big = voice_offer(1) + &"a=x\r\n".repeat(MAX_SDP_BYTES / 5);
        assert!(check_offer(&big).is_none());
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
        // the room and name a page sends next to a grant count for nothing
        let both = frame(serde_json::json!({ "role": "voice", "grant": GRANT, "room": "a/b", "user": "c", "sdp": "x" }));
        assert_eq!(read_join(&both, true, true), Ok((Claim::Grant(GRANT.into()), "x".into())));
        // no secret to redeem it with
        assert_eq!(read_join(&granted, true, false), Err("voice is not open"));
        // not the shape join hands out: never sent to the api
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
        // only while dev-open: otherwise it needs a grant
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
