//! The websocket plumbing `chat.rs` (the rooms) and `events.rs` (the gateway) share: the
//! limits, a send with a budget, the first frame with a timeout, the redis connection a
//! blocking tail needs. Lifted out of the chat with no change of behaviour; see docs/status.md.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use serde::Serialize;

/// The browser has this long to send its first frame (the hello).
pub(crate) const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Message and frame cap, set on the upgrade so axum refuses a bigger one before any parser sees it.
pub(crate) const MAX_FRAME_BYTES: usize = 8 * 1024;
/// A ping this often. A socket that sent nothing back (pong, text, anything)
/// for IDLE_LIMIT is a vanished peer and is dropped, so it stops being counted.
pub(crate) const PING_EVERY: Duration = Duration::from_secs(30);
pub(crate) const IDLE_LIMIT: Duration = Duration::from_secs(90);
/// After SIGTERM: how long `run` waits for the sockets to say goodbye.
pub(crate) const DRAIN_LIMIT: Duration = Duration::from_secs(2);
/// A frame that cannot be written in this long is a peer that stopped reading (a frozen
/// tab, a suspended laptop): dropped, like one that stopped answering pings. Otherwise
/// the handler would sit in the write for as long as the kernel keeps the socket.
pub(crate) const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// How long one XREAD waits for a new entry before coming back empty.
pub(crate) const READ_BLOCK_MS: usize = 5000;

pub(crate) async fn send<T: Serialize>(socket: &mut WebSocket, out: &T) -> Result<(), axum::Error> {
    send_within(socket, out, SEND_TIMEOUT).await
}

pub(crate) async fn send_within<T: Serialize>(socket: &mut WebSocket, out: &T, budget: Duration) -> Result<(), axum::Error> {
    let text = serde_json::to_string(out).unwrap_or_default();
    match tokio::time::timeout(budget, socket.send(Message::Text(text.into()))).await {
        Ok(sent) => sent,
        Err(_) => Err(axum::Error::new("the peer stopped reading")),
    }
}

/// The first text frame, within HELLO_TIMEOUT. None: nothing came in time, or it was not text.
pub(crate) async fn first_text(socket: &mut WebSocket) -> Option<String> {
    match tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => Some(text.to_string()),
        _ => None,
    }
}

/// A connection of its own for `XREAD BLOCK`: it would stall the shared multiplexed one, and
/// the default 500ms response timeout would cut every block short.
pub(crate) fn blocking_config(block_ms: usize) -> redis::AsyncConnectionConfig {
    redis::AsyncConnectionConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(Duration::from_millis(block_ms as u64 + 2000)))
}

/// "1729000000000-3" -> (1729000000000, 3). Orders the same way redis does.
pub(crate) fn id_parts(id: &str) -> (u64, u64) {
    let mut parts = id.splitn(2, '-');
    let ms = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let seq = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (ms, seq)
}
