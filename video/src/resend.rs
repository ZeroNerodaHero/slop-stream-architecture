use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use webrtc::interceptor::stream_info::StreamInfo;
use webrtc::interceptor::{Attributes, Interceptor, InterceptorBuilder, RTCPReader, RTCPWriter, RTPReader, RTPWriter};
use webrtc::rtcp::transport_feedbacks::transport_layer_nack::TransportLayerNack;
use webrtc::rtp::packet::Packet;

const RING: u16 = 512;

fn newer(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

#[derive(Default)]
struct Ring {
    packets: Vec<Option<Packet>>,
    last: Option<u16>,
    floor: Option<u16>,
}

impl Ring {
    fn add(&mut self, packet: &Packet) {
        if self.packets.is_empty() {
            self.packets = vec![None; RING as usize];
        }
        let seq = packet.header.sequence_number;
        if self.last.is_some_and(|last| !newer(seq, last)) {
            return;
        }
        self.packets[(seq % RING) as usize] = Some(packet.clone());
        self.last = Some(seq);
        if self.floor.is_some_and(|f| seq.wrapping_sub(f) >= RING) {
            self.floor = None;
        }
    }

    fn get(&self, seq: u16) -> Option<&Packet> {
        let last = self.last?;
        if newer(seq, last) || last.wrapping_sub(seq) >= RING || self.floor.is_some_and(|f| newer(f, seq)) {
            return None;
        }
        self.packets[(seq % RING) as usize].as_ref().filter(|p| p.header.sequence_number == seq)
    }
}

struct Stream {
    ring: Mutex<Ring>,
    next: Arc<dyn RTPWriter + Send + Sync>,
}

#[async_trait]
impl RTPWriter for Stream {
    async fn write(&self, packet: &Packet, attributes: &Attributes) -> Result<usize, webrtc::interceptor::Error> {
        self.ring.lock().unwrap_or_else(|e| e.into_inner()).add(packet);
        self.next.write(packet, attributes).await
    }
}

#[derive(Default)]
pub struct Resend {
    streams: Mutex<HashMap<u32, Arc<Stream>>>,
}

impl Resend {
    pub fn floor(&self, ssrc: u32, seq: u16) {
        if let Some(stream) = self.streams.lock().unwrap_or_else(|e| e.into_inner()).get(&ssrc) {
            stream.ring.lock().unwrap_or_else(|e| e.into_inner()).floor = Some(seq);
        }
    }

    fn stream(&self, ssrc: u32) -> Option<Arc<Stream>> {
        self.streams.lock().unwrap_or_else(|e| e.into_inner()).get(&ssrc).cloned()
    }

    async fn answer(&self, nack: &TransportLayerNack) {
        let Some(stream) = self.stream(nack.media_ssrc) else { return };
        let packets: Vec<Packet> = {
            let ring = stream.ring.lock().unwrap_or_else(|e| e.into_inner());
            nack.nacks.iter().flat_map(|pair| pair.into_iter()).filter_map(|seq| ring.get(seq).cloned()).collect()
        };
        let attributes = Attributes::new();
        for packet in &packets {
            if let Err(e) = stream.next.write(packet, &attributes).await {
                log::debug!("resend {}: {e}", packet.header.sequence_number);
            }
        }
    }
}

pub struct Builder(pub Arc<Resend>);

impl InterceptorBuilder for Builder {
    fn build(&self, _: &str) -> Result<Arc<dyn Interceptor + Send + Sync>, webrtc::interceptor::Error> {
        Ok(Arc::new(Handle(Arc::clone(&self.0))))
    }
}

struct Handle(Arc<Resend>);

struct Reader {
    parent: Arc<dyn RTCPReader + Send + Sync>,
    resend: Arc<Resend>,
}

#[async_trait]
impl RTCPReader for Reader {
    async fn read(&self, buf: &mut [u8], a: &Attributes) -> Result<(Vec<Box<dyn webrtc::rtcp::packet::Packet + Send + Sync>>, Attributes), webrtc::interceptor::Error> {
        let (packets, attributes) = self.parent.read(buf, a).await?;
        for p in &packets {
            if let Some(nack) = p.as_any().downcast_ref::<TransportLayerNack>() {
                let nack = nack.clone();
                let resend = Arc::clone(&self.resend);
                tokio::spawn(async move { resend.answer(&nack).await });
            }
        }
        Ok((packets, attributes))
    }
}

#[async_trait]
impl Interceptor for Handle {
    async fn bind_rtcp_reader(&self, reader: Arc<dyn RTCPReader + Send + Sync>) -> Arc<dyn RTCPReader + Send + Sync> {
        Arc::new(Reader { parent: reader, resend: Arc::clone(&self.0) })
    }

    async fn bind_rtcp_writer(&self, writer: Arc<dyn RTCPWriter + Send + Sync>) -> Arc<dyn RTCPWriter + Send + Sync> {
        writer
    }

    async fn bind_local_stream(&self, info: &StreamInfo, writer: Arc<dyn RTPWriter + Send + Sync>) -> Arc<dyn RTPWriter + Send + Sync> {
        if !info.rtcp_feedback.iter().any(|f| f.typ == "nack" && f.parameter.is_empty()) {
            return writer;
        }
        let stream = Arc::new(Stream { ring: Mutex::new(Ring::default()), next: writer });
        self.0.streams.lock().unwrap_or_else(|e| e.into_inner()).insert(info.ssrc, Arc::clone(&stream));
        stream
    }

    async fn unbind_local_stream(&self, info: &StreamInfo) {
        self.0.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&info.ssrc);
    }

    async fn bind_remote_stream(&self, _: &StreamInfo, reader: Arc<dyn RTPReader + Send + Sync>) -> Arc<dyn RTPReader + Send + Sync> {
        reader
    }

    async fn unbind_remote_stream(&self, _: &StreamInfo) {}

    async fn close(&self) -> Result<(), webrtc::interceptor::Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(seq: u16) -> Packet {
        let mut p = Packet::default();
        p.header.sequence_number = seq;
        p
    }

    #[test]
    fn the_ring_answers_for_what_it_still_holds() {
        let mut ring = Ring::default();
        for seq in 65000..=65535u16 {
            ring.add(&packet(seq));
        }
        for seq in 0..100u16 {
            ring.add(&packet(seq));
        }
        assert!(ring.get(99).is_some());
        assert!(ring.get(65535).is_some());
        assert!(ring.get(100).is_none());
        assert!(ring.get(99u16.wrapping_sub(RING)).is_none());
    }

    #[test]
    fn a_gap_forgets_the_packets_it_skipped() {
        let mut ring = Ring::default();
        ring.add(&packet(10));
        ring.add(&packet(10 + RING));
        assert!(ring.get(10).is_none());
        ring.add(&packet(10 + RING + 3));
        assert!(ring.get(10 + RING + 1).is_none());
        assert!(ring.get(10 + RING + 3).is_some());
    }

    #[test]
    fn nothing_before_the_floor_is_resent() {
        let mut ring = Ring::default();
        for seq in 100..200u16 {
            ring.add(&packet(seq));
        }
        ring.floor = Some(150);
        for seq in 200..210u16 {
            ring.add(&packet(seq));
        }
        assert!(ring.get(149).is_none());
        assert!(ring.get(150).is_some());
        assert!(ring.get(209).is_some());
        for seq in 210..=(150 + RING) {
            ring.add(&packet(seq));
        }
        assert_eq!(ring.floor, None);
    }
}
