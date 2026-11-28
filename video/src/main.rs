mod dummy;
mod fanout;
mod limits;
mod media;
mod resend;
mod simulcast;
mod thumbs;
mod timings;
mod view;
mod voice;

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
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use webrtc::rtcp::receiver_report::ReceiverReport;
use webrtc::rtcp::transport_feedbacks::transport_layer_nack::TransportLayerNack;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecParameters, RTPCodecType};
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::fanout::{Feed, Meter, Viewer, ViewerTrack};
use crate::media::{accept_simulcast, capability_of, media_setup, opus_capability};
use crate::resend::Resend;
use crate::simulcast::{is_copy_rid, level_of, pinned_limits, start_level, Codec, Picker, Signals, CODECS, LEVELS};
use crate::view::{Gate, View, MAX_STRIKES};

const KEYFRAME_GAP: Duration = Duration::from_millis(1500);
const FORCED_KEYFRAME_GAP: Duration = Duration::from_millis(300);
const KEYFRAME_IN_FLIGHT: Duration = Duration::from_millis(500);
const JOIN_PLI_WINDOW: Duration = Duration::from_secs(3);
const NACK_BEHIND_FLOOR: u16 = 4096;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const API_TIMEOUT: Duration = Duration::from_millis(1500);
const SHUTDOWN_FLUSH: Duration = Duration::from_secs(2);
const MAX_SDP_BYTES: usize = 48 * 1024;
const MAX_MEDIA_LINES: usize = 6;
const MAX_KIND_BYTES: usize = 16;
const MAX_LABEL_BYTES: usize = 64;
const MAX_LAYERS: usize = 16;
const MAX_LAYER_ID_BYTES: usize = 16;
const UDP_BUFFER_BYTES: usize = 4 << 20;
const MAX_WATCHERS_PER_IP_ROOM: usize = 4;
const MAX_WATCHERS_PER_IP: usize = 16;
const MAX_PREVIEWS_PER_IP: usize = 12;
const VIEWERS_TICK: Duration = Duration::from_secs(1);
const COPY_HOLD: Duration = Duration::from_secs(10);
const FOLLOW_TICK: Duration = Duration::from_millis(250);
const SWITCH_REASK: Duration = Duration::from_millis(500);
const HEALTH_WINDOW: Duration = Duration::from_secs(1);
const HEALTH_STALE: Duration = Duration::from_secs(3);
const NACK_MIN_SENT: u64 = 50;

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
    api_url: String,
    http: reqwest::Client,
    thumbs: bool,
    started: Instant,
    build: String,
}

#[derive(Clone, Default)]
struct Hub {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    next_viewer: Arc<AtomicU64>,
}

struct Room {
    generation: u64,
    generation_tx: watch::Sender<u64>,
    slots: Vec<Slot>,
    slots_tx: watch::Sender<Showing>,
    publisher: Option<Weak<RTCPeerConnection>>,
    viewers: HashMap<u64, IpAddr>,
    previews: HashMap<u64, IpAddr>,
    viewers_tx: watch::Sender<usize>,
}

struct Slot {
    mid: String,
    copy_mid: Option<String>,
    kind: RTPCodecType,
    track_id: String,
    out: SlotOut,
    asks: [[KeyframeAsks; LEVELS]; CODECS],
}

#[derive(Clone)]
enum SlotOut {
    Audio(Arc<TrackLocalStaticRTP>),
    Video(Feeds),
}

#[derive(Clone)]
struct Feeds {
    vp8: Arc<Feed>,
    vp9: Option<Arc<Feed>>,
}

impl Feeds {
    fn get(&self, codec: Codec) -> Option<&Arc<Feed>> {
        match codec {
            Codec::Vp8 => Some(&self.vp8),
            Codec::Vp9 => self.vp9.as_ref(),
        }
    }

    fn pick(&self, decodes_vp9: bool) -> &Arc<Feed> {
        let now = Instant::now();
        let live = |feed: &Feed| feed.views(now).iter().any(|l| l.live);
        match &self.vp9 {
            Some(vp9) if decodes_vp9 && (live(vp9) || !live(&self.vp8)) => vp9,
            _ => &self.vp8,
        }
    }

    fn primary(&self) -> Codec {
        if self.vp9.is_some() {
            Codec::Vp9
        } else {
            Codec::Vp8
        }
    }
}

enum Bound {
    Audio(Arc<TrackLocalStaticRTP>),
    Video { feed: Arc<Feed>, level: u8, tap: bool },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Offered {
    mid: String,
    kind: RTPCodecType,
    levels: u8,
    copy: Option<(String, u8)>,
}

impl Offered {
    fn pins(slots: &[Offered]) -> HashMap<String, Codec> {
        let mut pins = HashMap::new();
        for slot in slots.iter().filter(|s| s.kind == RTPCodecType::Video) {
            match &slot.copy {
                Some((copy, _)) => {
                    pins.insert(slot.mid.clone(), Codec::Vp9);
                    pins.insert(copy.clone(), Codec::Vp8);
                }
                None => {
                    pins.insert(slot.mid.clone(), Codec::Vp8);
                }
            }
        }
        pins
    }
}

#[derive(Default)]
struct CopyDemand {
    on: bool,
    wanted_at: Option<Instant>,
}

impl CopyDemand {
    fn update(&mut self, wanted: Option<bool>, now: Instant) -> Option<bool> {
        let wanted = wanted?;
        if wanted {
            self.wanted_at = Some(now);
            if !self.on {
                self.on = true;
                return Some(true);
            }
        } else if self.on && self.wanted_at.is_none_or(|at| now.saturating_duration_since(at) >= COPY_HOLD) {
            self.on = false;
            return Some(false);
        }
        None
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ask {
    Join,
    Backup(u64),
    Lost,
    Thumb,
    Switch,
    Resume,
    Trailing,
}

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Send,
    Skip,
    Trail(Duration),
}

#[derive(Default)]
struct KeyframeAsks {
    asked: Option<Instant>,
    asked_seen: u64,
    join_asked: Option<Instant>,
    trailing: bool,
}

impl KeyframeAsks {
    fn decide(&mut self, ask: Ask, now: Instant, seen: u64) -> Plan {
        let since = |t: Option<Instant>| t.map(|t| now.saturating_duration_since(t));
        let in_flight = seen == self.asked_seen && since(self.asked).is_some_and(|d| d < KEYFRAME_IN_FLIGHT);
        let join_recent = since(self.join_asked).filter(|d| *d < FORCED_KEYFRAME_GAP);
        let send = match ask {
            Ask::Lost => since(self.asked).is_none_or(|d| d >= KEYFRAME_GAP),
            Ask::Thumb => since(self.asked).is_none_or(|d| d >= FORCED_KEYFRAME_GAP),
            Ask::Switch => !in_flight && since(self.asked).is_none_or(|d| d >= FORCED_KEYFRAME_GAP),
            Ask::Resume => since(self.asked).is_none_or(|d| d >= FORCED_KEYFRAME_GAP),
            Ask::Backup(connected) if seen != connected => false,
            Ask::Join | Ask::Backup(_) if in_flight => false,
            Ask::Join | Ask::Backup(_) => match join_recent {
                Some(_) if self.trailing => false,
                Some(d) => {
                    self.trailing = true;
                    return Plan::Trail(FORCED_KEYFRAME_GAP - d);
                }
                None => true,
            },
            Ask::Trailing => {
                self.trailing = false;
                !in_flight && join_recent.is_none()
            }
        };
        if !send {
            return Plan::Skip;
        }
        self.asked = Some(now);
        self.asked_seen = seen;
        if !matches!(ask, Ask::Lost | Ask::Thumb | Ask::Switch | Ask::Resume) {
            self.join_asked = Some(now);
        }
        Plan::Send
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct SlotInfo {
    slot: usize,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Layer {
    id: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    slot: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    look: Option<AvatarLook>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct AvatarLook {
    shape: String,
    border: bool,
    color: String,
    bounce: bool,
}

impl AvatarLook {
    fn well_formed(&self) -> bool {
        let shape = matches!(self.shape.as_str(), "default" | "block" | "soft" | "bubble");
        let color = self.color.is_empty() || (self.color.len() == 7 && self.color.starts_with('#') && self.color[1..].bytes().all(|b| b.is_ascii_hexdigit()));
        shape && color
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Scene {
    layers: Vec<Layer>,
}

impl Scene {
    fn well_formed(&self, video_slots: usize) -> bool {
        self.layers.len() <= MAX_LAYERS
            && self.layers.iter().all(|layer| {
                let id = (1..=MAX_LAYER_ID_BYTES).contains(&layer.id.len())
                    && layer.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
                let placed = [layer.x, layer.y, layer.w, layer.h].iter().all(|v| (0.0..=1.0).contains(v));
                let fit = layer.fit.as_deref().is_none_or(|f| matches!(f, "cover" | "contain"));
                let named = match layer.kind.as_str() {
                    "camera" | "screen" => layer.slot.is_some_and(|slot| slot < video_slots),
                    "image" => layer.asset.is_some_and(|asset| asset > 0),
                    "avatar" => true,
                    _ => false,
                };
                let look = layer.look.as_ref().is_none_or(|l| layer.kind == "avatar" && l.well_formed());
                id && placed && fit && named && look
            })
    }
}

#[derive(Deserialize)]
struct SlotsFrame {
    slots: Vec<SlotInfo>,
    #[serde(default)]
    scene: Option<Scene>,
}

#[derive(Clone, Default)]
struct Showing {
    slots: Vec<SlotInfo>,
    scene: Option<Scene>,
}

#[derive(Deserialize)]
struct In {
    role: String,
    name: String,
    sdp: String,
    #[serde(default)]
    session: Option<i64>,
    #[serde(default)]
    token: Option<i64>,
    #[serde(default)]
    password: Option<String>,
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
    scene: Option<Scene>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    full: Option<bool>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,video=info,webrtc_ice=error"),
    )
    .init();

    if std::env::args().nth(1).as_deref() == Some("dummy") {
        return dummy::run().await;
    }
    timings::serve();
    if std::env::args().nth(1).as_deref() == Some("voice") {
        return voice::run().await;
    }

    let public_ip = std::env::var("PUBLIC_IP").unwrap_or_else(|_| "127.0.0.1".into());
    let ws_port = env_port("WS_PORT", 7880);
    let udp_port = env_port("UDP_PORT", 7882);

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
        build: std::env::var("BUILD").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "dev".into()),
    };

    let router = Router::new()
        .route("/health", get(health))
        .route("/live", get(live))
        .route("/viewers", get(viewers))
        .route("/thumb/{file}", get(thumb))
        .route("/ws", get(ws))
        .route_layer(axum::middleware::from_fn_with_state(limits::Limits::default(), limits::layer))
        .with_state(app.clone())
        .layer(axum::middleware::from_fn(timings::http));

    let addr = SocketAddr::from(([0, 0, 0, 0], ws_port));
    log::info!("websocket on {addr}/ws");
    let listener = tokio::net::TcpListener::bind(addr).await?;

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

pub(crate) fn media_socket(port: u16) -> anyhow::Result<tokio::net::UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    let _ = socket.set_send_buffer_size(UDP_BUFFER_BYTES);
    let _ = socket.set_recv_buffer_size(UDP_BUFFER_BYTES);
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

pub(crate) fn env_port(key: &str, default: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

async fn live(State(app): State<App>) -> Json<Vec<String>> {
    Json(app.hub.live_names().await)
}

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "up_secs": app.started.elapsed().as_secs(),
        "build": app.build,
        "live": app.hub.live_names().await.len(),
        "viewers": app.hub.viewer_counts().await.values().sum::<usize>(),
    }))
}

async fn viewers(State(app): State<App>) -> Json<HashMap<String, usize>> {
    Json(app.hub.viewer_counts().await)
}

async fn thumb(State(app): State<App>, axum::extract::Path(file): axum::extract::Path<String>) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    let Some(name) = file.strip_suffix(".jpg").map(str::to_lowercase) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !valid_name(&name) || !app.hub.live_names().await.contains(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if thumbs::picture_age(&name).await.is_none_or(|age| age > thumbs::stale_after()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(thumbs::jpeg_path(&name)).await {
        Ok(bytes) if bytes.len() > 4 => (
            [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "public, max-age=0, s-maxage=5, stale-while-revalidate=10")],
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

pub(crate) fn forwarded_ip(headers: &HeaderMap) -> Option<IpAddr> {
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

    if incoming.sdp.len() > MAX_SDP_BYTES
        || incoming.sdp.lines().filter(|l| l.starts_with("m=")).count() > MAX_MEDIA_LINES
        || RTCSessionDescription::offer(incoming.sdp.clone()).is_err()
    {
        let _ = send(&mut socket, Out::error("bad offer")).await;
        return;
    }

    match incoming.role.as_str() {
        "publish" => {
            let Some(slots) = offer_slots(&incoming.sdp).filter(|slots| !slots.is_empty()) else {
                let _ = send(&mut socket, Out::error("bad offer")).await;
                return;
            };
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
            let vp9 = decodes_vp9(&incoming.sdp);
            watch_stream(app, socket, name, incoming.sdp, wants, vp9, incoming.preview.unwrap_or(false), forwarded).await
        }
        _ => {
            let _ = send(&mut socket, Out::error("role must be publish or watch")).await;
        }
    }
}

async fn owns_stream(app: &App, name: &str, session: Option<i64>, token: Option<i64>) -> Result<(), &'static str> {
    let (Some(session), Some(token)) = (session, token) else {
        return Err("not your stream");
    };
    let url = format!("{}/api/streams/{name}/heartbeat?session={session}&token={token}", app.api_url);
    match timings::call("POST", "/api/streams/{name}/heartbeat", app.http.post(url)).await {
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

async fn publish(app: App, mut socket: WebSocket, name: String, sdp: String, slots: Vec<Offered>, grant: (Option<i64>, Option<i64>)) {
    let count = slots.len();
    let pins = Offered::pins(&slots);
    let copied = slots.iter().any(|s| s.copy.is_some());
    let Some(generation) = app.hub.claim(&name, slots).await else {
        let _ = send(&mut socket, Out::error("someone is already live")).await;
        return;
    };
    log::info!("publish {name}: start, {count} slot(s){}", if copied { ", camera in VP9 with a VP8 copy" } else { "" });
    let session = timings::Session::open("webrtc", "publish");
    let setup = Arc::new(timings::Setup::start("webrtc", "publish"));

    let dead = Arc::new(Notify::new());
    let peer = match new_peer(&app, Role::Publish, &name, dead.clone(), Arc::new(Notify::new()), Vec::new(), None, setup.clone()).await {
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
    let ingest = timings::line("session", "webrtc", "publish", timings::Dir::In);
    let delivery = timings::line("session", "webrtc", "watch", timings::Dir::Out);
    peer.on_track(Box::new(move |track, _, transceiver| {
        let hub = hub.clone();
        let room = room.clone();
        let (ingest, delivery) = (ingest.clone(), delivery.clone());
        tokio::spawn(async move {
            let kind = track.kind();
            let codec = track.codec();
            let mid = transceiver.mid().map(|m| m.to_string()).unwrap_or_default();
            let rid = track.rid().to_owned();
            let Some((bound, slot)) = hub.bind(&room, generation, &mid, &rid, track.ssrc()).await else {
                log::info!("publish {room}: {kind} packets on mid {mid:?} rid {rid:?} with no slot for them");
                return;
            };
            log::info!("publish {room}: slot {slot} up ({kind}, mid {mid}, rid {rid:?}, {})", codec.capability.mime_type);
            let (feed, level, camera) = match bound {
                Bound::Audio(local) => {
                    while let Ok((mut packet, _)) = track.read_rtp().await {
                        packet.header.extension = false;
                        packet.header.extensions.clear();
                        let size = timings::packet_bytes(packet.payload.len());
                        ingest.count(1, size);
                        if let Ok(written) = local.write_rtp(&packet).await {
                            timings::delivered(&delivery, written, size);
                        }
                    }
                    log::info!("publish {room}: slot {slot} done ({kind})");
                    return;
                }
                Bound::Video { feed, level, tap } => (feed, level, tap),
            };
            let family = feed.codec();
            if Codec::of_mime(&codec.capability.mime_type) != Some(family) {
                log::warn!("publish {room}: slot {slot} sent {} where {} was answered", codec.capability.mime_type, family.name());
                return;
            }

            let mut tap = None;
            if thumbs_on && camera {
                match thumbs::ThumbTap::start(&room, codec.payload_type).await {
                    Ok(started) => tap = Some(started),
                    Err(e) => log::warn!("publish {room}: no thumbnail: {e}"),
                }
            }
            if let Some(tap) = &tap {
                let hub = hub.clone();
                let room = room.clone();
                let ffmpeg_gone = tap.dead_flag();
                tokio::spawn(async move {
                    let mut wait = Duration::from_millis(400);
                    let mut due_since: Option<Instant> = None;
                    let mut told = false;
                    loop {
                        tokio::time::sleep(wait).await;
                        wait = Duration::from_millis(500);
                        if ffmpeg_gone.load(Ordering::Relaxed) {
                            break;
                        }
                        let age = thumbs::picture_age(&room).await;
                        if age.is_some_and(|age| age <= thumbs::due_after()) {
                            due_since = None;
                            if told {
                                log::info!("thumb {room}: pictures again");
                                told = false;
                            }
                        } else {
                            let stuck = due_since.get_or_insert_with(Instant::now).elapsed() > thumbs::stale_after();
                            if stuck && !told {
                                log::warn!("thumb {room}: no new picture for {}s with keyframes asked for. ffmpeg stuck, or the video stopped", thumbs::stale_after().as_secs());
                                told = true;
                            }
                            if stuck {
                                wait = Duration::from_secs(10);
                            }
                        }
                        if age.is_none_or(|age| age >= thumbs::ask_after()) {
                            hub.request_keyframe(&room, slot, family, level, Ask::Thumb).await;
                        }
                    }
                });
            }

            let mut meter = Meter::new(Instant::now());
            while let Ok((mut packet, _)) = track.read_rtp().await {
                packet.header.extension = false;
                packet.header.extensions.clear();
                let now = Instant::now();
                let parsed = family.parse(&packet.payload);
                feed.arrived(level, packet.payload.len(), &parsed, &mut meter, now);
                if let Some(tap) = &mut tap {
                    tap.feed(&packet);
                }
                let size = timings::packet_bytes(packet.payload.len());
                ingest.count(1, size);
                let written = feed.forward(level, &packet, &parsed, now).await;
                timings::delivered(&delivery, written, size);
            }
            drop(tap);
            log::info!("publish {room}: slot {slot} done ({kind}, rid {rid:?})");
        });
        Box::pin(async {})
    }));

    let answer = match negotiate(&peer, sdp, &pins).await {
        Ok(answer) => answer,
        Err(e) => {
            log::warn!("publish {name}: negotiate: {e}");
            let _ = send(&mut socket, Out::error("could not negotiate")).await;
            let _ = peer.close().await;
            app.hub.clear(&name).await;
            return;
        }
    };

    let mut by = "video";
    if send(&mut socket, Out::sdp(answer)).await.is_ok() {
        tokio::spawn(tell_attached(app.clone(), name.clone(), grant));
        let mut shutdown = app.shutdown.clone();
        let viewers = app.hub.viewers_rx(&name).await;
        let mut told = None;
        let mut copy = CopyDemand::default();
        let mut tick = tokio::time::interval(VIEWERS_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    match tell_viewers(&mut socket, viewers.as_ref(), &mut told).await {
                        Err(_) => {
                            log::info!("publish {name}: socket closed");
                            break;
                        }
                        Ok(Some(count)) => { tokio::spawn(tell_api_viewers(app.clone(), name.clone(), grant, count)); }
                        Ok(None) => {}
                    }
                    if let Some(full) = copy.update(app.hub.copy_wanted(&name, generation).await, Instant::now()) {
                        log::info!("publish {name}: the VP8 copy {} its upper layer", if full { "turns on" } else { "turns off" });
                        if send(&mut socket, Out::copy(full)).await.is_err() {
                            log::info!("publish {name}: socket closed");
                            break;
                        }
                    }
                }
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(e) = app.hub.set_slots(&name, generation, &text).await {
                            log::info!("publish {name}: a frame was ignored: {e}");
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        log::info!("publish {name}: socket closed by the page");
                        by = "stop";
                        break;
                    }
                    Some(Err(_)) | None => {
                        log::info!("publish {name}: socket closed");
                        break;
                    }
                    _ => {}
                },
                _ = dead.notified() => {
                    log::info!("publish {name}: peer gone");
                    session.fail("peer gone");
                    break;
                }
                _ = async { let _ = shutdown.wait_for(|s| *s).await; } => {
                    let _ = send(&mut socket, Out::event("ended")).await;
                    break;
                }
            }
        }
    }

    setup.done(false);
    let _ = peer.close().await;
    app.hub.clear(&name).await;
    end_session(&app, &name, grant, by).await;
    log::info!("publish {name}: ended");
}

async fn tell_attached(app: App, name: String, grant: (Option<i64>, Option<i64>)) {
    let (Some(session), Some(token)) = grant else { return };
    let url = format!("{}/api/streams/{name}/attached?session={session}&token={token}", app.api_url);
    for attempt in 1..=3 {
        match timings::call("POST", "/api/streams/{name}/attached", app.http.post(&url)).await {
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

async fn end_session(app: &App, name: &str, grant: (Option<i64>, Option<i64>), by: &str) {
    let (Some(session), Some(token)) = grant else { return };
    let url = format!("{}/api/streams/{name}/stop?session={session}&token={token}&by={by}", app.api_url);
    match timings::call("POST", "/api/streams/{name}/stop", app.http.post(url)).await {
        Ok(res) if res.status().is_success() => log::info!("publish {name}: told the api to stop session {session}"),
        Ok(res) if res.status().is_client_error() => {}
        Ok(res) => log::warn!("publish {name}: api answered {} to stop", res.status()),
        Err(e) => log::warn!("publish {name}: api unreachable for stop: {e}"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn watch_stream(app: App, mut socket: WebSocket, name: String, sdp: String, wants: (usize, usize), vp9: bool, preview: bool, forwarded: Option<IpAddr>) {
    let Some((tracks, mut generation, my_generation, mut slots)) = app.hub.tracks(&name, wants).await else {
        let _ = send(&mut socket, Out::error("not live")).await;
        return;
    };

    let what = if preview { "preview" } else { "watch" };
    let session = timings::Session::open("webrtc", what);
    let setup = Arc::new(timings::Setup::start("webrtc", what));
    let dead = Arc::new(Notify::new());
    let connected = Arc::new(Notify::new());
    let resend = Arc::new(Resend::default());
    let planned: Vec<(usize, SlotOut, Option<(Arc<Feed>, Arc<Viewer>, u8)>)> = tracks
        .into_iter()
        .map(|(slot, out, track_id)| {
            let viewer = match &out {
                SlotOut::Video(feeds) => {
                    let feed = Arc::clone(feeds.pick(vp9));
                    let start = feed.start_level(preview);
                    let track = ViewerTrack::new(capability_of(feed.codec()), track_id, name.clone(), Arc::clone(&resend));
                    Some((feed, Arc::new(Viewer::new(Arc::new(track), start, preview)), start))
                }
                SlotOut::Audio(_) => None,
            };
            (slot, out, viewer)
        })
        .collect();
    let watched = planned
        .iter()
        .filter_map(|(slot, _, viewer)| viewer.as_ref().map(|(feed, viewer, start)| (*slot, *start, Arc::clone(feed), Arc::downgrade(&viewer.track))))
        .collect();
    let peer = match new_peer(&app, Role::Watch, &name, dead.clone(), connected.clone(), watched, Some(Arc::clone(&resend)), setup.clone()).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("watch {name}: peer setup: {e}");
            let _ = send(&mut socket, Out::error("server error")).await;
            return;
        }
    };

    let mut following: Vec<(Arc<Feed>, Arc<Viewer>)> = Vec::new();
    for (slot, out, viewer) in planned {
        let local: Arc<dyn TrackLocal + Send + Sync> = match (&out, &viewer) {
            (_, Some((feed, viewer, _))) => {
                log::info!("{what} {name}: slot {slot} in {}", feed.codec().name());
                feed.join(Arc::clone(viewer));
                following.push((Arc::clone(feed), Arc::clone(viewer)));
                Arc::clone(&viewer.track) as _
            }
            (SlotOut::Audio(track), None) => Arc::clone(track) as _,
            (SlotOut::Video(_), None) => continue,
        };
        let sender = match peer.add_track(local).await {
            Ok(sender) => sender,
            Err(e) => {
                log::warn!("watch {name}: add track: {e}");
                let _ = send(&mut socket, Out::error("server error")).await;
                let _ = peer.close().await;
                leave_all(&following);
                return;
            }
        };

        match viewer {
            Some((feed, viewer, start)) => {
                let tag = format!("{what} {name}");
                tokio::spawn(follow(app.hub.clone(), name.clone(), tag, slot, feed, viewer, sender, start, preview));
            }
            None => {
                tokio::spawn(async move { while sender.read_rtcp().await.is_ok() {} });
            }
        }
    }

    let answer = match negotiate(&peer, sdp, &HashMap::new()).await {
        Ok(answer) => answer,
        Err(e) => {
            log::warn!("watch {name}: negotiate: {e}");
            let _ = send(&mut socket, Out::error("could not negotiate")).await;
            let _ = peer.close().await;
            leave_all(&following);
            return;
        }
    };
    let mut counted: Option<u64> = None;
    let mut gate = Gate::new(Instant::now());
    let mut strikes = 0;

    if send(&mut socket, Out::sdp(answer)).await.is_ok() {
        log::info!("watch {name}: joined");
        let mut shutdown = app.shutdown.clone();
        let current = slots.borrow_and_update().clone();
        let _ = send(&mut socket, Out::slots(current)).await;
        let viewers = app.hub.viewers_rx(&name).await;
        let mut told = None;
        let mut tick = tokio::time::interval(VIEWERS_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if strikes > MAX_STRIKES {
                log::info!("watch {name}: closed after {strikes} bad frames");
                let _ = send(&mut socket, Out::error("bad frames")).await;
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            let due = gate.due();
            tokio::select! {
                _ = async { if let Some(at) = due { tokio::time::sleep_until(at.into()).await } }, if due.is_some() => {
                    if let Some(view) = gate.tick(Instant::now()) {
                        tell_view(&following, view);
                    }
                }
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
                _ = tick.tick(), if counted.is_some() => {
                    if tell_viewers(&mut socket, viewers.as_ref(), &mut told).await.is_err() {
                        break;
                    }
                }
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Text(text))) => match View::parse(&text) {
                        Some(view) if view != gate.wanted() => {
                            if let Some(view) = gate.want(view, Instant::now()) {
                                tell_view(&following, view);
                            }
                        }
                        _ => strikes += 1,
                    },
                    Some(Ok(Message::Binary(_))) => strikes += 1,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        log::info!("watch {name}: left");
                        break;
                    }
                    _ => {}
                },
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
                    session.fail("peer gone");
                    break;
                }
                changed = slots.changed() => {
                    if changed.is_err() {
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
    setup.done(false);
    leave_all(&following);
    let _ = peer.close().await;
    drop(session);
}

fn tell_view(following: &[(Arc<Feed>, Arc<Viewer>)], view: View) {
    for (_, viewer) in following {
        viewer.want_view(view);
    }
}

fn leave_all(following: &[(Arc<Feed>, Arc<Viewer>)]) {
    for (feed, viewer) in following {
        feed.leave(viewer);
        viewer.track.release();
    }
}

#[derive(Default)]
struct Health {
    remb: Option<(u64, Instant)>,
    loss: Option<(f32, Instant)>,
    nacked: u64,
    window: std::collections::VecDeque<(Instant, u64, u64)>,
}

impl Health {
    fn reset(&mut self) {
        self.loss = None;
        self.window.clear();
    }

    fn read(&mut self, packets: &[Box<dyn webrtc::rtcp::packet::Packet + Send + Sync>], ssrc: Option<u32>, floor: Option<u16>, now: Instant) -> bool {
        let mut lost = false;
        for packet in packets {
            let any = packet.as_any();
            if any.downcast_ref::<PictureLossIndication>().is_some() || any.downcast_ref::<FullIntraRequest>().is_some() {
                lost = true;
            } else if let Some(remb) = any.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
                self.remb = Some((remb.bitrate.max(0.0) as u64, now));
            } else if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                for report in rr.reports.iter().filter(|r| Some(r.ssrc) == ssrc) {
                    let sample = f32::from(report.fraction_lost) / 256.0;
                    let smoothed = match self.loss {
                        Some((old, at)) if now.saturating_duration_since(at) < HEALTH_STALE => (old + sample) / 2.0,
                        _ => sample,
                    };
                    self.loss = Some((smoothed, now));
                }
            } else if let Some(nack) = any.downcast_ref::<TransportLayerNack>() {
                let before_floor = |seq: u16| floor.is_some_and(|f| (1..=NACK_BEHIND_FLOOR).contains(&f.wrapping_sub(seq)));
                self.nacked += nack.nacks.iter().flat_map(|n| n.into_iter()).filter(|seq| !before_floor(*seq)).count() as u64;
            }
        }
        lost
    }

    fn signals(&mut self, now: Instant, sent: u64) -> Signals {
        self.window.push_back((now, self.nacked, sent));
        while self.window.len() > 2 && self.window.get(1).is_some_and(|(at, _, _)| now.saturating_duration_since(*at) >= HEALTH_WINDOW) {
            self.window.pop_front();
        }
        let nack = match self.window.front() {
            Some((_, nacked, was_sent)) if sent.saturating_sub(*was_sent) >= NACK_MIN_SENT => self.nacked.saturating_sub(*nacked) as f32 / sent.saturating_sub(*was_sent) as f32,
            _ => 0.0,
        };
        let fresh = |at: Instant| now.saturating_duration_since(at) < HEALTH_STALE;
        Signals {
            remb: self.remb.filter(|(_, at)| fresh(*at)).map(|(r, _)| r),
            loss: self.loss.filter(|(_, at)| fresh(*at)).map_or(0.0, |(l, _)| l),
            nack,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn follow(hub: Hub, room: String, tag: String, slot: usize, feed: Arc<Feed>, viewer: Arc<Viewer>, sender: Arc<RTCRtpSender>, start: u8, preview: bool) {
    let top = LEVELS as u8 - 1;
    let limits = |view: View| if preview || view == View::Small { pinned_limits(feed.offered()) } else { (top, top) };
    let mut picker = Picker::new(start, top, Instant::now());
    let (cap, ceiling) = limits(View::Full);
    picker.limit(cap, ceiling);
    let mut health = Health::default();
    let mut tick = tokio::time::interval(FOLLOW_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut moving: Option<(Instant, Option<u8>)> = None;
    let mut asked: Option<Instant> = None;
    let mut resumed: Option<Instant> = None;
    let mut reask: Option<Instant> = None;
    let mut view = View::Full;
    let joined = Instant::now();
    loop {
        tokio::select! {
            _ = async { if let Some(at) = reask { tokio::time::sleep_until(at.into()).await } }, if reask.is_some() => {
                reask = None;
                if view != View::Hidden && resumed.is_some() && viewer.current().is_none() {
                    reask = Some(Instant::now() + FORCED_KEYFRAME_GAP);
                    hub.request_keyframe(&room, slot, feed.codec(), viewer.target(), Ask::Resume).await;
                }
            }
            _ = viewer.view_changed() => {
                let next = viewer.view();
                if next == view {
                    continue;
                }
                let was = std::mem::replace(&mut view, next);
                let now = Instant::now();
                log::info!("{tag}: slot {slot} view {was:?} -> {next:?}");
                if next == View::Hidden {
                    viewer.pause();
                    moving = None;
                    asked = None;
                    resumed = None;
                    reask = None;
                    continue;
                }
                let (cap, ceiling) = limits(next);
                picker.limit(cap, ceiling);
                let layers = feed.views(now);
                if was == View::Hidden {
                    picker.resume(now);
                    health.reset();
                }
                if !preview && next == View::Full {
                    picker.lift(start_level(&layers, feed.offered(), false), now);
                }
                picker.decide(now, &layers, None, &Signals::default());
                let target = picker.target();
                viewer.set_target(target);
                if was == View::Hidden {
                    viewer.resume();
                    resumed = Some(now);
                    asked = Some(now);
                    reask = Some(now + FORCED_KEYFRAME_GAP);
                    hub.request_keyframe(&room, slot, feed.codec(), target, Ask::Resume).await;
                } else if viewer.current() != Some(target) {
                    moving = Some((now, viewer.current()));
                    asked = Some(now);
                    hub.request_keyframe(&room, slot, feed.codec(), target, Ask::Switch).await;
                }
            }
            read = sender.read_rtcp() => {
                let Ok((packets, _)) = read else { break };
                let now = Instant::now();
                if health.read(&packets, viewer.track.ssrc(), viewer.track.floor(), now) && view != View::Hidden {
                    let level = viewer.current().unwrap_or_else(|| viewer.target());
                    let ask = if now.saturating_duration_since(joined) < JOIN_PLI_WINDOW { Ask::Join } else { Ask::Lost };
                    hub.request_keyframe(&room, slot, feed.codec(), level, ask).await;
                }
            }
            _ = tick.tick() => {
                if view == View::Hidden {
                    continue;
                }
                let now = Instant::now();
                let signals = health.signals(now, viewer.sent());
                let current = viewer.current();
                if let (Some(since), Some(on)) = (resumed, current) {
                    log::info!("{tag}: slot {slot} picture back on layer {on} {}ms after the resume", feed.switched_after(&viewer, since).as_millis());
                    resumed = None;
                }
                let before = picker.target();
                if let Some(why) = picker.decide(now, &feed.views(now), current, &signals) {
                    viewer.set_target(picker.target());
                    log::info!(
                        "{tag}: slot {slot} layer {before} -> {} ({why:?}; loss {:.3}, nack {:.3}, remb {:?})",
                        picker.target(), signals.loss, signals.nack, signals.remb
                    );
                    moving = Some((now, current));
                    asked = None;
                }
                let target = picker.target();
                if let Some((since, from)) = moving {
                    if current == Some(target) && from != current {
                        log::info!("{tag}: slot {slot} on layer {target} {}ms after the decision", feed.switched_after(&viewer, since).as_millis());
                        moving = None;
                        health.reset();
                    }
                }
                let pending = current.is_some_and(|c| c != target) || (current.is_none() && target != start);
                if resumed.is_none() && pending && asked.is_none_or(|at| now.saturating_duration_since(at) >= SWITCH_REASK) {
                    asked = Some(now);
                    hub.request_keyframe(&room, slot, feed.codec(), target, Ask::Switch).await;
                }
            }
        }
    }
}

async fn send_pli(peer: &RTCPeerConnection, ssrc: u32) {
    let _ = peer
        .write_rtcp(&[Box::new(PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: ssrc,
        })])
        .await;
}

async fn media_ip(peer: &RTCPeerConnection) -> Option<IpAddr> {
    let pair = peer.dtls_transport().ice_transport().get_selected_candidate_pair().await?;
    pair.remote.address.parse().ok()
}

async fn tell_viewers(socket: &mut WebSocket, viewers: Option<&watch::Receiver<usize>>, told: &mut Option<usize>) -> anyhow::Result<Option<usize>> {
    let Some(viewers) = viewers else { return Ok(None) };
    let now = *viewers.borrow();
    if *told != Some(now) {
        send(socket, Out::viewers(now)).await?;
        *told = Some(now);
        return Ok(Some(now));
    }
    Ok(None)
}

async fn tell_api_viewers(app: App, name: String, grant: (Option<i64>, Option<i64>), count: usize) {
    let (Some(session), Some(token)) = grant else { return };
    let url = format!("{}/api/streams/{name}/viewers?session={session}&token={token}&viewers={count}", app.api_url);
    match timings::call("POST", "/api/streams/{name}/viewers", app.http.post(url)).await {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => log::debug!("publish {name}: api answered {} to viewers", res.status()),
        Err(e) => log::debug!("publish {name}: api unreachable for viewers: {e}"),
    }
}

async fn pin_codecs(peer: &RTCPeerConnection, pins: &HashMap<String, Codec>) {
    for transceiver in peer.get_transceivers().await {
        if transceiver.kind() != RTPCodecType::Video {
            continue;
        }
        let track = transceiver.sender().await.track().await;
        let capability = match track.as_ref().and_then(|t| t.as_any().downcast_ref::<ViewerTrack>()) {
            Some(track) => track.codec().clone(),
            None => match transceiver.mid().and_then(|mid| pins.get(mid.as_str()).copied()) {
                Some(codec) => capability_of(codec),
                None => continue,
            },
        };
        let mime = capability.mime_type.clone();
        if let Err(e) = transceiver.set_codec_preferences(vec![RTCRtpCodecParameters { capability, ..Default::default() }]).await {
            log::warn!("mid {:?}: could not answer {mime} only: {e}", transceiver.mid());
        }
    }
}

async fn negotiate(peer: &RTCPeerConnection, sdp: String, pins: &HashMap<String, Codec>) -> anyhow::Result<String> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let offer = RTCSessionDescription::offer(sdp)?;
        peer.set_remote_description(offer).await?;
        pin_codecs(peer, pins).await;
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

type Watched = (usize, u8, Arc<Feed>, Weak<ViewerTrack>);

async fn new_peer(
    app: &App,
    role: Role,
    name: &str,
    dead: Arc<Notify>,
    connected: Arc<Notify>,
    watched: Vec<Watched>,
    resend: Option<Arc<Resend>>,
    setup: Arc<timings::Setup>,
) -> anyhow::Result<RTCPeerConnection> {
    let (mut media, registry) = media_setup(role == Role::Publish, true, resend)?;
    if role == Role::Publish {
        accept_simulcast(&mut media)?;
    }

    let mut setting = SettingEngine::default();
    setting.set_udp_network(UDPNetwork::Muxed(app.mux.clone()));
    setting.set_network_types(vec![NetworkType::Udp4]);
    let taken = Arc::new(AtomicBool::new(false));
    setting.set_ip_filter(Box::new(move |ip: IpAddr| {
        ip.is_ipv4() && !ip.is_loopback() && !taken.swap(true, Ordering::SeqCst)
    }));
    setting.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    setting.set_nat_1to1_ips(vec![app.public_ip.clone()], RTCIceCandidateType::Host);
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
    let watched: Arc<[Watched]> = watched.into();
    let early_hub = hub.clone();
    let early_room = room.clone();
    let early_watched = Arc::clone(&watched);
    let asked_early = AtomicBool::new(false);
    peer.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        if matches!(state, RTCIceConnectionState::Connected | RTCIceConnectionState::Completed)
            && !early_watched.is_empty()
            && !asked_early.swap(true, Ordering::SeqCst)
        {
            let asks = early_watched.iter().map(|(slot, level, feed, _)| (*slot, feed.codec(), *level, Ask::Join)).collect();
            let hub = early_hub.clone();
            let room = early_room.clone();
            tokio::spawn(async move { hub.request_keyframes(&room, asks).await });
        }
        Box::pin(async {})
    }));

    let asked_backup = AtomicBool::new(false);
    peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        log::info!("{tag}: peer {state}");
        if state == RTCPeerConnectionState::Connected {
            setup.done(true);
            connected.notify_one();
        }
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            setup.fail(&format!("peer {state} before it connected"));
        }
        match state {
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => dead.notify_one(),
            RTCPeerConnectionState::Connected
                if !watched.is_empty() && !asked_backup.swap(true, Ordering::SeqCst) =>
            {
                let asks = watched
                    .iter()
                    .filter(|(_, _, _, track)| !track.upgrade().is_some_and(|t| t.holds_picture()))
                    .map(|(slot, level, feed, _)| (*slot, feed.codec(), *level, Ask::Backup(feed.layer(*level).keyframes.load(Ordering::Relaxed))))
                    .collect();
                let hub = hub.clone();
                let room = room.clone();
                tokio::spawn(async move { hub.request_keyframes(&room, asks).await });
            }
            _ => {}
        }
        Box::pin(async {})
    }));

    Ok(peer)
}

impl Hub {
    async fn claim(&self, name: &str, slots: Vec<Offered>) -> Option<u64> {
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

    async fn bind(&self, name: &str, generation: u64, mid: &str, rid: &str, ssrc: u32) -> Option<(Bound, usize)> {
        let rooms = self.rooms.lock().await;
        let room = rooms.get(name).filter(|r| r.generation == generation)?;
        let camera = room.slots.iter().position(|s| s.kind == RTPCodecType::Video);
        let index = room.slots.iter().position(|s| s.mid == mid || s.copy_mid.as_deref() == Some(mid))?;
        let slot = &room.slots[index];
        match &slot.out {
            SlotOut::Audio(track) => Some((Bound::Audio(Arc::clone(track)), index)),
            SlotOut::Video(feeds) => {
                let feed = feeds.get(if slot.mid == mid { feeds.primary() } else { Codec::Vp8 })?;
                let level = level_of(rid).filter(|l| feed.offered() & (1 << l) != 0)?;
                feed.bind(level, ssrc);
                let lowest = feed.offered().trailing_zeros() as u8;
                let tap = camera == Some(index) && feed.codec() == Codec::Vp8 && level == lowest;
                Some((Bound::Video { feed: Arc::clone(feed), level, tap }, index))
            }
        }
    }

    #[allow(clippy::type_complexity)]
    async fn tracks(
        &self,
        name: &str,
        wants: (usize, usize),
    ) -> Option<(Vec<(usize, SlotOut, String)>, watch::Receiver<u64>, u64, watch::Receiver<Showing>)> {
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
            .map(|(index, slot)| (index, slot.out.clone(), slot.track_id.clone()))
            .collect();
        Some((tracks, room.generation_tx.subscribe(), room.generation, room.slots_tx.subscribe()))
    }

    async fn set_slots(&self, name: &str, generation: u64, text: &str) -> Result<(), &'static str> {
        let frame: SlotsFrame = serde_json::from_str(text).map_err(|_| "not a slots frame")?;
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| r.generation == generation).ok_or("room gone")?;
        let videos = room.slots.iter().filter(|s| s.kind == RTPCodecType::Video).count();
        if frame.scene.as_ref().is_some_and(|s| !s.well_formed(videos)) {
            return Err("bad scene");
        }
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
        room.slots_tx.send_replace(Showing { slots: frame.slots, scene: frame.scene });
        Ok(())
    }

    async fn request_keyframe(&self, name: &str, slot: usize, codec: Codec, level: u8, ask: Ask) {
        let Some((plan, peer, ssrc, generation)) = self.plan_keyframe(name, None, slot, codec, level, ask).await else { return };
        log::debug!("keyframe {name} slot {slot} {} layer {level}: {ask:?} -> {plan:?}", codec.name());
        match plan {
            Plan::Send => send_pli(&peer, ssrc).await,
            Plan::Skip => {}
            Plan::Trail(wait) => {
                drop(peer);
                let hub = self.clone();
                let name = name.to_owned();
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    if let Some((Plan::Send, peer, ssrc, _)) = hub.plan_keyframe(&name, Some(generation), slot, codec, level, Ask::Trailing).await {
                        send_pli(&peer, ssrc).await;
                    }
                });
            }
        }
    }

    async fn plan_keyframe(&self, name: &str, generation: Option<u64>, slot: usize, codec: Codec, level: u8, ask: Ask) -> Option<(Plan, Arc<RTCPeerConnection>, u32, u64)> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| generation.is_none_or(|g| g == r.generation))?;
        let peer = room.publisher.as_ref().and_then(Weak::upgrade)?;
        let generation = room.generation;
        let slot = room.slots.get_mut(slot)?;
        let SlotOut::Video(feeds) = &slot.out else { return None };
        let feed = feeds.get(codec)?;
        let ssrc = feed.ssrc(level)?;
        let seen = feed.layer(level).keyframes.load(Ordering::Relaxed);
        let plan = slot.asks[codec.index()].get_mut(level as usize)?.decide(ask, Instant::now(), seen);
        Some((plan, peer, ssrc, generation))
    }

    async fn request_keyframes(&self, name: &str, asks: Vec<(usize, Codec, u8, Ask)>) {
        for (slot, codec, level, ask) in asks {
            self.request_keyframe(name, slot, codec, level, ask).await;
        }
    }

    async fn copy_wanted(&self, name: &str, generation: u64) -> Option<bool> {
        let rooms = self.rooms.lock().await;
        let room = rooms.get(name).filter(|r| r.generation == generation)?;
        let camera = room.slots.iter().find(|s| s.copy_mid.is_some())?;
        let SlotOut::Video(feeds) = &camera.out else { return None };
        Some(feeds.vp8.has_full_viewers())
    }

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

    async fn remove_viewer(&self, name: &str, id: u64) {
        if let Some(room) = self.rooms.lock().await.get_mut(name) {
            if room.viewers.remove(&id).is_some() {
                room.recount();
            }
        }
    }

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
    fn new(name: &str, slots: Vec<Offered>) -> Self {
        let (generation_tx, _) = watch::channel(0);
        let slots: Vec<Slot> = slots
            .into_iter()
            .map(|Offered { mid, kind, levels, copy }| {
                let track_id = format!("{kind}-{mid}");
                let out = if kind == RTPCodecType::Audio {
                    SlotOut::Audio(Arc::new(TrackLocalStaticRTP::new(opus_capability(), track_id.clone(), name.to_owned())))
                } else {
                    SlotOut::Video(match &copy {
                        Some((_, copy_levels)) => Feeds { vp8: Arc::new(Feed::new(Codec::Vp8, *copy_levels)), vp9: Some(Arc::new(Feed::new(Codec::Vp9, levels))) },
                        None => Feeds { vp8: Arc::new(Feed::new(Codec::Vp8, levels)), vp9: None },
                    })
                };
                let copy_mid = copy.map(|(mid, _)| mid);
                Slot { mid, copy_mid, kind, track_id, out, asks: Default::default() }
            })
            .collect();
        let camera = slots
            .iter()
            .any(|s| s.kind == RTPCodecType::Video)
            .then(|| SlotInfo { slot: 0, kind: "camera".to_owned(), label: None });
        let (slots_tx, _) = watch::channel(Showing { slots: camera.into_iter().collect(), scene: None });
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

    fn copy(full: bool) -> Self {
        Self {
            event: Some("copy".to_owned()),
            full: Some(full),
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
            scene: showing.scene,
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

struct MediaSection {
    kind: Option<RTPCodecType>,
    mid: Option<String>,
    sends: bool,
    receives: bool,
    levels: u8,
    copy: bool,
    vp8: bool,
    vp9: Vec<String>,
    other_vp9: Vec<String>,
}

impl MediaSection {
    fn offers_vp9(&self) -> bool {
        self.vp9.iter().any(|pt| !self.other_vp9.contains(pt))
    }
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
            sections.push(MediaSection { kind, mid: None, sends: true, receives: true, levels: 0, copy: false, vp8: false, vp9: Vec::new(), other_vp9: Vec::new() });
        } else if let Some(section) = sections.last_mut() {
            if let Some(mid) = line.strip_prefix("a=mid:") {
                section.mid = Some(mid.trim().to_owned());
            } else if let Some(map) = line.strip_prefix("a=rtpmap:") {
                let mut words = map.split_whitespace();
                if let (Some(pt), Some(name)) = (words.next(), words.next()) {
                    let codec = name.split('/').next().unwrap_or_default();
                    if codec.eq_ignore_ascii_case("VP8") {
                        section.vp8 = true;
                    } else if codec.eq_ignore_ascii_case("VP9") {
                        section.vp9.push(pt.to_owned());
                    }
                }
            } else if let Some(fmtp) = line.strip_prefix("a=fmtp:") {
                let mut words = fmtp.splitn(2, ' ');
                if let (Some(pt), Some(params)) = (words.next(), words.next()) {
                    if params.split(';').any(|p| p.trim().starts_with("profile-id=") && p.trim() != "profile-id=0") {
                        section.other_vp9.push(pt.to_owned());
                    }
                }
            } else if let Some(rid) = line.strip_prefix("a=rid:") {
                let mut words = rid.split_whitespace();
                let name = words.next().unwrap_or_default();
                if let (Some(level), Some("send")) = (level_of(name), words.next()) {
                    section.levels |= 1 << level;
                    section.copy |= is_copy_rid(name);
                }
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

fn offer_slots(sdp: &str) -> Option<Vec<Offered>> {
    let mut slots: Vec<(Offered, bool)> = Vec::new();
    for section in media_sections(sdp).into_iter().filter(|section| section.sends && section.kind.is_some()) {
        let levels = if section.levels == 0 { 1 } else { section.levels };
        let offered = Offered { mid: section.mid.clone()?, kind: section.kind?, levels, copy: None };
        let video = offered.kind == RTPCodecType::Video;
        if !section.copy {
            slots.push((offered, video && section.offers_vp9()));
            continue;
        }
        let usable = video && section.vp8 && !section.offers_vp9();
        if let Some((slot, _)) = slots.iter_mut().find(|(slot, vp9)| usable && *vp9 && slot.kind == RTPCodecType::Video && slot.copy.is_none()) {
            slot.copy = Some((offered.mid, levels));
        }
    }
    Some(slots.into_iter().map(|(slot, _)| slot).collect())
}

fn decodes_vp9(sdp: &str) -> bool {
    let mut video = media_sections(sdp).into_iter().filter(|section| section.receives && section.kind == Some(RTPCodecType::Video)).peekable();
    video.peek().is_some() && video.all(|section| section.offers_vp9())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_avatar_look_rides_the_scene_and_bad_ones_are_refused() {
        let scene = |layer: &str| serde_json::from_str::<Scene>(&format!(r#"{{"layers":[{layer}]}}"#)).expect("a scene");
        let plain = scene(r#"{"id":"me","kind":"avatar","x":0,"y":0,"w":0.3,"h":0.5}"#);
        assert!(plain.well_formed(0), "no look is fine");
        assert!(!serde_json::to_string(&plain).unwrap().contains("look"), "no look is not sent");
        let styled = scene(r##"{"id":"me","kind":"avatar","x":0,"y":0,"w":0.3,"h":0.5,"look":{"shape":"bubble","border":true,"color":"#ff2266","bounce":false}}"##);
        assert!(styled.well_formed(0));
        let out = serde_json::to_value(&styled).unwrap();
        assert_eq!(out["layers"][0]["look"], serde_json::json!({ "shape": "bubble", "border": true, "color": "#ff2266", "bounce": false }), "the look passes through");
        assert!(scene(r##"{"id":"me","kind":"avatar","x":0,"y":0,"w":0.3,"h":0.5,"look":{"shape":"default","border":false,"color":"","bounce":true}}"##).well_formed(0));
        assert!(!scene(r##"{"id":"me","kind":"avatar","x":0,"y":0,"w":0.3,"h":0.5,"look":{"shape":"star","border":true,"color":"","bounce":true}}"##).well_formed(0));
        assert!(!scene(r##"{"id":"me","kind":"avatar","x":0,"y":0,"w":0.3,"h":0.5,"look":{"shape":"soft","border":true,"color":"red","bounce":true}}"##).well_formed(0));
        assert!(!scene(r##"{"id":"i1","kind":"image","asset":3,"x":0,"y":0,"w":0.3,"h":0.5,"look":{"shape":"soft","border":true,"color":"","bounce":true}}"##).well_formed(0), "only the avatar has a look");
    }

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, last))
    }

    async fn live_room(hub: &Hub, name: &str) -> u64 {
        hub.claim(name, vec![Offered { mid: "0".to_owned(), kind: RTPCodecType::Video, levels: 1, copy: None }]).await.expect("the name is free")
    }

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
        assert_eq!(hub.add_viewer("f", generation, ids.next().unwrap(), home).await, Err("too many watchers from your address"));
    }

    #[tokio::test]
    async fn the_thirteenth_preview_from_one_address_is_refused() {
        let hub = Hub::default();
        let f = live_room(&hub, "f").await;
        let g = live_room(&hub, "g").await;
        let home = ip(1);
        let mut ids = 0u64..;
        for i in 0..MAX_PREVIEWS_PER_IP {
            let (name, generation) = if i % 2 == 0 { ("f", f) } else { ("g", g) };
            hub.add_preview(name, generation, ids.next().unwrap(), home).await.expect("a preview under the cap");
        }
        let thirteenth = ids.next().unwrap();
        assert_eq!(hub.add_preview("f", f, thirteenth, home).await, Err("too many previews from your address"));
        hub.add_preview("f", f, ids.next().unwrap(), ip(2)).await.expect("another address has its own share");
        hub.remove_preview("f", 0).await;
        hub.add_preview("f", f, thirteenth, home).await.expect("the place a leaving preview freed");
        assert_eq!(hub.viewer_counts().await["f"], 0);
        assert_eq!(hub.viewer_counts().await["g"], 0);
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_simulcast_offer_names_its_layers() {
        let sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\na=rid:q send\r\na=rid:h send\r\na=rid:f send\r\na=simulcast:send q;h;f\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=sendonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\na=sendonly\r\na=rid:q send\r\na=rid:x send\r\na=rid:f recv\r\n";
        let slots = offer_slots(sdp).unwrap();
        assert_eq!(slots.iter().map(|s| (s.mid.as_str(), s.levels)).collect::<Vec<_>>(), vec![("0", 0b111), ("1", 1), ("2", 1)]);
    }

    const VP9_CAMERA: &str = "m=video 9 UDP/TLS/RTP/SAVPF 98 100 96\r\na=mid:0\r\na=sendonly\r\na=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\na=rtpmap:100 VP9/90000\r\na=fmtp:100 profile-id=2\r\na=rtpmap:96 VP8/90000\r\na=rid:q send\r\na=rid:h send\r\na=rid:f send\r\na=simulcast:send q;h;f\r\n";
    const AUDIO: &str = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=sendonly\r\na=rtpmap:111 opus/48000/2\r\n";
    const SCREEN: &str = "m=video 9 UDP/TLS/RTP/SAVPF 98 96\r\na=mid:2\r\na=sendonly\r\na=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\na=rtpmap:96 VP8/90000\r\n";
    const COPY: &str = "m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=mid:3\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rid:cq send\r\na=rid:ch send\r\na=simulcast:send cq;~ch\r\n";

    #[test]
    fn a_vp8_copy_joins_the_vp9_camera_and_is_not_a_slot() {
        let sdp = format!("v=0\r\n{VP9_CAMERA}{AUDIO}{SCREEN}{COPY}");
        let slots = offer_slots(&sdp).unwrap();
        assert_eq!(slots.len(), 3);
        assert_eq!(slots[0].copy, Some(("3".to_owned(), 0b11)));
        assert_eq!(slots[0].levels, 0b111);
        assert_eq!(slots[2].copy, None);
        let pins = Offered::pins(&slots);
        assert_eq!(pins.get("0"), Some(&Codec::Vp9));
        assert_eq!(pins.get("3"), Some(&Codec::Vp8));
        assert_eq!(pins.get("2"), Some(&Codec::Vp8));
        assert_eq!(pins.get("1"), None);
    }

    #[test]
    fn without_a_copy_every_video_slot_stays_vp8() {
        let slots = offer_slots(&format!("v=0\r\n{VP9_CAMERA}{AUDIO}{SCREEN}")).unwrap();
        assert!(slots.iter().all(|s| s.copy.is_none()));
        assert!(Offered::pins(&slots).values().all(|c| *c == Codec::Vp8));
        let vp8_camera = VP9_CAMERA.replace("a=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\n", "").replace("a=rtpmap:100 VP9/90000\r\n", "");
        let slots = offer_slots(&format!("v=0\r\n{vp8_camera}{AUDIO}{COPY}")).unwrap();
        assert_eq!(slots.len(), 2, "a copy with no VP9 camera to follow is dropped");
        assert!(slots.iter().all(|s| s.copy.is_none()));
        let two_copies = offer_slots(&format!("v=0\r\n{VP9_CAMERA}{COPY}{}", COPY.replace("a=mid:3", "a=mid:4"))).unwrap();
        assert_eq!(two_copies.len(), 1);
        assert_eq!(two_copies[0].copy, Some(("3".to_owned(), 0b11)));
    }

    #[test]
    fn a_viewer_decodes_vp9_only_when_every_video_section_offers_profile_0() {
        let recv = |video: &str| format!("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n{video}{video}");
        let both = "m=video 9 UDP/TLS/RTP/SAVPF 96 98\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\n";
        let bare = "m=video 9 UDP/TLS/RTP/SAVPF 96 98\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:98 VP9/90000\r\n";
        let vp8 = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\n";
        let profile2 = "m=video 9 UDP/TLS/RTP/SAVPF 96 100\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:100 VP9/90000\r\na=fmtp:100 profile-id=2\r\n";
        assert!(decodes_vp9(&recv(both)));
        assert!(decodes_vp9(&recv(bare)));
        assert!(!decodes_vp9(&recv(vp8)));
        assert!(!decodes_vp9(&recv(profile2)));
        assert!(!decodes_vp9(&format!("v=0\r\n{both}{vp8}")));
        assert!(!decodes_vp9("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n"));
    }

    #[test]
    fn the_copy_top_turns_on_at_once_and_off_after_the_hold() {
        let t = Instant::now();
        let mut copy = CopyDemand::default();
        assert_eq!(copy.update(None, t), None);
        assert_eq!(copy.update(Some(false), t), None);
        assert_eq!(copy.update(Some(true), t), Some(true));
        assert_eq!(copy.update(Some(true), t + ms(1000)), None);
        assert_eq!(copy.update(Some(false), t + ms(2000)), None);
        assert_eq!(copy.update(Some(true), t + ms(5000)), None);
        assert_eq!(copy.update(Some(false), t + ms(5000) + COPY_HOLD - ms(1)), None);
        assert_eq!(copy.update(Some(false), t + ms(5000) + COPY_HOLD), Some(false));
        assert_eq!(copy.update(Some(false), t + ms(60_000)), None);
        assert_eq!(copy.update(Some(true), t + ms(61_000)), Some(true));
    }

    #[tokio::test]
    async fn the_copy_binds_to_the_vp8_feed_and_feeds_the_thumbnail() {
        let hub = Hub::default();
        let slots = offer_slots(&format!("v=0\r\n{VP9_CAMERA}{AUDIO}{COPY}")).unwrap();
        let generation = hub.claim("c", slots).await.unwrap();
        let Some((Bound::Video { feed, level, tap }, slot)) = hub.bind("c", generation, "0", "f", 1).await else { panic!("the camera binds") };
        assert_eq!((feed.codec(), level, tap, slot), (Codec::Vp9, 2, false, 0));
        let Some((Bound::Video { feed, tap, .. }, _)) = hub.bind("c", generation, "0", "q", 2).await else { panic!("the camera binds") };
        assert_eq!((feed.codec(), tap), (Codec::Vp9, false));
        let Some((Bound::Video { feed, level, tap }, slot)) = hub.bind("c", generation, "3", "cq", 3).await else { panic!("the copy binds") };
        assert_eq!((feed.codec(), level, tap, slot), (Codec::Vp8, 0, true, 0));
        let Some((Bound::Video { feed, level, tap }, _)) = hub.bind("c", generation, "3", "ch", 4).await else { panic!("the copy binds") };
        assert_eq!((feed.codec(), level, tap), (Codec::Vp8, 1, false));
        assert!(hub.bind("c", generation, "3", "cf", 5).await.is_none());
        let rooms = hub.rooms.lock().await;
        let SlotOut::Video(feeds) = &rooms["c"].slots[0].out else { panic!("a video slot") };
        assert_eq!(feeds.pick(true).codec(), Codec::Vp9);
        assert_eq!(feeds.pick(false).codec(), Codec::Vp8);
        assert_eq!(feeds.vp8.ssrc(0), Some(3));
        assert_eq!(feeds.vp9.as_ref().unwrap().ssrc(2), Some(1));
        let now = Instant::now();
        let mut meter = Meter::new(now);
        feeds.vp8.arrived(0, 100, &Default::default(), &mut meter, now);
        assert_eq!(feeds.pick(true).codec(), Codec::Vp8, "a VP9 feed that is quiet while the copy flows sends VP9 viewers to the copy");
        feeds.vp9.as_ref().unwrap().arrived(2, 100, &Default::default(), &mut meter, now);
        assert_eq!(feeds.pick(true).codec(), Codec::Vp9);
        assert_eq!(feeds.pick(false).codec(), Codec::Vp8);
    }

    #[tokio::test]
    async fn a_vp8_only_publisher_has_one_feed_and_vp9_viewers_get_vp8() {
        let hub = Hub::default();
        let generation = live_room(&hub, "p").await;
        let Some((Bound::Video { feed, tap, .. }, _)) = hub.bind("p", generation, "0", "", 9).await else { panic!("binds") };
        assert_eq!((feed.codec(), tap), (Codec::Vp8, true));
        let rooms = hub.rooms.lock().await;
        let SlotOut::Video(feeds) = &rooms["p"].slots[0].out else { panic!("a video slot") };
        assert!(feeds.vp9.is_none());
        assert_eq!(feeds.pick(true).codec(), Codec::Vp8);
        assert!(feeds.get(Codec::Vp9).is_none());
    }

    #[test]
    fn a_switch_asks_at_most_once_per_gap_and_never_over_one_in_flight() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Switch, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Switch, t + ms(100), 0), Plan::Skip);
        assert_eq!(asks.decide(Ask::Switch, t + FORCED_KEYFRAME_GAP, 0), Plan::Skip);
        assert_eq!(asks.decide(Ask::Switch, t + FORCED_KEYFRAME_GAP, 1), Plan::Send);
        assert_eq!(asks.join_asked, None);
        assert_eq!(asks.decide(Ask::Join, t + FORCED_KEYFRAME_GAP + ms(10), 1), Plan::Skip);
    }

    #[test]
    fn many_resumes_on_one_layer_share_one_keyframe_per_gap() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        let sent = (0..15u64).filter(|i| asks.decide(Ask::Resume, t + ms(i * 20), 0) == Plan::Send).count();
        assert_eq!(sent, 1);
        let sent = (0..50u64).filter(|i| asks.decide(Ask::Resume, t + ms(300 + i * 20), 0) == Plan::Send).count();
        assert_eq!(sent, 4);
        assert_eq!(asks.decide(Ask::Resume, t + FORCED_KEYFRAME_GAP * 5, 1), Plan::Send);
        assert_eq!(asks.decide(Ask::Switch, t + FORCED_KEYFRAME_GAP + ms(100), 2), Plan::Skip);
        assert_eq!(asks.decide(Ask::Lost, t + FORCED_KEYFRAME_GAP + ms(100), 2), Plan::Skip);
        assert_eq!(asks.join_asked, None);
    }

    #[test]
    fn nacks_for_packets_from_before_the_switch_do_not_count() {
        use webrtc::rtcp::transport_feedbacks::transport_layer_nack::NackPair;
        let nack = |packet_id: u16, lost_packets: u16| -> Vec<Box<dyn webrtc::rtcp::packet::Packet + Send + Sync>> {
            vec![Box::new(TransportLayerNack { sender_ssrc: 0, media_ssrc: 7, nacks: vec![NackPair { packet_id, lost_packets }] })]
        };
        let mut health = Health::default();
        health.read(&nack(100, 0b11), Some(7), Some(101), Instant::now());
        assert_eq!(health.nacked, 2);
        health.read(&nack(65530, 0), Some(7), Some(2), Instant::now());
        assert_eq!(health.nacked, 2);
        health.read(&nack(40000, 0), Some(7), Some(2), Instant::now());
        assert_eq!(health.nacked, 3);
        health.read(&nack(9, 0), Some(7), None, Instant::now());
        assert_eq!(health.nacked, 4);
    }

    #[test]
    fn the_nack_ratio_slides_with_every_tick() {
        let t = Instant::now();
        let mut health = Health::default();
        for i in 0..8u64 {
            assert_eq!(health.signals(t + ms(250 * i), i * 100).nack, 0.0);
        }
        health.nacked = 60;
        let signals = health.signals(t + ms(2000), 825);
        assert!(signals.nack > 0.10, "{}", signals.nack);
        assert!(health.window.len() <= 6);
    }

    #[test]
    fn a_join_shares_a_keyframe_on_its_way() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Join, t + ms(100), 0), Plan::Skip);
        assert_eq!(asks.decide(Ask::Join, t + ms(250), 0), Plan::Skip);
        assert!(!asks.trailing);
    }

    #[test]
    fn a_join_after_the_keyframe_went_gets_one_trailing_request() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Join, t + ms(200), 1), Plan::Trail(ms(100)));
        assert_eq!(asks.decide(Ask::Join, t + ms(250), 1), Plan::Skip);
        assert_eq!(asks.decide(Ask::Trailing, t + ms(300), 1), Plan::Send);
        assert!(!asks.trailing);
        assert_eq!(asks.decide(Ask::Join, t + ms(350), 1), Plan::Skip);
    }

    #[test]
    fn the_first_join_of_a_burst_ignores_other_recent_requests() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Thumb, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Join, t + ms(120), 1), Plan::Send);
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Lost, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Join, t + ms(50), 1), Plan::Send);
    }

    #[test]
    fn a_request_unanswered_past_the_in_flight_window_is_taken_as_lost() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Join, t + KEYFRAME_IN_FLIGHT, 0), Plan::Send);
    }

    #[test]
    fn a_trailing_request_is_skipped_when_a_join_asked_since() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Join, t + ms(200), 1), Plan::Trail(ms(100)));
        assert_eq!(asks.decide(Ask::Join, t + ms(300), 1), Plan::Send);
        assert_eq!(asks.decide(Ask::Trailing, t + ms(301), 1), Plan::Skip);
        assert!(!asks.trailing);
    }

    #[test]
    fn join_requests_stay_at_one_per_gap_under_any_join_rate() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        let mut sent = 0;
        let mut seen = 0;
        let mut trail_at: Option<Instant> = None;
        let mut answer_at: Option<Instant> = None;
        for step in 0..300 {
            let now = t + ms(step * 10);
            if answer_at.is_some_and(|a| now >= a) {
                seen += 1;
                answer_at = None;
            }
            if trail_at.is_some_and(|a| now >= a) {
                trail_at = None;
                if asks.decide(Ask::Trailing, now, seen) == Plan::Send {
                    sent += 1;
                    answer_at = Some(now + ms(50));
                }
            }
            match asks.decide(Ask::Join, now, seen) {
                Plan::Send => {
                    sent += 1;
                    answer_at = Some(now + ms(50));
                }
                Plan::Trail(wait) => trail_at = Some(now + wait),
                Plan::Skip => {}
            }
        }
        assert!(sent <= 3000 / FORCED_KEYFRAME_GAP.as_millis() as usize + 1, "{sent} join requests in 3s");
        assert!(sent >= 5, "joins kept getting keyframes: {sent}");
    }

    #[test]
    fn a_backup_asks_again_once_the_publisher_will_answer_when_the_early_keyframe_went_before_connect() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(150), 1), Plan::Trail(ms(150)));
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(160), 1), Plan::Skip);
        assert_eq!(asks.decide(Ask::Join, t + ms(200), 1), Plan::Skip);
        assert_eq!(asks.decide(Ask::Trailing, t + ms(300), 1), Plan::Send);
    }

    #[test]
    fn a_backup_waits_for_a_keyframe_on_its_way() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(0), t + ms(150), 0), Plan::Skip);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(150), 1), Plan::Trail(ms(150)));
    }

    #[test]
    fn a_backup_skips_when_a_keyframe_went_after_connect() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(0), t + ms(200), 1), Plan::Skip);
        assert_eq!(asks.decide(Ask::Backup(0), t + ms(900), 1), Plan::Skip);
    }

    #[test]
    fn a_backup_with_no_join_lately_asks_at_once() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Backup(0), t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(100), 1), Plan::Trail(ms(200)));
    }

    #[test]
    fn early_backups_share_one_trailing_ask() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(100), 1), Plan::Trail(ms(200)));
        assert_eq!(asks.decide(Ask::Backup(2), t + ms(200), 2), Plan::Skip);
        assert_eq!(asks.decide(Ask::Backup(2), t + ms(250), 2), Plan::Skip);
        assert_eq!(asks.decide(Ask::Trailing, t + ms(300), 2), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(3), t + ms(400), 3), Plan::Trail(ms(200)));
    }

    #[test]
    fn a_burst_of_early_asks_and_backups_stays_bounded_and_every_watcher_gets_a_keyframe() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        let connect_after = 12;
        let answer_after = 5;
        let mut sent = 0;
        let mut seen = 0;
        let mut forwarded = Vec::new();
        let mut answers: Vec<u64> = Vec::new();
        let mut trails: Vec<u64> = Vec::new();
        let mut connects: Vec<(u64, u64)> = Vec::new();
        for step in 0..300u64 {
            let now = t + ms(step * 10);
            let due = answers.iter().filter(|a| **a <= step).count();
            answers.retain(|a| *a > step);
            for _ in 0..due {
                seen += 1;
                forwarded.push(step);
            }
            let mut plans = Vec::new();
            if trails.contains(&step) {
                trails.retain(|a| *a != step);
                plans.push(asks.decide(Ask::Trailing, now, seen));
            }
            if step >= connect_after && step < 200 + connect_after {
                connects.push((step - connect_after, step));
                plans.push(asks.decide(Ask::Backup(seen), now, seen));
            }
            if step < 200 {
                plans.push(asks.decide(Ask::Join, now, seen));
            }
            for plan in plans {
                match plan {
                    Plan::Send => {
                        sent += 1;
                        answers.push(step + answer_after);
                    }
                    Plan::Trail(wait) => trails.push(step + (wait.as_millis() as u64).div_ceil(10)),
                    Plan::Skip => {}
                }
            }
        }
        assert!(sent <= 2 * (3000 / FORCED_KEYFRAME_GAP.as_millis() as usize) + 1, "{sent} join requests in 3s");
        for (joined, connected) in connects {
            let first = forwarded.iter().find(|f| **f > connected).unwrap_or_else(|| panic!("watcher {joined} got no keyframe"));
            let wait = (first - connected) * 10;
            assert!(wait <= FORCED_KEYFRAME_GAP.as_millis() as u64 + answer_after * 10 + 10, "watcher {joined} waited {wait}ms");
        }
    }

    #[test]
    fn a_watcher_loss_and_the_thumbnail_keep_their_gaps() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Lost, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Lost, t + ms(1499), 1), Plan::Skip);
        assert_eq!(asks.decide(Ask::Thumb, t + ms(299), 1), Plan::Skip);
        assert_eq!(asks.decide(Ask::Thumb, t + ms(300), 1), Plan::Send);
        assert_eq!(asks.decide(Ask::Lost, t + ms(1799), 2), Plan::Skip);
        assert_eq!(asks.decide(Ask::Lost, t + ms(1800), 2), Plan::Send);
    }

    #[tokio::test]
    async fn a_preview_for_a_room_that_is_gone_is_not_live() {
        let hub = Hub::default();
        let generation = live_room(&hub, "f").await;
        hub.clear("f").await;
        assert_eq!(hub.add_preview("f", generation, 0, ip(1)).await, Err("not live"));
    }

    fn test_app() -> App {
        let (_, shutdown) = watch::channel(false);
        App {
            hub: Hub::default(),
            public_ip: "127.0.0.1".to_owned(),
            mux: UDPMuxDefault::new(UDPMuxParams::new(media_socket(0).expect("a udp socket"))),
            shutdown,
            dummy_prefix: "dummy-".to_owned(),
            dummy_password: None,
            api_url: "http://127.0.0.1:9".to_owned(),
            http: reqwest::Client::new(),
            thumbs: false,
            started: Instant::now(),
            build: "test".to_owned(),
        }
    }

    async fn recvonly_offer(client: &RTCPeerConnection) -> String {
        use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
        use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
        client
            .add_transceiver_from_kind(RTPCodecType::Video, Some(RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Recvonly, send_encodings: vec![] }))
            .await
            .expect("a video transceiver");
        let offer = client.create_offer(None).await.expect("an offer");
        let mut gathered = client.gathering_complete_promise().await;
        client.set_local_description(offer).await.expect("the offer applies");
        let _ = gathered.recv().await;
        client.local_description().await.expect("a local description").sdp
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_closed_watch_peer_frees_its_viewer_track_and_resend_rings() {
        let app = test_app();
        let mut gone = Vec::new();
        for _ in 0..3 {
            let feed = Arc::new(Feed::new(Codec::Vp8, 1));
            let resend = Arc::new(Resend::default());
            let track = Arc::new(ViewerTrack::new(crate::media::vp8_capability(), "v".to_owned(), "s".to_owned(), Arc::clone(&resend)));
            let viewer = Arc::new(Viewer::new(Arc::clone(&track), 0, false));
            feed.join(Arc::clone(&viewer));
            let connected = Arc::new(Notify::new());
            let watched = vec![(0, 0, Arc::clone(&feed), Arc::downgrade(&track))];
            let setup = Arc::new(timings::Setup::start("webrtc", "watch"));
            let peer = new_peer(&app, Role::Watch, "s", Arc::new(Notify::new()), Arc::clone(&connected), watched, Some(Arc::clone(&resend)), setup).await.expect("a watch peer");
            let sender = peer.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>).await.expect("the viewer track");

            let (media, registry) = media_setup(false, false, None).expect("client media");
            let client = APIBuilder::new().with_media_engine(media).with_interceptor_registry(registry).build().new_peer_connection(RTCConfiguration::default()).await.expect("a client peer");
            let answer = negotiate(&peer, recvonly_offer(&client).await, &HashMap::new()).await.expect("an answer");
            client.set_remote_description(RTCSessionDescription::answer(answer).expect("an answer")).await.expect("the answer applies");
            tokio::time::timeout(Duration::from_secs(10), connected.notified()).await.expect("the peers connect");

            gone.push((Arc::downgrade(&track), Arc::downgrade(&resend)));
            feed.leave(&viewer);
            client.close().await.expect("the client closes");
            peer.close().await.expect("the peer closes");
            drop((sender, peer, client, viewer, track, resend));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while gone.iter().any(|(track, resend)| track.strong_count() > 0 || resend.strong_count() > 0) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let left: Vec<(usize, usize)> = gone.iter().map(|(track, resend)| (track.strong_count(), resend.strong_count())).collect();
        assert!(left.iter().all(|&(t, r)| t == 0 && r == 0), "viewer tracks and resend state still held after close: {left:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_watch_session_whose_ice_never_completes_releases_its_hold_and_its_track() {
        let app = test_app();
        let mut gone = Vec::new();
        for _ in 0..3 {
            let feed = Arc::new(Feed::new(Codec::Vp8, 1));
            let resend = Arc::new(Resend::default());
            let track = Arc::new(ViewerTrack::new(crate::media::vp8_capability(), "v".to_owned(), "s".to_owned(), Arc::clone(&resend)));
            let viewer = Arc::new(Viewer::new(Arc::clone(&track), 0, false));
            feed.join(Arc::clone(&viewer));
            let following = vec![(Arc::clone(&feed), Arc::clone(&viewer))];
            let dead = Arc::new(Notify::new());
            let watched = vec![(0, 0, Arc::clone(&feed), Arc::downgrade(&track))];
            let setup = Arc::new(timings::Setup::start("webrtc", "watch"));
            let peer = new_peer(&app, Role::Watch, "s", Arc::clone(&dead), Arc::new(Notify::new()), watched, Some(Arc::clone(&resend)), setup).await.expect("a watch peer");
            let sender = peer.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>).await.expect("the viewer track");

            let (media, registry) = media_setup(false, false, None).expect("client media");
            let client = APIBuilder::new().with_media_engine(media).with_interceptor_registry(registry).build().new_peer_connection(RTCConfiguration::default()).await.expect("a client peer");
            let unreachable: String = recvonly_offer(&client).await.lines().filter(|l| !l.starts_with("a=candidate") && !l.starts_with("a=end-of-candidates")).map(|l| format!("{l}\r\n")).collect();
            negotiate(&peer, unreachable, &HashMap::new()).await.expect("an answer");
            client.close().await.expect("the client closes");

            let now = Instant::now();
            let key = crate::simulcast::Frame { keyframe: true, picture_id: None, tl0: None, size: None };
            let delta = crate::simulcast::Frame { keyframe: false, ..key };
            for seq in 0..200u16 {
                let packet = webrtc::rtp::packet::Packet { header: webrtc::rtp::header::Header { sequence_number: seq, timestamp: u32::from(seq) * 3000, ssrc: 1, ..Default::default() }, payload: bytes::Bytes::from(vec![0u8; 1000]) };
                feed.forward(0, &packet, if seq == 0 { &key } else { &delta }, now).await;
            }
            assert!(track.holds_picture(), "the unconnected viewer holds its keyframe");
            assert_ne!(peer.ice_connection_state(), RTCIceConnectionState::Connected);

            leave_all(&following);
            assert!(!track.holds_picture(), "session end empties the hold");
            peer.close().await.expect("the peer closes");
            gone.push((Arc::downgrade(&track), Arc::downgrade(&resend)));
            drop((sender, peer, client, following, viewer, track, resend, feed));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while gone.iter().any(|(track, resend)| track.strong_count() > 0 || resend.strong_count() > 0) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let left: Vec<(usize, usize)> = gone.iter().map(|(track, resend)| (track.strong_count(), resend.strong_count())).collect();
        assert!(left.iter().all(|&(t, r)| t == 0 && r == 0), "viewer tracks and resend state still held after a failed session: {left:?}");
    }
}
