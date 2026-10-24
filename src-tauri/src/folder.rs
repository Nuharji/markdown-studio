//! Folders: Markdown Studio opens a whole folder of notes (with its subfolders), like a notebook.
//! - `folder_tree`: the subfolders and Markdown files (hidden folders, node_modules and target are left out)
//! - `folder_create` / `folder_rename` / `folder_move`: new notes and subfolders, renaming, moving notes into
//!   subfolders — always inside the opened folder; renaming a note can update the `[[links]]` to it
//! - `folder_graph`: the network of notes — `[[wiki links]]` (found by name anywhere in the folder, so moving a note
//!   into a subfolder never breaks them) and relative Markdown links `[text](other.md)`; links to notes that don't
//!   exist yet become "missing" nodes
//! - `resolve_note`: which note a `[[link]]` means (also used by `find_note` in main.rs)

use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

const SKIP_DIRS: &[&str] = &["node_modules", "target"];
const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 16;
/// Larger files are listed but not read for links.
const MAX_READ: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
    /// subfolders first, then notes, in natural order ("Teil 2" before "Teil 10")
    children: Vec<Entry>,
    /// notes: modification time (ms since 1970), so the UI notices changes
    modified: u64,
}

#[derive(Serialize, Debug)]
pub struct Tree {
    root: String,
    name: String,
    children: Vec<Entry>,
    files: usize,
    /// more than MAX_FILES notes: the rest is left out
    truncated: bool,
}

fn s(p: &Path) -> String { p.to_string_lossy().into_owned() }

pub fn is_md(p: &Path) -> bool {
    let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
    crate::MD_EXT.contains(&ext.as_str())
}

fn mtime(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Case-insensitive order in which runs of digits compare as numbers.
pub fn natural(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(&b),
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n1 = String::new();
                while let Some(&c) = x.peek() { if c.is_ascii_digit() { n1.push(c); x.next(); } else { break; } }
                let mut n2 = String::new();
                while let Some(&d) = y.peek() { if d.is_ascii_digit() { n2.push(d); y.next(); } else { break; } }
                let (t1, t2) = (n1.trim_start_matches('0'), n2.trim_start_matches('0'));
                let o = t1.len().cmp(&t2.len()).then_with(|| t1.cmp(t2));
                if o != Ordering::Equal { return o; }
            }
            (Some(c), Some(d)) => {
                if c != d { return c.cmp(&d); }
                x.next();
                y.next();
            }
        }
    }
}

fn scan_dir(dir: &Path, depth: usize, count: &mut usize, truncated: &mut bool) -> Vec<Entry> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue; }
        let path = e.path();
        // Symbolic links are not followed (no loops, nothing outside the folder).
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || depth >= MAX_DEPTH { continue; }
            let children = scan_dir(&path, depth + 1, count, truncated);
            out.push(Entry { name, path: s(&path), dir: true, children, modified: 0 });
        } else if ft.is_file() && is_md(&path) {
            if *count >= MAX_FILES { *truncated = true; continue; }
            *count += 1;
            let modified = e.metadata().map(|m| mtime(&m)).unwrap_or(0);
            out.push(Entry { name, path: s(&path), dir: false, children: vec![], modified });
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural(&a.name, &b.name)));
    out
}

pub fn scan(root: &Path) -> Result<Tree, String> {
    if !root.is_dir() { return Err(format!("{}: not a folder", root.display())); }
    let (mut files, mut truncated) = (0, false);
    let children = scan_dir(root, 0, &mut files, &mut truncated);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| s(root));
    Ok(Tree { root: s(root), name, children, files, truncated })
}

/// All notes below `root` (paths), in the tree's order.
pub fn note_list(root: &Path) -> Vec<PathBuf> {
    fn walk(list: &[Entry], out: &mut Vec<PathBuf>) {
        for e in list { if e.dir { walk(&e.children, out) } else { out.push(PathBuf::from(&e.path)) } }
    }
    let mut out = Vec::new();
    if let Ok(t) = scan(root) { walk(&t.children, &mut out); }
    out
}

/* ============ Staying inside the opened folder ============ */

/// `p` (existing, or a new name in an existing folder) lies inside `root` — after resolving "..", links and case.
fn inside(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let full = match fs::canonicalize(p) {
        Ok(c) => c,
        Err(_) => {
            let parent = p.parent().ok_or("no folder")?;
            let name = p.file_name().ok_or("no name")?;
            fs::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?.join(name)
        }
    };
    if full.starts_with(&root) { Ok(full) } else { Err(format!("{} is outside of {}", p.display(), root.display())) }
}

/// A path from `inside` (with links resolved) written with the opened folder's path as the UI knows it, so open
/// documents can be matched by their path.
fn shown(root: &Path, p: &Path) -> PathBuf {
    match fs::canonicalize(root) {
        Ok(c) => p.strip_prefix(&c).map(|r| root.join(r)).unwrap_or_else(|_| p.to_path_buf()),
        Err(_) => p.to_path_buf(),
    }
}

/// A file or folder name typed by the user: no path parts, none of the characters Windows forbids.
pub fn clean_name(name: &str) -> Result<String, String> {
    let c: String = name.trim().chars().filter(|c| !"/\\:*?\"<>|".contains(*c) && !c.is_control()).collect();
    let c = c.trim().trim_end_matches('.').trim().to_string();
    if c.is_empty() || c == "." || c == ".." { return Err("empty name".into()); }
    Ok(c)
}

/// "Name" → "Name.md" (a name that already has a Markdown extension keeps it).
fn note_file(name: &str) -> String {
    if is_md(Path::new(name)) { name.to_string() } else { format!("{name}.md") }
}

/// `dir/base`, or `dir/base 2`, `dir/base 3` … when that exists (`ext` with its dot, or "").
fn free_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{base}{ext}"));
    if !first.exists() { return first; }
    (2..).map(|n| dir.join(format!("{base} {n}{ext}"))).find(|p| !p.exists()).unwrap()
}

/// Creates a note ("note": with the name as its heading) or a subfolder ("folder") in `dir`; a name that is taken gets
/// a number. Returns the new path.
pub fn create(root: &Path, dir: &Path, name: &str, kind: &str) -> Result<PathBuf, String> {
    let dir = inside(root, dir)?;
    if !dir.is_dir() { return Err(format!("{}: not a folder", dir.display())); }
    let clean = clean_name(name)?;
    if kind == "folder" {
        let p = free_path(&dir, &clean, "");
        fs::create_dir(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        return Ok(p);
    }
    let file = note_file(&clean);
    let stem = Path::new(&file).file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or(clean.clone());
    let ext = Path::new(&file).extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default();
    let p = free_path(&dir, &stem, &ext);
    let title = p.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or(stem);
    fs::write(&p, format!("# {title}\n\n")).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p)
}

/// Renames a note or folder (in place). A note keeps its extension when the new name has none.
pub fn rename(root: &Path, path: &Path, name: &str) -> Result<PathBuf, String> {
    let from = inside(root, path)?;
    if from == fs::canonicalize(root).map_err(|e| e.to_string())? { return Err("the opened folder itself can't be renamed here".into()); }
    let clean = clean_name(name)?;
    let new_name = if from.is_dir() || is_md(Path::new(&clean)) { clean } else {
        format!("{clean}.{}", from.extension().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "md".into()))
    };
    let to = from.parent().ok_or("no folder")?.join(&new_name);
    if to == from { return Ok(to); }
    // Only a change of case (Notiz → notiz) may "exist" already on case-insensitive disks.
    let same_file = to.to_string_lossy().to_lowercase() == from.to_string_lossy().to_lowercase();
    if to.exists() && !same_file { return Err(format!("{new_name} exists already")); }
    fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(to)
}

/// Moves a note or folder into the folder `to` (both inside `root`).
pub fn move_to(root: &Path, path: &Path, to: &Path) -> Result<PathBuf, String> {
    let from = inside(root, path)?;
    let dir = inside(root, to)?;
    if !dir.is_dir() { return Err(format!("{}: not a folder", dir.display())); }
    if from == fs::canonicalize(root).map_err(|e| e.to_string())? { return Err("the opened folder itself can't be moved".into()); }
    if dir.starts_with(&from) { return Err("a folder can't be moved into itself".into()); }
    let target = dir.join(from.file_name().ok_or("no name")?);
    if target == from { return Ok(target); }
    if target.exists() { return Err(format!("{} exists already in {}", target.file_name().unwrap_or_default().to_string_lossy(), dir.display())); }
    fs::rename(&from, &target).map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(target)
}

/* ============ Links between notes ============ */

#[derive(Debug, PartialEq, Clone)]
pub enum Link {
    /// [[Name]], [[Folder/Name]], [[Name#Heading]], [[Name|text]], ![[Name]] — the target without heading and text
    Wiki(String),
    /// [text](other.md) / [text](<Sub/My note.md>) — a relative path, percent-decoded, without #anchor
    Path(String),
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |c: u8| (c as char).to_digit(16).map(|v| v as u8);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) { out.push(h * 16 + l); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The links of a note, in order (not in code blocks or `inline code`).
pub fn links_in(text: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(f) = fence {
            if t.starts_with(f) { fence = None; }
            continue;
        }
        if t.starts_with("```") { fence = Some("```"); continue; }
        if t.starts_with("~~~") { fence = Some("~~~"); continue; }
        let mut in_code = false;
        let mut i = 0;
        while i < line.len() {
            let rest = &line[i..];
            if rest.starts_with('`') { in_code = !in_code; i += 1; continue; }
            if !in_code && rest.starts_with("[[") {
                if let Some(end) = rest[2..].find("]]") {
                    let inner = &rest[2..2 + end];
                    if !inner.is_empty() && !inner.contains('[') {
                        let target = inner.split('|').next().unwrap_or("");
                        let target = target.split('#').next().unwrap_or("").trim();
                        if !target.is_empty() { out.push(Link::Wiki(target.to_string())); }
                        i += end + 4;
                        continue;
                    }
                }
            }
            if !in_code && rest.starts_with("](") {
                let body = &rest[2..];
                let (href, used) = if let Some(b) = body.strip_prefix('<') {
                    match b.find('>') { Some(e) => (&b[..e], e + 2), None => ("", 0) }
                } else {
                    let e = body.find(|c: char| c == ')' || c.is_whitespace()).unwrap_or(body.len());
                    (&body[..e], e)
                };
                let href = href.split('#').next().unwrap_or("").split('?').next().unwrap_or("");
                let external = href.contains("://") || href.starts_with("mailto:") || href.starts_with('/') || href.starts_with('\\');
                if !href.is_empty() && !external {
                    let decoded = percent_decode(href);
                    if is_md(Path::new(&decoded)) { out.push(Link::Path(decoded)); }
                }
                i += 2 + used;
                continue;
            }
            i += rest.chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }
    out
}

/// "a/./b/../c" → "a/c" (no file system access).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => { out.pop(); }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Path relative to `root` with "/" (for comparing and for the UI), without the extension when `stem`.
fn rel(root: &Path, p: &Path, stem: bool) -> String {
    let r = p.strip_prefix(root).unwrap_or(p);
    let r = if stem { r.with_extension("") } else { r.to_path_buf() };
    r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

/// Which of `notes` a wiki link means: "Name" or "Name.md" anywhere (the note next to `from` first, then the one
/// nearest the top); "Sub/Name" by the end of its path. Any case.
pub fn resolve_note(root: &Path, notes: &[PathBuf], from: Option<&Path>, target: &str) -> Option<PathBuf> {
    let want = target.trim().trim_start_matches("./").replace('\\', "/").to_lowercase();
    let want = want.strip_suffix(".md").or_else(|| want.strip_suffix(".markdown")).unwrap_or(&want).to_string();
    if want.is_empty() { return None; }
    let here = from.and_then(Path::parent);
    let mut best: Option<(usize, &PathBuf)> = None;
    for p in notes {
        let r = rel(root, p, true).to_lowercase();
        let ok = if want.contains('/') { r == want || r.ends_with(&format!("/{want}")) } else { r.rsplit('/').next() == Some(want.as_str()) };
        if !ok { continue; }
        // Rank: same folder as the linking note, then fewer folders deep.
        let rank = if here.is_some() && p.parent() == here { 0 } else { 1 + r.matches('/').count() };
        if best.map_or(true, |(b, _)| rank < b) { best = Some((rank, p)); }
    }
    best.map(|(_, p)| p.clone())
}

#[derive(Serialize, Debug)]
pub struct Node {
    /// empty for a missing note
    path: String,
    /// file name without extension
    name: String,
    /// subfolder relative to the opened folder ("" = top level), with "/"
    folder: String,
    words: usize,
    /// linked with [[…]] but not created yet
    missing: bool,
}

#[derive(Serialize, Debug)]
pub struct Graph {
    nodes: Vec<Node>,
    /// [from, to] node indexes, each pair once, no self links
    links: Vec<(usize, usize)>,
}

/// The network of the notes below `root`. `open`: [path, text] of notes with unsaved edits, used instead of the file.
pub fn graph(root: &Path, open: &[(String, String)]) -> Graph {
    let notes = note_list(root);
    let mut nodes: Vec<Node> = Vec::new();
    let mut index: HashMap<PathBuf, usize> = HashMap::new();
    for p in &notes {
        let folder = p.parent().map(|d| rel(root, d, false)).unwrap_or_default();
        index.insert(p.clone(), nodes.len());
        nodes.push(Node { path: s(p), name: p.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(), folder, words: 0, missing: false });
    }
    let mut ghosts: HashMap<String, usize> = HashMap::new();
    let mut links: Vec<(usize, usize)> = Vec::new();
    for (i, p) in notes.iter().enumerate() {
        let text = match open.iter().find(|(o, _)| Path::new(o) == p.as_path()) {
            Some((_, t)) => t.clone(),
            None => {
                if fs::metadata(p).map(|m| m.len() > MAX_READ).unwrap_or(true) { continue; }
                match fs::read(p) { Ok(b) => crate::decode_text(&b).0, Err(_) => continue }
            }
        };
        nodes[i].words = crate::markdown::count_words(&text);
        for l in links_in(&text) {
            let to = match &l {
                Link::Wiki(name) => match resolve_note(root, &notes, Some(p), name) {
                    Some(t) => index.get(&t).copied(),
                    None => {
                        let key = name.trim().to_lowercase();
                        Some(*ghosts.entry(key).or_insert_with(|| {
                            let shown = name.trim().rsplit('/').next().unwrap_or(name).to_string();
                            nodes.push(Node { path: String::new(), name: shown, folder: String::new(), words: 0, missing: true });
                            nodes.len() - 1
                        }))
                    }
                },
                Link::Path(href) => {
                    let target = normalize(&p.parent().unwrap_or(root).join(href.replace('\\', "/")));
                    index.get(&target).copied().or_else(|| {
                        // Different case on disk (Windows / macOS).
                        let low = target.to_string_lossy().to_lowercase();
                        index.iter().find(|(k, _)| k.to_string_lossy().to_lowercase() == low).map(|(_, v)| *v)
                    })
                }
            };
            if let Some(to) = to {
                if to != i && !links.contains(&(i, to)) { links.push((i, to)); }
            }
        }
    }
    Graph { nodes, links }
}

/// Changes `[[old]]`, `[[old|…]]` and `[[old#…]]` (any case, also with a folder in front) to `new` in a note.
/// None when nothing changed.
pub fn rename_links(text: &str, old: &str, new: &str) -> Option<String> {
    let old_l = old.to_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    let mut fence: Option<&str> = None;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if let Some(f) = fence {
            if t.starts_with(f) { fence = None; }
            out.push_str(line);
            continue;
        }
        if t.starts_with("```") { fence = Some("```"); out.push_str(line); continue; }
        if t.starts_with("~~~") { fence = Some("~~~"); out.push_str(line); continue; }
        let mut i = 0;
        let mut in_code = false;
        while i < line.len() {
            let rest = &line[i..];
            if rest.starts_with('`') { in_code = !in_code; out.push('`'); i += 1; continue; }
            if !in_code && rest.starts_with("[[") {
                if let Some(end) = rest[2..].find("]]") {
                    let inner = &rest[2..2 + end];
                    let cut = inner.find(|c| c == '|' || c == '#').unwrap_or(inner.len());
                    let target = &inner[..cut];
                    let (dir, name) = match target.rfind('/') { Some(k) => (&target[..=k], &target[k + 1..]), None => ("", target) };
                    let bare = name.trim();
                    let bare_l = bare.to_lowercase();
                    let matches = bare_l == old_l || bare_l == format!("{old_l}.md");
                    if matches && !inner.contains('[') {
                        out.push_str("[[");
                        out.push_str(dir);
                        out.push_str(new);
                        out.push_str(&inner[cut..]);
                        out.push_str("]]");
                        changed = true;
                        i += end + 4;
                        continue;
                    }
                }
            }
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    changed.then_some(out)
}

/* ============ Commands ============ */

#[tauri::command]
pub async fn open_folder(app: tauri::AppHandle) -> Result<Option<Tree>, String> {
    let Some(f) = crate::shared::file_dialog(&app).set_title("Open Folder").blocking_pick_folder() else { return Ok(None) };
    let p = f.into_path().map_err(|e| e.to_string())?;
    scan(&p).map(Some)
}

#[tauri::command]
pub async fn folder_tree(root: String) -> Result<Tree, String> { scan(Path::new(&root)) }

#[tauri::command]
pub async fn folder_graph(root: String, open: Option<Vec<(String, String)>>) -> Graph {
    graph(Path::new(&root), &open.unwrap_or_default())
}

#[tauri::command]
pub async fn folder_create(root: String, dir: String, name: String, kind: String) -> Result<String, String> {
    let root = Path::new(&root);
    create(root, Path::new(&dir), &name, &kind).map(|p| s(&shown(root, &p)))
}

#[derive(Serialize)]
pub struct Renamed {
    path: String,
    /// notes whose [[links]] were changed
    updated: Vec<String>,
}

/// Renames a note or folder; for a note, `update_links` changes the `[[links]]` to it in the other notes (except the
/// ones in `skip`: open with unsaved edits).
#[tauri::command]
pub async fn folder_rename(root: String, path: String, name: String, update_links: bool, skip: Vec<String>) -> Result<Renamed, String> {
    let root = PathBuf::from(root);
    let old_stem = Path::new(&path).file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let was_note = Path::new(&path).is_file();
    let to = shown(&root, &rename(&root, Path::new(&path), &name)?);
    let mut updated = Vec::new();
    if was_note && update_links {
        let new_stem = to.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
        for p in note_list(&root) {
            if skip.iter().any(|k| Path::new(k) == p.as_path()) { continue; }
            let Ok(bytes) = fs::read(&p) else { continue };
            let (text, fmt) = crate::decode_text(&bytes);
            if let Some(new_text) = rename_links(&text, &old_stem, &new_stem) {
                let (out, _) = crate::encode_text(&new_text, &fmt);
                if fs::write(&p, out).is_ok() { updated.push(s(&p)); }
            }
        }
    }
    Ok(Renamed { path: s(&to), updated })
}

#[tauri::command]
pub async fn folder_move(root: String, path: String, to: String) -> Result<String, String> {
    let root = Path::new(&root);
    move_to(root, Path::new(&path), Path::new(&to)).map(|p| s(&shown(root, &p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("md-folder-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["Teil 10", "teil 2", "Anhang", "Teil 1"];
        v.sort_by(|a, b| natural(a, b));
        assert_eq!(v, ["Anhang", "Teil 1", "teil 2", "Teil 10"]);
    }

    #[test]
    fn tree_lists_folders_and_notes() {
        let d = temp("tree");
        fs::create_dir_all(d.join("Mathe/Analysis")).unwrap();
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::create_dir_all(d.join("node_modules")).unwrap();
        fs::write(d.join("Start.md"), "# Start").unwrap();
        fs::write(d.join("bild.png"), "x").unwrap();
        fs::write(d.join(".git/x.md"), "").unwrap();
        fs::write(d.join("Mathe/Kapitel 10.md"), "").unwrap();
        fs::write(d.join("Mathe/Kapitel 2.md"), "").unwrap();
        fs::write(d.join("Mathe/Analysis/Ableitung.markdown"), "").unwrap();
        let t = scan(&d).unwrap();
        assert_eq!(t.files, 4);
        let names: Vec<&str> = t.children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Mathe", "Start.md"], "hidden folders, node_modules and pictures are left out; folders first");
        let mathe: Vec<&str> = t.children[0].children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(mathe, ["Analysis", "Kapitel 2.md", "Kapitel 10.md"]);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn links_are_found() {
        let text = "Siehe [[Mathe 1]], [[Bio|Biologie]] und [[Sub/Zelle#Aufbau]] sowie ![[Bild]].\n\
            [Kapitel](Teil%202.md) [extern](https://x.de/a.md) [Bild](a.png) [B](<Unter ordner/B.md#x>)\n\
            `[[kein Link]]`\n```\n[[auch keiner]]\n```\n";
        assert_eq!(links_in(text), vec![
            Link::Wiki("Mathe 1".into()), Link::Wiki("Bio".into()), Link::Wiki("Sub/Zelle".into()), Link::Wiki("Bild".into()),
            Link::Path("Teil 2.md".into()), Link::Path("Unter ordner/B.md".into()),
        ]);
    }

    #[test]
    fn graph_across_subfolders() {
        let d = temp("graph");
        fs::create_dir_all(d.join("Bio")).unwrap();
        fs::create_dir_all(d.join("Mathe")).unwrap();
        fs::write(d.join("Start.md"), "# Start\n[[Zelle]] [[mathe/funktionen]] [[Neu]] [[Start]]\n").unwrap();
        fs::write(d.join("Bio/Zelle.md"), "Zurück: [Start](../Start.md) und [[Zelle]]\n").unwrap();
        fs::write(d.join("Mathe/Funktionen.md"), "Ohne Links\n").unwrap();
        // Unsaved text of an open note counts instead of the file.
        let open = vec![(s(&d.join("Mathe/Funktionen.md")), "Jetzt mit [[Zelle]]".to_string())];
        let g = graph(&d, &open);
        let id = |n: &str| g.nodes.iter().position(|x| x.name == n).unwrap();
        assert_eq!(g.nodes.len(), 4);
        assert!(g.nodes[id("Neu")].missing);
        assert_eq!(g.nodes[id("Zelle")].folder, "Bio");
        let mut l = g.links.clone();
        l.sort();
        let mut want = vec![(id("Start"), id("Zelle")), (id("Start"), id("Funktionen")), (id("Start"), id("Neu")),
            (id("Zelle"), id("Start")), (id("Funktionen"), id("Zelle"))];
        want.sort();
        assert_eq!(l, want, "self links are left out");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn resolve_prefers_same_folder() {
        let d = temp("resolve");
        let notes = vec![d.join("Index.md"), d.join("A/Index.md"), d.join("A/B/Index.md"), d.join("C/Thema.md")];
        assert_eq!(resolve_note(&d, &notes, Some(&d.join("A/B/x.md")), "index"), Some(d.join("A/B/Index.md")));
        assert_eq!(resolve_note(&d, &notes, Some(&d.join("C/x.md")), "Index"), Some(d.join("Index.md")));
        assert_eq!(resolve_note(&d, &notes, None, "a/index.md"), Some(d.join("A/Index.md")));
        assert_eq!(resolve_note(&d, &notes, None, "Thema"), Some(d.join("C/Thema.md")));
        assert_eq!(resolve_note(&d, &notes, None, "Fehlt"), None);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn create_rename_move_stay_inside() {
        let d = temp("ops");
        let sub = create(&d, &d, "Kapitel", "folder").unwrap();
        assert!(sub.is_dir());
        let n = create(&d, &d, "Neue Notiz", "note").unwrap();
        assert_eq!(fs::read_to_string(&n).unwrap(), "# Neue Notiz\n\n");
        let n2 = create(&d, &d, "Neue Notiz", "note").unwrap();
        assert_eq!(n2.file_name().unwrap(), "Neue Notiz 2.md", "a taken name gets a number");
        assert!(create(&d, &d.join(".."), "x", "note").is_err(), "nothing outside the opened folder");
        assert!(create(&d, &d, "../x", "note").unwrap().starts_with(&d), "path parts are removed from names");
        let r = rename(&d, &n2, "Zweite").unwrap();
        assert_eq!(r.file_name().unwrap(), "Zweite.md");
        assert!(rename(&d, &r, "Neue Notiz").is_err(), "no overwriting");
        let m = move_to(&d, &r, &sub).unwrap();
        assert_eq!(m, sub.join("Zweite.md"));
        assert!(move_to(&d, &sub, &sub).is_err(), "not into itself");
        assert!(move_to(&d, &m, Path::new("/")).is_err());
        // A folder opened through a symbolic link: results keep the path the UI knows.
        #[cfg(unix)]
        {
            let link = std::env::temp_dir().join(format!("md-folder-link-{}", std::process::id()));
            let _ = fs::remove_file(&link);
            std::os::unix::fs::symlink(&d, &link).unwrap();
            assert_eq!(shown(&link, &m), link.join("Kapitel/Zweite.md"));
            let _ = fs::remove_file(&link);
        }
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn links_follow_a_rename() {
        let t = "[[Alt]] und [[alt|Text]] und [[Ordner/Alt#Teil]] und [[Alter]]\n`[[Alt]]`\n```\n[[Alt]]\n```\n";
        assert_eq!(rename_links(t, "Alt", "Neu").unwrap(),
            "[[Neu]] und [[Neu|Text]] und [[Ordner/Neu#Teil]] und [[Alter]]\n`[[Alt]]`\n```\n[[Alt]]\n```\n");
        assert_eq!(rename_links("nichts", "Alt", "Neu"), None);
    }
}
