use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use url::Url;

const HOST: &str = "nodentity.xyz";
const PROVIDERS: [&str; 4] = ["google", "discord", "twitch", "kick"];
const EVENT: &str = "desktop-auth";

#[derive(Default)]
pub struct PendingAuth(Mutex<Option<String>>);

fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn login_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let plain = url.scheme() == "https"
        && url.host_str() == Some(HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    if !plain {
        return None;
    }
    let slug = url.path().strip_prefix("/api/oauth/")?.strip_suffix("/start")?;
    if !PROVIDERS.contains(&slug) {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next()?;
    if key != "desktop" || !is_token(&value) || pairs.next().is_some() {
        return None;
    }
    Some(url)
}

fn auth_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let plain = url.scheme() == "nodentity"
        && url.host_str() == Some("auth")
        && matches!(url.path(), "" | "/")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    if !plain {
        return None;
    }
    let (mut code, mut state, mut count) = (None, None, 0);
    for (key, value) in url.query_pairs() {
        count += 1;
        match key.as_ref() {
            "code" => code = Some(value),
            "state" => state = Some(value),
            _ => return None,
        }
    }
    let ok = count == 2 && code.is_some_and(|c| is_token(&c)) && state.is_some_and(|s| is_token(&s));
    ok.then(|| url.to_string())
}

#[tauri::command]
pub fn open_login<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let url = login_url(&url).ok_or_else(|| "that is not a login link".to_owned())?;
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, url);
        Err("no browser to open".to_owned())
    }
}

#[tauri::command]
pub fn take_desktop_auth(pending: State<'_, PendingAuth>) -> Option<String> {
    pending.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

pub fn focus<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn receive<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    let Some(url) = urls.iter().filter_map(|u| auth_url(u.as_str())).next_back() else { return };
    if let Some(pending) = app.try_state::<PendingAuth>() {
        *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.clone());
    }
    let _ = app.emit_to("main", EVENT, url);
    if let Some(window) = app.get_webview_window("main") {
        focus(&window);
    }
}

#[cfg(desktop)]
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
    if let Err(e) = app.deep_link().register_all() {
        eprintln!("deep link: could not register the nodentity scheme: {e}");
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| receive(&handle, &event.urls()));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, &urls);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_login_start_on_the_site_opens() {
        let t = "0a".repeat(32);
        for p in PROVIDERS {
            assert!(login_url(&format!("https://nodentity.xyz/api/oauth/{p}/start?desktop={t}")).is_some(), "{p}");
        }
        for bad in [
            format!("http://nodentity.xyz/api/oauth/google/start?desktop={t}"),
            format!("https://evil.example/api/oauth/google/start?desktop={t}"),
            format!("https://nodentity.xyz.evil.example/api/oauth/google/start?desktop={t}"),
            format!("https://me@nodentity.xyz/api/oauth/google/start?desktop={t}"),
            format!("https://nodentity.xyz:8443/api/oauth/google/start?desktop={t}"),
            format!("https://nodentity.xyz/api/oauth/github/start?desktop={t}"),
            format!("https://nodentity.xyz/api/oauth/google/callback?desktop={t}"),
            format!("https://nodentity.xyz/api/oauth/google/start?desktop={t}&link=1"),
            format!("https://nodentity.xyz/api/oauth/google/start?link=1&desktop={t}"),
            format!("https://nodentity.xyz/api/oauth/google/start?desktop={}", "0A".repeat(32)),
            format!("https://nodentity.xyz/api/oauth/google/start?desktop={t}#x"),
            "https://nodentity.xyz/api/oauth/google/start".to_owned(),
            "https://nodentity.xyz/api/oauth/google/start?desktop=abc".to_owned(),
            "file:///etc/passwd".to_owned(),
            "not a url".to_owned(),
        ] {
            assert!(login_url(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_an_auth_link_with_a_code_and_a_state_is_kept() {
        let (c, s) = ("1".repeat(64), "f".repeat(64));
        assert!(auth_url(&format!("nodentity://auth?code={c}&state={s}")).is_some());
        assert!(auth_url(&format!("nodentity://auth/?state={s}&code={c}")).is_some());
        for bad in [
            format!("nodentity://other?code={c}&state={s}"),
            format!("https://auth?code={c}&state={s}"),
            format!("nodentity://auth?code={c}"),
            format!("nodentity://auth?code={c}&state={s}&x=1"),
            format!("nodentity://auth?code={c}&state=short"),
            format!("nodentity://auth/path?code={c}&state={s}"),
        ] {
            assert!(auth_url(&bad).is_none(), "{bad}");
        }
    }
}
