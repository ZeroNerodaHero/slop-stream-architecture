mod dummy;
mod limits;
mod media;
mod thumbs;
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
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::media::{is_vp8_keyframe, media_setup, opus_capability, vp8_capability};
use webrtc::api::media_engine::MIME_TYPE_VP8;

const KEYFRAME_GAP: Duration = Duration::from_millis(1500);
const FORCED_KEYFRAME_GAP: Duration = Duration::from_millis(300);
const KEYFRAME_IN_FLIGHT: Duration = Duration::from_millis(500);
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
    kind: RTPCodecType,
    track: Arc<TrackLocalStaticRTP>,
    ssrc: Option<u32>,
    keyframes: Arc<AtomicU64>,
    asks: KeyframeAsks,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ask {
    Join,
    Backup(u64),
    Lost,
    Thumb,
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
    reask: bool,
}

impl KeyframeAsks {
    fn decide(&mut self, ask: Ask, now: Instant, seen: u64) -> Plan {
        let since = |t: Option<Instant>| t.map(|t| now.saturating_duration_since(t));
        let in_flight = seen == self.asked_seen && since(self.asked).is_some_and(|d| d < KEYFRAME_IN_FLIGHT);
        let join_recent = since(self.join_asked).filter(|d| *d < FORCED_KEYFRAME_GAP);
        let send = match ask {
            Ask::Lost => since(self.asked).is_none_or(|d| d >= KEYFRAME_GAP),
            Ask::Thumb => since(self.asked).is_none_or(|d| d >= FORCED_KEYFRAME_GAP),
            Ask::Backup(connected) if seen != connected => false,
            Ask::Join | Ask::Backup(_) if in_flight => false,
            Ask::Backup(_) if join_recent.is_some() && self.reask => {
                self.reask = false;
                self.asked = Some(now);
                self.asked_seen = seen;
                return Plan::Send;
            }
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
        if !matches!(ask, Ask::Lost | Ask::Thumb) {
            self.join_asked = Some(now);
            self.reask = ask == Ask::Join;
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
    x: f64,
    y: f64,
    w: f64,
    h: f64,
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
                id && placed && fit && named
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
        .with_state(app.clone());

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
            [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "public, max-age=3, s-maxage=3")],
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
            watch_stream(app, socket, name, incoming.sdp, wants, incoming.preview.unwrap_or(false), forwarded).await
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

async fn publish(app: App, mut socket: WebSocket, name: String, sdp: String, slots: Vec<(String, RTPCodecType)>, grant: (Option<i64>, Option<i64>)) {
    let count = slots.len();
    let Some(generation) = app.hub.claim(&name, slots).await else {
        let _ = send(&mut socket, Out::error("someone is already live")).await;
        return;
    };
    log::info!("publish {name}: start, {count} slot(s)");

    let dead = Arc::new(Notify::new());
    let peer = match new_peer(&app, Role::Publish, &name, dead.clone(), Arc::new(Notify::new()), Vec::new()).await {
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
            let mid = transceiver.mid().map(|m| m.to_string()).unwrap_or_default();
            let Some((local, slot, camera, keyframes)) = hub.bind(&room, generation, &mid, track.ssrc()).await else {
                log::info!("publish {room}: {kind} packets on mid {mid:?} with no slot for them");
                return;
            };
            log::info!("publish {room}: slot {slot} up ({kind}, mid {mid}, {})", codec.capability.mime_type);
            let vp8 = codec.capability.mime_type.eq_ignore_ascii_case(MIME_TYPE_VP8);

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
                            hub.request_keyframe(&room, slot, Ask::Thumb).await;
                        }
                    }
                });
            }

            while let Ok((mut packet, _)) = track.read_rtp().await {
                packet.header.extension = false;
                packet.header.extensions.clear();
                if vp8 && is_vp8_keyframe(&packet.payload) {
                    keyframes.fetch_add(1, Ordering::Relaxed);
                }
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

    let mut by = "video";
    if send(&mut socket, Out::sdp(answer)).await.is_ok() {
        tokio::spawn(tell_attached(app.clone(), name.clone(), grant));
        let mut shutdown = app.shutdown.clone();
        let viewers = app.hub.viewers_rx(&name).await;
        let mut told = None;
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
    end_session(&app, &name, grant, by).await;
    log::info!("publish {name}: ended");
}

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

async fn end_session(app: &App, name: &str, grant: (Option<i64>, Option<i64>), by: &str) {
    let (Some(session), Some(token)) = grant else { return };
    let url = format!("{}/api/streams/{name}/stop?session={session}&token={token}&by={by}", app.api_url);
    match app.http.post(url).send().await {
        Ok(res) if res.status().is_success() => log::info!("publish {name}: told the api to stop session {session}"),
        Ok(res) if res.status().is_client_error() => {}
        Ok(res) => log::warn!("publish {name}: api answered {} to stop", res.status()),
        Err(e) => log::warn!("publish {name}: api unreachable for stop: {e}"),
    }
}

async fn watch_stream(app: App, mut socket: WebSocket, name: String, sdp: String, wants: (usize, usize), preview: bool, forwarded: Option<IpAddr>) {
    let Some((tracks, mut generation, my_generation, mut slots)) = app.hub.tracks(&name, wants).await else {
        let _ = send(&mut socket, Out::error("not live")).await;
        return;
    };

    let dead = Arc::new(Notify::new());
    let connected = Arc::new(Notify::new());
    let watched = tracks.iter().map(|(slot, _, keyframes)| (*slot, Arc::clone(keyframes))).collect();
    let peer = match new_peer(&app, Role::Watch, &name, dead.clone(), connected.clone(), watched).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("watch {name}: peer setup: {e}");
            let _ = send(&mut socket, Out::error("server error")).await;
            return;
        }
    };

    for (slot, track, _) in tracks {
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
                    hub.request_keyframe(&room, slot, Ask::Lost).await;
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
        let current = slots.borrow_and_update().clone();
        let _ = send(&mut socket, Out::slots(current)).await;
        let viewers = app.hub.viewers_rx(&name).await;
        let mut told = None;
        let mut tick = tokio::time::interval(VIEWERS_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
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
    match app.http.post(url).send().await {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => log::debug!("publish {name}: api answered {} to viewers", res.status()),
        Err(e) => log::debug!("publish {name}: api unreachable for viewers: {e}"),
    }
}

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
    watched: Vec<(usize, Arc<AtomicU64>)>,
) -> anyhow::Result<RTCPeerConnection> {
    let (media, registry) = media_setup(role == Role::Publish)?;

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
    let watched: Arc<[(usize, Arc<AtomicU64>)]> = watched.into();
    let early_hub = hub.clone();
    let early_room = room.clone();
    let early_watched = Arc::clone(&watched);
    let asked_early = AtomicBool::new(false);
    peer.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        if matches!(state, RTCIceConnectionState::Connected | RTCIceConnectionState::Completed)
            && !early_watched.is_empty()
            && !asked_early.swap(true, Ordering::SeqCst)
        {
            let asks = early_watched.iter().map(|(slot, _)| (*slot, Ask::Join)).collect();
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
            connected.notify_one();
        }
        match state {
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => dead.notify_one(),
            RTCPeerConnectionState::Connected
                if !watched.is_empty() && !asked_backup.swap(true, Ordering::SeqCst) =>
            {
                let asks = watched.iter().map(|(slot, seen)| (*slot, Ask::Backup(seen.load(Ordering::Relaxed)))).collect();
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

    #[allow(clippy::type_complexity)]
    async fn bind(&self, name: &str, generation: u64, mid: &str, ssrc: u32) -> Option<(Arc<TrackLocalStaticRTP>, usize, bool, Arc<AtomicU64>)> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| r.generation == generation)?;
        let camera = room.slots.iter().position(|s| s.kind == RTPCodecType::Video);
        let index = room.slots.iter().position(|s| s.mid == mid)?;
        let slot = &mut room.slots[index];
        slot.ssrc = Some(ssrc);
        Some((Arc::clone(&slot.track), index, camera == Some(index), Arc::clone(&slot.keyframes)))
    }

    #[allow(clippy::type_complexity)]
    async fn tracks(
        &self,
        name: &str,
        wants: (usize, usize),
    ) -> Option<(Vec<(usize, Arc<TrackLocalStaticRTP>, Arc<AtomicU64>)>, watch::Receiver<u64>, u64, watch::Receiver<Showing>)> {
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
            .map(|(index, slot)| (index, Arc::clone(&slot.track), Arc::clone(&slot.keyframes)))
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

    async fn request_keyframe(&self, name: &str, slot: usize, ask: Ask) {
        let Some((plan, peer, ssrc, generation)) = self.plan_keyframe(name, None, slot, ask).await else { return };
        match plan {
            Plan::Send => send_pli(&peer, ssrc).await,
            Plan::Skip => {}
            Plan::Trail(wait) => {
                drop(peer);
                let hub = self.clone();
                let name = name.to_owned();
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    if let Some((Plan::Send, peer, ssrc, _)) = hub.plan_keyframe(&name, Some(generation), slot, Ask::Trailing).await {
                        send_pli(&peer, ssrc).await;
                    }
                });
            }
        }
    }

    async fn plan_keyframe(&self, name: &str, generation: Option<u64>, slot: usize, ask: Ask) -> Option<(Plan, Arc<RTCPeerConnection>, u32, u64)> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| generation.is_none_or(|g| g == r.generation))?;
        let peer = room.publisher.as_ref().and_then(Weak::upgrade)?;
        let generation = room.generation;
        let slot = room.slots.get_mut(slot)?;
        let ssrc = slot.ssrc.filter(|_| slot.kind == RTPCodecType::Video)?;
        let plan = slot.asks.decide(ask, Instant::now(), slot.keyframes.load(Ordering::Relaxed));
        Some((plan, peer, ssrc, generation))
    }

    async fn request_keyframes(&self, name: &str, asks: Vec<(usize, Ask)>) {
        for (slot, ask) in asks {
            self.request_keyframe(name, slot, ask).await;
        }
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
                    keyframes: Arc::default(),
                    asks: KeyframeAsks::default(),
                }
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

fn offer_slots(sdp: &str) -> Option<Vec<(String, RTPCodecType)>> {
    media_sections(sdp)
        .into_iter()
        .filter(|section| section.sends && section.kind.is_some())
        .map(|section| Some((section.mid?, section.kind?)))
        .collect()
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

    async fn live_room(hub: &Hub, name: &str) -> u64 {
        hub.claim(name, vec![("0".to_owned(), RTPCodecType::Video)]).await.expect("the name is free")
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
    fn a_backup_asks_again_when_the_early_keyframe_went_before_connect() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(150), 1), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(160), 1), Plan::Skip);
    }

    #[test]
    fn a_backup_waits_for_a_keyframe_on_its_way() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(0), t + ms(150), 0), Plan::Skip);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(150), 1), Plan::Send);
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
        assert!(!asks.reask);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(100), 1), Plan::Trail(ms(200)));
    }

    #[test]
    fn one_early_ask_gets_one_reask_and_later_backups_trail() {
        let t = Instant::now();
        let mut asks = KeyframeAsks::default();
        assert_eq!(asks.decide(Ask::Join, t, 0), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(1), t + ms(100), 1), Plan::Send);
        assert_eq!(asks.decide(Ask::Backup(2), t + ms(200), 2), Plan::Trail(ms(100)));
        assert_eq!(asks.decide(Ask::Backup(2), t + ms(250), 2), Plan::Skip);
        assert_eq!(asks.decide(Ask::Trailing, t + ms(300), 2), Plan::Send);
        assert!(!asks.reask);
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
}
