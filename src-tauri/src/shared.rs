//! Settings shared by all Studio apps (the same file in every app): theme, layout, language, the work folder and the sync
//! folder, kept in
//! <config dir>/Studio/shared.json (Windows: %APPDATA%\Studio, macOS: ~/Library/Application Support/Studio,
//! Linux: ~/.config/Studio). Studio Hub edits them; each app reads them at start and when its window gets the focus
//! (shared.js) and writes back its own theme and language changes — so all apps look and speak alike. File dialogs
//! start in the work folder. The sync folder (e.g. in iCloud Drive, OneDrive or Dropbox) is where apps with their own
//! data (Plan Studio's plan) keep it, so two computers share it.
//! An app can have its own look: `apps.<app>` (e.g. `apps.md`) holds its own theme, layout and layoutCustom, which win
//! over the shared ones for that app (set in the app — „Nur für diese App“ — or in Studio Hub → Design pro App).

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const THEMES: [&str; 5] = ["dark", "light", "github", "github-dark", "cli"];
const LANGS: [&str; 3] = ["auto", "en", "de"];
const LAYOUTS: [&str; 4] = ["adobe", "custom", "modern", "cli"];

/// The options of the layout "custom": only known options with valid values.
fn custom_layout_ok(o: &Map<String, Value>) -> bool {
    o.iter().all(|(k, v)| {
        let allowed: &[&str] = match k.as_str() {
            "dock" => &["right", "left"],
            "tools" => &["left", "right"],
            "density" => &["compact", "normal", "comfortable"],
            "corners" => &["theme", "sharp", "medium", "round"],
            "float" => &["off", "on"],
            "status" => &["on", "off"],
            "font" => &["theme", "mono"],
            _ => &[],
        };
        v.as_str().is_some_and(|s| allowed.contains(&s))
    })
}

/// One app's own look: only known keys with valid values; None when nothing valid is left.
fn app_entry(o: &Map<String, Value>) -> Option<Value> {
    let mut e = Map::new();
    for (k, v) in o {
        let ok = match (k.as_str(), v) {
            ("theme", Value::String(s)) => THEMES.contains(&s.as_str()),
            ("layout", Value::String(s)) => LAYOUTS.contains(&s.as_str()),
            ("layoutCustom", Value::Object(c)) => custom_layout_ok(c),
            _ => false,
        };
        if ok { e.insert(k.clone(), v.clone()); }
    }
    (!e.is_empty()).then_some(Value::Object(e))
}

/// App ids are short lower-case names (md, pd, dt, sl, pl, vw, ag, hub).
fn app_id_ok(id: &str) -> bool {
    (2..=8).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase())
}

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
            // Entries are replaced whole; null removes one (the app follows the hub again).
            ("apps", Value::Object(p)) => {
                let mut apps = cur.get("apps").and_then(Value::as_object).cloned().unwrap_or_default();
                for (id, e) in p.iter().filter(|(id, _)| app_id_ok(id)) {
                    match e.as_object().and_then(app_entry) {
                        Some(v) => { apps.insert(id.clone(), v); }
                        None if e.is_null() => { apps.remove(id); }
                        None => {}
                    }
                }
                if apps.is_empty() { cur.remove("apps"); } else { cur.insert("apps".into(), Value::Object(apps)); }
                continue;
            }
            ("theme", Value::String(s)) => THEMES.contains(&s.as_str()),
            ("lang", Value::String(s)) => LANGS.contains(&s.as_str()),
            ("layout", Value::String(s)) => LAYOUTS.contains(&s.as_str()),
            ("layoutCustom", Value::Object(o)) => custom_layout_ok(o),
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
        let m2 = merge(Map::new(), json!({"layout": "custom", "layoutCustom": {"dock": "left", "float": "on"}}).as_object().unwrap());
        assert_eq!(Value::Object(m2.clone()), json!({"layout": "custom", "layoutCustom": {"dock": "left", "float": "on"}}));
        let m2 = merge(m2, json!({"layout": "neon", "layoutCustom": {"dock": "top"}}).as_object().unwrap());
        assert_eq!(m2["layout"], "custom", "unknown layouts are ignored");
        assert_eq!(m2["layoutCustom"]["dock"], "left", "bad options are ignored");
        assert_eq!(merge(Map::new(), json!({"layoutCustom": {"evil": "left"}}).as_object().unwrap()).len(), 0);
        // CLI: theme, layout and the monospace font option
        let c = merge(Map::new(), json!({"theme": "cli", "layout": "cli", "apps": {"md": {"theme": "cli", "layout": "cli"}}}).as_object().unwrap());
        assert_eq!(Value::Object(c), json!({"theme": "cli", "layout": "cli", "apps": {"md": {"theme": "cli", "layout": "cli"}}}));
        let c = merge(Map::new(), json!({"layoutCustom": {"font": "mono", "dock": "left"}}).as_object().unwrap());
        assert_eq!(c["layoutCustom"], json!({"font": "mono", "dock": "left"}));
        assert_eq!(merge(Map::new(), json!({"layoutCustom": {"font": "comic"}}).as_object().unwrap()).len(), 0);
        // Own looks per app
        let a = merge(m.clone(), json!({"apps": {"md": {"theme": "light", "layout": "modern", "evil": 1}, "pd": {"theme": "neon"}, "BAD!": {"theme": "light"}}}).as_object().unwrap());
        assert_eq!(a["apps"], json!({"md": {"theme": "light", "layout": "modern"}}), "bad entries, keys and ids are ignored");
        assert_eq!(a["theme"], "light", "the shared theme stays");
        let a = merge(a, json!({"apps": {"dt": {"layoutCustom": {"dock": "left"}}}}).as_object().unwrap());
        assert_eq!(a["apps"].as_object().unwrap().len(), 2, "other apps are kept");
        let a = merge(a, json!({"apps": {"md": {"theme": "github"}}}).as_object().unwrap());
        assert_eq!(a["apps"]["md"], json!({"theme": "github"}), "an entry is replaced whole");
        let a = merge(a, json!({"apps": {"md": null, "dt": null}}).as_object().unwrap());
        assert!(a.get("apps").is_none(), "null removes an entry; no entries left removes apps");
        let dir = std::env::temp_dir().join(format!("studio-shared-test-{}", std::process::id()));
        let path = dir.join("Studio").join("shared.json");
        write_to(&path, &m).unwrap();
        assert_eq!(read_from(&path), m);
        assert!(read_from(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
