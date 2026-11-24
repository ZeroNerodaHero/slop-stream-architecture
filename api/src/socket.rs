use std::time::Duration;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use serde::Serialize;

pub(crate) const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_FRAME_BYTES: usize = 8 * 1024;
pub(crate) const PING_EVERY: Duration = Duration::from_secs(30);
pub(crate) const IDLE_LIMIT: Duration = Duration::from_secs(90);
pub(crate) const DRAIN_LIMIT: Duration = Duration::from_secs(2);
pub(crate) const SEND_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const READ_BLOCK_MS: usize = 5000;

pub(crate) async fn send<T: Serialize>(socket: &mut WebSocket, out: &T) -> Result<(), axum::Error> {
    send_within(socket, out, SEND_TIMEOUT).await
}

pub(crate) async fn send_within<T: Serialize>(socket: &mut WebSocket, out: &T, budget: Duration) -> Result<(), axum::Error> {
    send_frame_within(socket, frame_of(out), budget).await
}

pub(crate) fn frame_of<T: Serialize>(out: &T) -> Utf8Bytes {
    serde_json::to_string(out).unwrap_or_default().into()
}

pub(crate) async fn send_frame(socket: &mut WebSocket, frame: Utf8Bytes) -> Result<(), axum::Error> {
    send_frame_within(socket, frame, SEND_TIMEOUT).await
}

async fn send_frame_within(socket: &mut WebSocket, frame: Utf8Bytes, budget: Duration) -> Result<(), axum::Error> {
    match tokio::time::timeout(budget, socket.send(Message::Text(frame))).await {
        Ok(sent) => sent,
        Err(_) => Err(axum::Error::new("the peer stopped reading")),
    }
}

pub(crate) async fn first_text(socket: &mut WebSocket) -> Option<String> {
    match tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => Some(text.to_string()),
        _ => None,
    }
}

pub(crate) fn blocking_config(block_ms: usize) -> redis::AsyncConnectionConfig {
    redis::AsyncConnectionConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(Duration::from_millis(block_ms as u64 + 2000)))
}

pub(crate) fn id_parts(id: &str) -> (u64, u64) {
    let mut parts = id.splitn(2, '-');
    let ms = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let seq = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (ms, seq)
}
