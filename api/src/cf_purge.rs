//! Cloudflare's copy of a public picture or video, dropped when the api takes the thing down.
//! The edge keeps a public answer as long as its `Cache-Control` says (a day for a chat picture,
//! a year for an asset); a takedown that only empties the bucket would leave the edge serving it.
//! So each takedown of a public route names its urls here, and they are purged by url
//! (docs/cloudflare-cache-rules.md).
//!
//! CF_PURGE_TOKEN (Zone > Cache Purge on the one zone), CF_ZONE_ID, and PUBLIC_URL (the origin
//! the urls are under). Any of them unset or empty: off, a debug line per purge, nothing else.
//! A purge never holds up or fails the request that asked for it: it runs on its own task, gives
//! up after PURGE_TIMEOUT, and a failure is a warn line. Never a private (group or DM) url: those
//! answer `private, no-store`, the edge never kept them, and the caller does not name them.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::json;

/// The whole call to Cloudflare, connect to answer.
const PURGE_TIMEOUT: Duration = Duration::from_secs(3);
/// Urls per purge call: the most Cloudflare takes in one on the free plan.
const PER_CALL: usize = 30;

struct Config {
    token: String,
    zone: String,
    origin: String,
    http: reqwest::Client,
}

/// Read once. None: purging is off.
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

/// The absolute urls of `paths` (each starting `/`) under `origin`.
fn urls(origin: &str, paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| format!("{origin}{p}")).collect()
}

/// Purge `paths` (each starting `/`, query and all, as the page asks for it) from Cloudflare's
/// cache, on a task of its own. Returns at once.
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
