/* School features of Markdown Studio (loaded after app.js and using its helpers):
   - Sources panel: the sources of the ```quellen block, a form to add one, citing with [@key] (markdown.rs formats them)
   - Templates: Referat, Hausarbeit / Facharbeit, Versuchsprotokoll, Unterrichtsnotiz, Lernzettel
   - Sketches: a drawing pad (mouse, pen with pressure) whose strokes are kept as a ```sketch block
   - Notes: [[Note]] links open Note.md from the same folder, or create it there
   - Export as Word (.docx, written in Rust: docx.rs) and as PDF (the print dialog's "Save as PDF") */
'use strict';
window.School = (() => {
  const today = () => new Date().toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB');

  /* ================= Sources ================= */
  const LANGS = ['quellen', 'sources', 'references', 'literatur', 'bibliography'];
  let sourcesT = 0, list = [];
  async function renderSources() {
    const box = $('#srcList'); if (!box) return;
    list = cur() ? await invoke('md_sources', {text: ed.value}).catch(() => []) : [];
    box.innerHTML = list.length ? list.map((s, i) => `<div class="src-item" data-i="${i}">
        <div class="src-main"><b>${esc(s.author || '—')}</b> (${esc(s.year || '—')})<br><span>${esc(s.title)}</span></div>
        <div class="src-side"><code>@${esc(s.key)}</code><button class="btn-sm" data-cite="${i}">${esc(t('src.cite'))}</button></div></div>`).join('')
      : `<div class="empty">${esc(t('src.empty'))}</div>`;
  }
  const renderSourcesSoon = () => { clearTimeout(sourcesT); sourcesT = setTimeout(renderSources, 400); };
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-cite]');
    if (c) { const s = list[+c.dataset.cite]; if (s) insertAtCursor(`[@${s.key}]`); return; }
    const it = e.target.closest('.src-item');
    if (it && list[+it.dataset.i]) gotoLine(list[+it.dataset.i].line);
  });
  /* A new source from the form: a key like "mueller2020" (unique), appended to the sources block — which is created
     at the end of the document (with a heading) when there is none yet. */
  function addSource() {
    if (!cur()) A.newDoc();
    const v = id => $('#' + id).value.trim().replace(/\|/g, '/');
    const author = v('srcAuthor'), title = v('srcTitle'), year = v('srcYear'), place = v('srcPlace');
    let accessed = v('srcAccessed');
    if (!author && !title) return toast(t('src.need'));
    if (/^https?:\/\//.test(place) && !accessed) accessed = today();
    const base = ((author.split(/[,;]/)[0] || title).normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').replace(/\p{M}/gu, '').toLowerCase().slice(0, 16) || 'quelle') + (year.replace(/\D/g, '') || '');
    let key = base, n = 2;
    while (list.some(s => s.key === key)) key = base + String.fromCharCode(96 + n++);
    const line = `${key}: ${[author, title, year, place, accessed].join(' | ').replace(/( \| )+$/, '')}`;
    const lines = ed.value.split('\n');
    // The end of the first sources block, if there is one.
    let open = -1, end = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(```|~~~)\s*(\S*)/.exec(lines[i]);
      if (!m) continue;
      if (open < 0 && LANGS.includes(m[2].toLowerCase())) open = i;
      else if (open >= 0 && !m[2]) { end = i; break; }
    }
    if (open >= 0 && end > open) {
      const pos = lines.slice(0, end).join('\n').length + 1;
      replaceRange(pos, pos, line + '\n');
    } else {
      const head = `\n\n## ${t('src.heading')}\n\n\`\`\`quellen\n${line}\n\`\`\`\n`;
      const pos = ed.value.replace(/\s+$/, '').length;
      replaceRange(pos, ed.value.length, head);
    }
    ['srcAuthor', 'srcTitle', 'srcYear', 'srcPlace', 'srcAccessed'].forEach(id => $('#' + id).value = '');
    toast(t('src.added', {key}));
    renderSourcesSoon();
  }

  /* ================= Templates ================= */
  const TEMPLATES = ['referat', 'hausarbeit', 'protokoll', 'notiz', 'lernzettel'];
  function templates() {
    const l = lang === 'de' ? 'de' : 'en';
    modal(t('tpl.title'), `<p class="hint">${esc(t('tpl.hint'))}</p><div class="tpl-grid">` + TEMPLATES.map(k =>
      `<button class="tpl-card" data-tpl="${k}"><b>${esc(t('tpl.' + k))}</b><span>${esc(t('tpl.' + k + '.d'))}</span></button>`).join('') + '</div>');
    $$('[data-tpl]').forEach(b => b.onclick = () => {
      const k = b.dataset.tpl, src = $(`#tpl-${k}-${l}`).textContent.trim().replace(/\{date\}/g, today()) + '\n';
      closeModal();
      openDoc(`${t('tpl.' + k)}.md`, src);
    });
  }

  /* ================= Notes ([[links]]) ================= */
  async function openNote(name) {
    const d = cur();
    if (!invoke || !d || typeof d.handle !== 'string') return toast(t('note.saveFirst'));
    try {
      const f = await invoke('find_note', {from: d.handle, name}) || await invoke('create_note', {from: d.handle, name});
      openNative([f]);
    } catch (e) { toast(String(e)); }
  }

  /* ================= Sketches ================= */
  const COLORS = ['#1f2328', '#e5484d', '#378ef0', '#30a46c', '#f5a524', '#8e4ec6'], SW = 1000, SH = 560;
  function sketchBlocks() {
    // [start, end] character offsets of every ```sketch block's content, in order.
    const out = [], re = /^([ \t]*)(```|~~~)[ \t]*sketch[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
    let m;
    while ((m = re.exec(ed.value))) { const start = m.index + m[0].indexOf('\n') + 1; out.push([start, start + m[3].length]); }
    return out;
  }
  function sketch(index = null) {
    if (!cur()) A.newDoc();
    let data = {w: SW, h: SH, s: []};
    const blocks = sketchBlocks();
    if (index != null && blocks[index]) { try { data = JSON.parse(ed.value.slice(...blocks[index])); } catch (e) {} }
    let color = COLORS[0], width = 4, stroke = null;
    modal(t('sk.title'), `<div class="sk-tools">${COLORS.map((c, i) => `<button class="sk-col${i ? '' : ' active'}" data-col="${c}" style="background:${c}"></button>`).join('')}
      <span class="sep"></span>${[2, 4, 8, 16].map(w => `<button class="btn-sm sk-w${w === 4 ? ' active' : ''}" data-w="${w}">${w}</button>`).join('')}
      <span class="flex"></span><button class="btn-sm" data-sk="undo">${esc(t('sk.undo'))}</button><button class="btn-sm" data-sk="clear">${esc(t('sk.clear'))}</button></div>
      <canvas class="sk-pad" width="${data.w}" height="${data.h}"></canvas><p class="hint">${esc(t('sk.hint'))}</p>`);
    $('.modal').classList.add('wide');
    $('#modalFoot').hidden = false;
    $('#modalFoot').innerHTML = `<span class="flex"></span><button class="btn-sm" data-sk="cancel">${esc(t('confirm.cancel'))}</button>
      <button class="btn-sm primary" data-sk="ok">${esc(t(index != null ? 'sk.update' : 'sk.insert'))}</button>`;
    const cv = $('.sk-pad'), g = cv.getContext('2d');
    const draw = () => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      g.lineCap = g.lineJoin = 'round';
      for (const [c, w, pts] of data.s) {
        const p = pts.reduce((a, q) => a + (q[2] ?? 0.5), 0) / pts.length;
        g.strokeStyle = c; g.lineWidth = Math.max(0.5, w * (0.5 + p)); g.beginPath();
        pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
        if (pts.length === 1) g.lineTo(pts[0][0] + 0.1, pts[0][1]);
        g.stroke();
      }
    };
    const at = e => { const r = cv.getBoundingClientRect(); return [Math.round((e.clientX - r.left) / r.width * cv.width * 10) / 10, Math.round((e.clientY - r.top) / r.height * cv.height * 10) / 10, Math.round((e.pointerType === 'pen' ? e.pressure : 0.5) * 100) / 100]; };
    cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); stroke = [color, width, [at(e)]]; data.s.push(stroke); draw(); };
    cv.onpointermove = e => { if (!stroke) return; const p = at(e), last = stroke[2][stroke[2].length - 1]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) { stroke[2].push(p); draw(); } };
    cv.onpointerup = cv.onpointercancel = () => { stroke = null; };
    const body = $('#modal');
    const onClick = e => {
      const c = e.target.closest('[data-col]'), w = e.target.closest('[data-w]'), a = e.target.closest('[data-sk]');
      if (c) { color = c.dataset.col; $$('.sk-col').forEach(x => x.classList.toggle('active', x === c)); }
      if (w) { width = +w.dataset.w; $$('.sk-w').forEach(x => x.classList.toggle('active', x === w)); }
      if (!a) return;
      if (a.dataset.sk === 'undo') { data.s.pop(); draw(); }
      if (a.dataset.sk === 'clear') { data.s = []; draw(); }
      if (a.dataset.sk === 'cancel') done();
      if (a.dataset.sk === 'ok') {
        const json = JSON.stringify({w: data.w, h: data.h, s: data.s});
        done();
        const blocks2 = sketchBlocks();
        if (index != null && blocks2[index]) replaceRange(blocks2[index][0], blocks2[index][1], json + '\n');
        else insertBlock('```sketch\n' + json + '\n```');
      }
    };
    const done = () => { body.removeEventListener('click', onClick); closeModal(); };
    body.addEventListener('click', onClick);
    draw();
  }

  /* ================= Export ================= */
  async function exportDocx() {
    await render();
    const d = cur(), pictures = [];
    // Diagrams and sketches go into the Word file as pictures, drawn on white.
    for (const [kind, sel] of [['diagram', '.diagram'], ['sketch', '.sketch']]) {
      const els = [...paper.querySelectorAll(sel)];
      for (let i = 0; i < els.length; i++) {
        const svg = els[i].querySelector('svg'); if (!svg) continue;
        try {
          const {xml, w, h} = standaloneSvg(svg);
          pictures.push({kind, index: i, png: Array.from(await svgToPng(xml, w, h, 2, '#ffffff')), w, h});
        } catch (e) {}
      }
    }
    try {
      const path = await invoke('export_docx', {text: ed.value, title: d.name.replace(/\.[^.]+$/, '') || 'document', lang,
        path: typeof d.handle === 'string' ? d.handle : null, pictures});
      if (path) toast(t('toast.exported', {name: path}));
    } catch (e) { toast(t('toast.exportFail', {e})); }
  }
  async function exportPdf() { toast(t('pdf.hint')); setTimeout(() => A.print(), 900); }

  return {renderSources, renderSourcesSoon, addSource, templates, openNote, sketch, exportDocx, exportPdf};
})();
$('#srcAdd') && ($('#srcAdd').onclick = () => School.addSource());
