//! Pictures that lie on this computer: choosing them for a note (Insert → Image from File…) and showing them in
//! the preview. The webview can't read files itself, so the preview asks for each local picture and gets it back
//! as a data: URL (which also makes an HTML export self-contained).

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Picture files the chooser offers.
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
/// Bigger files aren't loaded into the preview.
const MAX_BYTES: usize = 40 * 1024 * 1024;

/// A chosen picture, ready to be written as `![alt](link)`.
#[derive(Serialize, Debug, PartialEq)]
pub struct Picked {
    alt: String,
    link: String,
}

/// The MIME type of a picture, from its first bytes (SVG: from the text); None if it isn't a picture.
fn mime_of(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") { return Some("image/png"); }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) { return Some("image/jpeg"); }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") { return Some("image/gif"); }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" { return Some("image/webp"); }
    if b.starts_with(b"BM") && b.len() > 26 { return Some("image/bmp"); }
    if b.starts_with(&[0, 0, 1, 0]) { return Some("image/x-icon"); }
    if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") { return Some("image/avif"); }
    let head = String::from_utf8_lossy(&b[..b.len().min(4096)]).to_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if (head.starts_with("<svg") || head.starts_with("<?xml") || head.starts_with("<!--") || head.starts_with("<!doctype svg")) && head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// A picture from a Markdown image link as a data: URL — relative to the note's folder (`doc` is the note's file)
/// or absolute, also file:/// links. None for web addresses, missing files and files that aren't pictures.
pub fn data_url(src: &str, doc: Option<&Path>) -> Option<String> {
    let base = doc.and_then(Path::parent);
    let src = src.trim();
    let absolute = src.starts_with("file:") || Path::new(src).is_absolute() || (cfg!(windows) && src.get(1..3) == Some(":/"));
    if base.is_none() && !absolute { return None; }
    let bytes = crate::docx::local_picture(src, base)?;
    if bytes.len() > MAX_BYTES { return None; }
    Some(format!("data:{};base64,{}", mime_of(&bytes)?, base64(&bytes)))
}

/// The path from the folder `dir` to `file`, with `/` (`../` to go up). None if they share nothing but the root
/// (or another drive) — then the absolute path is clearer.
fn relative(dir: &Path, file: &Path) -> Option<String> {
    let d: Vec<Component> = dir.components().collect();
    let f: Vec<Component> = file.components().collect();
    let same = d.iter().zip(&f).take_while(|(a, b)| a == b).count();
    let shared_real = d[..same].iter().any(|c| matches!(c, Component::Normal(_)));
    if !shared_real { return None; }
    let mut parts: Vec<String> = vec!["..".into(); d.len() - same];
    parts.extend(f[same..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(parts.join("/"))
}

/// The link for a picture file as written in Markdown: relative to the note's folder if the note is saved,
/// else absolute; `/` as separator; in `<…>` when it holds spaces or brackets.
fn link_for(file: &Path, doc: Option<&Path>) -> String {
    let rel = doc.and_then(Path::parent).and_then(|dir| relative(dir, file));
    let mut s = rel.unwrap_or_else(|| file.to_string_lossy().into_owned());
    if cfg!(windows) { s = s.replace('\\', "/"); }
    let s = s.replace('<', "%3C").replace('>', "%3E");
    if s.contains([' ', '(', ')', '\t']) { format!("<{s}>") } else { s }
}

/// The alt text: the file name without extension, without characters that would end the brackets.
fn alt_for(file: &Path) -> String {
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    stem.replace(['[', ']'], "").replace(['_', '-'], " ").trim().to_string()
}

fn pick(files: Vec<PathBuf>, doc: Option<&Path>) -> Vec<Picked> {
    files.iter().map(|f| Picked { alt: alt_for(f), link: link_for(f, doc) }).collect()
}

/// Lets the user choose pictures (several at once) and returns their links for the note `doc` (None: not saved yet).
#[tauri::command]
pub async fn pick_image(app: tauri::AppHandle, doc: Option<String>) -> Result<Vec<Picked>, String> {
    let doc = doc.map(PathBuf::from);
    let mut dialog = crate::shared::file_dialog(&app).set_title("Insert image").add_filter("Images", IMAGE_EXT);
    if let Some(dir) = doc.as_deref().and_then(Path::parent) { dialog = dialog.set_directory(dir); }
    let Some(files) = dialog.blocking_pick_files() else { return Ok(vec![]) };
    let files: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    Ok(pick(files, doc.as_deref()))
}

/// The local picture of an image link in the note `doc`, as a data: URL for the preview (None: not found).
#[tauri::command]
pub async fn local_image(src: String, doc: Option<String>) -> Option<String> {
    data_url(&src, doc.as_deref().map(Path::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn knows_pictures() {
        assert_eq!(mime_of(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(mime_of(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(mime_of(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(mime_of(b"<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Some("image/svg+xml"));
        assert_eq!(mime_of(b"# Not a picture\n"), None);
        assert_eq!(mime_of(b"<html><body>x</body></html>"), None);
    }

    #[test]
    fn links_relative_to_the_note() {
        let note = Path::new("/home/a/Notizen/Bio/Zelle.md");
        assert_eq!(link_for(Path::new("/home/a/Notizen/Bio/zelle.png"), Some(note)), "zelle.png");
        assert_eq!(link_for(Path::new("/home/a/Notizen/Bio/Bilder/Mito chondrium.jpg"), Some(note)), "<Bilder/Mito chondrium.jpg>");
        assert_eq!(link_for(Path::new("/home/a/Bilder/x.png"), Some(note)), "../../Bilder/x.png");
        assert_eq!(link_for(Path::new("/tmp/x.png"), Some(note)), "/tmp/x.png");
        assert_eq!(link_for(Path::new("/tmp/x.png"), None), "/tmp/x.png");
        assert_eq!(alt_for(Path::new("/x/mein_bild-2 [neu].png")), "mein bild 2 neu");
    }

    #[test]
    fn loads_local_pictures() {
        let dir = std::env::temp_dir().join("md-images-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Bilder")).unwrap();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        std::fs::write(dir.join("Bilder/a b.png"), png).unwrap();
        std::fs::write(dir.join("secret.txt"), "not a picture").unwrap();
        let note = dir.join("Note.md");
        let want = format!("data:image/png;base64,{}", base64(png));
        assert_eq!(data_url("Bilder/a%20b.png", Some(&note)).as_deref(), Some(want.as_str()));
        let abs = dir.join("Bilder/a b.png").to_string_lossy().into_owned();
        assert_eq!(data_url(&abs, None).as_deref(), Some(want.as_str()));
        assert_eq!(data_url("secret.txt", Some(&note)), None);
        assert_eq!(data_url("Bilder/a%20b.png", None), None);
        assert_eq!(data_url("https://example.com/a.png", Some(&note)), None);
        // The link written by the chooser finds the picture again (spaces: in <…>, which Markdown strips).
        let link = link_for(&dir.join("Bilder/a b.png"), Some(&note));
        assert_eq!(link, "<Bilder/a b.png>");
        assert!(data_url(link.trim_matches(['<', '>']), Some(&note)).is_some());
    }
}
