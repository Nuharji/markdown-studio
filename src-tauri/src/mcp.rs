//! The MCP server (the same file in every Studio app; the app's own tools are in mcp_tools.rs). Started with `--mcp`,
//! the program opens no window: it answers the Model Context Protocol on stdin / stdout (JSON-RPC, one message per
//! line) until stdin closes, so Claude, ChatGPT and other MCP clients can use what the app can do.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// Protocol versions this server can speak, newest first.
const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub type Call<'a> = &'a dyn Fn(&str, &Value) -> Result<Value, String>;

pub fn wanted() -> bool { std::env::args().skip(1).any(|a| a == "--mcp") }

pub fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": description, "inputSchema": {"type": "object", "properties": properties, "required": required}})
}

fn tool_result(r: Result<Value, String>) -> Value {
    match r {
        Ok(Value::String(s)) => json!({"content": [{"type": "text", "text": s}], "isError": false}),
        Ok(v) => json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}], "isError": false}),
        Err(e) => json!({"content": [{"type": "text", "text": e}], "isError": true}),
    }
}

/// The answer to one message (None for notifications).
pub fn respond(name: &str, version: &str, tools: &[Value], call: Call, msg: &Value) -> Option<Value> {
    let id = msg.get("id").filter(|i| !i.is_null())?.clone();
    let error = |code: i64, message: String| Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let used = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            json!({"protocolVersion": used, "capabilities": {"tools": {}}, "serverInfo": {"name": name, "version": version}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools}),
        "tools/call" => {
            let tool = params.get("name").and_then(Value::as_str).unwrap_or("");
            if !tools.iter().any(|t| t["name"] == tool) { return error(-32602, format!("unknown tool: {tool}")); }
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            tool_result(call(tool, &args))
        }
        other => return error(-32601, format!("unknown method: {other}")),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// Answers on stdout what comes in on stdin, until stdin closes.
pub fn serve(name: &str, version: &str, tools: &[Value], call: Call) {
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(msg) if msg.is_object() => respond(name, version, tools, call, &msg),
            Ok(_) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "expected one message per line"}})),
            Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}})),
        };
        if let Some(a) = answer {
            if writeln!(out, "{a}").and_then(|_| out.flush()).is_err() { break; }
        }
    }
}

/* ---------------- Arguments of a tool ---------------- */

#[allow(dead_code)]
pub fn opt_text(args: &Value, key: &str) -> String { args.get(key).and_then(Value::as_str).unwrap_or("").to_string() }

#[allow(dead_code)]
pub fn text(args: &Value, key: &str) -> Result<String, String> {
    Some(opt_text(args, key)).filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("{key} is needed"))
}

#[allow(dead_code)]
pub fn flag(args: &Value, key: &str) -> bool { args.get(key).and_then(Value::as_bool).unwrap_or(false) }

/// A full path: the folder a client starts the server in says nothing about where its files are.
#[allow(dead_code)]
pub fn path(args: &Value, key: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(text(args, key)?);
    if p.is_absolute() { Ok(p) } else { Err(format!("{key} must be a full path: {}", p.display())) }
}

/// Whether a file has one of these extensions (lower case).
#[allow(dead_code)]
pub fn has_ext(p: &Path, exts: &[&str]) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
}

/// Writes a file. An existing one is only replaced with `overwrite`, and never left half written.
#[allow(dead_code)]
pub fn put(p: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("{}: {e}", p.display());
    if !overwrite {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(p).map_err(fail)?;
        return f.write_all(bytes).map_err(fail);
    }
    let tmp = p.with_extension(format!("mcp-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(fail)?;
    std::fs::rename(&tmp, p).map_err(fail)
}

/* ---------------- Folders (without a window there is no AppHandle) ---------------- */

/// What Tauri calls the config folder.
#[allow(dead_code)]
pub fn config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(windows) { return std::env::var_os("APPDATA").map(PathBuf::from); }
    if cfg!(target_os = "macos") { return home.map(|h| h.join("Library").join("Application Support")); }
    std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".config")))
}

/// The folder shared by the Studio apps (shared.json, agent/).
#[allow(dead_code)]
pub fn studio_dir() -> Option<PathBuf> {
    // Debug builds only: test copies use their own folder (like shared.rs), never the real one.
    #[cfg(debug_assertions)]
    if let Ok(d) = std::env::var("STUDIO_SHARED_DIR") { return Some(PathBuf::from(d)); }
    config_dir().map(|d| d.join("Studio"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(msg: Value) -> Option<Value> {
        let tools = [tool("echo", "Says it back", json!({"text": {"type": "string"}}), &["text"])];
        let call: Call = &|_, args| text(args, "text").map(Value::String);
        respond("test", "1.0.0", &tools, call, &msg)
    }

    #[test]
    fn speaks_the_protocol() {
        let init = ask(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})).unwrap();
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], "test");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        let newer = ask(json!({"id": "a", "method": "initialize", "params": {"protocolVersion": "2099-01-01"}})).unwrap();
        assert_eq!(newer["id"], "a");
        assert_eq!(newer["result"]["protocolVersion"], VERSIONS[0], "unknown version: offers its own");
        assert!(ask(json!({"method": "notifications/initialized"})).is_none(), "no answer to a notification");
        assert_eq!(ask(json!({"id": 2, "method": "ping"})).unwrap()["result"], json!({}));
        assert_eq!(ask(json!({"id": 3, "method": "tools/list"})).unwrap()["result"]["tools"][0]["name"], "echo");
        assert_eq!(ask(json!({"id": 4, "method": "nope"})).unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn calls_tools() {
        let call = |name: &str, args: Value| ask(json!({"id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})).unwrap();
        let ok = call("echo", json!({"text": "hi"}));
        assert_eq!(ok["result"]["content"][0]["text"], "hi");
        assert_eq!(ok["result"]["isError"], false);
        let bad = call("echo", json!({}));
        assert_eq!(bad["result"]["isError"], true, "a failing tool is a result the model can read");
        assert_eq!(call("missing", json!({}))["error"]["code"], -32602);
    }

    #[test]
    fn arguments_and_files() {
        assert!(path(&json!({"p": "relative/file.md"}), "p").is_err());
        assert!(has_ext(Path::new("/a/B.MD"), &["md"]) && !has_ext(Path::new("/a/b.txt"), &["md"]));
        let d = std::env::temp_dir().join(format!("studio-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a.txt");
        put(&f, b"one", false).unwrap();
        assert!(put(&f, b"two", false).is_err(), "nothing is overwritten unless asked");
        assert_eq!(std::fs::read(&f).unwrap(), b"one");
        put(&f, b"two", true).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"two");
        let _ = std::fs::remove_dir_all(d);
    }
}
