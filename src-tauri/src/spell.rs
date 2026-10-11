//! Spelling and grammar checking, German and English, fully offline (the same file in every Studio app).
//!
//! - Spelling: Hunspell dictionaries (dictionaries/de, dictionaries/en — separate files with their own licenses) read
//!   with spellbook, plus a personal dictionary shared by all Studio apps (<data dir>/Studio/dictionary.txt).
//! - Grammar: a set of common rules — doubled words, a small letter after the end of a sentence, spaces before
//!   punctuation, several spaces, a missing space after a comma, and in English "a"/"an" and a lowercase "i".
//!
//! Language "auto" accepts a word that either dictionary knows (mixed texts are common) and picks the grammar rules
//! per paragraph by its most common words. Positions in results are UTF-16 offsets, like JavaScript strings.

use serde::Serialize;
use spellbook::Dictionary;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, OnceLock},
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Issue {
    /// UTF-16 offsets in the checked text
    pub start: usize,
    pub end: usize,
    /// "spell" or the grammar rule: double, case, space-before, spaces, comma-space, a-an, i
    pub kind: &'static str,
    /// replacements for grammar issues (spelling suggestions come from `spell_suggest`)
    pub fix: Vec<String>,
}

struct Dicts {
    de: Option<Dictionary>,
    en: Option<Dictionary>,
}

static DICTS: OnceLock<Dicts> = OnceLock::new();
static USER: LazyLock<Mutex<(Option<SystemTime>, HashSet<String>)>> = LazyLock::new(|| Mutex::new((None, HashSet::new())));

/// Where the dictionaries are: next to the installed app's resources, next to a portable exe, or in the source tree.
fn dict_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(r) = app.path().resource_dir() { dirs.push(r.join("dictionaries")); }
    if let Some(exe) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        dirs.push(exe.join("dictionaries"));
        // Linux packages that were repackaged (Flatpak): <prefix>/bin/app and <prefix>/lib/<app>/dictionaries
        if let Ok(libs) = std::fs::read_dir(exe.join("..").join("lib")) { dirs.extend(libs.flatten().map(|e| e.path().join("dictionaries"))); }
    }
    // Debug builds: the source tree.
    #[cfg(debug_assertions)]
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionaries"));
    dirs.into_iter().find(|d| d.join("en").join("index.dic").exists())
}

fn load(dir: &Path, lang: &str) -> Option<Dictionary> {
    let aff = std::fs::read_to_string(dir.join(lang).join("index.aff")).ok()?;
    let dic = std::fs::read_to_string(dir.join(lang).join("index.dic")).ok()?;
    Dictionary::new(&aff, &dic).ok()
}

fn dicts(app: &AppHandle) -> &'static Dicts {
    DICTS.get_or_init(|| {
        let dir = dict_dir(app);
        let (de, en) = match &dir {
            Some(d) => std::thread::scope(|s| {
                let de = s.spawn(|| load(d, "de"));
                let en = load(d, "en");
                (de.join().ok().flatten(), en)
            }),
            None => (None, None),
        };
        Dicts { de, en }
    })
}

/// The personal dictionary shared by all Studio apps.
fn user_path(app: &AppHandle) -> Option<PathBuf> { app.path().data_dir().ok().map(|d| d.join("Studio").join("dictionary.txt")) }

/// The personal words, re-read when another app changed the file.
fn user_words(app: &AppHandle) -> HashSet<String> {
    let mut u = USER.lock().unwrap();
    let Some(p) = user_path(app) else { return u.1.clone() };
    let stamp = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
    if stamp != u.0 {
        u.1 = std::fs::read_to_string(&p).unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        u.0 = stamp;
    }
    u.1.clone()
}

/* ---------- Words ---------- */

/// A word of the text: byte range and the text.
struct Word<'a> { start: usize, end: usize, text: &'a str }

fn is_word_char(c: char) -> bool { c.is_alphabetic() || c == '\'' || c == '’' || c == '-' }

/// Words with inner apostrophes and hyphens ("don't", "E-Mail"); tokens that touch digits, underscores, "@", "/" or
/// dots inside (file names, URLs, versions) are skipped, since they aren't prose.
fn words(text: &str) -> Vec<Word<'_>> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if !c.is_alphabetic() { continue; }
        let mut end = i + c.len_utf8();
        while let Some(&(j, d)) = it.peek() {
            if !is_word_char(d) { break; }
            end = j + d.len_utf8();
            it.next();
        }
        // Trailing apostrophes/hyphens aren't part of the word.
        let w = text[i..end].trim_end_matches(['\'', '’', '-']);
        let end = i + w.len();
        let before = text[..i].chars().next_back();
        let after = text[end..].chars().next();
        let after2 = text[end..].chars().nth(1);
        let glued = |c: Option<char>| c.is_some_and(|c| c.is_ascii_digit() || c == '_' || c == '@' || c == '/' || c == '\\' || c == '#');
        let dotted = before == Some('.') && i >= 2 && b[i - 2].is_ascii_alphanumeric()
            || after == Some('.') && after2.is_some_and(|c| c.is_alphanumeric());
        // skip the rest of a URL / path / identifier
        if glued(before) || glued(after) || dotted || after == Some(':') && text[end..].starts_with("://") {
            while let Some(&(_, d)) = it.peek() { if d.is_whitespace() { break; } it.next(); }
            continue;
        }
        out.push(Word { start: i, end, text: w });
    }
    out
}

/// Words that aren't checked: acronyms (HTML), mixed case (JavaScript, iPhone), single letters.
fn skip_word(w: &str) -> bool {
    let letters: Vec<char> = w.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() < 2 { return true; }
    if letters.iter().all(|c| c.is_uppercase()) { return true; }
    letters.windows(2).any(|p| p[0].is_lowercase() && p[1].is_uppercase())
}

/// Common words the dictionaries lack (tech terms written in small letters); compared case-insensitively.
const EXTRA: &[&str] = &["ok", "okay", "url", "urls", "json", "csv", "tsv", "pdf", "pdfs", "repo", "repos", "todo", "todos", "github", "gitlab",
    "javascript", "typescript", "markdown", "html", "css", "api", "apis", "ui", "ux", "npm", "cli", "utf", "ascii", "xml", "yaml", "toml", "svg",
    "png", "jpg", "jpeg", "gif", "webp", "latex", "katex", "mermaid", "regex", "wifi", "emoji", "emojis", "tauri", "rust", "webview", "frontend",
    "backend", "localhost", "autosave", "autosaved", "autosaves", "strg", "entf", "einfg", "pos1", "bild", "tab", "esc", "ctrl", "cmd", "enter", "async", "config", "configs", "dev", "devs", "plugin", "plugins", "screenshot", "screenshots", "smartphone", "app", "apps"];

const STOP_DE: &[&str] = &["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "auf", "für", "sich", "dem", "den", "von", "zu", "es", "auch", "wird", "sind", "werden", "wenn", "dass", "ich", "wir", "sie", "noch", "aber", "oder", "bei", "im"];
const STOP_EN: &[&str] = &["the", "and", "is", "not", "a", "an", "with", "on", "for", "it", "of", "to", "in", "that", "this", "are", "be", "was", "you", "we", "they", "or", "but", "at", "by", "from", "have", "has", "will", "can"];

/// "de" or "en" by the most common words (ties: the fallback).
fn detect<'a>(words: &[Word<'_>], fallback: &'a str) -> &'a str {
    let (mut de, mut en) = (0, 0);
    for w in words {
        let l = w.text.to_lowercase();
        if STOP_DE.contains(&l.as_str()) { de += 1; }
        if STOP_EN.contains(&l.as_str()) { en += 1; }
    }
    if de > en { "de" } else if en > de { "en" } else if fallback == "de" { "de" } else { "en" }
}

/* ---------- Grammar rules ---------- */

const ABBREV: &[&str] = &["z", "b", "d", "h", "u", "a", "bzw", "ca", "usw", "etc", "vgl", "evtl", "ggf", "nr", "bspw", "inkl", "exkl", "max", "min",
    "e", "g", "i", "vs", "approx", "dr", "mr", "mrs", "ms", "prof", "st", "no", "fig", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "okt", "nov", "dec", "dez", "co", "inc", "ltd"];
/// Words that may follow themselves ("die die Tür öffnet", "had had", "that that").
const DOUBLE_OK: &[&str] = &["die", "der", "das", "den", "dem", "des", "sie", "had", "that", "is"];
/// "a" before these vowel-letter words is right (they start with a consonant sound) …
const A_OK: &[&str] = &["one", "once", "uni", "use", "usu", "uti", "ure", "eu", "ewe", "unanim", "ubiq", "uran"];
/// … and "an" before these consonant-letter words (silent h).
const AN_OK: &[&str] = &["hour", "honest", "honor", "honour", "heir", "herb"];

fn grammar(text: &str, words: &[Word<'_>], lang: &str, out: &mut Vec<(usize, usize, &'static str, Vec<String>)>) {
    for (k, w) in words.iter().enumerate() {
        let l = w.text.to_lowercase();
        // Doubled word: "the the" (only spaces between).
        if let Some(n) = words.get(k + 1) {
            if n.text.to_lowercase() == l && text[w.end..n.start].chars().all(|c| c == ' ' || c == '\t') && !DOUBLE_OK.contains(&l.as_str()) && l.chars().count() > 1 {
                out.push((w.start, n.end, "double", vec![w.text.to_string()]));
            }
        }
        // A small letter after the end of a sentence: ". word" (not after abbreviations, single letters or numbers).
        let before = text[..w.start].trim_end_matches([' ', '\t']);
        if before.len() < w.start && w.text.chars().next().is_some_and(char::is_lowercase) && !skip_word(w.text) {
            if let Some(p) = before.chars().next_back().filter(|c| matches!(c, '.' | '!' | '?')) {
                let prev = before[..before.len() - p.len_utf8()].rsplit(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
                let ellipsis = before.ends_with("..") || before.ends_with('…');
                if !ellipsis && !prev.is_empty() && !prev.chars().all(|c| c.is_ascii_digit()) && !ABBREV.contains(&prev.to_lowercase().as_str()) {
                    let mut c = w.text.chars();
                    let cap: String = c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default();
                    out.push((w.start, w.end, "case", vec![cap]));
                }
            }
        }
        if lang == "en" {
            // "a apple" / "an car"
            if let Some(n) = words.get(k + 1).filter(|n| text[w.end..n.start] == *" ") {
                let nl = n.text.to_lowercase();
                let vowel = nl.starts_with(['a', 'e', 'i', 'o', 'u']);
                if w.text == "a" || w.text == "A" {
                    if vowel && !A_OK.iter().any(|p| nl.starts_with(p)) { out.push((w.start, w.end, "a-an", vec![format!("{}n", w.text)])); }
                } else if (w.text == "an" || w.text == "An") && !vowel && !AN_OK.iter().any(|p| nl.starts_with(p)) && !n.text.chars().all(char::is_uppercase) {
                    out.push((w.start, w.end, "a-an", vec![w.text[..1].to_string()]));
                }
            }
        }
    }
    // Lowercase "i" as a word (English): single letters aren't in `words`.
    if lang == "en" {
        for (i, _) in text.match_indices('i') {
            let b = text[..i].chars().next_back();
            let a = text[i + 1..].chars().next();
            let edge = |c: Option<char>| c.is_none_or(|c| c == ' ' || c == '\n' || c == '\t' || c == ',' || c == '\'' || c == '’' || c == '!' || c == '?');
            if edge(b) && edge(a) && b.is_some() { out.push((i, i + 1, "i", vec!["I".into()])); }
        }
    }
    // Characters: spaces before punctuation, several spaces, missing space after a comma.
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut k = 0;
    while k < chars.len() {
        let (i, c) = chars[k];
        if c == ' ' {
            let mut j = k;
            while j < chars.len() && chars[j].1 == ' ' { j += 1; }
            let prev = if k > 0 { Some(chars[k - 1].1) } else { None };
            let next = chars.get(j).map(|x| x.1);
            let end = chars.get(j).map_or(text.len(), |x| x.0);
            let word_before = prev.is_some_and(|p| !p.is_whitespace());
            if word_before && matches!(next, Some(',' | ';' | '!' | '?')) || word_before && next == Some('.') && chars.get(j + 1).map(|x| x.1) != Some('.') && chars.get(j + 1).is_none_or(|x| !x.1.is_alphanumeric()) {
                out.push((i, end, "space-before", vec![String::new()]));
            } else if j - k >= 2 && word_before && next.is_some_and(|n| !n.is_whitespace()) {
                out.push((i, end, "spaces", vec![" ".into()]));
            }
            k = j;
            continue;
        }
        if c == ',' && k > 0 && chars[k - 1].1.is_alphabetic() && chars.get(k + 1).is_some_and(|x| x.1.is_alphabetic()) {
            out.push((i, i + 1, "comma-space", vec![", ".into()]));
        }
        k += 1;
    }
}

/* ---------- Checking ---------- */

/// Checks `text` (only the byte ranges in `parts`, e.g. the prose of a Markdown file). `lang`: "auto", "de" or "en";
/// `fallback`: the UI language, for paragraphs whose language can't be told.
pub fn check(app: &AppHandle, text: &str, parts: &[(usize, usize)], lang: &str, fallback: &str) -> Vec<Issue> {
    let d = dicts(app);
    let user = user_words(app);
    let known = |w: &str, l: &str| -> bool {
        let one = |dict: &Option<Dictionary>| dict.as_ref().is_some_and(|d| d.check(w));
        match l { "de" => one(&d.de), "en" => one(&d.en), _ => one(&d.de) || one(&d.en) }
    };
    let ok = |w: &str| -> bool {
        let lw = w.to_lowercase();
        if user.contains(w) || user.contains(&lw) || skip_word(w) || EXTRA.contains(&lw.as_str()) { return true; }
        let w = w.replace('’', "'");
        if known(&w, lang) { return true; }
        // Hyphenated words: fine when every part is ("Rust-Code").
        w.contains('-') && w.split('-').all(|p| p.is_empty() || skip_word(p) || known(p, lang))
    };
    let have_dicts = d.de.is_some() || d.en.is_some();
    let mut raw: Vec<(usize, usize, &'static str, Vec<String>)> = Vec::new();
    for &(s, e) in parts {
        let Some(part) = text.get(s..e) else { continue };
        // Paragraph by paragraph (blank lines), so the grammar language can differ.
        let mut off = 0;
        for para in part.split("\n\n") {
            let ws = words(para);
            if have_dicts {
                for w in &ws { if !ok(w.text) { raw.push((s + off + w.start, s + off + w.end, "spell", vec![])); } }
            }
            let gl = if lang == "auto" { detect(&ws, fallback) } else { lang };
            let mut g = Vec::new();
            grammar(para, &ws, gl, &mut g);
            raw.extend(g.into_iter().map(|(a, b, k, f)| (s + off + a, s + off + b, k, f)));
            off += para.len() + 2;
        }
    }
    raw.sort_by_key(|x| (x.0, x.1));
    raw.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);
    let u16 = utf16_index(text);
    raw.into_iter().map(|(a, b, kind, fix)| Issue { start: u16(a), end: u16(b), kind, fix }).collect()
}

/// Byte offset -> UTF-16 offset.
pub fn utf16_index(text: &str) -> impl Fn(usize) -> usize + '_ {
    move |b: usize| text[..b.min(text.len())].encode_utf16().count()
}

/// Suggestions for a misspelled word (best first).
pub fn suggest(app: &AppHandle, word: &str, lang: &str) -> Vec<String> {
    let d = dicts(app);
    let mut out = Vec::new();
    let mut add = |dict: &Option<Dictionary>| { if let Some(dict) = dict { let mut v = Vec::new(); dict.suggest(word, &mut v); for s in v { if !out.contains(&s) { out.push(s); } } } };
    match lang { "de" => add(&d.de), "en" => add(&d.en), _ => { add(&d.de); add(&d.en); } }
    out.truncate(8);
    out
}

#[tauri::command]
pub async fn spell_check(app: AppHandle, text: String, lang: String, fallback: String) -> Vec<Issue> {
    check(&app, &text, &[(0, text.len())], &lang, &fallback)
}

#[tauri::command]
pub async fn spell_suggest(app: AppHandle, word: String, lang: String) -> Vec<String> {
    suggest(&app, &word, &lang)
}

/// Adds a word to the personal dictionary (shared by all Studio apps).
#[tauri::command]
pub fn spell_add(app: AppHandle, word: String) -> Result<(), String> {
    let p = user_path(&app).ok_or("no data folder")?;
    let mut words = user_words(&app);
    if !words.insert(word.trim().to_string()) { return Ok(()); }
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let mut list: Vec<&String> = words.iter().collect();
    list.sort();
    std::fs::write(&p, list.iter().map(|w| format!("{w}\n")).collect::<String>()).map_err(|e| e.to_string())?;
    *USER.lock().unwrap() = (std::fs::metadata(&p).and_then(|m| m.modified()).ok(), words);
    Ok(())
}

/// Whether the dictionaries were found (the UI says so when they are missing).
#[tauri::command]
pub async fn spell_ready(app: AppHandle) -> (bool, bool) {
    let d = dicts(&app);
    (d.de.is_some(), d.en.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn g(text: &str, lang: &str) -> Vec<(String, &'static str, Vec<String>)> {
        let ws = words(text);
        let mut out = Vec::new();
        grammar(text, &ws, lang, &mut out);
        out.into_iter().map(|(a, b, k, f)| (text[a..b].to_string(), k, f)).collect()
    }

    #[test]
    fn word_splitting() {
        let w: Vec<&str> = words("Don't use E-Mail at test@example.com or https://x.org/a, v1.2 file.rs — Grüße!").iter().map(|w| w.text).collect();
        assert_eq!(w, ["Don't", "use", "E-Mail", "at", "or", "Grüße"]);
        assert!(skip_word("HTML") && skip_word("JavaScript") && skip_word("iPhone") && !skip_word("Haus"));
    }

    #[test]
    fn grammar_rules() {
        assert_eq!(g("This is the the end.", "en"), [("the the".into(), "double", vec!["the".into()])]);
        assert!(g("Die Frau, die die Tür öffnet.", "de").is_empty());
        assert_eq!(g("Gut. dann weiter, z. B. so. Am 3. januar", "de"), [("dann".into(), "case", vec!["Dann".into()])]);
        assert_eq!(g("Wait... then go", "en"), vec![]);
        assert_eq!(g("Hello , world", "en"), [(" ".into(), "space-before", vec![String::new()])]);
        assert_eq!(g("Hello  world", "en"), [("  ".into(), "spaces", vec![" ".into()])]);
        assert_eq!(g("Rot,Grün und 1,5", "de"), [(",".into(), "comma-space", vec![", ".into()])]);
        assert_eq!(g("a apple, an car, a user, an hour, an MRI", "en"),
            [("a".into(), "a-an", vec!["an".into()]), ("an".into(), "a-an", vec!["a".into()])]);
        assert_eq!(g("then i said", "en"), [("i".into(), "i", vec!["I".into()])]);
        assert_eq!(g("Siehe Kapitel 3 . Fertig", "de").len(), 1);
    }

    #[test]
    fn language_detection() {
        assert_eq!(detect(&words("Das ist ein Test und nicht mehr"), "en"), "de");
        assert_eq!(detect(&words("This is a test and not more"), "de"), "en");
        assert_eq!(detect(&words("Rust Tauri"), "de"), "de");
    }

    /// Spelling with the real dictionaries (from the source tree).
    #[test]
    fn dictionaries() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionaries");
        let (de, en) = (load(&dir, "de").expect("de"), load(&dir, "en").expect("en"));
        assert!(de.check("Haus") && de.check("Häuser") && de.check("Straße") && !de.check("Hauss") && !de.check("haus"));
        assert!(en.check("house") && en.check("don't") && !en.check("hous") && !en.check("teh"));
        let mut s = Vec::new();
        en.suggest("teh", &mut s);
        assert!(s.contains(&"the".to_string()), "{s:?}");
    }
}


#[cfg(test)]
#[test]
fn crlf_dictionaries() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionaries").join("en");
    let crlf = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap().replace("\r\n", "\n").replace('\n', "\r\n");
    let d = Dictionary::new(&crlf("index.aff"), &crlf("index.dic")).expect("parses with CRLF");
    assert!(d.check("house") && d.check("houses") && !d.check("hous"));
}
