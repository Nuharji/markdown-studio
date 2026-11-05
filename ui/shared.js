/* Settings shared by all Studio apps (the same file in every app; Rust: shared.rs): theme, language and the work
   folder in <config dir>/Studio/shared.json. Studio Hub edits them; every app takes them over at start and whenever
   its window gets the focus, and passes its own theme / language changes on — so all apps look and speak alike.
   Shared.init({apply(s)}) → applies the shared values (s.theme, s.lang); Shared.push({theme, lang}) after a change.
   The layout (Adobe, Eigenes, Modern, CLI, Fokus, Gespiegelt; layouts.css) is shared as well, but this file applies it itself:
   Shared.layoutPicker() gives the settings section, Shared.setLayout(name) changes it.
   Own look per app: Shared.init({app: 'md', apply}) names the app. When shared.json has an entry apps.<app> (theme, layout,
   layoutCustom), the app uses it instead of the shared values (missing keys still follow the hub) and keeps its own theme /
   layout changes there. Shared.scopePicker() gives the switch „Wie im Studio Hub / Nur für diese App“; the hub edits the
   entries of all apps with Shared.apps and Shared.setApp(id, entry|null). The language is always shared. */
(() => {
  'use strict';
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
  let known = {}, raw = {}, hooks = null, APP = '';   // known: the values this app uses; raw: shared.json itself
  const SCOPED = ['theme', 'layout', 'layoutCustom'];
  const ownOf = (s, id) => id && s.apps && s.apps[id] && typeof s.apps[id] === 'object' ? s.apps[id] : null;
  const effective = s => {
    const o = ownOf(s, APP), e = {...s};
    if (o) for (const k of SCOPED) if (o[k] !== undefined) e[k] = o[k];
    return e;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* A layout is a set of options; Adobe is the plain set, Eigenes is whatever the user chose. */
  const OPTS = {dock: ['right', 'left'], tools: ['left', 'right'], density: ['compact', 'normal', 'comfortable'],
    corners: ['theme', 'sharp', 'medium', 'round'], float: ['off', 'on'], status: ['on', 'off'], font: ['theme', 'mono']};
  const BASE = {dock: 'right', tools: 'left', density: 'normal', corners: 'theme', float: 'off', status: 'on', font: 'theme'};
  const LAYOUTS = {adobe: BASE, custom: {...BASE, dock: 'left', density: 'compact', corners: 'medium'},
    modern: {...BASE, density: 'comfortable', corners: 'round', float: 'on'},
    // CLI: like a terminal — monospace font, square, compact and flat (layouts.css), with any theme (best with the CLI theme).
    cli: {...BASE, density: 'compact', corners: 'sharp', font: 'mono'},
    // Fokus: calm — roomy, no status bar, bars and panels without lines, the tool rail fades until you point at it.
    focus: {...BASE, density: 'comfortable', corners: 'medium', status: 'off'},
    // Gespiegelt: Adobe mirrored — panels on the left, tool rail on the right.
    mirror: {...BASE, dock: 'left', tools: 'right'}};
  const LABELS = {
    en: {heading: 'Layout', hint: 'How the window is arranged. Works with every theme and applies to all Studio apps.', adobe: 'Adobe', custom: 'Custom', modern: 'Modern', cli: 'CLI', focus: 'Focus', mirror: 'Mirrored',
      dock: 'Panels', tools: 'Tool rail', density: 'Density', corners: 'Corners', float: 'Floating panels', status: 'Status bar', font: 'Font', mono: 'Monospace',
      scope: 'Theme and layout', follow: 'Like Studio Hub', own: 'Only for this app',
      scopeHint: 'Like Studio Hub: this app looks like all the others and follows changes in the hub. Only for this app: theme and layout chosen here stay with this app.',
      right: 'Right', left: 'Left', compact: 'Compact', normal: 'Normal', comfortable: 'Roomy', theme: 'Like the theme', sharp: 'Sharp', medium: 'Medium', round: 'Round', on: 'On', off: 'Off'},
    de: {heading: 'Layout', hint: 'Wie das Fenster aufgebaut ist. Passt zu jedem Design und gilt für alle Studio-Apps.', adobe: 'Adobe', custom: 'Eigenes', modern: 'Modern', cli: 'CLI', focus: 'Fokus', mirror: 'Gespiegelt',
      dock: 'Seitenleiste', tools: 'Werkzeugleiste', density: 'Dichte', corners: 'Ecken', float: 'Schwebende Flächen', status: 'Statusleiste', font: 'Schrift', mono: 'Monospace',
      scope: 'Design und Layout', follow: 'Wie im Studio Hub', own: 'Nur für diese App',
      scopeHint: 'Wie im Studio Hub: Diese App sieht aus wie alle anderen und folgt Änderungen im Hub. Nur für diese App: Design und Layout, die du hier wählst, gelten nur für diese App.',
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
    const cls = [o.tools === 'right' && 'tr', o.dock === 'left' && 'dl', o.float === 'on' && 'fl', o.font === 'mono' && 'mo', name === 'focus' && 'fo'].filter(Boolean).join(' ');
    return `<div class="lo-mock ${cls}"><b></b><u></u><div class="lo-row"><i class="r"></i><i class="c">${o.font === 'mono' ? '&gt;_' : ''}</i><i class="d"></i></div>${o.status === 'on' ? '<u></u>' : ''}</div>`;
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
  /* The switch between the hub's look and an own look for this app. */
  function scopePicker() {
    if (!APP || !invoke) return '';
    const own = !!ownOf(raw, APP);
    return `<div class="sc-picker"><h3>${L('scope')}</h3><div class="lo-seg">` + ['follow', 'own'].map(v =>
      `<button class="${(v === 'own') === own ? 'active' : ''}" data-scope-pick="${v}">${L(v)}</button>`).join('') +
      `</div><p class="hint">${L('scopeHint')}</p></div>`;
  }
  function setOwn(on) {
    if (!APP || !invoke || !!ownOf(raw, APP) === on) return;
    let entry = null;
    if (on) {
      entry = {theme: known.theme || document.documentElement.dataset.theme, layout: layoutName(known)};
      if (known.layoutCustom) entry.layoutCustom = known.layoutCustom;
    }
    send({apps: {[APP]: entry}});
    refresh();
  }
  /* The hub: own looks of the other apps (an entry with theme / layout / layoutCustom; null = like the hub). */
  function setApp(id, entry) {
    if (!invoke || !/^[a-z]{2,8}$/.test(id)) return;
    send({apps: {[id]: entry && Object.keys(entry).length ? entry : null}});
    if (id === APP) refresh();
  }
  /* Writes a patch (apps entries are replaced whole) and keeps raw / known up to date at once. */
  function send(p) {
    const r = {...raw};
    for (const k of Object.keys(p)) {
      if (k === 'apps') {
        const a = {...(r.apps || {})};
        for (const id of Object.keys(p.apps)) { if (p.apps[id] === null) delete a[id]; else a[id] = p.apps[id]; }
        r.apps = a;
      } else if (p[k] === null) delete r[k]; else r[k] = p[k];
    }
    raw = r; known = effective(raw);
    invoke('shared_set', {patch: p}).then(s => { raw = s; known = effective(s); }).catch(() => {});
  }
  /* After the scope changed: apply the values this app now uses and update the settings on screen. */
  function refresh() {
    applyLayout(known);
    if (hooks) hooks.apply(known);
    const th = known.theme || document.documentElement.dataset.theme;
    document.querySelectorAll('[data-theme-pick]').forEach(b => {
      const on = b.dataset.themePick === th, mark = b.querySelector('.theme-name span');
      b.classList.toggle('active', on);
      if (mark) mark.innerHTML = on ? '&#10003;' : '';
    });
    document.querySelectorAll('.lo-picker').forEach(el => { el.outerHTML = layoutPicker(); });
    document.querySelectorAll('.sc-picker').forEach(el => { el.outerHTML = scopePicker(); });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-layout-pick],[data-layout-opt],[data-scope-pick]');
    if (!b) return;
    if (b.dataset.scopePick) setOwn(b.dataset.scopePick === 'own');
    else if (b.dataset.layoutPick) changeLayout({layout: b.dataset.layoutPick});
    else changeLayout({layoutCustom: {...layoutOptions('custom', known), [b.dataset.layoutOpt]: b.dataset.layoutVal}});
  });
  try { known = JSON.parse(localStorage.getItem(CACHE)) || {}; } catch (e) {}
  applyLayout(known);

  async function pull() {
    if (!invoke || !hooks) return known;
    const s = await invoke('shared_get').catch(() => null);
    if (!s) return known;
    raw = s;
    const e = effective(s);
    applyLayout(e);
    if (same(e, known)) return known;
    known = e; hooks.apply(e);
    return known;
  }
  /* Passes this app's changes on: to the shared values, or — with an own look — theme and layout to apps.<app>. */
  function push(patch) {
    if (!invoke || !hooks) return;   // before init the shared values are not known yet (and they win)
    const changed = Object.keys(patch).filter(k => patch[k] !== undefined && !same(known[k], patch[k]));
    if (!changed.length) return;
    const p = {}, own = ownOf(raw, APP);
    let mine = null;
    for (const k of changed) {
      if (own && SCOPED.includes(k)) (mine = mine || {...own})[k] = patch[k];
      else p[k] = patch[k];
    }
    if (mine) p.apps = {[APP]: mine};
    send(p);
  }
  window.addEventListener('focus', () => { pull(); });
  window.Shared = {init(h) { hooks = h; if (h.app) APP = h.app; return pull(); }, push, pull, get values() { return known; },
    scopePicker, setApp, get apps() { return {...(raw.apps || {})}; }, get own() { return !!ownOf(raw, APP); },
    layoutPicker, layoutHeading: () => `<h3>${L('heading')}</h3><p class="hint">${L('hint')}</p>` + layoutPicker(),
    layoutNames: () => Object.keys(LAYOUTS).map(id => ({id, label: L(id)})), layoutLabel: () => L('heading'),
    get layout() { return layoutName(known); }, setLayout: name => changeLayout({layout: name})};
})();
