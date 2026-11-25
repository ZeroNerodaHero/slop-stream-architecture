use std::sync::{mpsc, Mutex};
use std::thread::{self, JoinHandle};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::pcm::{Resampler, Sink};

#[derive(Serialize)]
pub struct InputDevice {
    id: String,
    name: String,
    default: bool,
}

pub struct Running {
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub struct Mic(Mutex<Option<Running>>);

#[tauri::command]
pub async fn list_input_devices() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let fallback = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    Ok(devices
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            let name = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| id.clone());
            Some(InputDevice {
                default: fallback.as_deref() == Some(id.as_str()),
                id,
                name,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn start_mic(
    state: State<'_, Mic>,
    id: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let (stop, stopped) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = thread::spawn(move || {
        let stream = match open(&id, channel).and_then(|s| s.play().map(|()| s).map_err(|e| e.to_string())) {
            Ok(stream) => stream,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let _ = ready_tx.send(Ok(()));
        let _ = stopped.recv();
        drop(stream);
    });
    let running = Running {
        stop,
        thread: Some(thread),
    };
    ready_rx
        .recv()
        .map_err(|_| "the mic did not open".to_string())??;
    let old = state.0.lock().map_err(|e| e.to_string())?.replace(running);
    drop(old);
    Ok(())
}

#[tauri::command]
pub async fn stop_mic(state: State<'_, Mic>) -> Result<(), String> {
    let old = state.0.lock().map_err(|e| e.to_string())?.take();
    drop(old);
    Ok(())
}

struct Feed {
    sink: Sink,
    resampler: Resampler,
    mono: Vec<f32>,
    channels: usize,
}

impl Feed {
    fn push(&mut self, data: impl Iterator<Item = f32>) {
        self.mono.clear();
        let channels = self.channels.max(1);
        let mut sum = 0.0;
        for (i, s) in data.enumerate() {
            sum += s;
            if i % channels == channels - 1 {
                self.mono.push(sum / channels as f32);
                sum = 0.0;
            }
        }
        let out = self.resampler.process(&self.mono);
        self.sink.push(out);
    }
}

fn blocked(e: impl std::fmt::Display) -> String {
    format!("the mic did not open ({e}). if nodentity is not allowed the mic, turn it on in System Settings, Privacy & Security, Microphone")
}

fn build<T: SizedSample + 'static>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut feed: Feed,
    convert: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| feed.push(data.iter().map(|s| convert(*s))),
            |_| {},
            None,
        )
        .map_err(blocked)
}

fn open(id: &str, channel: Channel<InvokeResponseBody>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = id
        .parse::<cpal::DeviceId>()
        .ok()
        .and_then(|id| host.device_by_id(&id))
        .ok_or("that mic is not there any more")?;
    let supported = device.default_input_config().map_err(blocked)?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let feed = Feed {
        sink: Sink::new(channel, 1),
        resampler: Resampler::new(config.sample_rate, 1),
        mono: Vec::new(),
        channels: usize::from(config.channels),
    };
    match format {
        SampleFormat::F32 => build::<f32>(&device, config, feed, |s| s),
        SampleFormat::I16 => build::<i16>(&device, config, feed, |s| f32::from(s) / 32_768.0),
        SampleFormat::I32 => build::<i32>(&device, config, feed, |s| s as f32 / 2_147_483_648.0),
        SampleFormat::U16 => build::<u16>(&device, config, feed, |s| (f32::from(s) - 32_768.0) / 32_768.0),
        SampleFormat::U8 => build::<u8>(&device, config, feed, |s| (f32::from(s) - 128.0) / 128.0),
        SampleFormat::I8 => build::<i8>(&device, config, feed, |s| f32::from(s) / 128.0),
        other => Err(format!("this mic sends {other} samples, which are not handled")),
    }
}
