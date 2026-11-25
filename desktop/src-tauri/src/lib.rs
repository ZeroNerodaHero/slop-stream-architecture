mod audio;
mod capture;
mod mic;
mod pcm;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .manage(audio::DesktopAudio::default())
        .manage(mic::Mic::default())
        .manage(capture::Captures::default())
        .invoke_handler(tauri::generate_handler![
            audio::start_desktop_audio,
            audio::stop_desktop_audio,
            mic::list_input_devices,
            mic::start_mic,
            mic::stop_mic,
            capture::list_capture_sources,
            capture::start_screen_capture,
            capture::stop_screen_capture
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("nodentity failed to start");
}
