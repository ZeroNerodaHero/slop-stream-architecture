//! One camera in. Copies the packets out to whoever is watching.
//!
//! Websocket on :7880/ws. The browser sends one text frame:
//!   {"role":"publish","name":"billy","sdp":"<offer sdp>","session":1,"token":2}
//!   {"role":"watch",  "name":"billy","sdp":"<offer sdp>"}
//! We answer {"sdp":"<answer sdp>"} or {"error":"..."} and keep the socket
//! open. Closing it hangs up. Watchers also get {"event":"ended"} when the
//! publisher leaves. All media rides one UDP port (7882).
//!
//! A publisher's session and token are what the api's go-live handed out; we
//! ask the api (its heartbeat route) whether that session is open for that
//! name, so a stranger who skips the api cannot publish under a claimed name.
//!
//! Also on the same port: GET /live (names connected right now) and GET /health
//! ({ok, up_secs, build, live}; the api folds it into /api/health).
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
/// Even a forced request (a joining watcher, the thumbnail) waits this long after
/// the last one: a burst of joins then shares one keyframe instead of one each.
const FORCED_KEYFRAME_GAP: Duration = Duration::from_millis(300);
/// The browser has this long to send its one message, and we have this long to answer.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The api gets this long to say whether a publisher's session is real.
const API_TIMEOUT: Duration = Duration::from_millis(1500);
/// After SIGTERM, how long the open sockets get to send their `ended` before we exit.
const SHUTDOWN_FLUSH: Duration = Duration::from_secs(2);
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
    /// A publisher's go-live grant from the api. Watchers send neither.
    #[serde(default)]
    session: Option<i64>,
    #[serde(default)]
    token: Option<i64>,
    /// Also needed to publish a reserved (dummy) name.
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
    }))
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

    // Check the offer before touching any room or building a peer. Every m=
    // section costs a transceiver and an interceptor chain, recvonly or not.
    let media_lines = count_sending_media_lines(&incoming.sdp);
    if incoming.sdp.len() > MAX_SDP_BYTES
        || incoming.sdp.lines().filter(|l| l.starts_with("m=")).count() > MAX_MEDIA_LINES
        || RTCSessionDescription::offer(incoming.sdp.clone()).is_err()
    {
        let _ = send(&mut socket, Out::error("bad offer")).await;
        return;
    }

    match incoming.role.as_str() {
        "publish" => {
            // Last, because it costs a round trip to the api.
            if let Err(e) = owns_stream(&app, &name, incoming.session, incoming.token).await {
                let _ = send(&mut socket, Out::error(e)).await;
                return;
            }
            publish(app, socket, name, incoming.sdp, media_lines).await
        }
        "watch" => watch_stream(app, socket, name, incoming.sdp).await,
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
    let thumbs_on = app.thumbs;
    peer.on_track(Box::new(move |track, _, _| {
        let hub = hub.clone();
        let room = room.clone();
        tokio::spawn(async move {
            let kind = track.kind();
            let codec = track.codec();
            let video_ssrc = (kind == RTPCodecType::Video).then(|| track.ssrc());
            let local = Arc::new(TrackLocalStaticRTP::new(
                codec.capability.clone(),
                kind.to_string(),
                room.clone(),
            ));
            let Some(first_video) = hub.add_track(&room, generation, Arc::clone(&local), video_ssrc).await else {
                return;
            };
            log::info!("publish {room}: {kind} up ({})", codec.capability.mime_type);

            // The stream's video track also feeds a small ffmpeg that makes the
            // thumbnail. A second video track (an offer can carry one) shares
            // neither the picture nor the keyframe requests.
            let mut tap = None;
            if thumbs_on && first_video {
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
                        hub.request_keyframe(&room, true).await;
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

    /// Add a publisher track. None if that publisher's room is gone already;
    /// otherwise whether this is the room's first video track, the one keyframe
    /// requests go to and the thumbnail is made from.
    async fn add_track(
        &self,
        name: &str,
        generation: u64,
        track: Arc<TrackLocalStaticRTP>,
        video_ssrc: Option<u32>,
    ) -> Option<bool> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(name).filter(|r| r.generation == generation)?;
        room.tracks.push(track);
        let first_video = video_ssrc.is_some() && room.video_ssrc.is_none();
        if first_video {
            room.video_ssrc = video_ssrc;
        }
        room.tracks_changed.notify_waiters();
        Some(first_video)
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
            let gap = if force { FORCED_KEYFRAME_GAP } else { KEYFRAME_GAP };
            if room.last_keyframe.is_some_and(|t| now.duration_since(t) < gap) {
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

pub(crate) fn valid_name(name: &str) -> bool {
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
