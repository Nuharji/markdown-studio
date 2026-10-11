//! Editor operations on the Markdown source: formatting (bold, lists, headings …), inserting blocks,
//! find & replace. The UI sends the text and the selection, Rust answers with one edit
//! (replace `s..e` with `text`, then select `sel_s..sel_e`), which the UI applies so it can be undone.
//! Positions are UTF-16 offsets, like the text field's selection.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Serialize, Debug, PartialEq)]
pub struct Edit {
    s: usize,
    e: usize,
    text: String,
    sel_s: usize,
    sel_e: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Cmd {
    /// Wrap the selection (or a placeholder) in `before`/`after`; unwraps if it is already wrapped.
    Wrap { before: String, after: String, placeholder: String },
    /// Turn the selected lines into a list / quote, or back (`ul`, `ol`, `task`, `quote`).
    Prefix { list: String },
    /// Heading level 0–6 for the current line; `toggle`: the same level again removes it. `cycle`: next level (1→2→3→none).
    Heading { level: usize, toggle: bool, cycle: bool },
    /// Insert a block on its own lines (blank lines around); `sel_from`/`sel_len` select part of it afterwards.
    Block { block: String, sel_from: Option<usize>, sel_len: Option<usize> },
}

/* ---------- UTF-16 positions ---------- */

pub fn u16len(s: &str) -> usize { s.encode_utf16().count() }

/// Byte index of a UTF-16 offset (clamped to the text).
pub fn byte_at(s: &str, pos: usize) -> usize {
    let mut u = 0;
    for (i, ch) in s.char_indices() {
        if u >= pos { return i; }
        u += ch.len_utf16();
    }
    s.len()
}

fn line_bounds(v: &str, s: usize) -> (usize, usize) {
    let ls = v[..s].rfind('\n').map_or(0, |i| i + 1);
    let le = v[s..].find('\n').map_or(v.len(), |i| s + i);
    (ls, le)
}

/// Builds an edit from byte positions (converted to UTF-16 for the UI).
fn edit(v: &str, s: usize, e: usize, text: String, sel: Option<(usize, usize)>) -> Edit {
    let (us, ue) = (u16len(&v[..s]), u16len(&v[..e]));
    let end = us + u16len(&text);
    let (sel_s, sel_e) = sel.unwrap_or((end, end));
    Edit { s: us, e: ue, text, sel_s, sel_e }
}

/* ---------- Commands ---------- */

fn wrap(v: &str, s: usize, e: usize, b: &str, a: &str, ph: &str) -> Edit {
    let sel = &v[s..e];
    let bl = u16len(b);
    let us = u16len(&v[..s]);
    if !sel.is_empty() && v[..s].ends_with(b) && v[e..].starts_with(a) {
        let sl = u16len(sel);
        return edit(v, s - b.len(), e + a.len(), sel.to_string(), Some((us - bl, us - bl + sl)));
    }
    if sel.len() >= b.len() + a.len() && sel.starts_with(b) && sel.ends_with(a) {
        let inner = &sel[b.len()..sel.len() - a.len()];
        return edit(v, s, e, inner.to_string(), Some((us, us + u16len(inner))));
    }
    let txt = if sel.is_empty() { ph } else { sel };
    edit(v, s, e, format!("{b}{txt}{a}"), Some((us + bl, us + bl + u16len(txt))))
}

static STRIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)").unwrap());
static UL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[-*+]\s+").unwrap());
static TASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[-*+]\s+\[[ xX]\]\s").unwrap());
static OL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d+[.)]\s").unwrap());
static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*>").unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}(#{1,6})\s+").unwrap());

fn is_kind(line: &str, kind: &str) -> bool {
    match kind {
        "ul" => UL.is_match(line) && !TASK.is_match(line),
        "task" => TASK.is_match(line),
        "ol" => OL.is_match(line),
        _ => QUOTE.is_match(line),
    }
}

fn prefix(v: &str, s: usize, mut e: usize, kind: &str) -> Edit {
    if e > s && v[..e].ends_with('\n') { e -= 1; }
    let ls = v[..s].rfind('\n').map_or(0, |i| i + 1);
    let le = v[e..].find('\n').map_or(v.len(), |i| e + i);
    let lines: Vec<&str> = v[ls..le].split('\n').collect();
    let filled: Vec<&&str> = lines.iter().filter(|l| !l.trim().is_empty()).collect();
    let all_on = !filled.is_empty() && filled.iter().all(|l| is_kind(l, kind));
    let mut n = 0;
    let out: Vec<String> = lines
        .iter()
        .map(|l| {
            if l.trim().is_empty() && lines.len() > 1 { return l.to_string(); }
            let stripped = STRIP.replace(l, "$1").into_owned();
            if all_on { return stripped; }
            let ind_len = l.len() - l.trim_start().len();
            let marker = match kind { "ol" => { n += 1; format!("{n}. ") } "task" => "- [ ] ".into(), "quote" => "> ".into(), _ => "- ".into() };
            format!("{}{}{}", &l[..ind_len], marker, &stripped[ind_len.min(stripped.len())..])
        })
        .collect();
    let text = out.join("\n");
    let us = u16len(&v[..ls]);
    let sel = if lines.len() == 1 { None } else { Some((us, us + u16len(&text))) };
    edit(v, ls, le, text, sel)
}

fn heading(v: &str, s: usize, level: usize, toggle: bool, cycle: bool) -> Edit {
    let (ls, le) = line_bounds(v, s);
    let line = &v[ls..le];
    let cur = HEADING.captures(line).map_or(0, |c| c[1].len());
    let level = if cycle { if cur >= 3 { 0 } else { cur + 1 } } else { level };
    let text = HEADING.replace(line, "").into_owned();
    let out = if level == 0 || (toggle && level == cur) { text } else { format!("{} {text}", "#".repeat(level)) };
    edit(v, ls, le, out, None)
}

fn block(v: &str, s: usize, e: usize, text: &str, sel_from: Option<usize>, sel_len: Option<usize>) -> Edit {
    let (before, after) = (&v[..s], &v[e..]);
    let pre = if before.is_empty() || before.ends_with("\n\n") { "" } else if before.ends_with('\n') { "\n" } else { "\n\n" };
    let post = if after.is_empty() { "\n" } else if after.starts_with("\n\n") { "" } else if after.starts_with('\n') { "\n" } else { "\n\n" };
    let base = u16len(before) + u16len(pre);
    let a = base + sel_from.unwrap_or(u16len(text));
    let sel = (a, if sel_from.is_some() { a + sel_len.unwrap_or(0) } else { a });
    edit(v, s, e, format!("{pre}{text}{post}"), Some(sel))
}

#[tauri::command]
pub fn md_edit(text: String, s: usize, e: usize, cmd: Cmd) -> Edit {
    let (bs, be) = (byte_at(&text, s.min(e)), byte_at(&text, s.max(e)));
    match cmd {
        Cmd::Wrap { before, after, placeholder } => wrap(&text, bs, be, &before, &after, &placeholder),
        Cmd::Prefix { list } => prefix(&text, bs, be, &list),
        Cmd::Heading { level, toggle, cycle } => heading(&text, bs, level, toggle, cycle),
        Cmd::Block { block: b, sel_from, sel_len } => block(&text, bs, be, &b, sel_from, sel_len),
    }
}

/// Whether the cursor stands inside $…$ or $$…$$ (then symbols are inserted without dollar signs).
#[tauri::command]
pub fn md_in_math(text: String, pos: usize) -> bool {
    let before = text[..byte_at(&text, pos)].replace("\\$", "");
    if before.matches("$$").count() % 2 == 1 { return true; }
    static BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());
    let para = BLANK.split(&before).last().unwrap_or("").replace("$$", "");
    para.matches('$').count() % 2 == 1
}

/* ---------- Find & replace ---------- */

/// Start positions (UTF-16) of every match, without overlaps.
pub fn find(text: &str, query: &str, case: bool) -> Vec<usize> {
    if query.is_empty() { return vec![]; }
    let fold = |c: char| -> char { if case { c } else { c.to_lowercase().next().unwrap_or(c) } };
    let hay: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().map(fold).collect();
    let mut offsets = Vec::with_capacity(hay.len() + 1);
    let mut u = 0;
    for ch in &hay { offsets.push(u); u += ch.len_utf16(); }
    offsets.push(u);
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()].iter().zip(&needle).all(|(a, b)| fold(*a) == *b) {
            out.push(offsets[i]);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

#[tauri::command]
pub fn md_find(text: String, query: String, case: bool) -> Vec<usize> {
    find(&text, &query, case)
}

/// Replaces every match; returns the new text and how many were replaced.
#[tauri::command]
pub fn md_replace_all(text: String, query: String, replacement: String, case: bool) -> (String, usize) {
    let hits = find(&text, &query, case);
    let qlen = u16len(&query);
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for h in &hits {
        let (a, b) = (byte_at(&text, *h), byte_at(&text, h + qlen));
        out.push_str(&text[last..a]);
        out.push_str(&replacement);
        last = b;
    }
    out.push_str(&text[last..]);
    (out, hits.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(text: &str, s: usize, e: usize, cmd: Cmd) -> (String, usize, usize) {
        let ed = md_edit(text.into(), s, e, cmd);
        let (a, b) = (byte_at(text, ed.s), byte_at(text, ed.e));
        (format!("{}{}{}", &text[..a], ed.text, &text[b..]), ed.sel_s, ed.sel_e)
    }
    fn w(b: &str) -> Cmd { Cmd::Wrap { before: b.into(), after: b.into(), placeholder: "text".into() } }
    #[test]
    fn wrapping() {
        assert_eq!(run("Grüße Welt", 6, 10, w("**")), ("Grüße **Welt**".into(), 8, 12));
        assert_eq!(run("Grüße **Welt**", 8, 12, w("**")), ("Grüße Welt".into(), 6, 10));
        assert_eq!(run("a ", 2, 2, w("*")), ("a *text*".into(), 3, 7));
        assert_eq!(run("😀 x", 3, 4, w("`")), ("😀 `x`".into(), 4, 5));
    }
    #[test]
    fn lists_and_headings() {
        let p = |l: &str| Cmd::Prefix { list: l.into() };
        assert_eq!(run("eins\nzwei", 0, 9, p("ol")).0, "1. eins\n2. zwei");
        assert_eq!(run("1. eins\n2. zwei", 0, 15, p("ol")).0, "eins\nzwei");
        assert_eq!(run("- a\n- b", 0, 7, p("task")).0, "- [ ] a\n- [ ] b");
        assert_eq!(run("text", 2, 2, p("quote")).0, "> text");
        let h = |level, toggle, cycle| Cmd::Heading { level, toggle, cycle };
        assert_eq!(run("x\nTitel\ny", 3, 3, h(2, true, false)).0, "x\n## Titel\ny");
        assert_eq!(run("## Titel", 3, 3, h(2, true, false)).0, "Titel");
        assert_eq!(run("### Titel", 3, 3, h(0, false, true)).0, "Titel");
        assert_eq!(run("# Titel", 3, 3, h(0, false, true)).0, "## Titel");
    }
    #[test]
    fn blocks_find_math() {
        assert_eq!(run("Absatz", 6, 6, Cmd::Block { block: "---".into(), sel_from: None, sel_len: None }), ("Absatz\n\n---\n".into(), 11, 11));
        assert_eq!(find("Äpfel und äpfel", "ÄPFEL", false), vec![0, 10]);
        assert_eq!(find("Äpfel und äpfel", "Äpfel", true), vec![0]);
        assert_eq!(md_replace_all("a😀a".into(), "a".into(), "b".into(), true), ("b😀b".into(), 2));
        assert!(md_in_math("Text $x + ".into(), 10));
        assert!(!md_in_math("Text $x$ und ".into(), 13));
    }
}
