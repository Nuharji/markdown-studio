//! Settings shared by all Studio apps (the same file in every app): theme, language, the work folder and the sync
//! folder, kept in
//! <config dir>/Studio/shared.json (Windows: %APPDATA%\Studio, macOS: ~/Library/Application Support/Studio,
//! Linux: ~/.config/Studio). Studio Hub edits them; each app reads them at start and when its window gets the focus
//! (shared.js) and writes back its own theme and language changes — so all apps look and speak alike. File dialogs
//! start in the work folder. The sync folder (e.g. in iCloud Drive, OneDrive or Dropbox) is where apps with their own
//! data (Plan Studio's plan) keep it, so two computers share it.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const THEMES: [&str; 4] = ["dark", "light", "github", "github-dark"];
const LANGS: [&str; 3] = ["auto", "en", "de"];

fn file(app: &AppHandle) -> Option<PathBuf> {
    // Debug builds only: test copies can use their own folder (STUDIO_SHARED_DIR), so they never change the real
    // shared settings of the installed apps.
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("STUDIO_SHARED_DIR") { return Some(PathBuf::from(dir).join("shared.json")); }
    app.path().config_dir().ok().map(|d| d.join("Studio").join("shared.json"))
}

pub fn read_from(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// Known keys with valid values are taken over; null removes a key; anything else is ignored.
pub fn merge(mut cur: Map<String, Value>, patch: &Map<String, Value>) -> Map<String, Value> {
    for (k, v) in patch {
        let ok = match (k.as_str(), v) {
            (_, Value::Null) => { cur.remove(k); continue; }
            ("theme", Value::String(s)) => THEMES.contains(&s.as_str()),
            ("lang", Value::String(s)) => LANGS.contains(&s.as_str()),
            ("workFolder", Value::String(s)) | ("syncFolder", Value::String(s)) => !s.is_empty(),
            _ => false,
        };
        if ok { cur.insert(k.clone(), v.clone()); }
    }
    cur
}

pub fn write_to(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shared_get(app: AppHandle) -> Value {
    Value::Object(file(&app).map(|p| read_from(&p)).unwrap_or_default())
}

/// Changes some shared settings and returns all of them.
#[tauri::command]
pub fn shared_set(app: AppHandle, patch: Value) -> Result<Value, String> {
    let path = file(&app).ok_or("no config folder")?;
    let merged = merge(read_from(&path), patch.as_object().ok_or("expected an object")?);
    write_to(&path, &merged)?;
    Ok(Value::Object(merged))
}

/// The work folder, when it is set and exists: file dialogs start there.
pub fn work_dir(app: &AppHandle) -> Option<PathBuf> {
    let p = file(app)?;
    read_from(&p).get("workFolder").and_then(Value::as_str).map(PathBuf::from).filter(|d| d.is_dir())
}

/// The sync folder, when it is set and exists.
#[allow(dead_code)]   // used by the apps that keep their own data there (Plan Studio)
pub fn sync_dir(app: &AppHandle) -> Option<PathBuf> {
    let p = file(app)?;
    read_from(&p).get("syncFolder").and_then(Value::as_str).map(PathBuf::from).filter(|d| d.is_dir())
}

/// A file dialog that starts in the work folder (when one is set).
pub fn file_dialog(app: &AppHandle) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let d = app.dialog().file();
    match work_dir(app) { Some(w) => d.set_directory(w), None => d }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_settings_merge_and_file() {
        let m = merge(Map::new(), json!({"theme": "light", "lang": "de", "workFolder": "/tmp", "syncFolder": "/sync", "evil": 1, "size": "x"}).as_object().unwrap());
        assert_eq!(Value::Object(m.clone()), json!({"theme": "light", "lang": "de", "workFolder": "/tmp", "syncFolder": "/sync"}));
        let m = merge(m, json!({"syncFolder": null}).as_object().unwrap());
        let m = merge(m, json!({"theme": "neon", "lang": null}).as_object().unwrap());
        assert_eq!(Value::Object(m.clone()), json!({"theme": "light", "workFolder": "/tmp"}), "bad values are ignored, null removes");
        let dir = std::env::temp_dir().join(format!("studio-shared-test-{}", std::process::id()));
        let path = dir.join("Studio").join("shared.json");
        write_to(&path, &m).unwrap();
        assert_eq!(read_from(&path), m);
        assert!(read_from(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
