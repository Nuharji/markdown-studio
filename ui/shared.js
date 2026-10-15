/* Settings shared by all Studio apps (the same file in every app; Rust: shared.rs): theme, language and the work
   folder in <config dir>/Studio/shared.json. Studio Hub edits them; every app takes them over at start and whenever
   its window gets the focus, and passes its own theme / language changes on — so all apps look and speak alike.
   Shared.init({apply(s)}) → applies the shared values (s.theme, s.lang); Shared.push({theme, lang}) after a change. */
(() => {
  'use strict';
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
  let known = {}, hooks = null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function pull() {
    if (!invoke || !hooks) return known;
    const s = await invoke('shared_get').catch(() => null);
    if (!s || same(s, known)) return known;
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
  window.Shared = {init(h) { hooks = h; return pull(); }, push, pull, get values() { return known; }};
})();
