use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};

pub const LEVELS: usize = 3;
pub const NO_LEVEL: u8 = u8::MAX;

const SEQ_WINDOW: u16 = 0x4000;
const SEQ_KEEP: u16 = 0x2000;

const LOSS_DOWN: f32 = 0.10;
const NACK_DOWN: f32 = 0.10;
const LOSS_OK: f32 = 0.02;
const NACK_OK: f32 = 0.02;
const SEVERE: f32 = 0.25;
const REMB_GRACE: Duration = Duration::from_secs(3);
const REMB_DOWN: f64 = 0.6;
const REMB_FIT: f64 = 0.85;
const SETTLE: Duration = Duration::from_secs(1);
const BASE_UP_WAIT: Duration = Duration::from_secs(4);
const AFTER_DOWN_WAIT: Duration = Duration::from_secs(8);
const MAX_UP_WAIT: Duration = Duration::from_secs(32);
const FAILED_UP_WITHIN: Duration = Duration::from_secs(10);
const UP_HELD: Duration = Duration::from_secs(30);

pub fn level_of(rid: &str) -> Option<u8> {
    match rid {
        "" | "q" | "cq" => Some(0),
        "h" | "ch" => Some(1),
        "f" | "cf" => Some(2),
        _ => None,
    }
}

pub fn is_copy_rid(rid: &str) -> bool {
    matches!(rid, "cq" | "ch" | "cf")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PictureId {
    pub value: u16,
    pub wide: bool,
    pub at: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub keyframe: bool,
    pub picture_id: Option<PictureId>,
    pub tl0: Option<(u8, usize)>,
    pub size: Option<(u16, u16)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Codec {
    #[default]
    Vp8,
    Vp9,
}

pub const CODECS: usize = 2;

impl Codec {

    pub fn index(self) -> usize {
        match self {
            Codec::Vp8 => 0,
            Codec::Vp9 => 1,
        }
    }

    pub fn of_mime(mime: &str) -> Option<Codec> {
        if mime.eq_ignore_ascii_case("video/VP8") {
            Some(Codec::Vp8)
        } else if mime.eq_ignore_ascii_case("video/VP9") {
            Some(Codec::Vp9)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Codec::Vp8 => "VP8",
            Codec::Vp9 => "VP9",
        }
    }

    pub fn parse(self, payload: &[u8]) -> Frame {
        match self {
            Codec::Vp8 => parse_vp8(payload),
            Codec::Vp9 => parse_vp9(payload),
        }
    }
}

fn read_picture_id(payload: &[u8], at: usize) -> Option<(PictureId, usize)> {
    let id = *payload.get(at)?;
    if id & 0x80 != 0 {
        let low = *payload.get(at + 1)?;
        Some((PictureId { value: (u16::from(id & 0x7f) << 8) | u16::from(low), wide: true, at }, at + 2))
    } else {
        Some((PictureId { value: u16::from(id), wide: false, at }, at + 1))
    }
}

pub fn parse_vp8(payload: &[u8]) -> Frame {
    let mut out = Frame::default();
    let Some(&first) = payload.first() else { return out };
    let mut at = 1;
    if first & 0x80 != 0 {
        let Some(&ext) = payload.get(at) else { return out };
        at += 1;
        if ext & 0x80 != 0 {
            let Some((id, next)) = read_picture_id(payload, at) else { return out };
            out.picture_id = Some(id);
            at = next;
        }
        if ext & 0x40 != 0 {
            let Some(&tl0) = payload.get(at) else { return out };
            out.tl0 = Some((tl0, at));
            at += 1;
        }
        if ext & 0x30 != 0 {
            at += 1;
        }
    }
    let start = first & 0x10 != 0 && first & 0x07 == 0;
    out.keyframe = start && payload.get(at).is_some_and(|tag| tag & 0x01 == 0);
    if out.keyframe {
        if let Some(head) = payload.get(at..at + 10) {
            if head[3..6] == [0x9d, 0x01, 0x2a] {
                let width = u16::from_le_bytes([head[6], head[7]]) & 0x3fff;
                let height = u16::from_le_bytes([head[8], head[9]]) & 0x3fff;
                out.size = Some((width, height));
            }
        }
    }
    out
}

const VP9_MAX_DIFFS: usize = 3;

pub fn parse_vp9(payload: &[u8]) -> Frame {
    let mut out = Frame::default();
    let Some(&first) = payload.first() else { return out };
    let inter = first & 0x40 != 0;
    let layered = first & 0x20 != 0;
    let flexible = first & 0x10 != 0;
    let begins = first & 0x08 != 0;
    let structure = first & 0x02 != 0;
    let mut at = 1;
    if first & 0x80 != 0 {
        let Some((id, next)) = read_picture_id(payload, at) else { return out };
        out.picture_id = Some(id);
        at = next;
    }
    let mut spatial = 0;
    if layered {
        let Some(&layer) = payload.get(at) else { return out };
        spatial = (layer >> 1) & 0x07;
        at += 1;
        if !flexible {
            let Some(&tl0) = payload.get(at) else { return out };
            out.tl0 = Some((tl0, at));
            at += 1;
        }
    }
    if flexible && inter {
        for _ in 0..VP9_MAX_DIFFS {
            let Some(&diff) = payload.get(at) else { return out };
            at += 1;
            if diff & 0x01 == 0 {
                break;
            }
        }
    }
    out.keyframe = begins && !inter && spatial == 0;
    if structure {
        out.size = vp9_size(payload, at);
    }
    out
}

fn vp9_size(payload: &[u8], at: usize) -> Option<(u16, u16)> {
    let head = *payload.get(at)?;
    if head & 0x10 == 0 {
        return None;
    }
    let layers = usize::from(head >> 5) + 1;
    let last = at + 1 + (layers - 1) * 4;
    let size = payload.get(last..last + 4)?;
    Some((u16::from_be_bytes([size[0], size[1]]), u16::from_be_bytes([size[2], size[3]])))
}

fn picture_mask(wide: bool) -> u16 {
    if wide {
        0x7fff
    } else {
        0x7f
    }
}

pub fn rewrite_payload(payload: &Bytes, frame: &Frame, pid_off: u16, tl0_off: u8) -> Bytes {
    if pid_off == 0 && tl0_off == 0 {
        return payload.clone();
    }
    let mut out = BytesMut::from(&payload[..]);
    if let Some(pid) = frame.picture_id {
        let value = pid.value.wrapping_add(pid_off) & picture_mask(pid.wide);
        if pid.wide {
            out[pid.at] = 0x80 | (value >> 8) as u8;
            out[pid.at + 1] = value as u8;
        } else {
            out[pid.at] = value as u8;
        }
    }
    if let Some((tl0, at)) = frame.tl0 {
        out[at] = tl0.wrapping_add(tl0_off);
    }
    out.freeze()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admit {
    pub seq: u16,
    pub ts: u32,
    pub pid_off: u16,
    pub tl0_off: u8,
    pub switched: bool,
}

#[derive(Clone, Copy, Debug)]
struct Last {
    seq: u16,
    ts: u32,
    pid: Option<u16>,
    tl0: Option<u8>,
    at: Instant,
}

#[derive(Debug, Default)]
pub struct Rewrite {
    layer: Option<u8>,
    base_seq: u16,
    seq_off: u16,
    ts_off: u32,
    pid_off: u16,
    tl0_off: u8,
    last: Option<Last>,
    paused: bool,
}

fn newer(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

impl Rewrite {
    pub fn pause(&mut self) {
        self.paused = true;
        self.layer = None;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    pub fn admit(&mut self, layer: u8, target: u8, seq: u16, ts: u32, frame: &Frame, now: Instant) -> Option<Admit> {
        if self.paused {
            return None;
        }
        let switched = layer == target && self.layer != Some(layer) && frame.keyframe;
        if switched {
            self.switch_to(layer, seq, ts, frame, now);
        } else if self.layer != Some(layer) || newer(self.base_seq, seq) {
            return None;
        }
        let ahead = seq.wrapping_sub(self.base_seq);
        if ahead > SEQ_WINDOW && ahead < 0x8000 {
            self.base_seq = seq.wrapping_sub(SEQ_KEEP);
        }
        let out_seq = seq.wrapping_add(self.seq_off);
        let out_ts = ts.wrapping_add(self.ts_off);
        let pid = frame.picture_id.map(|p| p.value.wrapping_add(self.pid_off) & picture_mask(p.wide));
        let tl0 = frame.tl0.map(|(t, _)| t.wrapping_add(self.tl0_off));
        match &mut self.last {
            Some(last) if !newer(out_seq, last.seq) => {}
            last => {
                let prev = *last;
                *last = Some(Last { seq: out_seq, ts: out_ts, pid: pid.or(prev.and_then(|l| l.pid)), tl0: tl0.or(prev.and_then(|l| l.tl0)), at: now });
            }
        }
        Some(Admit { seq: out_seq, ts: out_ts, pid_off: self.pid_off, tl0_off: self.tl0_off, switched })
    }

    fn switch_to(&mut self, layer: u8, seq: u16, ts: u32, frame: &Frame, now: Instant) {
        self.layer = Some(layer);
        self.base_seq = seq;
        let Some(last) = self.last else {
            return;
        };
        self.seq_off = last.seq.wrapping_add(1).wrapping_sub(seq);
        let gap = now.saturating_duration_since(last.at).as_micros().min(u128::from(u32::MAX / 2)) as u32;
        let step = (gap / 1000 * 90).max(1);
        self.ts_off = last.ts.wrapping_add(step).wrapping_sub(ts);
        self.pid_off = match (last.pid, frame.picture_id) {
            (Some(prev), Some(pid)) => prev.wrapping_add(1).wrapping_sub(pid.value) & picture_mask(pid.wide),
            _ => 0,
        };
        self.tl0_off = match (last.tl0, frame.tl0) {
            (Some(prev), Some((tl0, _))) => prev.wrapping_add(1).wrapping_sub(tl0),
            _ => 0,
        };
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayerView {
    pub live: bool,
    pub bps: u64,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Signals {
    pub remb: Option<u64>,
    pub loss: f32,
    pub nack: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Gone,
    Cap,
    Congested,
    Healthy,
}

#[derive(Debug)]
pub struct Picker {
    target: u8,
    cap: u8,
    ceiling: u8,
    changed: Instant,
    healthy_since: Option<Instant>,
    up_wait: Duration,
    last_up: Option<(Instant, u8)>,
}

fn below(layers: &[LayerView; LEVELS], from: u8) -> Option<u8> {
    (0..from).rev().find(|l| layers[*l as usize].live)
}

fn above(layers: &[LayerView; LEVELS], from: u8, cap: u8) -> Option<u8> {
    (from + 1..=cap.min(LEVELS as u8 - 1)).find(|l| layers[*l as usize].live)
}

impl Picker {
    pub fn new(start: u8, cap: u8, now: Instant) -> Self {
        Self { target: start, cap, ceiling: LEVELS as u8 - 1, changed: now, healthy_since: None, up_wait: BASE_UP_WAIT, last_up: None }
    }

    pub fn limit(&mut self, cap: u8, ceiling: u8) {
        self.cap = cap;
        self.ceiling = ceiling.max(cap);
    }

    pub fn resume(&mut self, now: Instant) {
        self.changed = now;
        self.healthy_since = None;
        self.last_up = None;
    }

    pub fn lift(&mut self, level: u8, now: Instant) {
        if level > self.target && level <= self.cap {
            self.set(level, now);
        }
    }

    pub fn target(&self) -> u8 {
        self.target
    }

    fn set(&mut self, target: u8, now: Instant) {
        self.target = target;
        self.changed = now;
        self.healthy_since = None;
    }

    pub fn decide(&mut self, now: Instant, layers: &[LayerView; LEVELS], current: Option<u8>, signals: &Signals) -> Option<Why> {
        if !layers[self.target as usize].live {
            let start = self.target.min(self.cap);
            let next = if layers[start as usize].live { Some(start) } else { below(layers, start).or_else(|| above(layers, start, self.ceiling)) };
            if let Some(next) = next.filter(|n| *n != self.target) {
                self.set(next, now);
                return Some(Why::Gone);
            }
            return None;
        }
        if self.target > self.cap && layers[self.cap as usize].live {
            self.set(self.cap, now);
            return Some(Why::Cap);
        }
        let Some(current) = current.filter(|c| *c == self.target) else {
            return None;
        };
        if let Some((at, _)) = self.last_up {
            if now.saturating_duration_since(at) >= UP_HELD {
                self.last_up = None;
                self.up_wait = BASE_UP_WAIT;
            }
        }
        let rate = layers[current as usize].bps as f64;
        let just_up = self.last_up.is_some_and(|(at, _)| at == self.changed);
        let remb = signals.remb.map(|r| r as f64).filter(|_| !just_up || now.saturating_duration_since(self.changed) >= REMB_GRACE);
        let remb_low = remb.is_some_and(|r| rate > 0.0 && r < rate * REMB_DOWN);
        let severe = signals.loss >= SEVERE || signals.nack >= SEVERE;
        let congested = signals.loss >= LOSS_DOWN || signals.nack >= NACK_DOWN || remb_low;
        let settled = just_up || now.saturating_duration_since(self.changed) >= SETTLE;
        if congested {
            self.healthy_since = None;
            if !settled {
                return None;
            }
            let fit = remb.filter(|_| remb_low).and_then(|r| (0..current).rev().find(|l| layers[*l as usize].live && (layers[*l as usize].bps as f64) <= r * REMB_FIT));
            let bottom = (0..current).find(|l| layers[*l as usize].live).filter(|_| severe);
            let Some(next) = bottom.or(fit).or_else(|| below(layers, current)) else {
                return None;
            };
            if let Some((at, from)) = self.last_up {
                if next <= from && now.saturating_duration_since(at) < FAILED_UP_WITHIN {
                    self.up_wait = (self.up_wait * 2).min(MAX_UP_WAIT);
                }
            }
            self.last_up = None;
            self.up_wait = self.up_wait.max(AFTER_DOWN_WAIT);
            self.set(next, now);
            return Some(Why::Congested);
        }
        let healthy = signals.loss < LOSS_OK && signals.nack < NACK_OK && !remb.is_some_and(|r| rate > 0.0 && r < rate);
        if !healthy {
            self.healthy_since = None;
            return None;
        }
        let since = *self.healthy_since.get_or_insert(now);
        if now.saturating_duration_since(since) < self.up_wait || now.saturating_duration_since(self.changed) < self.up_wait {
            return None;
        }
        let next = above(layers, current, self.cap)?;
        self.last_up = Some((now, current));
        self.set(next, now);
        Some(Why::Healthy)
    }
}

pub const START_BUDGET_BPS: u64 = 1_500_000;

fn offered_levels(offered: u8) -> impl DoubleEndedIterator<Item = u8> {
    (0..LEVELS as u8).filter(move |l| offered & (1 << l) != 0)
}

pub fn pinned_limits(offered: u8) -> (u8, u8) {
    let low = offered_levels(offered).next().unwrap_or(0);
    let ceiling = offered_levels(offered).rev().nth(1).unwrap_or(low);
    (low, ceiling.max(low))
}

pub fn start_level(layers: &[LayerView; LEVELS], offered: u8, pinned: bool) -> u8 {
    let live: Vec<u8> = (0..LEVELS as u8).filter(|l| layers[*l as usize].live).collect();
    if pinned {
        let (low, ceiling) = pinned_limits(offered);
        return live.iter().copied().find(|l| *l <= ceiling).unwrap_or(low);
    }
    let known = !live.is_empty() && live.iter().all(|l| layers[*l as usize].bps > 0);
    if !known {
        let lowest = offered_levels(offered).next().unwrap_or(0);
        return offered_levels(offered).rev().find(|l| *l <= 1).unwrap_or(lowest);
    }
    live.iter().rev().find(|l| layers[**l as usize].bps <= START_BUDGET_BPS).copied().unwrap_or(live[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn key(pid: u16, tl0: u8) -> Frame {
        Frame { keyframe: true, picture_id: Some(PictureId { value: pid, wide: true, at: 2 }), tl0: Some((tl0, 4)), size: None }
    }

    fn delta(pid: u16, tl0: u8) -> Frame {
        Frame { keyframe: false, ..key(pid, tl0) }
    }

    #[test]
    fn rids_map_to_levels() {
        assert_eq!(level_of(""), Some(0));
        assert_eq!(level_of("q"), Some(0));
        assert_eq!(level_of("h"), Some(1));
        assert_eq!(level_of("f"), Some(2));
        assert_eq!(level_of("x"), None);
        assert_eq!((level_of("cq"), level_of("ch"), level_of("cf")), (Some(0), Some(1), Some(2)));
        assert!(is_copy_rid("cq") && !is_copy_rid("q") && !is_copy_rid(""));
    }

    #[test]
    fn parses_picture_id_tl0_and_keyframe_size() {
        let payload = [0x90, 0xe0, 0x81, 0x23, 0x05, 0x40, 0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04];
        let frame = parse_vp8(&payload);
        assert!(frame.keyframe);
        assert_eq!(frame.picture_id, Some(PictureId { value: 0x0123, wide: true, at: 2 }));
        assert_eq!(frame.tl0, Some((0x05, 4)));
        assert_eq!(frame.size, Some((1920, 1080)));
        let narrow = parse_vp8(&[0x80, 0x80, 0x12, 0x01]);
        assert_eq!(narrow.picture_id, Some(PictureId { value: 0x12, wide: false, at: 2 }));
        assert!(!narrow.keyframe);
        assert_eq!(parse_vp8(&[0x90, 0x80, 0x92]), Frame::default());
    }

    const VP9_KEY: [u8; 17] = [0xaa, 0x81, 0x23, 0x00, 0x05, 0x18, 0x07, 0x80, 0x04, 0x38, 0x01, 0x04, 0x01, 0x82, 0x49, 0x83, 0x42];

    #[test]
    fn parses_a_vp9_keyframe_with_its_structure() {
        let frame = parse_vp9(&VP9_KEY);
        assert!(frame.keyframe);
        assert_eq!(frame.picture_id, Some(PictureId { value: 0x0123, wide: true, at: 1 }));
        assert_eq!(frame.tl0, Some((0x05, 4)));
        assert_eq!(frame.size, Some((1920, 1080)));
        assert_eq!(Codec::Vp9.parse(&VP9_KEY), frame);
    }

    #[test]
    fn parses_vp9_delta_flexible_and_upper_layer_frames() {
        let delta = parse_vp9(&[0xe8, 0x81, 0x24, 0x20, 0x05, 0x11]);
        assert!(!delta.keyframe);
        assert_eq!(delta.picture_id, Some(PictureId { value: 0x0124, wide: true, at: 1 }));
        assert_eq!(delta.tl0, Some((0x05, 4)));
        assert_eq!(delta.size, None);

        let flexible = parse_vp9(&[0xf8, 0x12, 0x00, 0x03, 0x02, 0x11]);
        assert!(!flexible.keyframe);
        assert_eq!(flexible.picture_id, Some(PictureId { value: 0x12, wide: false, at: 1 }));
        assert_eq!(flexible.tl0, None);

        let flexible_key = parse_vp9(&[0xb8, 0x12, 0x00, 0x11]);
        assert!(flexible_key.keyframe);
        assert_eq!(flexible_key.tl0, None);

        assert!(!parse_vp9(&[0xa8, 0x81, 0x23, 0x02, 0x05, 0x11]).keyframe);
        assert!(!parse_vp9(&[0xa0, 0x81, 0x23, 0x00, 0x05, 0x11]).keyframe);
        assert!(parse_vp9(&[0x88, 0x7f, 0x11]).keyframe);
        assert!(parse_vp9(&[0x08, 0x11]).keyframe);
    }

    #[test]
    fn a_short_vp9_descriptor_is_never_a_keyframe() {
        assert_eq!(parse_vp9(&[]), Frame::default());
        assert!(!parse_vp9(&[0xaa]).keyframe);
        assert!(!parse_vp9(&[0xaa, 0x81]).keyframe);
        assert!(!parse_vp9(&[0xaa, 0x81, 0x23]).keyframe);
        assert!(!parse_vp9(&[0xaa, 0x81, 0x23, 0x00]).keyframe);
        assert!(!parse_vp9(&[0xf8, 0x12, 0x00, 0x03]).keyframe);
        assert_eq!(parse_vp9(&[0xaa, 0x81, 0x23, 0x00, 0x05, 0x18, 0x07]).size, None);
        assert_eq!(parse_vp9(&[0xaa, 0x81, 0x23, 0x00, 0x05, 0x08]).size, None);
    }

    #[test]
    fn vp8_and_vp9_are_told_apart_by_mime() {
        assert_eq!(Codec::of_mime("video/VP8"), Some(Codec::Vp8));
        assert_eq!(Codec::of_mime("video/vp9"), Some(Codec::Vp9));
        assert_eq!(Codec::of_mime("video/H264"), None);
        assert_eq!(Codec::Vp8.parse(&VP9_KEY).keyframe, parse_vp8(&VP9_KEY).keyframe);
    }

    #[test]
    fn rewrites_a_vp9_picture_id_and_tl0_in_a_copy() {
        let payload = Bytes::from_static(&VP9_KEY);
        let moved = rewrite_payload(&payload, &parse_vp9(&payload), 0x7fff, 3);
        let again = parse_vp9(&moved);
        assert_eq!(again.picture_id.unwrap().value, 0x0122);
        assert_eq!(again.tl0.unwrap().0, 0x08);
        assert_eq!(again.size, Some((1920, 1080)));
        assert!(again.keyframe);
        assert_eq!(&moved[5..], &VP9_KEY[5..]);
        let flexible = Bytes::from_static(&[0xf8, 0x7f, 0x00, 0x03, 0x02, 0x11]);
        let out = rewrite_payload(&flexible, &parse_vp9(&flexible), 2, 9);
        assert_eq!(&out[..], &[0xf8, 0x01, 0x00, 0x03, 0x02, 0x11]);
    }

    #[test]
    fn a_vp9_switch_waits_for_a_keyframe_and_continues_picture_id_and_tl0() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        let first = r.admit(0, 0, 10, 1000, &parse_vp9(&VP9_KEY), t).unwrap();
        assert!(first.switched);
        let delta = parse_vp9(&[0xe8, 0x81, 0x24, 0x20, 0x05, 0x11]);
        assert!(r.admit(0, 0, 11, 4000, &delta, t).is_some());
        assert_eq!(r.admit(1, 1, 500, 90000, &parse_vp9(&[0xe8, 0x80, 0x10, 0x20, 0x40, 0x11]), t), None);
        let upper = r.admit(1, 1, 501, 93000, &parse_vp9(&[0xaa, 0x80, 0x11, 0x00, 0x41, 0x18, 0x07, 0x80, 0x04, 0x38, 0x00]), t).unwrap();
        assert!(upper.switched);
        assert_eq!(upper.seq, 12);
        assert_eq!(0x11u16.wrapping_add(upper.pid_off) & 0x7fff, 0x0125);
        assert_eq!(0x41u8.wrapping_add(upper.tl0_off), 0x06);
    }

    #[test]
    fn rewrites_picture_id_and_tl0_in_a_copy() {
        let payload = Bytes::from_static(&[0x90, 0xe0, 0xff, 0xfe, 0x05, 0x40, 0x50]);
        let frame = parse_vp8(&payload);
        let same = rewrite_payload(&payload, &frame, 0, 0);
        assert_eq!(same.as_ptr(), payload.as_ptr());
        let moved = rewrite_payload(&payload, &frame, 3, 250);
        let again = parse_vp8(&moved);
        assert_eq!(again.picture_id.unwrap().value, 1);
        assert_eq!(again.tl0.unwrap().0, 255);
        assert_eq!(&payload[..], &[0x90, 0xe0, 0xff, 0xfe, 0x05, 0x40, 0x50]);
        let narrow = Bytes::from_static(&[0x80, 0x80, 0x7f, 0x01]);
        let out = rewrite_payload(&narrow, &parse_vp8(&narrow), 2, 0);
        assert_eq!(out[2], 0x01);
    }

    #[test]
    fn nothing_flows_until_a_keyframe_on_the_target() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        assert_eq!(r.admit(1, 1, 100, 9000, &delta(5, 1), t), None);
        assert_eq!(r.admit(2, 1, 500, 1000, &key(70, 9), t), None);
        let first = r.admit(1, 1, 101, 12000, &key(6, 2), t).unwrap();
        assert_eq!((first.seq, first.ts, first.pid_off, first.tl0_off, first.switched), (101, 12000, 0, 0, true));
        assert_eq!(r.admit(1, 1, 102, 12000, &delta(6, 2), t).unwrap().seq, 102);
        assert_eq!(r.admit(1, 1, 99, 9000, &delta(5, 1), t), None);
    }

    #[test]
    fn a_switch_continues_seq_timestamp_picture_id_and_tl0() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        r.admit(1, 1, 1000, 50_000, &key(300, 40), t).unwrap();
        r.admit(1, 1, 1001, 53_000, &delta(301, 40), t + ms(33)).unwrap();
        assert!(r.admit(1, 2, 1002, 56_000, &delta(302, 41), t + ms(66)).is_some());
        assert_eq!(r.admit(2, 2, 7000, 900_000, &delta(9000, 200), t + ms(70)), None);
        let up = r.admit(2, 2, 7001, 903_000, &key(9001, 201), t + ms(100)).unwrap();
        assert!(up.switched);
        assert_eq!(up.seq, 1003);
        assert_eq!(up.ts, 56_000 + 34 * 90);
        assert_eq!(9001u16.wrapping_add(up.pid_off) & 0x7fff, 303);
        assert_eq!(201u8.wrapping_add(up.tl0_off), 42);
        assert_eq!(r.admit(1, 2, 1003, 59_000, &delta(303, 41), t + ms(100)), None);
        let next = r.admit(2, 2, 7002, 906_000, &delta(9002, 201), t + ms(133)).unwrap();
        assert_eq!((next.seq, next.ts), (1004, 56_000 + 34 * 90 + 3000));
    }

    #[test]
    fn a_switch_down_keeps_going_forward_and_wraps() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        r.admit(2, 2, 65_535, u32::MAX - 10, &key(0x7fff, 255), t).unwrap();
        let down = r.admit(0, 0, 5, 77, &key(10, 3), t + ms(40)).unwrap();
        assert_eq!(down.seq, 0);
        assert_eq!(down.ts, (u32::MAX - 10).wrapping_add(40 * 90));
        assert_eq!(10u16.wrapping_add(down.pid_off) & 0x7fff, 0);
        assert_eq!(3u8.wrapping_add(down.tl0_off), 0);
    }

    #[test]
    fn late_packets_from_before_the_switch_point_are_dropped_but_reordering_after_it_is_kept() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        r.admit(0, 0, 10, 0, &key(1, 1), t).unwrap();
        r.admit(0, 0, 12, 0, &delta(2, 1), t).unwrap();
        assert_eq!(r.admit(0, 0, 11, 0, &delta(2, 1), t).unwrap().seq, 11);
        assert_eq!(r.admit(0, 0, 9, 0, &delta(0, 1), t), None);
    }

    #[test]
    fn the_switch_point_follows_a_long_run_of_packets() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        r.admit(0, 0, 0, 0, &key(1, 1), t).unwrap();
        for seq in 1..=60_000u32 {
            assert!(r.admit(0, 0, seq as u16, 0, &delta(1, 1), t).is_some(), "seq {seq}");
        }
        for seq in 60_001..=140_000u32 {
            assert!(r.admit(0, 0, seq as u16, 0, &delta(1, 1), t).is_some(), "seq {seq}");
        }
    }

    fn three(bps: [u64; 3]) -> [LayerView; 3] {
        [
            LayerView { live: true, bps: bps[0], height: 360 },
            LayerView { live: true, bps: bps[1], height: 720 },
            LayerView { live: true, bps: bps[2], height: 1080 },
        ]
    }

    const RATES: [u64; 3] = [450_000, 1_100_000, 2_300_000];

    fn healthy() -> Signals {
        Signals { remb: None, loss: 0.0, nack: 0.0 }
    }

    #[test]
    fn new_viewers_start_at_or_under_the_budget_and_previews_on_the_lowest() {
        assert_eq!(start_level(&three(RATES), 0b111, false), 1);
        assert_eq!(start_level(&three(RATES), 0b111, true), 0);
        assert_eq!(start_level(&three([150_000, 500_000, 1_200_000]), 0b111, false), 2);
        let small = [
            LayerView { live: true, bps: 120_000, height: 240 },
            LayerView { live: true, bps: 600_000, height: 480 },
            LayerView { live: true, bps: 2_000_000, height: 720 },
        ];
        assert_eq!(start_level(&small, 0b111, true), 0);
        let mut no_bottom = three(RATES);
        no_bottom[0].live = false;
        assert_eq!(start_level(&no_bottom, 0b111, true), 1);
        no_bottom[1].live = false;
        assert_eq!(start_level(&no_bottom, 0b111, true), 0);
        let single = [LayerView { live: true, bps: 180_000, height: 240 }, LayerView::default(), LayerView::default()];
        assert_eq!(start_level(&single, 0b001, false), 0);
        assert_eq!(start_level(&single, 0b001, true), 0);
        let fresh = [LayerView::default(); 3];
        assert_eq!(start_level(&fresh, 0b111, false), 1);
        assert_eq!(start_level(&fresh, 0b110, false), 1);
        assert_eq!(start_level(&fresh, 0b110, true), 1);
        assert_eq!(start_level(&fresh, 0b001, false), 0);
    }

    #[test]
    fn a_pinned_viewer_is_held_to_the_lowest_layer_and_never_the_top() {
        assert_eq!(pinned_limits(0b111), (0, 1));
        assert_eq!(pinned_limits(0b011), (0, 0));
        assert_eq!(pinned_limits(0b110), (1, 1));
        assert_eq!(pinned_limits(0b001), (0, 0));
        assert_eq!(pinned_limits(0b100), (2, 2));
        assert_eq!(pinned_limits(0), (0, 0));
        let t = Instant::now();
        let mut layers = three(RATES);
        let mut p = Picker::new(2, 2, t);
        let (cap, ceiling) = pinned_limits(0b111);
        p.limit(cap, ceiling);
        assert_eq!(p.decide(t, &layers, None, &Signals::default()), Some(Why::Cap));
        assert_eq!(p.target(), 0);
        for step in 1..80 {
            p.decide(t + ms(step * 500), &layers, Some(p.target()), &healthy());
        }
        assert_eq!(p.target(), 0);
        layers[0].live = false;
        assert_eq!(p.decide(t + ms(41_000), &layers, Some(0), &healthy()), Some(Why::Gone));
        assert_eq!(p.target(), 1);
        layers[1].live = false;
        assert_eq!(p.decide(t + ms(41_500), &layers, Some(1), &healthy()), None);
        assert_eq!(p.target(), 1);
        layers[0].live = true;
        assert_eq!(p.decide(t + ms(42_000), &layers, None, &healthy()), Some(Why::Gone));
        assert_eq!(p.target(), 0);
    }

    #[test]
    fn leaving_the_pin_lifts_to_the_start_layer_and_resume_restarts_the_climb_wait() {
        let t = Instant::now();
        let layers = three(RATES);
        let mut p = Picker::new(0, 0, t);
        p.lift(1, t);
        assert_eq!(p.target(), 0);
        p.limit(2, 2);
        p.lift(1, t + ms(100));
        assert_eq!(p.target(), 1);
        p.lift(0, t + ms(100));
        assert_eq!(p.target(), 1);
        assert_eq!(p.decide(t + ms(200), &layers, Some(1), &healthy()), None);
        p.resume(t + ms(10_000));
        let mut now = t + ms(10_000);
        while p.target() == 1 {
            now += ms(250);
            p.decide(now, &layers, Some(1), &healthy());
        }
        assert_eq!(now, t + ms(10_250) + BASE_UP_WAIT);
    }

    #[test]
    fn a_pause_drops_everything_and_the_resume_waits_for_a_keyframe_and_stays_continuous() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        r.admit(1, 1, 100, 10_000, &key(50, 5), t).unwrap();
        let before = r.admit(1, 1, 101, 13_000, &delta(51, 5), t + ms(33)).unwrap();
        r.pause();
        assert_eq!(r.admit(1, 1, 102, 16_000, &delta(52, 5), t + ms(66)), None);
        assert_eq!(r.admit(1, 1, 500, 900_000, &key(400, 60), t + ms(5000)), None);
        r.resume();
        assert_eq!(r.admit(1, 1, 501, 903_000, &delta(401, 60), t + ms(10_000)), None);
        assert_eq!(r.admit(0, 1, 9000, 5, &key(7, 1), t + ms(10_010)), None);
        let back = r.admit(1, 1, 502, 906_000, &key(402, 61), t + ms(10_033)).unwrap();
        assert!(back.switched);
        assert_eq!(back.seq, before.seq.wrapping_add(1));
        assert_eq!(back.ts, before.ts.wrapping_add(10_000 * 90));
        assert_eq!(402u16.wrapping_add(back.pid_off) & 0x7fff, 52);
        assert_eq!(61u8.wrapping_add(back.tl0_off), 6);
        let next = r.admit(1, 1, 503, 909_000, &delta(403, 61), t + ms(10_066)).unwrap();
        assert_eq!((next.seq, next.ts), (before.seq.wrapping_add(2), back.ts.wrapping_add(3000)));
        r.pause();
        r.resume();
        let other = r.admit(2, 2, 70, 1, &key(9, 9), t + ms(20_000)).unwrap();
        assert!(other.switched);
        assert_eq!(other.seq, next.seq.wrapping_add(1));
    }

    #[test]
    fn a_pause_before_the_first_packet_starts_fresh() {
        let t = Instant::now();
        let mut r = Rewrite::default();
        r.pause();
        r.resume();
        let first = r.admit(0, 0, 40, 800, &key(3, 3), t).unwrap();
        assert_eq!((first.seq, first.ts, first.pid_off, first.tl0_off), (40, 800, 0, 0));
    }

    #[test]
    fn a_healthy_viewer_steps_up_after_the_wait_and_not_before() {
        let t = Instant::now();
        let layers = three(RATES);
        let mut p = Picker::new(1, 2, t);
        assert_eq!(p.decide(t + ms(500), &layers, Some(1), &healthy()), None);
        assert_eq!(p.decide(t + ms(4000), &layers, Some(1), &healthy()), None);
        assert_eq!(p.decide(t + ms(4500), &layers, Some(1), &healthy()), Some(Why::Healthy));
        assert_eq!(p.target(), 2);
        assert_eq!(p.decide(t + ms(30_000), &layers, Some(2), &healthy()), None);
        assert_eq!(p.target(), 2);
    }

    #[test]
    fn nothing_moves_while_a_switch_is_pending() {
        let t = Instant::now();
        let layers = three(RATES);
        let mut p = Picker::new(1, 2, t);
        let bad = Signals { loss: 0.5, ..healthy() };
        assert_eq!(p.decide(t + ms(9000), &layers, None, &bad), None);
        assert_eq!(p.decide(t + ms(9000), &layers, Some(0), &bad), None);
        assert_eq!(p.target(), 1);
    }

    #[test]
    fn loss_steps_down_once_per_settle_and_then_waits_longer_to_climb() {
        let t = Instant::now();
        let layers = three(RATES);
        let mut p = Picker::new(2, 2, t);
        let lossy = Signals { loss: 0.15, ..healthy() };
        assert_eq!(p.decide(t + SETTLE / 2, &layers, Some(2), &lossy), None);
        assert_eq!(p.decide(t + SETTLE, &layers, Some(2), &lossy), Some(Why::Congested));
        assert_eq!(p.target(), 1);
        assert_eq!(p.decide(t + SETTLE * 3 / 2, &layers, Some(1), &lossy), None);
        assert_eq!(p.decide(t + SETTLE * 2, &layers, Some(1), &lossy), Some(Why::Congested));
        assert_eq!(p.target(), 0);
        assert_eq!(p.decide(t + ms(7000), &layers, Some(0), &lossy), None);
        assert_eq!(p.target(), 0);
        let mut now = t + ms(7000);
        while p.target() == 0 && now < t + ms(30_000) {
            now += ms(500);
            p.decide(now, &layers, Some(0), &healthy());
        }
        assert_eq!(p.target(), 1);
        assert!(now - (t + ms(7000)) >= AFTER_DOWN_WAIT, "climbed after {:?}", now - (t + ms(7000)));
    }

    #[test]
    fn a_nack_storm_counts_as_congestion() {
        let t = Instant::now();
        let mut p = Picker::new(2, 2, t);
        let storm = Signals { nack: 0.2, ..healthy() };
        assert_eq!(p.decide(t + ms(3000), &three(RATES), Some(2), &storm), Some(Why::Congested));
        assert_eq!(p.target(), 1);
    }

    #[test]
    fn heavy_loss_drops_straight_to_the_bottom() {
        let t = Instant::now();
        let mut p = Picker::new(2, 2, t);
        let heavy = Signals { nack: 0.3, ..healthy() };
        assert_eq!(p.decide(t + ms(3000), &three(RATES), Some(2), &heavy), Some(Why::Congested));
        assert_eq!(p.target(), 0);
    }

    #[test]
    fn a_remb_still_sized_for_the_old_layer_does_not_undo_a_climb() {
        let t = Instant::now();
        let layers = three(RATES);
        let mut p = Picker::new(0, 2, t);
        let mut now = t;
        while p.target() == 0 {
            now += ms(250);
            p.decide(now, &layers, Some(0), &Signals { remb: Some(600_000), ..healthy() });
        }
        let lagging = Signals { remb: Some(600_000), ..healthy() };
        assert_eq!(p.decide(now + ms(250), &layers, Some(1), &lagging), None);
        assert_eq!(p.decide(now + ms(2750), &layers, Some(1), &lagging), None);
        assert_eq!(p.decide(now + REMB_GRACE, &layers, Some(1), &lagging), Some(Why::Congested));
        let lossy = Signals { loss: 0.2, ..healthy() };
        let mut q = Picker::new(1, 2, t);
        q.last_up = Some((t, 0));
        assert_eq!(q.decide(t + ms(250), &layers, Some(1), &lossy), Some(Why::Congested));
    }

    #[test]
    fn a_low_remb_jumps_straight_to_the_layer_that_fits() {
        let t = Instant::now();
        let mut p = Picker::new(2, 2, t);
        let remb = Signals { remb: Some(700_000), ..healthy() };
        assert_eq!(p.decide(t + ms(3000), &three(RATES), Some(2), &remb), Some(Why::Congested));
        assert_eq!(p.target(), 0);
    }

    #[test]
    fn a_remb_under_the_current_rate_holds_the_climb() {
        let t = Instant::now();
        let mut p = Picker::new(1, 2, t);
        let held = Signals { remb: Some(1_000_000), ..healthy() };
        for step in 1..40 {
            assert_eq!(p.decide(t + ms(step * 500), &three(RATES), Some(1), &held), None);
        }
        assert_eq!(p.target(), 1);
    }

    #[test]
    fn a_failed_climb_doubles_the_wait_and_holding_resets_it() {
        let t = Instant::now();
        let layers = three(RATES);
        let mut p = Picker::new(1, 2, t);
        p.up_wait = AFTER_DOWN_WAIT;
        for step in 1..17 {
            assert_eq!(p.decide(t + ms(step * 500), &layers, Some(1), &healthy()), None, "step {step}");
        }
        assert_eq!(p.decide(t + ms(8500), &layers, Some(1), &healthy()), Some(Why::Healthy));
        let lossy = Signals { loss: 0.2, ..healthy() };
        assert_eq!(p.decide(t + ms(8750), &layers, Some(1), &lossy), None);
        assert_eq!(p.decide(t + ms(9000), &layers, Some(2), &lossy), Some(Why::Congested));
        assert_eq!(p.up_wait, AFTER_DOWN_WAIT * 2);
        assert_eq!(p.decide(t + ms(9250), &layers, Some(1), &lossy), None);
        let mut now = t + ms(9000);
        while p.target() == 1 {
            now += ms(500);
            p.decide(now, &layers, Some(1), &healthy());
        }
        assert!(now - (t + ms(9000)) >= AFTER_DOWN_WAIT * 2);
        p.decide(now + UP_HELD, &layers, Some(2), &healthy());
        assert_eq!(p.up_wait, BASE_UP_WAIT);
    }

    #[test]
    fn a_layer_that_goes_quiet_moves_the_viewer_to_the_next_live_one() {
        let t = Instant::now();
        let mut layers = three(RATES);
        let mut p = Picker::new(2, 2, t);
        layers[2].live = false;
        assert_eq!(p.decide(t + ms(100), &layers, Some(2), &healthy()), Some(Why::Gone));
        assert_eq!(p.target(), 1);
        layers[1].live = false;
        layers[0].live = false;
        assert_eq!(p.decide(t + ms(200), &layers, Some(2), &healthy()), None);
        assert_eq!(p.target(), 1);
        layers[0].live = true;
        assert_eq!(p.decide(t + ms(300), &layers, None, &healthy()), Some(Why::Gone));
        assert_eq!(p.target(), 0);
    }

    #[test]
    fn a_quiet_low_layer_moves_a_preview_up_and_the_cap_brings_it_back() {
        let t = Instant::now();
        let mut layers = three(RATES);
        let mut p = Picker::new(0, 0, t);
        layers[0].live = false;
        assert_eq!(p.decide(t, &layers, Some(0), &healthy()), Some(Why::Gone));
        assert_eq!(p.target(), 1);
        layers[0].live = true;
        assert_eq!(p.decide(t + ms(500), &layers, Some(1), &healthy()), Some(Why::Cap));
        assert_eq!(p.target(), 0);
        for step in 2..80 {
            p.decide(t + ms(step * 500), &layers, Some(p.target()), &healthy());
        }
        assert_eq!(p.target(), 0);
        let single = [LayerView { live: true, bps: 180_000, height: 240 }, LayerView::default(), LayerView::default()];
        let mut lone = Picker::new(0, 2, t);
        for step in 1..80 {
            assert_eq!(lone.decide(t + ms(step * 500), &single, Some(0), &Signals { loss: 0.5, ..healthy() }), None);
        }
        assert_eq!(lone.target(), 0);
    }
}
