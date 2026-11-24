use std::time::Duration;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{ApiError, AppState};

const SITEVERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_CHARS: usize = 2048;
const SITEVERIFY_TIMEOUT: Duration = Duration::from_secs(10);
const MISSING: &str = "human check missing. try again";
const FAILED: &str = "human check failed. try again";

#[derive(Clone, Default)]
pub(crate) struct Config {
    keys: Option<Keys>,
}

#[derive(Clone)]
struct Keys {
    site_key: String,
    secret: String,
}

impl Config {
    pub(crate) fn from_env() -> Self {
        let config = Self::from_vars(|k| std::env::var(k).ok());
        if config.enabled() {
            log::info!("turnstile: on for signup and login");
        } else {
            log::info!("turnstile: off");
        }
        config
    }

    fn from_vars(get: impl Fn(&str) -> Option<String>) -> Self {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let flag = val("TURNSTILE_ENABLED").is_some_and(|v| v.eq_ignore_ascii_case("true") || v == "1");
        if !flag {
            return Config::default();
        }
        match (val("TURNSTILE_SITE_KEY"), val("TURNSTILE_SECRET")) {
            (Some(site_key), Some(secret)) => Config { keys: Some(Keys { site_key, secret }) },
            _ => {
                log::error!("turnstile: TURNSTILE_ENABLED is on but TURNSTILE_SITE_KEY or TURNSTILE_SECRET is not set, so it is off");
                Config::default()
            }
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.keys.is_some()
    }

    fn public(&self) -> Value {
        json!({ "enabled": self.enabled(), "siteKey": self.keys.as_ref().map(|k| k.site_key.as_str()) })
    }
}

fn usable_token(token: Option<&str>) -> Option<&str> {
    token.map(str::trim).filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN_CHARS)
}

#[derive(Deserialize)]
struct Answer {
    success: bool,
    #[serde(default, rename = "error-codes")]
    error_codes: Vec<String>,
}

fn passed(body: &str) -> Result<bool, String> {
    let answer: Answer = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if !answer.success {
        log::info!("turnstile: refused {:?}", answer.error_codes);
    }
    Ok(answer.success)
}

pub(crate) async fn verify(s: &AppState, token: Option<&str>, ip: &str) -> Result<(), ApiError> {
    let Some(keys) = &s.turnstile.keys else { return Ok(()) };
    let Some(token) = usable_token(token) else {
        return Err(ApiError::new(StatusCode::FORBIDDEN, MISSING));
    };
    let failed = || ApiError::new(StatusCode::FORBIDDEN, FAILED);
    let form = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("secret", &keys.secret).append_pair("response", token);
        if ip != "?" {
            form.append_pair("remoteip", ip);
        }
        form.finish()
    };
    let res = s
        .http
        .post(SITEVERIFY_URL)
        .timeout(SITEVERIFY_TIMEOUT)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| {
            log::warn!("turnstile: siteverify: {e}");
            failed()
        })?;
    if !res.status().is_success() {
        log::warn!("turnstile: siteverify: http {}", res.status());
        return Err(failed());
    }
    let body = res.text().await.map_err(|e| {
        log::warn!("turnstile: siteverify body: {e}");
        failed()
    })?;
    match passed(&body) {
        Ok(true) => Ok(()),
        Ok(false) => Err(failed()),
        Err(e) => {
            log::warn!("turnstile: siteverify body: {e}");
            Err(failed())
        }
    }
}

async fn public_config(State(s): State<AppState>) -> Json<Value> {
    Json(s.turnstile.public())
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/config/turnstile", get(public_config))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_vars(|k| map.get(k).cloned())
    }

    const KEYS: [(&str, &str); 2] = [("TURNSTILE_SITE_KEY", "1x00000000000000000000AA"), ("TURNSTILE_SECRET", "1x0000000000000000000000000000000AA")];

    #[test]
    fn on_only_with_the_flag_and_both_keys() {
        assert!(!vars(&[]).enabled(), "nothing set");
        assert!(!vars(&KEYS).enabled(), "keys without the flag");
        for on in ["true", "1", "TRUE", " true "] {
            assert!(vars(&[("TURNSTILE_ENABLED", on), KEYS[0], KEYS[1]]).enabled(), "{on:?}");
        }
        for off in ["false", "0", "yes", ""] {
            assert!(!vars(&[("TURNSTILE_ENABLED", off), KEYS[0], KEYS[1]]).enabled(), "{off:?}");
        }
        assert!(!vars(&[("TURNSTILE_ENABLED", "true"), KEYS[0]]).enabled(), "no secret");
        assert!(!vars(&[("TURNSTILE_ENABLED", "true"), KEYS[1]]).enabled(), "no site key");
        assert!(!vars(&[("TURNSTILE_ENABLED", "1"), ("TURNSTILE_SITE_KEY", " "), KEYS[1]]).enabled(), "a blank key is no key");
    }

    #[test]
    fn the_public_config_never_carries_the_secret() {
        let on = vars(&[("TURNSTILE_ENABLED", "true"), KEYS[0], KEYS[1]]).public();
        assert_eq!(on, json!({ "enabled": true, "siteKey": "1x00000000000000000000AA" }));
        assert!(!on.to_string().contains(KEYS[1].1));
        assert_eq!(vars(&[]).public(), json!({ "enabled": false, "siteKey": null }));
    }

    #[test]
    fn siteverify_passes_only_on_success_true() {
        assert_eq!(passed(r#"{"success":true,"challenge_ts":"2026-01-01T00:00:00Z","hostname":"nodentity.xyz","error-codes":[]}"#), Ok(true));
        assert_eq!(passed(r#"{"success":false,"error-codes":["invalid-input-response"]}"#), Ok(false));
        assert_eq!(passed(r#"{"success":false}"#), Ok(false));
        assert!(passed(r#"{"success":"true"}"#).is_err(), "a string is not true");
        assert!(passed(r#"{"error-codes":[]}"#).is_err(), "no success at all");
        assert!(passed("<html>bad gateway</html>").is_err());
        assert!(passed("").is_err());
    }

    #[test]
    fn a_token_is_there_and_at_most_2048_characters() {
        assert_eq!(usable_token(None), None);
        assert_eq!(usable_token(Some("")), None);
        assert_eq!(usable_token(Some("   ")), None);
        let longest = "a".repeat(MAX_TOKEN_CHARS);
        assert_eq!(usable_token(Some(&longest)), Some(longest.as_str()));
        assert_eq!(usable_token(Some(&"a".repeat(MAX_TOKEN_CHARS + 1))), None);
        assert_eq!(usable_token(Some(" tok ")), Some("tok"));
    }
}
