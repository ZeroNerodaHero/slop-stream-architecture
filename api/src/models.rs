//! The demo models (docs/vtuber.md): a few `.vrm` files anyone may wear on the go live page,
//! so a person with no model of their own can try one. They live in the bucket under
//! `models/`, and the page's picker is one fetch: `GET /api/models` is the list (a name, an
//! author, a licence, whether there is a thumbnail), `GET /api/models/<id>` the file and
//! `GET /api/models/<id>/thumb` its picture. Nothing here is anyone's upload: a streamer's own
//! model stays in their browser.
//!
//! The files get into the bucket from a folder, `random-media/vrms` in the repo, with
//! `api models <dir>` (scripts/models.sh runs it in the api container, and deploy.sh runs that
//! when the folder changed). Each `<name>.vrm` there is a model, its id the file's name; a
//! picture beside it with the same name (`<name>.jpg`, `.png`, `.webp`) is its thumbnail, and
//! without one the model's own embedded thumbnail is used when it is small. The name, the
//! author and the licence are read from the file's own meta. The list is one object,
//! `models/index.json`, written last, so the page never lists a file that is not there; a
//! model taken out of the folder is taken out of the bucket.
//!
//! A `.vrm` is a glb: a 12 byte header, a json chunk, a binary chunk. This reads the header and
//! the json chunk and nothing else: no mesh and no picture is decoded (the thumbnail's bytes
//! are copied out as they are).

use std::collections::HashSet;
use std::ops::Range;
use std::path::Path as FsPath;
use std::time::Duration;

use axum::extract::{FromRef, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::s3;
use crate::ApiError;

const INDEX_KEY: &str = "models/index.json";
const MODEL_MIME: &str = "model/gltf-binary";
/// A file's url carries `?v=`, the start of its hash, so the bytes behind one url never change.
const FILE_CACHE: &str = "public, max-age=31536000, immutable";
/// The folder is ours, so these are for mistakes, not for strangers: a file bigger than any
/// model, a thumbnail that is really a photo, a list nobody would scroll.
const MAX_MODEL_BYTES: usize = 64 * 1024 * 1024;
const MAX_THUMB_BYTES: usize = 512 * 1024;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_MODELS: usize = 24;
const MAX_ID_BYTES: usize = 48;
const MAX_WORDS: usize = 80;
/// The gltf extensions that pack a file's meshes or pictures, and the word for each. The page draws none of them.
const PACKED: [(&str, &str); 3] = [("KHR_draco_mesh_compression", "draco"), ("EXT_meshopt_compression", "meshopt"), ("KHR_texture_basisu", "ktx2")];
/// A model is tens of megabytes, and the bucket may be far away: the bucket client's usual
/// 10 s is for pictures.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const GLB_MAGIC: &[u8; 4] = b"glTF";
const CHUNK_JSON: &[u8; 4] = b"JSON";
const CHUNK_BIN: &[u8; 4] = b"BIN\0";
const THUMB_EXTS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

/// One model of the list, as the page gets it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Entry {
    /// The file's name without `.vrm`, as a slug: the url.
    id: String,
    /// The model's own name, from its meta. The id when it has none.
    name: String,
    /// Who made it, from its meta. Empty when it does not say.
    author: String,
    /// The licence it names, in a few words. Empty when it does not say.
    licence: String,
    /// `0` or `1`: which vrm it is.
    vrm: String,
    bytes: u64,
    /// The start of the file's hash (the thumbnail's with it): the `?v=` of its urls.
    v: String,
    /// It has a thumbnail in the bucket.
    thumb: bool,
}

impl Entry {
    /// Whatever the bucket's list holds, the page is only handed rows it can draw and ask for.
    fn well_formed(&self) -> bool {
        valid_id(&self.id)
            && !self.name.is_empty()
            && self.name.chars().count() <= MAX_WORDS
            && self.author.chars().count() <= MAX_WORDS
            && self.licence.chars().count() <= MAX_WORDS
            && matches!(self.vrm.as_str(), "0" | "1")
            && self.v.len() == 12
            && self.v.bytes().all(|b| b.is_ascii_hexdigit())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    models: Vec<Entry>,
}

fn model_key(id: &str) -> String {
    format!("models/{id}.vrm")
}

fn thumb_key(id: &str) -> String {
    format!("models/{id}.thumb")
}

/// a-z 0-9 - _, 1 to 48: a file name's slug, and nothing a path could be made of.
fn valid_id(id: &str) -> bool {
    (1..=MAX_ID_BYTES).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn no_model() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such model")
}

fn bucket_failed(what: &str, err: String) -> ApiError {
    log::warn!("s3 models: {err}");
    ApiError::new(StatusCode::BAD_GATEWAY, what)
}

/// The three reads. They want the bucket and nothing else of the api's state, so they are
/// written against any state that can hand one over: the api's, and a test's bare bucket.
pub(crate) fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    s3::Store: FromRef<S>,
{
    Router::new()
        .route("/api/models", get(list))
        .route("/api/models/{id}", get(file))
        .route("/api/models/{id}/thumb", get(thumb))
}

/// The list. No object yet (nobody ran `api models`) is an empty list, not an error.
async fn list(State(store): State<s3::Store>) -> Result<Response, ApiError> {
    let index = match s3::get(&store, INDEX_KEY).await {
        Ok(Some(bytes)) => serde_json::from_slice::<Index>(&bytes).unwrap_or_else(|e| {
            log::warn!("s3 models: {INDEX_KEY} is not a list: {e}");
            Index::default()
        }),
        Ok(None) => Index::default(),
        Err(e) => return Err(bucket_failed("could not load the models", e)),
    };
    let models: Vec<Entry> = index.models.into_iter().filter(Entry::well_formed).take(MAX_MODELS).collect();
    Ok(([(header::CACHE_CONTROL, "no-cache")], Json(json!({ "models": models }))).into_response())
}

async fn file(State(store): State<s3::Store>, Path(id): Path<String>) -> Result<Response, ApiError> {
    if !valid_id(&id) {
        return Err(no_model());
    }
    match s3::get(&store, &model_key(&id)).await {
        Ok(Some(bytes)) => Ok((
            [(header::CONTENT_TYPE, MODEL_MIME), (header::CACHE_CONTROL, FILE_CACHE), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
            bytes,
        )
            .into_response()),
        Ok(None) => Err(no_model()),
        Err(e) => Err(bucket_failed("could not load the model", e)),
    }
}

async fn thumb(State(store): State<s3::Store>, Path(id): Path<String>) -> Result<Response, ApiError> {
    if !valid_id(&id) {
        return Err(no_model());
    }
    let bytes = match s3::get(&store, &thumb_key(&id)).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(no_model()),
        Err(e) => return Err(bucket_failed("could not load the picture", e)),
    };
    // the type is what the bytes are, not what a name said
    let Some(mime) = picture_mime(&bytes) else {
        return Err(no_model());
    };
    Ok(([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, FILE_CACHE), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes).into_response())
}

/// Png, jpeg or webp by the first bytes. Never svg: a script.
fn picture_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

// ---- reading a .vrm ---------------------------------------------------------------------

/// What a `.vrm` says about itself.
#[derive(Debug, PartialEq)]
struct VrmInfo {
    /// `0` (vrm 0.x) or `1` (vrm 1.0).
    version: &'static str,
    name: String,
    author: String,
    licence: String,
    /// Where its own thumbnail's bytes are in the file, when it has one.
    thumb: Option<Range<usize>>,
}

fn u32_at(b: &[u8], at: usize) -> Option<usize> {
    let four: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(four) as usize)
}

/// A string kept to one line and `MAX_WORDS` characters.
fn words(v: Option<&Value>) -> String {
    let s = v.and_then(Value::as_str).unwrap_or_default();
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_WORDS).collect()
}

/// The glb's header and json chunk: is it a vrm, what does it call itself, and where is its
/// thumbnail. `Err` says why not, for the person who put the file in the folder.
fn read_vrm(b: &[u8]) -> Result<VrmInfo, String> {
    if b.len() < 20 || &b[0..4] != GLB_MAGIC {
        return Err("not a glb".into());
    }
    if u32_at(b, 4) != Some(2) {
        return Err("not a gltf 2 file".into());
    }
    if u32_at(b, 8) != Some(b.len()) {
        return Err("cut short: it is not as long as it says".into());
    }
    let json_len = u32_at(b, 12).ok_or("no json chunk")?;
    if &b[16..20] != CHUNK_JSON || json_len > MAX_JSON_BYTES {
        return Err("no json chunk".into());
    }
    let json_end = 20usize.checked_add(json_len).filter(|end| *end <= b.len()).ok_or("the json chunk runs past the file")?;
    let doc: Value = serde_json::from_slice(&b[20..json_end]).map_err(|_| "the json chunk does not parse")?;
    // the binary chunk, when there is one: what a buffer view's offsets count from
    let bin: Option<Range<usize>> = u32_at(b, json_end).and_then(|len| {
        let start = json_end + 8;
        let end = start.checked_add(len)?;
        (b.get(json_end + 4..json_end + 8)? == CHUNK_BIN && end <= b.len()).then_some(start..end)
    });

    // a buffer or a picture named by url is fetched by whoever draws the file: a model has everything inside
    let outside = |list: &str| doc[list].as_array().is_some_and(|items| items.iter().any(|item| item.get("uri").is_some()));
    if outside("buffers") || outside("images") {
        return Err("it points outside the file (a uri)".into());
    }
    // what the page that draws it carries no decoder for (frontend/src/infra/vrm.ts): refused here, so the
    // picker never lists a model it would then refuse
    if let Some(needed) = doc["extensionsRequired"].as_array() {
        for (extension, packer) in PACKED {
            if needed.iter().any(|e| e.as_str() == Some(extension)) {
                return Err(format!("it is packed with {packer}, which the page does not unpack"));
            }
        }
    }

    let extensions = &doc["extensions"];
    let (version, name, author, licence, image) = if let Some(meta) = extensions["VRMC_vrm"].get("meta") {
        let authors = meta["authors"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let url = words(meta.get("licenseUrl"));
        let licence = if url.contains("vrm.dev/licenses/1.0") { "VRM Public License 1.0".to_owned() } else { url };
        ("1", words(meta.get("name")), words(Some(&Value::String(authors))), licence, meta["thumbnailImage"].as_u64())
    } else if let Some(meta) = extensions["VRM"].get("meta") {
        // 0.x names a licence by a word (`CC0`, `Redistribution_Prohibited`), and `Other` points at a url
        let named = words(meta.get("licenseName")).replace('_', " ");
        let licence = if named.eq_ignore_ascii_case("other") { words(meta.get("otherLicenseUrl")) } else { named };
        // its thumbnail is a texture, whose `source` is the picture
        let image = meta["texture"].as_u64().and_then(|t| doc["textures"][t as usize]["source"].as_u64());
        ("0", words(meta.get("title")), words(meta.get("author")), licence, image)
    } else {
        return Err("a glb, but not a vrm (no VRM or VRMC_vrm in it)".into());
    };

    // the picture's bytes: its buffer view, inside the binary chunk
    let thumb = image.zip(bin).and_then(|(image, bin)| {
        let view = &doc["bufferViews"][doc["images"][image as usize]["bufferView"].as_u64()? as usize];
        let start = bin.start.checked_add(view["byteOffset"].as_u64().unwrap_or(0) as usize)?;
        let end = start.checked_add(view["byteLength"].as_u64()? as usize)?;
        (start < end && end <= bin.end).then_some(start..end)
    });
    Ok(VrmInfo { version, name, author, licence, thumb })
}

/// A file's name as an id: lowercased, anything but a-z 0-9 - _ a dash, no dash doubled or at an end.
fn slug(stem: &str) -> String {
    let mut out = String::new();
    for c in stem.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(MAX_ID_BYTES).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A megabyte count for a person: `15.1 mb`.
fn mb(bytes: u64) -> String {
    format!("{:.1} mb", bytes as f64 / 1_000_000.0)
}

// ---- the folder into the bucket: `api models <dir>` ---------------------------------------

/// One model of the folder, read and ready to go up.
struct Local {
    entry: Entry,
    file: Vec<u8>,
    /// The thumbnail's bytes and where they came from (a file's name, or `the model's own`).
    thumb: Option<(Vec<u8>, String)>,
}

/// The picture beside `<stem>.vrm`, when there is one: `<stem>.jpg`, `.jpeg`, `.png` or `.webp`.
fn sidecar(dir: &FsPath, stem: &str) -> Result<Option<(Vec<u8>, String)>, String> {
    for ext in THUMB_EXTS {
        let name = format!("{stem}.{ext}");
        let path = dir.join(&name);
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("{name}: {e}"))?;
        if bytes.len() > MAX_THUMB_BYTES {
            return Err(format!("{name} is {} kb: a thumbnail is {} kb at most", bytes.len() / 1024, MAX_THUMB_BYTES / 1024));
        }
        if picture_mime(&bytes).is_none() {
            return Err(format!("{name} is not a png, jpeg or webp"));
        }
        return Ok(Some((bytes, name)));
    }
    Ok(None)
}

/// One `.vrm` of the folder: read, checked, named. `Err` is the line to print for it.
fn read_local(dir: &FsPath, path: &FsPath) -> Result<Local, String> {
    let stem = path.file_stem().and_then(|s| s.to_str()).ok_or("a name that is not text")?;
    let id = slug(stem);
    if !valid_id(&id) {
        return Err("no letters or digits in its name to make an id of".into());
    }
    let file = std::fs::read(path).map_err(|e| e.to_string())?;
    if file.len() > MAX_MODEL_BYTES {
        return Err(format!("{}: a model here is {} at most", mb(file.len() as u64), mb(MAX_MODEL_BYTES as u64)));
    }
    let info = read_vrm(&file)?;
    // the picture beside it, else its own when that is small enough to be a thumbnail
    let thumb = match sidecar(dir, stem)? {
        Some(found) => Some(found),
        None => info
            .thumb
            .clone()
            .map(|range| file[range].to_vec())
            .filter(|bytes| bytes.len() <= MAX_THUMB_BYTES && picture_mime(bytes).is_some())
            .map(|bytes| (bytes, "the model's own".to_owned())),
    };
    let mut hash = Sha256::new();
    hash.update(&file);
    if let Some((bytes, _)) = &thumb {
        hash.update(bytes);
    }
    let entry = Entry {
        name: if info.name.is_empty() { id.clone() } else { info.name },
        id,
        author: info.author,
        licence: info.licence,
        vrm: info.version.to_owned(),
        bytes: file.len() as u64,
        v: hex(&hash.finalize())[..12].to_owned(),
        thumb: thumb.is_some(),
    };
    Ok(Local { entry, file, thumb })
}

/// Every `.vrm` of `dir`, by name. The second list is the files refused, each with why.
fn read_folder(dir: &FsPath) -> Result<(Vec<Local>, Vec<String>), String> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("vrm")))
        .collect();
    paths.sort();
    let mut models: Vec<Local> = Vec::new();
    let mut refused = Vec::new();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_owned();
        match read_local(dir, &path) {
            Ok(local) if models.iter().any(|m| m.entry.id == local.entry.id) => refused.push(format!("{name}: another file here is already `{}`", local.entry.id)),
            Ok(_) if models.len() >= MAX_MODELS => refused.push(format!("{name}: {MAX_MODELS} models at most")),
            Ok(local) => models.push(local),
            Err(why) => refused.push(format!("{name}: {why}")),
        }
    }
    Ok((models, refused))
}

/// What a run has to do to the bucket: the ids whose bytes go up (new, or changed), and the
/// ids to take out (in the bucket's list, gone from the folder).
fn plan(old: &[Entry], new: &[Entry]) -> (Vec<String>, Vec<String>) {
    let put = new.iter().filter(|n| !old.contains(n)).map(|n| n.id.clone()).collect();
    let kept: HashSet<&str> = new.iter().map(|n| n.id.as_str()).collect();
    let gone = old.iter().filter(|o| valid_id(&o.id) && !kept.contains(o.id.as_str())).map(|o| o.id.clone()).collect();
    (put, gone)
}

/// `api models <dir> [--dry-run]`: the folder's models into the bucket, and the list after
/// them. `--dry-run` reads the folder, prints the list it would write and touches nothing (no
/// bucket needed, so it runs anywhere). The bucket only: no postgres, no redis.
pub(crate) async fn upload(args: &[String]) -> Result<(), String> {
    let dry = args.iter().any(|a| a == "--dry-run");
    let dirs: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [dir] = dirs[..] else {
        return Err("usage: api models <dir> [--dry-run]\n  <dir> holds the .vrm files, each with an optional picture of the same name beside it".into());
    };
    let dir = FsPath::new(dir);
    let (models, refused) = read_folder(dir)?;
    for line in &refused {
        println!("  SKIP  {line}");
    }
    let new: Vec<Entry> = models.iter().map(|m| m.entry.clone()).collect();
    if dry {
        for m in &models {
            println!("  would put  {}", describe(m));
        }
        println!("{}", serde_json::to_string_pretty(&Index { models: new }).map_err(|e| e.to_string())?);
        return if refused.is_empty() { Ok(()) } else { Err(format!("{} file(s) refused", refused.len())) };
    }

    let store = s3::from_env()?.with_timeout(UPLOAD_TIMEOUT);
    s3::ensure(&store).await;
    let old: Vec<Entry> = match s3::get(&store, INDEX_KEY).await? {
        Some(bytes) => serde_json::from_slice::<Index>(&bytes).map(|i| i.models).unwrap_or_default(),
        None => Vec::new(),
    };
    let (put, gone) = plan(&old, &new);
    for m in &models {
        let id = &m.entry.id;
        if !put.contains(id) {
            println!("  same  {}", describe(m));
            continue;
        }
        s3::put(&store, &model_key(id), &m.file, MODEL_MIME).await?;
        match &m.thumb {
            Some((bytes, _)) => s3::put(&store, &thumb_key(id), bytes, picture_mime(bytes).unwrap_or("application/octet-stream")).await?,
            // it had a picture before and has none now
            None => s3::delete(&store, &thumb_key(id)).await?,
        }
        println!("  put   {}", describe(m));
    }
    // the list after the files it names, and before the ones it stops naming go
    let body = serde_json::to_vec(&Index { models: new }).map_err(|e| e.to_string())?;
    s3::put(&store, INDEX_KEY, &body, "application/json").await?;
    for id in &gone {
        s3::delete(&store, &model_key(id)).await?;
        s3::delete(&store, &thumb_key(id)).await?;
        println!("  gone  {id}");
    }
    println!("models: {} in the bucket's list ({} put, {} taken out)", models.len(), put.len(), gone.len());
    if refused.is_empty() {
        Ok(())
    } else {
        Err(format!("{} file(s) refused (above). the rest went up", refused.len()))
    }
}

fn describe(m: &Local) -> String {
    let e = &m.entry;
    let by = if e.author.is_empty() { String::new() } else { format!(" by {}", e.author) };
    let licence = if e.licence.is_empty() { "no licence named" } else { &e.licence };
    let thumb = m.thumb.as_ref().map_or("no thumbnail".to_owned(), |(_, from)| format!("thumbnail: {from}"));
    format!("{:<24} {}{by}, vrm {}, {}, {licence}, {thumb}", e.id, e.name, if e.vrm == "0" { "0.x" } else { "1.0" }, mb(e.bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

    /// A glb of `json` and `bin`, each padded to four bytes the way the format wants.
    fn glb(json: &Value, bin: &[u8]) -> Vec<u8> {
        let mut text = serde_json::to_vec(json).unwrap();
        while text.len() % 4 != 0 {
            text.push(b' ');
        }
        let mut data = bin.to_vec();
        while data.len() % 4 != 0 {
            data.push(0);
        }
        let total = 12 + 8 + text.len() + if data.is_empty() { 0 } else { 8 + data.len() };
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(GLB_MAGIC);
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(CHUNK_JSON);
        out.extend_from_slice(&text);
        if !data.is_empty() {
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(CHUNK_BIN);
            out.extend_from_slice(&data);
        }
        out
    }

    /// A vrm 0.x whose thumbnail is the png at byte 4 of the binary chunk, behind a texture.
    fn vrm0() -> Vec<u8> {
        let mut bin = vec![9, 9, 9, 9];
        bin.extend_from_slice(&PNG);
        glb(
            &json!({
                "asset": { "version": "2.0" },
                "buffers": [{ "byteLength": bin.len() }],
                "bufferViews": [{ "buffer": 0, "byteOffset": 4, "byteLength": PNG.len() }],
                "images": [{ "bufferView": 0, "mimeType": "image/png" }],
                "textures": [{ "source": 0 }],
                "extensions": { "VRM": { "meta": { "title": "  Sendagaya   Shino ", "author": "", "licenseName": "Redistribution_Prohibited", "texture": 0 } } }
            }),
            &bin,
        )
    }

    fn vrm1() -> Vec<u8> {
        glb(
            &json!({
                "asset": { "version": "2.0" },
                "buffers": [{ "byteLength": PNG.len() }],
                "bufferViews": [{ "buffer": 0, "byteLength": PNG.len() }],
                "images": [{ "bufferView": 0 }],
                "extensions": { "VRMC_vrm": { "specVersion": "1.0", "meta": { "name": "Seed-san", "authors": ["VirtualCast, Inc.", "someone"], "licenseUrl": "https://vrm.dev/licenses/1.0/", "thumbnailImage": 0 } } }
            }),
            &PNG,
        )
    }

    #[test]
    fn a_vrm_says_its_name_its_author_its_licence_and_where_its_thumbnail_is() {
        let file = vrm0();
        let info = read_vrm(&file).expect("a vrm 0.x");
        assert_eq!((info.version, info.name.as_str(), info.author.as_str(), info.licence.as_str()), ("0", "Sendagaya Shino", "", "Redistribution Prohibited"));
        assert_eq!(&file[info.thumb.expect("its thumbnail")], &PNG);

        let file = vrm1();
        let info = read_vrm(&file).expect("a vrm 1.0");
        assert_eq!((info.version, info.name.as_str(), info.author.as_str(), info.licence.as_str()), ("1", "Seed-san", "VirtualCast, Inc., someone", "VRM Public License 1.0"));
        assert_eq!(&file[info.thumb.expect("its thumbnail")], &PNG);
    }

    #[test]
    fn what_is_not_a_vrm_is_refused_with_why() {
        assert_eq!(read_vrm(b"<svg></svg>").unwrap_err(), "not a glb");
        assert_eq!(read_vrm(&[]).unwrap_err(), "not a glb");
        // a glb with no vrm in it
        let plain = glb(&json!({ "asset": { "version": "2.0" } }), &[]);
        assert!(read_vrm(&plain).unwrap_err().contains("not a vrm"));
        // cut short: the header still says the whole length
        let file = vrm1();
        assert!(read_vrm(&file[..file.len() - 4]).unwrap_err().contains("cut short"));
        // version 1 of gltf
        let mut old = vrm1();
        old[4] = 1;
        assert_eq!(read_vrm(&old).unwrap_err(), "not a gltf 2 file");
        // a json chunk that says it is longer than the file
        let mut long = vrm1();
        long[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read_vrm(&long).is_err());
    }

    #[test]
    fn a_model_that_points_outside_the_file_is_refused() {
        let meta = json!({ "VRM": { "meta": { "title": "x" } } });
        let picture = glb(&json!({ "images": [{ "uri": "https://elsewhere.example/a.png" }], "extensions": meta }), &[]);
        assert!(read_vrm(&picture).unwrap_err().contains("outside the file"));
        let buffer = glb(&json!({ "buffers": [{ "uri": "data.bin", "byteLength": 4 }], "extensions": meta }), &[]);
        assert!(read_vrm(&buffer).unwrap_err().contains("outside the file"));
    }

    #[test]
    fn a_model_the_page_cannot_unpack_is_refused() {
        let meta = json!({ "VRMC_vrm": { "meta": { "name": "x" } } });
        for (extension, packer) in PACKED {
            let packed = glb(&json!({ "extensionsRequired": [extension], "extensions": meta }), &[]);
            assert!(read_vrm(&packed).unwrap_err().contains(packer), "{extension}");
        }
        // one it only uses where it can, and one the page reads: neither is a reason
        let fine = glb(&json!({ "extensionsUsed": ["KHR_draco_mesh_compression"], "extensionsRequired": ["VRMC_vrm"], "extensions": meta }), &[]);
        assert!(read_vrm(&fine).is_ok());
    }

    #[test]
    fn a_thumbnail_that_is_not_inside_the_file_is_no_thumbnail() {
        // the view runs past the binary chunk
        let file = glb(
            &json!({
                "bufferViews": [{ "buffer": 0, "byteOffset": 8, "byteLength": 400 }],
                "images": [{ "bufferView": 0 }],
                "extensions": { "VRMC_vrm": { "meta": { "name": "x", "thumbnailImage": 0 } } }
            }),
            &PNG,
        );
        assert_eq!(read_vrm(&file).expect("still a vrm").thumb, None);
        // an index with nothing behind it, and a model with no binary chunk at all
        let file = glb(&json!({ "extensions": { "VRMC_vrm": { "meta": { "name": "x", "thumbnailImage": 7 } } } }), &[]);
        assert_eq!(read_vrm(&file).expect("still a vrm").thumb, None);
    }

    #[test]
    fn ids_are_slugs_of_the_file_name() {
        assert_eq!(slug("Sendagaya_Shino"), "sendagaya_shino");
        assert_eq!(slug("  VRM1 Constraint  Twist (Sample).v2 "), "vrm1-constraint-twist-sample-v2");
        assert_eq!(slug("--a--"), "a");
        assert_eq!(slug("日本語"), "");
        assert!(valid_id("seed-san") && valid_id("a_1"));
        for bad in ["", "Seed", "a b", "../x", "a/b", "a.vrm", &"a".repeat(49)] {
            assert!(!valid_id(bad), "{bad:?} passed");
        }
    }

    #[test]
    fn pictures_are_told_by_their_first_bytes() {
        assert_eq!(picture_mime(&PNG), Some("image/png"));
        assert_eq!(picture_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(picture_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(picture_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(picture_mime(b"GIF89a"), None);
    }

    fn entry(id: &str, v: &str) -> Entry {
        Entry { id: id.into(), name: id.into(), author: String::new(), licence: "CC0".into(), vrm: "0".into(), bytes: 10, v: v.into(), thumb: true }
    }

    #[test]
    fn a_run_puts_what_changed_and_takes_out_what_left_the_folder() {
        let old = [entry("a", "000000000001"), entry("b", "000000000002"), entry("c", "000000000003")];
        // a is as it was, b's bytes changed, c is gone, d is new
        let new = [entry("a", "000000000001"), entry("b", "00000000000f"), entry("d", "000000000004")];
        let (put, gone) = plan(&old, &new);
        assert_eq!(put, ["b", "d"]);
        assert_eq!(gone, ["c"]);
        // nothing in the bucket yet: everything goes up, nothing to take out
        assert_eq!(plan(&[], &new), (vec!["a".to_owned(), "b".to_owned(), "d".to_owned()], vec![]));
        // a list in the bucket with an id that is no id is never turned into a delete
        assert_eq!(plan(&[entry("../avatars", "000000000001")], &[]).1, Vec::<String>::new());
    }

    #[test]
    fn the_page_is_only_handed_rows_it_can_ask_for() {
        assert!(entry("seed-san", "0123456789ab").well_formed());
        assert!(!entry("../x", "0123456789ab").well_formed());
        assert!(!entry("a", "short").well_formed());
        assert!(!entry("a", "0123456789zz").well_formed());
        assert!(!Entry { vrm: "2".into(), ..entry("a", "0123456789ab") }.well_formed());
        assert!(!Entry { name: String::new(), ..entry("a", "0123456789ab") }.well_formed());
    }

    /// A stand-in bucket on this machine: the objects in a map, answered path-style the way s3 answers a GET.
    async fn bucket(objects: Vec<(&'static str, Vec<u8>)>) -> s3::Store {
        use std::collections::HashMap;
        use std::sync::Arc;
        let objects: Arc<HashMap<String, Vec<u8>>> = Arc::new(objects.into_iter().map(|(key, bytes)| (format!("/stream/{key}"), bytes)).collect());
        let app = Router::new().fallback(move |uri: axum::http::Uri| {
            let objects = objects.clone();
            async move {
                match objects.get(uri.path()) {
                    Some(bytes) => (StatusCode::OK, bytes.clone()).into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }
        });
        s3::Store::for_test(&listen(app).await)
    }

    /// `app` on a port of its own, and where it is.
    async fn listen(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn the_three_routes_read_the_bucket() {
        let listed = [entry("seed-san", "0123456789ab"), entry("orion", "ba9876543210")];
        // a row that is no row is in the bucket's list too: the page never sees it
        let mut in_bucket = listed.to_vec();
        in_bucket.push(entry("../avatars", "0123456789ab"));
        let store = bucket(vec![
            ("models/index.json", serde_json::to_vec(&Index { models: in_bucket }).unwrap()),
            ("models/seed-san.vrm", vrm1()),
            ("models/seed-san.thumb", PNG.to_vec()),
            ("models/script.thumb", b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>".to_vec()),
        ])
        .await;
        let api = listen(routes::<s3::Store>().with_state(store)).await;
        let http = reqwest::Client::new();
        let get = |path: &'static str| http.get(format!("{api}{path}")).send();
        let head = |res: &reqwest::Response, name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();

        let res = get("/api/models").await.unwrap();
        assert_eq!((res.status().as_u16(), head(&res, "cache-control").as_str()), (200, "no-cache"));
        let body: Value = res.json().await.unwrap();
        assert_eq!(body, json!({ "models": listed }));

        let res = get("/api/models/seed-san").await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(head(&res, "content-type"), MODEL_MIME);
        assert_eq!(head(&res, "cache-control"), FILE_CACHE);
        assert_eq!(head(&res, "x-content-type-options"), "nosniff");
        assert_eq!(res.bytes().await.unwrap().to_vec(), vrm1());

        let res = get("/api/models/seed-san/thumb").await.unwrap();
        assert_eq!((res.status().as_u16(), head(&res, "content-type").as_str()), (200, "image/png"));
        assert_eq!(res.bytes().await.unwrap().to_vec(), PNG.to_vec());

        // not there, not an id, and a thumbnail whose bytes are no picture: all the same 404
        for path in ["/api/models/nope", "/api/models/orion/thumb", "/api/models/Seed%20San", "/api/models/..%2Favatars", "/api/models/script/thumb"] {
            let res = get(path).await.unwrap();
            assert_eq!(res.status(), 404, "{path}");
            assert_eq!(res.json::<Value>().await.unwrap(), json!({ "error": "no such model" }), "{path}");
        }
    }

    #[tokio::test]
    async fn no_list_in_the_bucket_is_an_empty_list_and_no_bucket_is_a_502() {
        let empty = listen(routes::<s3::Store>().with_state(bucket(vec![]).await)).await;
        let res = reqwest::get(format!("{empty}/api/models")).await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.json::<Value>().await.unwrap(), json!({ "models": [] }));

        // a list that is not a list (someone wrote the object by hand) is an empty list too
        let garbled = listen(routes::<s3::Store>().with_state(bucket(vec![("models/index.json", b"{ nope".to_vec())]).await)).await;
        assert_eq!(reqwest::get(format!("{garbled}/api/models")).await.unwrap().json::<Value>().await.unwrap(), json!({ "models": [] }));

        // nothing listening where the bucket should be: a port that was just given back
        let gone = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        let down = listen(routes::<s3::Store>().with_state(s3::Store::for_test(&format!("http://{gone}")))).await;
        let res = reqwest::get(format!("{down}/api/models")).await.unwrap();
        assert_eq!(res.status(), 502);
        assert_eq!(res.json::<Value>().await.unwrap(), json!({ "error": "could not load the models" }));
    }

    #[test]
    fn a_folder_is_read_with_the_picture_beside_each_model() {
        let dir = std::env::temp_dir().join(format!("api-models-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Zero Model.vrm"), vrm0()).unwrap();
        std::fs::write(dir.join("one.vrm"), vrm1()).unwrap();
        std::fs::write(dir.join("one.jpg"), [0xFF, 0xD8, 0xFF, 0xE0, 1, 2]).unwrap();
        std::fs::write(dir.join("broken.vrm"), b"nope").unwrap();
        std::fs::write(dir.join("notes.txt"), b"not a model").unwrap();
        let (models, refused) = read_folder(&dir).expect("the folder");
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(models.iter().map(|m| m.entry.id.as_str()).collect::<Vec<_>>(), ["zero-model", "one"]);
        assert_eq!(refused, ["broken.vrm: not a glb"]);
        // the picture beside it wins over the model's own
        let one = &models[1];
        assert_eq!(one.thumb.as_ref().map(|(bytes, from)| (bytes[..3].to_vec(), from.as_str())), Some((vec![0xFF, 0xD8, 0xFF], "one.jpg")));
        assert_eq!((one.entry.name.as_str(), one.entry.vrm.as_str(), one.entry.thumb), ("Seed-san", "1", true));
        // none beside it: the model's own
        let zero = &models[0];
        assert_eq!(zero.thumb.as_ref().map(|(bytes, from)| (bytes.clone(), from.as_str())), Some((PNG.to_vec(), "the model's own")));
        assert!(zero.entry.well_formed() && one.entry.well_formed());
        assert_ne!(zero.entry.v, one.entry.v);
    }
}
