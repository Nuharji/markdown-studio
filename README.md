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

## MCP
Markdown Studio is also an MCP server, so Claude (Desktop or Code), ChatGPT and other MCP clients can use what it can do:
started with `--mcp`, the program opens no window and speaks MCP on stdin / stdout until the client closes it.

- `list_notes` — Lists the Markdown notes in a folder and its subfolders.
- `read_note` — Reads a Markdown note: its text and number of words.
- `write_note` — Writes a Markdown note. Replaces an existing note only with overwrite.
- `search_notes` — Finds a text in the notes of a folder (not case-sensitive): file, line and the line's text.
- `note_graph` — The network of the notes in a folder: notes, and which link to which with [[…]].
- `render_html` — Renders Markdown text to HTML the way the preview does.

Only Markdown files are written, an existing note only with `overwrite`. Files are given as full paths.

Claude Code: `claude mcp add markdown-studio -- "/Applications/Markdown Studio.app/Contents/MacOS/markdown-studio" --mcp`.
Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "markdown-studio": {
      "command": "/Applications/Markdown Studio.app/Contents/MacOS/markdown-studio",
      "args": [
        "--mcp"
      ]
    }
  }
}
```
The program is `/Applications/Markdown Studio.app/Contents/MacOS/markdown-studio` on macOS, `markdown-studio.exe` in the install folder on
Windows, and `markdown-studio` (or the AppImage) on Linux.

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

Folders (sidebar, subfolders, graph of linked notes): `src-tauri/src/folder.rs` (tree, links, rename/move) and `ui/folder.js` (sidebar, graph drawing).

Markdown → HTML: `src-tauri/src/markdown.rs` (pulldown-cmark); the UI draws math (KaTeX), diagrams (Mermaid) and code colors (highlight.js).
