/* The 3D view of the Studio apps — the layout „3D (Beta)“ (the same file in every app that has one; shared.js switches the
   layout, room3d.css draws it). It shows the app as the real, physical thing it would be: Markdown Studio as a bookcase
   (folders = shelves, notes = books), Agent Studio as a server rack (projects = rack units with LEDs), Studio Hub as a
   shelf of devices. Plain CSS 3D (no WebGL, no library), so it runs in every web view and follows the theme.

   An app registers once:  Room3D.register({data() → scene, open(id) (→ 'stay': stay in the room), title?() → text})
     scene = {kind: 'shelf' | 'rack', item: 'book' | 'device' (shelf only), groups: [{label, items: [item]}],
              empty?: text, emptyAction?: {label, run()}, stay?: true (stay in 3D after opening)}
     item  = {id, label, sub?, color?, state?: 'on' | 'running' | 'attention' | 'error' | 'off', active?, icon? (image URL)}
   data() is read again every 1.5 s while the view is on screen and only redrawn when it changed. „Zur App“ (or Esc)
   shows the normal window; the button „3D-Ansicht“ at the bottom right brings the room back. Drag turns the room,
   the mouse wheel / pinch zooms, Shift + drag moves it; every item can be reached with Tab and opened with Enter. */
(() => {
  'use strict';
  const LABELS = {
    en: {beta: 'Beta', search: 'Search…', back: 'To the app', leave: 'Leave 3D layout', reset: 'Reset view', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
      show: '3D view', help: 'Drag: turn · Wheel: zoom · Shift + drag: move · Click or Enter: open · Esc: to the app',
      more: '{n} more not shown — use the search', none: 'Nothing matches the search.', title: '3D view'},
    de: {beta: 'Beta', search: 'Suchen…', back: 'Zur App', leave: '3D-Layout verlassen', reset: 'Ansicht zurücksetzen', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern',
      show: '3D-Ansicht', help: 'Ziehen: drehen · Mausrad: zoomen · Umschalt + Ziehen: verschieben · Klick oder Eingabe: öffnen · Esc: zur App',
      more: '{n} weitere nicht gezeigt — nutze die Suche', none: 'Nichts passt zur Suche.', title: '3D-Ansicht'}
  };
  const L = (k, n) => ((LABELS[(document.documentElement.lang || '').slice(0, 2)] || LABELS.en)[k] || k).replace('{n}', n);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
  const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  const MAX = 360;   // items drawn at most (CSS 3D gets slow beyond that)
  const VIEW = {rx: -8, ry: -16, zoom: 1, px: 0, py: 0};

  let adapter = null, away = false, key = '', view = {...VIEW}, q = '', box = null, pill = null, timer = 0, fit = 1, lead = 0;
  const isOn = () => document.documentElement.dataset.layout === 'room';
  const visible = () => !!box && !box.hidden;

  /* ================= The scene: boxes made of faces ================= */
  /* A box w × h × d: its front face has the top-left corner at (x, y) and lies at depth z (the room's front is z = 0).
     faces: {front, right, left, top} → inner HTML (back and bottom are never seen and left out); room3d.css turns the
     side and top faces into place with the box's --d. */
  function block(cls, x, y, z, w, h, d, faces, attrs = '') {
    const face = k => faces[k] === undefined ? '' : `<div class="r3-f r3-${k}">${faces[k]}</div>`;
    return `<div class="r3-box ${cls}" ${attrs} style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;--d:${d}px;transform:translateZ(${z}px)">` +
      face('front') + face('right') + face('left') + face('top') + `</div>`;
  }
  const match = it => !q || (it.label + ' ' + (it.sub || '')).toLowerCase().includes(q);
  const itemAttrs = it => `role="button" tabindex="0" data-r3-id="${esc(it.id)}" aria-label="${esc(it.label + (it.sub ? ' — ' + it.sub : ''))}"`;
  const stateCls = it => (it.active ? ' r3-active' : '') + (it.state ? ' r3-st-' + it.state : '');

  /* ---- Shelf (bookcase / device shelf): one row of a case per group (wrapping when it is full), cases side by side ---- */
  function shelf(scene) {
    const dev = scene.item === 'device';
    const IW = dev ? 760 : 820, ROW = dev ? 170 : 200, D = dev ? 170 : 190, WALL = 18, BOARD = 16, ROWS = 5;
    const rows = [];
    let drawn = 0, hidden = 0;
    for (const g of scene.groups) {
      const items = g.items.filter(match);
      if (!items.length) continue;
      let row = {label: g.label, items: [], w: 0};
      rows.push(row);
      for (const it of items) {
        if (drawn >= MAX) { hidden++; continue; }
        const h = hash(it.id), w = dev ? 150 : 22 + h % 17;
        if (row.w + w > IW - 24 && row.items.length) { row = {label: '', items: [], w: 0}; rows.push(row); }
        row.items.push({it, w, h}); row.w += w + (dev ? 18 : 1); drawn++;
      }
    }
    const cases = [];
    for (let i = 0; i < rows.length; i += ROWS) cases.push(rows.slice(i, i + ROWS));
    if (!cases.length) cases.push([]);
    const CW = IW + 2 * WALL, GAP = 70, total = cases.length * CW + (cases.length - 1) * GAP;
    const nRows = Math.max(1, ...cases.map(c => c.length)), CH = nRows * ROW + (nRows + 1) * BOARD;
    let h = '';
    cases.forEach((rs, ci) => {
      const x0 = -total / 2 + ci * (CW + GAP), y0 = -CH / 2;
      // the case: sides, top, back wall and the boards
      h += block('r3-wood r3-side', x0, y0, 0, WALL, CH, D, {front: '', right: '', left: '', top: ''});
      h += block('r3-wood r3-side', x0 + CW - WALL, y0, 0, WALL, CH, D, {front: '', right: '', left: '', top: ''});
      h += `<div class="r3-back r3-wood-back" style="left:${x0 + WALL}px;top:${y0}px;width:${IW}px;height:${CH}px;transform:translateZ(${-D}px)"></div>`;
      for (let r = 0; r <= nRows; r++) {
        const row = rs[r - 1], by = y0 + r * (ROW + BOARD);
        const plate = r > 0 && row && row.label ? `<span class="r3-plate">${esc(row.label)}</span>` : '';
        h += block('r3-wood r3-board', x0 + WALL, r === 0 ? y0 : by, 0, IW, BOARD, D, {front: '', top: ''});
        if (plate) h += `<div class="r3-plate-at" style="left:${x0 + WALL}px;top:${by}px;width:${IW}px;transform:translateZ(1px)">${plate}</div>`;
      }
      rs.forEach((row, r) => {
        const floor = y0 + (r + 1) * (ROW + BOARD);   // top of the board below the row
        let x = x0 + WALL + 12;
        for (const {it, w, h: hh} of row.items) {
          if (dev) {
            const bh = 118, bd = 130;
            const icon = it.icon ? `<img src="${esc(it.icon)}" alt="" draggable="false">` : `<b>${esc(it.label.slice(0, 2))}</b>`;
            h += block('r3-item r3-device' + stateCls(it), x, floor - bh, -(D - bd) / 2, w, bh, bd, {
              front: `<div class="r3-dev-face">${icon}<span class="r3-dev-name">${esc(it.label)}</span><i class="r3-led"></i>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`,
              right: '', left: '', top: ''}, itemAttrs(it));
            x += w + 18;
          } else {
            const bh = 128 + hh % 52, bd = 130 + hh % 34, hue = it.color ? null : hh % 360;
            const style = it.color ? `--book:color-mix(in srgb,${esc(it.color)} ${52 + hh % 36}%,#1a1410)` : `--book:hsl(${hue} ${38 + hh % 30}% ${30 + hh % 18}%)`;
            h += `<div class="r3-slot" style="${style}">` + block('r3-item r3-book' + stateCls(it), x, floor - bh, -(D - bd) + 2, w, bh, bd, {
              front: `<span class="r3-spine">${esc(it.label)}</span>`, right: '', left: '', top: ''}, itemAttrs(it)) + `</div>`;
            x += w + 1;
          }
        }
      });
    });
    return {html: h, w: total, h: CH, d: D, hidden};
  }

  /* ---- Rack: a cabinet of rack units (one per item), a blank labelled panel above each group, cabinets side by side ---- */
  function rack(scene) {
    const UW = 480, UH = 44, D = 320, SIDE = 26, TOP = 30, PER = 14;
    const units = [];
    let hidden = 0;
    for (const g of scene.groups) {
      const items = g.items.filter(match);
      if (!items.length) continue;
      if (g.label) units.push({label: g.label});
      for (const it of items) { if (units.length >= MAX) hidden++; else units.push({it}); }
    }
    const cabs = [];
    for (let i = 0; i < units.length; i += PER) cabs.push(units.slice(i, i + PER));
    if (!cabs.length) cabs.push([]);
    const n = Math.max(6, ...cabs.map(c => c.length)), CW = UW + 2 * SIDE, CH = n * UH + 2 * TOP, GAP = 80;
    const total = cabs.length * CW + (cabs.length - 1) * GAP;
    let h = '';
    cabs.forEach((us, ci) => {
      const x0 = -total / 2 + ci * (CW + GAP), y0 = -CH / 2;
      h += block('r3-metal r3-cab-side', x0, y0, 0, SIDE, CH, D, {front: '<i class="r3-rail"></i>', right: '', left: '<i class="r3-vent"></i>', top: ''});
      h += block('r3-metal r3-cab-side', x0 + CW - SIDE, y0, 0, SIDE, CH, D, {front: '<i class="r3-rail"></i>', right: '<i class="r3-vent"></i>', left: '', top: ''});
      h += block('r3-metal r3-cab-top', x0 + SIDE, y0, 0, UW, TOP, D, {front: `<span class="r3-brand">${esc(scene.brand || '')}</span>`, top: ''});
      h += block('r3-metal r3-cab-top', x0 + SIDE, y0 + CH - TOP, 0, UW, TOP, D, {front: '', top: ''});
      h += `<div class="r3-back r3-cab-back" style="left:${x0 + SIDE}px;top:${y0 + TOP}px;width:${UW}px;height:${CH - 2 * TOP}px;transform:translateZ(${-D + 4}px)"></div>`;
      us.forEach((u, i) => {
        const y = y0 + TOP + i * UH;
        if (!u.it) {
          h += block('r3-unit r3-blank', x0 + SIDE, y + 2, -6, UW, UH - 4, 40, {front: `<span class="r3-blank-label">${esc(u.label)}</span>`, top: ''});
          return;
        }
        const it = u.it, col = it.color ? `--unit:${esc(it.color)}` : '';
        h += `<div class="r3-slot" style="${col}">` + block('r3-item r3-unit' + stateCls(it), x0 + SIDE, y + 2, -4, UW, UH - 4, D - 30, {
          front: `<i class="r3-ear"></i><span class="r3-leds"><i class="r3-led r3-pwr"></i><i class="r3-led r3-act"></i></span>` +
            `<span class="r3-unit-name">${esc(it.label)}</span><small>${esc(it.sub || '')}</small><span class="r3-bays">${'<i></i>'.repeat(6)}</span><i class="r3-ear"></i>`,
          right: '', left: '', top: ''}, itemAttrs(it)) + `</div>`;
      });
    });
    return {html: h, w: total, h: CH, d: D, hidden};
  }

  /* ================= On screen ================= */
  function build() {
    if (box) return;
    box = document.createElement('div');
    box.className = 'r3'; box.hidden = true;
    box.setAttribute('role', 'region');
    box.innerHTML = `<div class="r3-bar"><b class="r3-title"></b><span class="r3-beta">${esc(L('beta'))}</span>
      <input class="r3-q" type="search" spellcheck="false"><span class="r3-flex"></span>
      <button class="r3-btn" data-r3="out" title="${esc(L('zoomOut'))}">−</button><button class="r3-btn" data-r3="in" title="${esc(L('zoomIn'))}">+</button>
      <button class="r3-btn" data-r3="reset" title="${esc(L('reset'))}">⟲</button>
      <button class="r3-btn" data-r3="back"></button><button class="r3-btn" data-r3="leave"></button></div>
      <div class="r3-stage"><div class="r3-cam"><div class="r3-world"></div></div><div class="r3-msg" hidden></div></div>
      <div class="r3-foot"><span class="r3-tip"></span><span class="r3-help"></span></div>`;
    pill = document.createElement('button');
    pill.className = 'r3-pill'; pill.hidden = true;
    pill.addEventListener('click', () => { away = false; sync(); });
    document.body.append(box, pill);
    const stage = box.querySelector('.r3-stage');
    box.querySelector('.r3-q').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); key = ''; draw(); });
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-r3]');
      if (b) return act(b.dataset.r3);
      const it = e.target.closest('[data-r3-id]');
      if (it && !dragged) open(it.dataset.r3Id);
    });
    box.addEventListener('keydown', e => {
      const it = e.target.closest && e.target.closest('[data-r3-id]');
      if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(it.dataset.r3Id); }
      else if (e.key === 'Escape' && !document.querySelector('.modal-bg:not([hidden]):not(.hidden)')) { e.preventDefault(); act('back'); }
      else if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && /^Arrow/.test(e.key)) {
        e.preventDefault();
        const s = 4;
        if (e.key === 'ArrowLeft') view.ry -= s; else if (e.key === 'ArrowRight') view.ry += s;
        else if (e.key === 'ArrowUp') view.rx += s; else view.rx -= s;
        place();
      }
    });
    box.addEventListener('focusin', e => { const it = e.target.closest && e.target.closest('[data-r3-id]'); if (it) tip(it); });
    box.addEventListener('mouseover', e => { const it = e.target.closest && e.target.closest('[data-r3-id]'); tip(it); });
    // turning (drag), moving (Shift + drag) and zooming (wheel / pinch)
    let drag = null, dragged = false;
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = {x: e.clientX, y: e.clientY, v: {...view}, pan: e.shiftKey}; dragged = false;
    });
    window.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!dragged) { dragged = true; stage.classList.add('r3-dragging'); }
      if (drag.pan || e.altKey) { view.px = drag.v.px + dx; view.py = drag.v.py + dy; }
      else { view.ry = drag.v.ry + dx * 0.25; view.rx = drag.v.rx - dy * 0.2; }
      place();
    });
    window.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null; stage.classList.remove('r3-dragging');
      setTimeout(() => { dragged = false; }, 0);   // the click after a drag does not open anything
    });
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else { view.px -= e.deltaX; place(); }
    }, {passive: false});
    window.addEventListener('resize', () => { if (visible()) { measure(); place(); } });
  }
  function zoomBy(f) { view.zoom = Math.min(4, Math.max(0.35, view.zoom * f)); place(); }
  function act(a) {
    if (a === 'in') zoomBy(1.2); else if (a === 'out') zoomBy(1 / 1.2);
    else if (a === 'reset') { view = {...VIEW}; place(); }
    else if (a === 'back') { away = true; sync(); }
    else if (a === 'leave') { if (window.Shared) Shared.setLayout('adobe'); if (isOn()) { away = true; sync(); } }
  }
  function open(id) {
    if (!adapter) return;
    const scene = lastScene || {};
    let r;
    try { r = adapter.open(id); } catch (e) { console.error(e); }
    if (r !== 'stay' && !scene.stay) { away = true; sync(); }
    else { key = ''; draw(); }
  }
  function tip(it) {
    const t = box.querySelector('.r3-tip');
    t.textContent = it ? it.getAttribute('aria-label') : '';
  }
  let lastScene = null, size = {w: 1, h: 1, d: 1};
  function draw() {
    if (!adapter || !visible()) return;
    let scene;
    try { scene = adapter.data() || {groups: []}; } catch (e) { console.error(e); scene = {groups: []}; }
    const k = q + '\u0000' + JSON.stringify(scene, (n, v) => typeof v === 'function' ? undefined : v);
    if (k === key) return;
    key = k; lastScene = scene;
    labels();
    const r = scene.kind === 'rack' ? rack(scene) : shelf(scene);
    const world = box.querySelector('.r3-world'), msg = box.querySelector('.r3-msg');
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.r3Id;
    world.className = 'r3-world r3-k-' + (scene.kind === 'rack' ? 'rack' : scene.item === 'device' ? 'devices' : 'books');
    world.innerHTML = `<div class="r3-floor" style="top:${r.h / 2}px"></div><div class="r3-wall" style="top:-1600px;height:${1600 + r.h / 2}px;transform:translateZ(${-r.d - 60}px)"></div>` + r.html +
      (r.hidden ? `<div class="r3-more" style="top:${r.h / 2 + 24}px">${esc(L('more', r.hidden))}</div>` : '');
    const empty = !scene.groups.some(g => g.items.length);
    msg.hidden = !((empty && scene.empty) || (!empty && q && !world.querySelector('[data-r3-id]')));
    msg.innerHTML = empty ? `<p>${esc(scene.empty || '')}</p>` + (scene.emptyAction ? `<button class="r3-btn r3-primary" data-r3-empty>${esc(scene.emptyAction.label)}</button>` : '') : `<p>${esc(L('none'))}</p>`;
    const eb = msg.querySelector('[data-r3-empty]');
    if (eb) eb.onclick = () => { try { scene.emptyAction.run(); } catch (e) { console.error(e); } };
    if (focused) { const f = world.querySelector(`[data-r3-id="${CSS.escape(focused)}"]`); if (f) f.focus({preventScroll: true}); }
    size = r; measure(); place();
  }
  function measure() {
    const s = box.querySelector('.r3-stage').getBoundingClientRect();
    fit = Math.min((s.width - 60) / (size.w + 80), (s.height - 40) / (size.h + 80), 1.4) || 1;
    // Many things: not smaller than readable — start at the left end and let the user move along (Shift + drag, wheel sideways).
    lead = 0;
    if (fit < 0.55) { fit = Math.min(0.55, (s.height - 40) / (size.h + 80)); lead = Math.max(0, (size.w * fit - s.width) / 2 + 40); }
  }
  function place() {
    view.rx = Math.max(-28, Math.min(14, view.rx)); view.ry = Math.max(-55, Math.min(55, view.ry));
    const cam = box && box.querySelector('.r3-cam');
    if (!cam) return;
    cam.style.transform = `translate(${view.px + lead}px,${view.py}px) scale(${fit * view.zoom}) rotateX(${view.rx}deg) rotateY(${view.ry}deg)`;
  }
  function labels() {
    const title = adapter && adapter.title ? adapter.title() : L('title');
    box.querySelector('.r3-title').textContent = title;
    box.setAttribute('aria-label', title);
    box.querySelector('.r3-q').placeholder = L('search');
    box.querySelector('[data-r3="back"]').textContent = L('back');
    box.querySelector('[data-r3="leave"]').textContent = L('leave');
    box.querySelector('.r3-help').textContent = L('help');
    pill.innerHTML = `<span>▣</span> ${esc(L('show'))} <em>${esc(L('beta'))}</em>`;
  }
  /* Shows the room, the button back to it, or nothing — after the layout, the adapter or "away" changed. */
  function sync() {
    if (!adapter || !document.body) return;
    build();
    const on = isOn();
    if (!on) away = false;
    const show = on && !away, was = visible();
    box.hidden = !show; pill.hidden = !(on && away);
    document.documentElement.classList.toggle('r3-open', show);
    clearInterval(timer);
    if (!show) return;
    labels();
    if (!was) { key = ''; requestAnimationFrame(() => { draw(); const f = box.querySelector('[data-r3-id]'); if (f && !box.contains(document.activeElement)) f.focus({preventScroll: true}); }); }
    timer = setInterval(() => { if (document.visibilityState === 'visible') draw(); }, 1500);
  }
  new MutationObserver(() => { key = ''; if (box) labels(); sync(); })
    .observe(document.documentElement, {attributes: true, attributeFilter: ['data-layout', 'lang']});

  window.Room3D = {
    register(a) { adapter = a; key = ''; if (document.body) sync(); else document.addEventListener('DOMContentLoaded', sync); },
    refresh() { key = ''; draw(); },
    /* Back into the room (e.g. from a menu entry), or out of it to the normal window. */
    show() { away = false; sync(); }, hide() { away = true; sync(); },
    get ready() { return !!adapter; }, get on() { return isOn() && !away; }
  };
})();
