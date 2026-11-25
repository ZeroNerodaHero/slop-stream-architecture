use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

#[derive(Serialize)]
pub struct Shareable {
    id: String,
    kind: &'static str,
    name: String,
    app: String,
    width: u32,
    height: u32,
    thumbnail: Option<String>,
}

#[derive(Default)]
pub struct Captures {
    next: Mutex<u32>,
    running: Mutex<HashMap<u32, platform::Running>>,
}

#[cfg(target_os = "macos")]
pub fn denied(e: impl std::fmt::Display) -> String {
    format!("nodentity is not allowed to record the screen and its sound ({e}). turn it on in System Settings, Privacy & Security, Screen & System Audio Recording, then open nodentity again")
}

#[tauri::command]
pub async fn list_capture_sources() -> Result<Vec<Shareable>, String> {
    platform::list()
}

#[tauri::command]
pub async fn start_screen_capture(
    state: State<'_, Captures>,
    id: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let running = platform::start(&id, channel)?;
    let handle = {
        let mut next = state.next.lock().map_err(|e| e.to_string())?;
        *next += 1;
        *next
    };
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(handle, running);
    Ok(handle)
}

#[tauri::command]
pub async fn stop_screen_capture(state: State<'_, Captures>, handle: u32) -> Result<(), String> {
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&handle);
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{sync_channel, SyncSender};
    use std::sync::Arc;
    use std::thread;

    use base64::Engine;
    use jpeg_encoder::{ColorType, Encoder};
    use screencapturekit::cm::SCFrameStatus;
    use screencapturekit::prelude::*;
    use screencapturekit::screenshot_manager::SCScreenshotManager;
    use screencapturekit::stream::delegate_trait::StreamCallbacks;
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::{denied, Shareable};

    const MAX_WIDTH: f64 = 1920.0;
    const FPS: u32 = 30;
    const THUMB_WIDTH: f64 = 320.0;
    const MIN_WIDTH: f64 = 120.0;
    const MIN_HEIGHT: f64 = 80.0;

    pub struct Running(SCStream);

    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.stop_capture();
        }
    }

    struct Frame {
        width: usize,
        height: usize,
        pixels: Vec<u8>,
    }

    enum Target {
        Display(SCDisplay, Vec<SCWindow>),
        Window(SCWindow),
    }

    impl Target {
        fn filter(&self) -> Result<SCContentFilter, String> {
            let built = match self {
                Self::Display(display, own) => {
                    let own: Vec<&SCWindow> = own.iter().collect();
                    SCContentFilter::create()
                        .with_display(display)
                        .with_excluding_windows(&own)
                        .build()
                }
                Self::Window(window) => SCContentFilter::create().with_window(window).build(),
            };
            built.map_err(|e| e.to_string())
        }

        fn points(&self) -> (f64, f64) {
            match self {
                Self::Display(display, _) => {
                    (f64::from(display.width()), f64::from(display.height()))
                }
                Self::Window(window) => {
                    let frame = window.frame();
                    (frame.size.width, frame.size.height)
                }
            }
        }
    }

    fn content() -> Result<SCShareableContent, String> {
        SCShareableContent::create()
            .with_on_screen_windows_only(true)
            .with_exclude_desktop_windows(true)
            .get()
            .map_err(denied)
    }

    fn mine(window: &SCWindow) -> bool {
        window
            .owning_application()
            .is_some_and(|app| app.process_id() == std::process::id() as i32)
    }

    fn worth_listing(window: &SCWindow) -> bool {
        let frame = window.frame();
        window.is_on_screen()
            && window.window_layer() == 0
            && frame.size.width >= MIN_WIDTH
            && frame.size.height >= MIN_HEIGHT
            && !mine(window)
    }

    fn size_within(width: f64, height: f64, max: f64) -> (u32, u32) {
        let scale = if width > max { max / width } else { 1.0 };
        let even = |v: f64| ((v * scale / 2.0).round() as u32 * 2).max(2);
        (even(width), even(height))
    }

    fn frame_of(sample: &CMSampleBuffer) -> Option<Frame> {
        let pixels = sample.pixel_buffer()?;
        let guard = pixels.lock_read_only().ok()?;
        let (width, height, stride) = (guard.width(), guard.height(), guard.bytes_per_row());
        let data = unsafe { guard.as_slice() }?;
        let row = width * 4;
        let mut packed = Vec::with_capacity(row * height);
        for line in data.chunks(stride).take(height) {
            packed.extend_from_slice(line.get(..row)?);
        }
        Some(Frame {
            width,
            height,
            pixels: packed,
        })
    }

    fn jpeg(frame: &Frame, quality: u8) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        Encoder::new(&mut out, quality)
            .encode(
                &frame.pixels,
                u16::try_from(frame.width).ok()?,
                u16::try_from(frame.height).ok()?,
                ColorType::Bgra,
            )
            .ok()?;
        Some(out)
    }

    fn thumbnail(target: &Target) -> Option<String> {
        let filter = target.filter().ok()?;
        let (w, h) = target.points();
        let (width, height) = size_within(w, h, THUMB_WIDTH);
        let config = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(false);
        let sample = SCScreenshotManager::capture_sample_buffer(&filter, &config).ok()?;
        let bytes = jpeg(&frame_of(&sample)?, 70)?;
        Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    fn targets() -> Result<Vec<(String, String, String, Target)>, String> {
        let content = content()?;
        let windows = content.windows();
        let own: Vec<SCWindow> = windows.iter().filter(|w| mine(w)).cloned().collect();
        let displays = content.displays();
        let many = displays.len() > 1;
        let mut out = Vec::new();
        for (i, display) in displays.into_iter().enumerate() {
            let name = if many {
                format!("screen {}", i + 1)
            } else {
                "screen".to_string()
            };
            out.push((
                format!("d:{}", display.display_id()),
                name,
                String::new(),
                Target::Display(display, own.clone()),
            ));
        }
        for window in windows.into_iter().filter(worth_listing) {
            let app = window
                .owning_application()
                .map(|a| a.application_name())
                .unwrap_or_default();
            let name = window
                .title()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| app.clone());
            if name.is_empty() {
                continue;
            }
            out.push((
                format!("w:{}", window.window_id()),
                name,
                app,
                Target::Window(window),
            ));
        }
        Ok(out)
    }

    pub fn list() -> Result<Vec<Shareable>, String> {
        let targets = targets()?;
        let thumbs: Vec<Option<String>> = thread::scope(|scope| {
            let jobs: Vec<_> = targets
                .iter()
                .map(|(_, _, _, target)| scope.spawn(move || thumbnail(target)))
                .collect();
            jobs.into_iter().map(|j| j.join().ok().flatten()).collect()
        });
        Ok(targets
            .into_iter()
            .zip(thumbs)
            .map(|((id, name, app, target), thumbnail)| {
                let (w, h) = target.points();
                Shareable {
                    kind: if matches!(target, Target::Display(..)) {
                        "display"
                    } else {
                        "window"
                    },
                    id,
                    name,
                    app,
                    width: w.round() as u32,
                    height: h.round() as u32,
                    thumbnail,
                }
            })
            .collect())
    }

    fn encoder(channel: Channel<InvokeResponseBody>, busy: Arc<AtomicBool>) -> SyncSender<Frame> {
        let (tx, rx) = sync_channel::<Frame>(1);
        thread::spawn(move || {
            while let Ok(frame) = rx.recv() {
                let sent =
                    jpeg(&frame, 80).map(|bytes| channel.send(InvokeResponseBody::Raw(bytes)));
                busy.store(false, Ordering::Release);
                if matches!(sent, Some(Err(_))) {
                    break;
                }
            }
        });
        tx
    }

    pub fn start(id: &str, channel: Channel<InvokeResponseBody>) -> Result<Running, String> {
        let target = targets()?
            .into_iter()
            .find(|(key, ..)| key == id)
            .map(|(.., target)| target)
            .ok_or("that screen or window is not there any more")?;
        let filter = target.filter()?;
        let scale = f64::from(filter.point_pixel_scale());
        let scale = if scale > 0.0 { scale } else { 2.0 };
        let (w, h) = target.points();
        let (width, height) = size_within(w * scale, h * scale, MAX_WIDTH);
        let config = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_fps(FPS)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(true)
            .with_queue_depth(5);
        let ended = channel.clone();
        let callbacks = StreamCallbacks::new().on_error(move |_| {
            let _ = ended.send(InvokeResponseBody::Raw(Vec::new()));
        });
        let busy = Arc::new(AtomicBool::new(false));
        let frames = encoder(channel, busy.clone());
        let mut stream =
            SCStream::new_with_delegate(&filter, &config, callbacks).map_err(|e| e.to_string())?;
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
                    if !matches!(kind, SCStreamOutputType::Screen)
                        || sample.frame_status() != Some(SCFrameStatus::Complete)
                    {
                        return;
                    }
                    if busy.swap(true, Ordering::AcqRel) {
                        return;
                    }
                    let sent =
                        frame_of(&sample).is_some_and(|frame| frames.try_send(frame).is_ok());
                    if !sent {
                        busy.store(false, Ordering::Release);
                    }
                },
                SCStreamOutputType::Screen,
            )
            .map_err(|e| e.to_string())?;
        stream.start_capture().map_err(denied)?;
        Ok(Running(stream))
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::Shareable;

    pub struct Running;

    pub fn list() -> Result<Vec<Shareable>, String> {
        Err("unsupported".into())
    }

    pub fn start(_id: &str, _channel: Channel<InvokeResponseBody>) -> Result<Running, String> {
        Err("unsupported".into())
    }
}
