// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    content: String,
}

#[derive(Serialize)]
struct Saved {
    path: String,
    name: String,
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
    let text = String::from_utf8_lossy(&bytes);
    let content = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    Ok(Doc {
        path: path.to_string_lossy().into_owned(),
        name: file_name(path),
        content,
    })
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
async fn open_files(app: AppHandle) -> Result<Vec<Doc>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open Markdown")
        .add_filter("Markdown", MD_EXT)
        .blocking_pick_files();
    let Some(files) = picked else { return Ok(vec![]) };
    files
        .into_iter()
        .map(|f| f.into_path().map_err(|e| e.to_string()).and_then(|p| load(&p)))
        .collect()
}

#[tauri::command]
async fn read_file(path: String) -> Result<Doc, String> {
    load(Path::new(&path))
}

#[tauri::command]
async fn save_file(
    app: AppHandle,
    path: Option<String>,
    suggested_name: String,
    content: String,
) -> Result<Option<Saved>, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => match app
            .dialog()
            .file()
            .set_title("Save Markdown")
            .set_file_name(&suggested_name)
            .add_filter("Markdown", &["md", "markdown", "txt"])
            .blocking_save_file()
        {
            Some(f) => f.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    write(&target, &content)?;
    Ok(Some(Saved {
        path: target.to_string_lossy().into_owned(),
        name: file_name(&target),
    }))
}

#[tauri::command]
async fn export_html(app: AppHandle, suggested_name: String, html: String) -> Result<Option<String>, String> {
    let Some(f) = app
        .dialog()
        .file()
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
    let Some(f) = app
        .dialog()
        .file()
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
            context_menu,
            clipboard_read,
            clipboard_write,
            open_files,
            read_file,
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
