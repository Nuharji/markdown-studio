/* Auto-hide bars (the same file in every Studio app). When on, the bars leave the layout and slide in over the
   content when the mouse touches their screen edge; they slide out again once the mouse has left them. A bar stays
   while one of its menus is open or something in it has the keyboard focus. Alt alone shows the top bars until a
   click elsewhere, Escape or Alt again.
   AutoHide.init({top: [selectors, stacked downwards], left: [...], bottom: [...], css: 'extra rules while on'}) — optional
   AutoHide.set(on) */
(() => {
  'use strict';
  const body = document.body, EDGE = 4, SLACK = 8, DELAY = 450;
  // The Studio layout: menubar + options bar on top, tool rail left, status bar below (Studio Hub passes its own).
  let conf = {top: ['.menubar', '.optbar'], left: ['.tools'], bottom: ['.status'],
    css: 'body.ah{grid-template-rows:1fr} body.ah .main{grid-row:1;grid-template-columns:1fr auto}'}, on = false, altSticky = false, altAlone = false;
  const timers = {};
  const style = document.createElement('style');
  document.head.append(style);

  const bars = side => conf[side].flatMap(s => [...document.querySelectorAll(s)]);
  const shown = side => body.classList.contains('ah-show-' + side);
  const show = (side, v) => body.classList.toggle('ah-show-' + side, v);
  // Something in the bar is in use: an open menu (also one drawn outside the bar) or the keyboard focus.
  const busy = side => bars(side).some(el => el.contains(document.activeElement) || el.querySelector('.menu.open, .open, [aria-expanded="true"]')) ||
    (side === 'top' && altSticky);

  /* Fixed positions: stacked top bars get their offsets, the rail keeps its width. Measured while the bars are in
     the layout. */
  function measure() {
    let y = 0;
    // Upper bars lie above lower ones, so their open menus aren't covered.
    bars('top').forEach((el, i) => el.style.setProperty('--ah-z', 90 - i));
    for (const el of bars('top')) { el.style.setProperty('--ah-top', y + 'px'); el.style.setProperty('--ah-h', el.offsetHeight + 'px'); y += el.offsetHeight; }
    for (const el of bars('left')) el.style.setProperty('--ah-w', el.offsetWidth + 'px');
    for (const el of bars('bottom')) el.style.setProperty('--ah-h', el.offsetHeight + 'px');
  }
  function css() {
    const sel = (side, extra = '') => conf[side].map(s => `body.ah ${s}${extra}`).join(',') || 'body.ah .ah-none';
    style.textContent = `
      ${sel('top')},${sel('left')},${sel('bottom')}{position:fixed!important;z-index:80;transition:transform .16s ease,box-shadow .16s ease}
      ${sel('top')}{left:0;right:0;top:var(--ah-top);height:var(--ah-h);z-index:var(--ah-z,80);transform:translateY(calc(-100% - var(--ah-top) - 2px))}
      ${sel('left')}{left:0;top:0;bottom:0;width:var(--ah-w);z-index:79;transform:translateX(calc(-100% - 2px))}
      ${sel('bottom')}{left:0;right:0;bottom:0;height:var(--ah-h);transform:translateY(calc(100% + 2px))}
      ${conf.top.map(s => `body.ah.ah-show-top ${s}`).join(',') || '.ah-none'}{transform:none;box-shadow:0 4px 18px rgba(0,0,0,.28)}
      ${conf.left.map(s => `body.ah.ah-show-left ${s}`).join(',') || '.ah-none'}{transform:none;box-shadow:4px 0 18px rgba(0,0,0,.28)}
      ${conf.bottom.map(s => `body.ah.ah-show-bottom ${s}`).join(',') || '.ah-none'}{transform:none;box-shadow:0 -4px 18px rgba(0,0,0,.28)}
      ${conf.css || ''}`;
  }
  function hideLater(side) {
    if (timers[side]) return;
    timers[side] = setTimeout(() => { timers[side] = 0; if (!busy(side)) show(side, false); }, DELAY);
  }
  function stay(side) { clearTimeout(timers[side]); timers[side] = 0; show(side, true); }

  document.addEventListener('mousemove', e => {
    if (!on) return;
    const near = {top: e.clientY <= EDGE, left: e.clientX <= EDGE, bottom: e.clientY >= innerHeight - 1 - EDGE};
    for (const side of ['top', 'left', 'bottom']) {
      if (!conf[side].length) continue;
      const over = shown(side) && bars(side).some(el => {
        const r = el.getBoundingClientRect();
        return e.clientX >= r.left - SLACK && e.clientX <= r.right + SLACK && e.clientY >= r.top - SLACK && e.clientY <= r.bottom + SLACK;
      });
      // Edges at a corner: the top/bottom bars win over the rail.
      if (near[side] && !(side === 'left' && (near.top || near.bottom)) || over) stay(side);
      else if (shown(side)) hideLater(side);
    }
  }, {passive: true});
  document.documentElement.addEventListener('mouseleave', () => { if (on) ['top', 'left', 'bottom'].forEach(s => shown(s) && hideLater(s)); });
  // Keyboard: a focused control inside a bar shows it; leaving it lets the bar go.
  document.addEventListener('focusin', e => { if (on) for (const s of ['top', 'left', 'bottom']) if (bars(s).some(el => el.contains(e.target))) stay(s); });
  document.addEventListener('focusout', () => { if (on) setTimeout(() => ['top', 'left', 'bottom'].forEach(s => shown(s) && hideLater(s)), 0); });
  // Alt alone toggles the top bars; any other key in between (Alt+N …) doesn't.
  document.addEventListener('keydown', e => {
    if (!on) return;
    altAlone = e.key === 'Alt' && !e.repeat ? true : e.key === 'Alt' ? altAlone : false;
    if (e.key === 'Escape' && altSticky) { altSticky = false; hideLater('top'); }
  }, true);
  document.addEventListener('keyup', e => {
    if (!on || e.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    altSticky = !altSticky;
    if (altSticky) stay('top'); else hideLater('top');
  }, true);
  document.addEventListener('mousedown', e => {
    if (on && altSticky && !bars('top').some(el => el.contains(e.target))) { altSticky = false; hideLater('top'); }
  }, true);

  window.AutoHide = {
    init(c) { conf = {top: [], left: [], bottom: [], css: '', ...c}; css(); },
    set(v) {
      v = !!v;
      if (v === on) return;
      if (v) measure();
      on = v; altSticky = false;
      body.classList.toggle('ah', v);
      ['top', 'left', 'bottom'].forEach(s => show(s, false));
      // The content area changed size without a window resize; let the app lay out again.
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    },
    get on() { return on; }
  };
  css();
})();
