//! One person in. Copies the packets out to whoever is watching.
//!
//! Websocket on :7880/ws. The browser sends one text frame:
//!   {"role":"publish","name":"billy","sdp":"<offer sdp>","session":1,"token":2}
//!   {"role":"watch",  "name":"billy","sdp":"<offer sdp>"}
//! We answer {"sdp":"<answer sdp>"} or {"error":"..."} and keep the socket
//! open. Closing it hangs up. Watchers also get {"event":"ended"} when the
//! publisher leaves. All media rides one UDP port (7882).
//!
//! A publisher's offer can carry several video sections: the camera and some
//! screens. Every audio/video section it sends on is a slot of the room, made
//! when the room is claimed, so a watcher binds to all of them at once and a
//! section that only starts sending later (a screen shared mid-stream) reaches
//! them without anyone renegotiating; its packets are routed to the slot by mid.
//! The publisher says what is live where with later frames on its socket,
//!   {"slots":[{"slot":0,"kind":"camera"},{"slot":1,"kind":"screen","label":"screen"}],
//!    "layout":{"camera":"over","x":0.73,"y":0.73,"w":0.25}}
//! (`slot` counts its video sections from 0; `layout`, optional, is where the camera
//! sits while a screen is shared, see `Layout`), and watchers get each change as
//!   {"event":"slots","slots":[...],"layout":{...}}
//! right after their answer and whenever it changes. Until the publisher says,
//! the first video slot is the camera and there is no layout.
//!
//! A publisher's session and token are what the api's go-live handed out; we
//! ask the api (its heartbeat route) whether that session is open for that
//! name, so a stranger who skips the api cannot publish under a claimed name.
//! Once the room is claimed and answered we tell the api so (its `attached`
//! route, same grant): that is when it pushes `live` to the watchers waiting on
//! the name, so the first one to connect on the push is served. When the
//! publisher leaves we call its `stop`.
//!
//! Watchers and the publisher also get {"event":"viewers","viewers":3}: how many
//! different addresses are receiving the stream right now, sent at most once a second
//! and only when it moved. A watcher counts once its ICE and DTLS are done, by the
//! address its media really goes to (the selected candidate pair), so a view is a
//! peer taking real packets, not a request. One address holds at most
//! MAX_WATCHERS_PER_IP_ROOM peers in a room and MAX_WATCHERS_PER_IP in all; past
//! that it gets {"error":"too many watchers from your address"}. docs/viewers.md.
//! A watch frame may carry "preview":true (home's muted camera previews): a preview
//! gets the same answer and events but is not counted as a viewer and spends none of
//! those caps; one address holds at most MAX_PREVIEWS_PER_IP previews in all, past
//! that it gets {"error":"too many previews from your address"}.
//!
//! Also on the same port: GET /live (names connected right now), GET /viewers
//! ({name: viewers} for every live room) and GET /health
//! ({ok, up_secs, build, live, viewers}; the api folds it into /api/health).
//! Env: PUBLIC_IP, WS_PORT (7880), UDP_PORT (7882), API_URL (http://api:4000),
//! DUMMY_PASSWORD, DUMMY_PREFIX, BUILD.
//!
//! Names starting with DUMMY_PREFIX ("dummy-") are reserved for the fake streams
//! of `video dummy` (see dummy.rs): publishing one needs the matching password too.

mod dummy;
mod media;
mod thumbs;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::sync::{watch, Mutex, Notify};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::udp_mux::{UDPMuxDefault, UDPMuxParams};
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::media::{media_setup, opus_capability, vp8_capability};

/// Forwarded keyframe requests are rate limited to one per this gap, per slot.
const KEYFRAME_GAP: Duration = Duration::from_millis(1500);
/// Even a forced request (a joining watcher, the thumbnail) waits this long after
/// the last one: a burst of joins then shares one keyframe instead of one each.
const FORCED_KEYFRAME_GAP: Duration = Duration::from_millis(300);
/// The browser has this long to send its one message, and we have this long to answer.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The api gets this long to say whether a publisher's session is real.
const API_TIMEOUT: Duration = Duration::from_millis(1500);
/// After SIGTERM, how long the open sockets get to send their `ended` before we exit.
const SHUTDOWN_FLUSH: Duration = Duration::from_secs(2);
/// Biggest offer we accept. A real one is 5-20 KB (chrome: about 4.5 KB per video section).
const MAX_SDP_BYTES: usize = 48 * 1024;
/// Audio, the camera, three screens, and one to spare. Each costs a transceiver per peer.
const MAX_MEDIA_LINES: usize = 6;
/// A slots frame: how long its `kind` and `label` strings may be.
const MAX_KIND_BYTES: usize = 16;
const MAX_LABEL_BYTES: usize = 64;
const UDP_BUFFER_BYTES: usize = 4 << 20;
/// Watcher peers one address may hold in one room, and across every room. Tabs and
/// households share an address; past this it is someone pulling copies on purpose,
/// and every copy is ~2.5 Mbps of our egress.
const MAX_WATCHERS_PER_IP_ROOM: usize = 4;
const MAX_WATCHERS_PER_IP: usize = 16;
/// Preview peers (home's muted cameras, `preview: true`) one address may hold across
/// every room. Kept apart from the watcher caps so a few home tabs behind one address
/// never lock it out of watching; this bounds their egress on their own.
const MAX_PREVIEWS_PER_IP: usize = 12;
/// How often a socket is told the count, at most. Only sent when it moved.
const VIEWERS_TICK: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Publish,
    Watch,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Publish => "publish",
            Role::Watch => "watch",
        }
    }
}

#[derive(Clone)]
struct App {
    hub: Hub,
    public_ip: String,
    mux: Arc<UDPMuxDefault>,
    shutdown: watch::Receiver<bool>,
    dummy_prefix: String,
    dummy_password: Option<String>,
    /// Where the api is, to check a publisher's session and token.
    api_url: String,
    http: reqwest::Client,
    /// ffmpeg is here and THUMBS is not off: make a picture of every stream.
    thumbs: bool,
    /// For /health: how long this process has run, and the commit it was built from.
    started: Instant,
    build: String,
}

#[derive(Clone, Default)]
struct Hub {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    /// Ids for watcher and preview peers, to take them out again.
    next_viewer: Arc<AtomicU64>,
}

struct Room {
    /// Bumps every time a publisher starts or stops. Watchers leave when it changes.
    generation: u64,
    generation_tx: watch::Sender<u64>,
    /// One per audio/video section the publisher's offer sends on, in offer order.
    /// All made at claim, so watchers bind to every one before any packet has come.
    slots: Vec<Slot>,
    /// What the publisher says is live in which video slot, and its layout. Watchers get every change.
    slots_tx: watch::Sender<Showing>,
    publisher: Option<Weak<RTCPeerConnection>>,
    /// Connected watcher peers and the address each one's media goes to.
    viewers: HashMap<u64, IpAddr>,
    /// Connected preview peers (`preview: true`) and their addresses. Not in `viewers`:
    /// never counted, and capped on their own (MAX_PREVIEWS_PER_IP).
    previews: HashMap<u64, IpAddr>,
    /// How many different addresses are in `viewers`: the number people see.
    viewers_tx: watch::Sender<usize>,
}

/// One m= section of the publisher's offer and the track its packets are copied into.
struct Slot {
    mid: String,
    kind: RTPCodecType,
    track: Arc<TrackLocalStaticRTP>,
    /// The publisher's ssrc for it, known once its first packet came. Keyframe requests go there.
    ssrc: Option<u32>,
    last_keyframe: Option<Instant>,
}

/// What a publisher says is live in one of its video slots, for the watchers' layout.
/// `slot` counts the video sections of its offer from 0: the camera, then the screens.
#[derive(Clone, Serialize, Deserialize)]
struct SlotInfo {
    slot: usize,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

/// Where the publisher put the camera while a screen is shared, for the watchers' player
/// (docs/screen.md): over the screen (`over`), a box `w` of the frame wide with its corner at
/// `x`,`y` of the frame, or beside it as a tile (`beside`). Passed on as it came, once checked.
#[derive(Clone, Serialize, Deserialize)]
struct Layout {
    camera: String,
    x: f64,
    y: f64,
    w: f64,
}

impl Layout {
    /// A known word and fractions of the frame. Json has no NaN or infinity, and a range check keeps out the rest.
    fn well_formed(&self) -> bool {
        matches!(self.camera.as_str(), "over" | "beside") && [self.x, self.y, self.w].iter().all(|v| (0.0..=1.0).contains(v))
    }
}

/// A publisher's later frame: the video slots live right now (absent means not live), and
/// where the camera sits while a screen is shared (absent: the watcher's own rule).
#[derive(Deserialize)]
struct SlotsFrame {
    slots: Vec<SlotInfo>,
    #[serde(default)]
    layout: Option<Layout>,
}

/// What the publisher says it shows: the live video slots, and its layout if it sent one.
/// Watchers get the two together, in every `slots` event.
#[derive(Clone, Default)]
struct Showing {
    slots: Vec<SlotInfo>,
    layout: Option<Layout>,
}

#[derive(Deserialize)]
struct In {
    role: String,
    name: String,
    sdp: String,
    /// A publisher's go-live grant from the api. Watchers send neither.
    #[serde(default)]
    session: Option<i64>,
    #[serde(default)]
    token: Option<i64>,
    /// Also needed to publish a reserved (dummy) name.
    #[serde(default)]
    password: Option<String>,
    /// A watcher that is one of home's muted camera previews: held apart from the
    /// viewers, their count and their caps.
    #[serde(default)]
    preview: Option<bool>,
}

#[derive(Serialize, Default)]
struct Out {
    #[serde(skip_serializing_if = "Option::is_none")]
    sdp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    slots: Option<Vec<SlotInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    layout: Option<Layout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewers: Option<usize>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,video=info,webrtc_ice=error"),
    )
    .init();

    // `video dummy` is the fake-stream publisher, same binary, see dummy.rs
    if std::env::args().nth(1).as_deref() == Some("dummy") {
        return dummy::run().await;
    }

    let public_ip = std::env::var("PUBLIC_IP").unwrap_or_else(|_| "127.0.0.1".into());
    let ws_port = env_port("WS_PORT", 7880);
    let udp_port = env_port("UDP_PORT", 7882);

    // Anything but an ipv4 address makes every negotiation fail later with a
    // vague "could not negotiate" while /health still says ok. Refuse now.
    if public_ip.parse::<Ipv4Addr>().is_err() {
        anyhow::bail!("PUBLIC_IP={public_ip:?} is not an ipv4 address");
    }
    let mux = UDPMuxDefault::new(UDPMuxParams::new(media_socket(udp_port)?));
    log::info!("media on udp {udp_port}, advertising {public_ip}");
    if public_ip == "127.0.0.1" {
        log::warn!("PUBLIC_IP is 127.0.0.1. set it to the ip people type in the browser");
    }

    let api_url = std::env::var("API_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "http://api:4000".into())
        .trim_end_matches('/')
        .to_owned();
    log::info!("publishers' sessions are checked with the api at {api_url}");

    let dummy_prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let dummy_password = std::env::var("DUMMY_PASSWORD").ok().filter(|p| !p.trim().is_empty());
    match &dummy_password {
        Some(_) => log::info!("names starting with {dummy_prefix:?} need the dummy password"),
        None => log::info!("names starting with {dummy_prefix:?} are reserved (no DUMMY_PASSWORD set)"),
    }

    let thumbs = thumbs::enabled() && thumbs::ffmpeg_present().await;
    thumbs::sweep_stale().await;
    match (thumbs, thumbs::enabled()) {
        (true, _) => log::info!("thumbnails every {}s at /thumb/<name>.jpg", thumbs::every_secs()),
        (false, true) => log::warn!("no ffmpeg in this image, so no thumbnails"),
        (false, false) => log::info!("thumbnails off (THUMBS=0)"),
    }

    let (shutdown_tx, shutdown) = watch::channel(false);
    let app = App {
        hub: Hub::default(),
        public_ip,
        mux,
        shutdown,
        dummy_prefix,
        dummy_password,
        api_url,
        http: reqwest::Client::builder().timeout(API_TIMEOUT).build()?,
        thumbs,
        started: Instant::now(),
        // empty counts as unset, like the api: `BUILD=` in a shell is "dev", not ""
        build: std::env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into()),
    };

    let router = Router::new()
        .route("/health", get(health))
        .route("/live", get(live))
        .route("/viewers", get(viewers))
        .route("/thumb/{file}", get(thumb))
        .route("/ws", get(ws))
        .with_state(app.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], ws_port));
    log::info!("websocket on {addr}/ws");
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // On SIGTERM every room ends, every socket closes, and we exit right away
    // instead of being killed 10s later with viewers mid-frame.
    let hub = app.hub.clone();
    let stop = shutdown_tx.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            wait_for_signal().await;
            log::info!("shutting down");
            hub.end_all().await;
            let _ = stop.send(true);
        })
        .await?;
    // axum stops tracking a connection once it is upgraded to a websocket, so
    // serve returns while the publish/watch tasks are still sending `ended`.
    // Each of them holds a receiver of the shutdown channel; wait until the
    // last one is dropped, but never longer than this.
    drop(app);
    let _ = tokio::time::timeout(SHUTDOWN_FLUSH, shutdown_tx.closed()).await;
    Ok(())
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
    let mut int = signal(SignalKind::interrupt()).expect("sigint handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

/// The one UDP socket every peer shares, with big buffers so a keyframe burst
/// to many watchers does not drop packets. Asking is not getting: linux caps a
/// plain SO_SNDBUF/SO_RCVBUF at net.core.wmem_max/rmem_max (208 KB by default)
/// without an error, so read back what the kernel gave and say so once.
fn media_socket(port: u16) -> anyhow::Result<tokio::net::UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    let _ = socket.set_send_buffer_size(UDP_BUFFER_BYTES);
    let _ = socket.set_recv_buffer_size(UDP_BUFFER_BYTES);
    // linux reports double the size it granted; a value under what we asked
    // for means it was capped
    let send = socket.send_buffer_size().unwrap_or(0);
    let recv = socket.recv_buffer_size().unwrap_or(0);
    if send < UDP_BUFFER_BYTES || recv < UDP_BUFFER_BYTES {
        log::warn!(
            "udp buffers: send {} KB, recv {} KB. asked for {} MB; the kernel capped it (raise net.core.wmem_max and net.core.rmem_max on the host)",
            send / 1024,
            recv / 1024,
            UDP_BUFFER_BYTES >> 20
        );
    } else {
        log::info!("udp buffers: send {} KB, recv {} KB", send / 1024, recv / 1024);
    }
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from(([0, 0, 0, 0], port)).into())?;
    Ok(tokio::net::UdpSocket::from_std(socket.into())?)
}

fn env_port(key: &str, default: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

async fn live(State(app): State<App>) -> Json<Vec<String>> {
    Json(app.hub.live_names().await)
}

/// `up_secs` going backwards between two looks means this process restarted.
async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "up_secs": app.started.elapsed().as_secs(),
        "build": app.build,
        "live": app.hub.live_names().await.len(),
        "viewers": app.hub.viewer_counts().await.values().sum::<usize>(),
    }))
}

/// `{name: viewers}` for every live room: the names are /live's, the numbers what the
/// rooms' sockets are told.
async fn viewers(State(app): State<App>) -> Json<HashMap<String, usize>> {
    Json(app.hub.viewer_counts().await)
}

/// `GET /thumb/<name>.jpg`: the latest picture of a live stream, a few seconds old.
async fn thumb(State(app): State<App>, axum::extract::Path(file): axum::extract::Path<String>) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    let Some(name) = file.strip_suffix(".jpg").map(str::to_lowercase) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !valid_name(&name) || !app.hub.live_names().await.contains(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // a picture ffmpeg has not replaced in a while is not a picture of the stream now:
    // the video stopped coming while the connection held, or ffmpeg is gone. 404, like none
    if thumbs::picture_age(&name).await.is_none_or(|age| age > thumbs::stale_after()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(thumbs::jpeg_path(&name)).await {
        Ok(bytes) if bytes.len() > 4 => (
            [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3")],
            bytes,
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn ws(State(app): State<App>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let forwarded = forwarded_ip(&headers);
    upgrade
        .max_message_size(2 * MAX_SDP_BYTES)
        .max_frame_size(2 * MAX_SDP_BYTES)
        .on_upgrade(move |socket| handle(app, socket, forwarded))
}

/// The browser's address as caddy saw it. 7880 is only reachable inside the compose
/// network, and caddy replaces whatever X-Forwarded-For a browser sent with the real
/// one, so the last entry is caddy's word. The fallback when ICE does not say.
fn forwarded_ip(headers: &HeaderMap) -> Option<IpAddr> {
    let value = headers.get("x-forwarded-for")?.to_str().ok()?;
    value.rsplit(',').next()?.trim().parse().ok()
}

async fn handle(app: App, mut socket: WebSocket, forwarded: Option<IpAddr>) {
    let text = match tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        _ => return,
    };

    let incoming: In = match serde_json::from_str(&text) {
        Ok(msg) => msg,
        Err(_) => {
            let _ = send(&mut socket, Out::error("bad json")).await;
            return;
        }
    };

    let name = incoming.name.trim().to_lowercase();
    if !valid_name(&name) {
        let _ = send(&mut socket, Out::error("bad name. use a-z 0-9 _ - (1 to 32)")).await;
        return;
    }
    if incoming.role == "publish" && name.starts_with(&app.dummy_prefix) {
        let allowed = matches!((&app.dummy_password, &incoming.password), (Some(p), Some(q)) if p == q);
        if !allowed {
            let _ = send(&mut socket, Out::error("reserved name")).await;
            return;
        }
    }

    // Check the offer before touching any room or building a peer. Every m=
    // section costs a transceiver and an interceptor chain, recvonly or not.
    if incoming.sdp.len() > MAX_SDP_BYTES
        || incoming.sdp.lines().filter(|l| l.starts_with("m=")).count() > MAX_MEDIA_LINES
        || RTCSessionDescription::offer(incoming.sdp.clone()).is_err()
    {
        let _ = send(&mut socket, Out::error("bad offer")).await;
        return;
    }

    match incoming.role.as_str() {
        "publish" => {
            // The sections it sends on are the room's slots. Nothing to send, or a
            // section without a mid (nothing could route its packets), is no publish.
            let Some(slots) = offer_slots(&incoming.sdp).filter(|slots| !slots.is_empty()) else {
                let _ = send(&mut socket, Out::error("bad offer")).await;
                return;
            };
            // Last, because it costs a round trip to the api.
            if let Err(e) = owns_stream(&app, &name, incoming.session, incoming.token).await {
                let _ = send(&mut socket, Out::error(e)).await;
                return;
            }
            publish(app, socket, name, incoming.sdp, slots, (incoming.session, incoming.token)).await
        }
        "watch" => {
            let wants = offered_receivers(&incoming.sdp);
            if wants == (0, 0) {
                let _ = send(&mut socket, Out::error("bad offer")).await;
                return;
            }
            watch_stream(app, socket, name, incoming.sdp, wants, incoming.preview.unwrap_or(false), forwarded).await
        }
        _ => {
            let _ = send(&mut socket, Out::error("role must be publish or watch")).await;
        }
    }
}

/// Is this the session the api's go-live handed out for that name, still open?
/// The api's heartbeat route answers exactly that (200 / 403) and refreshes the
/// live key on the way, which does no harm. Err carries the reply for the browser.
async fn owns_stream(app: &App, name: &str, session: Option<i64>, token: Option<i64>) -> Result<(), &'static str> {
    let (Some(session), Some(token)) = (session, token) else {
        return Err("not your stream");
    };
    let url = format!("{}/api/streams/{name}/heartbeat?session={session}&token={token}", app.api_url);
    match app.http.post(url).send().await {
        Ok(res) if res.status().is_success() => Ok(()),
        Ok(res) if res.status().is_client_error() => Err("not your stream"),
        Ok(res) => {
            log::warn!("publish {name}: api answered {} to the session check", res.status());
            Err("api unreachable")
        }
        Err(e) => {
            log::warn!("publish {name}: api unreachable for the session check: {e}");
            Err("api unreachable")
        }
    }
}

/// `grant` is the go-live session and token the publish frame carried (checked by `owns_stream`):
/// when the publisher leaves, the api's own `stop` is called with them, so a crashed tab stops
/// being `streaming` within seconds instead of the sweeper's minutes. See docs/status.md.
async fn publish(app: App, mut socket: WebSocket, name: String, sdp: String, slots: Vec<(String, RTPCodecType)>, grant: (Option<i64>, Option<i64>)) {
    let count = slots.len();
    let Some(generation) = app.hub.claim(&name, slots).await else {
        let _ = send(&mut socket, Out::error("someone is already live")).await;
        return;
    };
    log::info!("publish {name}: start, {count} slot(s)");

    let dead = Arc::new(Notify::new());
    let peer = match new_peer(&app, Role::Publish, &name, dead.clone(), Arc::new(Notify::new())).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("publish {name}: peer setup: {e}");
            let _ = send(&mut socket, Out::error("server error")).await;
            app.hub.clear(&name).await;
            return;
        }
    };
    app.hub.set_publisher(&name, Arc::downgrade(&peer)).await;

    let hub = app.hub.clone();
    let room = name.clone();
    let thumbs_on = app.thumbs;
    peer.on_track(Box::new(move |track, _, transceiver| {
        let hub = hub.clone();
        let room = room.clone();
        tokio::spawn(async move {
            let kind = track.kind();
            let codec = track.codec();
            // The slot is the m= section these packets belong to. Its outgoing track
            // has existed since the room was claimed, so watchers who joined before
            // this first packet (a screen shared mid-stream) are bound to it already.
            let mid = transceiver.mid().map(|m| m.to_string()).unwrap_or_default();
            let Some((local, slot, camera)) = hub.bind(&room, generation, &mid, track.ssrc()).await else {
                log::info!("publish {room}: {kind} packets on mid {mid:?} with no slot for them");
                return;
            };
            log::info!("publish {room}: slot {slot} up ({kind}, mid {mid}, {})", codec.capability.mime_type);

            // The camera slot, the first video one, also feeds a small ffmpeg that
            // makes the thumbnail. The other video slots, the screens, share
            // neither the picture nor its keyframe requests.
            let mut tap = None;
            if thumbs_on && camera {
                match thumbs::ThumbTap::start(&room, codec.payload_type).await {
                    Ok(started) => tap = Some(started),
                    Err(e) => log::warn!("publish {room}: no thumbnail: {e}"),
                }
            }
            if let Some(tap) = &tap {
                // ffmpeg can only start on a keyframe, and only a keyframe gets it going
                // again after a lost frame (its vp8 depacketizer drops every frame until
                // one); a browser sends one only when asked. So ask, every 2s, whenever
                // the picture is missing or past due, for as long as ffmpeg lives: at the
                // start, and after a loss nobody else noticed. (The sfu gets a lost packet
                // back by nack and forwards a whole stream, so no watcher asks; ffmpeg,
                // fed in arrival order, saw a gap.) Quiet while the pictures come.
                let hub = hub.clone();
                let room = room.clone();
                let ffmpeg_gone = tap.dead_flag();
                tokio::spawn(async move {
                    let mut wait = Duration::from_millis(400);
                    let mut due_since: Option<Instant> = None;
                    let mut told = false;
                    loop {
                        tokio::time::sleep(wait).await;
                        wait = Duration::from_millis(2000);
                        if ffmpeg_gone.load(Ordering::Relaxed) {
                            break;
                        }
                        let due = thumbs::picture_age(&room).await.is_none_or(|age| age > thumbs::due_after());
                        if !due {
                            due_since = None;
                            if told {
                                log::info!("thumb {room}: pictures again");
                                told = false;
                            }
                            continue;
                        }
                        // keyframes asked for and no picture for as long as /thumb has been
                        // saying 404: ffmpeg is wedged or the video stopped. Said once (its
                        // own log is at `error` only), and the asking slows down: every 2s
                        // of keyframes for the rest of a stream would cost every watcher
                        let stuck = due_since.get_or_insert_with(Instant::now).elapsed() > thumbs::stale_after();
                        if stuck && !told {
                            log::warn!("thumb {room}: no new picture for {}s with keyframes asked for. ffmpeg stuck, or the video stopped", thumbs::stale_after().as_secs());
                            told = true;
                        }
                        if stuck {
                            wait = Duration::from_secs(10);
                        }
                        hub.request_keyframe(&room, slot, true).await;
                    }
                });
            }

            // Copy packets to every watcher bound to this track. A failing
            // watcher must not stop the stream for the others. Header
            // extensions carry ids from the publisher's session, so drop them.
            while let Ok((mut packet, _)) = track.read_rtp().await {
                packet.header.extension = false;
                packet.header.extensions.clear();
                if let Some(tap) = &mut tap {
                    tap.feed(&packet);
                }
                let _ = local.write_rtp(&packet).await;
            }
            drop(tap);
            log::info!("publish {room}: slot {slot} done ({kind})");
        });
        Box::pin(async {})
    }));

    let answer = match negotiate(&peer, sdp).await {
        Ok(answer) => answer,
        Err(e) => {
            log::warn!("publish {name}: negotiate: {e}");
            let _ = send(&mut socket, Out::error("could not negotiate")).await;
            let _ = peer.close().await;
            app.hub.clear(&name).await;
            return;
        }
    };

    if send(&mut socket, Out::sdp(answer)).await.is_ok() {
        // the room is claimed and answered: a watcher who comes now is served. tell the api,
        // which pushes `live` to whoever waits on the name. off the loop: the stream must not wait on it
        tokio::spawn(tell_attached(app.clone(), name.clone(), grant));
        let mut shutdown = app.shutdown.clone();
        let viewers = app.hub.viewers_rx(&name).await;
        let mut told = None;
        let mut tick = tokio::time::interval(VIEWERS_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // The socket stays open for the stream. The publisher's later frames say
        // what is live in which slot; anything else on it is ignored.
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    if tell_viewers(&mut socket, viewers.as_ref(), &mut told).await.is_err() {
                        log::info!("publish {name}: socket closed");
                        break;
                    }
                }
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(e) = app.hub.set_slots(&name, generation, &text).await {
                            log::info!("publish {name}: a frame was ignored: {e}");
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        log::info!("publish {name}: socket closed");
                        break;
                    }
                    _ => {}
                },
                _ = dead.notified() => {
                    log::info!("publish {name}: peer gone");
                    break;
                }
                _ = async { let _ = shutdown.wait_for(|s| *s).await; } => {
                    let _ = send(&mut socket, Out::event("ended")).await;
                    break;
                }
            }
        }
    }

    let _ = peer.close().await;
    app.hub.clear(&name).await;
    end_session(&app, &name, grant).await;
    log::info!("publish {name}: ended");
}

/// The publisher is here: tell the api with the grant it gave, through its `attached` route,
/// and the api publishes `live` for the name's watchers now, not at go-live (a watcher told
/// then would have been answered "not live" by us). A few tries a second apart, since nothing
/// else says it: past them the gateway's own 30s recheck reads the key and tells the watchers.
/// A 4xx is the api's word (the session is not open any more) and is not retried.
async fn tell_attached(app: App, name: String, grant: (Option<i64>, Option<i64>)) {
    let (Some(session), Some(token)) = grant else { return };
    let url = format!("{}/api/streams/{name}/attached?session={session}&token={token}", app.api_url);
    for attempt in 1..=3 {
        match app.http.post(&url).send().await {
            Ok(res) if res.status().is_success() => {
                log::info!("publish {name}: told the api the publisher is here");
                return;
            }
            Ok(res) if res.status().is_client_error() => {
                log::warn!("publish {name}: api answered {} to attached", res.status());
                return;
            }
            Ok(res) => log::warn!("publish {name}: api answered {} to attached (try {attempt})", res.status()),
            Err(e) => log::warn!("publish {name}: api unreachable for attached (try {attempt}): {e}"),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// The publisher is gone: tell the api with the grant it gave, through its own `stop` route,
/// so the row ends, the key goes and the watchers are told now. Awaited, not spawned: the
/// socket and peer are already closed, nothing waits on this task, and on SIGTERM an awaited
/// call finishes inside the flush while a detached one would race the exit and lose. A page
/// that sent its own stop first gets this one a 403, which is the expected outcome, not an
/// error; the sweeper stays the backstop when the api does not answer.
async fn end_session(app: &App, name: &str, grant: (Option<i64>, Option<i64>)) {
    let (Some(session), Some(token)) = grant else { return };
    let url = format!("{}/api/streams/{name}/stop?session={session}&token={token}", app.api_url);
    match app.http.post(url).send().await {
        Ok(res) if res.status().is_success() => log::info!("publish {name}: told the api to stop session {session}"),
        Ok(res) if res.status().is_client_error() => {} // already stopped by the page, or not theirs any more
        Ok(res) => log::warn!("publish {name}: api answered {} to stop", res.status()),
        Err(e) => log::warn!("publish {name}: api unreachable for stop: {e}"),
    }
}

/// `wants`: how many (audio, video) sections the watcher's offer can receive on. The
/// room's slots are bound to them in order, as many as fit: a watcher that asks for one
/// video gets the camera. `preview`: one of home's muted previews, held apart from the
/// viewers (not counted, its own cap) but otherwise served like any watcher.
async fn watch_stream(app: App, mut socket: WebSocket, name: String, sdp: String, wants: (usize, usize), preview: bool, forwarded: Option<IpAddr>) {
    let Some((tracks, mut generation, my_generation, mut slots)) = app.hub.tracks(&name, wants).await else {
        let _ = send(&mut socket, Out::error("not live")).await;
        return;
    };

    let dead = Arc::new(Notify::new());
    let connected = Arc::new(Notify::new());
    let peer = match new_peer(&app, Role::Watch, &name, dead.clone(), connected.clone()).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("watch {name}: peer setup: {e}");
            let _ = send(&mut socket, Out::error("server error")).await;
            return;
        }
    };

    for (slot, track) in tracks {
        let sender = match peer
            .add_track(track as Arc<dyn TrackLocal + Send + Sync>)
            .await
        {
            Ok(sender) => sender,
            Err(e) => {
                log::warn!("watch {name}: add track: {e}");
                let _ = send(&mut socket, Out::error("server error")).await;
                let _ = peer.close().await;
                return;
            }
        };

        // Watchers ask for keyframes when they lose a picture. Pass that on to
        // the publisher, for that slot, rate limited, instead of dropping it.
        let hub = app.hub.clone();
        let room = name.clone();
        tokio::spawn(async move {
            while let Ok((packets, _)) = sender.read_rtcp().await {
                let wants_keyframe = packets.iter().any(|p| {
                    let any = p.as_any();
                    any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                });
                if wants_keyframe {
                    hub.request_keyframe(&room, slot, false).await;
                }
            }
        });
    }

    let answer = match negotiate(&peer, sdp).await {
        Ok(answer) => answer,
        Err(e) => {
            log::warn!("watch {name}: negotiate: {e}");
            let _ = send(&mut socket, Out::error("could not negotiate")).await;
            let _ = peer.close().await;
            return;
        }
    };
    let mut counted: Option<u64> = None;

    if send(&mut socket, Out::sdp(answer)).await.is_ok() {
        log::info!("watch {name}: joined");
        let mut shutdown = app.shutdown.clone();
        // What is live in which slot: now, and again on every change.
        let current = slots.borrow_and_update().clone();
        let _ = send(&mut socket, Out::slots(current)).await;
        let viewers = app.hub.viewers_rx(&name).await;
        let mut told = None;
        let mut tick = tokio::time::interval(VIEWERS_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                // Counted once the media path is up, by the address it goes to. A
                // preview is held by that address instead, apart from the viewers.
                _ = connected.notified(), if counted.is_none() => {
                    let Some(ip) = media_ip(&peer).await.or(forwarded) else {
                        log::warn!("watch {name}: connected, but no address to count it by");
                        continue;
                    };
                    let id = app.hub.next_viewer.fetch_add(1, Ordering::Relaxed);
                    let held = if preview {
                        app.hub.add_preview(&name, my_generation, id, ip).await
                    } else {
                        app.hub.add_viewer(&name, my_generation, id, ip).await
                    };
                    match held {
                        Ok(()) => counted = Some(id),
                        Err(e) => {
                            log::info!("watch {name}: refused {ip}: {e}");
                            let _ = send(&mut socket, Out::error(e)).await;
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }
                    }
                }
                // not before it is counted itself, or the first word it hears is a 0
                _ = tick.tick(), if counted.is_some() => {
                    if tell_viewers(&mut socket, viewers.as_ref(), &mut told).await.is_err() {
                        break;
                    }
                }
                _ = wait_until_socket_closes(&mut socket) => {
                    log::info!("watch {name}: left");
                    break;
                }
                _ = async { let _ = generation.wait_for(|g| *g != my_generation).await; } => {
                    log::info!("watch {name}: stream ended");
                    let _ = send(&mut socket, Out::event("ended")).await;
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                _ = async { let _ = shutdown.wait_for(|s| *s).await; } => {
                    let _ = send(&mut socket, Out::event("ended")).await;
                    break;
                }
                _ = dead.notified() => {
                    log::info!("watch {name}: peer gone");
                    break;
                }
                changed = slots.changed() => {
                    if changed.is_err() {
                        // the room went, and its sender with it: the stream ended
                        log::info!("watch {name}: stream ended");
                        let _ = send(&mut socket, Out::event("ended")).await;
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    let current = slots.borrow_and_update().clone();
                    if send(&mut socket, Out::slots(current)).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    if let Some(id) = counted {
        if preview {
            app.hub.remove_preview(&name, id).await;
        } else {
            app.hub.remove_viewer(&name, id).await;
        }
    }
    let _ = peer.close().await;
}

/// Where this peer's media really goes: the remote side of the selected candidate
/// pair. Browsers hide their host candidates behind mdns names, but the pair that won
/// is the address the packets came from (peer reflexive), which is what we count.
async fn media_ip(peer: &RTCPeerConnection) -> Option<IpAddr> {
    let pair = peer.dtls_transport().ice_transport().get_selected_candidate_pair().await?;
    pair.remote.address.parse().ok()
}

/// Send the room's count if it moved since the last one this socket was told.
async fn tell_viewers(socket: &mut WebSocket, viewers: Option<&watch::Receiver<usize>>, told: &mut Option<usize>) -> anyhow::Result<()> {
    let Some(viewers) = viewers else { return Ok(()) };
    let now = *viewers.borrow();
    if *told != Some(now) {
        send(socket, Out::viewers(now)).await?;
        *told = Some(now);
    }
    Ok(())
}

/// Take the browser's offer, reply with our answer. Candidates are gathered
/// before the answer leaves, so one message each way is enough.
async fn negotiate(peer: &RTCPeerConnection, sdp: String) -> anyhow::Result<String> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let offer = RTCSessionDescription::offer(sdp)?;
        peer.set_remote_description(offer).await?;
        let answer = peer.create_answer(None).await?;
        let mut gathered = peer.gathering_complete_promise().await;
        peer.set_local_description(answer).await?;
        let _ = gathered.recv().await;
        let local = peer
            .local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("no local description"))?;
        Ok(local.sdp)
    })
    .await
    .map_err(|_| anyhow::anyhow!("negotiation timed out"))?
}

async fn new_peer(
    app: &App,
    role: Role,
    name: &str,
    dead: Arc<Notify>,
    connected: Arc<Notify>,
) -> anyhow::Result<RTCPeerConnection> {
    // The publisher's browser adapts its upload to our transport feedback.
    // Watchers' feedback is not used, so don't ask for it.
    let (media, registry) = media_setup(role == Role::Publish)?;

    let mut setting = SettingEngine::default();
    // Every peer shares the one UDP socket.
    setting.set_udp_network(UDPNetwork::Muxed(app.mux.clone()));
    setting.set_network_types(vec![NetworkType::Udp4]);
    // Exactly one host candidate. Two local ips mapped to the same public ip
    // would be a duplicate, and dropping the duplicate closes the shared socket.
    let taken = Arc::new(AtomicBool::new(false));
    setting.set_ip_filter(Box::new(move |ip: IpAddr| {
        ip.is_ipv4() && !ip.is_loopback() && !taken.swap(true, Ordering::SeqCst)
    }));
    setting.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    // Tell browsers our public ip. No STUN needed, so gathering is instant.
    setting.set_nat_1to1_ips(vec![app.public_ip.clone()], RTCIceCandidateType::Host);
    // Notice a vanished peer in seconds, not half a minute.
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

    let tag = format!("{} {name}", role.as_str());
    let hub = app.hub.clone();
    let room = name.to_owned();
    let is_watcher = role == Role::Watch;
    let asked_keyframe = Arc::new(AtomicBool::new(false));
    peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        log::info!("{tag}: peer {state}");
        if state == RTCPeerConnectionState::Connected {
            connected.notify_one();
        }
        match state {
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => dead.notify_one(),
            // A new watcher needs a keyframe on every picture right now, not
            // whenever the next one happens to come. Once per watcher, ignoring
            // the rate limit.
            RTCPeerConnectionState::Connected
                if is_watcher && !asked_keyframe.swap(true, Ordering::SeqCst) =>
            {
                let hub = hub.clone();
                let room = room.clone();
                tokio::spawn(async move { hub.request_keyframes(&room).await });
            }
            _ => {}
        }
        Box::pin(async {})
    }));

    Ok(peer)
}

impl Hub {
    /// Take the name, with a slot per section of the offer. Returns the new
    /// generation, or None if someone has it.
    async fn claim(&self, name: &str, slots: Vec<(String, RTPCodecType)>) -> Option<u64> {
        let mut rooms = self.rooms.lock().await;
        if rooms.contains_key(name) {
            return None;
        }
        let mut room = Room::new(name, slots);
        room.bump();
        let generation = room.generation;
        rooms.insert(name.to_owned(), room);
        Some(generation)
    }

    async fn set_publisher(&self, name: &str, peer: Weak<RTCPeerConnection>) {
        if let Some(room) = self.rooms.lock().await.get_mut(name) {
            room.publisher = Some(peer);
        }
    }

    /// The publisher's packets for `mid` have started. The slot's track to copy them
    /// into, the slot's index, and whether it is the camera (the first video slot,
    /// the one the thumbnail is made from). None if that publisher's room is gone,
    /// or its offer had no such section.
    async fn bind(&self, name: &str, generation: u64, mid: &str, ssrc: u32) -> Option<(Arc<TrackLocalStaticRTP>, usize, bool)> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| r.generation == generation)?;
        let camera = room.slots.iter().position(|s| s.kind == RTPCodecType::Video);
        let index = room.slots.iter().position(|s| s.mid == mid)?;
        let slot = &mut room.slots[index];
        slot.ssrc = Some(ssrc);
        Some((Arc::clone(&slot.track), index, camera == Some(index)))
    }

    /// The live room's tracks for a watcher that can receive on `wants` (audio, video)
    /// sections, with their slot indexes: the slots in order, as many of each kind as
    /// fit. Also a receiver that changes when the stream ends, the generation those
    /// tracks belong to, and the slots the publisher says are live. None when nobody
    /// is live. The tracks exist from the claim on, so there is nothing to wait for.
    #[allow(clippy::type_complexity)]
    async fn tracks(
        &self,
        name: &str,
        wants: (usize, usize),
    ) -> Option<(Vec<(usize, Arc<TrackLocalStaticRTP>)>, watch::Receiver<u64>, u64, watch::Receiver<Showing>)> {
        let rooms = self.rooms.lock().await;
        let room = rooms.get(name)?;
        let (mut audio, mut video) = wants;
        let tracks = room
            .slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| {
                let left = match slot.kind {
                    RTPCodecType::Audio => &mut audio,
                    _ => &mut video,
                };
                let fits = *left > 0;
                *left = left.saturating_sub(1);
                fits
            })
            .map(|(index, slot)| (index, Arc::clone(&slot.track)))
            .collect();
        Some((tracks, room.generation_tx.subscribe(), room.generation, room.slots_tx.subscribe()))
    }

    /// A publisher's later frame, checked against its offer: at most one entry per
    /// video slot, each naming one, strings kept short, and a layout that is one.
    /// Watchers get it as it is.
    async fn set_slots(&self, name: &str, generation: u64, text: &str) -> Result<(), &'static str> {
        let frame: SlotsFrame = serde_json::from_str(text).map_err(|_| "not a slots frame")?;
        if frame.layout.as_ref().is_some_and(|l| !l.well_formed()) {
            return Err("bad layout");
        }
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| r.generation == generation).ok_or("room gone")?;
        let videos = room.slots.iter().filter(|s| s.kind == RTPCodecType::Video).count();
        let mut named = vec![false; videos];
        for info in &frame.slots {
            let Some(seen) = named.get_mut(info.slot) else {
                return Err("no such video slot");
            };
            if std::mem::replace(seen, true) {
                return Err("a slot named twice");
            }
            if info.kind.len() > MAX_KIND_BYTES || info.label.as_ref().is_some_and(|l| l.len() > MAX_LABEL_BYTES) {
                return Err("kind or label too long");
            }
        }
        room.slots_tx.send_replace(Showing { slots: frame.slots, layout: frame.layout });
        Ok(())
    }

    /// Ask the publisher for a keyframe on one slot: a watcher lost that picture, or
    /// the thumbnail needs one. Rate limited per slot; nothing for audio, or for a
    /// slot that has not sent anything yet.
    async fn request_keyframe(&self, name: &str, slot: usize, force: bool) {
        let (peer, ssrc) = {
            let mut rooms = self.rooms.lock().await;
            let Some(room) = rooms.get_mut(name) else { return };
            let Some(peer) = room.publisher.as_ref().and_then(Weak::upgrade) else { return };
            let Some(slot) = room.slots.get_mut(slot) else { return };
            let Some(ssrc) = slot.ssrc.filter(|_| slot.kind == RTPCodecType::Video) else { return };
            let now = Instant::now();
            let gap = if force { FORCED_KEYFRAME_GAP } else { KEYFRAME_GAP };
            if slot.last_keyframe.is_some_and(|t| now.duration_since(t) < gap) {
                return;
            }
            slot.last_keyframe = Some(now);
            (peer, ssrc)
        };
        let _ = peer
            .write_rtcp(&[Box::new(PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: ssrc,
            })])
            .await;
    }

    /// A keyframe on every picture, for a watcher that just joined.
    async fn request_keyframes(&self, name: &str) {
        let count = self.rooms.lock().await.get(name).map_or(0, |room| room.slots.len());
        for slot in 0..count {
            self.request_keyframe(name, slot, true).await;
        }
    }

    /// The publisher left. Watchers see the generation change and leave too.
    async fn clear(&self, name: &str) {
        let mut rooms = self.rooms.lock().await;
        if let Some(mut room) = rooms.remove(name) {
            room.bump();
        }
    }

    async fn end_all(&self) {
        let mut rooms = self.rooms.lock().await;
        for (_, mut room) in rooms.drain() {
            room.bump();
        }
    }

    /// Count a connected watcher, unless its address already holds its share.
    async fn add_viewer(&self, name: &str, generation: u64, id: u64, ip: IpAddr) -> Result<(), &'static str> {
        let mut rooms = self.rooms.lock().await;
        let everywhere = rooms.values().flat_map(|r| r.viewers.values()).filter(|v| **v == ip).count();
        let room = rooms.get_mut(name).filter(|r| r.generation == generation).ok_or("not live")?;
        let here = room.viewers.values().filter(|v| **v == ip).count();
        if here >= MAX_WATCHERS_PER_IP_ROOM || everywhere >= MAX_WATCHERS_PER_IP {
            return Err("too many watchers from your address");
        }
        room.viewers.insert(id, ip);
        room.recount();
        Ok(())
    }

    /// A counted watcher left. A room that has moved on (a new publisher) never had it.
    async fn remove_viewer(&self, name: &str, id: u64) {
        if let Some(room) = self.rooms.lock().await.get_mut(name) {
            if room.viewers.remove(&id).is_some() {
                room.recount();
            }
        }
    }

    /// Hold a connected preview, unless its address already holds its share of them.
    /// Not a viewer: it goes in `previews`, never into the count or the watcher caps.
    async fn add_preview(&self, name: &str, generation: u64, id: u64, ip: IpAddr) -> Result<(), &'static str> {
        let mut rooms = self.rooms.lock().await;
        let everywhere = rooms.values().flat_map(|r| r.previews.values()).filter(|v| **v == ip).count();
        let room = rooms.get_mut(name).filter(|r| r.generation == generation).ok_or("not live")?;
        if everywhere >= MAX_PREVIEWS_PER_IP {
            return Err("too many previews from your address");
        }
        room.previews.insert(id, ip);
        Ok(())
    }

    /// A held preview left. Nothing to recount: it was never in the number.
    async fn remove_preview(&self, name: &str, id: u64) {
        if let Some(room) = self.rooms.lock().await.get_mut(name) {
            room.previews.remove(&id);
        }
    }

    async fn viewers_rx(&self, name: &str) -> Option<watch::Receiver<usize>> {
        self.rooms.lock().await.get(name).map(|r| r.viewers_tx.subscribe())
    }

    async fn viewer_counts(&self) -> HashMap<String, usize> {
        let rooms = self.rooms.lock().await;
        rooms.iter().map(|(name, room)| (name.clone(), *room.viewers_tx.borrow())).collect()
    }

    async fn live_names(&self) -> Vec<String> {
        let rooms = self.rooms.lock().await;
        let mut names: Vec<String> = rooms.keys().cloned().collect();
        names.sort();
        names
    }
}

impl Room {
    /// A room for `name` with a slot per offered section. The tracks' ids tell the
    /// slots apart on the watcher's side (`audio-0`, `video-1`, …: kind and mid);
    /// their stream id is the room, so a watcher gets them as one MediaStream.
    fn new(name: &str, slots: Vec<(String, RTPCodecType)>) -> Self {
        let (generation_tx, _) = watch::channel(0);
        let slots: Vec<Slot> = slots
            .into_iter()
            .map(|(mid, kind)| {
                let capability = if kind == RTPCodecType::Audio { opus_capability() } else { vp8_capability() };
                Slot {
                    track: Arc::new(TrackLocalStaticRTP::new(capability, format!("{kind}-{mid}"), name.to_owned())),
                    mid,
                    kind,
                    ssrc: None,
                    last_keyframe: None,
                }
            })
            .collect();
        // until the publisher says otherwise, its first video section is the camera and
        // there is no layout (a browser that never says, or the dummy, has exactly that)
        let camera = slots
            .iter()
            .any(|s| s.kind == RTPCodecType::Video)
            .then(|| SlotInfo { slot: 0, kind: "camera".to_owned(), label: None });
        let (slots_tx, _) = watch::channel(Showing { slots: camera.into_iter().collect(), layout: None });
        let (viewers_tx, _) = watch::channel(0);
        Self {
            generation: 0,
            generation_tx,
            slots,
            slots_tx,
            publisher: None,
            viewers: HashMap::new(),
            previews: HashMap::new(),
            viewers_tx,
        }
    }

    /// Different addresses, not peers: five tabs on one wifi are one viewer.
    fn recount(&mut self) {
        let unique: std::collections::HashSet<&IpAddr> = self.viewers.values().collect();
        self.viewers_tx.send_replace(unique.len());
    }

    fn bump(&mut self) {
        self.generation += 1;
        self.generation_tx.send_replace(self.generation);
    }
}

impl Out {
    fn sdp(sdp: String) -> Self {
        Self {
            sdp: Some(sdp),
            ..Default::default()
        }
    }

    fn error(message: &str) -> Self {
        Self {
            error: Some(message.to_owned()),
            ..Default::default()
        }
    }

    fn event(event: &str) -> Self {
        Self {
            event: Some(event.to_owned()),
            ..Default::default()
        }
    }

    fn viewers(count: usize) -> Self {
        Self {
            event: Some("viewers".to_owned()),
            viewers: Some(count),
            ..Default::default()
        }
    }

    fn slots(showing: Showing) -> Self {
        Self {
            event: Some("slots".to_owned()),
            slots: Some(showing.slots),
            layout: showing.layout,
            ..Default::default()
        }
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// One m= section of an offer, as far as the room cares: what it carries, its mid,
/// and which way it goes (no direction line means both ways).
struct MediaSection {
    kind: Option<RTPCodecType>,
    mid: Option<String>,
    sends: bool,
    receives: bool,
}

fn media_sections(sdp: &str) -> Vec<MediaSection> {
    let mut sections: Vec<MediaSection> = Vec::new();
    for line in sdp.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("m=") {
            let kind = match rest.split(' ').next() {
                Some("audio") => Some(RTPCodecType::Audio),
                Some("video") => Some(RTPCodecType::Video),
                _ => None,
            };
            sections.push(MediaSection { kind, mid: None, sends: true, receives: true });
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

/// The room's slots in a publisher's offer: every audio/video section it sends on,
/// in order, with its mid. None if one of them has no mid: every browser and
/// webrtc-rs bundle, so every section has one, and without it the packets that
/// come later could not be told apart.
fn offer_slots(sdp: &str) -> Option<Vec<(String, RTPCodecType)>> {
    media_sections(sdp)
        .into_iter()
        .filter(|section| section.sends && section.kind.is_some())
        .map(|section| Some((section.mid?, section.kind?)))
        .collect()
}

/// How many (audio, video) sections a watcher's offer can receive on.
fn offered_receivers(sdp: &str) -> (usize, usize) {
    media_sections(sdp)
        .into_iter()
        .filter(|section| section.receives)
        .fold((0, 0), |(audio, video), section| match section.kind {
            Some(RTPCodecType::Audio) => (audio + 1, video),
            Some(RTPCodecType::Video) => (audio, video + 1),
            _ => (audio, video),
        })
}

async fn send(socket: &mut WebSocket, msg: Out) -> anyhow::Result<()> {
    let text = serde_json::to_string(&msg)?;
    socket.send(Message::Text(text.into())).await?;
    Ok(())
}

async fn wait_until_socket_closes(socket: &mut WebSocket) {
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, last))
    }

    /// A live room with one camera slot, as a publisher's claim makes it.
    async fn live_room(hub: &Hub, name: &str) -> u64 {
        hub.claim(name, vec![("0".to_owned(), RTPCodecType::Video)]).await.expect("the name is free")
    }

    // F-1-2: home tabs behind one address used to be watcher peers, so four of them
    // in a featured room made the fifth peer from that address, the real watcher,
    // "too many watchers from your address". Previews are held apart now.
    #[tokio::test]
    async fn previews_spend_neither_the_watcher_cap_nor_the_count() {
        let hub = Hub::default();
        let generation = live_room(&hub, "f").await;
        let home = ip(1);
        let mut ids = 0u64..;
        for _ in 0..MAX_PREVIEWS_PER_IP {
            hub.add_preview("f", generation, ids.next().unwrap(), home).await.expect("a preview under the cap");
        }
        assert_eq!(hub.viewer_counts().await["f"], 0, "previews are not viewers");
        for _ in 0..MAX_WATCHERS_PER_IP_ROOM {
            hub.add_viewer("f", generation, ids.next().unwrap(), home).await.expect("the watcher share is untouched by previews");
        }
        assert_eq!(hub.viewer_counts().await["f"], 1, "four watcher peers from one address are one viewer");
        // the watcher cap itself still holds
        assert_eq!(hub.add_viewer("f", generation, ids.next().unwrap(), home).await, Err("too many watchers from your address"));
    }

    #[tokio::test]
    async fn the_thirteenth_preview_from_one_address_is_refused() {
        let hub = Hub::default();
        let f = live_room(&hub, "f").await;
        let g = live_room(&hub, "g").await;
        let home = ip(1);
        let mut ids = 0u64..;
        // spread over two rooms: the cap is per address across all of them
        for i in 0..MAX_PREVIEWS_PER_IP {
            let (name, generation) = if i % 2 == 0 { ("f", f) } else { ("g", g) };
            hub.add_preview(name, generation, ids.next().unwrap(), home).await.expect("a preview under the cap");
        }
        let thirteenth = ids.next().unwrap();
        assert_eq!(hub.add_preview("f", f, thirteenth, home).await, Err("too many previews from your address"));
        hub.add_preview("f", f, ids.next().unwrap(), ip(2)).await.expect("another address has its own share");
        // one leaving frees its place
        hub.remove_preview("f", 0).await;
        hub.add_preview("f", f, thirteenth, home).await.expect("the place a leaving preview freed");
        assert_eq!(hub.viewer_counts().await["f"], 0);
        assert_eq!(hub.viewer_counts().await["g"], 0);
    }

    #[tokio::test]
    async fn a_preview_for_a_room_that_is_gone_is_not_live() {
        let hub = Hub::default();
        let generation = live_room(&hub, "f").await;
        hub.clear("f").await;
        assert_eq!(hub.add_preview("f", generation, 0, ip(1)).await, Err("not live"));
    }
}
