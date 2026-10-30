/* Settings shared by all Studio apps (the same file in every app; Rust: shared.rs): theme, language and the work
   folder in <config dir>/Studio/shared.json. Studio Hub edits them; every app takes them over at start and whenever
   its window gets the focus, and passes its own theme / language changes on — so all apps look and speak alike.
   Shared.init({apply(s)}) → applies the shared values (s.theme, s.lang); Shared.push({theme, lang}) after a change.
   The layout (Adobe, Eigenes, Modern; layouts.css) is shared as well, but this file applies it itself:
   Shared.layoutPicker() gives the settings section, Shared.setLayout(name) changes it. */
(() => {
  'use strict';
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
  let known = {}, hooks = null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* A layout is a set of options; Adobe is the plain set, Eigenes is whatever the user chose. */
  const OPTS = {dock: ['right', 'left'], tools: ['left', 'right'], density: ['compact', 'normal', 'comfortable'],
    corners: ['theme', 'sharp', 'medium', 'round'], float: ['off', 'on'], status: ['on', 'off']};
  const BASE = {dock: 'right', tools: 'left', density: 'normal', corners: 'theme', float: 'off', status: 'on'};
  const LAYOUTS = {adobe: BASE, custom: {...BASE, dock: 'left', density: 'compact', corners: 'medium'},
    modern: {...BASE, density: 'comfortable', corners: 'round', float: 'on'}};
  const LABELS = {
    en: {heading: 'Layout', hint: 'How the window is arranged. Works with every theme and applies to all Studio apps.', adobe: 'Adobe', custom: 'Custom', modern: 'Modern',
      dock: 'Panels', tools: 'Tool rail', density: 'Density', corners: 'Corners', float: 'Floating panels', status: 'Status bar',
      right: 'Right', left: 'Left', compact: 'Compact', normal: 'Normal', comfortable: 'Roomy', theme: 'Like the theme', sharp: 'Sharp', medium: 'Medium', round: 'Round', on: 'On', off: 'Off'},
    de: {heading: 'Layout', hint: 'Wie das Fenster aufgebaut ist. Passt zu jedem Design und gilt für alle Studio-Apps.', adobe: 'Adobe', custom: 'Eigenes', modern: 'Modern',
      dock: 'Seitenleiste', tools: 'Werkzeugleiste', density: 'Dichte', corners: 'Ecken', float: 'Schwebende Flächen', status: 'Statusleiste',
      right: 'Rechts', left: 'Links', compact: 'Kompakt', normal: 'Normal', comfortable: 'Großzügig', theme: 'Wie das Design', sharp: 'Eckig', medium: 'Mittel', round: 'Rund', on: 'An', off: 'Aus'}
  };
  const L = k => (LABELS[(document.documentElement.lang || '').slice(0, 2)] || LABELS.en)[k];
  const CACHE = 'studio.layout';
  let layoutKey = '';
  const layoutName = s => LAYOUTS[s.layout] ? s.layout : 'adobe';
  const layoutOptions = (name, s) => {
    const o = {...LAYOUTS[name], ...(name === 'custom' ? s.layoutCustom : null)};
    for (const k of Object.keys(OPTS)) if (!OPTS[k].includes(o[k])) o[k] = LAYOUTS[name][k];
    return o;
  };
  function applyLayout(s) {
    const name = layoutName(s), o = layoutOptions(name, s), key = name + JSON.stringify(o);
    if (key === layoutKey) return;
    const first = !layoutKey, root = document.documentElement;
    layoutKey = key;
    root.dataset.layout = name;
    for (const k of Object.keys(OPTS)) {
      if (o[k] === BASE[k]) root.removeAttribute('data-l-' + k); else root.setAttribute('data-l-' + k, o[k]);
    }
    root.toggleAttribute('data-l-flex', o.dock !== BASE.dock || o.tools !== BASE.tools || o.float !== BASE.float);
    try { localStorage.setItem(CACHE, JSON.stringify({layout: name, layoutCustom: s.layoutCustom})); } catch (e) {}
    if (first) return;
    // The bars and the content area changed size without a window resize.
    if (window.AutoHide && AutoHide.on) { AutoHide.set(false); AutoHide.set(true); }
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  function layoutMock(name) {
    const o = layoutOptions(name, known);
    const cls = [o.tools === 'right' && 'tr', o.dock === 'left' && 'dl', o.float === 'on' && 'fl'].filter(Boolean).join(' ');
    return `<div class="lo-mock ${cls}"><b></b><u></u><div class="lo-row"><i class="r"></i><i class="c"></i><i class="d"></i></div>${o.status === 'on' ? '<u></u>' : ''}</div>`;
  }
  function layoutPicker() {
    const cur = layoutName(known), o = layoutOptions('custom', known);
    return `<div class="lo-picker"><div class="lo-grid">` + Object.keys(LAYOUTS).map(n =>
      `<button class="lo-card${n === cur ? ' active' : ''}" data-layout-pick="${n}">${layoutMock(n)}<div class="lo-name">${L(n)}<span>${n === cur ? '&#10003;' : ''}</span></div></button>`).join('') + `</div>` +
      (cur !== 'custom' ? '' : `<div class="lo-opts">` + Object.keys(OPTS).map(k =>
        `<span>${L(k)}</span><div class="lo-seg">` + OPTS[k].map(v =>
          `<button class="${o[k] === v ? 'active' : ''}" data-layout-opt="${k}" data-layout-val="${v}">${L(v)}</button>`).join('') + `</div>`).join('') + `</div>`) + `</div>`;
  }
  function changeLayout(patch) {
    push(patch);
    applyLayout(known);
    document.querySelectorAll('.lo-picker').forEach(el => { el.outerHTML = layoutPicker(); });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-layout-pick],[data-layout-opt]');
    if (!b) return;
    if (b.dataset.layoutPick) changeLayout({layout: b.dataset.layoutPick});
    else changeLayout({layoutCustom: {...layoutOptions('custom', known), [b.dataset.layoutOpt]: b.dataset.layoutVal}});
  });
  try { known = JSON.parse(localStorage.getItem(CACHE)) || {}; } catch (e) {}
  applyLayout(known);

  async function pull() {
    if (!invoke || !hooks) return known;
    const s = await invoke('shared_get').catch(() => null);
    if (!s) return known;
    applyLayout(s);
    if (same(s, known)) return known;
    known = s; hooks.apply(s);
    return known;
  }
  function push(patch) {
    if (!invoke) return;
    const changed = Object.keys(patch).filter(k => patch[k] !== undefined && known[k] !== patch[k]);
    if (!changed.length) return;
    const p = Object.fromEntries(changed.map(k => [k, patch[k]]));
    known = {...known, ...p};
    invoke('shared_set', {patch: p}).then(s => { known = s; }).catch(() => {});
  }
  window.addEventListener('focus', () => { pull(); });
  window.Shared = {init(h) { hooks = h; return pull(); }, push, pull, get values() { return known; },
    layoutPicker, layoutHeading: () => `<h3>${L('heading')}</h3><p class="hint">${L('hint')}</p>` + layoutPicker(),
    layoutNames: () => Object.keys(LAYOUTS).map(id => ({id, label: L(id)})), layoutLabel: () => L('heading'),
    get layout() { return layoutName(known); }, setLayout: name => changeLayout({layout: name})};
})();
