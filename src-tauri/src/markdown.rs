//! Markdown → HTML in Rust (pulldown-cmark), with the extras the preview needs:
//! - GitHub-style tables, task lists, strikethrough, footnotes, bare links (https://…, www.…) turned into links
//! - `$…$` / `$$…$$` and ```` ```math ```` become placeholders; ```` ```mermaid ```` becomes a diagram placeholder
//!   (the UI draws them with KaTeX / Mermaid)
//! - every top-level block gets `data-line` = its first source line (0-based), used for synchronized scrolling.
//! - school extras: sources in a ```` ```quellen ```` block are cited with `[@key]` / `[@key, S. 12]` and listed as a
//!   bibliography; `[[Note]]` links to Note.md next to the file; ```` ```sketch ```` blocks are drawings (SVG).
//! The UI still sanitizes the HTML (DOMPurify) right before showing it.

use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

#[derive(Serialize, Default)]
pub struct Rendered {
    html: String,
    /// [tex, display]
    math: Vec<(String, bool)>,
    diagrams: Vec<String>,
    /// number of ```sketch blocks (drawn here as SVG)
    sketches: usize,
    /// [level, text, source line] of every heading (outline)
    headings: Vec<(u8, String, usize)>,
    stats: Stats,
}

/// Counts for the status bar and the Properties panel.
#[derive(Serialize, Default)]
pub struct Stats {
    words: usize,
    /// characters as the editor counts them (UTF-16)
    chars: usize,
    lines: usize,
    code: usize,
    links: usize,
    images: usize,
}

/// Words: runs of letters/digits, which may contain ' ’ _ -.
pub fn count_words(s: &str) -> usize {
    let mut n = 0;
    let mut inside = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() { if !inside { n += 1; inside = true; } }
        else if !(inside && matches!(ch, '\'' | '’' | '_' | '-')) { inside = false; }
    }
    n
}

fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH
        | Options::ENABLE_GFM
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Splits text into plain parts and bare links (http://, https://, www.), like GitHub does.
fn autolink(text: &str) -> Option<Vec<Event<'static>>> {
    let starts = |s: &str| s.starts_with("https://") || s.starts_with("http://") || s.starts_with("www.");
    let mut out = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    let bytes = text.as_bytes();
    let mut found = false;
    while i < text.len() {
        let at_word_start = i == 0 || !(bytes[i - 1] as char).is_alphanumeric();
        if at_word_start && text.is_char_boundary(i) && starts(&text[i..]) {
            let rest = &text[i..];
            let mut end = rest.find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"').unwrap_or(rest.len());
            // Trailing punctuation belongs to the sentence, not the link.
            while end > 0 && ".,:;!?')]".contains(&rest[..end][end - 1..]) { end -= 1; }
            let url = &rest[..end];
            if url.len() > 7 && url.contains('.') {
                if !plain.is_empty() { out.push(Event::Text(CowStr::from(std::mem::take(&mut plain)))); }
                let href = if url.starts_with("www.") { format!("https://{url}") } else { url.to_string() };
                out.push(Event::InlineHtml(CowStr::from(format!("<a href=\"{}\">{}</a>", escape(&href), escape(url)))));
                found = true;
                i += end;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap();
        plain.push(ch);
        i += ch.len_utf8();
    }
    if !found { return None; }
    if !plain.is_empty() { out.push(Event::Text(CowStr::from(plain))); }
    Some(out)
}

/// Adds data-line="n" to the first tag of an HTML fragment.
fn tag_line(html: &str, line: usize) -> String {
    let t = html.trim_start();
    let lead = html.len() - t.len();
    if t.starts_with('<') && t[1..].starts_with(|c: char| c.is_ascii_alphabetic()) {
        let name_end = t[1..].find(|c: char| !c.is_ascii_alphanumeric() && c != '-').map(|p| p + 1).unwrap_or(t.len());
        format!("{}{} data-line=\"{line}\"{}", &html[..lead], &t[..name_end], &t[name_end..])
    } else {
        html.to_string()
    }
}

/// The prose of a Markdown source for spell checking: byte ranges of its text — not code, math, HTML or link targets.
pub fn prose(src: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut code = 0usize;
    // Keys and code written as HTML (<kbd>Strg+S</kbd>, <code>…</code>) aren't prose either.
    let tag = |h: &str, close: bool| {
        let h = h.trim().to_ascii_lowercase();
        ["kbd", "code", "samp", "var", "pre"].iter().any(|t| h.starts_with(&format!("<{}{t}", if close { "/" } else { "" })))
    };
    for (ev, r) in Parser::new_ext(src, options()).into_offset_iter() {
        match ev {
            Event::Start(Tag::CodeBlock(_)) => code += 1,
            Event::End(TagEnd::CodeBlock) => code = code.saturating_sub(1),
            Event::InlineHtml(ref h) | Event::Html(ref h) if tag(h, false) => code += 1,
            Event::InlineHtml(ref h) | Event::Html(ref h) if tag(h, true) => code = code.saturating_sub(1),
            Event::Text(_) if code == 0 => match out.last_mut() {
                Some(last) if last.1 == r.start => last.1 = r.end,
                _ => out.push((r.start, r.end)),
            },
            _ => {}
        }
    }
    out
}

/// Spelling and grammar issues of a Markdown document (spell.rs), prose only.
#[tauri::command]
pub async fn md_spell(app: tauri::AppHandle, text: String, lang: String, fallback: String) -> Vec<crate::spell::Issue> {
    crate::spell::check(&app, &text, &prose(&text), &lang, &fallback)
}


/* ============ Sources, citations, wiki links, sketches ============ */

/// Fenced block names that hold the sources of a document.
pub const SOURCE_LANGS: &[&str] = &["quellen", "sources", "references", "literatur", "bibliography"];

/// One source: `key: Author; Second Author | Title | Year | Publisher, place or URL | accessed`.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Source {
    pub key: String,
    pub author: String,
    pub title: String,
    pub year: String,
    pub place: String,
    pub accessed: String,
    /// source line (0-based), so the UI can jump to it
    pub line: usize,
}

/// Lines of fenced blocks: (language, first content line, lines), outside of other code.
fn fenced_blocks(src: &str) -> Vec<(String, usize, Vec<&str>)> {
    let mut out = Vec::new();
    let mut open: Option<(String, String, usize, Vec<&str>)> = None; // fence, lang, start, lines
    for (i, line) in src.lines().enumerate() {
        let t = line.trim_start();
        match &mut open {
            Some((fence, _, _, lines)) => {
                if t.starts_with(fence.as_str()) && t.trim_end().chars().all(|c| c == fence.chars().next().unwrap()) {
                    let (_, lang, start, lines) = open.take().unwrap();
                    out.push((lang, start, lines));
                } else { lines.push(line); }
            }
            None => {
                for f in ["```", "~~~"] {
                    if let Some(rest) = t.strip_prefix(f) {
                        let n = f.len() + rest.chars().take_while(|&c| c == f.chars().next().unwrap()).count();
                        let lang = t[n..].split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                        open = Some((t[..n].to_string(), lang, i + 1, Vec::new()));
                        break;
                    }
                }
            }
        }
    }
    out
}

pub fn sources(src: &str) -> Vec<Source> {
    let mut out = Vec::new();
    for (lang, start, lines) in fenced_blocks(src) {
        if !SOURCE_LANGS.contains(&lang.as_str()) { continue; }
        for (i, line) in lines.iter().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") { continue; }
            let Some((key, rest)) = line.split_once(':') else { continue };
            let key = key.trim();
            if key.is_empty() || !key.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c)) { continue; }
            let f: Vec<String> = rest.split('|').map(|x| x.trim().to_string()).collect();
            let get = |n: usize| f.get(n).cloned().unwrap_or_default();
            out.push(Source { key: key.to_string(), author: get(0), title: get(1), year: get(2), place: get(3), accessed: get(4), line: start + i });
        }
    }
    out
}

/// "Müller", "Müller & Schmidt", "Müller et al." — last names before the first comma of each author.
fn short_author(a: &str) -> String {
    let names: Vec<&str> = a.split(';').map(|x| x.split(',').next().unwrap_or("").trim()).filter(|x| !x.is_empty()).collect();
    match names.len() {
        0 => "o. A.".into(),
        1 => names[0].into(),
        2 => format!("{} & {}", names[0], names[1]),
        _ => format!("{} et al.", names[0]),
    }
}

/// The parts of a bibliography entry: (text, italic).
pub fn bib_parts(s: &Source, lang: &str) -> Vec<(String, bool)> {
    let de = lang == "de";
    let mut v = vec![(format!("{} ({}): ", if s.author.is_empty() { if de { "o. A." } else { "n.a." } } else { &s.author },
        if s.year.is_empty() { if de { "o. J." } else { "n.d." } } else { &s.year }), false)];
    v.push((s.title.clone(), true));
    let mut tail = String::from(".");
    if !s.place.is_empty() {
        tail += " ";
        tail += &s.place;
        if !s.place.ends_with('.') { tail += "."; }
    }
    if !s.accessed.is_empty() { tail += &format!(" ({} {})", if de { "Zugriff am" } else { "accessed" }, s.accessed); }
    v.push((tail, false));
    v
}

fn bibliography_html(list: &[Source], lang: &str) -> String {
    let mut sorted: Vec<&Source> = list.iter().collect();
    sorted.sort_by_key(|s| (s.author.to_lowercase(), s.year.clone()));
    let mut h = String::from("<div class=\"biblio\">");
    for s in sorted {
        h += &format!("<p class=\"bib-entry\" id=\"src-{}\">", escape(&s.key));
        for (t, it) in bib_parts(s, lang) {
            let t = escape(&t);
            // Web addresses in the entry become links.
            let t = t.split(' ').map(|w| if w.starts_with("http://") || w.starts_with("https://") {
                let (url, end) = match w.strip_suffix('.') { Some(u) => (u, "."), None => (w, "") };
                format!("<a href=\"{url}\">{url}</a>{end}")
            } else { w.to_string() }).collect::<Vec<_>>().join(" ");
            h += &if it { format!("<em>{t}</em>") } else { t };
        }
        h += "</p>";
    }
    if list.is_empty() { h += "<p class=\"bib-empty\">—</p>"; }
    h + "</div>"
}

/// Replaces citations `[@key]`, `[@key, S. 12]`, `[@a; @b]` and wiki links `[[Note]]`, `[[Note|text]]` in the
/// text (not in code). `html`: citations become <span class="cite">, wiki links <a data-note>; otherwise plain text
/// (Word export). Line breaks are never added or removed, so source lines stay where they were.
pub fn preprocess(src: &str, list: &[Source], html: bool) -> String {
    let mut out = String::with_capacity(src.len());
    let mut fence: Option<String> = None;
    for (n, line) in src.split_inclusive('\n').enumerate() {
        let t = line.trim_start();
        if let Some(f) = &fence {
            if t.starts_with(f.as_str()) { fence = None; }
            out.push_str(line);
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") { fence = Some(t[..3].to_string()); out.push_str(line); continue; }
        if t.starts_with("    ") || t.starts_with('\t') { out.push_str(line); continue; }
        let _ = n;
        // Outside of `inline code`.
        let mut in_code = false;
        let mut i = 0;
        let b = line.as_bytes();
        while i < line.len() {
            if b[i] == b'`' { in_code = !in_code; out.push('`'); i += 1; continue; }
            if !in_code && line[i..].starts_with("[[") {
                if let Some(end) = line[i + 2..].find("]]") {
                    let inner = &line[i + 2..i + 2 + end];
                    if !inner.is_empty() && !inner.contains('[') {
                        let (target, label) = inner.split_once('|').unwrap_or((inner, inner));
                        out.push_str(&if html {
                            format!("<a class=\"wikilink\" href=\"#\" data-note=\"{}\">{}</a>", escape(target.trim()), escape(label.trim()))
                        } else { label.trim().to_string() });
                        i += end + 4;
                        continue;
                    }
                }
            }
            if !in_code && line[i..].starts_with("[@") {
                if let Some(end) = line[i..].find(']') {
                    let inner = &line[i + 1..i + end];
                    let mut parts = Vec::new();
                    let mut ok = true;
                    for c in inner.split(';') {
                        let c = c.trim();
                        let Some(c) = c.strip_prefix('@') else { ok = false; break };
                        let (key, loc) = c.split_once(',').map(|(k, l)| (k.trim(), Some(l.trim()))).unwrap_or((c.trim(), None));
                        parts.push((key.to_string(), loc.map(str::to_string)));
                    }
                    if ok && !parts.is_empty() {
                        let mut missing = false;
                        let mut full = Vec::new();
                        let text = parts.iter().map(|(k, loc)| {
                            let base = match list.iter().find(|s| &s.key == k) {
                                Some(s) => { full.push(format!("{}: {}", s.author, s.title)); format!("{} {}", short_author(&s.author), s.year) }
                                None => { missing = true; format!("?{k}") }
                            };
                            match loc { Some(l) if !l.is_empty() => format!("{base}, {l}"), _ => base }
                        }).collect::<Vec<_>>().join("; ");
                        out.push_str(&if html {
                            format!("<span class=\"{}\" title=\"{}\">({})</span>", if missing { "cite cite-missing" } else { "cite" }, escape(&full.join(" · ")), escape(&text))
                        } else { format!("({text})") });
                        i += end + 1;
                        continue;
                    }
                }
            }
            let ch = line[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// A drawing from a ```sketch block: {"w":800,"h":400,"s":[[color, width, [[x,y,pressure],…]],…]}.
#[derive(serde::Deserialize, Default)]
pub struct Sketch {
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub s: Vec<(String, f64, Vec<Vec<f64>>)>,
}

pub fn sketch_svg(code: &str) -> Result<String, String> {
    let sk: Sketch = serde_json::from_str(code.trim()).map_err(|e| e.to_string())?;
    let (w, h) = (sk.w.max(10.0), sk.h.max(10.0));
    let mut svg = format!("<svg viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\" xmlns=\"http://www.w3.org/2000/svg\">");
    for (color, width, pts) in &sk.s {
        if pts.is_empty() { continue; }
        let color: String = color.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '#').take(9).collect();
        let pressure = pts.iter().map(|p| p.get(2).copied().unwrap_or(0.5)).sum::<f64>() / pts.len() as f64;
        let sw = (width * (0.5 + pressure)).max(0.5);
        let mut d = String::new();
        for (i, p) in pts.iter().enumerate() {
            let (x, y) = (p.first().copied().unwrap_or(0.0), p.get(1).copied().unwrap_or(0.0));
            d += &format!("{}{:.1} {:.1}", if i == 0 { "M" } else { " L" }, x, y);
        }
        if pts.len() == 1 { d += " l0.1 0"; }
        svg += &format!("<path d=\"{d}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{sw:.1}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>");
    }
    Ok(svg + "</svg>")
}

/// The sources of a document for the Sources panel.
#[tauri::command]
pub async fn md_sources(text: String) -> Vec<Source> { sources(&text) }

#[cfg(test)]
pub fn render(src: &str, inline: bool) -> Rendered { render_lang(src, inline, "en") }

pub fn render_lang(src: &str, inline: bool, lang: &str) -> Rendered {
    let src = src.replace("\r\n", "\n");
    let list = sources(&src);
    let src = preprocess(&src, &list, true);
    let line_starts: Vec<usize> = std::iter::once(0).chain(src.match_indices('\n').map(|(i, _)| i + 1)).collect();
    let line_of = |off: usize| line_starts.partition_point(|&s| s <= off).saturating_sub(1);
    let mut out = Rendered::default();
    let mut depth = 0usize;
    let mut group: Vec<Event> = Vec::new();
    let mut group_line = 0usize;
    let mut in_code: Option<String> = None; // "math" / "mermaid" while inside such a fenced block
    let mut code_buf = String::new();
    let mut link_depth = 0usize;
    let mut code_depth = 0usize;
    let mut heading: Option<(u8, String, usize)> = None;

    let flush = |group: &mut Vec<Event>, line: usize, out: &mut Rendered| {
        if group.is_empty() { return; }
        let mut h = String::new();
        html::push_html(&mut h, std::mem::take(group).into_iter());
        out.html += &if inline { h } else { tag_line(&h, line) };
    };

    for (ev, range) in Parser::new_ext(&src, options()).into_offset_iter() {
        if depth == 0 {
            group_line = line_of(range.start);
        }
        match &ev {
            Event::Start(Tag::Heading { level, .. }) => heading = Some((*level as u8, String::new(), line_of(range.start))),
            Event::End(TagEnd::Heading(_)) => { if let Some(h) = heading.take() { out.headings.push((h.0, h.1.trim().to_string(), h.2)); } }
            Event::Text(t) | Event::Code(t) if heading.is_some() => { if let Some(h) = heading.as_mut() { h.1.push_str(t); } }
            Event::Start(Tag::Image { .. }) => out.stats.images += 1,
            _ => {}
        }
        match &ev {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let lang = info.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                code_depth += 1;
                let special = lang == "math" || lang == "mermaid" || lang == "sketch" || SOURCE_LANGS.contains(&lang.as_str());
                if !special { out.stats.code += 1; }
                if special {
                    in_code = Some(lang);
                    code_buf.clear();
                    depth += 1;
                    continue;
                }
            }
            Event::Start(Tag::CodeBlock(_)) => { code_depth += 1; out.stats.code += 1; }
            Event::End(TagEnd::CodeBlock) => {
                code_depth = code_depth.saturating_sub(1);
                if let Some(kind) = in_code.take() {
                    depth -= 1;
                    let code = std::mem::take(&mut code_buf);
                    let ph = if kind == "math" {
                        out.math.push((code.trim().to_string(), true));
                        format!("<div class=\"math-block\" data-math=\"{}\"></div>", out.math.len() - 1)
                    } else if kind == "sketch" {
                        out.sketches += 1;
                        match sketch_svg(&code) {
                            Ok(svg) => format!("<div class=\"sketch\" data-sketch=\"{}\">{svg}</div>", out.sketches - 1),
                            Err(e) => format!("<div class=\"sketch dg-error\" data-sketch=\"{}\">sketch: {}</div>", out.sketches - 1, escape(&e)),
                        }
                    } else if SOURCE_LANGS.contains(&kind.as_str()) {
                        bibliography_html(&list, lang)
                    } else {
                        out.diagrams.push(code);
                        format!("<div class=\"diagram\" data-diagram=\"{}\"></div>", out.diagrams.len() - 1)
                    };
                    group.push(Event::Html(CowStr::from(ph)));
                    if depth == 0 { flush(&mut group, group_line, &mut out); }
                    continue;
                }
            }
            Event::Text(t) if in_code.is_some() => { code_buf.push_str(t); continue; }
            Event::Start(Tag::Link { .. }) | Event::Start(Tag::Image { .. }) => link_depth += 1,
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => link_depth = link_depth.saturating_sub(1),
            _ => {}
        }
        let ev = match ev {
            Event::InlineMath(tex) => {
                out.math.push((tex.to_string(), false));
                Event::InlineHtml(CowStr::from(format!("<span class=\"math-inline\" data-math=\"{}\"></span>", out.math.len() - 1)))
            }
            Event::DisplayMath(tex) => {
                out.math.push((tex.trim().to_string(), true));
                Event::InlineHtml(CowStr::from(format!("<span class=\"math-block\" data-math=\"{}\"></span>", out.math.len() - 1)))
            }
            Event::Text(t) if link_depth == 0 && code_depth == 0 => match autolink(&t) {
                Some(parts) => { group.extend(parts); continue; }
                None => Event::Text(t),
            },
            other => other,
        };
        match &ev {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
        group.push(ev);
        if depth == 0 { flush(&mut group, group_line, &mut out); }
    }
    flush(&mut group, group_line, &mut out);
    out.stats.words = count_words(&src);
    out.stats.chars = src.encode_utf16().count();
    out.stats.lines = line_starts.len();
    // Links as shown: written links, bare web addresses and footnote links.
    out.stats.links = out.html.matches("<a href=").count();
    if inline {
        // One paragraph without its <p> wrapper (short texts in the syntax guide).
        let h = out.html.trim();
        if let Some(inner) = h.strip_prefix("<p>").and_then(|s| s.strip_suffix("</p>")) {
            if !inner.contains("<p>") { out.html = inner.to_string(); }
        }
    }
    out
}

/// Renders several Markdown texts at once (the preview, or all cards of the syntax guide).
#[tauri::command]
pub async fn md_render(sources: Vec<String>, inline: Option<bool>, lang: Option<String>) -> Vec<Rendered> {
    let lang = lang.unwrap_or_else(|| "en".into());
    sources.iter().map(|s| render_lang(s, inline.unwrap_or(false), &lang)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lines_math_diagrams() {
        let r = render("# Title\n\nText with $x^2$ and https://example.com.\n\n```mermaid\ngraph TD\nA-->B\n```\n\n$$\n\\frac{a}{b}\n$$\n\n- [x] done\n- todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", false);
        assert!(r.html.starts_with("<h1 data-line=\"0\">Title</h1>"), "{}", r.html);
        assert!(r.html.contains("<p data-line=\"2\">Text with <span class=\"math-inline\" data-math=\"0\"></span> and <a href=\"https://example.com\">https://example.com</a>.</p>"), "{}", r.html);
        assert!(r.html.contains("<div data-line=\"4\" class=\"diagram\" data-diagram=\"0\"></div>"), "{}", r.html);
        assert_eq!(r.diagrams[0], "graph TD\nA-->B\n");
        assert_eq!(r.math[0], ("x^2".to_string(), false));
        assert_eq!(r.math[1], ("\\frac{a}{b}".to_string(), true));
        assert!(r.html.contains("type=\"checkbox\""));
        assert!(r.html.contains("<table data-line=\"16\">"), "{}", r.html);
    }
    #[test]
    fn code_is_not_touched() {
        let r = render("`https://x.org` and `$a$`\n\n```js\nlet u = 'https://x.org';\n```\n", false);
        assert!(!r.html.contains("<a href"), "{}", r.html);
        assert!(r.math.is_empty());
        assert!(r.html.contains("<pre data-line=\"2\"><code class=\"language-js\">"), "{}", r.html);
    }
    #[test]
    fn prose_ranges() {
        let src = "Text with `code` and <kbd>Strg+S</kbd> end.

```js
let barr;
```

[link text](https://exampel.com) $x^2$";
        let parts: Vec<&str> = prose(src).iter().map(|&(a, b)| &src[a..b]).collect();
        assert_eq!(parts, ["Text with ", " and ", " end.", "link text", " "]);
    }

    #[test]
    fn outline_and_stats() {
        let r = render("# Eins

Text mit Wörtern, don't stop.

```js
x
```

## Zwei *kursiv*

![bild](a.png) [link](b) https://c.de
", false);
        assert_eq!(r.headings, vec![(1, "Eins".into(), 0), (2, "Zwei kursiv".into(), 8)]);
        assert_eq!((r.stats.code, r.stats.images, r.stats.links), (1, 1, 2));
        assert_eq!(count_words("Text mit Wörtern, don't stop - 2024"), 6);
    }
    #[test]
    fn inline_mode() {
        assert_eq!(render("Use **bold** text", true).html, "Use <strong>bold</strong> text");
    }

    #[test]
    fn sources_and_citations() {
        let src = "Text [@mueller20, S. 12] und [@bpb; @x].\n\nCode `[@mueller20]` bleibt.\n\n```quellen\n# Kommentar\nmueller20: Müller, Anna; Schmidt, Bo | Klima verstehen | 2020 | Beltz, Weinheim\nbpb: Bundeszentrale | Demokratie | 2023 | https://www.bpb.de/x | 01.10.2026\n```\n";
        let list = sources(src);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].key, "mueller20");
        assert_eq!(list[1].accessed, "01.10.2026");
        assert_eq!(list[0].line, 6);
        let plain = preprocess(src, &list, false);
        assert!(plain.starts_with("Text (Müller & Schmidt 2020, S. 12) und (Bundeszentrale 2023; ?x)."), "{plain}");
        assert!(plain.contains("`[@mueller20]`"));
        assert_eq!(plain.lines().count(), src.lines().count());
        let r = render_lang(src, false, "de");
        assert!(r.html.contains("<span class=\"cite cite-missing\""), "{}", r.html);
        assert!(r.html.contains("<div data-line=\"4\" class=\"biblio\"><p class=\"bib-entry\" id=\"src-bpb\">Bundeszentrale (2023): <em>Demokratie</em>. <a href=\"https://www.bpb.de/x\">https://www.bpb.de/x</a>. (Zugriff am 01.10.2026)</p>"), "{}", r.html);
        assert_eq!(r.stats.code, 0);
    }
    #[test]
    fn wiki_links_and_sketches() {
        let r = render("Siehe [[Mathe 1]] und [[Bio|Biologie]].\n\n```sketch\n{\"w\":100,\"h\":50,\"s\":[[\"#e5484d\",2,[[1,2,0.5],[3,4,0.5]]]]}\n```\n", false);
        assert!(r.html.contains("<a class=\"wikilink\" href=\"#\" data-note=\"Mathe 1\">Mathe 1</a>"), "{}", r.html);
        assert!(r.html.contains("data-note=\"Bio\">Biologie</a>"));
        assert!(r.html.contains("<div data-line=\"2\" class=\"sketch\" data-sketch=\"0\"><svg viewBox=\"0 0 100 50\""), "{}", r.html);
        assert!(r.html.contains("<path d=\"M1.0 2.0 L3.0 4.0\" fill=\"none\" stroke=\"#e5484d\" stroke-width=\"2.0\""), "{}", r.html);
        assert_eq!(r.sketches, 1);
        assert!(sketch_svg("not json").is_err());
    }
}
