use crate::about_page::{decode_entities, http_url, sanitize_html};

pub(crate) fn render(md: &str) -> String {
    if md.trim().is_empty() {
        return String::new();
    }
    sanitize_html(&to_html(md))
}

enum Open {
    None,
    Para(Vec<String>),
    List(&'static str, Vec<String>),
    Quote(Vec<String>),
}

fn close(open: &mut Open, out: &mut String) {
    match std::mem::replace(open, Open::None) {
        Open::None => {}
        Open::Para(lines) => {
            out.push_str("<p>");
            out.push_str(&lines.join("<br>"));
            out.push_str("</p>");
        }
        Open::List(tag, items) => {
            out.push('<');
            out.push_str(tag);
            out.push('>');
            for item in items {
                out.push_str("<li>");
                out.push_str(&item);
                out.push_str("</li>");
            }
            out.push_str("</");
            out.push_str(tag);
            out.push('>');
        }
        Open::Quote(lines) => {
            out.push_str("<blockquote>");
            out.push_str(&lines.join("<br>"));
            out.push_str("</blockquote>");
        }
    }
}

pub(crate) fn to_html(md: &str) -> String {
    let text = md.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    let mut open = Open::None;
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            close(&mut open, &mut out);
            continue;
        }
        if let Some((tag, rest)) = heading(line) {
            close(&mut open, &mut out);
            out.push('<');
            out.push_str(tag);
            out.push('>');
            out.push_str(&inline(rest, true));
            out.push_str("</");
            out.push_str(tag);
            out.push('>');
            continue;
        }
        if let Some(rest) = quoted(line) {
            if !matches!(open, Open::Quote(_)) {
                close(&mut open, &mut out);
                open = Open::Quote(Vec::new());
            }
            if let Open::Quote(lines) = &mut open {
                lines.push(inline(rest, true));
            }
            continue;
        }
        if let Some((tag, rest)) = item(line) {
            let same = matches!(&open, Open::List(t, _) if *t == tag);
            if !same {
                close(&mut open, &mut out);
                open = Open::List(tag, Vec::new());
            }
            if let Open::List(_, items) = &mut open {
                items.push(inline(rest, true));
            }
            continue;
        }
        if !matches!(open, Open::Para(_)) {
            close(&mut open, &mut out);
            open = Open::Para(Vec::new());
        }
        if let Open::Para(lines) = &mut open {
            lines.push(inline(line, true));
        }
    }
    close(&mut open, &mut out);
    out
}

fn heading(line: &str) -> Option<(&'static str, &str)> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    Some((if hashes <= 2 { "h2" } else { "h3" }, rest))
}

fn quoted(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('>')?;
    let rest = rest.strip_prefix(' ').unwrap_or(rest).trim();
    (!rest.is_empty()).then_some(rest)
}

fn item(line: &str) -> Option<(&'static str, &str)> {
    for mark in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(mark) {
            let rest = rest.trim();
            return (!rest.is_empty()).then_some(("ul", rest));
        }
    }
    let digits = line.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || digits > 3 {
        return None;
    }
    let rest = &line[digits..];
    let rest = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?.trim();
    (!rest.is_empty()).then_some(("ol", rest))
}

fn push_escaped(out: &mut String, c: char) {
    match c {
        '&' => out.push_str("&amp;"),
        '<' => out.push_str("&lt;"),
        '>' => out.push_str("&gt;"),
        '"' => out.push_str("&quot;"),
        _ => out.push(c),
    }
}

fn push_href(out: &mut String, href: &str) {
    for c in href.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

const PUNCT: &str = "\\`*_{}[]()#+-.!~>|<&\"'";

fn find_close(s: &str, from: usize, mark: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = from;
    while i < s.len() {
        if bytes[i] == b'\\' {
            i += 1;
            if i < s.len() {
                i += s[i..].chars().next().map_or(1, char::len_utf8);
            }
            continue;
        }
        if s[i..].starts_with(mark) {
            let single = mark.len() == 1;
            let doubled = single && s[i + 1..].starts_with(mark);
            if !doubled {
                return Some(i);
            }
            i += 2;
            continue;
        }
        i += s[i..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

fn word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric())
}

fn emphasis(s: &str, i: usize, links: bool) -> Option<(String, usize)> {
    for (mark, tag) in [("**", "strong"), ("__", "u"), ("~~", "s"), ("*", "em"), ("_", "em")] {
        if !s[i..].starts_with(mark) {
            continue;
        }
        if mark.len() == 1 && s[i + 1..].starts_with(mark) {
            continue;
        }
        let start = i + mark.len();
        if mark == "_" && word_char(s[..i].chars().next_back()) {
            return None;
        }
        let end = find_close(s, start, mark)?;
        let inner = &s[start..end];
        let first = inner.chars().next()?;
        let last = inner.chars().next_back()?;
        if first.is_whitespace() || last.is_whitespace() {
            return None;
        }
        let after = end + mark.len();
        if mark == "_" && word_char(s[after..].chars().next()) {
            return None;
        }
        return Some((format!("<{tag}>{}</{tag}>", inline(inner, links)), after));
    }
    None
}

fn bracket_link(s: &str, i: usize, links: bool) -> Option<(String, usize)> {
    let close = find_close(s, i + 1, "]")?;
    let rest = &s[close + 1..];
    if !rest.starts_with('(') {
        return None;
    }
    let end = rest.find(')')?;
    let target = rest[1..end].trim();
    let text = &s[i + 1..close];
    let after = close + 1 + end + 1;
    let label = inline(text, false);
    match http_url(target).filter(|_| links) {
        Some(href) => {
            let mut out = String::from("<a href=\"");
            push_href(&mut out, &href);
            out.push_str("\">");
            out.push_str(if label.is_empty() { &href } else { &label });
            out.push_str("</a>");
            Some((out, after))
        }
        None => Some((label, after)),
    }
}

fn bare_link(s: &str, i: usize) -> Option<(String, usize)> {
    let rest = &s[i..];
    if !(rest.starts_with("https://") || rest.starts_with("http://")) {
        return None;
    }
    if word_char(s[..i].chars().next_back()) {
        return None;
    }
    let mut end = rest.find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"').unwrap_or(rest.len());
    while end > 0 && rest[..end].ends_with(['.', ',', ';', ':', '!', '?', ')', '\'', '*', '_', '~']) {
        end -= 1;
    }
    let href = http_url(&rest[..end])?;
    let mut out = String::from("<a href=\"");
    push_href(&mut out, &href);
    out.push_str("\">");
    for c in rest[..end].chars() {
        push_escaped(&mut out, c);
    }
    out.push_str("</a>");
    Some((out, i + end))
}

pub(crate) fn inline(s: &str, links: bool) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        let c = s[i..].chars().next().unwrap_or(' ');
        if c == '\\' {
            if let Some(next) = s[i + 1..].chars().next().filter(|n| PUNCT.contains(*n)) {
                push_escaped(&mut out, next);
                i += 1 + next.len_utf8();
                continue;
            }
        }
        if c == '[' {
            if let Some((html, next)) = bracket_link(s, i, links) {
                out.push_str(&html);
                i = next;
                continue;
            }
        }
        if c == '*' || c == '_' || c == '~' {
            if let Some((html, next)) = emphasis(s, i, links) {
                out.push_str(&html);
                i = next;
                continue;
            }
        }
        if links && c == 'h' {
            if let Some((html, next)) = bare_link(s, i) {
                out.push_str(&html);
                i = next;
                continue;
            }
        }
        push_escaped(&mut out, c);
        i += c.len_utf8();
    }
    out
}

pub(crate) fn escape_md(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '~' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub(crate) fn html_to_md(html: &str) -> String {
    let mut out = String::new();
    let mut lists: Vec<(bool, usize)> = Vec::new();
    let mut links: Vec<Option<String>> = Vec::new();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < html.len() {
        if bytes[i] != b'<' {
            let end = html[i..].find('<').map_or(html.len(), |n| i + n);
            out.push_str(&escape_md(&decode_entities(&html[i..end])));
            i = end;
            continue;
        }
        let Some(gt) = html[i..].find('>') else {
            out.push_str(&escape_md(&decode_entities(&html[i..])));
            break;
        };
        let tag = &html[i + 1..i + gt];
        i += gt + 1;
        let close = tag.starts_with('/');
        let body = tag.trim_start_matches('/');
        let name: String = body.chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
        let attrs = &body[name.len().min(body.len())..];
        match name.as_str() {
            "br" => out.push('\n'),
            "p" | "div" => {
                if close {
                    out.push_str("\n\n");
                } else {
                    line_start(&mut out);
                }
            }
            "h2" | "h3" => {
                if close {
                    out.push_str("\n\n");
                } else {
                    line_start(&mut out);
                    out.push_str(if name == "h2" { "## " } else { "### " });
                }
            }
            "blockquote" => {
                if close {
                    out.push_str("\n\n");
                } else {
                    line_start(&mut out);
                    out.push_str("> ");
                }
            }
            "ul" | "ol" => {
                if close {
                    lists.pop();
                    out.push('\n');
                } else {
                    line_start(&mut out);
                    lists.push((name == "ol", 0));
                }
            }
            "li" => {
                if close {
                    line_start(&mut out);
                } else {
                    line_start(&mut out);
                    match lists.last_mut() {
                        Some((true, n)) => {
                            *n += 1;
                            out.push_str(&format!("{n}. "));
                        }
                        _ => out.push_str("- "),
                    }
                }
            }
            "b" | "strong" => out.push_str("**"),
            "i" | "em" => out.push('*'),
            "u" => out.push_str("__"),
            "s" => out.push_str("~~"),
            "a" => {
                if close {
                    if let Some(Some(href)) = links.pop() {
                        out.push_str("](");
                        out.push_str(&href);
                        out.push(')');
                    }
                } else {
                    let href = crate::about_page::href_of(attrs).and_then(|h| http_url(&decode_entities(&h)));
                    if href.is_some() {
                        out.push('[');
                    }
                    links.push(href);
                }
            }
            _ => {}
        }
    }
    tidy(&out)
}

fn line_start(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

pub(crate) fn text_to_md(text: &str) -> String {
    tidy(&escape_md(text))
}

fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.replace("\r\n", "\n").split('\n') {
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_becomes_the_allowed_tags() {
        assert_eq!(render("### hi i'm wolf\nvtuber rigger, late night\n**just chatting**"), "<h3>hi i'm wolf</h3><p>vtuber rigger, late night<br><strong>just chatting</strong></p>");
        assert_eq!(render("# big"), "<h2>big</h2>");
        assert_eq!(render("1. be nice\n2. no spoilers"), "<ol><li>be nice</li><li>no spoilers</li></ol>");
        assert_eq!(render("- **cam** iphone\n- mic"), "<ul><li><strong>cam</strong> iphone</li><li>mic</li></ul>");
        assert_eq!(render("> quoted\n> more"), "<blockquote>quoted<br>more</blockquote>");
        assert_eq!(render("one\n\ntwo"), "<p>one</p><p>two</p>");
        assert_eq!(render("*i* _e_ __u__ ~~s~~"), "<p><em>i</em> <em>e</em> <u>u</u> <s>s</s></p>");
        assert_eq!(render("snake_case_word and 2 * 3 * 4"), "<p>snake_case_word and 2 * 3 * 4</p>");
        assert_eq!(render(""), "");
    }

    #[test]
    fn markdown_links_are_http_or_plain_words() {
        assert_eq!(render("[kit](https://kit.co/wolf)"), "<p><a href=\"https://kit.co/wolf\">kit</a></p>");
        assert_eq!(render("[bad](javascript:alert(1))"), "<p>bad)</p>");
        assert_eq!(render("see https://wolfhours.art."), "<p>see <a href=\"https://wolfhours.art/\">https://wolfhours.art</a>.</p>");
        assert_eq!(render("[a [b](https://x.example)](https://y.example)"), "<p><a href=\"https://x.example/\">a [b</a>](<a href=\"https://y.example/\">https://y.example</a>)</p>");
    }

    #[test]
    fn markdown_cannot_smuggle_html() {
        assert_eq!(render("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
        assert_eq!(render("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
        assert_eq!(render("[x](https://a.example/\"onclick=\"y)"), "<p><a href=\"https://a.example/%22onclick=%22y\">x</a></p>");
        assert_eq!(render("\\*not em\\*"), "<p>*not em*</p>");
    }

    #[test]
    fn old_html_comes_back_as_markdown() {
        assert_eq!(html_to_md("<h3>rules</h3><ol><li>be nice</li><li>no <b>spoilers</b></li></ol>"), "### rules\n\n1. be nice\n2. no **spoilers**");
        assert_eq!(html_to_md("<p>a &amp; b*</p><p><a href=\"https://x.example/\">x</a></p>"), "a & b\\*\n\n[x](https://x.example/)");
        assert_eq!(html_to_md("<p>one<br>two</p>"), "one\ntwo");
        assert_eq!(render(&html_to_md("<h3>rules</h3><ol><li>be nice</li></ol>")), "<h3>rules</h3><ol><li>be nice</li></ol>");
        assert_eq!(text_to_md("1. be nice\n\n\n2. *no*"), "1. be nice\n\n2. \\*no\\*");
    }
}
