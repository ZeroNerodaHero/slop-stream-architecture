use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::rtmp::{Restream, Shape, Status, Target};

#[derive(Default)]
pub struct Direct {
    running: Mutex<Option<Restream>>,
}

#[tauri::command]
pub fn restream_direct_ready() -> u32 {
    1
}

#[tauri::command]
pub async fn restream_direct_start(
    state: State<'_, Direct>,
    targets: Vec<Target>,
    shape: Shape,
) -> Result<(), String> {
    let next = Restream::start(targets, shape);
    let old = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .replace(next);
    drop(old);
    Ok(())
}

#[tauri::command]
pub async fn restream_direct_packet(
    state: State<'_, Direct>,
    request: Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("send the packet as bytes".into());
    };
    match state.running.lock().map_err(|e| e.to_string())?.as_ref() {
        Some(r) => r.push(raw),
        None => Err("not sending".into()),
    }
}

#[tauri::command]
pub async fn restream_direct_status(state: State<'_, Direct>) -> Result<Vec<Status>, String> {
    Ok(state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(Restream::statuses)
        .unwrap_or_default())
}

#[tauri::command]
pub async fn restream_direct_stop(state: State<'_, Direct>) -> Result<(), String> {
    let old = state.running.lock().map_err(|e| e.to_string())?.take();
    drop(old);
    Ok(())
}
