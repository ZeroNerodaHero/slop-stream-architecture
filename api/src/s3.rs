//! One s3 bucket.
//!
//! `S3_ENDPOINT=off` (or empty) is the seaweedfs container in docker-compose: `http://s3:8333`,
//! bucket from `S3_BUCKET`, login `stream` / `stream-s3`. Those two are the literals on
//! the `s3` service, not `S3_ACCESS_KEY`. Startup waits until the bucket answers, the
//! same way postgres is waited on. The container creates the bucket; a missing one is
//! created here too.
//!
//! A url is someone else's bucket (aws, r2, another s3). The key and secret are
//! required, the bucket is not created here, and a miss is a warning: the api still
//! serves. `S3_PATH_STYLE` empty means path-style, except `*.amazonaws.com`, which
//! wants virtual-hosted. Profile pictures are `avatars/<name>.jpg`. Stream
//! thumbnails are `thumbs/<name>/<id>.jpg`.

use std::time::Duration;

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::OPTIONAL_PROBE;

/// Same literals as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` on the `s3` service.
const LOCAL_ENDPOINT: &str = "http://s3:8333";
const LOCAL_ACCESS_KEY: &str = "stream";
const LOCAL_SECRET_KEY: &str = "stream-s3";
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub(crate) struct Store {
    http: reqwest::Client,
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
    path_style: bool,
    /// The seaweedfs container. Startup waits until the bucket answers.
    local: bool,
}

struct Target {
    url: String,
    /// The Host header the signature covers. Includes a non-default port.
    host: String,
    canonical_uri: String,
}

pub(crate) fn from_env() -> Result<Store, String> {
    let endpoint = std::env::var("S3_ENDPOINT").unwrap_or_default();
    let bucket = std::env::var("S3_BUCKET").unwrap_or_else(|_| "stream".into());
    let region = std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into());
    let access = std::env::var("S3_ACCESS_KEY").unwrap_or_default();
    let secret = std::env::var("S3_SECRET_KEY").unwrap_or_default();
    let path_style = std::env::var("S3_PATH_STYLE").unwrap_or_default();
    let config = resolve(&endpoint, &bucket, &region, &access, &secret, &path_style)?;
    if config.ignored_keys {
        log::warn!("S3_ENDPOINT is off, so S3_ACCESS_KEY and S3_SECRET_KEY are ignored. set S3_ENDPOINT to a url to use them");
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("http client");
    Ok(Store {
        http,
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region,
        access_key: config.access_key,
        secret_key: config.secret_key,
        path_style: config.path_style,
        local: config.local,
    })
}

struct Resolved {
    endpoint: String,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
    path_style: bool,
    local: bool,
    ignored_keys: bool,
}

fn resolve(
    endpoint: &str,
    bucket: &str,
    region: &str,
    access: &str,
    secret: &str,
    path_style: &str,
) -> Result<Resolved, String> {
    let endpoint = endpoint.trim();
    let local = matches!(
        endpoint.to_ascii_lowercase().as_str(),
        "" | "off" | "0" | "false" | "no"
    );
    let bucket = bucket.trim();
    if bucket.is_empty() {
        return Err("S3_BUCKET is empty".into());
    }
    if !valid_bucket(bucket) {
        return Err(format!(
            "S3_BUCKET is {bucket:?}. use 3 to 63 of a-z 0-9 . -"
        ));
    }
    let region = {
        let r = region.trim();
        if r.is_empty() {
            "us-east-1"
        } else {
            r
        }
    };
    if local {
        return Ok(Resolved {
            endpoint: LOCAL_ENDPOINT.into(),
            bucket: bucket.to_owned(),
            region: region.to_owned(),
            access_key: LOCAL_ACCESS_KEY.into(),
            secret_key: LOCAL_SECRET_KEY.into(),
            path_style: true,
            local: true,
            ignored_keys: !access.trim().is_empty() || !secret.trim().is_empty(),
        });
    }
    let endpoint = normalize_endpoint(endpoint)?;
    let access = access.trim();
    let secret = secret.trim();
    if access.is_empty() || secret.is_empty() {
        return Err("S3_ENDPOINT is a url, so S3_ACCESS_KEY and S3_SECRET_KEY are required".into());
    }
    let path_style = match path_style.trim().to_ascii_lowercase().as_str() {
        "" => !amazon_host(&host_of(&endpoint)),
        "1" | "true" | "on" | "yes" => true,
        "0" | "false" | "off" | "no" => false,
        other => return Err(format!("S3_PATH_STYLE is {other:?}. use 1 or 0")),
    };
    Ok(Resolved {
        endpoint,
        bucket: bucket.to_owned(),
        region: region.to_owned(),
        access_key: access.to_owned(),
        secret_key: secret.to_owned(),
        path_style,
        local: false,
        ignored_keys: false,
    })
}

/// Create the container's bucket if it is missing, and do not return until it answers.
/// A real endpoint is checked once: a miss is logged and the api still starts.
pub(crate) async fn ensure(store: &Store) {
    if store.local {
        log::info!(
            "s3: the container at {}, bucket {}",
            store.endpoint,
            store.bucket
        );
        loop {
            match head_bucket(store).await {
                Ok(status) if (200..300).contains(&status) => {
                    log::info!("s3: bucket {} is there", store.bucket);
                    return;
                }
                Ok(404) => match create_bucket(store).await {
                    Ok(()) => {
                        log::info!("s3: created bucket {}", store.bucket);
                        return;
                    }
                    Err(e) => log::warn!("s3: could not create bucket {}: {e}", store.bucket),
                },
                Ok(status) => log::warn!("s3: bucket {} answered {status}", store.bucket),
                Err(e) => log::warn!("s3 not ready: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    log::info!("s3: {}, bucket {}", store.endpoint, store.bucket);
    match tokio::time::timeout(OPTIONAL_PROBE, head_bucket(store)).await {
        Ok(Ok(status)) if (200..300).contains(&status) => {
            log::info!("s3: bucket {} answers", store.bucket)
        }
        Ok(Ok(404)) => log::warn!(
            "s3: bucket {} is not there. create it on that account; this box will not",
            store.bucket
        ),
        Ok(Ok(status)) => log::warn!("s3: bucket {} answered {status}", store.bucket),
        Ok(Err(e)) => log::warn!("s3: {e}"),
        Err(_) => log::warn!("s3: no answer in {}ms", OPTIONAL_PROBE.as_millis()),
    }
}

/// 2xx from a HEAD of the bucket, inside the caller's timeout.
pub(crate) async fn ready(store: &Store) -> bool {
    matches!(head_bucket(store).await, Ok(status) if (200..300).contains(&status))
}

pub(crate) async fn put(
    store: &Store,
    key: &str,
    body: &[u8],
    content_type: &str,
) -> Result<(), String> {
    check_key(key)?;
    let res = send(store, "PUT", Some(key), body, Some(content_type)).await?;
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(format!(
        "s3 put {key}: {status} {}",
        clip(&res.text().await.unwrap_or_default())
    ))
}

/// `Ok(None)` is a missing key.
pub(crate) async fn get(store: &Store, key: &str) -> Result<Option<Vec<u8>>, String> {
    check_key(key)?;
    let res = send(store, "GET", Some(key), b"", None).await?;
    let status = res.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if (200..300).contains(&status) {
        return res
            .bytes()
            .await
            .map(|b| Some(b.to_vec()))
            .map_err(|e| e.to_string());
    }
    Err(format!(
        "s3 get {key}: {status} {}",
        clip(&res.text().await.unwrap_or_default())
    ))
}

/// A missing key is fine.
pub(crate) async fn delete(store: &Store, key: &str) -> Result<(), String> {
    check_key(key)?;
    let res = send(store, "DELETE", Some(key), b"", None).await?;
    let status = res.status().as_u16();
    if status == 404 || (200..300).contains(&status) {
        return Ok(());
    }
    Err(format!(
        "s3 delete {key}: {status} {}",
        clip(&res.text().await.unwrap_or_default())
    ))
}

async fn head_bucket(store: &Store) -> Result<u16, String> {
    let res = send(store, "HEAD", None, b"", None).await?;
    Ok(res.status().as_u16())
}

async fn create_bucket(store: &Store) -> Result<(), String> {
    // us-east-1 takes an empty body. the container signs as that region.
    let res = send(store, "PUT", None, b"", None).await?;
    let status = res.status().as_u16();
    if (200..300).contains(&status) || status == 409 {
        return Ok(());
    }
    Err(format!(
        "{status} {}",
        clip(&res.text().await.unwrap_or_default())
    ))
}

async fn send(
    store: &Store,
    method: &str,
    key: Option<&str>,
    body: &[u8],
    content_type: Option<&str>,
) -> Result<reqwest::Response, String> {
    let target = store.target(key)?;
    let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let payload_hash = sha256_hex(body);
    let mut headers = vec![
        ("host".to_owned(), target.host.clone()),
        ("x-amz-content-sha256".to_owned(), payload_hash.clone()),
        ("x-amz-date".to_owned(), amz_date.clone()),
    ];
    if let Some(ct) = content_type {
        headers.push(("content-type".to_owned(), ct.to_owned()));
    }
    let authorization = authorization(
        method,
        &target.canonical_uri,
        "",
        &headers,
        &payload_hash,
        &store.access_key,
        &store.secret_key,
        &store.region,
        &amz_date,
    );
    let http_method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = store
        .http
        .request(http_method, &target.url)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("authorization", authorization);
    if let Some(ct) = content_type {
        req = req.header("content-type", ct);
    }
    if method == "PUT" || method == "POST" {
        req = req.body(body.to_vec());
    }
    req.send().await.map_err(|e| e.to_string())
}

impl Store {
    fn target(&self, key: Option<&str>) -> Result<Target, String> {
        let (scheme, host) = split_endpoint(&self.endpoint)?;
        let key_path = match key {
            None => String::new(),
            Some(k) => format!("/{}", encode_key(k)),
        };
        let (host, canonical_uri) = if self.path_style {
            (
                host.to_owned(),
                format!("/{}{key_path}", uri_encode(&self.bucket)),
            )
        } else if key_path.is_empty() {
            (format!("{}.{host}", self.bucket), "/".to_owned())
        } else {
            (format!("{}.{host}", self.bucket), key_path)
        };
        Ok(Target {
            url: format!("{scheme}://{host}{canonical_uri}"),
            host,
            canonical_uri,
        })
    }
}

fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    let host = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))
        .ok_or_else(|| format!("S3_ENDPOINT is {endpoint:?}. it is off, or an http(s) url"))?;
    if host.is_empty() || host.contains('/') {
        return Err(format!("S3_ENDPOINT is {endpoint:?}. a host, not a path"));
    }
    Ok(endpoint.to_owned())
}

fn split_endpoint(endpoint: &str) -> Result<(&str, &str), String> {
    if let Some(host) = endpoint.strip_prefix("https://") {
        Ok(("https", host))
    } else if let Some(host) = endpoint.strip_prefix("http://") {
        Ok(("http", host))
    } else {
        Err(format!("S3_ENDPOINT is {endpoint:?}"))
    }
}

fn host_of(endpoint: &str) -> String {
    split_endpoint(endpoint)
        .map(|(_, host)| host.split('/').next().unwrap_or(host).to_owned())
        .unwrap_or_default()
}

fn amazon_host(host: &str) -> bool {
    let host = host.split(':').next().unwrap_or(host);
    host.ends_with(".amazonaws.com") || host.ends_with(".amazonaws.com.cn")
}

fn valid_bucket(name: &str) -> bool {
    let b = name.as_bytes();
    (3..=63).contains(&b.len())
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'.')
}

fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.starts_with('/')
        || key.ends_with('/')
        || key
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("bad s3 key {key:?}"));
    }
    Ok(())
}

fn clip(s: &str) -> String {
    let s = s.trim();
    s.chars().take(200).collect()
}

/// AWS sigv4, header auth, service `s3`. `headers` are lowercase names; this sorts them.
fn authorization(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(String, String)],
    payload_hash: &str,
    access_key: &str,
    secret_key: &str,
    region: &str,
    amz_date: &str,
) -> String {
    let mut headers = headers.to_vec();
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let signed: String = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical = format!("{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed}\n{payload_hash}");
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let key = signing_key(secret_key, date, region);
    let signature = hex_encode(&hmac_sha256(&key, string_to_sign.as_bytes()));
    format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope},SignedHeaders={signed},Signature={signature}")
}

fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&Sha256::digest(data))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

/// Encode one path segment the way sigv4 wants. `/` is left to the caller.
fn uri_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn encode_key(key: &str) -> String {
    key.split('/').map(uri_encode).collect::<Vec<_>>().join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_body_hashes_to_the_well_known_value() {
        assert_eq!(sha256_hex(b""), EMPTY_SHA256);
    }

    /// The GET Object example in the sigv4 docs.
    /// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    #[test]
    fn signs_the_aws_get_object_example() {
        let headers = vec![
            ("host".into(), "examplebucket.s3.amazonaws.com".into()),
            ("range".into(), "bytes=0-9".into()),
            ("x-amz-content-sha256".into(), EMPTY_SHA256.into()),
            ("x-amz-date".into(), "20130524T000000Z".into()),
        ];
        let got = authorization(
            "GET",
            "/test.txt",
            "",
            &headers,
            EMPTY_SHA256,
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "20130524T000000Z",
        );
        assert_eq!(
            got,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn off_is_the_container_and_ignores_a_real_key() {
        let c = resolve("off", "stream", "us-east-1", "AKIA", "secret", "0").unwrap();
        assert!(c.local);
        assert!(c.path_style);
        assert_eq!(c.endpoint, LOCAL_ENDPOINT);
        assert_eq!(c.access_key, LOCAL_ACCESS_KEY);
        assert_eq!(c.secret_key, LOCAL_SECRET_KEY);
        assert!(c.ignored_keys);
        let bare = resolve("  ", "stream", "", "", "", "").unwrap();
        assert!(bare.local);
        assert_eq!(bare.region, "us-east-1");
        assert!(!bare.ignored_keys);
    }

    #[test]
    fn a_url_uses_that_bucket() {
        let aws = resolve(
            "https://s3.us-east-1.amazonaws.com/",
            "my-bucket",
            "us-east-1",
            "AKIA",
            "secret",
            "",
        )
        .unwrap();
        assert!(!aws.local);
        assert!(!aws.path_style);
        assert_eq!(aws.endpoint, "https://s3.us-east-1.amazonaws.com");
        let r2 = resolve(
            "https://abc.r2.cloudflarestorage.com",
            "my-bucket",
            "auto",
            "key",
            "secret",
            "",
        )
        .unwrap();
        assert!(r2.path_style);
        let forced = resolve(
            "https://s3.us-east-1.amazonaws.com",
            "my-bucket",
            "us-east-1",
            "key",
            "secret",
            "1",
        )
        .unwrap();
        assert!(forced.path_style);
        assert!(resolve(
            "https://s3.us-east-1.amazonaws.com",
            "my-bucket",
            "us-east-1",
            "",
            "secret",
            ""
        )
        .is_err());
        assert!(resolve("ftp://x", "my-bucket", "us-east-1", "k", "s", "").is_err());
        assert!(resolve("off", "NO", "us-east-1", "", "", "").is_err());
    }

    #[test]
    fn path_style_url_keeps_the_port_in_the_host() {
        let c = resolve("off", "stream", "us-east-1", "", "", "").unwrap();
        let store = Store {
            http: reqwest::Client::new(),
            endpoint: c.endpoint,
            bucket: c.bucket,
            region: c.region,
            access_key: c.access_key,
            secret_key: c.secret_key,
            path_style: c.path_style,
            local: c.local,
        };
        let t = store.target(Some("a b/c")).unwrap();
        assert_eq!(t.url, "http://s3:8333/stream/a%20b/c");
        assert_eq!(t.host, "s3:8333");
        assert_eq!(t.canonical_uri, "/stream/a%20b/c");
        let root = store.target(None).unwrap();
        assert_eq!(root.url, "http://s3:8333/stream");
        assert_eq!(root.canonical_uri, "/stream");
    }

    #[test]
    fn virtual_host_puts_the_bucket_in_the_host() {
        let c = resolve(
            "https://s3.us-east-1.amazonaws.com",
            "my-bucket",
            "us-east-1",
            "k",
            "s",
            "0",
        )
        .unwrap();
        let store = Store {
            http: reqwest::Client::new(),
            endpoint: c.endpoint,
            bucket: c.bucket,
            region: c.region,
            access_key: c.access_key,
            secret_key: c.secret_key,
            path_style: c.path_style,
            local: c.local,
        };
        let t = store.target(Some("dir/file.txt")).unwrap();
        assert_eq!(
            t.url,
            "https://my-bucket.s3.us-east-1.amazonaws.com/dir/file.txt"
        );
        assert_eq!(t.host, "my-bucket.s3.us-east-1.amazonaws.com");
        assert_eq!(t.canonical_uri, "/dir/file.txt");
    }

    #[test]
    fn local_login_matches_the_compose_file() {
        let compose = include_str!("../../docker-compose.yml");
        assert!(
            compose.contains("AWS_ACCESS_KEY_ID: stream"),
            "s3.rs signs as stream"
        );
        assert!(
            compose.contains("AWS_SECRET_ACCESS_KEY: stream-s3"),
            "s3.rs signs with stream-s3"
        );
    }

    #[test]
    fn keys_reject_a_walk_up() {
        assert!(check_key("a/b").is_ok());
        assert!(check_key("../x").is_err());
        assert!(check_key("/a").is_err());
        assert!(check_key("a/").is_err());
        assert!(check_key("").is_err());
    }

    /// `cargo test -p api -- --ignored roundtrip` with the container published on 127.0.0.1:8333.
    #[tokio::test]
    #[ignore]
    async fn roundtrip_against_a_bucket() {
        let store = Store {
            http: reqwest::Client::new(),
            endpoint: "http://127.0.0.1:8333".into(),
            bucket: "stream".into(),
            region: "us-east-1".into(),
            access_key: LOCAL_ACCESS_KEY.into(),
            secret_key: LOCAL_SECRET_KEY.into(),
            path_style: true,
            local: true,
        };
        if head_bucket(&store).await.unwrap() == 404 {
            create_bucket(&store).await.unwrap();
        }
        let key = format!("roundtrip-{}", std::process::id());
        put(&store, &key, b"hello", "text/plain").await.unwrap();
        assert_eq!(
            get(&store, &key).await.unwrap().as_deref(),
            Some(&b"hello"[..])
        );
        delete(&store, &key).await.unwrap();
        assert!(get(&store, &key).await.unwrap().is_none());
    }
}
