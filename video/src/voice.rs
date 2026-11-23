//! `video voice`: a small voice sfu, same binary. who may talk where is the api's word: a page
//! brings a grant from `POST /api/groups/:group/voice/:channel/join`, and we redeem it once with
//! the api (`POST /api/voice/redeem`, X-Voice-Secret) for the person and the room. the room and
//! the name come from that reply, never from the page.
//!
//! websocket on :7881/ws (VOICE_WS_PORT), media on one udp port, 7883 (VOICE_UDP_PORT).
//! `GET /health` on the same port says {ok, rooms, peers}. the first frame, within 10s:
//!   {"role":"voice","grant":"<64 hex>","sdp":"<offer>"}
//! the offer's audio: m-line 0 is your mic and must send, the other audio ones (15 at most)
//! are recvonly and are where you hear the others. it may have video m-lines too (see video,
//! below). we answer {"sdp":"<answer>"} or {"error":"..."}, then send
//!   {"event":"seats","seats":[{"seat":0,"user":"a","line":1,"mute":false,"deaf":false,"video":[]},...]}
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
//! video: a seat shows at most a camera and a screen, two tracks of its own (`camera<id>` and
//! `screen<id>`, stream `seat<id>`), VP8 only. the page is always the one that offers, so
//! there is no glare: after the answer it may send a new offer at any time,
//!   {"sdp":"<offer>","video":{"<mid>":"camera","<mid>":"screen"}}
//! (the join frame may carry `video` too), and gets {"sdp":"<answer>"} back. `video` names the
//! page's own sending video m-lines; a sending one it does not name is "bad offer", and the audio
//! m-lines must stay as they were. what sends is what shows: a camera line that goes inactive is
//! the camera off. the page's recvonly video m-lines are where it sees the others, at most 30:
//! each seat's `video` in the seats frame lists what it shows, `[{"kind":"camera","mid":"17"}]`,
//! the mid that carries it, or null while the page has no free video m-line for it (it adds
//! one and offers again). like the audio, a line only swaps tracks; a line given a new picture
//! asks its sender for a keyframe (a PLI), and a viewer's own PLI or FIR is passed on the same
//! way, at most one per KEYFRAME_GAP per track. the page also says
//!   {"state":{"mute":true,"deaf":false}}
//! for the others' tiles, the seats frame's `mute` and `deaf`. those are the page's own word:
//! they carry nothing about what is sent.
//!
//! closing the socket, or the peer going failed/closed (the ice timeout), frees the seat. a
//! peer that fails is said first, as an error frame: one that never connected is "no audio
//! path" (nothing came over udp: the port is shut somewhere between, 7883 not open in the
//! cloud firewall), one that did is "voice lost its connection".
//! at most 4 voice peers per address, and /ws is rate limited per address like the stream's.
//!
//! a moderator's word comes from the api, inside the compose network only: `POST /internal/voice`
//!   {"action":"mute"|"unmute"|"disconnect","user_id":"<uuid>","server":"<name>"}
//! with X-Voice-Secret, never through caddy (which sends `/voice` alone here, and always sets
//! X-Forwarded-For: such a request is a 404). mute stops carrying that person's mic to anyone
//! (their packets are dropped here, so they cannot lift it from the page), unmute carries it
//! again, disconnect ends their socket with {"error":"disconnected"}. a redeem says `muted` for
//! someone muted before they came. → {"seats": n}, how many seats it touched.
//!
//! who is in voice lives in the api (docs/voice.md), and we keep it current: `attached`
//! once a granted person has their answer, `left` when their seat frees, and every 15s one
//! `beat` naming everyone granted we have seated. a box that dies says nothing, and the api's
//! sweep drops its people within a minute. a call that fails is a warning in the log; nobody is
//! dropped for it. neither the secret nor a grant is ever logged.

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
/// sixteen audio and 32 video m-lines, VP8 alone on the video ones
const MAX_SDP_BYTES: usize = 128 * 1024;
const MAX_MEDIA_LINES: usize = 16;
/// a camera and a screen sending, and the others' 15 of each to see
const MAX_VIDEO_LINES: usize = 2 + 2 * (MAX_SEATS - 1);
/// keyframe requests to one track's sender, at most one per this
const KEYFRAME_GAP: Duration = Duration::from_millis(300);
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
    /// a moderator muted them before they came (the api's `voicemuted:<server>`)
    #[serde(default)]
    muted: bool,
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
    /// a moderator's mute: their mic's packets go nowhere while it is set
    muted: Arc<AtomicBool>,
    /// a moderator's disconnect: their socket ends when this is told
    kick: Arc<Notify>,
    /// their camera and screen, and what their page says of itself
    show: Show,
}

/// a camera or a screen
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

/// what a seat shows. the tracks and their keyframe bells are the seat's for its whole stay;
/// `on` says which of them its page is sending now
#[derive(Clone)]
struct Show {
    /// by `Kind as usize`: the camera's, then the screen's
    tracks: [Arc<TrackLocalStaticRTP>; 2],
    /// rung when a viewer needs a keyframe of that track: its sender gets a PLI
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

/// what a moderator asks of a seat (`POST /internal/voice`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Mute,
    Unmute,
    Disconnect,
}

#[derive(Deserialize)]
struct Order {
    action: Action,
    user_id: String,
    server: String,
}

impl Rooms {
    /// `action` on every seat `uid` holds in `server`'s rooms (a second tab is a second seat). → how many
    fn moderate(&self, uid: &str, server: &str, action: Action) -> usize {
        let mut n = 0;
        for (name, room) in &self.rooms {
            if name.split_once('/').is_none_or(|(s, _)| s != server) {
                continue;
            }
            for sitter in room.seats.0.iter().flatten().filter(|s| s.uid.as_deref() == Some(uid)) {
                match action {
                    Action::Mute => sitter.muted.store(true, Ordering::SeqCst),
                    Action::Unmute => sitter.muted.store(false, Ordering::SeqCst),
                    // a permit if the socket is not waiting yet: it ends at its next look
                    Action::Disconnect => sitter.kick.notify_one(),
                }
                n += 1;
            }
        }
        n
    }
}

/// whether two strings are the same, in a time that says nothing about where they differ (the
/// length aside): every byte is looked at, with no early way out
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// the gate on `/internal/voice`, the api's voice.rs `inside`: 404 for anything caddy passed (it
/// always sets X-Forwarded-For), 503 with no secret, 403 for a wrong or missing X-Voice-Secret
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

/// the `video` the join frame and every later offer may carry: the page's sending video m-lines
/// by mid, each `camera` or `screen`
fn read_labels(text: &str) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Labels {
        #[serde(default)]
        video: HashMap<String, String>,
    }
    serde_json::from_str::<Labels>(text).map(|l| l.video).unwrap_or_default()
}

/// which kind each sending video section is, from the page's labels: every one named, each
/// kind at most once. None is a bad offer.
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

/// what the page says after the join: a new offer, or its own mute and deafen
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

/// one picture a seat shows, and the mid that carries it to this page (None: no line free yet)
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
        // per address, per minute, the stream's counts (limits.rs)
        .route_layer(axum::middleware::from_fn_with_state(limits::Limits::default(), limits::layer))
        // the api's, inside only and behind the secret: not counted with the pages' requests
        .route("/internal/voice", post(moderate))
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

/// `POST /internal/voice {action, user_id, server}`: a moderator's word, from the api (the
/// module's head). → {"seats": n}; 400 for a body that does not read.
async fn moderate(State(voice): State<Voice>, headers: HeaderMap, body: Result<Json<Order>, axum::extract::rejection::JsonRejection>) -> Result<Json<serde_json::Value>, StatusCode> {
    inside(&headers, voice.api.secret.as_deref())?;
    let Json(order) = body.map_err(|_| StatusCode::BAD_REQUEST)?;
    let n = voice.state.lock().unwrap_or_else(|e| e.into_inner()).moderate(&order.user_id, &order.server, order.action);
    log::info!("voice: {:?} on {n} seat(s) in {}", order.action, order.server);
    Ok(Json(serde_json::json!({ "seats": n })))
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

/// a seat just taken: its number, the mic the others hear it by, the room's seats to follow, and
/// the moderator's two handles on it
struct Sat {
    seat: usize,
    mic: Arc<TrackLocalStaticRTP>,
    seats: watch::Receiver<Snapshot>,
    muted: Arc<AtomicBool>,
    kick: Arc<Notify>,
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
    fn sit(&self, held: &mut Held, name: &str, user: &str, uid: Option<&str>, muted: bool) -> Option<Sat> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let room = state.rooms.entry(name.to_owned()).or_insert_with(|| Room {
            seats: Seats::new(),
            tx: watch::Sender::new(Arc::new(Vec::new())),
        });
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic{id}"), "voice".to_owned()));
        let (muted, kick) = (Arc::new(AtomicBool::new(muted)), Arc::new(Notify::new()));
        let sitter = Sitter {
            user: user.to_owned(),
            uid: uid.map(str::to_owned),
            id,
            mic: mic.clone(),
            muted: muted.clone(),
            kick: kick.clone(),
            show: Show::new(id),
        };
        let Some(seat) = room.seats.take(sitter) else {
            if room.seats.taken() == 0 {
                state.rooms.remove(name);
            }
            return None;
        };
        held.seat = Some((name.to_owned(), seat));
        let snapshot = Arc::new(room.seats.snapshot());
        room.tx.send_replace(snapshot);
        Some(Sat { seat, mic, seats: room.tx.subscribe(), muted, kick })
    }

    /// `change` on what the sitter `id` in `seat` of `name` shows, told to the room when it
    /// changed anything. nothing when they are gone.
    fn show(&self, name: &str, seat: usize, id: u64, change: impl FnOnce(&mut Show)) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(room) = state.rooms.get_mut(name) else { return };
        let Some(Some(sitter)) = room.seats.0.get_mut(seat).filter(|s| s.as_ref().is_some_and(|s| s.id == id)) else { return };
        let was = (sitter.show.on, sitter.show.mute, sitter.show.deaf);
        change(&mut sitter.show);
        if was != (sitter.show.on, sitter.show.mute, sitter.show.deaf) {
            let snapshot = Arc::new(room.seats.snapshot());
            room.tx.send_replace(snapshot);
        }
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

/// what an m= section carries
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Media {
    Audio,
    Video,
    Other,
}

/// one m= section of an offer, as far as voice cares
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

/// the offer's sections if voice can take it: at most 128 KB, every section with a mid, the
/// first one a sending audio one, 1 to 16 audio and at most 32 video, two of those sending at
/// most, and nothing else (no data channel)
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

/// whether a later offer keeps the audio m-lines of the first, mid for mid
fn same_audio(first: &[Section], next: &[Section]) -> bool {
    let mids = |offer: &[Section]| offer.iter().filter(|s| s.kind == Media::Audio).map(|s| s.mid.clone()).collect::<Vec<_>>();
    mids(first) == mids(next) && next[0].sends
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
    let (room, user, presence, muted) = match claim {
        Claim::Open { room, user } => (room, user, None, false),
        Claim::Grant(grant) => match voice.api.redeem(&grant).await {
            Ok(who) => {
                let room = format!("{}/{}", who.server, who.channel);
                let presence = Presence { api: voice.api.clone(), user_id: who.user_id, server: who.server, channel: who.channel };
                (room, who.name, Some(Arc::new(presence)), who.muted)
            }
            Err(e) => return refuse(&mut socket, e).await,
        },
    };
    let uid = presence.as_ref().map(|p| p.user_id.as_str());
    let Some(mut sat) = voice.sit(&mut held, &room, &user, uid, muted) else {
        return refuse(&mut socket, "room full").await;
    };
    let tag = format!("voice {room} seat {}", sat.seat);
    log::info!("{tag}: {user} joined");
    let mut attached = None;
    let joined = Joined { room: &room, labels: read_labels(&text) };
    talk(&voice, &mut socket, &tag, sdp, &offer, &mut sat, presence.clone(), &mut attached, joined).await;
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

/// the room a join sat in, and the `video` of its frame
struct Joined<'a> {
    room: &'a str,
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
    joined: Joined<'_>,
) {
    let (seat, seats) = (sat.seat, &mut sat.seats);
    // who sits here: the id, and the tracks this page's camera and screen go out on
    let Some(me) = seats.borrow().get(seat).cloned().flatten() else {
        return refuse(socket, "server error").await;
    };
    let Some(kinds) = sending_kinds(offer, &joined.labels) else {
        return refuse(socket, "bad offer").await;
    };
    let dead = Arc::new(Notify::new());
    let linked = Arc::new(AtomicBool::new(false));
    let peer = match voice_peer(voice, tag, dead.clone(), linked.clone()).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("{tag}: peer setup: {e}");
            return refuse(socket, "server error").await;
        }
    };

    // added before the offer is applied, webrtc-rs pairs them with its sections in order:
    // the mic's sending section takes the recvonly one, each recvonly section a sendonly one
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

    // packets from the mic's section go to the mic track, which other peers' seats carry.
    // header extensions carry ids from this peer's session, so drop them
    // a moderator's mute drops them here, read packet by packet so it bites at once
    let mic_mid = offer[0].mid.clone();
    let writer = sat.mic.clone();
    let muted = sat.muted.clone();
    let shown = Shower { kinds: Arc::new(Mutex::new(kinds.clone())), show: me.show.clone(), peer: Arc::downgrade(&peer) };
    let showing = shown.clone();
    peer.on_track(Box::new(move |track, _, transceiver| {
        let mic = writer.clone();
        let mic_mid = mic_mid.clone();
        let muted = muted.clone();
        let showing = showing.clone();
        tokio::spawn(async move {
            if transceiver.mid().map(|m| m.to_string()) != mic_mid {
                return showing.forward(track, transceiver.mid().map(|m| m.to_string())).await;
            }
            while let Ok((mut packet, _)) = track.read_rtp().await {
                if muted.load(Ordering::SeqCst) {
                    continue;
                }
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
        if i == 0 || offer[i].kind != Media::Audio || t.direction() != RTCRtpTransceiverDirection::Sendonly {
            continue;
        }
        let sender = t.sender().await;
        // the track is still the idle one here: nothing was rebound yet
        let Some(id) = sender.track().await.map(|t| t.id().to_owned()) else { continue };
        let Some(idle) = idles.iter().find(|idle| idle.id() == id) else { continue };
        lines[i] = Some(Line { sender, idle: idle.clone(), bound: None });
    }
    video.collect(&peer, offer, &video_idles).await;
    voice.show(joined.room, seat, me.id, |s| s.on = on_of(&kinds));

    if send(socket, &serde_json::json!({ "sdp": answer })).await.is_ok() {
        // spawned, so the first seats frame does not wait on the api
        *attached = presence.map(|p| tokio::spawn(p.attached(seat)));
        let mut current = seats.borrow_and_update().clone();
        loop {
            rebind(tag, &mut lines, &current, seat).await;
            let mids = video.rebind(tag, &current, seat).await;
            if send(socket, &seats_event(&current, seat, &mids)).await.is_err() {
                break;
            }
            tokio::select! {
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(Message::Text(text))) => {
                        let Ok(said) = serde_json::from_str::<Said>(&text) else { continue };
                        if let Some(state) = said.state {
                            voice.show(joined.room, seat, me.id, |s| (s.mute, s.deaf) = (state.mute, state.deaf));
                        }
                        let Some(sdp) = said.sdp else { continue };
                        match renegotiate(tag, &peer, offer, &text, sdp, &shown, &mut video).await {
                            Ok((answer, kinds)) => {
                                voice.show(joined.room, seat, me.id, |s| s.on = on_of(&kinds));
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
                    _ => continue,
                },
                _ = sat.kick.notified() => {
                    log::info!("{tag}: disconnected by a moderator");
                    refuse(socket, "disconnected").await;
                    break;
                }
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

/// which of the camera and the screen a page sends, from its sending video mids
fn on_of(kinds: &HashMap<String, Kind>) -> [bool; 2] {
    Kind::ALL.map(|k| kinds.values().any(|&v| v == k))
}

/// a later offer from the page: checked against the first, its new video lines readied, and
/// answered. → the answer and the page's sending video mids; Err is the word for the page
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
    // before the offer is applied: a track that comes from it finds its kind
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

/// a page's camera and screen coming in, onto the seat's own tracks of those kinds
#[derive(Clone)]
struct Shower {
    /// the page's sending video mids, as its last offer named them
    kinds: Arc<Mutex<HashMap<String, Kind>>>,
    show: Show,
    peer: Weak<RTCPeerConnection>,
}

impl Shower {
    /// one incoming video track: its packets onto the seat's track of its kind (header
    /// extensions dropped, as the mic's), and a PLI back to the page each time a viewer rings
    /// that track's bell, at most one per KEYFRAME_GAP. until the track ends.
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
        while let Ok((mut packet, _)) = track.read_rtp().await {
            packet.header.extension = false;
            packet.header.extensions.clear();
            let _ = out.write_rtp(&packet).await;
        }
        asking.abort();
    }
}

/// one m-line that shows this page a camera or a screen
struct Screen {
    mid: String,
    sender: Arc<RTCRtpSender>,
    idle: Arc<TrackLocalStaticRTP>,
    /// the sitter and which of theirs it carries, None for idle
    bound: Option<(u64, Kind)>,
    /// the bell of what it carries, for this page's own keyframe requests
    key: Arc<Mutex<Option<Arc<Notify>>>>,
}

/// the m-lines a page sees the others' video on
#[derive(Default)]
struct Video {
    lines: Vec<Screen>,
    /// idle tracks made, for their names
    made: usize,
}

impl Video {
    /// before an offer is applied: a sendonly transceiver with an idle track for each recvonly
    /// video section there is no line for yet, which webrtc-rs pairs with it. → those tracks
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

    /// after the answer: the transceivers `idles` went to, as lines by their mid, each with a
    /// task that passes this page's PLIs and FIRs on to whatever the line carries
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

    /// every line onto a picture someone else shows now, or back to idle: a picture that stays
    /// keeps its line, one that went frees it, a new one takes the first free line and rings
    /// its bell (a keyframe, so the page has a picture at once). → the mid of each picture shown
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

/// a sendonly line with `idle` on it, its sequence numbers the sender's own. a line carries one
/// sitter's packets, then another's (replace_track), on one ssrc, and each comer's browser starts
/// its numbers anywhere: one that starts behind the last is a replay to the viewer's srtp, every
/// packet dropped until it catches up (minutes). the transformer goes on from the last number at
/// each replace_track, and must be on before the line sends anything
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

/// the seats frame for the page in `own`: everyone else, with what each shows and on which mid
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

    fn sitter(user: &str, uid: Option<&str>) -> Sitter {
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic-{user}"), "voice".to_owned()));
        Sitter { user: user.to_owned(), uid: uid.map(str::to_owned), id: 0, mic, muted: Arc::default(), kick: Arc::new(Notify::new()), show: Show::new(0) }
    }

    fn room_of(sitters: Vec<Sitter>) -> Room {
        let mut seats = Seats::new();
        for s in sitters {
            seats.take(s);
        }
        Room { seats, tx: watch::Sender::new(Arc::new(Vec::new())) }
    }

    #[test]
    fn a_mute_reaches_every_seat_of_theirs_in_that_server_and_no_other() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![sitter("al", Some("u1")), sitter("bo", Some("u2"))]));
        // a second tab of theirs in another of the server's channels
        rooms.rooms.insert("g/afk".into(), room_of(vec![sitter("al", Some("u1"))]));
        // the same account in another server: not this server's mute
        rooms.rooms.insert("h/lounge".into(), room_of(vec![sitter("al", Some("u1"))]));
        // a dev-open join has no account
        rooms.rooms.insert("g/dev".into(), room_of(vec![sitter("u1", None)]));
        let muted = |rooms: &Rooms, room: &str, seat: usize| rooms.rooms[room].seats.0[seat].as_ref().unwrap().muted.load(Ordering::SeqCst);

        assert_eq!(rooms.moderate("u1", "g", Action::Mute), 2);
        assert!(muted(&rooms, "g/lounge", 0) && muted(&rooms, "g/afk", 0));
        assert!(!muted(&rooms, "g/lounge", 1), "not bo");
        assert!(!muted(&rooms, "h/lounge", 0), "not another server");
        assert!(!muted(&rooms, "g/dev", 0), "not a name alone");
        assert_eq!(rooms.moderate("u1", "g", Action::Unmute), 2);
        assert!(!muted(&rooms, "g/lounge", 0));
        assert_eq!(rooms.moderate("nobody", "g", Action::Mute), 0);
    }

    #[tokio::test]
    async fn a_disconnect_is_heard_even_before_the_socket_waits_for_it() {
        let mut rooms = Rooms::default();
        rooms.rooms.insert("g/lounge".into(), room_of(vec![sitter("al", Some("u1"))]));
        let kick = rooms.rooms["g/lounge"].seats.0[0].as_ref().unwrap().kick.clone();
        assert_eq!(rooms.moderate("u1", "g", Action::Disconnect), 1);
        // told first, waited on after: the permit is kept
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
        // through caddy: as if there were no such route, secret or not
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
    fn video_offers() {
        // a camera and a screen sending, and the others' 30 to see: 48 m-lines in all
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("audio", "recvonly"), 15));
        lines.extend([("video", "sendonly"), ("video", "sendonly")]);
        lines.extend(std::iter::repeat_n(("video", "recvonly"), 30));
        let sections = check_offer(&offer(&lines)).expect("a full video offer");
        assert_eq!(sections.iter().filter(|s| s.kind == Media::Video).count(), 32);
        // a camera off is an inactive line, which counts for nothing
        assert!(check_offer(&offer(&[("audio", "sendrecv"), ("video", "inactive"), ("video", "sendonly"), ("video", "sendonly")])).is_some());
    }

    #[test]
    fn what_a_page_sends_is_named() {
        let sections = check_offer(&offer(&[("audio", "sendrecv"), ("video", "sendonly"), ("video", "sendonly"), ("video", "recvonly")])).unwrap();
        let labels = |v: serde_json::Value| read_labels(&serde_json::json!({ "sdp": "x", "video": v }).to_string());
        let kinds = sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera", "2": "screen", "3": "camera" }))).unwrap();
        assert_eq!(kinds, HashMap::from([("1".to_owned(), Kind::Camera), ("2".to_owned(), Kind::Screen)]));
        assert_eq!(on_of(&kinds), [true, true]);
        // a sending line not named, a word that is no kind, one kind twice
        assert!(sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera" }))).is_none());
        assert!(sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera", "2": "face" }))).is_none());
        assert!(sending_kinds(&sections, &labels(serde_json::json!({ "1": "camera", "2": "camera" }))).is_none());
        // nothing sending, nothing named: the audio-only page
        let audio = check_offer(&voice_offer(15)).unwrap();
        assert_eq!(sending_kinds(&audio, &read_labels(r#"{"role":"voice","sdp":"x"}"#)), Some(HashMap::new()));
        assert_eq!(on_of(&HashMap::new()), [false, false]);
    }

    #[test]
    fn a_later_offer_keeps_the_audio() {
        let first = check_offer(&voice_offer(3)).unwrap();
        let mut lines = vec![("audio", "sendrecv"), ("audio", "recvonly"), ("audio", "recvonly"), ("audio", "recvonly"), ("video", "sendonly")];
        assert!(same_audio(&first, &check_offer(&offer(&lines)).unwrap()));
        // an audio line more, or one fewer
        lines.push(("audio", "recvonly"));
        assert!(!same_audio(&first, &check_offer(&offer(&lines)).unwrap()));
        assert!(!same_audio(&first, &check_offer(&voice_offer(2)).unwrap()));
    }

    fn seated(user: &str, id: u64, on: [bool; 2]) -> Sitter {
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic{id}"), "voice".to_owned()));
        let mut show = Show::new(id);
        show.on = on;
        Sitter { user: user.to_owned(), uid: None, id, mic, muted: Arc::default(), kick: Arc::new(Notify::new()), show }
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
        // 17 audio m-lines
        assert!(check_offer(&voice_offer(16)).is_none());
        // video first, or a data channel
        assert!(check_offer(&offer(&[("video", "sendrecv")])).is_none());
        assert!(check_offer(&offer(&[("video", "sendonly"), ("audio", "sendrecv")])).is_none());
        assert!(check_offer(&offer(&[("audio", "sendrecv"), ("application", "sendrecv")])).is_none());
        // three sending video lines, or 33 video lines
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("video", "sendonly"), 3));
        assert!(check_offer(&offer(&lines)).is_none());
        let mut lines = vec![("audio", "sendrecv")];
        lines.extend(std::iter::repeat_n(("video", "recvonly"), 33));
        assert!(check_offer(&offer(&lines)).is_none());
        // m-line 0 must send
        assert!(check_offer(&offer(&[("audio", "recvonly"), ("audio", "recvonly")])).is_none());
        assert!(check_offer(&offer(&[("audio", "inactive")])).is_none());
        // no m-lines, no mid, too big
        assert!(check_offer("v=0\r\n").is_none());
        assert!(check_offer("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n").is_none());
        let big = voice_offer(1) + &"a=x\r\n".repeat(MAX_SDP_BYTES / 5);
        assert!(check_offer(&big).is_none());
    }

    /// a browser's real offer before BUNDLE is agreed: every m-line carries its own candidates.
    /// a phone with many networks (wifi, cellular, vpns, v4 and v6, udp and tcp) goes past
    /// MAX_SDP_BYTES in a full call (16 audio and 32 video m-lines; an iPhone's audio-only join
    /// frame measured 72 KB); the page sends m-line 0's udp candidates only
    /// (frontend/src/infra/voice-offer.ts), which fits
    fn browser_offer(candidates: impl Fn(usize) -> usize) -> String {
        // a webkit m-line's own lines come to ~1.1 KB: codecs, extensions, fingerprint, ice
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
