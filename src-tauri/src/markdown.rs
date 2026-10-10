//! Markdown → HTML in Rust (pulldown-cmark), with the extras the preview needs:
//! - GitHub-style tables, task lists, strikethrough, footnotes, bare links (https://…, www.…) turned into links
//! - `$…$` / `$$…$$` and ```` ```math ```` become placeholders; ```` ```mermaid ```` becomes a diagram placeholder
//!   (the UI draws them with KaTeX / Mermaid)
//! - every top-level block gets `data-line` = its first source line (0-based), used for synchronized scrolling.
//! The UI still sanitizes the HTML (DOMPurify) right before showing it.

use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

#[derive(Serialize, Default)]
pub struct Rendered {
    html: String,
    /// [tex, display]
    math: Vec<(String, bool)>,
    diagrams: Vec<String>,
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

pub fn render(src: &str, inline: bool) -> Rendered {
    let src = src.replace("\r\n", "\n");
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
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let lang = info.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                code_depth += 1;
                if lang == "math" || lang == "mermaid" {
                    in_code = Some(lang);
                    code_buf.clear();
                    depth += 1;
                    continue;
                }
            }
            Event::Start(Tag::CodeBlock(_)) => code_depth += 1,
            Event::End(TagEnd::CodeBlock) => {
                code_depth = code_depth.saturating_sub(1);
                if let Some(kind) = in_code.take() {
                    depth -= 1;
                    let code = std::mem::take(&mut code_buf);
                    let ph = if kind == "math" {
                        out.math.push((code.trim().to_string(), true));
                        format!("<div class=\"math-block\" data-math=\"{}\"></div>", out.math.len() - 1)
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
pub async fn md_render(sources: Vec<String>, inline: Option<bool>) -> Vec<Rendered> {
    sources.iter().map(|s| render(s, inline.unwrap_or(false))).collect()
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
    fn inline_mode() {
        assert_eq!(render("Use **bold** text", true).html, "Use <strong>bold</strong> text");
    }
}
