use serde_json::Value;
use url::Url;

use crate::og::{self, Page, DESCRIPTION_CHARS, TITLE_CHARS};

const SITE: &str = "Wikipedia";
const NAMESPACES: [&str; 20] = [
    "special", "talk", "user", "wikipedia", "wp", "project", "file", "image", "media", "mediawiki", "template", "help", "category", "portal", "draft", "module", "timedtext", "book", "gadget", "topic",
];

pub(crate) fn summary_url(url: &Url) -> Option<Url> {
    let host = url.host_str()?.to_ascii_lowercase();
    let lang = host.strip_suffix(".wikipedia.org")?;
    let lang = lang.strip_suffix(".m").unwrap_or(lang);
    if lang.is_empty() || lang == "www" || lang == "m" || !lang.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return None;
    }
    let title = url.path().strip_prefix("/wiki/")?;
    if title.is_empty() || !is_article(title) {
        return None;
    }
    let title = title.replace('/', "%2F");
    Url::parse(&format!("https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}")).ok()
}

fn is_article(title: &str) -> bool {
    let decoded = percent_decode(title);
    let Some((prefix, _)) = decoded.split_once(':') else { return true };
    let prefix = prefix.trim().to_lowercase().replace(' ', "_");
    let space = prefix.strip_suffix("_talk").unwrap_or(&prefix);
    !NAMESPACES.contains(&space) && prefix != "talk"
}

fn percent_decode(raw: &str) -> String {
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let Some(v) = raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'_' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn parse_summary(json: &[u8], base: &Url) -> Option<Page> {
    let v: Value = serde_json::from_slice(json).ok()?;
    let text = |key: &str, max: usize| v.get(key).and_then(Value::as_str).map(|s| og::plain(s, max)).filter(|s| !s.is_empty());
    let title = text("displaytitle", TITLE_CHARS).or_else(|| text("title", TITLE_CHARS));
    let description = text("extract", DESCRIPTION_CHARS);
    if title.is_none() && description.is_none() {
        return None;
    }
    let image = ["thumbnail", "originalimage"]
        .iter()
        .filter_map(|k| v.get(k).and_then(|i| i.get("source")).and_then(Value::as_str))
        .find_map(|src| og::absolute(src, base));
    Some(Page { site: Some(SITE.to_owned()), title, description, image, color: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped(raw: &str) -> Option<String> {
        summary_url(&Url::parse(raw).unwrap()).map(|u| u.to_string())
    }

    #[test]
    fn an_article_maps_to_its_summary_on_the_same_wiki() {
        assert_eq!(mapped("https://en.wikipedia.org/wiki/Anime").as_deref(), Some("https://en.wikipedia.org/api/rest_v1/page/summary/Anime"));
        assert_eq!(mapped("https://de.wikipedia.org/wiki/Anime#Geschichte").as_deref(), Some("https://de.wikipedia.org/api/rest_v1/page/summary/Anime"));
        assert_eq!(mapped("https://en.m.wikipedia.org/wiki/Anime").as_deref(), Some("https://en.wikipedia.org/api/rest_v1/page/summary/Anime"));
        assert_eq!(mapped("https://zh-yue.wikipedia.org/wiki/X").as_deref(), Some("https://zh-yue.wikipedia.org/api/rest_v1/page/summary/X"));
    }

    #[test]
    fn a_percent_encoded_title_stays_encoded() {
        assert_eq!(mapped("https://ja.wikipedia.org/wiki/%E3%82%A2%E3%83%8B%E3%83%A1").as_deref(), Some("https://ja.wikipedia.org/api/rest_v1/page/summary/%E3%82%A2%E3%83%8B%E3%83%A1"));
        assert_eq!(mapped("https://en.wikipedia.org/wiki/Pok%C3%A9mon").as_deref(), Some("https://en.wikipedia.org/api/rest_v1/page/summary/Pok%C3%A9mon"));
        assert_eq!(mapped("https://en.wikipedia.org/wiki/AC/DC").as_deref(), Some("https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC"));
        assert_eq!(mapped("https://en.wikipedia.org/wiki/Star_Trek:_The_Next_Generation").as_deref(), Some("https://en.wikipedia.org/api/rest_v1/page/summary/Star_Trek:_The_Next_Generation"));
    }

    #[test]
    fn other_pages_are_not_mapped() {
        for raw in [
            "https://en.wikipedia.org/wiki/Special:Random",
            "https://en.wikipedia.org/wiki/Special%3ARandom",
            "https://en.wikipedia.org/wiki/Talk:Anime",
            "https://en.wikipedia.org/wiki/User_talk:Someone",
            "https://en.wikipedia.org/wiki/File:Example.jpg",
            "https://en.wikipedia.org/wiki/Category:Anime",
            "https://en.wikipedia.org/w/index.php?title=Anime&action=history",
            "https://en.wikipedia.org/wiki/",
            "https://en.wikipedia.org/",
            "https://www.wikipedia.org/wiki/Anime",
            "https://wikipedia.org/wiki/Anime",
            "https://en.wikipedia.org.evil.example/wiki/Anime",
            "https://en.wiktionary.org/wiki/anime",
        ] {
            assert_eq!(mapped(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_summary_becomes_a_page() {
        let base = Url::parse("https://en.wikipedia.org/api/rest_v1/page/summary/Anime").unwrap();
        let json = br#"{
            "type": "standard",
            "title": "Anime",
            "displaytitle": "<span class=\"mw-page-title-main\">Anime</span>",
            "extract": "Anime is hand-drawn and computer-generated animation originating from Japan. Outside Japan and in English, anime refers specifically to animation produced in Japan.",
            "thumbnail": { "source": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Anime.png/320px-Anime.png", "width": 320, "height": 180 },
            "originalimage": { "source": "https://upload.wikimedia.org/wikipedia/commons/a/a1/Anime.png", "width": 1920, "height": 1080 }
        }"#;
        let page = parse_summary(json, &base).unwrap();
        assert_eq!(page.site.as_deref(), Some("Wikipedia"));
        assert_eq!(page.title.as_deref(), Some("Anime"));
        assert!(page.description.as_deref().unwrap().starts_with("Anime is hand-drawn"));
        assert_eq!(page.image.as_deref(), Some("https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Anime.png/320px-Anime.png"));
        assert_eq!(page.color, None);
    }

    #[test]
    fn a_summary_without_a_thumbnail_uses_the_original_or_none() {
        let base = Url::parse("https://en.wikipedia.org/api/rest_v1/page/summary/X").unwrap();
        let page = parse_summary(br#"{"title":"X &amp; Y","extract":"words","originalimage":{"source":"https://upload.wikimedia.org/x.png"}}"#, &base).unwrap();
        assert_eq!(page.title.as_deref(), Some("X & Y"));
        assert_eq!(page.image.as_deref(), Some("https://upload.wikimedia.org/x.png"));
        let bare = parse_summary(br#"{"title":"X","extract":""}"#, &base).unwrap();
        assert_eq!((bare.description, bare.image), (None, None));
        assert!(parse_summary(br#"{"type":"https://mediawiki.org/wiki/HyperSwitch/errors/not_found"}"#, &base).is_none());
        assert!(parse_summary(b"<html>not json</html>", &base).is_none());
    }
}
