use serde::{Deserialize, Serialize};
use url::Url;

pub(crate) const TITLE_CHARS: usize = 200;
pub(crate) const DESCRIPTION_CHARS: usize = 500;
pub(crate) const SITE_CHARS: usize = 80;
const RAW_TEXT: [&str; 5] = ["script", "style", "template", "textarea", "xmp"];
const VIDEO_HOSTS: [&str; 12] = [
    "youtube.com",
    "youtu.be",
    "music.youtube.com",
    "youtube-nocookie.com",
    "vimeo.com",
    "player.vimeo.com",
    "twitch.tv",
    "clips.twitch.tv",
    "streamable.com",
    "dailymotion.com",
    "dai.ly",
    "tiktok.com",
];
const STOPS: &str = "\u{3001}\u{3002}\u{ff0c}\u{ff0e}\u{ff01}\u{ff1f}\u{ff1a}\u{ff1b}\u{2026}\u{2014}\u{201c}\u{201d}\u{ff08}\u{ff09}\u{300c}\u{300d}\u{300e}\u{300f}\u{3010}\u{3011}\u{300a}\u{300b}\u{3008}\u{3009}\u{ff3b}\u{ff3d}\u{ff5b}\u{ff5d}";
const TRAIL: &str = ".,;:!?'\"\u{00bb}\u{201d}\u{2019}";
const BRACKETS: [(char, char); 4] = [('(', ')'), ('[', ']'), ('{', '}'), ('<', '>')];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Page {
    pub(crate) site: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) image: Option<String>,
    pub(crate) color: Option<String>,
}

#[derive(Default)]
struct Found {
    og_site: Option<String>,
    og_title: Option<String>,
    og_description: Option<String>,
    og_image: Option<String>,
    og_image_url: Option<String>,
    tw_title: Option<String>,
    tw_description: Option<String>,
    tw_image: Option<String>,
    description: Option<String>,
    theme: Option<String>,
    title: Option<String>,
}

impl Found {
    fn meta(&mut self, key: &str, content: String) {
        let slot = match key {
            "og:site_name" => &mut self.og_site,
            "og:title" => &mut self.og_title,
            "og:description" => &mut self.og_description,
            "og:image" => &mut self.og_image,
            "og:image:url" | "og:image:secure_url" => &mut self.og_image_url,
            "twitter:title" => &mut self.tw_title,
            "twitter:description" => &mut self.tw_description,
            "twitter:image" | "twitter:image:src" => &mut self.tw_image,
            "description" => &mut self.description,
            "theme-color" => &mut self.theme,
            _ => return,
        };
        if slot.is_none() && !content.trim().is_empty() {
            *slot = Some(content);
        }
    }
}

pub(crate) fn parse(html: &str, base: &Url) -> Page {
    let found = scan(html);
    let text = |raw: Option<String>, max: usize| raw.map(|r| plain(&r, max)).filter(|t| !t.is_empty());
    let image = [found.og_image, found.og_image_url, found.tw_image].into_iter().flatten().find_map(|raw| absolute(&raw, base));
    Page {
        site: text(found.og_site, SITE_CHARS),
        title: text(found.og_title.or(found.tw_title).or(found.title), TITLE_CHARS),
        description: text(found.og_description.or(found.tw_description).or(found.description), DESCRIPTION_CHARS),
        image,
        color: found.theme.as_deref().and_then(color),
    }
}

pub(crate) fn absolute(raw: &str, base: &Url) -> Option<String> {
    let raw = decode(raw.trim());
    if raw.is_empty() || raw.len() > crate::ssrf::MAX_URL_LEN {
        return None;
    }
    let url = base.join(&raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(url.to_string())
}

fn color(raw: &str) -> Option<String> {
    let hex = raw.trim().strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 => Some(format!("#{}", hex.to_ascii_lowercase())),
        3 => Some(format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_lowercase())),
        _ => None,
    }
}

fn starts_with_ci(hay: &[u8], at: usize, needle: &[u8]) -> bool {
    hay.len() >= at + needle.len() && hay[at..at + needle.len()].eq_ignore_ascii_case(needle)
}

fn find_from(hay: &[u8], at: usize, needle: &[u8]) -> Option<usize> {
    if at >= hay.len() {
        return None;
    }
    hay[at..].windows(needle.len()).position(|w| w == needle).map(|p| p + at)
}

fn find_ci(hay: &[u8], at: usize, needle: &[u8]) -> Option<usize> {
    if at >= hay.len() {
        return None;
    }
    hay[at..].windows(needle.len()).position(|w| w.eq_ignore_ascii_case(needle)).map(|p| p + at)
}

fn scan(html: &str) -> Found {
    let b = html.as_bytes();
    let mut found = Found::default();
    let mut i = 0;
    while let Some(lt) = find_from(b, i, b"<") {
        i = lt + 1;
        if starts_with_ci(b, lt, b"<!--") {
            i = find_from(b, lt + 4, b"-->").map_or(b.len(), |e| e + 3);
            continue;
        }
        let Some(&next) = b.get(i) else { break };
        if next == b'!' || next == b'?' || next == b'/' {
            i = find_from(b, i, b">").map_or(b.len(), |e| e + 1);
            continue;
        }
        if !next.is_ascii_alphabetic() {
            continue;
        }
        let name_end = (i..b.len()).find(|&j| !(b[j].is_ascii_alphanumeric() || b[j] == b'-' || b[j] == b':')).unwrap_or(b.len());
        let name = html[i..name_end].to_ascii_lowercase();
        let (attrs, after) = attributes(html, name_end);
        i = after;
        if RAW_TEXT.contains(&name.as_str()) {
            let close = format!("</{name}");
            i = find_ci(b, i, close.as_bytes()).map_or(b.len(), |e| find_from(b, e, b">").map_or(b.len(), |g| g + 1));
            continue;
        }
        match name.as_str() {
            "meta" => {
                let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
                let Some(content) = get("content") else { continue };
                for key in [get("property"), get("name"), get("itemprop")].into_iter().flatten() {
                    found.meta(&key.trim().to_ascii_lowercase(), content.clone());
                }
            }
            "title" => {
                let end = find_ci(b, i, b"</title").unwrap_or(b.len());
                if found.title.is_none() {
                    found.title = Some(html[i..end].to_owned());
                }
                i = find_from(b, end, b">").map_or(b.len(), |g| g + 1);
            }
            "svg" | "math" => {
                let close = format!("</{name}");
                i = find_ci(b, i, close.as_bytes()).map_or(b.len(), |e| e + close.len());
            }
            _ => {}
        }
    }
    found
}

fn attributes(html: &str, mut i: usize) -> (Vec<(String, String)>, usize) {
    let b = html.as_bytes();
    let mut out = Vec::new();
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= b.len() {
            return (out, i);
        }
        if b[i] == b'>' {
            return (out, i + 1);
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'>' && b[i] != b'/' {
            i += 1;
        }
        let name = html[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let quote = b[i];
                let end = (i + 1..b.len()).find(|&j| b[j] == quote).unwrap_or(b.len());
                let v = &html[i + 1..end];
                i = (end + 1).min(b.len());
                v
            } else {
                let s = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                &html[s..i]
            };
            out.push((name, value.to_owned()));
        } else if !name.is_empty() {
            out.push((name, String::new()));
        }
    }
}

pub(crate) fn plain(raw: &str, max: usize) -> String {
    let decoded = decode(&strip_tags(raw));
    let cleaned = strip_tags(&decoded);
    let mut out = String::with_capacity(cleaned.len().min(max * 4));
    let mut space = false;
    for c in cleaned.chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if c.is_control() || is_invisible(c) {
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    cut(&out, max)
}

fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}\u{2026}", kept.trim_end())
}

fn strip_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let after = &rest[lt + 1..];
        let tagish = after.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '/' || c == '!' || c == '?');
        match (tagish, after.find('>')) {
            (true, Some(gt)) => {
                out.push(' ');
                rest = &after[gt + 1..];
            }
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        match entity(after) {
            Some((c, used)) => {
                out.push(c);
                rest = &after[used..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity(s: &str) -> Option<(char, usize)> {
    if let Some(num) = s.strip_prefix('#') {
        let (digits, radix, skip) = match num.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16, 2),
            None => (num, 10, 1),
        };
        let len = digits.chars().take_while(|c| c.is_digit(radix)).count();
        if len == 0 || len > 8 {
            return None;
        }
        let code = u32::from_str_radix(&digits[..len], radix).ok()?;
        let c = match code {
            0 => '\u{FFFD}',
            _ => char::from_u32(code).unwrap_or('\u{FFFD}'),
        };
        let semi = usize::from(digits[len..].starts_with(';'));
        return Some((c, skip + len + semi));
    }
    let len = s.chars().take_while(|c| c.is_ascii_alphanumeric()).count();
    if len == 0 || len > 10 {
        return None;
    }
    let name = &s[..len];
    let c = match name {
        "amp" | "AMP" => '&',
        "lt" | "LT" => '<',
        "gt" | "GT" => '>',
        "quot" | "QUOT" => '"',
        "apos" => '\'',
        "nbsp" => '\u{00A0}',
        "ndash" => '\u{2013}',
        "mdash" => '\u{2014}',
        "hellip" => '\u{2026}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "sbquo" => '\u{201A}',
        "ldquo" => '\u{201C}',
        "rdquo" => '\u{201D}',
        "bdquo" => '\u{201E}',
        "laquo" => '\u{00AB}',
        "raquo" => '\u{00BB}',
        "copy" => '\u{00A9}',
        "reg" => '\u{00AE}',
        "trade" => '\u{2122}',
        "middot" => '\u{00B7}',
        "bull" => '\u{2022}',
        "deg" => '\u{00B0}',
        "times" => '\u{00D7}',
        "divide" => '\u{00F7}',
        "euro" => '\u{20AC}',
        "pound" => '\u{00A3}',
        "yen" => '\u{00A5}',
        "cent" => '\u{00A2}',
        "sect" => '\u{00A7}',
        "para" => '\u{00B6}',
        "eacute" => '\u{00E9}',
        "egrave" => '\u{00E8}',
        "aacute" => '\u{00E1}',
        "agrave" => '\u{00E0}',
        "ouml" => '\u{00F6}',
        "uuml" => '\u{00FC}',
        "auml" => '\u{00E4}',
        "szlig" => '\u{00DF}',
        "ntilde" => '\u{00F1}',
        "ccedil" => '\u{00E7}',
        _ => return None,
    };
    let semi = usize::from(s[len..].starts_with(';'));
    Some((c, len + semi))
}

pub(crate) fn first_link(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while from < text.len() {
        let at = [lower[from..].find("http://"), lower[from..].find("https://")].into_iter().flatten().min()? + from;
        from = at + 1;
        if text[..at].chars().next_back().is_some_and(char::is_alphanumeric) {
            continue;
        }
        let end = text[at..].find(|c: char| c.is_whitespace() || STOPS.contains(c)).map_or(text.len(), |e| e + at);
        let link = trim_link(&text[at..end]);
        let Ok(url) = Url::parse(link) else { continue };
        if url.host_str().is_some_and(|h| !h.is_empty()) {
            return Some(link.to_owned());
        }
    }
    None
}

fn trim_link(raw: &str) -> &str {
    let mut link = raw;
    loop {
        let before = link;
        link = link.trim_end_matches(|c| TRAIL.contains(c));
        for (open, close) in BRACKETS {
            if link.ends_with(close) && link.matches(open).count() < link.matches(close).count() {
                link = &link[..link.len() - close.len_utf8()];
            }
        }
        if link == before {
            return link;
        }
    }
}

pub(crate) fn plays_inline(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).unwrap_or(&host);
    if VIDEO_HOSTS.contains(&host) {
        return true;
    }
    let path = url.path().to_ascii_lowercase();
    [".mp4", ".webm", ".mov"].iter().any(|ext| path.ends_with(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://en.wikipedia.org/wiki/Anime").unwrap()
    }

    #[test]
    fn og_tags_win() {
        let html = r##"<!doctype html><html><head>
            <title>Anime - Wikipedia</title>
            <meta property="og:site_name" content="Wikipedia">
            <meta property="og:title" content="Anime">
            <meta property="og:description" content="Anime is hand-drawn and computer-generated animation originating from Japan.">
            <meta property="og:image" content="/static/anime.png">
            <meta name="twitter:title" content="not this">
            <meta name="theme-color" content="#3366CC">
        </head><body></body></html>"##;
        let page = parse(html, &base());
        assert_eq!(page.site.as_deref(), Some("Wikipedia"));
        assert_eq!(page.title.as_deref(), Some("Anime"));
        assert_eq!(page.description.as_deref(), Some("Anime is hand-drawn and computer-generated animation originating from Japan."));
        assert_eq!(page.image.as_deref(), Some("https://en.wikipedia.org/static/anime.png"));
        assert_eq!(page.color.as_deref(), Some("#3366cc"));
    }

    #[test]
    fn twitter_tags_fill_in() {
        let html = r#"<head><meta name="twitter:title" content="Tweet title"><meta name='twitter:description' content='Said things'><meta name=twitter:image content=https://cdn.example.com/a.jpg></head>"#;
        let page = parse(html, &base());
        assert_eq!(page.title.as_deref(), Some("Tweet title"));
        assert_eq!(page.description.as_deref(), Some("Said things"));
        assert_eq!(page.image.as_deref(), Some("https://cdn.example.com/a.jpg"));
        assert_eq!(page.site, None);
    }

    #[test]
    fn the_title_tag_and_meta_description_are_the_last_resort() {
        let html = "<html><head><TITLE>\n  Plain   page\n</TITLE><meta name=\"description\" content=\"A page.\"></head></html>";
        let page = parse(html, &base());
        assert_eq!(page.title.as_deref(), Some("Plain page"));
        assert_eq!(page.description.as_deref(), Some("A page."));
        assert_eq!(page.image, None);
        assert_eq!(page.color, None);
    }

    #[test]
    fn meta_description_fills_in_when_og_and_twitter_have_none() {
        let html = r#"<head><meta property="og:title" content="Titled"><meta name="Description" content="  The plain   description. "><meta name="twitter:card" content="summary"></head>"#;
        let page = parse(html, &base());
        assert_eq!(page.title.as_deref(), Some("Titled"));
        assert_eq!(page.description.as_deref(), Some("The plain description."));
        let html = r#"<meta name="description" content="loses"><meta property="og:description" content="wins">"#;
        assert_eq!(parse(html, &base()).description.as_deref(), Some("wins"));
    }

    #[test]
    fn entities_are_decoded_and_tags_stripped() {
        let html = r#"<meta property="og:title" content="Tom &amp; Jerry &#8212; &quot;the&quot; &#x27;cat&#x27; &lt;3 &hellip;"><meta property="og:description" content="&lt;b&gt;bold&lt;/b&gt; <i>words</i> &nbsp;here &unknown; &#0;">"#;
        let page = parse(html, &base());
        assert_eq!(page.title.as_deref(), Some("Tom & Jerry \u{2014} \"the\" 'cat' <3 \u{2026}"));
        assert_eq!(page.description.as_deref(), Some("bold words here &unknown; \u{FFFD}"));
    }

    #[test]
    fn script_style_and_comments_are_ignored() {
        let html = r#"<head>
            <script>var s = '<meta property="og:title" content="from script">'; </script>
            <style>.x::after { content: '<title>css</title>'; }</style>
            <!-- <meta property="og:title" content="from comment"> -->
            <svg><title>icon</title></svg>
            <title>Real</title>
            <meta property="og:description" content="kept">
        </head>"#;
        let page = parse(html, &base());
        assert_eq!(page.title.as_deref(), Some("Real"));
        assert_eq!(page.description.as_deref(), Some("kept"));
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis() {
        let long = "word ".repeat(400);
        let html = format!(r#"<meta property="og:title" content="{long}"><meta property="og:description" content="{long}"><meta property="og:site_name" content="{long}">"#);
        let page = parse(&html, &base());
        assert_eq!(page.title.as_ref().unwrap().chars().count(), TITLE_CHARS);
        assert!(page.title.as_ref().unwrap().ends_with('\u{2026}'));
        assert!(page.description.as_ref().unwrap().chars().count() <= DESCRIPTION_CHARS);
        assert!(page.site.as_ref().unwrap().chars().count() <= SITE_CHARS);
    }

    #[test]
    fn a_bad_image_or_colour_is_dropped() {
        let html = r#"<meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="data:image/png;base64,AA"><meta name="theme-color" content="red; background:url(x)">"#;
        let page = parse(html, &base());
        assert_eq!(page.image, None);
        assert_eq!(page.color, None);
        let html = r##"<meta property="og:image" content="//cdn.example.com/x.png?a=1&amp;b=2"><meta name="theme-color" content="#AbC">"##;
        let page = parse(html, &base());
        assert_eq!(page.image.as_deref(), Some("https://cdn.example.com/x.png?a=1&b=2"));
        assert_eq!(page.color.as_deref(), Some("#aabbcc"));
    }

    #[test]
    fn control_and_invisible_characters_go() {
        assert_eq!(plain("a\u{0}b\u{7}c\u{202E}d\u{200B}e\n\n\tf", 50), "abcde f");
    }

    #[test]
    fn the_first_http_link_is_found() {
        assert_eq!(first_link("look https://en.wikipedia.org/wiki/Anime.").as_deref(), Some("https://en.wikipedia.org/wiki/Anime"));
        assert_eq!(first_link("(see https://example.com/a_(b)) and http://two.example").as_deref(), Some("https://example.com/a_(b)"));
        assert_eq!(first_link("HTTPS://Example.com/X, then more").as_deref(), Some("HTTPS://Example.com/X"));
        assert_eq!(first_link("xhttps://nope.example https://yes.example").as_deref(), Some("https://yes.example"));
        assert_eq!(first_link("www.example.com and ftp://x.example"), None);
        assert_eq!(first_link("https:// nothing"), None);
        assert_eq!(first_link("\u{3010}https://example.jp/\u{3011}").as_deref(), Some("https://example.jp/"));
        assert_eq!(first_link("no links here"), None);
    }

    #[test]
    fn video_links_play_inline_instead() {
        for raw in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://m.twitch.tv/x", "https://example.com/clip.MP4"] {
            assert!(plays_inline(&Url::parse(raw).unwrap()), "{raw}");
        }
        assert!(!plays_inline(&Url::parse("https://en.wikipedia.org/wiki/Anime").unwrap()));
    }
}
