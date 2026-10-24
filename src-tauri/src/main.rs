// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agentlink;
mod shared;
mod docx;
mod edit;
mod folder;
mod markdown;
mod spell;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri::Emitter;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const MD_EXT: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];

/// A document handed to the UI.
#[derive(Serialize, Clone)]
struct Doc {
    path: String,
    name: String,
    /// The text with LF line endings (the editor's form).
    content: String,
    fmt: TextFmt,
}

/// How a file is stored on disk, so saving writes it back the same way.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct TextFmt {
    /// "UTF-8", "UTF-16LE", "UTF-16BE" or "windows-1252"
    encoding: String,
    bom: bool,
    /// "\n" or "\r\n"
    eol: String,
}

impl Default for TextFmt {
    fn default() -> Self { TextFmt { encoding: "UTF-8".into(), bom: false, eol: "\n".into() } }
}

#[derive(Serialize)]
struct Saved {
    path: String,
    name: String,
    /// The format actually written (Windows-1252 falls back to UTF-8 when the text has characters it can't hold).
    fmt: TextFmt,
}

/// Reads a text file in whatever encoding it has: a BOM decides (UTF-8, UTF-16), otherwise valid UTF-8 is UTF-8 and
/// anything else is taken as Windows-1252 (older Windows files), so umlauts are never turned into "�".
fn decode_text(bytes: &[u8]) -> (String, TextFmt) {
    let utf16 = |b: &[u8], le: bool| String::from_utf16_lossy(&b.chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect::<Vec<_>>());
    let (text, encoding, bom) = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (String::from_utf8_lossy(rest).into_owned(), "UTF-8", true)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        (utf16(rest, true), "UTF-16LE", true)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        (utf16(rest, false), "UTF-16BE", true)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_owned(), "UTF-8", false),
            Err(_) => (encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes).0.into_owned(), "windows-1252", false),
        }
    };
    let eol = match text.find('\n') { Some(i) if i > 0 && text.as_bytes()[i - 1] == b'\r' => "\r\n", _ => "\n" };
    let content = if eol == "\r\n" { text.replace("\r\n", "\n") } else { text };
    (content, TextFmt { encoding: encoding.into(), bom, eol: eol.into() })
}

/// The editor's text (LF) as bytes in the file's format; returns the format used.
fn encode_text(content: &str, fmt: &TextFmt) -> (Vec<u8>, TextFmt) {
    let text = if fmt.eol == "\r\n" { content.replace("\r\n", "\n").replace('\n', "\r\n") } else { content.to_owned() };
    let mut used = fmt.clone();
    let bytes = match fmt.encoding.as_str() {
        "UTF-16LE" | "UTF-16BE" => {
            let le = fmt.encoding == "UTF-16LE";
            used.bom = true;
            let mut out = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
            for u in text.encode_utf16() { out.extend(if le { u.to_le_bytes() } else { u.to_be_bytes() }); }
            out
        }
        "windows-1252" => {
            let (b, _, unmappable) = encoding_rs::WINDOWS_1252.encode(&text);
            if unmappable { used.encoding = "UTF-8".into(); text.into_bytes() } else { b.into_owned() }
        }
        _ => {
            used.encoding = "UTF-8".into();
            let mut out = if fmt.bom { vec![0xEF, 0xBB, 0xBF] } else { Vec::new() };
            out.extend(text.as_bytes());
            out
        }
    };
    (bytes, used)
}

/// Files requested before the UI was ready (command-line args, macOS "Open with").
struct Pending {
    ready: bool,
    paths: Vec<PathBuf>,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.md".into())
}

fn load(path: &Path) -> Result<Doc, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (content, fmt) = decode_text(&bytes);
    Ok(Doc {
        path: path.to_string_lossy().into_owned(),
        name: file_name(path),
        content,
        fmt,
    })
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))
}

/// The app's texts in English and German (i18n/*.json, built into the program).
#[tauri::command]
fn texts() -> serde_json::Value {
    let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap_or_default();
    serde_json::json!({"en": parse(include_str!("../i18n/en.json")), "de": parse(include_str!("../i18n/de.json"))})
}

#[tauri::command]
async fn open_files(app: AppHandle) -> Result<Vec<Doc>, String> {
    let picked = crate::shared::file_dialog(&app)
        .set_title("Open Markdown")
        .add_filter("Markdown", MD_EXT)
        .blocking_pick_files();
    let Some(files) = picked else { return Ok(vec![]) };
    files
        .into_iter()
        .map(|f| f.into_path().map_err(|e| e.to_string()).and_then(|p| load(&p)))
        .collect()
}

/// A linked note ([[Name]], [[Name#Heading]]): Name.md (or another Markdown extension) in the folder of the note
/// `from`, any case — or, when a folder is open (`root`), anywhere in it (folder.rs: resolve_note).
#[tauri::command]
async fn find_note(from: String, name: String, root: Option<String>) -> Result<Option<Doc>, String> {
    let name = name.split('#').next().unwrap_or("").to_string();
    if let Some(root) = root.filter(|r| Path::new(&from).starts_with(r)) {
        let root = PathBuf::from(root);
        let notes = folder::note_list(&root);
        return match folder::resolve_note(&root, &notes, Some(Path::new(&from)), &name) { Some(p) => load(&p).map(Some), None => Ok(None) };
    }
    let dir = Path::new(&from).parent().ok_or("no folder")?;
    let want = name.trim().to_lowercase();
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        let stem = p.file_stem().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if p.is_file() && MD_EXT.contains(&ext.as_str()) && (stem == want || format!("{stem}.{ext}") == want) { return load(&p).map(Some); }
    }
    Ok(None)
}

/// Creates the linked note Name.md next to `from` (with the name as its heading) and returns it.
#[tauri::command]
async fn create_note(from: String, name: String) -> Result<Doc, String> {
    let dir = Path::new(&from).parent().ok_or("no folder")?;
    let name = name.split('#').next().unwrap_or("").to_string();
    let clean: String = name.trim().chars().filter(|c| !"/\\:*?\"<>|".contains(*c)).collect();
    if clean.is_empty() { return Err("empty name".into()); }
    let path = dir.join(format!("{clean}.md"));
    if !path.exists() { write(&path, &format!("# {}\n\n", name.trim()))?; }
    load(&path)
}

#[tauri::command]
async fn read_file(path: String) -> Result<Doc, String> {
    load(Path::new(&path))
}

/// Modification times (ms since 1970) of files, so the UI notices changes made by other programs; 0 if missing.
#[tauri::command]
async fn file_stamps(paths: Vec<String>) -> Vec<u64> {
    paths
        .iter()
        .map(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
        .collect()
}

#[tauri::command]
async fn save_file(
    app: AppHandle,
    path: Option<String>,
    suggested_name: String,
    content: String,
    fmt: Option<TextFmt>,
) -> Result<Option<Saved>, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => match crate::shared::file_dialog(&app)
            .set_title("Save Markdown")
            .set_file_name(&suggested_name)
            .add_filter("Markdown", &["md", "markdown", "txt"])
            .blocking_save_file()
        {
            Some(f) => f.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    let (bytes, fmt) = encode_text(&content, &fmt.unwrap_or_default());
    fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(Saved {
        path: target.to_string_lossy().into_owned(),
        name: file_name(&target),
        fmt,
    }))
}

/// Escapes text for HTML (content and attribute values).
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\x27', "&#39;")
}

/// What the HTML export needs from the preview: the rendered body, its stylesheet and the look.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    title: String,
    lang: String,
    body: String,
    css: String,
    paper_class: String,
    page_width: u32,
    dark: bool,
    github: bool,
}

const KATEX_CSS: &str = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
const HLJS_CSS: &str = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/";

/// A standalone HTML page that looks like the preview (math and code styles from the CDN, prints without the frame).
fn html_page(p: &Page) -> String {
    let hl = format!("{HLJS_CSS}{}", if p.dark { "github-dark.min.css" } else { "github.min.css" });
    let bg = match (p.dark, p.github) { (true, true) => "#010409", (true, false) => "#0f0f0f", (false, true) => "#f6f8fa", (false, false) => "#f2f2f2" };
    format!(
        "<!DOCTYPE html>
<html lang=\"{lang}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>{title}</title>
<link rel=\"stylesheet\" href=\"{KATEX_CSS}\"><link rel=\"stylesheet\" href=\"{hl}\">
<style>{css}
body{{margin:0;background:{bg}}}.paper{{--paperw:{w}px;margin:40px auto;box-shadow:0 2px 18px rgba(0,0,0,.15)}}
@media print{{body{{background:#fff}}.paper{{margin:0;box-shadow:none;max-width:none}}}}</style></head>
<body><article class=\"{class}\">{body}</article></body></html>",
        lang = esc(&p.lang), title = esc(&p.title), css = p.css.replace("</style", "<\\/style"), w = p.page_width, class = esc(&p.paper_class), body = p.body
    )
}

#[tauri::command]
async fn export_html(app: AppHandle, page: Page) -> Result<Option<String>, String> {
    let (suggested_name, html) = (format!("{}.html", page.title), html_page(&page));
    // Debug builds only: automated tests export without the save dialog.
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("MD_EXPORT_TO") {
        write(std::path::Path::new(&p), &html)?;
        return Ok(Some(p));
    }
    let Some(f) = crate::shared::file_dialog(&app)
        .set_title("Export as HTML")
        .set_file_name(&suggested_name)
        .add_filter("HTML", &["html", "htm"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let target = f.into_path().map_err(|e| e.to_string())?;
    write(&target, &html)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn save_bytes(
    app: AppHandle,
    suggested_name: String,
    filter_name: String,
    extensions: Vec<String>,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let Some(f) = crate::shared::file_dialog(&app)
        .set_file_name(&suggested_name)
        .add_filter(&filter_name, &exts)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let target = f.into_path().map_err(|e| e.to_string())?;
    fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn confirm(app: AppHandle, title: String, message: String, ok_label: String, cancel_label: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label))
        .blocking_show()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let allowed = ["https://", "http://", "mailto:"].iter().any(|p| url.starts_with(p));
    if !allowed {
        return Err(format!("Refusing to open {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn print_page(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn initial_files(state: State<Mutex<Pending>>) -> Vec<Doc> {
    let mut pending = state.lock().unwrap();
    pending.ready = true;
    pending.paths.drain(..).filter_map(|p| load(&p).ok()).collect()
}

/// One entry of a native context menu; an entry without `id` is a separator.
#[derive(Deserialize)]
struct MenuEntry {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    accel: Option<String>,
}

/// Shows a native (OS) context menu at the mouse position. The chosen item's id
/// reaches the UI as a "context-menu" event (see `on_menu_event` in `main`).
#[tauri::command]
fn context_menu(app: AppHandle, window: tauri::Window, items: Vec<MenuEntry>) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    let mut menu = MenuBuilder::new(&app);
    for entry in items {
        let Some(id) = entry.id else {
            menu = menu.separator();
            continue;
        };
        let label = entry.label.unwrap_or_default();
        let enabled = entry.enabled.unwrap_or(true);
        if let Some(checked) = entry.checked {
            let item = CheckMenuItemBuilder::with_id(id, label)
                .enabled(enabled)
                .checked(checked)
                .build(&app)
                .map_err(|e| e.to_string())?;
            menu = menu.item(&item);
            continue;
        }
        let plain = || MenuItemBuilder::with_id(id.clone(), label.clone()).enabled(enabled);
        // The shortcut is only shown as a hint; leave it out if the OS can't display it.
        let item = match entry.accel.as_deref() {
            Some(a) => plain().accelerator(a).build(&app).or_else(|_| plain().build(&app)),
            None => plain().build(&app),
        }
        .map_err(|e| e.to_string())?;
        menu = menu.item(&item);
    }
    let menu = menu.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}
fn main() {
    let args: Vec<PathBuf> = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| {
            let _ = app.emit("context-menu", event.id().as_ref());
        })
        .manage(Mutex::new(Pending { ready: false, paths: args }))
        .invoke_handler(tauri::generate_handler![
            shared::shared_get,
            shared::shared_set,
            agentlink::agent_send,
            agentlink::agent_poll,
            agentlink::agent_ack,
            agentlink::agent_open,
            agentlink::agent_open_file,
            context_menu,
            clipboard_read,
            clipboard_write,
            open_files,
            read_file,
            find_note,
            create_note,
            folder::open_folder,
            folder::folder_tree,
            folder::folder_graph,
            folder::folder_create,
            folder::folder_rename,
            folder::folder_move,
            file_stamps,
            markdown::md_render,
            markdown::md_sources,
            docx::export_docx,
            markdown::md_spell,
            spell::spell_check,
            spell::spell_suggest,
            spell::spell_add,
            spell::spell_ready,
            edit::md_edit,
            edit::md_in_math,
            edit::md_find,
            edit::md_replace_all,
            texts,
            save_file,
            export_html,
            save_bytes,
            confirm,
            open_url,
            print_page,
            initial_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building Markdown Studio");

    app.run(|_app, _event| {
        // macOS delivers "Open with" / double-clicked files as an event instead of argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            use tauri::Manager;
            let paths: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            let state = _app.state::<Mutex<Pending>>();
            let mut pending = state.lock().unwrap();
            if pending.ready {
                let docs: Vec<Doc> = paths.iter().filter_map(|p| load(p).ok()).collect();
                let _ = _app.emit("open-docs", docs);
            } else {
                pending.paths.extend(paths);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_formats_round_trip() {
        // Windows-1252 with CRLF: umlauts and € survive, line endings stay.
        let ansi = b"# Gr\xfc\xdfe\r\n\r\n5 \x80\r\n";
        let (text, fmt) = decode_text(ansi);
        assert_eq!(text, "# Grüße\n\n5 €\n");
        assert_eq!(fmt, TextFmt { encoding: "windows-1252".into(), bom: false, eol: "\r\n".into() });
        assert_eq!(encode_text(&text, &fmt).0, ansi.to_vec());
        // A character Windows-1252 can't hold: saved as UTF-8 instead of being lost.
        let (b, used) = encode_text("Grüße 😀\n", &fmt);
        assert_eq!(used.encoding, "UTF-8");
        assert_eq!(String::from_utf8(b).unwrap(), "Grüße 😀\r\n");
        // UTF-8 with BOM, UTF-16 LE, plain LF.
        for bytes in [b"\xef\xbb\xbf# A\r\n\xc3\xbc\r\n".to_vec(), [0xFF, 0xFE, b'#', 0, b'\n', 0, 0xFC, 0].to_vec(), b"# LF\n\nx\n".to_vec()] {
            let (text, fmt) = decode_text(&bytes);
            assert!(!text.contains('\r'));
            assert_eq!(encode_text(&text, &fmt).0, bytes, "{fmt:?}");
        }
    }

    #[test]
    fn linked_notes() {
        let dir = std::env::temp_dir().join("md-notes-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Mathe 1.md"), "# Mathe 1\n").unwrap();
        let from = dir.join("Heute.md").to_string_lossy().into_owned();
        use tauri::async_runtime::block_on as run;
        assert_eq!(run(find_note(from.clone(), "mathe 1".into(), None)).unwrap().unwrap().name, "Mathe 1.md");
        assert!(run(find_note(from.clone(), "Bio".into(), None)).unwrap().is_none());
        let made = run(create_note(from.clone(), "Bio: Zelle".into())).unwrap();
        assert_eq!((made.name.as_str(), made.content.as_str()), ("Bio Zelle.md", "# Bio: Zelle\n\n"));
        assert!(run(find_note(from, "bio zelle".into(), None)).unwrap().is_some());
    }

    #[test]
    fn html_export_page() {
        let p = Page { title: "A & <B>".into(), lang: "de".into(), body: "<h1>Hi</h1>".into(), css: ".paper{color:red}".into(),
            paper_class: "paper dark".into(), page_width: 820, dark: true, github: false };
        let h = html_page(&p);
        assert!(h.starts_with("<!DOCTYPE html>\n<html lang=\"de\">"));
        assert!(h.contains("<title>A &amp; &lt;B&gt;</title>"));
        assert!(h.contains("github-dark.min.css") && h.contains("background:#0f0f0f") && h.contains("--paperw:820px"));
        assert!(h.ends_with("<body><article class=\"paper dark\"><h1>Hi</h1></article></body></html>"));
    }
}
