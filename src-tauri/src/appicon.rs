//! The Dock icon follows the theme (the same file in every Studio app). ui/applogo.js paints the recolored icon and
//! sends it here as PNG bytes; an empty picture brings back the installed icon. Only macOS has a Dock — on Windows and
//! Linux the window / taskbar icon is set from JS (Window.setIcon), so this does nothing there.

#[tauri::command]
pub fn set_dock_icon(app: tauri::AppHandle, png: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(move || mac::set(&png)).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, png);
    Ok(())
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::AnyThread;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    pub fn set(png: &[u8]) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let app = NSApplication::sharedApplication(mtm);
        if png.is_empty() {
            unsafe { app.setApplicationIconImage(None) };
            return;
        }
        let data = NSData::with_bytes(png);
        if let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) {
            unsafe { app.setApplicationIconImage(Some(&img)) };
        }
    }
}
