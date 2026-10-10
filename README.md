# Markdown Studio (Rust / Tauri)

Desktop Markdown & LaTeX editor. The native shell is Rust ([Tauri 2](https://tauri.app)); the UI is the
Markdown Studio editor rendered by the OS web view (WebView2 on Windows, WebKit on macOS/Linux).
All rendering libraries (marked, KaTeX, highlight.js, DOMPurify) are bundled in `ui/vendor`, so it works offline.

```
ui/                 Editor UI (index.html, app.js, vendor/)
src-tauri/src/      Rust backend: file dialogs, open/save, HTML export, printing, "Open with" handling
src-tauri/          Cargo.toml, tauri.conf.json, capabilities
flatpak/            Flatpak manifest (repackages the Linux .deb)
.github/workflows/  CI that builds every platform
app-icon.png        Source icon (platform icons are generated from it)
```

## Build outputs

| Platform | Architectures | Packages |
|---|---|---|
| Windows 10/11 | x64, x86, ARM64 | NSIS `.exe` installer (+ `.msi` for x64/x86) |
| Linux | x86_64, aarch64 | `.AppImage`, `.deb`, `.flatpak` |
| macOS 10.15+ | Universal (Apple Silicon + Intel) | `.dmg` |

## Build everything (GitHub Actions)

macOS and Linux packages can't be built on Windows, so CI builds them all:

1. Push this folder to a GitHub repository.
2. **Actions → Build → Run workflow**, or push a tag like `v1.0.0` (a tag also creates a draft GitHub release with all files).
3. Download the installers from the run's **Artifacts**.

## Build Windows installers locally

1. Install [Rust](https://rustup.rs), [Node.js LTS](https://nodejs.org), and
   [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with
   *Desktop development with C++* (add *MSVC ARM64 build tools* for ARM64).
2. Run `.\build-windows.ps1 -Targets x64,x86,arm64`.

Dev mode with live reload: `npx @tauri-apps/cli@2 icon app-icon.png` once, then `npx @tauri-apps/cli@2 dev`.

## Notes

- Builds are unsigned. Windows SmartScreen and macOS Gatekeeper will warn on first launch
  (macOS: right-click the app → Open). Signing needs your own certificates.
- `.md` / `.markdown` files are associated with the app by the installers.
