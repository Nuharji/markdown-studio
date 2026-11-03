//! What Markdown Studio offers over MCP (mcp.rs): notes and folders of notes. Only Markdown files are written, and an
//! existing note only with `overwrite` (it keeps its encoding and line endings).

use crate::{folder, markdown, mcp};
use serde_json::{json, Value};
use std::path::Path;

pub fn run() { mcp::serve("markdown-studio", env!("CARGO_PKG_VERSION"), &tools(), &call) }

const MAX_HITS: usize = 200;

fn tools() -> Vec<Value> {
    let path = json!({"type": "string", "description": "Full path of the note"});
    let folder = json!({"type": "string", "description": "Full path of the folder"});
    vec![
        mcp::tool("list_notes", "Lists the Markdown notes in a folder and its subfolders.", json!({"folder": folder}), &["folder"]),
        mcp::tool("read_note", "Reads a Markdown note: its text and number of words.", json!({"path": path}), &["path"]),
        mcp::tool("write_note", "Writes a Markdown note. Replaces an existing note only with overwrite.", json!({"path": path, "content": {"type": "string"}, "overwrite": {"type": "boolean"}}), &["path", "content"]),
        mcp::tool("search_notes", "Finds a text in the notes of a folder (not case-sensitive): file, line and the line's text.", json!({"folder": folder, "query": {"type": "string"}}), &["folder", "query"]),
        mcp::tool("note_graph", "The network of the notes in a folder: notes, and which link to which with [[…]].", json!({"folder": folder}), &["folder"]),
        mcp::tool("render_html", "Renders Markdown text to HTML the way the preview does.", json!({"text": {"type": "string"}}), &["text"]),
    ]
}

fn folder_arg(args: &Value) -> Result<std::path::PathBuf, String> {
    let d = mcp::path(args, "folder")?;
    if d.is_dir() { Ok(d) } else { Err(format!("{}: not a folder", d.display())) }
}

fn write_note(p: &Path, content: &str, overwrite: bool) -> Result<Value, String> {
    if !folder::is_md(p) { return Err(format!("{}: not a Markdown file", p.display())); }
    let fmt = if p.exists() && overwrite { crate::load(p)?.fmt } else { Default::default() };
    let (bytes, _) = crate::encode_text(content, &fmt);
    mcp::put(p, &bytes, overwrite)?;
    Ok(json!({"path": p, "bytes": bytes.len()}))
}

fn search(root: &Path, query: &str) -> Value {
    let q = query.to_lowercase();
    let mut hits = Vec::new();
    let mut more = false;
    'notes: for p in folder::note_list(root) {
        let Ok(doc) = crate::load(&p) else { continue };
        for (i, line) in doc.content.lines().enumerate() {
            if !line.to_lowercase().contains(&q) { continue; }
            if hits.len() == MAX_HITS { more = true; break 'notes; }
            hits.push(json!({"path": p, "line": i + 1, "text": line.chars().take(300).collect::<String>()}));
        }
    }
    json!({"hits": hits, "more": more})
}

fn call(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_notes" => Ok(json!(folder::note_list(&folder_arg(args)?))),
        "read_note" => {
            let doc = crate::load(&mcp::path(args, "path")?)?;
            Ok(json!({"path": doc.path, "words": markdown::count_words(&doc.content), "content": doc.content}))
        }
        "write_note" => write_note(&mcp::path(args, "path")?, args.get("content").and_then(Value::as_str).ok_or("content is needed")?, mcp::flag(args, "overwrite")),
        "search_notes" => Ok(search(&folder_arg(args)?, &mcp::text(args, "query")?)),
        "note_graph" => serde_json::to_value(folder::graph(&folder_arg(args)?, &[])).map_err(|e| e.to_string()),
        "render_html" => serde_json::to_value(markdown::render(&mcp::text(args, "text")?, false)).map_err(|e| e.to_string()),
        _ => Err(format!("unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn notes_in_a_folder() {
        let d = std::env::temp_dir().join(format!("md-mcp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Bio")).unwrap();
        fs::write(d.join("Heute.md"), "# Heute\n\nSiehe [[Zelle]]\n").unwrap();
        fs::write(d.join("Bio").join("Zelle.md"), "# Zelle\nDie MITOCHONDRIEN\n").unwrap();
        let folder = d.to_string_lossy();
        assert_eq!(call("list_notes", &json!({"folder": folder})).unwrap().as_array().unwrap().len(), 2);
        let hits = call("search_notes", &json!({"folder": folder, "query": "mitochondrien"})).unwrap();
        assert_eq!(hits["hits"][0]["line"], 2);
        let graph = call("note_graph", &json!({"folder": folder})).unwrap();
        assert_eq!(graph["links"].as_array().unwrap().len(), 1);
        assert!(call("list_notes", &json!({"folder": d.join("Heute.md")})).is_err());

        let new = d.join("Neu.md");
        call("write_note", &json!({"path": new, "content": "Eins\n"})).unwrap();
        assert!(call("write_note", &json!({"path": new, "content": "Zwei\n"})).is_err(), "nothing is overwritten unless asked");
        assert_eq!(call("read_note", &json!({"path": new})).unwrap()["words"], 1);
        assert!(call("write_note", &json!({"path": d.join("evil.sh"), "content": "x"})).is_err(), "only Markdown files");

        // Replacing keeps the file's encoding and line endings.
        let old = d.join("Alt.md");
        fs::write(&old, b"Gr\xfc\xdfe\r\n").unwrap();
        call("write_note", &json!({"path": old, "content": "Grüße\nneu\n", "overwrite": true})).unwrap();
        assert_eq!(fs::read(&old).unwrap(), b"Gr\xfc\xdfe\r\nneu\r\n");
        assert!(call("render_html", &json!({"text": "# Hi"})).unwrap()["html"].as_str().unwrap().contains("<h1"));
        let _ = fs::remove_dir_all(d);
    }
}
