use std::sync::OnceLock;
use std::time::Duration;

use serde_json::json;

const PURGE_TIMEOUT: Duration = Duration::from_secs(3);
const PER_CALL: usize = 30;

struct Config {
    token: String,
    zone: String,
    origin: String,
    http: reqwest::Client,
}

fn config() -> Option<&'static Config> {
    static CONFIG: OnceLock<Option<Config>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let val = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
            let (token, zone, origin) = (val("CF_PURGE_TOKEN")?, val("CF_ZONE_ID")?, val("PUBLIC_URL")?);
            let http = reqwest::Client::builder().timeout(PURGE_TIMEOUT).build().ok()?;
            Some(Config { token, zone, origin: origin.trim_end_matches('/').to_owned(), http })
        })
        .as_ref()
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
            let sent = cf.http.post(&to).bearer_auth(&cf.token).json(&json!({ "files": chunk })).send().await;
            match sent {
                Ok(res) if res.status().is_success() => log::debug!("cf purge: {chunk:?}"),
                Ok(res) => {
                    let status = res.status();
                    let body = res.text().await.unwrap_or_default();
                    log::warn!("cf purge {chunk:?}: {status} {}", body.chars().take(300).collect::<String>());
                }
                Err(e) => log::warn!("cf purge {chunk:?}: {e}"),
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
}
