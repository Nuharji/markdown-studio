/* Shared by the Studio apps: makes the web view behave like a desktop app.
   - Right-click opens a native (OS) context menu built in Rust, never the browser's menu.
   - Copy / cut / paste from those menus go through the system clipboard in Rust.
   - Browser shortcuts (reload, back, print preview, caret browsing, ...) are switched off.
   An app adds its own menu entries with Native.setProvider(fn) and handles them with Native.setHandler(fn). */
(() => {
  'use strict';
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
  const LABELS = {
    en: {undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', copyText: 'Copy'},
    de: {undo: 'Rückgängig', redo: 'Wiederholen', cut: 'Ausschneiden', copy: 'Kopieren', paste: 'Einfügen', selectAll: 'Alles auswählen', copyText: 'Kopieren'}
  };
  const L = k => (LABELS[document.documentElement.lang] || LABELS.en)[k];
  let provider = null, handler = null, field = null;

  const isField = el => !!el && (el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && /^(text|search|url|email|number|password|tel)?$/i.test(el.getAttribute('type') || '')));
  /* Standard editing entries for a text field (null = separator). */
  function fieldItems(el) {
    const ro = el.readOnly || el.disabled, sel = el.selectionEnd > el.selectionStart && el.type !== 'password';
    return [
      {id: 'native:undo', label: L('undo'), accel: 'Ctrl+Z', enabled: !ro}, {id: 'native:redo', label: L('redo'), accel: 'Ctrl+Y', enabled: !ro}, null,
      {id: 'native:cut', label: L('cut'), accel: 'Ctrl+X', enabled: sel && !ro}, {id: 'native:copy', label: L('copy'), accel: 'Ctrl+C', enabled: sel},
      {id: 'native:paste', label: L('paste'), accel: 'Ctrl+V', enabled: !ro}, null,
      {id: 'native:selectAll', label: L('selectAll'), accel: 'Ctrl+A'}
    ];
  }
  /* "Copy" for text selected in a rendered page (preview, PDF text layer). */
  const textSelection = () => String(window.getSelection ? window.getSelection() : '').trim();
  const copyTextItem = () => ({id: 'native:copyText', label: L('copyText'), accel: 'Ctrl+C', enabled: !!textSelection()});

  function show(items) {
    // Drop leading, trailing and doubled separators.
    const clean = [];
    for (const it of items) if (it || (clean.length && clean[clean.length - 1])) clean.push(it);
    while (clean.length && !clean[clean.length - 1]) clean.pop();
    if (!clean.length || !invoke) return;
    invoke('context_menu', {items: clean.map(i => i ? {id: i.id, label: i.label, enabled: i.enabled !== false, checked: i.checked, accel: i.accel || null} : {})})
      .catch(() => {});
  }
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    const target = e.target.closest ? e.target.closest('input,textarea') : null;
    field = isField(target) ? target : null;
    const own = provider ? provider(e) : null;
    if (own) return show(own);
    if (field) return show(fieldItems(field));
  }, true);

  function insert(el, text) {
    el.focus();
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (!ok) { el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); el.dispatchEvent(new Event('input', {bubbles: true})); }
  }
  async function nativeAction(a) {
    if (a === 'copyText') return invoke('clipboard_write', {text: textSelection()});
    const el = field; if (!el) return;
    el.focus();
    if (a === 'undo' || a === 'redo') return document.execCommand(a);
    if (a === 'selectAll') return el.select();
    const text = el.value.slice(el.selectionStart, el.selectionEnd);
    if (a === 'copy' || a === 'cut') { await invoke('clipboard_write', {text}); if (a === 'cut') insert(el, ''); return; }
    if (a === 'paste') insert(el, await invoke('clipboard_read'));
  }
  if (invoke) {
    // Keep the real window title (taskbar, Alt+Tab) in sync with the document title the app sets.
    const win = window.__TAURI__.window.getCurrentWindow(), titleEl = document.querySelector('title');
    let lastTitle = '';
    const syncTitle = () => { const t = document.title; if (t && t !== lastTitle) { lastTitle = t; win.setTitle(t).catch(() => {}); } };
    if (titleEl) new MutationObserver(syncTitle).observe(titleEl, {childList: true, characterData: true, subtree: true});
    syncTitle();
    window.__TAURI__.event.listen('context-menu', ev => {
      const id = String(ev.payload);
      if (id.startsWith('native:')) nativeAction(id.slice(7));
      else if (handler) handler(id);
    });
  }

  /* Browser shortcuts that make no sense in a desktop app. The apps' own shortcuts still run
     (they listen too); this only stops the web view's built-in behavior. */
  const BLOCK_KEYS = new Set(['F3', 'F5', 'F7', 'F12', 'BrowserBack', 'BrowserForward', 'BrowserRefresh', 'BrowserHome', 'BrowserSearch', 'BrowserFavorites']);
  const BLOCK_CTRL = new Set(['d', 'e', 'f', 'g', 'h', 'j', 'l', 'n', 'o', 'p', 'r', 's', 't', 'u', 'w']);
  window.addEventListener('keydown', e => {
    const k = e.key || '', ctrl = e.ctrlKey || e.metaKey;
    if (BLOCK_KEYS.has(k) || (e.altKey && !ctrl && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home')) ||
        (ctrl && !e.altKey && BLOCK_CTRL.has(k.toLowerCase())) || (ctrl && e.shiftKey && /^[ijck]$/i.test(k))) e.preventDefault();
  }, true);
  // Images and links in documents shouldn't be draggable out of the window like in a browser.
  document.addEventListener('dragstart', e => { if (e.target && (e.target.tagName === 'IMG' || e.target.tagName === 'A')) e.preventDefault(); }, true);
  // Middle-click on links would open a browser window.
  document.addEventListener('auxclick', e => { if (e.button === 1 && e.target.closest && e.target.closest('a')) e.preventDefault(); }, true);

  window.Native = {
    available: !!invoke,
    setProvider(fn) { provider = fn; },
    setHandler(fn) { handler = fn; },
    fieldItems, copyTextItem, isField,
    clipboardRead: () => invoke ? invoke('clipboard_read') : navigator.clipboard.readText(),
    clipboardWrite: text => invoke ? invoke('clipboard_write', {text}) : navigator.clipboard.writeText(text)
  };
})();
