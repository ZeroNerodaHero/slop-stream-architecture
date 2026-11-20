//! `video voice`: a small voice sfu, same binary. a spike: there is no grant yet, so it
//! turns everyone away unless VOICE_DEV_OPEN=1.
//!
//! websocket on :7881/ws (VOICE_WS_PORT), media on one udp port, 7883 (VOICE_UDP_PORT).
//! `GET /health` on the same port says {ok, rooms, peers}. the first frame, within 10s:
//!   {"role":"voice","room":"<server>/<channel>","user":"<name>","sdp":"<offer>"}
//! the offer is audio only: m-line 0 is your mic and must send, the rest (15 at most)
//! are recvonly and are where you hear the others. we answer {"sdp":"<answer>"} or
//! {"error":"..."}, then send
//!   {"event":"seats","seats":[{"seat":0,"user":"a","line":1},...]}
//! right after the answer and on every join and leave.
//!
//! a room has 16 seats and each person takes the lowest free one. your own seat is not
//! in the list and has no m-line: seat N is heard on m-line N+1 if N is below your seat
//! and on m-line N if it is above (`line` says which, so a page need not work it out).
//! joins and leaves only swap the track behind those m-lines (replace_track), so nobody
//! renegotiates. an empty seat's m-line gets an idle track nobody writes to: webrtc-rs
//! cannot put a track back on a sender once it was replaced with none.
//!
//! closing the socket, or the peer going failed/closed (the ice timeout), frees the seat.
//! at most 4 voice peers per address, and /ws is rate limited per address like the stream's.

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
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
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

#[derive(Clone)]
struct Voice {
    public_ip: String,
    mux: Arc<UDPMuxDefault>,
    open: bool,
    state: Arc<Mutex<Rooms>>,
    next_id: Arc<AtomicU64>,
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

#[derive(Deserialize)]
struct Join {
    role: String,
    room: String,
    user: String,
    sdp: String,
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

    if public_ip.parse::<Ipv4Addr>().is_err() {
        anyhow::bail!("PUBLIC_IP={public_ip:?} is not an ipv4 address");
    }
    let mux = UDPMuxDefault::new(UDPMuxParams::new(media_socket(udp_port)?));
    log::info!("voice: media on udp {udp_port}, advertising {public_ip}");
    if open {
        log::warn!("voice: VOICE_DEV_OPEN=1, anyone may join any room");
    } else {
        log::info!("voice: closed (no grant yet; VOICE_DEV_OPEN=1 opens it)");
    }

    let voice = Voice {
        public_ip,
        mux,
        open,
        state: Arc::default(),
        next_id: Arc::default(),
    };
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
    fn sit(&self, held: &mut Held, name: &str, user: &str) -> Option<(usize, Arc<TrackLocalStaticRTP>, watch::Receiver<Snapshot>)> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let room = state.rooms.entry(name.to_owned()).or_insert_with(|| Room {
            seats: Seats::new(),
            tx: watch::Sender::new(Arc::new(Vec::new())),
        });
        let mic = Arc::new(TrackLocalStaticRTP::new(opus_voice_capability(), format!("mic{id}"), "voice".to_owned()));
        let Some(seat) = room.seats.take(Sitter { user: user.to_owned(), id, mic: mic.clone() }) else {
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
    // no grant in p0: closed unless a dev opened it
    if !voice.open {
        return refuse(&mut socket, "voice is not open").await;
    }
    let Ok(join) = serde_json::from_str::<Join>(&text) else {
        return refuse(&mut socket, "bad json").await;
    };
    if join.role != "voice" || !valid_room(&join.room) || !valid_user(&join.user) {
        return refuse(&mut socket, "bad join").await;
    }
    let Some(offer) = check_offer(&join.sdp) else {
        return refuse(&mut socket, "bad offer").await;
    };
    let Some(mut held) = voice.hold_ip(ip) else {
        return refuse(&mut socket, "too many voice peers from this address").await;
    };
    let Some((seat, mic, mut seats)) = voice.sit(&mut held, &join.room, &join.user) else {
        return refuse(&mut socket, "room full").await;
    };
    let tag = format!("voice {} seat {seat}", join.room);
    log::info!("{tag}: {} joined", join.user);
    talk(&voice, &mut socket, &tag, join.sdp, &offer, seat, mic, &mut seats).await;
    log::info!("{tag}: {} left", join.user);
    drop(held);
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
) {
    let dead = Arc::new(Notify::new());
    let peer = match voice_peer(voice, tag, dead.clone()).await {
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
                    log::info!("{tag}: peer gone");
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

/// the stream's ice settings (main.rs new_peer) with the voice codecs
async fn voice_peer(voice: &Voice, tag: &str, dead: Arc<Notify>) -> anyhow::Result<RTCPeerConnection> {
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
    let tag = tag.to_owned();
    peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        log::info!("{tag}: peer {state}");
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
