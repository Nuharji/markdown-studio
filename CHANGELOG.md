# Changelog

## 1.11.0 — 2026-10-24
- New: Open a whole folder (File → Open Folder…, Ctrl+Shift+O). A sidebar shows its subfolders and notes (folders first, “Teil 2” before “Teil 10”), the open note highlighted; filter by name; Alt+B shows or hides it. The folder is opened again at the next start; recently opened folders are listed.
- New: Sort notes into subfolders — drag notes and folders onto a folder, or right-click → Move to…; new notes and subfolders right in the tree (buttons or right-click), rename with F2. Renaming a note updates the `[[links]]` to it in the other notes. Open tabs follow when a note is moved or renamed.
- New: Graph of notes (View → Graph of Notes, Alt+G): every note of the folder and its `[[links]]` and links to other .md files as a network. Colors are the subfolders (click one in the legend to see only it), notes that are linked but not created yet are hollow (a click creates them). Hover shows a note’s links, click opens it, drag moves notes, wheel zooms, double-click fits; search highlights notes.
- New: Links tab in the side panel: the current note’s neighborhood as a small graph (depth 1–3), what links to it and what it links to.
- With a folder open, `[[Name]]` finds the note anywhere in it (the one next to the current note first), so moving notes into subfolders never breaks links. Dragging a note from the sidebar into the editor writes a `[[link]]` to it.
- Fixed: Word export on macOS and Linux left out pictures linked with Windows backslashes (`Bilder\Bild.png`).

## 1.10.2 — 2026-10-18
- Fixed: Word export left out pictures whose file name has spaces or umlauts when the link is written the usual way (`![Foto](Klasse%207b.png)`, as VS Code, Typora or Obsidian write it) — the Word file showed “[Bild: …]” instead. Such links, links in `<…>` and file:/// links now find the picture.

## 1.10.1 — 2026-10-15
- App icon with a picture of what the app does, like Slides and Plan Studio; the window and taskbar icon is now the same picture.

## 1.10.0 — 2026-10-15
- New: Export as Word (.docx) — headings, lists (also nested and numbered), tables, quotes, code, links, footnotes, pictures next to the file, diagrams and sketches as pictures, formulas (as text), citations and the reference list; A4 with page numbers. Written in Rust (docx.rs) without extra libraries.
- New: Export as PDF (File menu) — opens the print dialog; choose “Save as PDF”.
- New: Sources and citations. The Sources panel adds a source (key is made for you) to a `quellen` block; `[@key]` / `[@key, S. 12]` in the text become “(Müller 2020, S. 12)”, the block becomes the reference list (sorted by author). Unknown keys are marked red.
- New: File → New from Template: Referat, Facharbeit / Hausarbeit, Versuchsprotokoll, Unterrichtsnotiz, Lernzettel (German and English).
- New: Notes — `[[Name]]` links to Name.md in the same folder; a click opens it or creates it there.
- New: Sketches (Insert → Sketch, Ctrl+Shift+Y): draw with mouse or pen (pressure works); kept as a `sketch` block in the text, double-click in the preview to change it.
- Shared with all Studio apps (shared.rs / shared.js): theme and language follow the other apps and Studio Hub (also when you switch windows), and file dialogs open in the work folder chosen in Studio Hub.

## 1.9.1 — 2026-10-11
- Fixed: files that are not UTF-8 (older Windows files in Windows-1252 / ANSI) showed umlauts, ß and € as “�”, and saving destroyed those characters for good. They now open correctly and are saved back in their own encoding. If you type a character that encoding can’t hold (e.g. an emoji), the file is saved as UTF-8 and you get a note.
- Fixed: saving changed Windows line endings (CRLF) to LF and removed a UTF-8 BOM; UTF-16 files couldn’t be read. Files now keep their line endings, BOM and encoding. F5 / changes on disk are also detected correctly for CRLF files.

## 1.9.0 — 2026-10-11
- Loading information: opening a large document shows a card with its name while the preview is built (only when it takes a moment).

## 1.8.0 — 2026-10-11
- New: Settings → Shortcuts. Every menu command can get its own key: click it and press the new combination (with Ctrl or Alt, or a function key); Backspace removes a shortcut, ↺ or “Reset all” brings the defaults back. A key that another command used is moved (you get a note); system keys like Copy stay fixed. Menus, tooltips and Help → Keyboard Shortcuts show your keys.

## 1.7.0 — 2026-10-11
- New: Auto-hide bars (View menu, or Settings → General). The menu bar, toolbar, tool rail and status bar leave the window and slide in when the mouse touches their edge; they stay while a menu is open or you type in them. Alt alone shows the top bars (Escape or a click elsewhere hides them).

## 1.6.1 — 2026-10-11
- Spelling suggestions: the closest words come first, from both dictionaries (e.g. “wrold” → “world”).
- Faster checking of long documents.

## 1.6.0 — 2026-10-11
- Spelling & grammar check, German and English, entirely on your PC: misspelled words get a red wavy underline, grammar hints a blue one (doubled words, a small letter after the end of a sentence, spaces before punctuation, several spaces, a missing space after a comma, and in English “a”/“an” and “I”). Code, math, links and HTML are skipped.
- Right-click an underlined word for suggestions, “Add to dictionary” (a personal dictionary shared by all Studio apps) or “Ignore”. F7 or the status bar jumps to the next issue.
- Settings → Editor → Spelling & grammar: Automatic (German + English), German, English or Off.
- The portable .zip now includes the dictionaries (separate files with their own licenses, see dictionaries/README.md); the bare portable .exe has no spell check.

## 1.5.1 — 2026-10-11
- HTML export: the page is now put together and saved by the Rust core.
- Fixed: an HTML export made right after typing could miss the last changes.

## 1.5.0 — 2026-10-11
- More of the app runs in its Rust core: formatting commands (bold, italic, code, headings, lists, quotes, blocks), find & replace, word/character statistics and the outline now come from Rust. Undo (Ctrl+Z) works as before.
- The English and German texts are now language files (src-tauri/i18n) delivered by the Rust core.
- The table of contents and printing wait for the preview to be ready.

## 1.4.0 — 2026-10-10
- Markdown is now turned into HTML by the app's Rust core (pulldown-cmark) instead of a JavaScript library: GitHub-style tables, task lists, strikethrough, footnotes and bare links (https://…, www.…), math ($…$, $$…, `` `math ``) and Mermaid diagrams as before.
- The preview's line anchors for synchronized scrolling now come from Rust too.
- The syntax guide renders all its examples in one go.
## 1.3.5 — 2026-10-10
- Files changed by other programs are refreshed: open documents without unsaved edits reload by themselves (cursor and scroll position stay); if you have unsaved edits you get a hint instead.
- New: File → Refresh from Disk (F5) loads the newest version of the file (asks first if you have unsaved edits).

## 1.3.4 — 2026-10-10
- Icon fades swapped: dark themes now show the dark fade and light themes the light fade — in the menu bar, on the start screen and in the taskbar.

## 1.3.3 — 2026-10-10
- The app icon follows the theme: a light fade in dark themes, a dark fade in light themes — in the menu bar, on the start screen and in the window/taskbar icon.
- All Studio icons now have exactly the same rounded corners.

## 1.3.2 — 2026-10-10
- Synchronized scrolling now follows the content: each heading, paragraph, diagram, formula and code block in the editor lines up with the same block in the preview (in both directions), instead of just matching the scroll percentage.
- New app icon with a dark-to-bright blue fade, matching the Studio family look (also in the title bar and start screen).

## 1.3.1 — 2026-10-10
- The Windows taskbar and Alt+Tab now show the open document's name.

## 1.3.0 — 2026-10-10
- Right-click opens native Windows menus: editing and formatting in the editor, copy/export/print in the preview, save diagrams as SVG/PNG, close tabs.
- Copy and paste go through the system clipboard.
- Browser shortcuts (reload, back, print preview, caret browsing) are switched off.

## 1.2.0 — 2026-10-10
- New start screen when no document is open: New document, Open, Syntax guide and a list of recent files.

## 1.1.0 — 2026-10-10
- Diagrams with Mermaid: flowchart, sequence, class, state, Gantt, pie, mind map and timeline.
- Save any diagram as SVG or PNG; diagram reference cards and a new chapter in the syntax guide.

## 1.0.0 — 2026-10-10
- First desktop release: Markdown editor with live preview, LaTeX math (KaTeX), syntax highlighting.
- Settings dialog, English and German, themes Dark, Light, GitHub and GitHub Dark.
- Markdown and LaTeX reference panels, symbol palette, full syntax guide (F1), export to HTML, print / PDF.