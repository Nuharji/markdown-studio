//! Markdown → Word (.docx), written here without extra libraries: the document is walked with pulldown-cmark and
//! written as WordprocessingML, then packed into a ZIP. Covered: headings, paragraphs, bold / italic / strikethrough /
//! code, links, bullet / numbered / task lists (nested), quotes, code blocks, tables, rules, footnotes (as notes at the
//! end), pictures (local files next to the document, and diagrams / sketches the UI hands over as PNG), formulas (as
//! their TeX text), citations and the bibliography (markdown.rs). A4 with page numbers in the footer.

use crate::markdown::{bib_parts, preprocess, sources, SOURCE_LANGS};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::path::{Path, PathBuf};

/// A diagram or sketch drawn by the UI, as PNG (kind "diagram" / "sketch", index in document order).
#[derive(serde::Deserialize, Clone)]
pub struct Picture {
    pub kind: String,
    pub index: usize,
    pub png: Vec<u8>,
    pub w: u32,
    pub h: u32,
}

fn x(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Width × height of a PNG, JPEG or GIF file.
/// "%20" → " ", "%C3%BC" → "ü" (links to files with spaces or umlauts are written like that by most editors).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) { out.push((h * 16 + l) as u8); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// The bytes of a picture on disk, from a Markdown image link: relative to the document's folder or absolute,
/// percent-encoded or not, also file:/// links. Web addresses aren't fetched (the export stays offline).
fn local_picture(url: &str, base: Option<&Path>) -> Option<Vec<u8>> {
    let url = url.trim();
    let (url, decode_only) = match url.strip_prefix("file:///").or_else(|| url.strip_prefix("file://")) {
        Some(rest) => (rest, true),
        None if url.contains("://") || url.starts_with("data:") => return None,
        None => (url, false),
    };
    let decoded = percent_decode(url);
    // The decoded name first; the name as written too, in case a file really has "%" in its name.
    let mut names: Vec<String> = if decode_only || decoded == url { vec![decoded.clone()] } else { vec![decoded.clone(), url.to_string()] };
    // Written on Windows (Bilder\Bild.png): on macOS and Linux the backslash doesn't separate folders.
    if !cfg!(windows) {
        let slashed: Vec<String> = names.iter().filter(|n| n.contains('\\')).map(|n| n.replace('\\', "/")).collect();
        names.extend(slashed);
    }
    names.into_iter().find_map(|name| {
        let p = PathBuf::from(&name);
        let p = if p.is_absolute() { p } else { base.map(|b| b.join(&name)).unwrap_or(p) };
        std::fs::read(p).ok()
    })
}

fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() > 24 && &b[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some((u32::from_be_bytes([b[16], b[17], b[18], b[19]]), u32::from_be_bytes([b[20], b[21], b[22], b[23]])));
    }
    if b.len() > 10 && &b[..6] == b"GIF89a" || b.len() > 10 && &b[..6] == b"GIF87a" {
        return Some((u16::from_le_bytes([b[6], b[7]]) as u32, u16::from_le_bytes([b[8], b[9]]) as u32));
    }
    if b.len() > 4 && b[0] == 0xFF && b[1] == 0xD8 {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xFF { i += 1; continue; }
            let m = b[i + 1];
            if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
                return Some((u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32, u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32));
            }
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            i += 2 + len;
        }
    }
    None
}

#[derive(Default, Clone, Copy)]
struct Fmt { bold: bool, italic: bool, strike: bool, code: bool, sup: bool, link: bool }

struct ListCtx { ordered: bool, num: usize }

#[derive(Default)]
struct Doc {
    body: String,
    /// relationships after the fixed ones: (type, target, external)
    rels: Vec<(&'static str, String, bool)>,
    media: Vec<(String, Vec<u8>)>,
    /// numbering instances: Some(start) for numbered lists, None for bullets
    nums: Vec<Option<u64>>,
    pics: usize,
}

impl Doc {
    fn rel(&mut self, kind: &'static str, target: String, external: bool) -> String {
        self.rels.push((kind, target, external));
        format!("rId{}", self.rels.len() + 10)
    }
    /// An inline picture run, at most 16 cm wide.
    fn picture(&mut self, bytes: Vec<u8>, ext: &str, w: u32, h: u32, alt: &str) -> String {
        self.pics += 1;
        let name = format!("image{}.{ext}", self.pics);
        let rid = self.rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", format!("media/{name}"), false);
        self.media.push((name.clone(), bytes));
        let max = 16.0 * 360000.0;
        let (mut cx, mut cy) = (w.max(1) as f64 * 9525.0, h.max(1) as f64 * 9525.0); // 96 dpi
        if cx > max { cy *= max / cx; cx = max; }
        let (cx, cy) = (cx as u64, cy as u64);
        let id = self.pics;
        format!("<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{id}\" name=\"Picture {id}\" descr=\"{alt}\"/>\
<a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>", alt = x(alt))
    }
}

fn run(text: &str, f: Fmt) -> String {
    if text.is_empty() { return String::new(); }
    let mut p = String::new();
    if f.link { p += "<w:rStyle w:val=\"Hyperlink\"/>"; }
    if f.code { p += "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/>"; }
    if f.bold { p += "<w:b/>"; }
    if f.italic { p += "<w:i/>"; }
    if f.strike { p += "<w:strike/>"; }
    if f.code { p += "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/>"; }
    if f.sup { p += "<w:vertAlign w:val=\"superscript\"/>"; }
    let rpr = if p.is_empty() { String::new() } else { format!("<w:rPr>{p}</w:rPr>") };
    format!("<w:r>{rpr}<w:t xml:space=\"preserve\">{}</w:t></w:r>", x(text))
}

fn para(style: Option<&str>, extra_ppr: &str, runs: &str) -> String {
    let st = style.map(|s| format!("<w:pStyle w:val=\"{s}\"/>")).unwrap_or_default();
    let ppr = if st.is_empty() && extra_ppr.is_empty() { String::new() } else { format!("<w:pPr>{st}{extra_ppr}</w:pPr>") };
    format!("<w:p>{ppr}{runs}</w:p>")
}

/// Builds the .docx file. `base` is the folder of the Markdown file (for pictures given by relative path).
pub fn build(text: &str, lang: &str, title: &str, base: Option<&Path>, pictures: &[Picture]) -> Vec<u8> {
    let de = lang == "de";
    let list = sources(text);
    let src = preprocess(&text.replace("\r\n", "\n"), &list, false);
    let opts = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH | Options::ENABLE_GFM;

    let mut d = Doc::default();
    let mut f = Fmt::default();
    // The paragraph being written: (style, extra pPr, runs)
    let mut cur: Option<(Option<String>, String, String)> = None;
    let mut out_stack: Vec<String> = Vec::new(); // footnote bodies are written aside
    let mut lists: Vec<ListCtx> = Vec::new();
    let mut item_fresh = false;
    let mut quote = 0usize;
    let mut code: Option<(String, String)> = None; // (lang, text)
    let mut table: Option<(String, bool)> = None; // (xml, in head)
    let mut cell_open = false;
    let mut image: Option<(String, String)> = None; // (url, alt)
    let mut notes: Vec<(String, String)> = Vec::new(); // label, xml
    let mut note_order: Vec<String> = Vec::new();
    let mut note_body: Option<(String, String)> = None;
    let (mut diagrams, mut sketches) = (0usize, 0usize);

    macro_rules! target { () => { if let Some((_, b)) = note_body.as_mut() { b } else { &mut d.body } } }
    let close = |cur: &mut Option<(Option<String>, String, String)>, tgt: &mut String| {
        if let Some((st, ppr, runs)) = cur.take() { tgt.push_str(&para(st.as_deref(), &ppr, &runs)); }
    };
    let note_no = |order: &mut Vec<String>, label: &str| -> usize {
        match order.iter().position(|l| l == label) { Some(i) => i + 1, None => { order.push(label.to_string()); order.len() } }
    };

    for ev in Parser::new_ext(&src, opts) {
        // Inside a fenced block everything is collected as text.
        if let Some((_, buf)) = code.as_mut() {
            match ev {
                Event::Text(t) => { buf.push_str(&t); continue; }
                Event::End(TagEnd::CodeBlock) => {}
                _ => continue,
            }
        }
        if let Some((_, alt)) = image.as_mut() {
            match &ev {
                Event::Text(t) | Event::Code(t) => { alt.push_str(t); continue; }
                Event::End(TagEnd::Image) => {}
                _ => continue,
            }
        }
        match ev {
            Event::Start(Tag::Paragraph) => {
                if item_fresh { item_fresh = false; } else {
                    close(&mut cur, target!());
                    let ind = if lists.is_empty() { String::new() } else { format!("<w:ind w:left=\"{}\"/>", 720 * lists.len()) };
                    let st = if quote > 0 { Some("Quote".to_string()) } else if table.is_some() { None } else { None };
                    cur = Some((st, ind, String::new()));
                }
            }
            Event::End(TagEnd::Paragraph) => close(&mut cur, target!()),
            Event::Start(Tag::Heading { level, .. }) => {
                close(&mut cur, target!());
                let n = match level { HeadingLevel::H1 => 1, HeadingLevel::H2 => 2, HeadingLevel::H3 => 3, HeadingLevel::H4 => 4, HeadingLevel::H5 => 5, HeadingLevel::H6 => 6 };
                cur = Some((Some(format!("Heading{n}")), String::new(), String::new()));
            }
            Event::End(TagEnd::Heading(_)) => close(&mut cur, target!()),
            Event::Start(Tag::BlockQuote(_)) => { close(&mut cur, target!()); quote += 1; }
            Event::End(TagEnd::BlockQuote(_)) => quote = quote.saturating_sub(1),
            Event::Start(Tag::List(start)) => {
                close(&mut cur, target!());
                d.nums.push(start);
                lists.push(ListCtx { ordered: start.is_some(), num: d.nums.len() });
            }
            Event::End(TagEnd::List(_)) => { close(&mut cur, target!()); lists.pop(); }
            Event::Start(Tag::Item) => {
                close(&mut cur, target!());
                let l = lists.last().map(|l| (l.num, l.ordered)).unwrap_or((1, false));
                let lvl = lists.len().saturating_sub(1).min(8);
                cur = Some((Some("ListParagraph".into()), format!("<w:numPr><w:ilvl w:val=\"{lvl}\"/><w:numId w:val=\"{}\"/></w:numPr>", l.0), String::new()));
                item_fresh = true;
            }
            Event::End(TagEnd::Item) => { close(&mut cur, target!()); item_fresh = false; }
            Event::TaskListMarker(done) => { if let Some(c) = cur.as_mut() { c.2 += &run(if done { "☑ " } else { "☐ " }, Fmt::default()); } }
            Event::Start(Tag::CodeBlock(kind)) => {
                close(&mut cur, target!());
                let lang = match kind { CodeBlockKind::Fenced(i) => i.split_whitespace().next().unwrap_or("").to_ascii_lowercase(), _ => String::new() };
                code = Some((lang, String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                let (lang, text) = code.take().unwrap_or_default();
                let tgt = target!();
                if lang == "math" {
                    tgt.push_str(&para(Some("Formula"), "", &run(text.trim(), Fmt { italic: true, ..Fmt::default() })));
                } else if lang == "mermaid" || lang == "sketch" {
                    let (kind, idx) = if lang == "mermaid" { diagrams += 1; ("diagram", diagrams - 1) } else { sketches += 1; ("sketch", sketches - 1) };
                    match pictures.iter().find(|p| p.kind == kind && p.index == idx) {
                        Some(p) => { let r = d.picture(p.png.clone(), "png", p.w, p.h, kind); target!().push_str(&para(Some("Figure"), "", &r)); }
                        None => tgt.push_str(&para(Some("Code"), "", &run(&format!("[{}]", if kind == "diagram" { if de { "Diagramm" } else { "Diagram" } } else if de { "Skizze" } else { "Sketch" }), Fmt::default()))),
                    }
                } else if SOURCE_LANGS.contains(&lang.as_str()) {
                    let mut sorted = list.clone();
                    sorted.sort_by_key(|s| (s.author.to_lowercase(), s.year.clone()));
                    for s in &sorted {
                        let runs: String = bib_parts(s, lang_of(de)).iter().map(|(t, it)| run(t, Fmt { italic: *it, ..Fmt::default() })).collect();
                        tgt.push_str(&para(Some("Bibliography"), "", &runs));
                    }
                } else {
                    for line in text.trim_end_matches('\n').split('\n') { tgt.push_str(&para(Some("Code"), "", &run(line, Fmt::default()))); }
                }
            }
            Event::Start(Tag::Table(aligns)) => {
                close(&mut cur, target!());
                let w = 9000 / aligns.len().max(1);
                let grid: String = aligns.iter().map(|_| format!("<w:gridCol w:w=\"{w}\"/>")).collect();
                table = Some((format!("<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>"), false));
            }
            Event::End(TagEnd::Table) => { if let Some((xml, _)) = table.take() { let t = target!(); t.push_str(&xml); t.push_str("</w:tbl>"); t.push_str(&para(None, "", "")); } }
            Event::Start(Tag::TableHead) => { if let Some(t) = table.as_mut() { t.0 += "<w:tr><w:trPr><w:tblHeader/></w:trPr>"; t.1 = true; } }
            Event::End(TagEnd::TableHead) => { if let Some(t) = table.as_mut() { t.0 += "</w:tr>"; t.1 = false; } }
            Event::Start(Tag::TableRow) => { if let Some(t) = table.as_mut() { t.0 += "<w:tr>"; } }
            Event::End(TagEnd::TableRow) => { if let Some(t) = table.as_mut() { t.0 += "</w:tr>"; } }
            Event::Start(Tag::TableCell) => {
                let head = table.as_ref().map(|t| t.1).unwrap_or(false);
                if head { f.bold = true; }
                cur = Some((None, String::new(), String::new()));
                cell_open = true;
                if let Some(t) = table.as_mut() { t.0 += &format!("<w:tc><w:tcPr>{}</w:tcPr>", if head { "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"E8EEF7\"/>" } else { "" }); }
            }
            Event::End(TagEnd::TableCell) => {
                if let Some(t) = table.as_mut() {
                    if let Some((st, ppr, runs)) = cur.take() { t.0 += &para(st.as_deref(), &ppr, &runs); }
                    t.0 += "</w:tc>";
                }
                cell_open = false;
                if table.as_ref().map(|t| t.1).unwrap_or(false) { f.bold = false; }
            }
            Event::Start(Tag::Emphasis) => f.italic = true,
            Event::End(TagEnd::Emphasis) => f.italic = false,
            Event::Start(Tag::Strong) => f.bold = true,
            Event::End(TagEnd::Strong) => f.bold = cell_open && table.as_ref().map(|t| t.1).unwrap_or(false),
            Event::Start(Tag::Strikethrough) => f.strike = true,
            Event::End(TagEnd::Strikethrough) => f.strike = false,
            Event::Start(Tag::Link { dest_url, .. }) => {
                if cur.is_none() { cur = Some((None, String::new(), String::new())); }
                if dest_url.starts_with("http://") || dest_url.starts_with("https://") || dest_url.starts_with("mailto:") {
                    let rid = d.rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", x(&dest_url), true);
                    if let Some(c) = cur.as_mut() { c.2 += &format!("<w:hyperlink r:id=\"{rid}\">"); }
                    f.link = true;
                }
            }
            Event::End(TagEnd::Link) => { if f.link { if let Some(c) = cur.as_mut() { c.2 += "</w:hyperlink>"; } f.link = false; } }
            Event::Start(Tag::Image { dest_url, .. }) => image = Some((dest_url.to_string(), String::new())),
            Event::End(TagEnd::Image) => {
                let (url, alt) = image.take().unwrap_or_default();
                let pic = local_picture(&url, base).and_then(|b| image_size(&b).map(|s| (b, s)));
                let r = match pic {
                    Some((b, (w, h))) => {
                        let ext = if b.starts_with(b"\x89PNG") { "png" } else if b.starts_with(b"GIF") { "gif" } else { "jpeg" };
                        d.picture(b, ext, w, h, &alt)
                    }
                    None => run(&format!("[{}: {}]", if de { "Bild" } else { "Image" }, if alt.is_empty() { &url } else { &alt }), Fmt { italic: true, ..Fmt::default() }),
                };
                if cur.is_none() { cur = Some((Some("Figure".into()), String::new(), String::new())); }
                if let Some(c) = cur.as_mut() { c.2 += &r; }
            }
            Event::Text(t) => {
                if cur.is_none() { cur = Some((None, String::new(), String::new())); }
                if let Some(c) = cur.as_mut() { c.2 += &run(&t, f); }
            }
            Event::Code(t) => { if let Some(c) = cur.as_mut() { c.2 += &run(&t, Fmt { code: true, ..f }); } }
            Event::InlineMath(t) => { if let Some(c) = cur.as_mut() { c.2 += &run(&t, Fmt { italic: true, ..f }); } }
            Event::DisplayMath(t) => {
                close(&mut cur, target!());
                target!().push_str(&para(Some("Formula"), "", &run(t.trim(), Fmt { italic: true, ..Fmt::default() })));
            }
            Event::SoftBreak => { if let Some(c) = cur.as_mut() { c.2 += &run(" ", f); } }
            Event::HardBreak => { if let Some(c) = cur.as_mut() { c.2 += "<w:r><w:br/></w:r>"; } }
            Event::Rule => {
                close(&mut cur, target!());
                target!().push_str(&para(None, "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"BFBFBF\"/></w:pBdr>", ""));
            }
            Event::FootnoteReference(label) => {
                let n = note_no(&mut note_order, &label);
                if let Some(c) = cur.as_mut() { c.2 += &run(&n.to_string(), Fmt { sup: true, ..f }); }
            }
            Event::Start(Tag::FootnoteDefinition(label)) => {
                close(&mut cur, target!());
                out_stack.push(String::new());
                note_body = Some((label.to_string(), String::new()));
            }
            Event::End(TagEnd::FootnoteDefinition) => {
                close(&mut cur, target!());
                if let Some((label, body)) = note_body.take() { note_no(&mut note_order, &label); notes.push((label, body)); }
                out_stack.pop();
            }
            _ => {}
        }
    }
    close(&mut cur, target!());
    if !notes.is_empty() {
        d.body += &para(Some("Heading2"), "", &run(if de { "Anmerkungen" } else { "Notes" }, Fmt::default()));
        for (i, label) in note_order.iter().enumerate() {
            if let Some((_, body)) = notes.iter().find(|(l, _)| l == label) {
                // The number goes in front of the note's first paragraph.
                let num = run(&format!("{} ", i + 1), Fmt { sup: true, ..Fmt::default() });
                d.body += &match body.find("<w:r>") { Some(p) => format!("{}{num}{}", &body[..p], &body[p..]), None => body.clone() };
            }
        }
    }
    package(d, title, lang)
}

fn lang_of(de: bool) -> &'static str { if de { "de" } else { "en" } }

/* ── package ── */
const W_NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";
const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

fn styles(lang: &str) -> String {
    let heading = |n: u8, size: u32, color: &str| format!("<w:style w:type=\"paragraph\" w:styleId=\"Heading{n}\"><w:name w:val=\"heading {n}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/>\
<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"{}\" w:after=\"120\"/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:color w:val=\"{color}\"/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>",
        if n == 1 { 360 } else { 240 }, n - 1);
    let l = if lang == "de" { "de-DE" } else { "en-US" };
    format!("{XML}<w:styles {W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Calibri\" w:cs=\"Calibri\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/><w:lang w:val=\"{l}\"/></w:rPr></w:rPrDefault>\
<w:pPrDefault><w:pPr><w:spacing w:after=\"160\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:rPr><w:b/><w:sz w:val=\"48\"/></w:rPr></w:style>\
{}{}{}{}{}{}\
<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val=\"single\" w:sz=\"18\" w:space=\"8\" w:color=\"378EF0\"/></w:pBdr><w:ind w:left=\"360\"/></w:pPr><w:rPr><w:i/><w:color w:val=\"404040\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F4F4F4\"/><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:ind w:left=\"120\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/><w:sz w:val=\"19\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Formula\"><w:name w:val=\"Formula\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Figure\"><w:name w:val=\"Figure\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:jc w:val=\"center\"/></w:pPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:after=\"60\"/><w:ind w:left=\"720\"/><w:contextualSpacing/></w:pPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Bibliography\"><w:name w:val=\"Bibliography\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"567\" w:hanging=\"567\"/></w:pPr></w:style>\
<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>\
<w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:pPr><w:spacing w:after=\"0\"/></w:pPr><w:tblPr><w:tblBorders>\
<w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
<w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
</w:tblBorders><w:tblCellMar><w:left w:w=\"108\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style></w:styles>",
        heading(1, 36, "1F3864"), heading(2, 30, "1F3864"), heading(3, 26, "2F5496"), heading(4, 24, "2F5496"), heading(5, 22, "2F5496"), heading(6, 22, "595959"))
}

fn numbering(nums: &[Option<u64>]) -> String {
    let lvls = |ordered: bool| (0..9).map(|i| {
        let (fmt, text) = if ordered { (["decimal", "lowerLetter", "lowerRoman"][i % 3], format!("%{}.", i + 1)) } else { ("bullet", ["•", "◦", "▪"][i % 3].to_string()) };
        format!("<w:lvl w:ilvl=\"{i}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>", 720 * (i + 1))
    }).collect::<String>();
    let mut s = format!("{XML}<w:numbering {W_NS}><w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{}</w:abstractNum><w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{}</w:abstractNum>", lvls(false), lvls(true));
    for (i, n) in nums.iter().enumerate() {
        // Every numbered list restarts at its own first number.
        s += &match n {
            Some(start) => format!("<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"1\"/><w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"{start}\"/></w:lvlOverride></w:num>", i + 1),
            None => format!("<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"0\"/></w:num>", i + 1),
        };
    }
    if nums.is_empty() { s += "<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>"; }
    s + "</w:numbering>"
}

fn package(d: Doc, title: &str, lang: &str) -> Vec<u8> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let doc = format!("{XML}<w:document {W_NS} xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>{}\
<w:sectPr><w:footerReference w:type=\"default\" r:id=\"rId3\"/><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1417\" w:right=\"1417\" w:bottom=\"1134\" w:left=\"1417\" w:header=\"708\" w:footer=\"567\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>", d.body);
    let mut rels = String::from("<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>\
<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer\" Target=\"footer1.xml\"/>");
    for (i, (kind, target, ext)) in d.rels.iter().enumerate() {
        rels += &format!("<Relationship Id=\"rId{}\" Type=\"{kind}\" Target=\"{target}\"{}/>", i + 11, if *ext { " TargetMode=\"External\"" } else { "" });
    }
    let footer = format!("{XML}<w:ftr {W_NS}><w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType=\"end\"/></w:r></w:p></w:ftr>");
    let core = format!("{XML}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:language>{}</dc:language></cp:coreProperties>", x(title), if lang == "de" { "de-DE" } else { "en-US" });
    files.push(("[Content_Types].xml".into(), format!("{XML}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"gif\" ContentType=\"image/gif\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
<Override PartName=\"/word/footer1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>").into_bytes()));
    files.push(("_rels/.rels".into(), format!("{XML}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>").into_bytes()));
    files.push(("word/document.xml".into(), doc.into_bytes()));
    files.push(("word/_rels/document.xml.rels".into(), format!("{XML}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{rels}</Relationships>").into_bytes()));
    files.push(("word/styles.xml".into(), styles(lang).into_bytes()));
    files.push(("word/numbering.xml".into(), numbering(&d.nums).into_bytes()));
    files.push(("word/footer1.xml".into(), footer.into_bytes()));
    files.push(("docProps/core.xml".into(), core.into_bytes()));
    for (name, bytes) in d.media { files.push((format!("word/media/{name}"), bytes)); }
    zip(&files)
}

/* ── ZIP (stored) ── */
fn crc32(b: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &x in b { c ^= x as u32; for _ in 0..8 { c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 }; } }
    !c
}
pub fn zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in files {
        let (crc, size, off) = (crc32(data), data.len() as u32, out.len() as u32);
        let n = name.as_bytes();
        let head = |sig: u32| { let mut h = sig.to_le_bytes().to_vec(); h.extend([20, 0]); h };
        let mut l = head(0x0403_4b50);
        l.extend([0, 8, 0, 0, 0, 0, 0x21, 0]);            // flags (UTF-8 names), stored, time, date (1980-01-01)
        l.extend(crc.to_le_bytes()); l.extend(size.to_le_bytes()); l.extend(size.to_le_bytes());
        l.extend((n.len() as u16).to_le_bytes()); l.extend([0, 0]);
        out.extend(&l); out.extend(n); out.extend(data);
        let mut c = head(0x0201_4b50);
        c.extend([20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0]);
        c.extend(crc.to_le_bytes()); c.extend(size.to_le_bytes()); c.extend(size.to_le_bytes());
        c.extend((n.len() as u16).to_le_bytes()); c.extend([0; 8]); c.extend([0; 4]); c.extend(off.to_le_bytes());
        central.extend(c); central.extend(n);
    }
    let (cd_off, cd_len, count) = (out.len() as u32, central.len() as u32, files.len() as u16);
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes()); out.extend([0; 4]);
    out.extend(count.to_le_bytes()); out.extend(count.to_le_bytes());
    out.extend(cd_len.to_le_bytes()); out.extend(cd_off.to_le_bytes()); out.extend([0, 0]);
    out
}

/// Export as Word: save dialog, then the file is written (None = cancelled).
#[tauri::command]
pub async fn export_docx(app: tauri::AppHandle, text: String, title: String, lang: String, path: Option<String>, pictures: Vec<Picture>) -> Result<Option<String>, String> {
    let base = path.as_deref().map(Path::new).and_then(Path::parent).map(Path::to_path_buf);
    let bytes = build(&text, &lang, &title, base.as_deref(), &pictures);
    // Debug builds only: automated tests export without the save dialog.
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("MD_EXPORT_TO") {
        std::fs::write(&p, &bytes).map_err(|e| e.to_string())?;
        return Ok(Some(p));
    }
    let Some(f) = crate::shared::file_dialog(&app).set_title("Export as Word").set_file_name(&format!("{title}.docx")).add_filter("Word", &["docx"]).blocking_save_file() else {
        return Ok(None);
    };
    let target = f.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn part(zipb: &[u8], name: &str) -> String {
        // Stored ZIP: find the local header with this name and read its data.
        let n = name.as_bytes();
        let mut i = 0;
        while i + 30 < zipb.len() {
            if zipb[i..i + 4] == [0x50, 0x4b, 3, 4] {
                let size = u32::from_le_bytes(zipb[i + 18..i + 22].try_into().unwrap()) as usize;
                let nl = u16::from_le_bytes(zipb[i + 26..i + 28].try_into().unwrap()) as usize;
                if &zipb[i + 30..i + 30 + nl] == n { return String::from_utf8_lossy(&zipb[i + 30 + nl..i + 30 + nl + size]).into_owned(); }
                i += 30 + nl + size;
            } else { i += 1; }
        }
        panic!("{name} missing")
    }
    #[test]
    fn word_document() {
        let md = "# Titel & mehr\n\nText mit **fett**, *kursiv*, ~~weg~~, `code` und [Link](https://x.de) [@a].[^1]\n\n- eins\n  - tiefer\n- [x] erledigt\n\n3. drei\n4. vier\n\n> Zitat\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$$\nE = mc^2\n$$\n\n---\n\n```quellen\na: Müller, Anna | Buch | 2020 | Beltz\n```\n\n[^1]: Eine Fußnote.\n";
        let z = build(md, "de", "Test", None, &[]);
        let doc = part(&z, "word/document.xml");
        assert!(doc.contains("<w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t xml:space=\"preserve\">Titel &amp; mehr</w:t></w:r>"), "{doc}");
        assert!(doc.contains("<w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">fett</w:t>"));
        assert!(doc.contains("<w:hyperlink r:id=\"rId11\"><w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/></w:rPr><w:t xml:space=\"preserve\">Link</w:t></w:r></w:hyperlink>"), "{doc}");
        assert!(doc.contains("(Müller 2020)"));
        assert!(doc.contains("<w:ilvl w:val=\"1\"/>"), "nested list level");
        assert!(doc.contains("☑ "));
        assert!(doc.contains("<w:pStyle w:val=\"Code\"/></w:pPr><w:r><w:t xml:space=\"preserve\">let b = 2;</w:t>"));
        assert!(doc.contains("<w:tbl>") && doc.contains("<w:tblHeader/>"));
        assert!(doc.contains("<w:pStyle w:val=\"Formula\"/>") && doc.contains("E = mc^2"));
        assert!(doc.contains("<w:pStyle w:val=\"Bibliography\"/>") && doc.contains(">Buch</w:t>"));
        assert!(doc.contains(">Anmerkungen</w:t>") && doc.contains(">Eine Fußnote.</w:t>"));
        let num = part(&z, "word/numbering.xml");
        assert!(num.contains("<w:startOverride w:val=\"3\"/>"), "{num}");
        let rels = part(&z, "word/_rels/document.xml.rels");
        assert!(rels.contains("Target=\"https://x.de\" TargetMode=\"External\""));
        // Every part is well-formed enough to have matching document tags.
        assert!(doc.ends_with("</w:body></w:document>"));
    }
    #[test]
    fn local_pictures_with_spaces_and_umlauts() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(20u32.to_be_bytes()); png.extend(10u32.to_be_bytes()); png.extend([8, 2, 0, 0, 0]);
        let dir = std::env::temp_dir().join(format!("md-docx-pics-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Bilder")).unwrap();
        for name in ["Mein Bild.png", "Grüße.png", "Bilder/Klasse 7b.png"] { std::fs::write(dir.join(name), &png).unwrap(); }
        // How other editors write such links: percent-encoded, in <…>, or plain; also a Windows path with backslashes.
        let md = "![a](Mein%20Bild.png)\n\n![b](<Mein Bild.png>)\n\n![c](Gr%C3%BC%C3%9Fe.png)\n\n![d](Grüße.png)\n\n![e](Bilder/Klasse%207b.png)\n\n![f](Bilder\\Klasse%207b.png)\n";
        let z = build(md, "de", "P", Some(&dir), &[]);
        let doc = part(&z, "word/document.xml");
        std::fs::remove_dir_all(&dir).ok();
        assert!(!doc.contains("[Bild:"), "a picture was not found: {doc}");
        assert_eq!(doc.matches("<wp:extent ").count(), 6, "{doc}");
    }
    #[test]
    fn pictures_and_sizes() {
        let png = {
            let mut p = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
            p.extend(200u32.to_be_bytes()); p.extend(100u32.to_be_bytes()); p.extend([8, 2, 0, 0, 0]);
            p
        };
        assert_eq!(image_size(&png), Some((200, 100)));
        let z = build("```mermaid\ngraph TD\n```\n\n```sketch\n{}\n```\n", "en", "P", None, &[Picture { kind: "diagram".into(), index: 0, png: png.clone(), w: 200, h: 100 }]);
        let doc = part(&z, "word/document.xml");
        assert!(doc.contains("<wp:extent cx=\"1905000\" cy=\"952500\"/>"), "{doc}");
        assert!(doc.contains(">[Sketch]</w:t>"));
        assert_eq!(part(&z, "word/media/image1.png").len() > 0, true);
    }
    /// `MD_DOCX_SAMPLE=/path/file.docx cargo test sample` writes an example file to look at.
    #[test]
    fn sample() {
        let Ok(p) = std::env::var("MD_DOCX_SAMPLE") else { return };
        let md = "# Referat: Klimawandel\n\n**Name:** Jamie · **Klasse:** 10b\n\n## 1 Einleitung\n\nDer Klimawandel [@ipcc, S. 4] betrifft *alle*.[^a]\n\n1. Ursachen\n2. Folgen\n   - Hitze\n   - Dürre\n\n> Wichtig ist, was wir tun.\n\n| Jahr | CO₂ (ppm) |\n|---|---|\n| 1990 | 354 |\n| 2020 | 414 |\n\nFormel: $E = mc^2$\n\n## Literaturverzeichnis\n\n```quellen\nipcc: IPCC | Sechster Sachstandsbericht | 2023 | https://www.ipcc.ch | 01.10.2026\n```\n\n[^a]: Stand 2026.\n";
        std::fs::write(p, build(md, "de", "Referat", None, &[])).unwrap();
    }
}
