/* The link to Agent Studio (the same file in every Studio app; Rust: agentlink.rs). "Send to Agent Studio": a file,
   a selection or a text with a task goes to Agent Studio (it is started when it isn't open), Claude works on it there,
   and the answer and the files it made come back here as a card in the corner (open, show in Agent Studio, OK).
   AgentLink.init({app, lang(), open(path) → false when the app can't open it (the system then does),
                  actions(result) → [{label, run}],
                  onStatus(status)})
   AgentLink.send({title, files, selection, content, dir, presets: [{label, task, level, format}]}) → the dialog
   AgentLink.sendNow({title, task, files, …}) → without a dialog; AgentLink.status → Agent Studio's state (or null);
   AgentLink.open() → opens Agent Studio. */
(() => {
  'use strict';
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
  const T = {
    en: {send: 'Send to Agent Studio', task: 'Task for Claude', taskPh: 'What should Claude do?', edit: 'May create and change files in this folder',
      web: 'May use the internet', go: 'Send', cancel: 'Cancel', file: 'File', sel: 'Selection ({n} characters)', text: 'Text ({n} characters)',
      own: 'Own task', closed: 'Agent Studio is not open — it will be started.', noApp: 'Only in the app (not in the browser).',
      waiting: 'Waiting for Agent Studio …', running: 'Claude is working …', needsYou: 'Needs you in Agent Studio', done: 'Done',
      failed: 'Did not work', stopped: 'Stopped', declined: 'Not started', open: 'Open', inAgent: 'In Agent Studio', ok: 'OK', more: 'More',
      sent: 'Sent to Agent Studio', newFiles: 'New / changed files'},
    de: {send: 'An Agent Studio senden', task: 'Auftrag für Claude', taskPh: 'Was soll Claude tun?', edit: 'Darf in diesem Ordner Dateien anlegen und ändern',
      web: 'Darf ins Internet', go: 'Senden', cancel: 'Abbrechen', file: 'Datei', sel: 'Auswahl ({n} Zeichen)', text: 'Text ({n} Zeichen)',
      own: 'Eigener Auftrag', closed: 'Agent Studio ist nicht offen — es wird gestartet.', noApp: 'Nur in der App (nicht im Browser).',
      waiting: 'Wartet auf Agent Studio …', running: 'Claude arbeitet …', needsYou: 'Braucht dich in Agent Studio', done: 'Fertig',
      failed: 'Hat nicht geklappt', stopped: 'Angehalten', declined: 'Nicht gestartet', open: 'Öffnen', inAgent: 'In Agent Studio', ok: 'OK', more: 'Mehr',
      sent: 'An Agent Studio gesendet', newFiles: 'Neue / geänderte Dateien'}
  };
  let o = {app: '', lang: () => 'en'}, status = null, alive = false, results = [], waiting = [], pollT = 0;
  const local = {};       // sent here, not yet seen in Agent Studio's folders: id → {id, title, status, created}
  const gone = new Set(); // dismissed
  const t = (k, v) => { let s = (T[o.lang() === 'de' ? 'de' : 'en'])[k] || k; for (const x in v || {}) s = s.split('{' + x + '}').join(v[x]); return s; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  const dirOf = p => String(p || '').replace(/[\\/][^\\/]*$/, '');

  const css = `
.al-ov{position:fixed;inset:0;background:var(--overlay,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;z-index:9000}
.al-dlg{background:var(--modal-bg,var(--panel,#222));color:var(--text,#eee);border:1px solid var(--border,#444);border-radius:var(--radius,10px);box-shadow:var(--shadow,0 10px 40px rgba(0,0,0,.4));width:min(560px,92vw);max-height:88vh;overflow:auto;padding:18px 20px;font-family:var(--font-ui,system-ui);font-size:13px}
.al-dlg h2{margin:0 0 10px;font-size:16px;display:flex;align-items:center;gap:8px}
.al-what{color:var(--dim,#999);margin-bottom:10px;word-break:break-all}
.al-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.al-chip{border:1px solid var(--border,#444);background:var(--input-bg,transparent);color:var(--text,#eee);border-radius:999px;padding:4px 11px;cursor:pointer;font:inherit}
.al-chip.on{background:var(--cta,#4a7);color:var(--on-accent,#fff);border-color:transparent}
.al-dlg label.al-l{display:block;color:var(--dim,#999);margin:4px 0}
.al-dlg textarea{width:100%;box-sizing:border-box;min-height:96px;resize:vertical;background:var(--input-bg,#111);color:var(--text,#eee);border:1px solid var(--input-border,var(--border,#444));border-radius:8px;padding:8px;font:inherit}
.al-sw{display:flex;align-items:center;gap:8px;margin:8px 0 0;cursor:pointer}
.al-hint{color:var(--dim,#999);margin-top:10px;font-size:12px}
.al-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.al-btn{border:1px solid var(--border,#444);background:transparent;color:var(--text,#eee);border-radius:var(--btn-radius,6px);padding:5px 14px;cursor:pointer;font:inherit}
.al-btn.pri{background:var(--cta,#4a7);color:var(--on-accent,#fff);border-color:transparent}
.al-btn:disabled{opacity:.5;cursor:default}
.al-tray{position:fixed;right:14px;bottom:34px;display:flex;flex-direction:column;gap:8px;z-index:8500;max-width:min(380px,90vw);font-family:var(--font-ui,system-ui);font-size:12.5px}
.al-card{background:var(--modal-bg,var(--panel,#222));color:var(--text,#eee);border:1px solid var(--border,#444);border-radius:var(--radius,10px);box-shadow:var(--shadow,0 6px 24px rgba(0,0,0,.35));padding:10px 12px}
.al-card .al-h{display:flex;align-items:center;gap:7px;font-weight:600}
.al-card .al-h span.al-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al-card .al-x{border:0;background:none;color:var(--dim,#999);cursor:pointer;font-size:14px;padding:0 2px}
.al-st{color:var(--dim,#999);margin:3px 0}
.al-st.done{color:var(--ok,#5b5)}.al-st.failed,.al-st.declined{color:var(--danger,#d55)}.al-st.needsYou{color:var(--warn,#d93)}
.al-sum{white-space:pre-wrap;max-height:9em;overflow:hidden;margin:4px 0;line-height:1.4}
.al-sum.all{max-height:40vh;overflow:auto}
.al-files{margin:4px 0;display:flex;flex-direction:column;gap:3px}
.al-files div{display:flex;align-items:center;gap:6px}.al-files span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al-card .al-btns{margin-top:6px;gap:6px}.al-card .al-btn{padding:3px 10px}
.al-dot{width:8px;height:8px;border-radius:50%;background:var(--accent,#4a7);flex:none}
.al-dot.running,.al-dot.waiting{animation:al-p 1.2s ease-in-out infinite}.al-dot.failed,.al-dot.declined{background:var(--danger,#d55)}.al-dot.needsYou{background:var(--warn,#d93)}.al-dot.done{background:var(--ok,#5b5)}
@keyframes al-p{50%{opacity:.3}}`;
  function style() {
    if (document.getElementById('al-css')) return;
    const s = document.createElement('style'); s.id = 'al-css'; s.textContent = css; document.head.append(s);
  }

  /* ---- Agent Studio's folders ---- */
  async function poll() {
    clearTimeout(pollT);
    if (!invoke || !o.app) return;
    const r = await invoke('agent_poll', {from: o.app}).catch(() => null);
    if (r) {
      status = r.status || null; alive = !!r.alive; results = r.results || []; waiting = r.waiting || [];
      for (const id of Object.keys(local)) if (results.some(x => x.id === id) || waiting.some(x => x.id === id) || Date.now() - local[id].created > 10 * 60000) delete local[id];
      if (o.onStatus) try { o.onStatus(status, alive); } catch (e) {}
      draw();
    }
    const busy = waiting.length || Object.keys(local).length || results.some(x => x.status === 'running');
    pollT = setTimeout(poll, busy ? 2500 : 30000);
  }
  async function sendNow(task) {
    if (!invoke) { alert(t('noApp')); return null; }
    const id = await invoke('agent_send', {task: {app: o.app, lang: o.lang(), ...task}}).catch(e => { alert(String(e)); return null; });
    if (id) { local[id] = {id, title: task.title || '', status: 'waiting', created: Date.now()}; draw(); setTimeout(poll, 600); }
    return id;
  }

  /* ---- The dialog ---- */
  function send(x = {}) {
    style();
    const files = (x.files || []).filter(Boolean), presets = [...(x.presets || []), {label: t('own'), task: '', level: 'read'}];
    let pick = 0;
    const ov = document.createElement('div'); ov.className = 'al-ov';
    const what = files.length ? files.map(f => `📄 ${esc(base(f))}`).join('<br>') : '';
    const extra = x.selection ? t('sel', {n: x.selection.length}) : x.content ? t('text', {n: x.content.length}) : '';
    const folder = x.dir || (files[0] ? dirOf(files[0]) : '');
    ov.innerHTML = `<div class="al-dlg" role="dialog"><h2><span class="al-dot"></span>${esc(t('send'))}</h2>
      <div class="al-what" title="${esc(files.join('\n'))}">${what}${what && extra ? '<br>' : ''}${esc(extra)}</div>
      <div class="al-chips">${presets.map((p, i) => `<button class="al-chip${i === 0 ? ' on' : ''}" data-p="${i}">${esc(p.label)}</button>`).join('')}</div>
      <label class="al-l">${esc(t('task'))}</label><textarea placeholder="${esc(t('taskPh'))}"></textarea>
      ${folder ? `<label class="al-sw"><input type="checkbox" data-k="edit"> ${esc(t('edit'))}</label>` : ''}
      <label class="al-sw"><input type="checkbox" data-k="web"> ${esc(t('web'))}</label>
      ${alive ? '' : `<div class="al-hint">${esc(t('closed'))}</div>`}
      <div class="al-btns"><button class="al-btn" data-a="no">${esc(t('cancel'))}</button><button class="al-btn pri" data-a="go">${esc(t('go'))}</button></div></div>`;
    const ta = ov.querySelector('textarea'), ed = ov.querySelector('[data-k=edit]'), web = ov.querySelector('[data-k=web]');
    const choose = i => {
      pick = i;
      ov.querySelectorAll('.al-chip').forEach((c, j) => c.classList.toggle('on', j === i));
      ta.value = presets[i].task; if (ed) ed.checked = presets[i].level === 'edit'; web.checked = !!presets[i].web;
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); };
    const go = async () => {
      const task = ta.value.trim(); if (!task) { ta.focus(); return; }
      const p = presets[pick];
      close();
      await sendNow({title: p.task && task === p.task ? p.label : (x.title || task.split('\n')[0].slice(0, 60)), task, files, selection: x.selection || '', content: x.content || '',
        dir: folder, level: ed && ed.checked ? 'edit' : 'read', web: web.checked, format: p.format || ''});
    };
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); go(); }
    };
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    ov.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.p) choose(+b.dataset.p);
      if (b.dataset.a === 'no') close();
      if (b.dataset.a === 'go') go();
    });
    document.addEventListener('keydown', key, true);
    document.body.append(ov);
    choose(0);
    if (invoke) poll();
  }

  /* ---- The cards in the corner ---- */
  let tray = null;
  const open = {};        // id → summary shown in full
  function draw() {
    style();
    const list = [...results, ...waiting.filter(w => !results.some(r => r.id === w.id)),
      ...Object.values(local).filter(l => !results.some(r => r.id === l.id) && !waiting.some(w => w.id === l.id))].filter(r => !gone.has(r.id));
    if (!tray) { tray = document.createElement('div'); tray.className = 'al-tray'; document.body.append(tray); tray.addEventListener('click', click); }
    tray.innerHTML = list.map(r => {
      const st = r.status || 'waiting', acts = st === 'done' && o.actions ? (o.actions(r) || []) : [];
      const sum = String(r.summary || (st === 'needsYou' ? r.question || '' : ''));
      return `<div class="al-card" data-id="${esc(r.id)}"><div class="al-h"><span class="al-dot ${esc(st)}"></span><span class="al-t" title="${esc(r.title)}">${esc(r.title || 'Agent Studio')}</span>
          <button class="al-x" data-a="ack" title="${esc(t('ok'))}">&#10005;</button></div>
        <div class="al-st ${esc(st)}">${esc(t(st))}</div>
        ${sum ? `<div class="al-sum${open[r.id] ? ' all' : ''}">${esc(sum)}</div>${!open[r.id] && sum.length > 300 ? `<button class="al-btn" data-a="more">${esc(t('more'))}</button>` : ''}` : ''}
        ${(r.files || []).length ? `<div class="al-st">${esc(t('newFiles'))}</div><div class="al-files">${r.files.map((f, i) => `<div><span title="${esc(f)}">📄 ${esc(base(f))}</span><button class="al-btn" data-a="file" data-i="${i}">${esc(t('open'))}</button></div>`).join('')}</div>` : ''}
        <div class="al-btns">${acts.map((a, i) => `<button class="al-btn pri" data-a="act" data-i="${i}">${esc(a.label)}</button>`).join('')}
          ${st !== 'waiting' && st !== 'declined' ? `<button class="al-btn" data-a="agent">${esc(t('inAgent'))}</button>` : ''}
          ${st === 'running' || st === 'waiting' ? '' : `<button class="al-btn${acts.length ? '' : ' pri'}" data-a="ack">${esc(t('ok'))}</button>`}</div></div>`;
    }).join('');
  }
  async function click(e) {
    const b = e.target.closest('button'), card = e.target.closest('.al-card'); if (!b || !card) return;
    const id = card.dataset.id, r = results.find(x => x.id === id) || {id};
    const a = b.dataset.a;
    if (a === 'more') { open[id] = true; draw(); }
    if (a === 'agent') AgentLink.open();
    if (a === 'file') {
      const f = r.files[+b.dataset.i];
      try { if (!o.open || await o.open(f) === false) await invoke('agent_open_file', {path: f}); } catch (err) { alert(String(err)); }
    }
    if (a === 'act') { const acts = o.actions ? o.actions(r) || [] : []; const x = acts[+b.dataset.i]; if (x && await x.run(r) !== false) ack(id); }
    if (a === 'ack') ack(id);
  }
  function ack(id) {
    gone.add(id); delete local[id];
    if (invoke && results.some(x => x.id === id)) invoke('agent_ack', {id}).catch(() => {});
    results = results.filter(x => x.id !== id);
    draw();
  }

  window.addEventListener('focus', () => { if (o.app) poll(); });
  window.AgentLink = {
    init(opts) { o = {...o, ...opts}; poll(); return this; },
    send, sendNow, poll,
    open: () => invoke ? invoke('agent_open').then(() => setTimeout(poll, 1500)).catch(() => {}) : null,
    get status() { return status; }, get alive() { return alive; }, get results() { return results; }
  };
})();
