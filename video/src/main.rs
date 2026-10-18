//! One camera in. Copies the packets out to whoever is watching.
//!
//! Websocket on :7880/ws. The browser sends one text frame:
//!   {"role":"publish","name":"billy","sdp":"<offer sdp>"}
//!   {"role":"watch",  "name":"billy","sdp":"<offer sdp>"}
//! We answer {"sdp":"<answer sdp>"} or {"error":"..."} and keep the socket
//! open. Closing it hangs up. Watchers also get {"event":"ended"} when the
//! publisher leaves. All media rides one UDP port (7882).
//!
//! Also on the same port: GET /live (names connected right now) and GET /health.
//! Env: PUBLIC_IP, WS_PORT (7880), UDP_PORT (7882), DUMMY_PASSWORD, DUMMY_PREFIX.
//!
//! Names starting with DUMMY_PREFIX ("dummy-") are reserved for the fake streams
//! of `video dummy` (see dummy.rs): publishing one needs the matching password.

mod dummy;
mod media;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
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

use crate::media::media_setup;

/// How long a watcher waits for a publisher that just started to finish setting up.
const TRACK_WAIT: Duration = Duration::from_secs(8);
/// Forwarded keyframe requests are rate limited to one per this gap, per stream.
const KEYFRAME_GAP: Duration = Duration::from_millis(1500);
/// The browser has this long to send its one message, and we have this long to answer.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Biggest offer we accept. A real one is 5-15 KB.
const MAX_SDP_BYTES: usize = 32 * 1024;
const MAX_MEDIA_LINES: usize = 4;
const UDP_BUFFER_BYTES: usize = 4 << 20;

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
}

#[derive(Clone, Default)]
struct Hub {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
}

struct Room {
    /// Bumps every time a publisher starts or stops. Watchers leave when it changes.
    generation: u64,
    generation_tx: watch::Sender<u64>,
    expected_tracks: usize,
    tracks: Vec<Arc<TrackLocalStaticRTP>>,
    tracks_changed: Arc<Notify>,
    publisher: Option<Weak<RTCPeerConnection>>,
    video_ssrc: Option<u32>,
    last_keyframe: Option<Instant>,
}

#[derive(Deserialize)]
struct In {
    role: String,
    name: String,
    sdp: String,
    /// Only needed to publish a reserved (dummy) name.
    #[serde(default)]
    password: Option<String>,
}

#[derive(Serialize, Default)]
struct Out {
    #[serde(skip_serializing_if = "Option::is_none")]
    sdp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<String>,
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

    let mux = UDPMuxDefault::new(UDPMuxParams::new(media_socket(udp_port)?));
    log::info!("media on udp {udp_port}, advertising {public_ip}");
    if public_ip == "127.0.0.1" {
        log::warn!("PUBLIC_IP is 127.0.0.1. set it to the ip people type in the browser");
    }

    let dummy_prefix = std::env::var("DUMMY_PREFIX").unwrap_or_else(|_| "dummy-".into());
    let dummy_password = std::env::var("DUMMY_PASSWORD").ok().filter(|p| !p.trim().is_empty());
    match &dummy_password {
        Some(_) => log::info!("names starting with {dummy_prefix:?} need the dummy password"),
        None => log::info!("names starting with {dummy_prefix:?} are reserved (no DUMMY_PASSWORD set)"),
    }

    let (shutdown_tx, shutdown) = watch::channel(false);
    let app = App {
        hub: Hub::default(),
        public_ip,
        mux,
        shutdown,
        dummy_prefix,
        dummy_password,
    };

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/live", get(live))
        .route("/ws", get(ws))
        .with_state(app.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], ws_port));
    log::info!("websocket on {addr}/ws");
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // On SIGTERM every room ends, every socket closes, and we exit right away
    // instead of being killed 10s later with viewers mid-frame.
    let hub = app.hub.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            wait_for_signal().await;
            log::info!("shutting down");
            hub.end_all().await;
            let _ = shutdown_tx.send(true);
        })
        .await?;
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
/// to many watchers does not drop packets.
fn media_socket(port: u16) -> anyhow::Result<tokio::net::UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    let _ = socket.set_send_buffer_size(UDP_BUFFER_BYTES);
    let _ = socket.set_recv_buffer_size(UDP_BUFFER_BYTES);
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

async fn ws(State(app): State<App>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(2 * MAX_SDP_BYTES)
        .max_frame_size(2 * MAX_SDP_BYTES)
        .on_upgrade(move |socket| handle(app, socket))
}

async fn handle(app: App, mut socket: WebSocket) {
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

    // Check the offer before touching any room or building a peer.
    let media_lines = count_sending_media_lines(&incoming.sdp);
    if incoming.sdp.len() > MAX_SDP_BYTES
        || media_lines > MAX_MEDIA_LINES
        || RTCSessionDescription::offer(incoming.sdp.clone()).is_err()
    {
        let _ = send(&mut socket, Out::error("bad offer")).await;
        return;
    }

    match incoming.role.as_str() {
        "publish" => publish(app, socket, name, incoming.sdp, media_lines).await,
        "watch" => watch_stream(app, socket, name, incoming.sdp).await,
        _ => {
            let _ = send(&mut socket, Out::error("role must be publish or watch")).await;
        }
    }
}

async fn publish(app: App, mut socket: WebSocket, name: String, sdp: String, expected: usize) {
    let Some(generation) = app.hub.claim(&name, expected.max(1)).await else {
        let _ = send(&mut socket, Out::error("someone is already live")).await;
        return;
    };
    log::info!("publish {name}: start, {expected} track(s)");

    let dead = Arc::new(Notify::new());
    let peer = match new_peer(&app, Role::Publish, &name, dead.clone()).await {
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
    peer.on_track(Box::new(move |track, _, _| {
        let hub = hub.clone();
        let room = room.clone();
        tokio::spawn(async move {
            let kind = track.kind();
            let codec = track.codec().capability;
            let video_ssrc = (kind == RTPCodecType::Video).then(|| track.ssrc());
            let local = Arc::new(TrackLocalStaticRTP::new(
                codec.clone(),
                kind.to_string(),
                room.clone(),
            ));
            if !hub.add_track(&room, generation, Arc::clone(&local), video_ssrc).await {
                return;
            }
            log::info!("publish {room}: {kind} up ({})", codec.mime_type);

            // Copy packets to every watcher bound to this track. A failing
            // watcher must not stop the stream for the others. Header
            // extensions carry ids from the publisher's session, so drop them.
            while let Ok((mut packet, _)) = track.read_rtp().await {
                packet.header.extension = false;
                packet.header.extensions.clear();
                let _ = local.write_rtp(&packet).await;
            }
            log::info!("publish {room}: {kind} done");
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
        let mut shutdown = app.shutdown.clone();
        tokio::select! {
            _ = wait_until_socket_closes(&mut socket) => log::info!("publish {name}: socket closed"),
            _ = dead.notified() => log::info!("publish {name}: peer gone"),
            _ = async { let _ = shutdown.wait_for(|s| *s).await; } => {
                let _ = send(&mut socket, Out::event("ended")).await;
            }
        }
    }

    let _ = peer.close().await;
    app.hub.clear(&name).await;
    log::info!("publish {name}: ended");
}

async fn watch_stream(app: App, mut socket: WebSocket, name: String, sdp: String) {
    let Some((tracks, mut generation, my_generation)) = app.hub.wait_for_tracks(&name).await
    else {
        let _ = send(&mut socket, Out::error("not live")).await;
        return;
    };

    let dead = Arc::new(Notify::new());
    let peer = match new_peer(&app, Role::Watch, &name, dead.clone()).await {
        Ok(peer) => Arc::new(peer),
        Err(e) => {
            log::error!("watch {name}: peer setup: {e}");
            let _ = send(&mut socket, Out::error("server error")).await;
            return;
        }
    };

    for track in tracks {
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

        // Watchers ask for keyframes when they lose the picture. Pass that on
        // to the publisher, rate limited, instead of dropping it.
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
                    hub.request_keyframe(&room, false).await;
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

    if send(&mut socket, Out::sdp(answer)).await.is_ok() {
        log::info!("watch {name}: joined");
        let mut shutdown = app.shutdown.clone();
        tokio::select! {
            _ = wait_until_socket_closes(&mut socket) => log::info!("watch {name}: left"),
            _ = async { let _ = generation.wait_for(|g| *g != my_generation).await; } => {
                log::info!("watch {name}: stream ended");
                let _ = send(&mut socket, Out::event("ended")).await;
                let _ = socket.send(Message::Close(None)).await;
            }
            _ = async { let _ = shutdown.wait_for(|s| *s).await; } => {
                let _ = send(&mut socket, Out::event("ended")).await;
            }
            _ = dead.notified() => log::info!("watch {name}: peer gone"),
        }
    }

    let _ = peer.close().await;
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
        match state {
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => dead.notify_one(),
            // A new watcher needs a keyframe right now, not whenever the next
            // one happens to come. Once per watcher, ignoring the rate limit.
            RTCPeerConnectionState::Connected
                if is_watcher && !asked_keyframe.swap(true, Ordering::SeqCst) =>
            {
                let hub = hub.clone();
                let room = room.clone();
                tokio::spawn(async move { hub.request_keyframe(&room, true).await });
            }
            _ => {}
        }
        Box::pin(async {})
    }));

    Ok(peer)
}

impl Hub {
    /// Take the name. Returns the new generation, or None if someone has it.
    async fn claim(&self, name: &str, expected_tracks: usize) -> Option<u64> {
        let mut rooms = self.rooms.lock().await;
        if rooms.contains_key(name) {
            return None;
        }
        let mut room = Room::new();
        room.expected_tracks = expected_tracks;
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

    /// Add a publisher track. False if that publisher's room is gone already.
    async fn add_track(
        &self,
        name: &str,
        generation: u64,
        track: Arc<TrackLocalStaticRTP>,
        video_ssrc: Option<u32>,
    ) -> bool {
        let mut rooms = self.rooms.lock().await;
        let Some(room) = rooms.get_mut(name).filter(|r| r.generation == generation) else {
            return false;
        };
        room.tracks.push(track);
        if video_ssrc.is_some() {
            room.video_ssrc = video_ssrc;
        }
        room.tracks_changed.notify_waiters();
        true
    }

    /// The live room's tracks, a receiver that changes when the stream ends,
    /// and the generation those tracks belong to. Waits a little if the
    /// publisher is still setting up. None when nobody is live.
    async fn wait_for_tracks(
        &self,
        name: &str,
    ) -> Option<(Vec<Arc<TrackLocalStaticRTP>>, watch::Receiver<u64>, u64)> {
        let started = Instant::now();
        loop {
            let (expected, tracks, changed, receiver, generation) = {
                let rooms = self.rooms.lock().await;
                let room = rooms.get(name)?;
                (
                    room.expected_tracks,
                    room.tracks.clone(),
                    room.tracks_changed.clone(),
                    room.generation_tx.subscribe(),
                    room.generation,
                )
            };
            if tracks.len() >= expected {
                return Some((tracks, receiver, generation));
            }
            if started.elapsed() > TRACK_WAIT {
                return (!tracks.is_empty()).then_some((tracks, receiver, generation));
            }
            let wakeup = changed.notified();
            tokio::pin!(wakeup);
            tokio::select! {
                _ = &mut wakeup => {}
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        }
    }

    async fn request_keyframe(&self, name: &str, force: bool) {
        let (peer, ssrc) = {
            let mut rooms = self.rooms.lock().await;
            let Some(room) = rooms.get_mut(name) else { return };
            let now = Instant::now();
            let recently = room
                .last_keyframe
                .is_some_and(|t| now.duration_since(t) < KEYFRAME_GAP);
            if recently && !force {
                return;
            }
            match (&room.publisher, room.video_ssrc) {
                (Some(peer), Some(ssrc)) => {
                    room.last_keyframe = Some(now);
                    (peer.upgrade(), ssrc)
                }
                _ => return,
            }
        };
        if let Some(peer) = peer {
            let _ = peer
                .write_rtcp(&[Box::new(PictureLossIndication {
                    sender_ssrc: 0,
                    media_ssrc: ssrc,
                })])
                .await;
        }
    }

    /// The publisher left. Watchers see the generation change and leave too.
    async fn clear(&self, name: &str) {
        let mut rooms = self.rooms.lock().await;
        if let Some(mut room) = rooms.remove(name) {
            room.bump();
            room.tracks_changed.notify_waiters();
        }
    }

    async fn end_all(&self) {
        let mut rooms = self.rooms.lock().await;
        for (_, mut room) in rooms.drain() {
            room.bump();
            room.tracks_changed.notify_waiters();
        }
    }

    async fn live_names(&self) -> Vec<String> {
        let rooms = self.rooms.lock().await;
        let mut names: Vec<String> = rooms.keys().cloned().collect();
        names.sort();
        names
    }
}

impl Room {
    fn new() -> Self {
        let (generation_tx, _) = watch::channel(0);
        Self {
            generation: 0,
            generation_tx,
            expected_tracks: 1,
            tracks: Vec::new(),
            tracks_changed: Arc::new(Notify::new()),
            publisher: None,
            video_ssrc: None,
            last_keyframe: None,
        }
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
}

fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// How many tracks the publisher is actually sending: audio/video m= sections
/// that are not recvonly or inactive.
fn count_sending_media_lines(sdp: &str) -> usize {
    let mut count = 0;
    let mut sending = false;
    for line in sdp.lines() {
        let line = line.trim_end();
        if line.starts_with("m=") {
            count += sending as usize;
            sending = line.starts_with("m=audio") || line.starts_with("m=video");
        } else if line == "a=recvonly" || line == "a=inactive" {
            sending = false;
        }
    }
    count + sending as usize
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
