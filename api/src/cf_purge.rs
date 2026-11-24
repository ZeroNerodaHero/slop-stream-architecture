use std::sync::OnceLock;
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::json;

const PURGE_TIMEOUT: Duration = Duration::from_secs(3);
const PER_CALL: usize = 30;
const VARS: [&str; 3] = ["CF_PURGE_TOKEN", "CF_ZONE_ID", "PUBLIC_URL"];

struct Config {
    token: String,
    zone: String,
    origin: String,
    http: reqwest::Client,
}

fn setting(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn config() -> Option<&'static Config> {
    static CONFIG: OnceLock<Option<Config>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let (token, zone, origin) = (setting("CF_PURGE_TOKEN")?, setting("CF_ZONE_ID")?, setting("PUBLIC_URL")?);
            let http = reqwest::Client::builder().timeout(PURGE_TIMEOUT).build().ok()?;
            Some(Config { token, zone, origin: origin.trim_end_matches('/').to_owned(), http })
        })
        .as_ref()
}

fn missing(get: impl Fn(&str) -> Option<String>) -> Vec<&'static str> {
    VARS.into_iter().filter(|k| get(k).is_none()).collect()
}

pub(crate) fn warn_if_off() {
    let gone = missing(setting);
    if !gone.is_empty() {
        log::warn!("cf purge off: {} unset, taken-down public chat media stays in the cdn until it expires", gone.join(", "));
    }
}

fn backoff(attempt: usize) -> Option<Duration> {
    match attempt {
        0 => Some(Duration::from_millis(500)),
        1 => Some(Duration::from_secs(2)),
        _ => None,
    }
}

fn retries(status: Option<StatusCode>) -> bool {
    status.is_none_or(|s| s == StatusCode::TOO_MANY_REQUESTS || s.is_server_error())
}

fn urls(origin: &str, paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| format!("{origin}{p}")).collect()
}

pub(crate) fn purge(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let Some(cf) = config() else {
        log::debug!("cf purge off (CF_PURGE_TOKEN, CF_ZONE_ID or PUBLIC_URL unset): not purging {paths:?}");
        return;
    };
    let files = urls(&cf.origin, &paths);
    tokio::spawn(async move {
        let to = format!("https://api.cloudflare.com/client/v4/zones/{}/purge_cache", cf.zone);
        for chunk in files.chunks(PER_CALL) {
            let mut attempt = 0;
            loop {
                let sent = cf.http.post(&to).bearer_auth(&cf.token).json(&json!({ "files": chunk })).send().await;
                let status = match sent {
                    Ok(res) if res.status().is_success() => {
                        log::debug!("cf purge: {chunk:?}");
                        break;
                    }
                    Ok(res) => {
                        let status = res.status();
                        let body = res.text().await.unwrap_or_default();
                        log::warn!("cf purge {chunk:?} try {}: {status} {}", attempt + 1, body.chars().take(300).collect::<String>());
                        Some(status)
                    }
                    Err(e) => {
                        log::warn!("cf purge {chunk:?} try {}: {e}", attempt + 1);
                        None
                    }
                };
                let Some(wait) = backoff(attempt).filter(|_| retries(status)) else { break };
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_under_the_origin() {
        assert_eq!(urls("https://nodentity.xyz", &["/api/chat-images/x".into()]), vec!["https://nodentity.xyz/api/chat-images/x".to_owned()]);
    }

    #[test]
    fn three_tries_at_most_with_a_growing_wait() {
        assert_eq!(backoff(0), Some(Duration::from_millis(500)));
        assert_eq!(backoff(1), Some(Duration::from_secs(2)));
        assert_eq!(backoff(2), None);
        assert_eq!((0..10).map_while(backoff).count() + 1, 3);
    }

    #[test]
    fn only_a_lost_call_a_429_or_a_5xx_is_tried_again() {
        for (status, want) in [
            (None, true),
            (Some(StatusCode::TOO_MANY_REQUESTS), true),
            (Some(StatusCode::INTERNAL_SERVER_ERROR), true),
            (Some(StatusCode::BAD_GATEWAY), true),
            (Some(StatusCode::SERVICE_UNAVAILABLE), true),
            (Some(StatusCode::BAD_REQUEST), false),
            (Some(StatusCode::UNAUTHORIZED), false),
            (Some(StatusCode::FORBIDDEN), false),
            (Some(StatusCode::NOT_FOUND), false),
        ] {
            assert_eq!(retries(status), want, "{status:?}");
        }
    }

    #[test]
    fn the_warning_names_what_is_unset() {
        assert_eq!(missing(|_| Some("x".into())), Vec::<&str>::new());
        assert_eq!(missing(|_| None), vec!["CF_PURGE_TOKEN", "CF_ZONE_ID", "PUBLIC_URL"]);
        assert_eq!(missing(|k| (k == "CF_ZONE_ID").then(|| "z".into())), vec!["CF_PURGE_TOKEN", "PUBLIC_URL"]);
    }
}
