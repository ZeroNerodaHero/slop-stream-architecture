use tauri::ipc::{Channel, InvokeResponseBody};

pub const RATE: u32 = 48_000;
const CHUNK_FRAMES: usize = 960;

pub struct Sink {
    channel: Channel<InvokeResponseBody>,
    channels: usize,
    pending: Vec<f32>,
}

impl Sink {
    pub fn new(channel: Channel<InvokeResponseBody>, channels: usize) -> Self {
        Self {
            channel,
            channels,
            pending: Vec::with_capacity(CHUNK_FRAMES * channels * 2),
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        let chunk = CHUNK_FRAMES * self.channels;
        while self.pending.len() >= chunk {
            let mut bytes = Vec::with_capacity(chunk * 4);
            for s in self.pending.drain(..chunk) {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let _ = self.channel.send(InvokeResponseBody::Raw(bytes));
        }
    }
}

pub struct Resampler {
    channels: usize,
    step: f64,
    pos: f64,
    last: Vec<f32>,
    out: Vec<f32>,
}

impl Resampler {
    pub fn new(from: u32, channels: usize) -> Self {
        Self {
            channels,
            step: f64::from(from) / f64::from(RATE),
            pos: 0.0,
            last: vec![0.0; channels],
            out: Vec::new(),
        }
    }

    pub fn process(&mut self, input: &[f32]) -> &[f32] {
        self.out.clear();
        let channels = self.channels;
        let frames = input.len() / channels;
        if frames == 0 {
            return &self.out;
        }
        if (self.step - 1.0).abs() < f64::EPSILON {
            self.out.extend_from_slice(&input[..frames * channels]);
            return &self.out;
        }
        let at = |k: usize, c: usize, last: &[f32]| if k == 0 { last[c] } else { input[(k - 1) * channels + c] };
        while self.pos < frames as f64 {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            for c in 0..channels {
                let a = at(i, c, &self.last);
                let b = at(i + 1, c, &self.last);
                self.out.push(a + (b - a) * frac);
            }
            self.pos += self.step;
        }
        self.pos -= frames as f64;
        self.last.copy_from_slice(&input[(frames - 1) * channels..frames * channels]);
        &self.out
    }
}

pub fn floats(bytes: &[u8]) -> impl Iterator<Item = f32> + '_ {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
}
