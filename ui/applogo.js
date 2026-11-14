/* The app logo follows the theme (the same file in every Studio app, like shared.js).
   - In the window: the small logo tile in the menu bar (.logo>span, or an element with data-applogo) and the big tile
     of the empty state (.big-tile) get the theme's logo colors (CSS --logo-a/--logo-b fade, --logo-fg letters, --logo-ring).
   - Dock (macOS, Rust command set_dock_icon) and window / taskbar icon (Windows, Linux): ui/app-icon.png recolored the
     same way — the tile takes the theme's fade, the white card and letters take the theme's foreground.
   The default theme „dark“ keeps the original icon (and the installed one in the Dock).
   Recipes: tile = [from, to] (top left → bottom right), fg = letters / pictogram, ring = outline, mono = terminal font.
   A color is '#hex', a theme variable ('--accent'), the app's own tile color ('tile-a' / 'tile-b', from the CSS, light
   fade in light themes) or a mix [color, color, share of the second]. */
(() => {
  'use strict';
  const T = window.__TAURI__, invoke = T ? T.core.invoke : null;
  const APP_TILE = {tile: ['tile-a', 'tile-b'], fg: '#fff'};
  const PAPER = {tile: ['--panel', '--bg'], fg: 'tile-a', ring: '--border'};   // light card, logo in the app's color
  const CLI = {tile: ['#0a0a0a', '#141414'], fg: '--accent', ring: '--accent', mono: true};
  const RECIPES = {
    dark: {...APP_TILE, original: true},
    light: APP_TILE, rose: APP_TILE, github: PAPER, sand: PAPER,
    'github-dark': {tile: [['--bg', 'tile-b', .18], ['--bg', 'tile-b', .7]], fg: '#fff', ring: '--border'},
    midnight: {tile: [['--chrome', 'tile-b', .12], ['--chrome', 'tile-b', .8]], fg: '#fff'},
    dusk: {tile: [['--chrome', 'tile-b', .12], ['--chrome', 'tile-b', .8]], fg: '#fff'},
    graphite: {tile: ['#2a2b2f', '#4a4c52'], fg: 'tile-b', ring: ['--border', 'tile-b', .35]},
    contrast: {tile: ['#000', '#000'], fg: '#fff', ring: '--accent'},
    cli: CLI, 'cli-amber': CLI, 'cli-cyan': CLI, 'cli-magenta': CLI, 'cli-white': CLI
  };
  const MONO = 'ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace';

  /* Colors as [r, g, b]; the browser parses any CSS color via a canvas. */
  const pen = document.createElement('canvas').getContext('2d');
  function rgb(css) {
    pen.fillStyle = '#000'; pen.fillStyle = css || '#000';
    const v = pen.fillStyle;
    if (v[0] === '#') return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
    const m = v.match(/[\d.]+/g) || [0, 0, 0];
    return m.slice(0, 3).map(Number);
  }
  const hex = c => '#' + c.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
  function color(spec, cs) {
    if (Array.isArray(spec)) return mix(color(spec[0], cs), color(spec[1], cs), spec[2]);
    if (spec === 'tile-a' || spec === 'tile-b') return rgb(cs.getPropertyValue('--' + spec).trim());
    if (spec.startsWith('--')) return rgb(cs.getPropertyValue(spec).trim());
    return rgb(spec);
  }
  /* The resolved logo of a theme: {a, b, fg, ring (or null), mono, original}. */
  function resolve(theme) {
    const r = RECIPES[theme] || APP_TILE, cs = getComputedStyle(document.documentElement);
    return {a: color(r.tile[0], cs), b: color(r.tile[1], cs), fg: color(r.fg, cs), ring: r.ring ? color(r.ring, cs) : null,
      mono: !!r.mono, original: !!r.original};
  }

  /* In the window: CSS variables + one style sheet for the logo elements. */
  const SEL = '.logo>span,.big-tile,[data-applogo]';
  const sheet = document.createElement('style');
  sheet.textContent = `${SEL.split(',').map(s => s + ':not(.no-applogo)').join(',')}{` +
    'background:linear-gradient(135deg,var(--logo-a,var(--tile-a)),var(--logo-b,var(--tile-b)))!important;' +
    'color:var(--logo-fg,#fff)!important;font-family:var(--logo-font,inherit)!important;' +
    'box-shadow:inset 0 0 0 max(1px,.09em) var(--logo-ring,transparent)!important}' +
    '.big-tile:not(.no-applogo){box-shadow:inset 0 0 0 .07em var(--logo-ring,transparent),0 12px 32px rgba(0,0,0,.3)!important}';
  document.head.appendChild(sheet);
  function applyCss(L) {
    const st = document.documentElement.style;
    st.setProperty('--logo-a', hex(L.a)); st.setProperty('--logo-b', hex(L.b)); st.setProperty('--logo-fg', hex(L.fg));
    st.setProperty('--logo-ring', L.ring ? hex(L.ring) : 'transparent');
    if (L.mono) st.setProperty('--logo-font', MONO); else st.removeProperty('--logo-font');
  }

  /* The icon picture: app-icon.png with its tile and its white parts recolored. The icons all share one design (a tile
     in the app's color, a white card and white letters), so "how white is a pixel" (its smallest channel) tells the
     foreground from the tile. Returns a canvas (size × size). */
  function paint(img, L, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, size, size);
    if (L.original) return c;
    const d = g.getImageData(0, 0, size, size), p = d.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!p[i + 3]) continue;
      const w = Math.min(p[i], p[i + 1], p[i + 2]) / 255, t = Math.max(0, Math.min(1, (w - 0.3) / 0.55));
      const u = (x + y) / (2 * size), tile = mix(L.a, L.b, u), o = mix(tile, L.fg, t);
      p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2];
    }
    g.putImageData(d, 0, 0);
    if (L.ring) {
      const m = size * 0.0625, lw = size * 0.025, w = size - 2 * m;
      g.strokeStyle = hex(L.ring); g.lineWidth = lw;
      g.beginPath(); g.roundRect(m + lw / 2, m + lw / 2, w - lw, w - lw, w * 0.225 - lw / 2); g.stroke();
    }
    return c;
  }
  const png = c => new Promise(ok => c.toBlob(b => b ? b.arrayBuffer().then(a => ok(new Uint8Array(a))) : ok(null), 'image/png'));

  const icon = new Image();
  let iconReady = null, lastKey = '', seq = 0;
  async function applyIcon(L, key) {
    if (!invoke) return;
    if (!iconReady) iconReady = new Promise(ok => { icon.onload = () => ok(true); icon.onerror = () => ok(false); icon.src = 'app-icon.png'; });
    if (!(await iconReady)) return;
    const mine = ++seq, bytes = await png(paint(icon, L, 256));
    if (!bytes || mine !== seq) return;   // a newer theme came in meanwhile
    try { T.window.getCurrentWindow().setIcon(bytes).catch(() => {}); } catch (e) { /* no window API */ }
    // macOS Dock; an empty picture brings back the installed icon.
    invoke('set_dock_icon', {png: L.original ? [] : Array.from(bytes)}).catch(() => {});
  }

  function sync() {
    const theme = document.documentElement.dataset.theme || 'dark', L = resolve(theme);
    applyCss(L);
    const key = theme + JSON.stringify(L);
    if (key === lastKey) return;
    lastKey = key;
    applyIcon(L, key);
  }
  new MutationObserver(sync).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  sync();

  window.AppLogo = {RECIPES, resolve, paint, sync};
})();
