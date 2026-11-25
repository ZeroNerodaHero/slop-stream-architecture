use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

#[derive(Default)]
pub struct DesktopAudio(Mutex<Option<platform::Running>>);

#[tauri::command]
pub async fn start_desktop_audio(
    state: State<'_, DesktopAudio>,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let running = platform::start(channel)?;
    let old = state.0.lock().map_err(|e| e.to_string())?.replace(running);
    drop(old);
    Ok(())
}

#[tauri::command]
pub async fn stop_desktop_audio(state: State<'_, DesktopAudio>) -> Result<(), String> {
    let old = state.0.lock().map_err(|e| e.to_string())?.take();
    drop(old);
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Mutex;

    use screencapturekit::prelude::*;
    use tauri::ipc::{Channel, InvokeResponseBody};

    use crate::pcm::{floats, Sink, RATE};

    pub struct Running(SCStream);

    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.stop_capture();
        }
    }

    pub fn start(channel: Channel<InvokeResponseBody>) -> Result<Running, String> {
        let content = SCShareableContent::get().map_err(crate::capture::denied)?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or("no display to take the sound from")?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build()
            .map_err(|e| e.to_string())?;
        let config = SCStreamConfiguration::new()
            .with_width(2)
            .with_height(2)
            .with_fps(1)
            .with_captures_audio(true)
            .with_sample_rate(RATE as i32)
            .with_channel_count(2)
            .with_excludes_current_process_audio(true);
        let sink = Mutex::new((Sink::new(channel, 2), Vec::<f32>::new()));
        let mut stream = SCStream::new(&filter, &config).map_err(|e| e.to_string())?;
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
                    if !matches!(kind, SCStreamOutputType::Audio) {
                        return;
                    }
                    let Ok(mut guard) = sink.lock() else { return };
                    let (sink, scratch) = &mut *guard;
                    interleave(&sample, scratch);
                    sink.push(scratch);
                },
                SCStreamOutputType::Audio,
            )
            .map_err(|e| e.to_string())?;
        stream.start_capture().map_err(crate::capture::denied)?;
        Ok(Running(stream))
    }

    fn interleave(sample: &CMSampleBuffer, out: &mut Vec<f32>) {
        out.clear();
        let Ok(list) = sample.audio_buffer_list() else { return };
        let buffers: Vec<_> = (0..list.num_buffers()).filter_map(|i| list.get(i)).collect();
        match buffers.as_slice() {
            [] => {}
            [one] if one.number_channels >= 2 => {
                let channels = one.number_channels as usize;
                let all: Vec<f32> = floats(one.data()).collect();
                for frame in all.chunks_exact(channels) {
                    out.push(frame[0]);
                    out.push(frame[1]);
                }
            }
            [one] => {
                for s in floats(one.data()) {
                    out.push(s);
                    out.push(s);
                }
            }
            [left, right, ..] => {
                for (l, r) in floats(left.data()).zip(floats(right.data())) {
                    out.push(l);
                    out.push(r);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use tauri::ipc::{Channel, InvokeResponseBody};
    use wasapi::{
        initialize_mta, AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, SampleType,
        StreamMode, WaveFormat,
    };

    use crate::pcm::{floats, Sink, RATE};

    pub struct Running {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub fn start(channel: Channel<InvokeResponseBody>) -> Result<Running, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let flag = stop.clone();
        let thread = thread::spawn(move || run(channel, &flag, &ready_tx));
        let running = Running {
            stop,
            thread: Some(thread),
        };
        ready_rx
            .recv()
            .map_err(|_| "desktop audio did not start".to_string())??;
        Ok(running)
    }

    fn open() -> Result<(AudioClient, AudioCaptureClient), String> {
        let _ = initialize_mta();
        let device = DeviceEnumerator::new()
            .and_then(|e| e.get_default_device(Direction::Render))
            .map_err(|e| format!("no speakers to take the sound from: {e}"))?;
        let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
        let format = WaveFormat::new(32, 32, SampleType::Float, RATE as usize, 2, None);
        let mode = StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: 1_000_000,
        };
        client
            .initialize_client(&format, Direction::Capture, mode, None)
            .map_err(|e| e.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;
        Ok((client, capture))
    }

    fn run(channel: Channel<InvokeResponseBody>, stop: &AtomicBool, ready: &mpsc::Sender<Result<(), String>>) {
        let (client, capture) = match open() {
            Ok(opened) => opened,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let _ = ready.send(Ok(()));
        let mut sink = Sink::new(channel, 2);
        let mut queue = VecDeque::<u8>::new();
        let mut samples = Vec::<f32>::new();
        while !stop.load(Ordering::Relaxed) {
            if capture.read_from_device_to_deque(&mut queue).is_err() {
                break;
            }
            let whole = queue.len() - queue.len() % 8;
            if whole > 0 {
                let bytes: Vec<u8> = queue.drain(..whole).collect();
                samples.clear();
                samples.extend(floats(&bytes));
                sink.push(&samples);
            }
            thread::sleep(Duration::from_millis(5));
        }
        let _ = client.stop_stream();
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use tauri::ipc::{Channel, InvokeResponseBody};

    pub struct Running;

    pub fn start(_channel: Channel<InvokeResponseBody>) -> Result<Running, String> {
        Err("unsupported".into())
    }
}
