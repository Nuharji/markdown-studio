//! The link to Agent Studio (the same file in every Studio app; JS: agentlink.js). The apps and Agent Studio talk
//! through files in <config dir>/Studio/agent/ (next to shared.json):
//! - inbox/<id>.json — a task an app sends ("Send to Agent Studio"): Agent Studio takes it and starts a run.
//! - outbox/<id>.json — how that task goes and what came out of it (status, answer, new files, data), kept up to date
//!   by Agent Studio; the app that sent it shows it and removes it once it has been seen (`agent_ack`).
//! - status.json — Agent Studio's state for the other apps: what needs the person, what runs, what was done today
//!   (Studio Hub's badge, Plan Studio's morning overview), a heartbeat and where Agent Studio is (to start it).

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn dir(app: &AppHandle) -> Option<PathBuf> {
    // Debug builds only: test copies use their own folder (like shared.rs), never the real one.
    #[cfg(debug_assertions)]
    if let Ok(d) = std::env::var("STUDIO_SHARED_DIR") { return Some(PathBuf::from(d).join("agent")); }
    app.path().config_dir().ok().map(|d| d.join("Studio").join("agent"))
}

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn read(p: &Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }

fn write(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

/// Ids are made here and in Agent Studio: letters, digits and "-" only (they become file names).
pub fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') }

fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!("{:x}-{:x}-{}", now(), std::process::id(), N.fetch_add(1, Ordering::Relaxed))
}

fn text(v: &Value, k: &str, max: usize) -> String { v.get(k).and_then(Value::as_str).unwrap_or("").chars().take(max).collect() }

/// A task as it is put into the inbox: only known fields, sizes limited, files that exist.
pub fn clean_task(v: &Value, id: &str) -> Result<Value, String> {
    let app = text(v, "app", 60);
    let task = text(v, "task", 20_000);
    if app.trim().is_empty() || task.trim().is_empty() { return Err("app and task are needed".into()); }
    let files: Vec<String> = v.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
        .filter(|f| Path::new(f).is_file()).take(20).map(str::to_string).collect();
    let dir = Some(text(v, "dir", 2000)).filter(|d| !d.is_empty() && Path::new(d).is_dir());
    let level = if v.get("level").and_then(Value::as_str) == Some("edit") { "edit" } else { "read" };
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("app".into(), json!(app));
    o.insert("title".into(), json!(text(v, "title", 200)));
    o.insert("task".into(), json!(task));
    o.insert("files".into(), json!(files));
    if let Some(d) = dir { o.insert("dir".into(), json!(d)); }
    for (k, max) in [("selection", 200_000), ("content", 400_000), ("format", 4000), ("lang", 5), ("kind", 40)] {
        let s = text(v, k, max);
        if !s.is_empty() { o.insert(k.into(), json!(s)); }
    }
    o.insert("level".into(), json!(level));
    o.insert("web".into(), json!(v.get("web").and_then(Value::as_bool).unwrap_or(false)));
    o.insert("created".into(), json!(now()));
    Ok(Value::Object(o))
}

/// Agent Studio's status, when it has written one.
fn status(app: &AppHandle) -> Option<Value> { dir(app).and_then(|d| read(&d.join("status.json"))) }

/// Agent Studio is open: its heartbeat is fresh (it writes one every 20 seconds).
fn alive(s: &Option<Value>) -> bool {
    s.as_ref().and_then(|s| s.get("beat")).and_then(Value::as_u64).is_some_and(|b| now().saturating_sub(b) < 75_000)
}

/// Starts Agent Studio (or brings it to the front on macOS). `background`: without taking the focus.
fn launch(app: &AppHandle, background: bool) -> bool {
    let st = status(app);
    let exe = st.as_ref().and_then(|s| s.get("exe")).and_then(Value::as_str).map(PathBuf::from).filter(|p| p.is_file());
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if background { c.arg("-g"); }
        // …/Agent Studio.app/Contents/MacOS/agent-studio → the .app
        match exe.as_ref().and_then(|e| e.ancestors().find(|a| a.extension().is_some_and(|x| x == "app")).map(Path::to_path_buf)) {
            Some(bundle) => { c.arg(bundle); }
            None => { c.args(["-b", "com.agentstudio.app"]); }
        }
        c.status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = background;
        if alive(&st) { return true; }
        let mut cands: Vec<PathBuf> = exe.into_iter().collect();
        #[cfg(windows)]
        for v in ["LOCALAPPDATA", "ProgramFiles"] {
            if let Some(b) = std::env::var_os(v) { cands.push(PathBuf::from(b).join("Agent Studio").join("agent-studio.exe")); }
        }
        #[cfg(not(windows))]
        cands.extend(["/usr/bin/agent-studio".into(), "/usr/local/bin/agent-studio".into()]);
        cands.into_iter().filter(|p| p.is_file()).any(|p| {
            let mut c = std::process::Command::new(p);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            c.spawn().is_ok()
        })
    }
}

/// Sends a task to Agent Studio (and starts it when it isn't open); returns the task's id.
#[tauri::command]
pub fn agent_send(app: AppHandle, task: Value) -> Result<String, String> {
    let d = dir(&app).ok_or("no config folder")?;
    let id = new_id();
    write(&d.join("inbox").join(format!("{id}.json")), &clean_task(&task, &id)?)?;
    if !alive(&status(&app)) { launch(&app, true); }
    Ok(id)
}

/// Agent Studio's status and the results of the tasks this app (`from`) sent.
#[tauri::command]
pub fn agent_poll(app: AppHandle, from: String) -> Value {
    let Some(d) = dir(&app) else { return json!({"status": null, "alive": false, "results": []}) };
    let st = status(&app);
    let mut results: Vec<Value> = std::fs::read_dir(d.join("outbox")).into_iter().flatten().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| read(&e.path()))
        .filter(|r| r.get("app").and_then(Value::as_str) == Some(from.as_str()))
        .collect();
    results.sort_by_key(|r| r.get("created").and_then(Value::as_u64).unwrap_or(0));
    // Tasks still waiting in the inbox (Agent Studio hasn't taken them yet).
    let waiting: Vec<Value> = std::fs::read_dir(d.join("inbox")).into_iter().flatten().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| read(&e.path()))
        .filter(|r| r.get("app").and_then(Value::as_str) == Some(from.as_str()))
        .map(|r| json!({"id": r["id"], "title": r["title"], "status": "waiting", "created": r["created"]}))
        .collect();
    json!({"alive": alive(&st), "status": st, "results": results, "waiting": waiting})
}

/// The result of a task has been seen: it leaves the outbox.
#[tauri::command]
pub fn agent_ack(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) { return Err("bad id".into()); }
    let d = dir(&app).ok_or("no config folder")?;
    let _ = std::fs::remove_file(d.join("outbox").join(format!("{id}.json")));
    Ok(())
}

/// Opens Agent Studio (starts it or brings it to the front).
#[tauri::command]
pub fn agent_open(app: AppHandle) -> bool { launch(&app, false) }

/// Opens a file a task made with the program the system uses for it (when this app can't open it itself).
#[tauri::command]
pub fn agent_open_file(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() { return Err(format!("{path}: not found")); }
    #[cfg(target_os = "macos")]
    let mut c = std::process::Command::new("open");
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer");
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = std::process::Command::new("xdg-open");
    c.arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_are_cleaned() {
        let f = std::env::temp_dir().join(format!("agentlink-test-{}.md", std::process::id()));
        std::fs::write(&f, "x").unwrap();
        let v = json!({"app": "Markdown Studio", "title": "Gegenlesen", "task": "Lies gegen", "files": [f.to_string_lossy(), "/no/such/file"],
            "level": "publish", "web": true, "evil": 1, "selection": "Satz"});
        let c = clean_task(&v, "abc-1").unwrap();
        assert_eq!(c["files"].as_array().unwrap().len(), 1, "only files that exist");
        assert_eq!(c["level"], "read", "only read or edit");
        assert_eq!(c["selection"], "Satz");
        assert!(c.get("evil").is_none() && c.get("content").is_none());
        assert!(clean_task(&json!({"app": "X", "task": " "}), "a").is_err());
        assert!(valid_id("18c-2f-0") && !valid_id("../x") && !valid_id(""));
        let _ = std::fs::remove_file(f);
    }
}
