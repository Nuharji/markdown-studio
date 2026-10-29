/* Folders in Markdown Studio (loaded after app.js and using its helpers; the Rust side is folder.rs):
   - File → Open Folder: a sidebar with the folder's subfolders and notes — filter, new note / subfolder, rename (the
     [[links]] to a renamed note are updated), sorting notes into subfolders by dragging or with "Move to…"
   - Graph (View → Graph of Notes, Alt+G): the network of the notes — [[links]] and links to other .md files — in a
     force layout; colors are the subfolders, notes that are linked but not created yet are hollow
   - Links tab in the side panel: the current note's neighborhood as a small graph, what links here and where it links to
   - Folders can be hidden from the graph (right-click → Hide in Graph): their notes stay in the tree, but leave both graphs
   Dragging a note from the sidebar into the editor writes a [[link]] to it. */
'use strict';
window.Folder = (() => {
  let root = null, tree = null, treeKey = '', graph = null, filter = '', selected = null, editing = false;
  let expanded = new Set(), byPath = new Map(), recentFolders = [], visible = false, width = 260, graphOpen = false;
  let ctx = null, dragPath = null, localDepth = 1, showMissing = true, groupFilter = null, search = '';
  let hiddenBy = {};   // root → folders whose notes the graph leaves out

  const sepOf = p => p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const under = (p, dir) => typeof p === 'string' && !!dir && (p === dir || p.startsWith(dir + sepOf(dir)));
  const baseName = p => p.split(/[\\/]/).pop();
  const parentOf = p => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
  const stem = n => n.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
  const relDir = p => p === root ? baseName(root) : baseName(root) + '/' + p.slice(root.length + 1).replace(/\\/g, '/');
  const docPath = d => d && typeof d.handle === 'string' ? d.handle : null;
  const linksTabOn = () => settings.dock && settings.dockTab === 'links';
  const hiddenDirs = () => (root && hiddenBy[root]) || [];
  const isHidden = p => hiddenDirs().some(d => under(p, d));

  const SVG = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
    newNote: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/></svg>',
    newFolder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/></svg>',
    graph: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.3 7.1l7.4.6M7 8.3l1.4 7.3M16.6 10.1l-5.9 6"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="m7 15 5-5 5 5"/><path d="M5 20h14"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 8.5 4.3 9.5 6a15 15 0 0 1-2.8 3.4M6.6 7.6A15 15 0 0 0 2.5 12c1 1.7 4.5 6 9.5 6a9.6 9.6 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
  };

  /* ================= Opening and the tree ================= */
  async function pick() {
    if (!invoke) return;
    try { const tr = await invoke('open_folder'); if (tr) openTree(tr); }
    catch (e) { toast(t('toast.folderFail', {e})); }
  }
  async function openPath(path) {
    try { openTree(await invoke('folder_tree', {root: path})); }
    catch (e) { recentFolders = recentFolders.filter(p => p !== path); renderAll(); saveSession(); toast(t('fd.gone', {name: path})); }
  }
  function openTree(tr) {
    if (tr.root !== root) { expanded = new Set(); graph = null; groupFilter = null; bigView.reset(); localView.reset(); }
    root = tr.root; visible = true;
    recentFolders = [root, ...recentFolders.filter(p => p !== root)].slice(0, 8);
    setTree(tr, true);
    layout(); renderAll(); saveSession(); loadGraph();
  }
  function close() {
    root = tree = graph = null; treeKey = ''; visible = false;
    if (graphOpen) showGraph(false);
    layout(); renderAll(); saveSession();
  }
  function setTree(tr, force) {
    const key = JSON.stringify(tr);
    if (!force && key === treeKey) return false;
    treeKey = key; tree = tr; byPath = new Map();
    const walk = list => list.forEach(e => { byPath.set(e.path, e); if (e.dir) walk(e.children); });
    walk(tr.children);
    return true;
  }
  /* The folder is checked every 4 s and when the window gets focus, so notes made or changed by other programs show up. */
  async function refresh(force = false) {
    if (!root) return;
    let tr;
    try { tr = await invoke('folder_tree', {root}); }
    catch (e) { const r = root; close(); return toast(t('fd.gone', {name: r})); }
    if (tr.root !== root || !setTree(tr, force)) return;
    if (!editing) renderTree();
    graphSoon(force ? 0 : 300);
  }
  setInterval(() => { if (root && !editing && document.visibilityState === 'visible') refresh(); }, 4000);
  window.addEventListener('focus', () => refresh());

  function layout() {
    const on = !!invoke && visible;
    $('.main').classList.toggle('has-files', on);
    $('#files').hidden = !on;
    $('#files').style.width = width + 'px';
  }
  function renderAll() { renderTree(); if (linksTabOn()) renderLinks(); }

  function renderTree() {
    const box = $('#filesTree'), head = $('#filesName'), foot = $('#filesFoot');
    $$('#files [data-fd-root]').forEach(b => b.disabled = !root);
    if (!root || !tree) {
      head.textContent = t('fd.title'); head.title = ''; foot.textContent = '';
      box.innerHTML = `<div class="empty">${esc(t('fd.none'))}<br><br><button class="btn-sm primary" data-act="openFolder">${esc(t('a.openFolder'))}</button></div>` +
        (recentFolders.length ? `<div class="sect">${esc(t('fd.recent'))}</div>` + recentFolders.map(p =>
          `<button class="ft-recent" data-folder="${esc(p)}" title="${esc(p)}">${SVG.folder}<span>${esc(baseName(p))}</span></button>`).join('') : '');
      return;
    }
    head.textContent = tree.name; head.title = tree.root;
    foot.textContent = t('fd.notes', {n: num(tree.files)}) + (tree.truncated ? ' · ' + t('fd.truncated', {n: num(tree.files)}) : '');
    const q = filter.trim().toLowerCase(), act = docPath(cur());
    const dirty = new Set(docs.filter(d => d.dirty).map(docPath).filter(Boolean));
    const keep = e => !q || (e.dir ? e.name.toLowerCase().includes(q) || e.children.some(keep) : stem(e.name).toLowerCase().includes(q));
    const count = e => e.children.reduce((n, c) => n + (c.dir ? count(c) : 1), 0);
    const hidden = hiddenDirs();
    const row = (e, depth) => {
      if (!keep(e)) return '';
      const pad = `style="padding-left:${6 + depth * 14}px"`, sel = e.path === selected ? ' sel' : '';
      if (e.dir) {
        const open = !!q || expanded.has(e.path), off = hidden.includes(e.path);
        return `<div class="ft-row ft-dir${sel}${off ? ' ft-off' : ''}" data-path="${esc(e.path)}" data-dir="1" draggable="true" ${pad}>` +
          `<span class="ft-caret">${open ? '▾' : '▸'}</span>${SVG.folder}<span class="ft-name">${esc(e.name)}</span>` +
          (off ? `<button class="ft-unhide" data-unhide="${esc(e.path)}" title="${esc(t('fd.hiddenTip'))}">${SVG.eyeOff}</button>` : '') +
          `<small>${count(e) || ''}</small></div>` +
          (open ? `<div class="ft-kids" data-in="${esc(e.path)}">${e.children.map(c => row(c, depth + 1)).join('')}</div>` : '');
      }
      return `<div class="ft-row ft-note${sel}${e.path === act ? ' active' : ''}${dirty.has(e.path) ? ' dirty' : ''}" data-path="${esc(e.path)}" draggable="true" ${pad} title="${esc(e.name)}">` +
        `<span class="ft-caret"></span>${SVG.note}<span class="ft-name">${esc(stem(e.name))}</span></div>`;
    };
    const html = tree.children.map(e => row(e, 0)).join('');
    box.innerHTML = `<div class="ft-kids ft-top" data-in="${esc(root)}">${html}</div>` +
      (!html ? `<div class="empty">${esc(t(q ? 'fd.noMatch' : 'fd.empty'))}</div>` : '');
    const a = box.querySelector('.ft-row.active');
    if (a && !q) showRow(a);
  }
  /* Scrolls the tree so a row is visible (by hand: scrollIntoView would move the app frame too). */
  function showRow(el) {
    const box = $('#filesTree'), r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top; else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }
  /* Opens every folder above a note, so it can be seen in the tree. */
  function reveal(path) {
    let p = parentOf(path);
    while (p && under(p, root) && p !== root) { expanded.add(p); p = parentOf(p); }
  }

  async function openNote(path) {
    try { openNative([await invoke('read_file', {path})]); }
    catch (e) { toast(t('toast.missing', {name: baseName(path)})); refresh(true); }
  }

  $('#filesTree').addEventListener('click', e => {
    const rf = e.target.closest('[data-folder]');
    if (rf) return openPath(rf.dataset.folder);
    const uh = e.target.closest('[data-unhide]');
    if (uh) return hideDir(uh.dataset.unhide, false);
    const r = e.target.closest('.ft-row'); if (!r || editing) return;
    selected = r.dataset.path;
    if (r.dataset.dir) { expanded.has(selected) ? expanded.delete(selected) : expanded.add(selected); renderTree(); saveSession(); }
    else openNote(selected);
  });
  $('#filesTree').addEventListener('keydown', e => {
    if (e.key === 'F2' && selected && !editing) { e.preventDefault(); rename(selected); }
  });
  $('#filesFilter').addEventListener('input', e => { filter = e.target.value; renderTree(); });
  $('#files').addEventListener('click', e => {
    const b = e.target.closest('[data-fd]'); if (!b || b.disabled) return;
    const dir = selectedDir();
    ({newNote: () => newItem(dir, 'note'), newFolder: () => newItem(dir, 'folder'), graph: () => showGraph(true),
      collapse: () => { expanded.clear(); renderTree(); saveSession(); }, close})[b.dataset.fd]();
  });
  /* The folder new things go into: the selected folder, or the folder of the selected or current note. */
  function selectedDir() {
    const p = selected || docPath(cur());
    if (!p || !under(p, root)) return root;
    const e = byPath.get(p);
    return e && e.dir ? p : parentOf(p);
  }

  /* Width of the sidebar: drag its right edge. */
  $('#filesResize').addEventListener('pointerdown', e => {
    const el = e.currentTarget, x0 = e.clientX, w0 = width;
    el.setPointerCapture(e.pointerId); el.classList.add('drag');
    const move = ev => { width = Math.min(520, Math.max(170, w0 + ev.clientX - x0)); $('#files').style.width = width + 'px'; };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => { el.removeEventListener('pointermove', move); el.classList.remove('drag'); saveSession(); }, {once: true});
  });

  /* ================= New, rename, move ================= */
  /* A name typed right in the tree: Enter takes it, Escape or an empty name cancels. */
  function inlineInput(host, value, onDone) {
    editing = true;
    const inp = document.createElement('input');
    inp.className = 'ft-input'; inp.value = value; inp.spellcheck = false;
    host.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = async ok => {
      if (done) return; done = true;
      const v = inp.value.trim();
      editing = false;
      if (ok && v && v !== value) await onDone(v); else renderTree();
    };
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }
  function newItem(dir, kind) {
    if (!root) return;
    if (dir !== root) expanded.add(dir);
    filter = ''; $('#filesFilter').value = '';
    renderTree();
    const box = $$('#filesTree .ft-kids').find(k => k.dataset.in === dir) || $('#filesTree .ft-top');
    const depth = dir === root ? 0 : dir.slice(root.length + 1).split(/[\\/]/).length;
    const rowEl = document.createElement('div');
    rowEl.className = 'ft-row ft-new'; rowEl.style.paddingLeft = (6 + depth * 14) + 'px';
    rowEl.innerHTML = `<span class="ft-caret"></span>${kind === 'note' ? SVG.note : SVG.folder}<span class="ft-name"></span>`;
    box.prepend(rowEl);
    showRow(rowEl);
    inlineInput(rowEl.querySelector('.ft-name'), '', async name => {
      try {
        const p = await invoke('folder_create', {root, dir, name, kind});
        selected = p;
        if (kind === 'folder') expanded.add(p);
        await refresh(true); renderTree();
        if (kind === 'note') openNote(p); else toast(t('fd.created', {name: baseName(p)}));
      } catch (e) { toast(String(e)); renderTree(); }
    });
    // An empty name cancels, but the placeholder row must go too.
    const inp = $('#filesTree .ft-input'); if (inp) inp.placeholder = t(kind === 'note' ? 'fd.newNoteName' : 'fd.newFolderName');
  }
  function rename(path) {
    const el = $$('#filesTree .ft-row').find(r => r.dataset.path === path);
    if (!el) return;
    const e = byPath.get(path), isNote = e && !e.dir;
    inlineInput(el.querySelector('.ft-name'), isNote ? stem(e.name) : e ? e.name : baseName(path), async name => {
      const skip = docs.filter(d => d.dirty).map(docPath).filter(Boolean);
      try {
        const r = await invoke('folder_rename', {root, path, name, updateLinks: true, skip});
        moved(path, r.path);
        let msg = t('fd.renamed', {name: isNote ? stem(baseName(r.path)) : baseName(r.path)});
        if (r.updated.length) msg += ' · ' + t('fd.linksUpdated', {n: r.updated.length});
        toast(msg);
        if (isNote && docs.some(d => d.dirty && (d === cur() ? ed.value : d.content).toLowerCase().includes('[[' + stem(e.name).toLowerCase())))
          setTimeout(() => toast(t('fd.linksSkipped')), 2600);
        await refresh(true); checkDisk();
      } catch (err) { toast(String(err)); renderTree(); }
    });
  }
  async function move(path, dir) {
    if (!root || parentOf(path) === dir || under(dir, path)) return;
    try {
      const to = await invoke('folder_move', {root, path, to: dir});
      moved(path, to);
      if (dir !== root) expanded.add(dir);
      toast(t('fd.moved', {name: stem(baseName(path)), dir: relDir(dir)}));
      await refresh(true);
    } catch (e) { toast(String(e)); }
  }
  /* A note or folder got a new path: open documents, recent files and the tree follow. */
  function moved(from, to) {
    const map = p => to + p.slice(from.length);
    docs.forEach(d => { if (under(d.handle, from)) { d.handle = map(d.handle); d.name = baseName(d.handle); } });
    recent.forEach(r => { if (under(r.path, from)) { r.path = map(r.path); r.name = baseName(r.path); } });
    expanded = new Set([...expanded].map(p => under(p, from) ? map(p) : p));
    if (root && hiddenBy[root]) { hiddenBy[root] = hiddenBy[root].map(p => under(p, from) ? map(p) : p); graphSoon(0); }
    if (selected && under(selected, from)) selected = map(selected);
    renderTabs(); updateTitle(); saveSession();
  }
  function moveDialog(path) {
    const dirs = [root];
    const walk = list => list.forEach(e => { if (e.dir) { if (!under(e.path, path)) dirs.push(e.path); walk(e.children); } });
    walk(tree.children);
    const from = parentOf(path);
    modal(t('fd.moveTitle', {name: stem(baseName(path))}), `<p class="hint">${esc(t('fd.moveHint'))}</p><div class="ft-moves">` + dirs.map((d, i) => {
      const depth = d === root ? 0 : d.slice(root.length + 1).split(/[\\/]/).length;
      return `<button class="ft-move" data-i="${i}" style="padding-left:${10 + depth * 16}px"${d === from ? ' disabled' : ''}>${SVG.folder}<span>${esc(d === root ? baseName(root) : baseName(d))}</span></button>`;
    }).join('') + '</div>');
    $$('.ft-move').forEach(b => b.onclick = () => { closeModal(); move(path, dirs[+b.dataset.i]); });
  }

  /* Drag and drop: notes and folders onto a folder (or the empty area = the top level); into the editor = a [[link]]. */
  const tree$ = $('#filesTree');
  tree$.addEventListener('dragstart', e => {
    const r = e.target.closest('.ft-row');
    if (!r || editing) return e.preventDefault();
    dragPath = r.dataset.path;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('application/x-md-path', dragPath);
    if (!r.dataset.dir) e.dataTransfer.setData('text/plain', `[[${stem(baseName(dragPath))}]]`);
  });
  tree$.addEventListener('dragend', () => { dragPath = null; $$('.ft-drop').forEach(x => x.classList.remove('ft-drop')); });
  const dropDir = e => {
    const r = e.target.closest('.ft-row');
    if (!r) return root;
    return r.dataset.dir ? r.dataset.path : parentOf(r.dataset.path);
  };
  tree$.addEventListener('dragover', e => {
    if (!dragPath) return;
    const dir = dropDir(e);
    if (under(dir, dragPath)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    $$('.ft-drop').forEach(x => x.classList.remove('ft-drop'));
    const target = dir === root ? tree$ : $$('#filesTree .ft-row').find(x => x.dataset.path === dir);
    if (target) target.classList.add('ft-drop');
  });
  tree$.addEventListener('dragleave', e => { if (!tree$.contains(e.relatedTarget)) $$('.ft-drop').forEach(x => x.classList.remove('ft-drop')); });
  tree$.addEventListener('drop', e => {
    if (!dragPath) return;
    e.preventDefault(); e.stopPropagation();
    const path = dragPath, dir = dropDir(e);
    dragPath = null; $$('.ft-drop').forEach(x => x.classList.remove('ft-drop'));
    move(path, dir);
  });
  ed.addEventListener('drop', e => {
    const p = e.dataTransfer.getData('application/x-md-path');
    if (!p || !cur()) return;
    e.preventDefault(); e.stopPropagation();
    if (!byPath.get(p) || byPath.get(p).dir) return;
    insertAtCursor(`[[${stem(baseName(p))}]]`);
  });
  ed.addEventListener('dragover', e => { if (dragPath) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });

  /* ================= Right-click menu (app.js asks first) ================= */
  function menu(e) {
    if (!e.target.closest('#files') || !root || editing || e.target.closest('input')) return null;
    const r = e.target.closest('#filesTree .ft-row');
    ctx = r ? {path: r.dataset.path, dir: !!r.dataset.dir} : {path: root, dir: true, top: true};
    if (r) selected = ctx.path;
    const items = [];
    if (r && !ctx.dir) items.push({id: 'fd:open', label: t('fd.open')}, {id: 'fd:link', label: t('fd.insertLink'), enabled: !!cur()},
      {id: 'fd:graph', label: t('fd.showGraph')}, null);
    items.push({id: 'fd:newNote', label: t('fd.newNote')}, {id: 'fd:newFolder', label: t('fd.newFolder')});
    if (r) items.push(null, {id: 'fd:rename', label: t('fd.rename'), accel: 'F2'}, {id: 'fd:move', label: t('fd.moveTo')});
    if (r && ctx.dir) items.push(hiddenDirs().includes(ctx.path) ? {id: 'fd:unhide', label: t('fd.unhide')}
      : {id: 'fd:hide', label: t('fd.hide'), enabled: !isHidden(ctx.path)});
    if (hiddenDirs().length) items.push({id: 'fd:unhideAll', label: t('fd.unhideAll', {n: hiddenDirs().length})});
    items.push(null, {id: 'fd:collapse', label: t('fd.collapse')}, {id: 'fd:refresh', label: t('fd.refresh')}, {id: 'fd:close', label: t('fd.close')});
    return items;
  }
  function action(id) {
    if (!ctx || !root) return;
    const {path, dir} = ctx, inDir = dir ? path : parentOf(path);
    ({
      'fd:open': () => openNote(path),
      'fd:link': () => insertAtCursor(`[[${stem(baseName(path))}]]`),
      'fd:graph': () => { showGraph(true); bigView.focusKey(path); },
      'fd:newNote': () => newItem(inDir, 'note'),
      'fd:newFolder': () => newItem(inDir, 'folder'),
      'fd:rename': () => rename(path),
      'fd:move': () => moveDialog(path),
      'fd:hide': () => hideDir(path, true),
      'fd:unhide': () => hideDir(path, false),
      'fd:unhideAll': () => hideDir(null, false),
      'fd:collapse': () => { expanded.clear(); renderTree(); saveSession(); },
      'fd:refresh': () => refresh(true),
      'fd:close': close
    })[id]?.();
  }

  /* ================= Folders hidden from the graph ================= */
  /* dir null with on = false shows all folders again. A folder inside a hidden one needs no entry of its own. */
  function hideDir(dir, on) {
    if (!root) return;
    let list = hiddenDirs();
    if (on) list = [...list.filter(d => !under(d, dir)), dir];
    else list = dir == null ? [] : list.filter(d => d !== dir);
    if (list.length) hiddenBy[root] = list; else delete hiddenBy[root];
    if (on && groupFilter != null && dir === root + sepOf(root) + groupFilter) groupFilter = null;
    renderTree(); saveSession();
    bigView.autoFit = true; localView.autoFit = true; drawGraphs();
    toast(t(on ? 'fd.hidden' : dir == null ? 'fd.unhiddenAll' : 'fd.unhidden', {name: dir == null ? '' : relDir(dir)}));
  }

  /* ================= The graph ================= */
  let graphT = 0, graphSeq = 0;
  /* The links come from Rust; notes with unsaved edits count with their current text. */
  async function loadGraph() {
    if (!root || !invoke) return;
    const my = ++graphSeq, r = root;
    const open = docs.filter(d => d.dirty && under(docPath(d), root)).map(d => [d.handle, d === cur() ? ed.value : d.content]);
    const g = await invoke('folder_graph', {root, open}).catch(() => null);
    if (my !== graphSeq || !g || r !== root) return;
    graph = g;
    drawGraphs();
  }
  const graphSoon = (ms = 1200) => { clearTimeout(graphT); graphT = setTimeout(loadGraph, ms); };
  const keyOf = n => n.missing ? '?' + n.name.toLowerCase() : n.path;
  const groupOf = n => n.missing ? '' : n.folder.split('/')[0];
  const PALETTE = ['#378ef0', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#d6409f', '#3e63dd', '#ad7f58', '#7c8a00'];
  function groupColors() {
    const groups = [...new Set(graph.nodes.filter(n => !n.missing).map(groupOf))].filter(Boolean).sort((a, b) => a.localeCompare(b, lang));
    const m = new Map([['', '#8b95a1']]);
    groups.forEach((g, i) => m.set(g, PALETTE[i % PALETTE.length]));
    return m;
  }
  function drawGraphs() {
    if (!graph) return;
    if (graphOpen) drawBig();
    if (linksTabOn()) renderLinks();
  }

  /* A force layout on a canvas: notes push each other away, links pull like springs, notes of one subfolder stay
     together. Positions are kept by note, so an update only moves what changed. */
  class NetView {
    constructor(canvas, opts) {
      this.cv = canvas; this.g = canvas.getContext('2d'); this.opts = opts;
      this.nodes = []; this.links = []; this.adj = []; this.pos = new Map();
      this.view = {x: 0, y: 0, k: 1}; this.alpha = 0; this.hover = -1; this.drag = null; this.pan = null; this.raf = 0; this.autoFit = true;
      this.mark = '';
      canvas.addEventListener('pointerdown', e => this.down(e));
      canvas.addEventListener('pointermove', e => this.move(e));
      canvas.addEventListener('pointerup', e => this.up(e));
      canvas.addEventListener('pointerleave', () => { if (!this.drag && !this.pan && this.hover >= 0) { this.hover = -1; this.draw(); } });
      canvas.addEventListener('wheel', e => this.wheel(e), {passive: false});
      canvas.addEventListener('dblclick', () => { this.fit(); this.draw(); });
      new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas);
    }
    reset() { this.pos = new Map(); this.autoFit = true; }
    /* nodes: [{key, name, path, folder, missing, color, current}], links: [[a, b]] */
    setData(nodes, links) {
      const old = this.pos, cx = this.nodes.length ? this.nodes.reduce((s, n) => s + n.x, 0) / this.nodes.length : 0;
      this.pos = new Map();
      let fresh = 0;
      this.nodes = nodes.map((n, i) => {
        const p = old.get(n.key), a = i * 2.39996, r = 14 * Math.sqrt(i + 1);
        if (!p) fresh++;
        const o = {...n, x: p ? p.x : cx + Math.cos(a) * r, y: p ? p.y : Math.sin(a) * r, vx: 0, vy: 0, deg: 0};
        this.pos.set(n.key, o);
        return o;
      });
      // A new note that links to a known one starts next to it.
      this.links = links.map(([a, b]) => ({a, b}));
      this.adj = nodes.map(() => new Set());
      for (const l of this.links) {
        this.nodes[l.a].deg++; this.nodes[l.b].deg++; this.adj[l.a].add(l.b); this.adj[l.b].add(l.a);
        const A = this.nodes[l.a], B = this.nodes[l.b];
        if (!old.has(A.key) && old.has(B.key)) { A.x = B.x + (Math.random() - .5) * 30; A.y = B.y + (Math.random() - .5) * 30; }
        if (!old.has(B.key) && old.has(A.key)) { B.x = A.x + (Math.random() - .5) * 30; B.y = A.y + (Math.random() - .5) * 30; }
      }
      if (this.hover >= this.nodes.length) this.hover = -1;
      if (this.drag) this.drag = null;
      this.kick(fresh > nodes.length / 3 ? 1 : fresh ? 0.5 : 0.15);
    }
    kick(a) { this.alpha = Math.max(this.alpha, a); this.loop(); }
    loop() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (!this.cv.offsetParent) return;   // hidden: continues when shown (kick)
        for (let i = 0; i < (this.nodes.length > 600 ? 1 : 2); i++) this.tick();
        if (this.autoFit && this.alpha > 0.03) this.fit();
        this.draw();
        if (this.alpha > 0.004 || this.drag) this.loop();
      });
    }
    tick() {
      const N = this.nodes, n = N.length, a = this.alpha, local = this.opts.local;
      if (!n) return;
      const rep = local ? 1600 : 1100, len = local ? 70 : 55;
      for (let i = 0; i < n; i++) {
        const p = N[i];
        for (let j = i + 1; j < n; j++) {
          const q = N[j];
          let dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
          if (d2 > 160000) continue;
          if (d2 < 0.01) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 0.5; }
          const f = rep * a / d2;
          p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
        }
      }
      for (const l of this.links) {
        const p = N[l.a], q = N[l.b], dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - len) / d * 0.08 * a, fx = dx * f, fy = dy * f;
        p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
      }
      // Notes of the same subfolder are drawn to their middle.
      const mid = new Map();
      for (const p of N) { const m = mid.get(p.group) || {x: 0, y: 0, n: 0}; m.x += p.x; m.y += p.y; m.n++; mid.set(p.group, m); }
      for (const p of N) {
        const m = mid.get(p.group);
        if (m.n > 1 && p.group) { p.vx += (m.x / m.n - p.x) * 0.012 * a; p.vy += (m.y / m.n - p.y) * 0.012 * a; }
        const grav = p.deg ? 0.006 : 0.05;
        p.vx -= p.x * grav * a; p.vy -= p.y * grav * a;
      }
      for (const p of N) {
        if (this.drag && this.drag.n === p) { p.vx = p.vy = 0; continue; }
        p.vx *= 0.6; p.vy *= 0.6;
        const v = Math.hypot(p.vx, p.vy); if (v > 40) { p.vx *= 40 / v; p.vy *= 40 / v; }
        p.x += p.vx; p.y += p.vy;
      }
      this.alpha *= this.drag ? 1 : 0.982;
    }
    resize() {
      const dpr = window.devicePixelRatio || 1, w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    }
    radius(p) { return (this.opts.local ? 4.5 : 3.5) + Math.sqrt(p.deg) * 1.7 + (p.current ? 2 : 0); }
    fit() {
      const N = this.nodes, W = this.cv.clientWidth, H = this.cv.clientHeight;
      if (!N.length || !W || !H) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of N) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      const pad = this.opts.local ? 50 : 70, k = Math.min((W - pad) / Math.max(1, x1 - x0), (H - pad) / Math.max(1, y1 - y0), this.opts.local ? 1.6 : 2.2);
      this.view = {k: Math.max(0.05, k), x: -(x0 + x1) / 2 * k, y: -(y0 + y1) / 2 * k};
    }
    focusKey(key) {
      const i = this.nodes.findIndex(n => n.key === key);
      if (i < 0) return;
      this.autoFit = false;
      const p = this.nodes[i];
      this.view.k = Math.max(this.view.k, 1.2); this.view.x = -p.x * this.view.k; this.view.y = -p.y * this.view.k;
      this.hover = i; this.draw();
    }
    toWorld(e) {
      const r = this.cv.getBoundingClientRect(), v = this.view;
      return {x: (e.clientX - r.left - r.width / 2 - v.x) / v.k, y: (e.clientY - r.top - r.height / 2 - v.y) / v.k};
    }
    hit(e) {
      const w = this.toWorld(e);
      let best = -1, bd = Infinity;
      this.nodes.forEach((p, i) => {
        const d = Math.hypot(p.x - w.x, p.y - w.y), r = this.radius(p) + 4 / this.view.k;
        if (d <= r && d < bd) { best = i; bd = d; }
      });
      return best;
    }
    down(e) {
      if (e.button !== 0) return;
      this.cv.setPointerCapture(e.pointerId);
      const i = this.hit(e);
      if (i >= 0) { this.drag = {n: this.nodes[i], i, moved: false, sx: e.clientX, sy: e.clientY}; this.kick(0.08); }
      else this.pan = {sx: e.clientX, sy: e.clientY, x: this.view.x, y: this.view.y, moved: false};
    }
    move(e) {
      if (this.drag) {
        if (Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy) > 3) this.drag.moved = true;
        if (!this.drag.moved) return;
        const w = this.toWorld(e); this.drag.n.x = w.x; this.drag.n.y = w.y;
        this.autoFit = false; this.kick(0.25);
        return;
      }
      if (this.pan) {
        const dx = e.clientX - this.pan.sx, dy = e.clientY - this.pan.sy;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.pan.moved = true;
        this.view.x = this.pan.x + dx; this.view.y = this.pan.y + dy; this.autoFit = false; this.draw();
        return;
      }
      const i = this.hit(e);
      if (i !== this.hover) { this.hover = i; this.cv.style.cursor = i >= 0 ? 'pointer' : ''; this.draw(); }
    }
    up(e) {
      const d = this.drag;
      this.drag = null; this.pan = null;
      if (d && !d.moved) this.opts.onOpen(this.nodes[d.i]);
    }
    wheel(e) {
      e.preventDefault();
      const r = this.cv.getBoundingClientRect(), v = this.view;
      const sx = e.clientX - r.left - r.width / 2, sy = e.clientY - r.top - r.height / 2;
      const k = Math.min(6, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)));
      v.x = sx - (sx - v.x) * k / v.k; v.y = sy - (sy - v.y) * k / v.k; v.k = k;
      this.autoFit = false; this.draw();
    }
    draw() {
      const {g, cv} = this, W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!W || !H) return;
      this.resize();
      const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
      const text = col('--text'), dim = col('--dim'), accent = col('--accent'), line = col('--border'), bg = col('--panel');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const v = this.view;
      g.translate(W / 2 + v.x, H / 2 + v.y); g.scale(v.k, v.k);
      const N = this.nodes, focus = this.hover >= 0 ? this.hover : this.drag ? this.drag.i : -1;
      const near = focus >= 0 ? this.adj[focus] : null, mark = this.mark;
      const lit = i => focus < 0 || i === focus || near.has(i);
      g.lineWidth = 1 / v.k;
      for (const l of this.links) {
        const p = N[l.a], q = N[l.b], on = focus >= 0 && (l.a === focus || l.b === focus);
        g.strokeStyle = on ? accent : line;
        g.globalAlpha = focus < 0 ? 0.9 : on ? 1 : 0.2;
        g.lineWidth = (on ? 1.6 : 1) / v.k;
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
        // Arrow head: where the link points.
        if (on || this.opts.local) {
          const r = this.radius(q) + 1, dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, s = 5 / Math.max(v.k, .6);
          const tx = q.x - ux * r, ty = q.y - uy * r;
          g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx - ux * s - uy * s * .6, ty - uy * s + ux * s * .6); g.lineTo(tx - ux * s + uy * s * .6, ty - uy * s - ux * s * .6);
          g.closePath(); g.fillStyle = on ? accent : line; g.fill();
        }
      }
      N.forEach((p, i) => {
        const r = this.radius(p);
        g.globalAlpha = lit(i) ? 1 : 0.18;
        g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
        if (p.missing) { g.fillStyle = bg; g.fill(); g.strokeStyle = dim; g.lineWidth = 1.2 / v.k; g.setLineDash([2 / v.k, 2 / v.k]); g.stroke(); g.setLineDash([]); }
        else { g.fillStyle = p.color; g.fill(); }
        if (p.current || (mark && p.name.toLowerCase().includes(mark))) {
          g.beginPath(); g.arc(p.x, p.y, r + 3 / v.k, 0, Math.PI * 2);
          g.strokeStyle = p.current ? accent : '#f5a524'; g.lineWidth = 2 / v.k; g.stroke();
        }
      });
      // Names: always in the small graph, otherwise when zoomed in, near the mouse or found by the search.
      const fs = 11 / v.k;
      g.font = `${fs}px ${col('--font-ui') || 'sans-serif'}`; g.textAlign = 'center'; g.textBaseline = 'top';
      N.forEach((p, i) => {
        const found = mark && p.name.toLowerCase().includes(mark);
        const show = this.opts.local || v.k > 0.85 || found || p.current || (focus >= 0 && lit(i)) || N.length < 40;
        if (!show) return;
        g.globalAlpha = lit(i) ? (p.missing ? 0.7 : 1) : 0.15;
        g.fillStyle = i === focus ? col('--strong') : p.missing ? dim : text;
        const label = p.name.length > 32 ? p.name.slice(0, 30) + '…' : p.name;
        g.fillText(label, p.x, p.y + this.radius(p) + 3 / v.k);
      });
      g.globalAlpha = 1;
    }
  }

  const openGraphNode = async n => {
    if (!n.missing) { showGraph(false); return openNote(n.path); }
    // A note that is linked but doesn't exist yet: made next to the first note linking to it.
    const i = graph.nodes.findIndex(x => keyOf(x) === n.key), from = graph.links.find(([, b]) => b === i);
    if (!from) return;
    try {
      const f = await invoke('create_note', {from: graph.nodes[from[0]].path, name: n.name});
      showGraph(false); openNative([f]); refresh(true);
    } catch (e) { toast(String(e)); }
  };
  const bigView = new NetView($('#graphCanvas'), {onOpen: openGraphNode});
  const localView = new NetView($('#localCanvas'), {local: true, onOpen: n => n.current ? null : openGraphNode(n)});

  /* Turns (a part of) the Rust graph into what NetView draws; `keep` decides which nodes. */
  function subgraph(keep) {
    const colors = groupColors(), act = docPath(cur()), idx = new Map(), nodes = [];
    const out = hiddenSet(act);
    graph.nodes.forEach((n, i) => {
      if (out.has(i) || !keep(n, i)) return;
      idx.set(i, nodes.length);
      nodes.push({key: keyOf(n), name: n.missing ? n.name : n.name, path: n.path, folder: n.folder, missing: n.missing,
        group: groupOf(n), color: colors.get(groupOf(n)) || colors.get(''), current: !!act && n.path === act});
    });
    const links = graph.links.filter(([a, b]) => idx.has(a) && idx.has(b)).map(([a, b]) => [idx.get(a), idx.get(b)]);
    return {nodes, links, colors};
  }
  /* The nodes left out because of hidden folders (the current note always stays): notes in them, and notes not created
     yet that only they link to. */
  function hiddenSet(act) {
    const out = new Set();
    if (!hiddenDirs().length) return out;
    graph.nodes.forEach((n, i) => { if (!n.missing && n.path !== act && isHidden(n.path)) out.add(i); });
    const linked = new Set(graph.links.filter(([a]) => !out.has(a)).map(([, b]) => b));
    graph.nodes.forEach((n, i) => { if (n.missing && !linked.has(i)) out.add(i); });
    return out;
  }
  function drawBig() {
    if (!graph) { $('#graphStats').textContent = ''; return; }
    const {nodes, links, colors} = subgraph(n => (showMissing || !n.missing) && (groupFilter == null || (!n.missing && groupOf(n) === groupFilter)));
    bigView.mark = search.trim().toLowerCase();
    bigView.setData(nodes, links);
    $('#graphStats').textContent = t('gr.stats', {n: num(nodes.filter(n => !n.missing).length), l: num(links.length)});
    const counts = new Map(), out = hiddenSet(docPath(cur()));
    graph.nodes.forEach((n, i) => { if (!n.missing && !out.has(i)) counts.set(groupOf(n), (counts.get(groupOf(n)) || 0) + 1); });
    $('#graphLegend').innerHTML = [...colors].filter(([g]) => counts.has(g)).map(([g, c]) =>
      `<button class="gl-item${groupFilter === g ? ' active' : ''}${groupFilter != null && groupFilter !== g ? ' off' : ''}" data-group="${esc(g)}" title="${esc(t('gr.filterTip'))}">` +
      `<i style="background:${c}"></i>${esc(g || t('gr.top'))}<small>${counts.get(g)}</small></button>`).join('') +
      (groupFilter != null ? `<button class="gl-item" data-group-all="1">${esc(t('gr.all'))}</button>` : '') +
      hiddenDirs().map(d => `<button class="gl-item gl-hidden" data-unhide="${esc(d)}" title="${esc(t('gr.unhideTip'))}">` +
        `${SVG.eyeOff}${esc(relDir(d))}</button>`).join('');
  }
  function showGraph(on = !graphOpen) {
    if (on && !root) { toast(t('fd.needFolder')); return pick(); }
    graphOpen = on;
    $('.center').classList.toggle('graph-on', on);
    $('#graphView').hidden = !on;
    syncDisabled();
    if (on) {
      if (graph) drawBig();
      bigView.autoFit = true; bigView.kick(0.3);
      loadGraph();
    } else ed.focus({preventScroll: true});
  }
  $('#graphLegend').addEventListener('click', e => {
    const uh = e.target.closest('[data-unhide]');
    if (uh) return hideDir(uh.dataset.unhide, false);
    const b = e.target.closest('[data-group],[data-group-all]'); if (!b) return;
    groupFilter = b.dataset.groupAll || groupFilter === b.dataset.group ? null : b.dataset.group;
    bigView.autoFit = true; drawBig();
  });
  $('#graphSearch').addEventListener('input', e => { search = e.target.value; bigView.mark = search.trim().toLowerCase(); bigView.draw(); });
  $('#graphSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q = search.trim().toLowerCase(), n = bigView.nodes.find(x => x.name.toLowerCase().includes(q));
    if (n) bigView.focusKey(n.key);
  });
  $('#graphMissing').addEventListener('change', e => { showMissing = e.target.checked; drawBig(); });
  $('#graphFit').onclick = () => { bigView.fit(); bigView.draw(); };
  $('#graphClose').onclick = () => showGraph(false);

  /* ================= Links tab: the current note's neighborhood ================= */
  function renderLinks() {
    const box = $('#linksList'), wrap = $('#localWrap'), d = cur(), p = docPath(d);
    const msg = (text, button) => { wrap.hidden = true; box.innerHTML = `<div class="empty">${esc(text)}${button ? `<br><br><button class="btn-sm primary" data-act="openFolder">${esc(t('a.openFolder'))}</button>` : ''}</div>`; };
    if (!invoke || !root) return msg(t('fd.noLinksTab'), !!invoke);
    if (!d) return msg(t('fd.noLinksTab'));
    if (!p) return msg(t('fd.saveFirst'));
    if (!under(p, root)) return msg(t('fd.notInFolder'));
    if (!graph) { wrap.hidden = true; box.innerHTML = ''; return graphSoon(0); }
    const me = graph.nodes.findIndex(n => n.path === p);
    if (me < 0) { wrap.hidden = true; box.innerHTML = ''; return; }
    // Nodes up to `localDepth` links away (in either direction).
    const dist = new Map([[me, 0]]);
    let front = [me];
    for (let k = 0; k < localDepth; k++) {
      const next = [];
      for (const [a, b] of graph.links) {
        if (front.includes(a) && !dist.has(b)) { dist.set(b, k + 1); next.push(b); }
        if (front.includes(b) && !dist.has(a)) { dist.set(a, k + 1); next.push(a); }
      }
      front = next;
    }
    wrap.hidden = false;
    $$('#localDepth button').forEach(b => b.classList.toggle('active', +b.dataset.depth === localDepth));
    const {nodes, links} = subgraph((n, i) => dist.has(i));
    localView.setData(nodes, links);
    const into = graph.links.filter(([, b]) => b === me).map(([a]) => a), out = graph.links.filter(([a]) => a === me).map(([, b]) => b);
    const colors = groupColors();
    const item = i => {
      const n = graph.nodes[i];
      return `<button class="lk-item${n.missing ? ' missing' : ''}" data-node="${i}"><i style="background:${n.missing ? 'transparent' : colors.get(groupOf(n))}"></i>` +
        `<span>${esc(n.name)}</span><small>${esc(n.missing ? t('fd.missing') : n.folder || '')}</small></button>`;
    };
    box.innerHTML = `<div class="sect">${esc(t('fd.backlinks', {n: into.length}))}</div>` +
      (into.length ? into.map(item).join('') : `<div class="lk-none">${esc(t('fd.noBacklinks'))}</div>`) +
      `<div class="sect">${esc(t('fd.outgoing', {n: out.length}))}</div>` +
      (out.length ? out.map(item).join('') : `<div class="lk-none">${esc(t('fd.noOutgoing'))}</div>`);
  }
  $('#linksList').addEventListener('click', e => {
    const b = e.target.closest('[data-node]'); if (!b || !graph) return;
    const n = graph.nodes[+b.dataset.node];
    openGraphNode({...n, key: keyOf(n)});
  });
  $('#localDepth').addEventListener('click', e => {
    const b = e.target.closest('[data-depth]'); if (!b) return;
    localDepth = +b.dataset.depth; localView.autoFit = true; renderLinks(); saveSession();
  });
  $('#localWhole').onclick = () => { showGraph(true); const p = docPath(cur()); if (p) setTimeout(() => bigView.focusKey(p), 400); };

  /* ================= Hooks called by app.js ================= */
  function onActive() {
    if (graphOpen) showGraph(false);
    const p = docPath(cur());
    if (root && under(p, root)) { selected = p; reveal(p); }
    if (root && !editing) renderTree();
    if (linksTabOn()) renderLinks();
  }
  const onDirty = () => { if (root && !editing) renderTree(); };
  const typed = () => { if (root && (graphOpen || linksTabOn()) && under(docPath(cur()), root)) graphSoon(1500); };
  const saved = () => { if (root) refresh(true); };
  let pending = null;   // the saved folder while it is being opened again
  const state = () => ({root: root || pending, expanded: [...expanded], recent: recentFolders, visible, width, depth: localDepth, hidden: hiddenBy});
  function restore(s) {
    if (!s || !invoke) return layout();
    recentFolders = s.recent || []; width = s.width || width; localDepth = s.depth || 1; hiddenBy = s.hidden || {};
    visible = !!s.visible;
    layout();
    if (s.root) {
      pending = s.root;
      invoke('folder_tree', {root: s.root}).then(tr => { pending = null; openTree(tr); visible = !!s.visible; expanded = new Set(s.expanded || []); layout(); onActive(); })
        .catch(() => { pending = null; visible = false; layout(); renderTree(); });
    }
    else renderTree();
  }
  function toggle() { visible = !visible; layout(); renderTree(); saveSession(); }
  function language() {
    $$('#files [data-fd]').forEach(b => b.title = t({newNote: 'fd.newNote', newFolder: 'fd.newFolder', graph: 'a.graph', collapse: 'fd.collapse', close: 'fd.close'}[b.dataset.fd]));
    renderAll(); if (graphOpen) drawBig();
  }
  $$('#files [data-fd]').forEach(b => b.innerHTML = SVG[b.dataset.fd]);
  // app.js's start may already be over when this file loads (then it couldn't hand over the saved folder).
  if (booted) { try { restore((JSON.parse(localStorage.getItem(STORE)) || {}).folder); } catch (e) {} }

  return {pick, close, toggle, showGraph, menu, action, onActive, onDirty, typed, saved, state, restore, renderLinks, language,
    get root() { return root; }, get visible() { return visible && !!invoke; }, get graphOpen() { return graphOpen; }, under,
    graphData: () => graph, views: {bigView, localView}, hideDir, get hidden() { return hiddenDirs(); }};
})();
