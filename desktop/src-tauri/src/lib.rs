mod audio;
mod capture;
mod login;
mod mic;
mod pcm;
mod restream;
mod rtmp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                login::focus(&window);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());
    builder
        .plugin(tauri_plugin_process::init())
        .manage(audio::DesktopAudio::default())
        .manage(mic::Mic::default())
        .manage(capture::Captures::default())
        .manage(restream::Direct::default())
        .manage(login::PendingAuth::default())
        .invoke_handler(tauri::generate_handler![
            audio::start_desktop_audio,
            audio::stop_desktop_audio,
            mic::list_input_devices,
            mic::start_mic,
            mic::stop_mic,
            capture::list_capture_sources,
            capture::start_screen_capture,
            capture::stop_screen_capture,
            capture::resize_screen_capture,
            restream::restream_direct_ready,
            restream::restream_direct_start,
            restream::restream_direct_packet,
            restream::restream_direct_status,
            restream::restream_direct_stop,
            login::open_login,
            login::take_desktop_auth
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                login::install(app.handle());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("nodentity failed to start");
}
