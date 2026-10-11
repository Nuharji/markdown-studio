/* Loading information while files open (the same file in every Studio app): a card with the file name, what is
   happening and a real progress bar. The app reports its steps with their share of the bar; the Rust side reports bytes
   read and parsed ("load-progress" events: {id, done, total}). The card only appears when opening takes a moment.
   const job = LoadBar.start(name); job.step(label, from, to, {busy}); job.set(fraction, detail); job.done();
   Steps named after the Rust side's phases follow its events by themselves:
   job.plan({read: {label, from, to, next: 'parse'}, parse: {…, next: 'prepare'}, prepare: {…, busy: true}}, 'read') */
(() => {
  'use strict';
  const jobs = new Map();
  let seq = 0, box = null;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const num = (n, d) => n.toLocaleString(document.documentElement.lang || undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
  const mb = (done, total) => `${num(done / 1048576, total >= 10485760 ? 0 : 1)} / ${num(total / 1048576, total >= 10485760 ? 0 : 1)} MB`;

  const css = document.createElement('style');
  css.textContent = `.loadbox{position:fixed;left:50%;top:28%;transform:translateX(-50%);z-index:300;display:flex;flex-direction:column;gap:10px;width:min(420px,90vw);pointer-events:none}
    .load-card{background:var(--panel,#262626);color:var(--text,#ddd);border:1px solid var(--border,#3c3c3c);border-radius:10px;padding:14px 16px;box-shadow:0 10px 34px rgba(0,0,0,.35);font-size:12px}
    .load-name{font-weight:600;color:var(--strong,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px}
    .load-row{display:flex;justify-content:space-between;gap:10px;color:var(--dim,#999);margin-bottom:8px}
    .load-bar{height:6px;border-radius:3px;background:var(--border,#3c3c3c);overflow:hidden;position:relative}
    .load-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--accent,#378ef0);transition:width .18s ease}
    .load-card.busy .load-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:loadshine 1.1s linear infinite}
    @keyframes loadshine{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
    body:has(.modal-bg.show) .loadbox{display:none}`;
  document.head.append(css);

  function draw() {
    const shown = [...jobs.values()].filter(j => j.shown);
    if (!shown.length) { if (box) box.remove(); box = null; return; }
    if (!box) { box = document.createElement('div'); box.className = 'loadbox'; box.setAttribute('role', 'status'); document.body.append(box); }
    box.innerHTML = shown.map(j => `<div class="load-card${j.busy ? ' busy' : ''}"><div class="load-name">${esc(j.name)}</div>
      <div class="load-row"><span>${esc(j.label)}</span><span>${esc(j.detail)}${j.detail ? ' · ' : ''}${Math.round(j.pct * 100)} %</span></div>
      <div class="load-bar"><div class="load-fill" style="width:${(j.pct * 100).toFixed(1)}%"></div></div></div>`).join('');
  }

  function start(name) {
    const job = {id: ++seq, name, pct: 0, label: '', detail: '', from: 0, to: 1, busy: false, shown: false};
    job.timer = setTimeout(() => { job.shown = true; draw(); }, 300);
    // In a step without measurable progress the bar creeps on slowly (never past 90 % of the step), so it doesn't look stuck.
    job.creep = setInterval(() => { if (job.busy && job.shown) { job.pct += (job.from + (job.to - job.from) * .9 - job.pct) * .04; draw(); } }, 200);
    /* A step that fills the bar from `from` to `to` (0…1); busy = no measurable progress inside it. */
    job.step = (label, from, to, o = {}) => { Object.assign(job, {label, from, to, busy: !!o.busy, detail: ''}); job.pct = Math.max(job.pct, from); if (job.shown) draw(); return job; };
    job.set = (fraction, detail = '') => {
      job.pct = Math.max(job.pct, job.from + (job.to - job.from) * Math.min(1, Math.max(0, fraction)));
      job.detail = detail; job.busy = false;
      if (job.shown) draw();
    };
    /* Named steps: Rust events with that phase move to them; a finished step goes on to its `next`. */
    job.plan = (steps, first) => { job.steps = steps; return job.go(first); };
    job.go = name => { const s = job.steps && job.steps[name]; if (s) { job.cur = name; job.step(s.label, s.from, s.to, {busy: s.busy}); } return job; };
    job.done = () => { clearTimeout(job.timer); clearInterval(job.creep); jobs.delete(job.id); draw(); };
    jobs.set(job.id, job);
    return job;
  }

  // Bytes read / parsed by the Rust side.
  if (window.__TAURI__) window.__TAURI__.event.listen('load-progress', ev => {
    const p = ev.payload || {}, job = jobs.get(p.id);
    if (!job) return;
    if (p.phase && job.steps && job.steps[p.phase] && job.cur !== p.phase) job.go(p.phase);
    if (p.total) job.set(p.done / p.total, mb(p.done, p.total));
    else { job.busy = true; if (job.shown) draw(); }   // a step without measurable progress
    const s = job.steps && job.steps[job.cur];
    if (p.total && p.done >= p.total && s && s.next) job.go(s.next);
  });

  window.LoadBar = {start};
})();
