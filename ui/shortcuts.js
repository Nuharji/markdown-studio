/* Customizable shortcuts (the same file in every Studio app). Menu entries are
   [action, key, checked(), fixed, extraKeys]; the user's keys are settings.keys = {action: "Ctrl+K" | ""} ("" = none).
   Shortcuts.apply(MENUS, keys) puts them into the menu entries (defaults are remembered);
   Shortcuts.editor(box, opts) draws the list in Settings, where a key is changed by pressing it. */
(() => {
  'use strict';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  let active = null;   // the editor that is recording a key (the apps' own shortcuts pause meanwhile)
  const entries = MENUS => MENUS.flatMap(([menu, items]) => items.filter(Array.isArray).map(it => ({menu, it})));

  /* Puts the user's keys into the menu entries; entries handled by the system (fixed) keep theirs. */
  function apply(MENUS, keys = {}) {
    for (const {it} of entries(MENUS)) {
      if (it.length < 7) { it[5] = it[1] || ''; it[6] = it[4] || []; while (it.length < 7) it.push(undefined); }
      const own = !it[3] && Object.prototype.hasOwnProperty.call(keys, it[0]);
      it[1] = own ? keys[it[0]] : it[5];
      it[4] = own ? [] : it[6];
    }
  }

  /* A key worth assigning: with Ctrl or Alt, or a function key (letters alone would get in the way of typing). */
  const usable = combo => /(^|\+)(Ctrl|Alt)\+/.test(combo) || /(^|\+)F\d{1,2}$/.test(combo);

  /* opts: {MENUS, keys, t, fmtKey, comboOf, label(action), onChange(keys)} */
  function editor(box, o) {
    let recording = null, note = '', q = '';
    const me = {};
    const list = () => entries(o.MENUS).filter(({it}) => !(it[3] && !it[1]));
    const owner = (combo, except) => list().find(({it}) => it[0] !== except && (it[1] === combo || (it[4] || []).includes(combo)));
    function draw() {
      active = recording ? me : active === me ? null : active;
      const rows = list().filter(({it}) => !q || o.label(it[0]).toLowerCase().includes(q) || (it[1] || '').toLowerCase().includes(q));
      let h = `<p class="hint">${esc(o.t('keys.hint'))}</p>
        <div class="keys-tools"><input class="field-in" id="keysSearch" placeholder="${esc(o.t('keys.search'))}" value="${esc(q)}" spellcheck="false">
        <button class="btn-sm" data-keys="resetAll">${esc(o.t('keys.resetAll'))}</button></div>`;
      if (note) h += `<p class="keys-note">${esc(note)}</p>`;
      let menu = null;
      h += '<table class="keys-table">';
      for (const {menu: m, it} of rows) {
        if (m !== menu) { menu = m; h += `<tr><th colspan="3">${esc(o.t('menu.' + m))}</th></tr>`; }
        const rec = recording === it[0], changed = (it[1] || '') !== (it[5] || '');
        h += `<tr class="${changed ? 'changed' : ''}"><td>${esc(o.label(it[0]))}</td>
          <td><button class="key-btn${rec ? ' rec' : ''}" data-rec="${esc(it[0])}"${it[3] ? ' disabled' : ''}>${rec ? esc(o.t('keys.press')) : it[1] ? `<kbd>${esc(o.fmtKey(it[1]))}</kbd>` : '<span class="dim">—</span>'}</button></td>
          <td>${changed ? `<button class="btn-sm" data-reset="${esc(it[0])}" title="${esc(o.t('keys.reset'))}">↺</button>` : ''}</td></tr>`;
      }
      box.innerHTML = h + '</table>';
      const s = box.querySelector('#keysSearch');
      s.oninput = () => { q = s.value.trim().toLowerCase(); const pos = s.selectionStart; draw(); const n = box.querySelector('#keysSearch'); n.focus(); n.setSelectionRange(pos, pos); };
    }
    const save = keys => { o.keys = keys; o.onChange(keys); draw(); };
    box.onclick = e => {
      const b = e.target.closest('[data-rec],[data-reset],[data-keys]'); if (!b) return;
      note = '';
      if (b.dataset.rec) { recording = recording === b.dataset.rec ? null : b.dataset.rec; draw(); }
      else if (b.dataset.reset) { const k = {...o.keys}; delete k[b.dataset.reset]; recording = null; save(k); }
      else if (b.dataset.keys === 'resetAll') { recording = null; save({}); }
    };
    // While recording, the next key press is the new shortcut (before the app's own shortcuts see it).
    const onKey = e => {
      if (!box.isConnected) { if (active === me) active = null; return; }
      if (!recording) return;
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const act = recording;
      if (e.key === 'Escape') { recording = null; return draw(); }
      if (e.key === 'Backspace' || e.key === 'Delete') { recording = null; return save({...o.keys, [act]: ''}); }
      const combo = o.comboOf(e);
      if (!usable(combo)) { note = o.t('keys.needMod'); return draw(); }
      recording = null;
      const other = owner(combo, act), k = {...o.keys, [act]: combo};
      if (other && other.it[3]) { note = o.t('keys.fixed', {k: o.fmtKey(combo), a: o.label(other.it[0])}); return draw(); }
      if (other) { k[other.it[0]] = ''; note = o.t('keys.taken', {k: o.fmtKey(combo), a: o.label(other.it[0])}); }
      save(k);
    };
    window.addEventListener('keydown', onKey, true);
    // The listener goes when the settings page is replaced.
    new MutationObserver((_, obs) => { if (!box.isConnected) { window.removeEventListener('keydown', onKey, true); obs.disconnect(); if (active === me) active = null; } })
      .observe(document.body, {childList: true, subtree: true});
    draw();
  }

  const css = document.createElement('style');
  css.textContent = `.keys-tools{display:flex;gap:8px;margin:6px 0 10px}.keys-tools .field-in{flex:1}
    .keys-note{color:var(--accent);margin:0 0 8px}
    .keys-table{width:100%;border-collapse:collapse}.keys-table th{text-align:left;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:12px 0 4px}
    .keys-table td{padding:3px 4px;border-bottom:1px solid var(--border)}.keys-table td:nth-child(2){width:190px;text-align:right}.keys-table td:last-child{width:34px;text-align:right}
    .keys-table tr.changed td:first-child{font-weight:600}
    .key-btn{min-width:150px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;cursor:pointer;text-align:center}
    .key-btn:hover:not(:disabled){border-color:var(--accent)}.key-btn:disabled{cursor:default;opacity:.6}
    .key-btn.rec{border-color:var(--accent);color:var(--accent);font-style:italic}`;
  document.head.append(css);

  window.Shortcuts = {apply, editor, usable, get recording() { return !!active; }};
})();
