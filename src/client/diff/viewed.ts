import { api } from '../api.js';
import { DIFF, state } from '../state.js';
import { setCollapsed } from './collapse.js';
import { renderSidebarTree } from './sidebar.js';

/* ---------- viewed (確認済み) state ---------- */

// Viewed ("確認済み") state, GitHub "Viewed" semantics. Persisted server-side
// per branch (viewed.json via /api/viewed) as { [filePath]: contentHash }.
// A file counts as viewed only when its stored hash still matches the current
// diff's hash, so a file whose diff changed automatically reverts to unviewed
// (the server does this pruning in POST /api/viewed/reconcile). Moving off
// browser localStorage means marks survive a serve restart on a new port.
// VIEWED_KEY is now only read once, to migrate any legacy localStorage marks
// left over on this origin into the server, then deleted.
const VIEWED_KEY = 'ark-viewed';

// Lightweight, non-cryptographic string hash (djb2). Used only to detect when
// a file's diff content changed since it was marked viewed.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function fileHash(file) {
  return djb2(JSON.stringify(file.hunks || []));
}

// Cache the current hash of every file so lookups during toggle/render are O(1).
export function computeFileHashes() {
  state.fileHashes = {};
  (DIFF.files || []).forEach(function (f) { state.fileHashes[f.path] = fileHash(f); });
}

// Load persisted viewed state from the server. Any legacy localStorage marks
// on this origin are migrated into the server exactly once (then deleted), so
// marks made before this became server-backed are not lost. The server then
// reconciles the stored map against the current diff's hashes (fileHashes),
// dropping files whose diff changed or that are gone. Returns a promise that
// resolves once `viewed` holds the reconciled map. Best-effort: on any
// failure `viewed` is left as {} (everything shows unviewed) rather than
// throwing, so an offline server never blanks the diff.
export function loadViewed() {
  let legacy = {};
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    if (raw) legacy = JSON.parse(raw) || {};
  } catch (e) { legacy = {}; }
  if (!legacy || typeof legacy !== 'object') legacy = {};
  const hasLegacy = Object.keys(legacy).length > 0;

  const migrated = hasLegacy
    ? api('GET', '/api/viewed').then(function (data) {
        // Server wins over legacy on conflict (it is the newer source of
        // truth); reconcile below prunes anything not in the current diff.
        const merged = Object.assign({}, legacy, (data && data.viewed) || {});
        return api('PUT', '/api/viewed', { viewed: merged });
      }).then(function () {
        try { localStorage.removeItem(VIEWED_KEY); } catch (e) { /* ignore */ }
      }, function () { /* migration is best-effort; ignore failures */ })
    : Promise.resolve();

  return migrated.then(function () {
    return api('POST', '/api/viewed/reconcile', { hashes: state.fileHashes });
  }).then(function (data) {
    state.viewed = (data && data.viewed) || {};
  }, function () {
    state.viewed = {};
  });
}

// Persist the current viewed map (full replace). Called on every toggle; the
// whole map is small (one short hash per file) so no debounce is needed.
export function saveViewed() {
  api('PUT', '/api/viewed', { viewed: state.viewed }).catch(function () { /* offline: ignore */ });
}

// Apply the (async-loaded) viewed state to the already-built diff DOM: collapse
// viewed file boxes via the shared 'collapsed' class, sync their toggle
// buttons, and re-split the sidebar tree.
export function applyViewedState() {
  (DIFF.files || []).forEach(function (f, fi) {
    const box = document.getElementById('file-' + fi);
    if (box) {
      const v = isViewed(f.path);
      box.classList.toggle('viewed', v);
      setCollapsed(box, v);
    }
  });
  document.querySelectorAll('.viewed-btn[data-file]').forEach(function (btn: any) {
    updateViewedButton(btn, isViewed(btn.dataset.file));
  });
  renderSidebarTree();
}

export function isViewed(path) {
  return Object.prototype.hasOwnProperty.call(state.viewed, path);
}

export function setFileViewed(path, on) {
  if (on) state.viewed[path] = state.fileHashes[path];
  else delete state.viewed[path];
  saveViewed();
}

// Sync a viewed-toggle button's visuals/ARIA to its on/off state.
export function updateViewedButton(btn, on) {
  btn.classList.toggle('is-viewed', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '確認済みを解除して展開' : '確認済みにして本体を折りたたむ';
  const chk = btn.querySelector('.viewed-check');
  if (chk) chk.textContent = on ? '✓' : '';
}
