use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use serde::Serialize;
use tokio::time::{Instant, Interval, MissedTickBehavior};

pub(crate) const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_FRAME_BYTES: usize = 8 * 1024;
pub(crate) const PING_EVERY: Duration = Duration::from_secs(20);
pub(crate) const IDLE_LIMIT: Duration = Duration::from_secs(45);
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

pub(crate) async fn ping(socket: &mut WebSocket) -> bool {
    matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Ping(Bytes::new()))).await, Ok(Ok(())))
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

pub(crate) fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Beat {
    Ping,
    Silent,
}

pub(crate) struct Heartbeat {
    ping: Interval,
    heard: Instant,
    idle: Duration,
}

impl Heartbeat {
    pub(crate) fn new(every: Duration, idle: Duration) -> Self {
        let mut ping = tokio::time::interval_at(Instant::now() + every, every);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Heartbeat { ping, heard: Instant::now(), idle }
    }

    pub(crate) fn standard() -> Self {
        Heartbeat::new(PING_EVERY, IDLE_LIMIT)
    }

    pub(crate) fn heard(&mut self) {
        self.heard = Instant::now();
    }

    pub(crate) async fn next(&mut self) -> Beat {
        let deadline = self.heard + self.idle;
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => Beat::Silent,
            _ = self.ping.tick() => Beat::Ping,
        }
    }
}

#[derive(Clone)]
pub(crate) struct IpSlots {
    held: Arc<Mutex<HashMap<String, usize>>>,
    limit: usize,
}

pub(crate) struct IpSlot {
    held: Arc<Mutex<HashMap<String, usize>>>,
    ip: String,
}

impl IpSlots {
    pub(crate) fn new(limit: usize) -> Self {
        IpSlots { held: Arc::default(), limit }
    }

    pub(crate) fn take(&self, ip: String) -> Option<IpSlot> {
        let mut m = locked(&self.held);
        let n = m.entry(ip.clone()).or_insert(0);
        if *n >= self.limit {
            if *n == 0 {
                m.remove(&ip);
            }
            return None;
        }
        *n += 1;
        Some(IpSlot { held: self.held.clone(), ip })
    }

    pub(crate) fn held(&self, ip: &str) -> usize {
        locked(&self.held).get(ip).copied().unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn addresses(&self) -> usize {
        locked(&self.held).len()
    }
}

impl Drop for IpSlot {
    fn drop(&mut self) {
        let mut m = locked(&self.held);
        if let Some(n) = m.get_mut(&self.ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_holds_at_most_its_sockets_and_gets_them_back() {
        let slots = IpSlots::new(3);
        let held: Vec<IpSlot> = (0..3).map(|_| slots.take("1.2.3.4".into()).unwrap()).collect();
        assert!(slots.take("1.2.3.4".into()).is_none());
        assert!(slots.take("5.6.7.8".into()).is_some());
        assert_eq!(slots.held("1.2.3.4"), 3);
        drop(held);
        assert_eq!(slots.held("1.2.3.4"), 0);
        assert_eq!(slots.addresses(), 0);
        assert!(slots.take("1.2.3.4".into()).is_some());
    }

    #[test]
    fn a_slot_comes_back_when_its_task_panics() {
        let slots = IpSlots::new(1);
        let mine = slots.clone();
        let died = std::thread::spawn(move || {
            let _slot = mine.take("1.2.3.4".into()).unwrap();
            panic!("a handler fell over");
        })
        .join();
        assert!(died.is_err());
        assert_eq!(slots.held("1.2.3.4"), 0);
        assert!(slots.take("1.2.3.4".into()).is_some());
    }

    #[test]
    fn a_zero_limit_leaves_no_entry_behind() {
        let slots = IpSlots::new(0);
        for _ in 0..1000 {
            assert!(slots.take("1.2.3.4".into()).is_none());
        }
        assert_eq!(slots.addresses(), 0);
    }

    #[test]
    fn the_heartbeat_is_twenty_and_forty_five() {
        assert_eq!(PING_EVERY, Duration::from_secs(20));
        assert_eq!(IDLE_LIMIT, Duration::from_secs(45));
        const { assert!(IDLE_LIMIT.as_secs() > 2 * PING_EVERY.as_secs()) };
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_peer_is_cut_at_forty_five_seconds_not_sixty() {
        let started = Instant::now();
        let mut beat = Heartbeat::standard();
        assert_eq!(beat.next().await, Beat::Ping);
        assert_eq!(started.elapsed(), Duration::from_secs(20));
        assert_eq!(beat.next().await, Beat::Ping);
        assert_eq!(started.elapsed(), Duration::from_secs(40));
        assert_eq!(beat.next().await, Beat::Silent);
        assert_eq!(started.elapsed(), Duration::from_secs(45));
    }

    #[tokio::test(start_paused = true)]
    async fn a_peer_that_answers_stays() {
        let started = Instant::now();
        let mut beat = Heartbeat::standard();
        for n in 1..=50u64 {
            assert_eq!(beat.next().await, Beat::Ping);
            assert_eq!(started.elapsed(), Duration::from_secs(20 * n));
            beat.heard();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_peer_that_goes_quiet_after_talking_is_cut_forty_five_after_its_last_word() {
        let started = Instant::now();
        let mut beat = Heartbeat::standard();
        tokio::time::sleep(Duration::from_secs(30)).await;
        beat.heard();
        assert_eq!(beat.next().await, Beat::Ping);
        assert_eq!(started.elapsed(), Duration::from_secs(30));
        assert_eq!(beat.next().await, Beat::Ping);
        assert_eq!(started.elapsed(), Duration::from_secs(50));
        assert_eq!(beat.next().await, Beat::Ping);
        assert_eq!(started.elapsed(), Duration::from_secs(70));
        assert_eq!(beat.next().await, Beat::Silent);
        assert_eq!(started.elapsed(), Duration::from_secs(75));
    }
}
