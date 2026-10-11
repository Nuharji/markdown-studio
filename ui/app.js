'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const ed = $('#editor'), paper = $('#paper'), canvas = $('#canvas'), workspace = $('#workspace'), edPane = $('#edPane');
const STORE = 'markdown-studio.v1';
const F = '```';
// Exported HTML files are opened outside the app, so they reference the CDN copies of the styles.
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
const HLJS_CSS = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/';
// Native backend (Rust/Tauri). Null when the UI is opened directly in a browser.
const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = t => t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section';
const norm = t => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/* ================= Translations ================= */
/* The texts (English / German) live in src-tauri/i18n/*.json and are loaded from Rust at start. */
let I18N = {en: {}, de: {}
};
let lang = 'en';
function t(key, vars) {
  let s = I18N[lang][key] ?? I18N.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  return s;
}
const fmtKey = k => lang === 'de' ? k.replace(/Ctrl/g, 'Strg').replace(/Shift/g, 'Umschalt') : k;
const num = n => n.toLocaleString(lang);

const LIBS_OK = !!(window.katex && window.DOMPurify && invoke);

/* ================= Rendering ================= */
const MACROS = {'\\R':'\\mathbb{R}','\\N':'\\mathbb{N}','\\Z':'\\mathbb{Z}','\\Q':'\\mathbb{Q}','\\C':'\\mathbb{C}'};
/* Mermaid diagrams render asynchronously, one at a time, cached by theme + source. */
const MERMAID_OK = !!window.mermaid;
const svgCache = new Map();
let diagramQueue = Promise.resolve(), diagramSeq = 0;
const mermaidTheme = () => isPaperDark() ? 'dark' : isGh() ? 'neutral' : 'default';
function fillDiagram(el, res, tools) {
  if (res.error) {
    el.className = 'diagram error';
    el.innerHTML = `<div class="dg-error"><b>${esc(t('dg.error'))}</b><pre>${esc(res.error)}</pre></div>`;
    return;
  }
  el.className = 'diagram';
  el.innerHTML = res.svg + (tools ? `<div class="dg-tools"><button data-dg="svg" title="${esc(t('dg.saveSvg'))}">SVG</button>` +
    `<button data-dg="png" title="${esc(t('dg.savePng'))}">PNG</button></div>` : '');
}
function renderDiagram(el, code, prevHtml, tools) {
  if (!MERMAID_OK) return fillDiagram(el, {error: 'Mermaid library not loaded'}, false);
  const theme = mermaidTheme(), key = theme + '\n' + code, hit = svgCache.get(key);
  if (hit) return fillDiagram(el, hit, tools);
  el.classList.add('pending');
  if (prevHtml) el.innerHTML = prevHtml;
  diagramQueue = diagramQueue.then(async () => {
    if (!el.isConnected) return;
    let res = svgCache.get(key);
    if (!res) {
      try {
        mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme, htmlLabels: false, flowchart: {htmlLabels: false},
          fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif'});
        await mermaid.parse(code);
        res = {svg: (await mermaid.render('mmd-' + (++diagramSeq), code)).svg};
      } catch (e) {
        res = {error: String((e && e.message) || e).trim()};
      }
      svgCache.set(key, res);
      if (svgCache.size > 300) svgCache.delete(svgCache.keys().next().value);
    }
    if (el.isConnected) fillDiagram(el, res, tools);
  });
}
/* Markdown is turned into HTML in Rust (markdown.rs): GitHub-style Markdown, math and diagram placeholders, and
   data-line anchors for synchronized scrolling. Here it is sanitized and the formulas, diagrams and code colors are drawn. */
async function mdRender(sources, inline = false) { return invoke('md_render', {sources, inline}); }
/* r = {html, math: [[tex, display]], diagrams: [code]} from Rust. */
function renderInto(root, r) {
  // Keep the previous drawings so a diagram being edited doesn't flash empty while it re-renders.
  const prev = [...root.querySelectorAll('[data-diagram]')].map(el => el.classList.contains('error') ? '' : el.innerHTML);
  root.innerHTML = DOMPurify.sanitize(r.html);
  const tools = root === paper;
  root.querySelectorAll('[data-diagram]').forEach((el, i) => renderDiagram(el, r.diagrams[+el.dataset.diagram], prev[i], tools));
  const macros = {...MACROS};
  root.querySelectorAll('[data-math]').forEach(el => {
    const m = r.math[+el.dataset.math];
    if (!m) return;
    const [tex, display] = m;
    try { el.innerHTML = katex.renderToString(tex, {displayMode: display, throwOnError: false, macros, strict: 'ignore'}); }
    catch (e) { el.textContent = tex; el.classList.add('math-error'); el.title = e.message; }
  });
  if (window.hljs) root.querySelectorAll('pre code[class*="language-"]').forEach(c => {
    const l = [...c.classList].find(x => x.startsWith('language-')).slice(9);
    if (hljs.getLanguage(l)) hljs.highlightElement(c);
  });
  root.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
}

/* ================= Documents & session ================= */
const THEMES = ['dark', 'light', 'github', 'github-dark'];
const DEF = {lang: 'auto', theme: 'dark', view: 'split', split: 50, zoom: 100, sync: true, wrap: true, paper: 'auto', font: 'sans',
  pagew: 860, edFont: 14, dock: true, dockTab: 'outline'};
let settings = {...DEF}, docs = [], active = 0, untitledN = 1, saveT, rT, booted = false;
const cur = () => docs[active];
const blankDoc = (name, content = '', handle = null) =>
  ({name: name || `${t('doc.untitled')}-${untitledN++}.md`, content, handle, dirty: false, sel: [0, 0], scroll: 0});
const effectiveLang = () => settings.lang === 'auto'
  ? ((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en') : settings.lang;
const isGh = () => settings.theme.startsWith('github');
const isPaperDark = () => settings.paper === 'dark' || (settings.paper === 'auto' && settings.theme === 'github-dark');
const paperClass = () => 'md' + (isGh() ? ' gh' : '') + (isPaperDark() ? ' dark' : '') + (settings.font === 'serif' ? ' serif' : '');

function storeCurrent() {
  const d = cur(); if (!d) return;
  d.content = ed.value; d.sel = [ed.selectionStart, ed.selectionEnd]; d.scroll = ed.scrollTop;
}
function saveNow() {
  storeCurrent();
  try { localStorage.setItem(STORE, JSON.stringify({
    docs: docs.map(d => ({name: d.name, content: d.content, dirty: d.dirty, sel: d.sel,
      path: typeof d.handle === 'string' ? d.handle : null})), active, settings, untitledN, recent})); } catch (e) {}
}
function saveSession() { clearTimeout(saveT); saveT = setTimeout(saveNow, 300); }
window.addEventListener('beforeunload', saveNow);

/* Recently opened files (native only: the browser has no file paths). */
let recent = [];
function addRecent(path, name) {
  if (typeof path !== 'string') return;
  recent = [{path, name}, ...recent.filter(r => r.path !== path)].slice(0, 10);
}
function renderRecent() {
  $('#recent').innerHTML = recent.length ? `<div class="sect">${esc(t('ui.recent'))}</div>` + recent.map((r, i) =>
    `<button data-recent="${i}"><span class="tab-ico">MD</span><span>${esc(r.name)}</span><small>${esc(r.path)}</small></button>`).join('') : '';
}
$('#recent').addEventListener('click', async e => {
  const b = e.target.closest('[data-recent]'); if (!b) return;
  const r = recent[+b.dataset.recent];
  try { openNative([await invoke('read_file', {path: r.path})]); }
  catch (err) { recent = recent.filter(x => x !== r); renderRecent(); saveSession(); toast(t('toast.missing', {name: r.name})); }
});

/* Actions that make sense with no document open; everything else is disabled on the start screen. */
const NO_DOC = new Set(['newDoc', 'openFile', 'settings', 'langAuto', 'langEn', 'langDe', 'themeDark', 'themeLight', 'themeGithub',
  'themeGithubDark', 'openGuide', 'refMd', 'refLatex', 'shortcuts', 'about', 'togglePanels', 'toggleSync', 'toggleWrap', 'togglePaper',
  'zoomIn', 'zoomOut', 'zoomReset', 'viewEdit', 'viewSplit', 'viewPreview']);
const allowed = act => !!cur() || NO_DOC.has(act);
function run(act) { if (allowed(act)) A[act](); }
function syncDisabled() {
  $$('[data-act]').forEach(b => b.disabled = !allowed(b.dataset.act));
  $('#styleSel').disabled = !cur();
}

function loadActive() {
  const d = cur();
  $('#emptyState').hidden = !!d; workspace.hidden = !d;
  syncDisabled();
  if (!d) {
    ed.value = ''; $('#findbar').classList.remove('show');
    renderTabs(); updateTitle(); render(); renderRecent(); saveSession();
    ['#stPos', '#stWords', '#stChars', '#stRead'].forEach(s => $(s).textContent = '');
    return;
  }
  ed.value = d.content;
  ed.setSelectionRange(d.sel[0], d.sel[1]);
  ed.scrollTop = d.scroll;
  renderTabs(); updateTitle(); render(); updateCursor(); saveSession();
  ed.focus({preventScroll: true});
}
function activate(i) { if (i === active) return; storeCurrent(); active = i; loadActive(); }

/* ================= Files changed outside (e.g. by another program or Claude) ================= */
/* Every open file's modification time is checked every 2 s and when the window gets focus. Unchanged documents reload
   by themselves (cursor and scroll position stay); documents with unsaved edits only get a hint — F5 loads the file then. */
const onDisk = d => invoke && typeof d.handle === 'string';
async function stampOf(d) { if (onDisk(d)) { try { [d.stamp] = await invoke('file_stamps', {paths: [d.handle]}); } catch (e) {} } }
function replaceContent(d, content) {
  d.content = content; d.disk = content;
  if (d === cur()) {
    const sel = [ed.selectionStart, ed.selectionEnd], top = ed.scrollTop, canvasTop = canvas.scrollTop;
    ed.value = content;
    ed.setSelectionRange(Math.min(sel[0], content.length), Math.min(sel[1], content.length));
    ed.scrollTop = top; render(); canvas.scrollTop = canvasTop; updateCursor();
  }
  d.dirty = false; renderTabs(); updateTitle(); saveSession();
}
let checking = false;
async function checkDisk() {
  if (checking || !invoke) return;
  const list = docs.filter(onDisk); if (!list.length) return;
  checking = true;
  try {
    const stamps = await invoke('file_stamps', {paths: list.map(d => d.handle)});
    for (let i = 0; i < list.length; i++) {
      const d = list[i], s = stamps[i];
      if (!s || s === d.stamp) continue;
      const first = d.stamp == null;
      d.stamp = s;
      let f; try { f = await invoke('read_file', {path: d.handle}); } catch (e) { continue; }
      if (f.content === d.content) { d.disk = f.content; continue; }
      if (d === cur()) storeCurrent();
      if (!d.dirty) { replaceContent(d, f.content); if (!first) toast(t('toast.reloaded', {name: d.name})); }
      else if (f.content !== d.disk) { d.disk = f.content; toast(t('toast.changedOutside', {name: d.name})); }
    }
  } finally { checking = false; }
}
/* F5: load the file from disk now (asks first if there are unsaved edits). */
async function reloadFile() {
  const d = cur(); if (!d) return;
  if (!onDisk(d)) return toast(t('toast.notOnDisk', {name: d.name}));
  storeCurrent();
  let f; try { f = await invoke('read_file', {path: d.handle}); } catch (e) { return toast(t('toast.missing', {name: d.name})); }
  if (f.content === d.content) { d.dirty = false; renderTabs(); updateTitle(); return toast(t('toast.upToDate', {name: d.name})); }
  if (d.dirty && !await ask(t('confirm.reload', {name: d.name}))) return;
  replaceContent(d, f.content); stampOf(d);
  toast(t('toast.reloaded', {name: d.name}));
}
window.addEventListener('focus', checkDisk);
setInterval(() => { if (document.visibilityState === 'visible') checkDisk(); }, 2000);
function openDoc(name, content, handle = null) {
  if (typeof handle === 'string') {
    const open = docs.findIndex(x => x.handle === handle);
    if (open >= 0) { activate(open); return docs[open]; }
  }
  storeCurrent();
  const c = cur(), d = blankDoc(name, content, handle);
  if (c && !c.content.trim() && !c.dirty && !c.handle) docs[active] = d;
  else { docs.push(d); active = docs.length - 1; }
  loadActive();
  return d;
}
// Native files arrive from Rust as {path, name, content}.
const openNative = list => list.forEach(f => { addRecent(f.path, f.name); const d = openDoc(f.name, f.content, f.path); stampOf(d); });
async function ask(message) {
  return invoke
    ? invoke('confirm', {title: t('confirm.title'), message, okLabel: t('confirm.ok'), cancelLabel: t('confirm.cancel')})
    : confirm(message);
}
async function closeTab(i) {
  const d = docs[i];
  if (d.dirty && !await ask(t('confirm.close', {name: d.name}))) return;
  i = docs.indexOf(d);
  if (i !== active) storeCurrent();
  docs.splice(i, 1);
  if (i < active) active--; else active = Math.min(active, docs.length - 1);   // -1 = start screen
  loadActive();
}
function renderTabs() {
  const box = $('#tabs'); box.innerHTML = '';
  docs.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === active ? ' active' : '') + (d.dirty ? ' dirty' : '');
    el.dataset.i = i;
    el.title = d.name + (!d.handle && d.dirty ? ' ' + t('ui.notSaved') : '');
    el.innerHTML = `<span class="tab-ico">MD</span><span class="name">${esc(d.name)}</span><button class="x" title="${esc(t('a.closeTab'))} (Alt+W)">&#10005;</button>`;
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };
    el.onclick = e => e.target.closest('.x') ? closeTab(i) : activate(i);
    box.append(el);
  });
  const plus = document.createElement('button');
  plus.className = 'tab-new'; plus.title = `${t('ui.newDocTip')} (Alt+N)`; plus.textContent = '+';
  plus.onclick = () => A.newDoc();
  box.append(plus);
}
function updateTitle() {
  const d = cur();
  if (!d) {
    $('#apptitle').textContent = document.title = 'Markdown Studio';
    $('#stState').className = ''; $('#stState').textContent = ''; $('#pName').textContent = '';
    return;
  }
  $('#apptitle').textContent = `${d.name}${d.dirty ? ' ●' : ''}  —  Markdown Studio`;
  document.title = `${d.dirty ? '● ' : ''}${d.name} — Markdown Studio`;
  const st = $('#stState');
  st.className = 'st-state' + (d.dirty ? ' dirty' : '');
  st.textContent = d.dirty ? t('st.dirty') : d.handle ? t('st.saved') : t('st.clean');
  $('#pName').textContent = d.name;
}
function markDirty(flag) {
  const d = cur(); if (!d) return;
  if (d.dirty !== flag) { d.dirty = flag; renderTabs(); }
  updateTitle(); saveSession();
}

ed.addEventListener('input', () => {
  if (!cur()) return;
  cur().content = ed.value;
  markDirty(true);
  clearTimeout(rT); rT = setTimeout(render, ed.value.length > 60000 ? 350 : 120);
  updateCursor();
});

let renderSeq = 0;
async function render() {
  clearTimeout(rT);
  if (!LIBS_OK) { paper.textContent = ed.value; return; }
  // Results of older keystrokes that arrive late are ignored.
  const my = ++renderSeq, [r] = await mdRender([ed.value]);
  if (my !== renderSeq) return;
  renderInto(paper, r);
  invalidateSync(); buildOutline(r); updateStats(r);
}

/* ================= Status, outline & stats ================= */
function updateCursor() {
  const s = ed.selectionStart, e = ed.selectionEnd, v = ed.value, before = v.slice(0, s);
  const ln = before.split('\n').length, col = s - before.lastIndexOf('\n');
  $('#stPos').textContent = t('st.pos', {l: ln, c: col}) + (e > s ? '  ' + t('st.sel', {n: e - s}) : '');
  const ls = v.lastIndexOf('\n', s - 1) + 1; let le = v.indexOf('\n', s); if (le < 0) le = v.length;
  const m = /^ {0,3}(#{1,6})\s/.exec(v.slice(ls, le));
  $('#styleSel').value = m ? m[1].length : 0;
}
['keyup', 'click', 'select', 'focus'].forEach(ev => ed.addEventListener(ev, updateCursor));

/* r = the Rust rendering: stats {words, chars, lines, code, links, images}, headings, math, diagrams. */
function updateStats(r) {
  const s = r.stats, words = s.words, read = Math.max(1, Math.ceil(words / 220));
  $('#stWords').textContent = t('st.words', {n: num(words)});
  $('#stChars').textContent = t('st.chars', {n: num(s.chars)});
  $('#stRead').textContent = t('st.read', {n: read});
  $('#pWords').textContent = num(words);
  $('#pChars').textContent = num(s.chars);
  $('#pLines').textContent = num(s.lines);
  $('#pHeads').textContent = r.headings.length;
  $('#pMath').textContent = r.math.length;
  $('#pDiagrams').textContent = r.diagrams.length;
  $('#pCode').textContent = s.code;
  $('#pLinks').textContent = `${s.links} / ${s.images}`;
  $('#pRead').textContent = t('st.min', {n: read});
}

function outlineHeadings() { return [...paper.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => !h.closest('.example')); }
/* Scroll only the preview canvas (scrollIntoView would also scroll the app frame). */
function scrollPreviewTo(el) {
  const top = el.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop - 16;
  canvas.scrollTo({top: Math.max(0, top), behavior: 'smooth'});
}
/* The outline: headings and their source lines come from Rust; the preview's heading elements are matched in order. */
function buildOutline(r) {
  const box = $('#outline'), used = {}, src = r.headings.map(([level, text, line]) => ({key: norm(text), line}));
  const hs = outlineHeadings();
  box.innerHTML = hs.length ? '' : `<div class="empty">${t('ui.noHeadings')}</div>`;
  let from = 0;
  hs.forEach(h => {
    let id = slug(h.textContent);
    if (used[id]) id += '-' + used[id]++; else used[id] = 1;
    h.id = id;
    const key = norm(h.textContent);
    const idx = src.findIndex((s, i) => i >= from && s.key === key);
    const line = idx >= 0 ? src[idx].line : null;
    if (idx >= 0) from = idx + 1;
    const it = document.createElement('div');
    it.className = 'ol-item'; it.dataset.level = h.tagName[1];
    it.style.paddingLeft = (8 + (h.tagName[1] - 1) * 14) + 'px';
    it.textContent = h.textContent; it.title = h.textContent;
    it.onclick = () => {
      if (settings.view !== 'edit') scrollPreviewTo(h);
      if (line != null && settings.view !== 'preview') gotoLine(line);
    };
    box.append(it);
  });
}

/* Scroll the textarea so a character offset is visible (measures wrapped text with a hidden mirror). */
function scrollToPos(pos) {
  if (!ed.clientWidth) return;
  const cs = getComputedStyle(ed), mirror = document.createElement('div');
  Object.assign(mirror.style, {position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', boxSizing: 'border-box',
    width: ed.clientWidth + 'px', padding: cs.padding, fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    tabSize: cs.tabSize, whiteSpace: settings.wrap ? 'pre-wrap' : 'pre', overflowWrap: 'break-word'});
  mirror.textContent = ed.value.slice(0, pos) + '​';
  document.body.append(mirror);
  const h = mirror.scrollHeight; mirror.remove();
  ed.scrollTop = Math.max(0, h - ed.clientHeight / 3);
}
function gotoLine(n) {
  const lines = ed.value.split('\n'); let pos = 0;
  for (let i = 0; i < n; i++) pos += lines[i].length + 1;
  ed.focus({preventScroll: true}); ed.setSelectionRange(pos, pos); scrollToPos(pos); updateCursor();
}

/* ================= Editing primitives ================= */
function replaceRange(s, e, text, selS, selE) {
  ed.focus({preventScroll: true});
  ed.setSelectionRange(s, e);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (err) {}
  if (!ok) { ed.setRangeText(text, s, e, 'end'); ed.dispatchEvent(new Event('input')); }
  if (selS != null) ed.setSelectionRange(selS, selE);
  updateCursor();
}
const selInfo = () => ({s: ed.selectionStart, e: ed.selectionEnd, v: ed.value, sel: ed.value.slice(ed.selectionStart, ed.selectionEnd)});

/* Formatting commands are computed in Rust (edit.rs): it answers with one edit, which is applied here so Ctrl+Z works. */
async function runEdit(cmd) {
  const {s, e} = selInfo();
  const r = await invoke('md_edit', {text: ed.value, s, e, cmd});
  replaceRange(r.s, r.e, r.text, r.sel_s, r.sel_e);
}
const wrap = (before, after = before, placeholder = 'text') => runEdit({kind: 'wrap', before, after, placeholder});
const insertBlock = (block, selFrom = null, selLen = null) => runEdit({kind: 'block', block, sel_from: selFrom, sel_len: selLen});
const setHeading = (level, toggle = true) => runEdit({kind: 'heading', level, toggle, cycle: false});
const listCmd = list => runEdit({kind: 'prefix', list});
function insertAtCursor(text) { const {s, e} = selInfo(); replaceRange(s, e, text); }
/* Editor keys: Tab indent, Enter continues lists */
ed.addEventListener('keydown', e => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const {s, e: en, v} = selInfo();
    if (s === en && !e.shiftKey) return insertAtCursor('  ');
    const ls = v.lastIndexOf('\n', s - 1) + 1; let le = v.indexOf('\n', en > s && v[en - 1] === '\n' ? en - 1 : en); if (le < 0) le = v.length;
    const out = v.slice(ls, le).split('\n').map(l => e.shiftKey ? l.replace(/^ {1,2}|^\t/, '') : '  ' + l).join('\n');
    return replaceRange(ls, le, out, ls, ls + out.length);
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && ed.selectionStart === ed.selectionEnd) {
    const s = ed.selectionStart, v = ed.value, ls = v.lastIndexOf('\n', s - 1) + 1, line = v.slice(ls, s);
    const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
    if (!m) return;
    e.preventDefault();
    if (line === m[0]) return replaceRange(ls, s, '');
    let marker = m[2];
    if (m[3]) marker = (+m[3] + 1) + m[4] + ' ';
    else marker = marker.replace(/\[[xX]\]/, '[ ]');
    insertAtCursor('\n' + m[1] + marker);
  }
});

/* ================= Find & replace ================= */
const findIn = $('#findIn'), replIn = $('#replIn'), findCase = $('#findCase');
function openFind() {
  $('#findbar').classList.add('show');
  const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
  if (sel && !sel.includes('\n')) findIn.value = sel;
  findIn.focus(); findIn.select(); countMatches();
}
function closeFind() { $('#findbar').classList.remove('show'); ed.focus(); }
/* Matches are found in Rust (edit.rs); positions are the text field's. */
const matchesFor = q => q ? invoke('md_find', {text: ed.value, query: q, case: findCase.checked}) : Promise.resolve([]);
async function countMatches() {
  const q = findIn.value, list = await matchesFor(q);
  if (!q) return $('#fCount').textContent = '';
  const k = list.indexOf(ed.selectionStart);
  $('#fCount').textContent = list.length
    ? (k >= 0 && ed.selectionEnd - ed.selectionStart === q.length ? t('find.count', {i: k + 1, n: list.length}) : t('find.found', {n: list.length}))
    : t('find.none');
}
async function findNext(back = false) {
  const q = findIn.value; if (!q) return openFind();
  const list = await matchesFor(q); if (!list.length) return countMatches();
  const s = ed.selectionStart;
  let i = back ? [...list].reverse().find(x => x < s) : list.find(x => x > s || (x === s && ed.selectionEnd === s));
  if (i == null) i = back ? list[list.length - 1] : list[0];
  ed.setSelectionRange(i, i + q.length); scrollToPos(i); countMatches(); updateCursor();
}
function replaceOne() {
  const q = findIn.value; if (!q) return;
  const {s, e, sel} = selInfo();
  const same = findCase.checked ? sel === q : sel.toLowerCase() === q.toLowerCase();
  if (same) { replaceRange(s, e, replIn.value); findIn.focus(); }
  findNext();
}
async function replaceAll() {
  const q = findIn.value; if (!q) return;
  const [text, n] = await invoke('md_replace_all', {text: ed.value, query: q, replacement: replIn.value, case: findCase.checked});
  if (!n) return countMatches();
  replaceRange(0, ed.value.length, text, 0, 0);
  toast(t('find.replaced', {n})); countMatches();
}
findIn.addEventListener('input', countMatches);
findCase.addEventListener('change', countMatches);
findIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey); } });
replIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } });
$('#fNext').onclick = () => findNext(); $('#fPrev').onclick = () => findNext(true);
$('#fRepl').onclick = replaceOne; $('#fAll').onclick = replaceAll; $('#fClose').onclick = closeFind;

/* ================= Files ================= */
const FILE_TYPES = [{description: 'Markdown', accept: {'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt']}}];
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function openFile() {
  if (invoke) {
    try { openNative(await invoke('open_files')); } catch (e) { toast(t('toast.openFail', {e})); }
    return;
  }
  if (!window.showOpenFilePicker) return $('#fileIn').click();
  try {
    const handles = await showOpenFilePicker({types: FILE_TYPES, multiple: true});
    for (const h of handles) { const f = await h.getFile(); openDoc(f.name, await f.text(), h); }
  } catch (e) { if (e.name !== 'AbortError') toast(t('toast.openFail', {e: e.message})); }
}
$('#fileIn').onchange = async e => {
  for (const f of e.target.files) openDoc(f.name, await f.text());
  e.target.value = '';
};
async function save(as) {
  storeCurrent();
  const d = cur();
  if (invoke) {
    try {
      const r = await invoke('save_file', {path: as ? null : d.handle, suggestedName: d.name, content: d.content});
      if (!r) return;
      d.handle = r.path; d.name = r.name; addRecent(r.path, r.name); d.disk = d.content; stampOf(d);
      markDirty(false); renderTabs(); toast(t('toast.saved', {name: d.name}));
    } catch (e) { toast(t('toast.saveFail', {e})); }
    return;
  }
  try {
    if (!d.handle || as) {
      if (!window.showSaveFilePicker) {
        download(d.name, d.content, 'text/markdown');
        markDirty(false); return toast(t('toast.downloaded', {name: d.name}));
      }
      d.handle = await showSaveFilePicker({suggestedName: d.name, types: FILE_TYPES});
      d.name = d.handle.name;
    }
    const w = await d.handle.createWritable();
    await w.write(d.content); await w.close();
    markDirty(false); renderTabs(); toast(t('toast.saved', {name: d.name}));
  } catch (e) { if (e.name !== 'AbortError') toast(t('toast.saveFail', {e: e.message})); }
}
async function exportHtml() {
  render();
  const d = cur(), title = d.name.replace(/\.[^.]+$/, '') || 'document', dark = isPaperDark();
  const hl = HLJS_CSS + (dark ? 'github-dark.min.css' : 'github.min.css');
  const bg = dark ? (isGh() ? '#010409' : '#0f0f0f') : (isGh() ? '#f6f8fa' : '#f2f2f2');
  const body = paper.cloneNode(true);
  body.querySelectorAll('.dg-tools').forEach(el => el.remove());
  const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${KATEX_CSS}"><link rel="stylesheet" href="${hl}">
<style>${$('#md-css').textContent}
body{margin:0;background:${bg}}.paper{--paperw:${settings.pagew}px;margin:40px auto;box-shadow:0 2px 18px rgba(0,0,0,.15)}
@media print{body{background:#fff}.paper{margin:0;box-shadow:none;max-width:none}}</style></head>
<body><article class="${paper.className}">${body.innerHTML}</article></body></html>`;
  if (invoke) {
    try {
      const path = await invoke('export_html', {suggestedName: title + '.html', html});
      if (path) toast(t('toast.exported', {name: path}));
    } catch (e) { toast(t('toast.exportFail', {e})); }
    return;
  }
  download(title + '.html', html, 'text/html');
  toast(t('toast.exported', {name: title + '.html'}));
}

/* Diagram export (hover toolbar on each diagram in the preview) */
async function saveBytes(name, filterName, ext, bytes, mime) {
  if (invoke) {
    const path = await invoke('save_bytes', {suggestedName: name, filterName, extensions: [ext], bytes: Array.from(bytes)});
    if (path) toast(t('toast.exported', {name: path}));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], {type: mime}));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(t('toast.exported', {name}));
}
function standaloneSvg(svg) {
  const box = svg.viewBox && svg.viewBox.baseVal, r = svg.getBoundingClientRect();
  const w = Math.ceil((box && box.width) || r.width), h = Math.ceil((box && box.height) || r.height);
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', w); clone.setAttribute('height', h);
  clone.style.maxWidth = '';
  return {xml: new XMLSerializer().serializeToString(clone), w, h};
}
async function svgToPng(xml, w, h, scale = 2) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * scale; c.height = h * scale;
  const ctx = c.getContext('2d');
  ctx.fillStyle = isPaperDark() ? (isGh() ? '#0d1117' : '#1c1c1c') : '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((ok, fail) => c.toBlob(b => b ? ok(b) : fail(new Error('PNG encoding failed')), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
paper.addEventListener('click', async e => {
  const btn = e.target.closest('[data-dg]');
  if (!btn) return;
  const all = [...paper.querySelectorAll('.diagram')], el = btn.closest('.diagram'), svg = el.querySelector('svg');
  if (!svg) return;
  const base = (cur().name.replace(/\.[^.]+$/, '') || 'document') + `-${t('dg.file')}-${all.indexOf(el) + 1}`;
  try {
    const {xml, w, h} = standaloneSvg(svg);
    if (btn.dataset.dg === 'svg') await saveBytes(base + '.svg', 'SVG', 'svg', new TextEncoder().encode(xml), 'image/svg+xml');
    else await saveBytes(base + '.png', 'PNG', 'png', await svgToPng(xml, w, h), 'image/png');
  } catch (err) { toast(t('toast.dgFail', {e: (err && err.message) || err})); }
});

/* External links open in the system browser when running natively. */
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="http"], a[href^="mailto:"]');
  if (!a || !invoke) return;
  e.preventDefault();
  invoke('open_url', {url: a.href}).catch(err => toast(t('toast.linkFail', {e: err})));
});

/* Drag & drop */
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').classList.add('show'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  for (const f of e.dataTransfer.files) {
    if (/\.(md|markdown|mdown|mkd|txt)$/i.test(f.name)) openDoc(f.name, await f.text());
    else toast(t('toast.skipped', {name: f.name}));
  }
});

/* ================= Reference panels & guide ================= */
function parseRef(id) {
  const split = line => { const [title, desc = ''] = line.split(' | '); return {title: title.trim(), desc: desc.trim()}; };
  return $('#' + id).textContent.split(/^@@ /m).filter(x => x.trim()).map(chunk => {
    const lines = chunk.split('\n'), r = {en: split(lines.shift())};
    if (lines[0] && lines[0].startsWith('@de ')) r.de = split(lines.shift().slice(4));
    r.code = lines.join('\n').replace(/\s+$/, '');
    return r;
  });
}
const REF = {md: parseRef('ref-md'), latex: parseRef('ref-latex'), diagram: parseRef('ref-diagram')};
const refText = r => (lang === 'de' && r.de) || r.en;
const SYMBOLS = String.raw`\alpha \beta \gamma \delta \epsilon \theta \lambda \mu \pi \sigma \phi \omega \Gamma \Delta \Theta \Lambda \Sigma \Phi \Omega \infty
\sum \prod \int \oint \partial \nabla \sqrt{x} \frac{a}{b} x^{n} x_{i} \hat{x} \vec{v} \bar{x} \dot{x} \pm \times \div \cdot
\le \ge \ne \approx \equiv \propto \in \notin \subset \subseteq \cup \cap \emptyset \forall \exists \neg \land \lor
\to \Rightarrow \Leftrightarrow \mapsto \mathbb{R} \mathbb{N} \mathbb{Z} \mathbb{C} \ldots`.split(/\s+/);

let cardsBuilt = false;
async function buildCards() {
  if (cardsBuilt || !LIBS_OK) return; cardsBuilt = true;
  for (const kind of ['md', 'diagram', 'latex']) {
    const box = $({md: '#mdCards', diagram: '#dgCards', latex: '#latexCards'}[kind]);
    // All examples and descriptions of a section are rendered in Rust in one go.
    const outs = await mdRender(REF[kind].map(r => r.code)), descs = await mdRender(REF[kind].map(r => refText(r).desc || ''), true);
    box.innerHTML = '';
    REF[kind].forEach((r, k) => {
      const {title, desc} = refText(r), c = document.createElement('div');
      c.className = 'card';
      c.dataset.search = [title, desc, r.en.title, r.code].join(' ').toLowerCase();
      c.innerHTML = `<div class="card-h"><span>${esc(title)}</span><button class="btn-sm">${esc(t('ui.insert'))}</button></div>
        ${desc ? `<div class="desc">${DOMPurify.sanitize(descs[k].html)}</div>` : ''}
        <pre class="src">${esc(r.code)}</pre><div class="out ${paperClass()}"></div>`;
      renderInto(c.querySelector('.out'), outs[k]);
      c.querySelector('button').onclick = () => {
        if (!cur()) A.newDoc();
        r.code.includes('\n') ? insertBlock(r.code) : insertAtCursor(r.code);
      };
      box.append(c);
    });
  }
  const g = $('#glyphs'); g.innerHTML = '';
  SYMBOLS.forEach(cmd => {
    const b = document.createElement('button');
    b.className = 'glyph'; b.title = cmd;
    b.innerHTML = katex.renderToString(cmd, {throwOnError: false, macros: {...MACROS}});
    b.onmousedown = e => e.preventDefault();
    b.onclick = async () => { if (!cur()) A.newDoc(); const math = await invoke('md_in_math', {text: ed.value, pos: ed.selectionStart}); insertAtCursor(math ? cmd + (/[a-zA-Z]$/.test(cmd) ? ' ' : '') : `$${cmd}$`); };
    g.append(b);
  });
  $$('[data-filter]').forEach(inp => inp.dispatchEvent(new Event('input')));
}
$$('[data-filter]').forEach(inp => inp.addEventListener('input', () => {
  const q = inp.value.toLowerCase().trim();
  $$(`.dpanel[data-panel="${inp.dataset.filter}"] .card`).forEach(c => c.style.display = !q || c.dataset.search.includes(q) ? '' : 'none');
}));

function buildGuide() {
  const entry = r => {
    const {title, desc} = refText(r);
    return `### ${title}\n\n${desc ? desc + '\n\n' : ''}${'````'}markdown\n${r.code}\n${'````'}\n\n<div class="example">\n\n${r.code}\n\n</div>\n\n`;
  };
  const kb = k => `<kbd>${esc(fmtKey(k)).replace(/\\/g, '\\\\').replace(/`/g, '&#96;')}</kbd>`;
  let s = `# ${t('g.title')}\n\n${t('g.intro')}\n\n**${t('doc.contents')}**\n\n` +
    [t('g.md'), t('g.latex'), t('g.dg'), t('g.keys')].map(h => `- [${h}](#${slug(h)})`).join('\n') + '\n\n';
  s += `## ${t('g.md')}\n\n${t('g.mdIntro')}\n\n`;
  REF.md.forEach(r => s += entry(r));
  s += `## ${t('g.latex')}\n\n${t('g.latexIntro')}\n\n`;
  REF.latex.forEach(r => s += entry(r));
  s += `## ${t('g.dg')}\n\n${t('g.dgIntro')}\n\n`;
  REF.diagram.forEach(r => s += entry(r));
  s += `## ${t('g.keys')}\n\n| ${t('g.menu')} | ${t('g.command')} | ${t('g.shortcut')} |\n|:-----|:--------|:---------|\n`;
  MENUS.forEach(([m, items]) => items.forEach(it => { if (Array.isArray(it) && it[1]) s += `| ${t('menu.' + m)} | ${t('a.' + it[0])} | ${kb(it[1])} |\n`; }));
  s += `\n| ${t('ed.editor')} | ${t('g.action')} |\n|:-------|:-------|\n` +
    `| ${kb('Tab')} / ${kb('Shift+Tab')} | ${t('g.indent')} |\n` +
    `| ${kb('Enter')} ${t('g.enter')} | ${t('g.enterDo')} |\n` +
    `| ${kb('F3')} | ${t('g.f3')} |\n` +
    `| ${kb('Ctrl')} + ${t('g.wheel')} | ${t('g.wheelDo')} |\n` +
    `| ${t('g.mid')} | ${t('g.midDo')} |\n`;
  return s;
}

/* ================= UI: menus, toolbars ================= */
const ICONS = {
  newf: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>',
  codeblock: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m10 9-3 3 3 3M14 9l3 3-3 3"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><path d="M4 5v14M9 7h11M9 12h11M9 17h7"/></svg>',
  ul: '<svg viewBox="0 0 24 24"><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
  ol: '<svg viewBox="0 0 24 24"><path d="M10 6h11M10 12h11M10 18h11M4 4h1v5M3 9h3M3 14.5c.5-.8 2.5-1 2.7.3.2 1.2-2.7 2.2-2.7 4.2h3"/></svg>',
  task: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="6" rx="1"/><path d="m3.5 16.5 2 2 3.5-3.5M13 7h8M13 17h8"/></svg>',
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/></svg>',
  hr: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/><path d="M7 6h10M7 18h10" opacity=".4"/></svg>',
  diagram: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v4a2 2 0 0 0 2 2H14"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};

function setView(v) { settings.view = v; applySettings(); render(); }
function setZoom(z) { settings.zoom = Math.min(200, Math.max(50, Math.round(z / 10) * 10)); applySettings(); }
function showDock(tab) { settings.dock = true; settings.dockTab = tab; applySettings(); }
function setLang(l) { settings.lang = l; applySettings(); }
function setTheme(th) { settings.theme = th; applySettings(); }
function modal(title, html) {
  $('.modal').classList.remove('wide'); $('#modalFoot').hidden = true; settingsOpen = false;
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.add('show');
}
function closeModal() { $('#modal').classList.remove('show'); settingsOpen = false; }
$('#modalClose').onclick = closeModal;
$('#modal').onmousedown = e => { if (e.target.id === 'modal') closeModal(); };
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400); }

const A = {
  newDoc: () => openDoc(null, ''),
  openFile, save: () => save(false), reloadFile, saveAs: () => save(true), exportHtml,
  print: async () => {
    await render();
    setTimeout(() => invoke ? invoke('print_page').catch(e => toast(t('toast.printFail', {e}))) : window.print(), 60);
  },
  closeTab: () => closeTab(active),
  undo: () => { ed.focus(); document.execCommand('undo'); },
  redo: () => { ed.focus(); document.execCommand('redo'); },
  selectAll: () => { ed.focus(); ed.select(); },
  find: openFind, findNext: () => findNext(),
  h1: () => setHeading(1), h2: () => setHeading(2), h3: () => setHeading(3), para: () => setHeading(0),
  heading: () => runEdit({kind: 'heading', level: 0, toggle: false, cycle: true}),
  bold: () => wrap('**', '**', lang === 'de' ? 'fetter Text' : 'bold text'),
  italic: () => wrap('*', '*', lang === 'de' ? 'kursiver Text' : 'italic text'),
  strike: () => wrap('~~', '~~', lang === 'de' ? 'durchgestrichen' : 'strikethrough'),
  code: () => selInfo().sel.includes('\n') ? A.codeblock() : wrap('`', '`', 'code'),
  link: () => {
    const {s, e, sel} = selInfo(), label = lang === 'de' ? 'Linktext' : 'link text';
    if (/^https?:\/\/\S+$/.test(sel)) return replaceRange(s, e, `[${label}](${sel})`, s + 1, s + 1 + label.length);
    const txt = sel || label;
    replaceRange(s, e, `[${txt}](https://)`, s + txt.length + 3, s + txt.length + 11);
  },
  image: () => {
    const {s, e, sel} = selInfo(), txt = sel || (lang === 'de' ? 'Alternativtext' : 'alt text');
    replaceRange(s, e, `![${txt}](https://)`, s + txt.length + 4, s + txt.length + 12);
  },
  ul: () => listCmd('ul'), ol: () => listCmd('ol'), task: () => listCmd('task'), quote: () => listCmd('quote'),
  codeblock: () => { const {sel} = selInfo(); sel ? insertBlock(F + '\n' + sel.replace(/\n$/, '') + '\n' + F) : insertBlock(F + 'js\n// code\n' + F, 6, 7); },
  table: () => {
    const [c, x] = lang === 'de' ? ['Spalte', 'Zelle '] : ['Column', 'Cell  '];
    insertBlock(`| ${c} 1 | ${c} 2 | ${c} 3 |\n|${'-'.repeat(c.length + 4)}|${'-'.repeat(c.length + 4)}|${'-'.repeat(c.length + 4)}|\n` +
      `| ${x.padEnd(c.length + 2)} | ${x.padEnd(c.length + 2)} | ${x.padEnd(c.length + 2)} |`, 2, c.length + 2);
  },
  hr: () => insertBlock('---'),
  diagram: () => {
    const [a, b, c, d, y, n] = lang === 'de' ? ['Start', 'Idee?', 'Umsetzen', 'Nachdenken', 'Ja', 'Nein'] : ['Start', 'Idea?', 'Build it', 'Think more', 'Yes', 'No'];
    insertBlock(`${F}mermaid\nflowchart LR\n  A[${a}] --> B{${b}}\n  B -->|${y}| C[${c}]\n  B -->|${n}| D[${d}]\n  D --> B\n${F}`);
  },
  mathInline: () => wrap('$', '$', 'x^2'),
  mathBlock: () => { const {sel} = selInfo(); sel ? insertBlock('$$\n' + sel + '\n$$') : insertBlock('$$\nE = mc^2\n$$', 3, 8); },
  toc: async () => {
    await render();
    const hs = outlineHeadings();
    if (!hs.length) return toast(t('toast.noHeadings'));
    const min = Math.min(...hs.map(h => +h.tagName[1]));
    return insertBlock(`**${t('doc.contents')}**\n\n` + hs.map(h => '  '.repeat(h.tagName[1] - min) + `- [${h.textContent.replace(/[[\]]/g, '')}](#${h.id})`).join('\n'));
  },
  date: () => insertAtCursor(new Date().toLocaleDateString(lang, {year: 'numeric', month: 'long', day: 'numeric'})),
  viewEdit: () => setView('edit'), viewSplit: () => setView('split'), viewPreview: () => setView('preview'),
  togglePanels: () => { settings.dock = !settings.dock; applySettings(); },
  toggleSync: () => { settings.sync = !settings.sync; applySettings(); },
  toggleWrap: () => { settings.wrap = !settings.wrap; applySettings(); },
  togglePaper: () => { settings.paper = isPaperDark() ? 'light' : 'dark'; applySettings(); },
  zoomIn: () => setZoom(settings.zoom + 10), zoomOut: () => setZoom(settings.zoom - 10), zoomReset: () => setZoom(100),
  settings: () => openSettings(),
  langAuto: () => setLang('auto'), langEn: () => setLang('en'), langDe: () => setLang('de'),
  themeDark: () => setTheme('dark'), themeLight: () => setTheme('light'),
  themeGithub: () => setTheme('github'), themeGithubDark: () => setTheme('github-dark'),
  openGuide: () => {
    const name = t('doc.guideFile'), i = docs.findIndex(d => d.name === name && !d.dirty);
    if (i >= 0) activate(i); else openDoc(name, buildGuide());
    if (settings.view === 'edit') setView('split');
  },
  refMd: () => showDock('md'), refLatex: () => showDock('latex'),
  shortcuts: () => {
    let h = '';
    MENUS.forEach(([m, items]) => {
      const rows = items.filter(it => Array.isArray(it) && it[1]);
      if (rows.length) h += `<h4>${esc(t('menu.' + m))}</h4><table>` +
        rows.map(it => `<tr><td>${esc(t('a.' + it[0]))}</td><td><kbd>${esc(fmtKey(it[1]))}</kbd></td></tr>`).join('') + '</table>';
    });
    h += `<h4>${t('ed.editor')}</h4><table>
      <tr><td>${t('ed.indent')}</td><td><kbd>Tab</kbd> / <kbd>${fmtKey('Shift+Tab')}</kbd></td></tr>
      <tr><td>${t('ed.continue')}</td><td><kbd>Enter</kbd></td></tr>
      <tr><td>${t('a.findNext')}</td><td><kbd>F3</kbd></td></tr>
      <tr><td>${t('ed.zoom')}</td><td><kbd>${fmtKey('Ctrl')}</kbd> + ${t('ed.wheel')}</td></tr></table>`;
    modal(t('a.shortcuts'), h);
  },
  about: async () => {
    const v = invoke ? await window.__TAURI__.app.getVersion().catch(() => '') : '';
    modal(t('a.about'), `${v ? `<p><b>${t('about.version', {v: esc(v)})}</b></p>` : ''}<p>${t('about.p1')}</p>
    <p>${t('about.p2', {libs: '<a href="https://github.com/pulldown-cmark/pulldown-cmark">pulldown-cmark</a> (Rust), <a href="https://katex.org">KaTeX</a>, <a href="https://mermaid.js.org">Mermaid</a>, <a href="https://highlightjs.org">highlight.js</a>, DOMPurify'})}</p>
    <p>${t('about.p3')}</p>`);
  }
};

// Menu items: [action, shortcut, checked(), nativeKey]; strings are separators, '#key' is a section label.
const MENUS = [
  ['file', [['newDoc', 'Alt+N'], ['openFile', 'Ctrl+O'], '-', ['save', 'Ctrl+S'], ['saveAs', 'Ctrl+Shift+S'], ['reloadFile', 'F5'], '-',
    ['exportHtml', 'Ctrl+E'], ['print', 'Ctrl+P'], '-', ['closeTab', 'Alt+W']]],
  ['edit', [['undo', 'Ctrl+Z', null, true], ['redo', 'Ctrl+Y', null, true], '-', ['find', 'Ctrl+F'], ['findNext', 'F3'], '-',
    ['selectAll', 'Ctrl+A', null, true]]],
  ['insert', [['h1', 'Ctrl+Shift+1'], ['h2', 'Ctrl+Shift+2'], ['h3', 'Ctrl+Shift+3'], ['para', 'Ctrl+Shift+0'], '-',
    ['bold', 'Ctrl+B'], ['italic', 'Ctrl+I'], ['strike', 'Ctrl+Shift+X'], ['code', 'Ctrl+`'], ['link', 'Ctrl+K'], ['image', 'Ctrl+Shift+G'], '-',
    ['ul', 'Ctrl+Shift+8'], ['ol', 'Ctrl+Shift+7'], ['task', 'Ctrl+Shift+9'], ['quote', 'Ctrl+Shift+.'],
    ['codeblock', 'Ctrl+Shift+K'], ['table', 'Ctrl+Shift+L'], ['hr', 'Ctrl+Shift+-'], ['diagram', 'Ctrl+Shift+D'], '-',
    ['mathInline', 'Ctrl+M'], ['mathBlock', 'Ctrl+Shift+M'], '-', ['toc'], ['date']]],
  ['view', [['viewEdit', 'Alt+1', () => settings.view === 'edit'], ['viewSplit', 'Alt+2', () => settings.view === 'split'],
    ['viewPreview', 'Alt+3', () => settings.view === 'preview'], '-',
    ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleSync', null, () => settings.sync],
    ['toggleWrap', null, () => settings.wrap], ['togglePaper', null, isPaperDark], '-',
    ['zoomIn'], ['zoomOut'], ['zoomReset']]],
  ['settings', [['settings', 'Ctrl+,'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark']]],
  ['help', [['openGuide', 'F1'], ['refMd'], ['refLatex'], ['shortcuts'], '-', ['about']]]
];
const KEYMAP = {};
MENUS.forEach(([, items]) => items.forEach(it => { if (Array.isArray(it) && it[1] && !it[3]) KEYMAP[it[1]] = it[0]; }));

let menuOpen = null;
function openMenu(m, items) {
  closeMenus();
  const dd = m.querySelector('.dropdown'); dd.innerHTML = '';
  items.forEach(it => {
    if (it === '-') return dd.append(document.createElement('hr'));
    if (typeof it === 'string') { const l = document.createElement('div'); l.className = 'dd-label'; l.textContent = t(it.slice(1)); return dd.append(l); }
    const [act, key, check] = it, b = document.createElement('button');
    b.innerHTML = `<span class="chk">${check && check() ? '&#10003;' : ''}</span><span>${esc(t('a.' + act))}</span><kbd>${esc(key ? fmtKey(key) : '')}</kbd>`;
    b.disabled = !allowed(act);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { closeMenus(); run(act); };
    dd.append(b);
  });
  m.classList.add('open'); menuOpen = m;
}
function closeMenus() { $$('.menu.open').forEach(x => x.classList.remove('open')); menuOpen = null; }
function buildMenubar() {
  const nav = $('#menus'); nav.innerHTML = ''; menuOpen = null;
  MENUS.forEach(([name, items]) => {
    const m = document.createElement('div'), b = document.createElement('button'), dd = document.createElement('div');
    m.className = 'menu'; dd.className = 'dropdown'; b.textContent = t('menu.' + name);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => menuOpen === m ? closeMenus() : openMenu(m, items);
    b.onmouseenter = () => { if (menuOpen && menuOpen !== m) openMenu(m, items); };
    m.append(b, dd); nav.append(m);
  });
}
document.addEventListener('mousedown', e => { if (menuOpen && !e.target.closest('.menu')) closeMenus(); });

const keyOf = act => { for (const [, items] of MENUS) for (const it of items) if (Array.isArray(it) && it[0] === act && it[1]) return it[1]; return ''; };
const tip = act => t('a.' + act) + (keyOf(act) ? ` (${fmtKey(keyOf(act))})` : '');
function makeBtn(act, html, title) {
  const b = document.createElement('button');
  b.className = 'ibtn'; b.innerHTML = html; b.title = title || tip(act); b.dataset.act = act;
  return b;
}
const RAIL = [
  ['heading', '<b class="g">H</b>'], '-',
  ['bold', '<b class="g" style="font-weight:800">B</b>'], ['italic', '<i class="g serif" style="font-size:17px">I</i>'],
  ['strike', '<s class="g">S</s>'], ['code', ICONS.code], '-',
  ['link', ICONS.link], ['image', ICONS.image], '-',
  ['ul', ICONS.ul], ['ol', ICONS.ol], ['task', ICONS.task], ['quote', ICONS.quote], '-',
  ['codeblock', ICONS.codeblock], ['table', ICONS.table], ['hr', ICONS.hr], ['diagram', ICONS.diagram], '-',
  ['mathInline', '<span class="g serif"><i>x</i>²</span>'], ['mathBlock', '<span class="g serif" style="font-size:17px">&sum;</span>']
];
function buildToolbars() {
  const fill = (id, list) => { const box = $(id); box.innerHTML = ''; list.forEach(([a, i]) => box.append(makeBtn(a, i))); };
  fill('#fileBtns', [['newDoc', ICONS.newf], ['openFile', ICONS.open], ['save', ICONS.save], ['undo', ICONS.undo], ['redo', ICONS.redo], ['find', ICONS.search]]);
  fill('#viewBtns', [['togglePaper', ICONS.sun], ['print', ICONS.print], ['togglePanels', ICONS.panel], ['settings', ICONS.gear], ['openGuide', ICONS.help]]);
  const tools = $('#tools'); tools.innerHTML = '';
  RAIL.forEach(r => {
    if (r === '-') { const s = document.createElement('div'); s.className = 'sep'; return tools.append(s); }
    tools.append(makeBtn(r[0], r[1]));
  });
  $('#viewSeg').innerHTML = [['viewEdit', 'ui.editor'], ['viewSplit', 'ui.split'], ['viewPreview', 'ui.preview']]
    .map(([a, l]) => `<button data-act="${a}" title="${esc(tip(a))}">${esc(t(l))}</button>`).join('');
  $('#styleSel').innerHTML = [0, 1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n ? t('a.h1').replace('1', n) : t('a.para')}</option>`).join('');
}
document.addEventListener('mousedown', e => { if (e.target.closest('.ibtn,.cta,#viewSeg button')) e.preventDefault(); });
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) run(b.dataset.act); });

$('#styleSel').onchange = e => setHeading(+e.target.value, false);
$$('#dockTabs button').forEach(b => b.onclick = () => showDock(b.dataset.tab));
$('#zIn').onclick = A.zoomIn; $('#zOut').onclick = A.zoomOut; $('#zVal').onclick = A.zoomReset;
canvas.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(settings.zoom + (e.deltaY < 0 ? 10 : -10)); } }, {passive: false});
paper.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]'); if (!a) return;
  e.preventDefault();
  const target = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
  if (target) scrollPreviewTo(target);
});

/* ================= Settings dialog ================= */
let settingsOpen = false, prefsSection = 'general';
function openSettings(section) {
  if (section) prefsSection = section;
  $('.modal').classList.add('wide'); $('#modalFoot').hidden = false;
  settingsOpen = true; renderSettings();
  $('#modal').classList.add('show');
}
function renderSettings() {
  const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const seg = (name, items, cur) => `<div class="seg small" data-seg="${name}">` +
    items.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'active' : ''}">${esc(l)}</button>`).join('') + '</div>';
  const sw = (name, label) => `<label class="switch"><input type="checkbox" data-sw="${name}"${settings[name] ? ' checked' : ''}><span></span>${esc(label)}</label>`;
  const range = (name, label, min, max, step, unit) => `<h3>${esc(label)} <span class="val">${settings[name]}${unit}</span></h3>
    <input type="range" data-range="${name}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${settings[name]}">`;
  const mock = th => `<div class="tc-mock" data-theme="${th}"><div class="tc-bar"><i></i><i></i><i></i><b></b></div>
    <div class="tc-body"><div class="tc-rail"></div><div class="tc-ed"><i></i><i style="width:70%"></i><i style="width:85%"></i><i style="width:50%"></i><i style="width:75%"></i></div>
    <div class="tc-pv"><div class="tc-paper"><i></i><i></i><i style="width:80%"></i><i style="width:60%"></i><i style="width:90%"></i></div></div><div class="tc-dock"></div></div></div>`;
  const body = {
    general: `<h3>${t('set.language')}</h3><p class="hint">${t('set.languageHint')}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${t('set.layout')}</h3>${sw('dock', t('set.panels'))}`,
    appearance: `<h3>${t('set.theme')}</h3><div class="theme-grid">` + THEMES.map(th =>
        `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
         <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') + `</div>
      <h3>${t('set.paper')}</h3><p class="hint">${t('set.paperHint')}</p>
      ${seg('paper', [['auto', t('set.paperAuto')], ['light', t('set.light')], ['dark', t('set.dark')]], settings.paper)}`,
    editor: `${range('edFont', t('set.edFont'), 11, 22, 1, ' px')}<h3>${t('set.behavior')}</h3>${sw('wrap', t('set.wrap'))}${sw('sync', t('set.sync'))}`,
    preview: `<h3>${t('set.font')}</h3><select class="wide-sel" data-sel="font">${opt('sans', t('set.sans'), settings.font)}${opt('serif', t('set.serif'), settings.font)}</select>
      ${range('pagew', t('set.pageWidth'), 560, 1240, 20, ' px')}${range('zoom', t('set.zoom'), 50, 200, 10, '%')}`
  };
  const sections = ['general', 'appearance', 'editor', 'preview'];
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${sections.map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav>
    <section>${body[prefsSection]}</section></div>`;
  $('#modalFoot').innerHTML = `<button class="btn-sm" data-pref="reset">${esc(t('set.reset'))}</button><span class="flex"></span>
    <button class="btn-sm primary" data-pref="done">${esc(t('set.done'))}</button>`;
}
$('#modal').addEventListener('click', e => {
  if (!settingsOpen) return;
  const el = e.target.closest('[data-sec],[data-theme-pick],[data-seg] button,[data-pref]');
  if (!el) return;
  if (el.dataset.sec) prefsSection = el.dataset.sec;
  else if (el.dataset.themePick) settings.theme = el.dataset.themePick;
  else if (el.dataset.v) settings[el.parentElement.dataset.seg] = el.dataset.v;
  else if (el.dataset.pref === 'done') return closeModal();
  else if (el.dataset.pref === 'reset') { settings = {...DEF}; toast(t('set.resetDone')); }
  applySettings(); renderSettings();
});
$('#modal').addEventListener('change', e => {
  const d = e.target.dataset;
  if (d.sel) { settings[d.sel] = e.target.value; applySettings(); renderSettings(); }
  if (d.sw) { settings[d.sw] = e.target.checked; applySettings(); }
});
$('#modal').addEventListener('input', e => {
  const d = e.target.dataset; if (!d.range) return;
  settings[d.range] = +e.target.value;
  e.target.previousElementSibling.querySelector('.val').textContent = e.target.value + d.unit;
  applySettings();
});

/* ================= Apply language & settings ================= */
function applyLanguage() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  $$('[data-i18n-ph]').forEach(el => el.placeholder = t(el.dataset.i18nPh));
  $$('[data-i18n-title]').forEach(el => el.title = t(el.dataset.i18nTitle));
  $('#splitter').title = t('ui.resize');
  buildMenubar(); buildToolbars();
  cardsBuilt = false;
  if (booted) { renderTabs(); updateTitle(); render(); updateCursor(); renderRecent(); syncDisabled(); }
}
let lastMermaidTheme = null;
function applySettings() {
  invalidateSync();
  if (!THEMES.includes(settings.theme)) settings.theme = 'dark';
  const nl = effectiveLang();
  if (nl !== lang) { lang = nl; applyLanguage(); }
  document.documentElement.dataset.theme = settings.theme;
  workspace.className = 'workspace mode-' + settings.view;
  $$('#viewSeg button').forEach(b => b.classList.toggle('active', b.dataset.act === 'view' + settings.view[0].toUpperCase() + settings.view.slice(1)));
  edPane.style.flexBasis = settings.view === 'split' ? settings.split + '%' : '';
  const dark = isPaperDark();
  paper.className = 'paper ' + paperClass();
  $$('.card .out').forEach(o => o.className = 'out ' + paperClass());
  paper.style.setProperty('--paperw', settings.pagew + 'px');
  paper.style.zoom = settings.zoom / 100;
  canvas.classList.toggle('darkpaper', dark && settings.theme !== 'github-dark');
  // Diagrams are drawn in the paper's colors, so a paper change redraws them.
  if (booted && mermaidTheme() !== lastMermaidTheme) {
    if (paper.querySelector('[data-diagram]')) render();
    if ($('#dgCards').querySelector('.diagram')) { cardsBuilt = false; }
  }
  lastMermaidTheme = mermaidTheme();
  $('#hljsLight').disabled = dark; $('#hljsDark').disabled = !dark;
  $('[data-act="togglePaper"]').innerHTML = dark ? ICONS.moon : ICONS.sun;
  ed.style.fontSize = settings.edFont + 'px';
  ed.wrap = settings.wrap ? 'soft' : 'off';
  ed.style.whiteSpace = settings.wrap ? 'pre-wrap' : 'pre';
  $('#dock').classList.toggle('hidden', !settings.dock);
  $$('#dockTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === settings.dockTab));
  $$('.dpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === settings.dockTab));
  if (settings.dock && (settings.dockTab === 'md' || settings.dockTab === 'latex')) buildCards();
  $('#zVal').textContent = settings.zoom + '%';
  saveSession();
}

/* Splitter */
$('#splitter').addEventListener('pointerdown', e => {
  const sp = e.currentTarget, rect = workspace.getBoundingClientRect();
  sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
  const move = ev => { settings.split = Math.min(85, Math.max(15, (ev.clientX - rect.left) / rect.width * 100)); edPane.style.flexBasis = settings.split + '%'; };
  sp.addEventListener('pointermove', move);
  sp.addEventListener('pointerup', () => { sp.removeEventListener('pointermove', move); sp.classList.remove('drag'); saveSession(); }, {once: true});
});

/* Synchronized scrolling: source lines are matched to the preview blocks they produced (data-line),
   and positions between two such anchors are interpolated, so headings, diagrams and math stay aligned. */
let syncLock = null, syncT;
function invalidateSync() { editorLineTops.cache = null; }
/* Pixel top of every source line in the editor (measured with a hidden mirror, wrapping included). */
function editorLineTops() {
  if (editorLineTops.cache) return editorLineTops.cache;
  const cs = getComputedStyle(ed), mirror = document.createElement('div');
  Object.assign(mirror.style, {position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', boxSizing: 'border-box',
    width: ed.clientWidth + 'px', padding: cs.padding, fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing, tabSize: cs.tabSize, whiteSpace: settings.wrap ? 'pre-wrap' : 'pre', overflowWrap: 'break-word'});
  const frag = document.createDocumentFragment();
  for (const l of ed.value.split('\n')) { const d = document.createElement('div'); d.textContent = l || '​'; frag.append(d); }
  mirror.append(frag); document.body.append(mirror);
  const tops = [...mirror.children].map(d => d.offsetTop);
  mirror.remove();
  return editorLineTops.cache = tops;
}
/* Matching [editorY, previewY] pairs, increasing on both sides, from the top to the end of both panes. */
function syncPoints() {
  const tops = editorLineTops(), base = canvas.getBoundingClientRect().top - canvas.scrollTop;
  const edMax = Math.max(0, ed.scrollHeight - ed.clientHeight), pvMax = Math.max(0, canvas.scrollHeight - canvas.clientHeight);
  const pts = [[0, 0]];
  for (const el of paper.children) {
    const ln = el.dataset.line;
    if (ln == null || tops[ln] == null) continue;
    const e = tops[ln], p = el.getBoundingClientRect().top - base - 16, last = pts[pts.length - 1];
    if (e > last[0] && p > last[1] && e < edMax && p < pvMax) pts.push([e, p]);
  }
  pts.push([edMax, pvMax]);
  return pts;
}
function mapScroll(y, pts, from, to) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (y <= b[from]) return a[to] + (b[to] - a[to]) * (b[from] === a[from] ? 0 : (y - a[from]) / (b[from] - a[from]));
  }
  return pts[pts.length - 1][to];
}
function syncFrom(src, dst, tag) {
  if (!settings.sync || settings.view !== 'split' || (syncLock && syncLock !== tag)) return;
  syncLock = tag;
  const fromEd = src === ed;
  dst.scrollTop = mapScroll(src.scrollTop, syncPoints(), fromEd ? 0 : 1, fromEd ? 1 : 0);
  clearTimeout(syncT); syncT = setTimeout(() => syncLock = null, 100);
}
ed.addEventListener('scroll', () => syncFrom(ed, canvas, 'e'));
canvas.addEventListener('scroll', () => syncFrom(canvas, ed, 'p'));
ed.addEventListener('input', invalidateSync);
new ResizeObserver(invalidateSync).observe(ed);

/* Global shortcuts */
function comboOf(e) {
  let k = e.key;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Period') k = '.';
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Backquote') k = '`';
  else if (e.code === 'Backslash' || e.code === 'IntlBackslash') k = '\\';
  else if (k.length === 1) k = k.toUpperCase();
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('#modal').classList.contains('show')) closeModal();
    else if (menuOpen) closeMenus();
    else if ($('#findbar').classList.contains('show')) closeFind();
    return;
  }
  if (e.ctrlKey && e.altKey) return; // AltGr on international keyboards types characters
  const act = KEYMAP[comboOf(e)];
  if (act) { e.preventDefault(); e.stopPropagation(); run(act); }
}, true);

/* ================= Native right-click menus (see native.js) ================= */
if (window.Native) {
  const item = act => ({id: act, label: t('a.' + act), accel: keyOf(act) || null, enabled: allowed(act)});
  let ctxTab = -1, ctxDiagram = null;
  Native.setProvider(e => {
    const tab = e.target.closest('.tab');
    if (tab) {
      ctxTab = +tab.dataset.i;
      return [{id: 'tab:close', label: t('a.closeTab'), accel: 'Alt+W'}, {id: 'tab:others', label: t('ctx.closeOthers'), enabled: docs.length > 1}];
    }
    if (e.target === ed && cur()) {
      return [...Native.fieldItems(ed), null, item('bold'), item('italic'), item('strike'), item('code'), item('link'), null,
        item('table'), item('codeblock'), item('mathInline'), item('mathBlock'), item('diagram')];
    }
    const dg = e.target.closest('#paper .diagram');
    if (dg && dg.querySelector('svg')) {
      ctxDiagram = dg;
      return [Native.copyTextItem(), null, {id: 'dg:svg', label: t('dg.saveSvg')}, {id: 'dg:png', label: t('dg.savePng')}];
    }
    if (e.target.closest('#paper') && cur()) return [Native.copyTextItem(), null, item('exportHtml'), item('print')];
    return null;
  });
  Native.setHandler(async id => {
    if (id === 'tab:close') return closeTab(ctxTab);
    if (id === 'tab:others') { const keep = docs[ctxTab]; for (const d of [...docs]) if (d !== keep) await closeTab(docs.indexOf(d)); return; }
    if (id.startsWith('dg:')) { const b = ctxDiagram && ctxDiagram.querySelector(`[data-dg="${id.slice(3)}"]`); if (b) b.click(); return; }
    run(id);
  });
}

window.__md = {A, ed, render, findNext, replaceAll, countMatches};  // test hook (like Dt's __dt)

/* ================= Boot ================= */
(async function boot() {
  if (invoke) I18N = await invoke('texts');
  if (!LIBS_OK) document.body.insertAdjacentHTML('beforeend', `<div class="libfail">${t('libfail')}</div>`);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
  if (saved && saved.settings) settings = {...DEF, ...saved.settings};
  lang = effectiveLang();
  applyLanguage();
  recent = (saved && saved.recent) || [];
  if (saved && Array.isArray(saved.docs)) {
    // A saved session with no documents opens on the start screen.
    untitledN = saved.untitledN || 1;
    docs = saved.docs.map(d => ({...blankDoc(d.name, d.content, invoke ? d.path : null), dirty: !!d.dirty, sel: d.sel || [0, 0]}));
    active = Math.min(saved.active || 0, docs.length - 1);
  } else {
    docs = [blankDoc(lang === 'de' ? 'Willkommen.md' : 'Welcome.md', $('#welcome-' + lang).textContent.trim() + '\n')];
  }
  booted = true;
  applySettings();
  loadActive();
  if (cur()) ed.setSelectionRange(cur().sel[0], cur().sel[1]);
  if (invoke) {
    // Files passed on the command line / via "Open with", and (macOS) files opened while running.
    invoke('initial_files').then(openNative).catch(e => toast(t('toast.openFail', {e})));
    window.__TAURI__.event.listen('open-docs', e => openNative(e.payload));
  }
})();
