/* agent-review-kit review UI — entry module (compiled to ES modules, no bundler) */

import { api } from './api.js';
import { bodySnippet, copyPathButton, esc, fmtDate } from './dom.js';
import { intentFieldHtml, selectedIntent, syncIntentFields } from './intent.js';
import {
  attachDocPanelResize,
  attachPinResize,
  attachSidebarResize,
  clampPinWidth,
  PIN_MIN,
  restoreDocPanelWidth,
  restorePersistedWidths,
  savedPinDefault,
} from './resize.js';
import { app, badge, connState, DIFF, diffMeta, DOC, state } from './state.js';
import {
  commentLocShort,
  isAgentComment,
  pruneThreadCollapse,
  renderThread,
  setThreadCollapsed,
  threadState,
  THREAD_STATE_LABEL,
  threadStructure,
} from './threads.js';
import { docRefresh, initDocMode } from './doc/index.js';

// Viewed ("確認済み") state, GitHub "Viewed" semantics. Persisted server-side
// per branch (viewed.json via /api/viewed) as { [filePath]: contentHash }.
// A file counts as viewed only when its stored hash still matches the current
// diff's hash, so a file whose diff changed automatically reverts to unviewed
// (the server does this pruning in POST /api/viewed/reconcile). Moving off
// browser localStorage means marks survive a serve restart on a new port.
// VIEWED_KEY is now only read once, to migrate any legacy localStorage marks
// left over on this origin into the server, then deleted.
const VIEWED_KEY = 'ark-viewed';

/* ---------- syntax highlighting ----------
 * Highlighting is baked at generate time by Shiki (github-dark) into each
 * diff cell's `html` field (see codeCell). The client only renders that
 * pre-colored markup, so there is no runtime highlighter here. */

/* ---------- viewed (確認済み) state ---------- */

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
function computeFileHashes() {
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
function loadViewed() {
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
function saveViewed() {
  api('PUT', '/api/viewed', { viewed: state.viewed }).catch(function () { /* offline: ignore */ });
}

// Apply the (async-loaded) viewed state to the already-built diff DOM: collapse
// viewed file boxes via the shared 'collapsed' class, sync their toggle
// buttons, and re-split the sidebar tree.
function applyViewedState() {
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

function isViewed(path) {
  return Object.prototype.hasOwnProperty.call(state.viewed, path);
}

function setFileViewed(path, on) {
  if (on) state.viewed[path] = state.fileHashes[path];
  else delete state.viewed[path];
  saveViewed();
}

// Sync a viewed-toggle button's visuals/ARIA to its on/off state.
function updateViewedButton(btn, on) {
  btn.classList.toggle('is-viewed', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '確認済みを解除して展開' : '確認済みにして本体を折りたたむ';
  const chk = btn.querySelector('.viewed-check');
  if (chk) chk.textContent = on ? '✓' : '';
}

/* ---------- diff rendering ---------- */

// Sync the 'collapsed' class on a file box and update its collapse-btn visuals.
// Called by the chevron click handler and by viewed-state toggling so both
// code paths stay in sync without duplicating the button update logic.
function setCollapsed(box, on) {
  box.classList.toggle('collapsed', on);
  const btn = box.querySelector('.collapse-btn');
  if (!btn) return;
  btn.textContent = on ? '▸' : '▾';
  btn.title = on ? '展開する' : '折りたたむ';
  btn.setAttribute('aria-expanded', on ? 'false' : 'true');
}

// Create a collapse-toggle chevron button, wire its click handler, insert it
// at the front of `header`, and return it. Shared by renderDiff (interactive
// boxes) and renderReadOnlyFiles (read-only boxes) so they get identical
// collapse affordances.
function appendCollapseToggle(header, box) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'collapse-btn';
  btn.textContent = '▾';
  btn.title = '折りたたむ';
  btn.setAttribute('aria-label', 'このファイルの表示を折りたたむ');
  btn.setAttribute('aria-expanded', 'true');
  btn.addEventListener('click', function () {
    setCollapsed(box, !box.classList.contains('collapsed'));
  });
  header.insertBefore(btn, header.firstChild);
  return btn;
}

function statusLabel(st) {
  return { modified: 'modified', added: 'added', deleted: 'deleted', renamed: 'renamed', binary: 'binary' }[st] || st;
}

function renderDiff() {
  diffMeta.textContent = (DIFF.base ? 'base: ' + DIFF.base : 'working tree vs HEAD') +
    ' / generated: ' + fmtDate(DIFF.generatedAt);

  // Compute per-file content hashes up front. Persisted viewed state is
  // fetched from the server asynchronously (see below) and applied once the
  // boxes exist, so `viewed` starts empty and every file builds as unviewed.
  computeFileHashes();
  state.viewed = {};

  state.expanders = {};

  const frag = document.createDocumentFragment();

  if (DIFF.files.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '行番号をクリックでコメント、Shift+クリックまたはドラッグで範囲選択できます。';
    frag.appendChild(hint);
  }

  // Overall (not tied to a file/line) comments section, always present.
  frag.appendChild(buildOverallSection());

  if (!DIFF.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-diff';
    empty.innerHTML = '差分がありません。変更を加えてから <code>agent-review-kit generate</code> を再実行してください。';
    frag.appendChild(empty);
    app.innerHTML = '';
    app.appendChild(frag);
    renderComments();
    return;
  }

  // Render .file boxes in tree-traversal order (see treeOrder) so the main
  // diff order matches the sidebar tree. `fi` stays the file's original index
  // in DIFF.files, keeping id (file-<index>) and tree data-target in sync.
  treeOrder(DIFF.files).forEach(function (fi) {
    const file = DIFF.files[fi];
    const box = document.createElement('div');
    box.className = 'file';
    box.id = 'file-' + fi;
    box.dataset.file = file.path;

    const header = document.createElement('div');
    header.className = 'file-header';
    let title = esc(file.path);
    if (file.status === 'renamed' && file.oldPath !== file.path) {
      title = esc(file.oldPath) + ' → ' + esc(file.path);
    }
    header.innerHTML = '<span class="file-status ' + esc(file.status) + '">' +
      esc(statusLabel(file.status)) + '</span><span class="file-name">' + title + '</span>';

    // Collapse toggle (chevron at the far left of the header): hides/shows the
    // file body only. Independent of 確認済み (viewed) and not persisted.
    appendCollapseToggle(header, box);

    header.appendChild(copyPathButton(file.path));

    // 確認済み (Viewed) toggle: collapses this file's body (via the shared
    // 'collapsed' class) and moves it to the "確認済み" section of the tree.
    // Placed to the left of 📌. Checkbox-like.
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'viewed-btn';
    viewBtn.dataset.file = file.path;
    viewBtn.setAttribute('aria-label', 'このファイルを確認済みにする');
    viewBtn.innerHTML =
      '<span class="viewed-check" aria-hidden="true"></span>' +
      '<span class="viewed-label">確認済み</span>';
    viewBtn.addEventListener('click', function () {
      const on = !isViewed(file.path);
      setFileViewed(file.path, on);
      box.classList.toggle('viewed', on);
      setCollapsed(box, on);
      updateViewedButton(viewBtn, on);
      renderSidebarTree();
    });
    header.appendChild(viewBtn);

    // 📌 pin button: opens/refreshes the right-side display-only panel for
    // this file. `fi` is the file's original index in DIFF.files.
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'pin-btn';
    pinBtn.textContent = '📌';
    pinBtn.title = 'このファイルを右側パネルに固定表示（表示専用）';
    pinBtn.setAttribute('aria-label', 'このファイルを右側パネルに固定表示');
    pinBtn.dataset.fileIndex = fi;
    pinBtn.addEventListener('click', function () { togglePin(fi); });
    header.appendChild(pinBtn);

    // Apply persisted viewed state (collapse + button visuals) up front.
    // At initial build time `viewed` is always empty (loaded async below),
    // so these are effectively no-ops; kept for consistency.
    if (isViewed(file.path)) {
      box.classList.add('viewed');
      setCollapsed(box, true);
    }
    updateViewedButton(viewBtn, isViewed(file.path));

    box.appendChild(header);

    if (file.status === 'binary' || !file.hunks.length) {
      const p = document.createElement('div');
      p.className = 'empty-diff';
      p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
      box.appendChild(p);
      frag.appendChild(box);
      return;
    }

    box.appendChild(buildDiffTable(file, true));
    frag.appendChild(box);
  });

  app.innerHTML = '';
  app.appendChild(frag);
  buildSidebar();
  renderComments();

  // Fetch persisted viewed state and apply it to the freshly built boxes.
  // Done after the DOM exists (and after renderComments) so async ordering
  // never leaves comments unrendered; a brief all-unviewed flash is fine.
  loadViewed().then(applyViewedState);
}

// Shared by the standalone /commit and /snapshot pages: same file boxes and
// diff tables as renderDiff (tree-traversal order, matching the sidebar
// tree). Collapse chevrons are included (same as the main diff); viewed/pin
// buttons and comment wiring are not. Context expanders still appear when the
// server embedded new-side content (newLines) for the page.
function renderReadOnlyFiles(frag, emptyText) {
  if (!DIFF.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-diff';
    empty.textContent = emptyText;
    frag.appendChild(empty);
  }

  treeOrder(DIFF.files).forEach(function (fi) {
    const file = DIFF.files[fi];
    const box = document.createElement('div');
    box.className = 'file';
    box.id = 'file-' + fi;
    box.dataset.file = file.path;

    const header = document.createElement('div');
    header.className = 'file-header';
    let title = esc(file.path);
    if (file.status === 'renamed' && file.oldPath !== file.path) {
      title = esc(file.oldPath) + ' → ' + esc(file.path);
    }
    header.innerHTML = '<span class="file-status ' + esc(file.status) + '">' +
      esc(statusLabel(file.status)) + '</span><span class="file-name">' + title + '</span>';
    appendCollapseToggle(header, box);
    header.appendChild(copyPathButton(file.path));
    box.appendChild(header);

    if (file.status === 'binary' || !file.hunks.length) {
      const p = document.createElement('div');
      p.className = 'empty-diff';
      p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
      box.appendChild(p);
    } else {
      box.appendChild(buildDiffTable(file, false));
    }
    frag.appendChild(box);
  });
}

// Read-only render for the /commit/<sha> page (window.__COMMIT__ set).
function renderCommitPage() {
  const c = window.__COMMIT__;
  diffMeta.textContent = c.shortSha + ' / ' + c.author + ' / ' + fmtDate(c.date);

  state.expanders = {};

  const frag = document.createDocumentFragment();

  const banner = document.createElement('div');
  banner.className = 'commit-banner';
  banner.innerHTML =
    '<div class="commit-subject"></div><div class="commit-meta-line"></div>';
  banner.querySelector('.commit-subject').textContent = c.subject;
  banner.querySelector('.commit-meta-line').textContent =
    'commit ' + c.sha + ' — ' + c.author + ' — ' + fmtDate(c.date);
  frag.appendChild(banner);

  renderReadOnlyFiles(frag, 'このコミットには差分がありません。');

  app.innerHTML = '';
  app.appendChild(frag);
  buildReadOnlySidebar();
}

// Read-only render for the /snapshot/<id> page (window.__SNAPSHOT__ set):
// one fix's diff, captured as a patch instead of a commit. The banner names
// the review comment the fix responds to.
function renderSnapshotPage() {
  const s = window.__SNAPSHOT__;
  diffMeta.textContent = '修正 #' + s.seq + ' / ' + fmtDate(s.createdAt);

  state.expanders = {};

  const frag = document.createDocumentFragment();

  const banner = document.createElement('div');
  banner.className = 'commit-banner';
  banner.innerHTML =
    '<div class="commit-subject"></div><div class="commit-meta-line"></div>' +
    '<div class="snapshot-comment"></div>';
  banner.querySelector('.commit-subject').textContent =
    s.title || ('修正スナップショット #' + s.seq);
  banner.querySelector('.commit-meta-line').textContent =
    'snapshot ' + s.id + ' — 修正 #' + s.seq + ' — ' + fmtDate(s.createdAt) +
    ' — コメント ' + s.commentId;
  const commentEl = banner.querySelector('.snapshot-comment');
  if (s.commentBody) {
    commentEl.textContent = '対象コメント: ' + s.commentBody;
  } else {
    commentEl.remove();
  }
  frag.appendChild(banner);

  renderReadOnlyFiles(frag, 'このスナップショットには差分がありません。');

  app.innerHTML = '';
  app.appendChild(frag);
  buildReadOnlySidebar();
}

/* ---------- context expansion (GitHub-style) ---------- */

const EXPAND_STEP = 20;

function hunkRange(hunk) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
  if (!m) return null;
  const oldStart = parseInt(m[1], 10);
  const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
  const newStart = parseInt(m[3], 10);
  const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
  return {
    oldStart: oldStart,
    oldEnd: oldStart + oldCount - 1,
    newStart: newStart,
    newEnd: newStart + newCount - 1,
  };
}

function tryExpandTo(path, side, line) {
  const list = state.expanders[path];
  if (!list) return false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].expandTo(side, line)) return true;
  }
  return false;
}

// Build the <table> for a single file's diff. Reused by the main diff and the
// pin panel. When `interactive` is false the number cells get no data-file, so
// the document-level selection handlers skip them (panel is display-only).
function buildDiffTable(file, interactive) {
  const table = document.createElement('table');
  table.className = 'diff';
  const colgroup = document.createElement('colgroup');
  colgroup.innerHTML =
    '<col class="col-num"><col class="col-code"><col class="col-num"><col class="col-code">';
  table.appendChild(colgroup);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  // Context expansion needs the full new-side content (embedded at generate
  // time). Each gap between hunks (and before/after the outer hunks) gets an
  // expander row whose closure tracks the still-hidden range [lo, hi] in
  // new-side line numbers; `delta` maps them to old-side (old = new + delta).
  const canExpand = Array.isArray(file.newLines) && file.newLines.length > 0;
  const controllers = [];

  function addExpander(lo, hi, delta) {
    const state = { lo: lo, hi: hi, delta: delta };
    const tr = document.createElement('tr');
    tr.className = 'expander-row';
    const td = document.createElement('td');
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);

    // The hunk header row (`tr.hunk`) right after this gap is created later,
    // once file.hunks.forEach reaches it (see below). Once every hidden line
    // in the gap has been revealed, that header is meaningless on its own
    // (no more hidden rows to introduce) and should disappear along with
    // this expander row.
    let headerRow = null;

    function contextRow(n) {
      const raw = file.newLines[n - 1];
      const text = raw === undefined ? '' : raw;
      // Baked Shiki HTML for this new-side line (parallel to newLines), when
      // available. Lets expanded context match the highlighted diff rows.
      const hl = file.newLinesHtml && file.newLinesHtml[n - 1];
      const html = typeof hl === 'string' ? hl : undefined;
      // Expanded lines are not part of the generated diff, so they have no
      // diff position; diffLine 0 marks "expanded context" on saved comments.
      const left = { line: n + delta, text: text, diffLine: 0, kind: 'context', html: html };
      const right = { line: n, text: text, diffLine: 0, kind: 'context', html: html };
      const row = document.createElement('tr');
      row.className = 'diff-row expanded-row';
      row.appendChild(numCell(file, 'old', left, interactive));
      row.appendChild(codeCell(left, 'del'));
      row.appendChild(numCell(file, 'new', right, interactive));
      row.appendChild(codeCell(right, 'add'));
      return row;
    }

    // Reveal the top of the gap (continues downward after the hunk above).
    function revealTop(count) {
      const end = Math.min(state.lo + count - 1, state.hi);
      const frag = document.createDocumentFragment();
      for (let n = state.lo; n <= end; n++) frag.appendChild(contextRow(n));
      tr.before(frag);
      state.lo = end + 1;
      finishReveal();
    }

    // Reveal the bottom of the gap (just above the hunk below).
    function revealBottom(count) {
      const start = Math.max(state.hi - count + 1, state.lo);
      const frag = document.createDocumentFragment();
      for (let n = start; n <= state.hi; n++) frag.appendChild(contextRow(n));
      tr.after(frag);
      state.hi = start - 1;
      finishReveal();
    }

    function finishReveal() {
      renderControls();
    }

    function expanderButton(label, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'expander-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
      });
      return b;
    }

    function renderControls() {
      const remaining = state.hi - state.lo + 1;
      if (remaining <= 0) {
        tr.remove();
        if (headerRow) headerRow.remove();
        return;
      }
      td.innerHTML = '';
      if (remaining > EXPAND_STEP) {
        td.appendChild(expanderButton('↓ ' + EXPAND_STEP + '行',
          '上側（直前のハンクの続き）を' + EXPAND_STEP + '行表示',
          function () { revealTop(EXPAND_STEP); }));
        td.appendChild(expanderButton('↑ ' + EXPAND_STEP + '行',
          '下側（次のハンクの直前）を' + EXPAND_STEP + '行表示',
          function () { revealBottom(EXPAND_STEP); }));
      }
      td.appendChild(expanderButton('すべて表示', '非表示の行をすべて表示',
        function () { revealTop(state.hi - state.lo + 1); }));
      const label = document.createElement('span');
      label.className = 'expander-label';
      label.textContent = remaining + ' 行が非表示';
      td.appendChild(label);
    }

    renderControls();

    controllers.push({
      // Reveal a hidden line by expanding from the nearest edge, keeping the
      // remaining gap contiguous. Returns false when the line isn't here.
      expandTo: function (side, line) {
        const n = side === 'new' ? line : line - state.delta;
        if (n < state.lo || n > state.hi) return false;
        if (n - state.lo <= state.hi - n) revealTop(n - state.lo + 1);
        else revealBottom(state.hi - n + 1);
        return true;
      },
    });

    return {
      // Called once the hunk header row for the hunk right after this gap
      // exists, so renderControls() can remove it together with this
      // expander row when the gap is fully revealed.
      attachHeaderRow: function (hr) {
        headerRow = hr;
      },
    };
  }

  let prevRange = null;
  // Handle for the gap expander created right before the hunk currently
  // being built (if any), so its header row can be attached once made.
  let pendingExpander = null;
  file.hunks.forEach(function (hunk) {
    const range = canExpand ? hunkRange(hunk) : null;
    if (range) {
      const gapLo = prevRange ? prevRange.newEnd + 1 : 1;
      const gapHi = range.newStart - 1;
      const delta = prevRange
        ? prevRange.oldEnd - prevRange.newEnd
        : range.oldStart - range.newStart;
      if (gapHi >= gapLo) pendingExpander = addExpander(gapLo, gapHi, delta);
      prevRange = range;
    }

    const hr = document.createElement('tr');
    hr.className = 'hunk';
    hr.innerHTML = '<td colspan="4">' + esc(hunk.header) + '</td>';
    tbody.appendChild(hr);
    if (pendingExpander) {
      pendingExpander.attachHeaderRow(hr);
      pendingExpander = null;
    }

    hunk.rows.forEach(function (row) {
      const tr = document.createElement('tr');
      tr.className = 'diff-row';
      tr.appendChild(numCell(file, 'old', row.left, interactive));
      tr.appendChild(codeCell(row.left, 'del'));
      tr.appendChild(numCell(file, 'new', row.right, interactive));
      tr.appendChild(codeCell(row.right, 'add'));
      tbody.appendChild(tr);
    });
  });

  if (canExpand && prevRange) {
    const gapLo = prevRange.newEnd + 1;
    const gapHi = file.newLines.length;
    const delta = prevRange.oldEnd - prevRange.newEnd;
    if (gapHi >= gapLo) addExpander(gapLo, gapHi, delta);
  }

  // The pin panel is display-only and rebuilt on every pin; only the main
  // table's controllers are used for comment auto-expansion.
  if (interactive !== false) state.expanders[file.path] = controllers;
  return table;
}

/* ---------- pinned split view (right panels) ---------- */

// Total width (viewport %) the stack may occupy. A newcomer first shrinks to
// whatever room is left; only when even a minimum-width panel (PIN_MIN) won't
// fit do we drop the oldest pin. Defaults (first 45, subsequent 25) are chosen
// so three usable panels still fit under this cap (45 + 25 + 15 = 85).
const PIN_TOTAL_MAX = 85;
const PIN_NEXT_DEFAULT = 25; // subsequent panels; first uses savedPinDefault()

function ensurePinStack() {
  if (state.pinStack) return state.pinStack;
  state.pinStack = document.createElement('div');
  state.pinStack.id = 'pin-stack';
  document.body.appendChild(state.pinStack);
  return state.pinStack;
}

function pinTotalWidth() {
  return state.pins.reduce(function (sum, p) { return sum + p.width; }, 0);
}

// Push panel widths and the combined right-side gutter into the DOM. The
// main content's margin-right tracks --pin-total-width so it never overlaps.
export function updatePinLayout() {
  state.pins.forEach(function (p) { p.el.style.width = p.width + 'vw'; });
  document.documentElement.style.setProperty('--pin-total-width', pinTotalWidth() + 'vw');
  document.body.classList.toggle('has-pin', state.pins.length > 0);
}

function updatePinButtons() {
  const pinned = {};
  state.pins.forEach(function (p) { pinned[String(p.index)] = true; });
  document.querySelectorAll('.pin-btn').forEach(function (b: any) {
    const active = !!pinned[b.dataset.fileIndex];
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  // Repo-file tree rows: mark the ones whose panel is currently open.
  document.querySelectorAll('.repo-tree .tree-file').forEach(function (r: any) {
    r.classList.toggle('active', !!pinned['repo:' + r.dataset.path]);
  });
}

// Build a single display-only panel element for DIFF.files[fi].
function buildPinPanel(fi) {
  const file = DIFF.files[fi];
  const panel = document.createElement('aside');
  panel.className = 'pin-panel';
  panel.dataset.fileIndex = fi;
  panel.innerHTML =
    '<div class="pin-panel-header">' +
    '<span class="pin-panel-file"></span>' +
    '<span class="pin-panel-note">表示専用</span>' +
    '<button class="pin-panel-close" type="button" title="固定を解除">✕</button>' +
    '</div>' +
    '<div class="pin-panel-body"></div>';
  panel.querySelector('.pin-panel-file').textContent = file.path;
  (panel.querySelector('.pin-panel-file') as any).title = file.path;
  const panelHeader = panel.querySelector('.pin-panel-header');
  panelHeader.insertBefore(
    copyPathButton(file.path),
    panel.querySelector('.pin-panel-note')
  );
  panel.querySelector('.pin-panel-close').addEventListener('click', function () {
    removePin(fi);
  });

  const bodyEl = panel.querySelector('.pin-panel-body');
  if (file.status === 'binary' || !file.hunks.length) {
    const p = document.createElement('div');
    p.className = 'empty-diff';
    p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
    bodyEl.appendChild(p);
  } else {
    // Display-only table (interactive=false): number cells get no data-file,
    // so document-level selection handlers skip them.
    bodyEl.appendChild(buildDiffTable(file, false));
  }

  // Left-edge drag handle for resizing this panel individually.
  const resizer = document.createElement('div');
  resizer.className = 'pin-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでパネル幅を調整';
  attachPinResize(resizer, panel);
  panel.appendChild(resizer);

  // Belt-and-suspenders: even though the panel's number cells carry no
  // data-file, stop mousedown from ever reaching the document-level selection
  // handler so the panel can never start a main-diff selection.
  panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  return panel;
}

function removePin(fi) {
  const i = state.pins.findIndex(function (p) { return p.index === fi; });
  if (i < 0) return;
  state.pins[i].el.remove();
  state.pins.splice(i, 1);
  if (!state.pins.length && state.pinStack) {
    state.pinStack.remove();
    state.pinStack = null;
  }
  updatePinLayout();
  updatePinButtons();
}

// Shared pin-stack insertion for any panel kind. `key` identifies the panel:
// a DIFF.files index for diff panels, 'repo:<path>' for repo-file panels.
function addPin(key, panel) {
  if (state.pins.some(function (p) { return p.index === key; })) return;

  // Target width: first panel uses the last-used width (default 45%), the rest
  // use PIN_NEXT_DEFAULT. Shrink the newcomer to whatever room is left; if even
  // PIN_MIN won't fit, drop the oldest pin(s) until it does (with a warning).
  const target = state.pins.length === 0 ? clampPinWidth(savedPinDefault()) : PIN_NEXT_DEFAULT;
  let width = Math.min(target, PIN_TOTAL_MAX - pinTotalWidth());
  if (width < PIN_MIN) {
    while (state.pins.length && PIN_TOTAL_MAX - pinTotalWidth() < PIN_MIN) {
      const oldest = state.pins[0];
      console.warn('agent-review-kit: pinned panels exceed available width; unpinning ' +
        String(oldest.index));
      removePin(oldest.index);
    }
    width = Math.min(target, PIN_TOTAL_MAX - pinTotalWidth());
  }
  width = clampPinWidth(width);

  const stack = ensurePinStack();
  state.pins.push({ index: key, width: width, el: panel });
  stack.appendChild(panel); // newest at the right edge
  updatePinLayout();
  updatePinButtons();
}

function pinFile(fi) {
  const file = DIFF.files[fi];
  if (!file) return;
  if (state.pins.some(function (p) { return p.index === fi; })) return;
  addPin(fi, buildPinPanel(fi));
}

// Re-📌 an already-pinned file unpins just that panel; 📌 a new file adds one.
function togglePin(fi) {
  if (state.pins.some(function (p) { return p.index === fi; })) removePin(fi);
  else pinFile(fi);
}

/* ---------- repository file viewer (support feature) ---------- */

// Render a full repo file as a read-only two-column table (line number +
// highlighted line). Shared by the repo-file pin panel and the standalone
// /file/<path> page. f mirrors the /api/file payload.
function buildFileTable(f) {
  if (f.binary || f.tooLarge) {
    const d = document.createElement('div');
    d.className = 'empty-diff';
    d.textContent = f.binary
      ? 'バイナリファイル（表示できません）'
      : 'ファイルが大きすぎるため表示できません';
    return d;
  }
  const table = document.createElement('table');
  table.className = 'diff file-view';
  const lines = f.lines || [];
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const body = f.html && typeof f.html[i] === 'string' ? f.html[i] : esc(lines[i]);
    rows.push(
      '<tr><td class="num static">' + (i + 1) + '</td><td class="code">' + body + '</td></tr>'
    );
  }
  table.innerHTML = rows.join('');
  return table;
}

function buildRepoPinPanel(key, f) {
  const panel = document.createElement('aside');
  panel.className = 'pin-panel repo-pin-panel';
  panel.innerHTML =
    '<div class="pin-panel-header">' +
    '<span class="pin-panel-file"></span>' +
    '<a class="pin-panel-open" target="_blank" rel="noopener" title="新しいタブで開く">↗</a>' +
    '<span class="pin-panel-note">表示専用</span>' +
    '<button class="pin-panel-close" type="button" title="閉じる">✕</button>' +
    '</div>' +
    '<div class="pin-panel-body"></div>';
  const nameEl: any = panel.querySelector('.pin-panel-file');
  nameEl.textContent = f.path;
  nameEl.title = f.path;
  (panel.querySelector('.pin-panel-open') as any).href = '/file/' + encodeURIComponent(f.path);
  panel.querySelector('.pin-panel-header').insertBefore(
    copyPathButton(f.path),
    panel.querySelector('.pin-panel-open')
  );
  panel.querySelector('.pin-panel-close').addEventListener('click', function () {
    removePin(key);
  });
  panel.querySelector('.pin-panel-body').appendChild(buildFileTable(f));

  const resizer = document.createElement('div');
  resizer.className = 'pin-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでパネル幅を調整';
  attachPinResize(resizer, panel);
  panel.appendChild(resizer);
  panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  return panel;
}

// Open a repository file in the pin stack; clicking the same file again
// closes its panel. Content is fetched on open, so it always reflects the
// working tree at that moment.
function openRepoFile(filePath) {
  const key = 'repo:' + filePath;
  if (state.pins.some(function (p) { return p.index === key; })) {
    removePin(key);
    return;
  }
  api('GET', '/api/file?path=' + encodeURIComponent(filePath)).then(function (data) {
    addPin(key, buildRepoPinPanel(key, data.file));
  }).catch(function (err) {
    alert('ファイルを開けませんでした: ' + err);
  });
}

// Nested tree of every tracked file, for the sidebar's「リポジトリのファイル」
// section. Directories start collapsed and their children render lazily on
// first expand (repos can hold thousands of files). Files already in the
// diff are dimmed — their content is on the main page. Clicking a file
// toggles its pin panel.
function renderRepoTree(files, container) {
  const inDiff = {};
  DIFF.files.forEach(function (f) { inDiff[f.path] = true; });
  const root = { dirs: {}, files: [] };
  files.forEach(function (p) {
    const parts = String(p).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
      node = node.dirs[parts[i]];
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  });
  (function render(node, parent, depth) {
    Object.keys(node.dirs).sort().forEach(function (name) {
      const dEl = document.createElement('div');
      dEl.className = 'tree-dir repo-dir';
      dEl.style.paddingLeft = (4 + depth * 12) + 'px';
      dEl.textContent = '▸ ' + name + '/';
      parent.appendChild(dEl);
      const children = document.createElement('div');
      children.hidden = true;
      parent.appendChild(children);
      let built = false;
      dEl.addEventListener('click', function () {
        const open = children.hidden;
        children.hidden = !open;
        dEl.textContent = (open ? '▾ ' : '▸ ') + name + '/';
        if (open && !built) {
          built = true;
          render(node.dirs[name], children, depth + 1);
        }
      });
    });
    node.files.sort(byName).forEach(function (f) {
      const fEl = document.createElement('div');
      fEl.className = 'tree-file repo-file' + (inDiff[f.path] ? ' in-diff' : '');
      fEl.style.paddingLeft = (4 + depth * 12) + 'px';
      fEl.dataset.path = f.path;
      const label = document.createElement('span');
      label.className = 'tree-name';
      label.textContent = f.name;
      label.title = inDiff[f.path] ? f.path + '（差分に含まれるファイル）' : f.path;
      fEl.appendChild(label);
      fEl.addEventListener('click', function () { openRepoFile(f.path); });
      parent.appendChild(fEl);
    });
  })(root, container, 0);
}

/* ---------- overall comments ---------- */

// A fresh section is created on every renderDiff (which wipes #app). It holds
// the list of file:null comments (filled by renderComments) plus a post form.
function buildOverallSection() {
  const sec = document.createElement('section');
  sec.className = 'overall-section';
  sec.innerHTML =
    '<h2>全体コメント</h2>' +
    '<p class="hint">ファイルや行に紐づかない、レビュー全体への指摘・質問。</p>' +
    '<div class="overall-list"></div>' +
    '<div class="overall-form comment-form">' +
    '<textarea placeholder="レビュー全体へのコメント（Ctrl+Enterで送信）"></textarea>' +
    intentFieldHtml() +
    '<div class="buttons"><button class="primary overall-submit">コメントを追加</button></div>' +
    '</div>';

  const form = sec.querySelector('.overall-form');
  const textarea = sec.querySelector('textarea');
  const btn: any = sec.querySelector('.overall-submit');
  syncIntentFields(form);

  function submit() {
    const body = textarea.value.trim();
    if (!body) return;
    btn.disabled = true;
    api('POST', '/api/comments', { body: body, intent: selectedIntent(form) }).then(function () {
      textarea.value = '';
      // Blur so a Ctrl+Enter submit (which keeps focus) doesn't leave the
      // textarea as activeElement — isEditingDraft() would otherwise defer
      // the refresh forever and the new comment would never appear.
      textarea.blur();
      btn.disabled = false;
      refresh();
    }).catch(function (err) {
      alert('コメントの保存に失敗しました: ' + err);
      btn.disabled = false;
    });
  }

  btn.addEventListener('click', submit);
  textarea.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
  });
  return sec;
}

/* ---------- file tree sidebar ---------- */

function statusMark(st) {
  return { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', binary: 'B' }[st] || 'M';
}

// Build a nested tree from a list of { file, index } entries, preserving each
// file's ORIGINAL DIFF.files index (so data-target file-<index> stays correct
// even when the entry list is a filtered subset). Directory branches are only
// created along included files' paths, so filtering also prunes empty dirs.
function buildTreeFrom(entries) {
  const root = { dirs: {}, files: [] };
  entries.forEach(function (e) {
    const parts = String(e.file.path).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      node.dirs[seg] = node.dirs[seg] || { dirs: {}, files: [] };
      node = node.dirs[seg];
    }
    node.files.push({ name: parts[parts.length - 1], index: e.index, file: e.file });
  });
  return root;
}

function buildTree(files) {
  return buildTreeFrom(files.map(function (file, fi) {
    return { file: file, index: fi };
  }));
}

// Shared comparator for files within a tree node (by name). Kept identical to
// the directory ordering (default string sort) so the tree and the main diff
// agree exactly.
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// The order in which files appear when walking the tree: directories first
// (recursively, name-sorted), then this node's own files (name-sorted).
// Returns the list of original DIFF.files indices in that display order.
// renderDiff and renderTreeNode both follow this exact ordering.
function treeOrder(files) {
  const order = [];
  (function walk(node) {
    Object.keys(node.dirs).sort().forEach(function (name) {
      walk(node.dirs[name]);
    });
    node.files.slice().sort(byName).forEach(function (f) {
      order.push(f.index);
    });
  })(buildTree(files));
  return order;
}

function renderTreeNode(node, container, depth) {
  Object.keys(node.dirs).sort().forEach(function (name) {
    const dEl = document.createElement('div');
    dEl.className = 'tree-dir';
    dEl.style.paddingLeft = (4 + depth * 12) + 'px';
    dEl.textContent = name + '/';
    container.appendChild(dEl);
    renderTreeNode(node.dirs[name], container, depth + 1);
  });
  node.files.slice().sort(byName).forEach(function (f) {
    const fEl = document.createElement('div');
    fEl.className = 'tree-file';
    fEl.style.paddingLeft = (4 + depth * 12) + 'px';
    fEl.dataset.target = 'file-' + f.index;

    const mark = document.createElement('span');
    mark.className = 'tree-status tree-status-' + esc(f.file.status);
    mark.textContent = statusMark(f.file.status);

    const label = document.createElement('span');
    label.className = 'tree-name';
    label.textContent = f.name;
    label.title = f.file.path;

    const badge = document.createElement('span');
    badge.className = 'tree-count';
    badge.dataset.file = f.file.path;

    fEl.appendChild(mark);
    fEl.appendChild(label);
    fEl.appendChild(badge);
    fEl.addEventListener('click', function () {
      const el = document.getElementById('file-' + f.index);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    container.appendChild(fEl);
  });
}

// Create the .layout flex wrapper holding the (empty) tree sidebar, its drag
// resizer, and #app. Shared by the main review page and the standalone
// read-only pages. Returns the sidebar element, or null when already built /
// nothing to show.
function buildSidebarShell() {
  if (state.sidebarBuilt || !DIFF.files.length) return null;
  const parent = app.parentNode;
  if (!parent) return null;

  const layout = document.createElement('div');
  layout.className = 'layout';
  parent.insertBefore(layout, app);

  const sidebar = document.createElement('aside');
  sidebar.id = 'file-tree';
  sidebar.className = 'sidebar';

  // Vertical drag handle between the sidebar and #app.
  const resizer = document.createElement('div');
  resizer.className = 'sidebar-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでサイドバー幅を調整';
  attachSidebarResize(resizer, sidebar);

  layout.appendChild(sidebar);
  layout.appendChild(resizer);
  layout.appendChild(app); // move #app into the flex layout
  state.sidebarBuilt = true;
  return sidebar;
}

// File-tree-only sidebar for the standalone /commit and /snapshot pages:
// jump navigation over the read-only file boxes. No viewed split, comment
// list, or commits section — none of those apply there.
function buildReadOnlySidebar() {
  const sidebar = buildSidebarShell();
  if (!sidebar) return;

  const heading = document.createElement('div');
  heading.className = 'sidebar-title';
  heading.textContent = 'ファイル (' + DIFF.files.length + ')';
  sidebar.appendChild(heading);

  const treeWrap = document.createElement('div');
  treeWrap.className = 'tree';
  renderTreeNode(buildTree(DIFF.files), treeWrap, 0);
  sidebar.appendChild(treeWrap);
  // No comments here: hide the (empty) per-file count badges the tree
  // renderer always creates.
  updateTreeCounts();
}

function buildSidebar() {
  const sidebar = buildSidebarShell();
  if (!sidebar) return;
  const heading = document.createElement('div');
  heading.className = 'sidebar-title';
  heading.id = 'file-tree-title';
  sidebar.appendChild(heading);

  // Unviewed files render as the normal nested tree; viewed files move to a
  // flat "確認済み" section below it. Both are (re)filled by renderSidebarTree.
  const treeWrap = document.createElement('div');
  treeWrap.className = 'tree';
  sidebar.appendChild(treeWrap);

  const viewedWrap = document.createElement('div');
  viewedWrap.className = 'viewed-tree';
  viewedWrap.id = 'viewed-tree';
  sidebar.appendChild(viewedWrap);

  // Comment management list (filled/updated by renderCommentList on refresh).
  const cHeading = document.createElement('div');
  cHeading.className = 'sidebar-title sidebar-comments-title';
  cHeading.id = 'sidebar-comments-title';
  cHeading.textContent = 'コメント (0)';
  sidebar.appendChild(cHeading);

  const cList = document.createElement('div');
  cList.className = 'comment-list';
  sidebar.appendChild(cList);

  // Commits under review (base..HEAD), like GitHub's Commits tab. Fetched
  // once per page load; `generate` triggers a full reload, which refetches.
  const commitHeading = document.createElement('div');
  commitHeading.className = 'sidebar-title sidebar-commits-title';
  commitHeading.id = 'sidebar-commits-title';
  const commitList = document.createElement('div');
  commitList.className = 'commit-list';
  commitList.id = 'sidebar-commit-list';
  sidebar.appendChild(commitHeading);
  sidebar.appendChild(commitList);
  loadCommitList(commitHeading, commitList);

  // Repository file viewer (support feature): a collapsed-by-default section
  // listing every tracked file. The list loads lazily on first expand;
  // clicking a file opens it read-only in the pin stack (see openRepoFile).
  const repoHeading = document.createElement('div');
  repoHeading.className = 'sidebar-title repo-tree-title';
  repoHeading.textContent = '▸ リポジトリのファイル';
  repoHeading.title = 'クリックで開閉。差分に含まれないファイルも参照できます';
  sidebar.appendChild(repoHeading);
  const repoWrap = document.createElement('div');
  repoWrap.className = 'repo-tree';
  repoWrap.hidden = true;
  sidebar.appendChild(repoWrap);
  let repoLoaded = false;
  repoHeading.addEventListener('click', function () {
    const open = repoWrap.hidden;
    repoWrap.hidden = !open;
    repoHeading.textContent = (open ? '▾' : '▸') + ' リポジトリのファイル';
    if (open && !repoLoaded) {
      repoLoaded = true;
      repoWrap.textContent = '読み込み中…';
      api('GET', '/api/repo-files').then(function (data) {
        repoWrap.textContent = '';
        renderRepoTree(data.files || [], repoWrap);
        updatePinButtons(); // mark rows whose panel is already open
      }).catch(function (err) {
        repoLoaded = false;
        repoWrap.textContent = '取得に失敗しました: ' + err;
      });
    }
  });

  // Populate the tree/確認済み sections now that the sidebar is in the DOM
  // (renderSidebarTree looks its containers up by id/selector).
  renderSidebarTree();
}

// Fill the sidebar commits section: base..HEAD, newest first, each row
// opening the existing /commit/<sha> diff page in a new tab. The heading
// toggles the list (collapsed by default to keep the sidebar compact). With
// no base or no commits the whole section stays hidden.
function loadCommitList(heading, list) {
  heading.style.display = 'none';
  list.style.display = 'none';
  api('GET', '/api/commits').then(function (data) {
    const commits = data.commits || [];
    if (!commits.length) return;
    heading.style.display = '';
    let collapsed = true;
    function syncHeading() {
      heading.textContent = (collapsed ? '▸' : '▾') + ' コミット (' + commits.length + ')';
      list.style.display = collapsed ? 'none' : '';
    }
    heading.addEventListener('click', function () {
      collapsed = !collapsed;
      syncHeading();
    });
    heading.title = 'クリックで開閉';
    syncHeading();

    commits.forEach(function (cm) {
      const item = document.createElement('div');
      item.className = 'commit-item';
      item.title = cm.subject + '\n' + cm.author + ' — ' + cm.date;

      const sha = document.createElement('span');
      sha.className = 'commit-item-sha';
      sha.textContent = cm.shortSha;

      const subject = document.createElement('span');
      subject.className = 'commit-item-subject';
      subject.textContent = cm.subject;

      item.appendChild(sha);
      item.appendChild(subject);
      item.addEventListener('click', function () {
        window.open('/commit/' + encodeURIComponent(cm.sha), '_blank', 'noopener');
      });
      list.appendChild(item);
    });
  }).catch(function () { /* auxiliary; ignore fetch failures */ });
}

// (Re)render the sidebar tree: unviewed files as the nested tree, viewed files
// as the nested "確認済み" tree below it, plus the progress title. Called after every
// viewed toggle and once on initial sidebar build. Refreshes comment counts on
// both lists since it recreates their badge elements.
function renderSidebarTree() {
  const title = document.getElementById('file-tree-title');
  const treeWrap = document.querySelector('.sidebar .tree');
  const viewedWrap = document.getElementById('viewed-tree');
  if (!treeWrap || !viewedWrap) return;

  const unviewedEntries = [];
  const viewedEntries = [];
  DIFF.files.forEach(function (f, i) {
    (isViewed(f.path) ? viewedEntries : unviewedEntries).push({ file: f, index: i });
  });

  if (title) {
    title.textContent = 'ファイル (未確認 ' + unviewedEntries.length +
      ' / 全 ' + DIFF.files.length + ')';
  }

  treeWrap.innerHTML = '';
  renderTreeNode(buildTreeFrom(unviewedEntries), treeWrap, 0);

  viewedWrap.innerHTML = '';
  if (viewedEntries.length) {
    const h = document.createElement('div');
    h.className = 'sidebar-title viewed-title';
    h.textContent = '確認済み (' + viewedEntries.length + ')';

    // Bulk revert: clears every mark and re-expands the file boxes, so a
    // full re-review never needs a per-file un-toggle.
    const clearBtn = document.createElement('button');
    clearBtn.className = 'viewed-clear-btn';
    clearBtn.type = 'button';
    clearBtn.textContent = 'すべて解除';
    clearBtn.title = 'すべてのファイルの確認済みを解除する';
    clearBtn.addEventListener('click', function () {
      if (!confirm('すべてのファイルの確認済みを解除しますか？')) return;
      state.viewed = {};
      saveViewed();
      applyViewedState();
    });
    h.appendChild(clearBtn);
    viewedWrap.appendChild(h);

    const list = document.createElement('div');
    list.className = 'viewed-list';
    renderTreeNode(buildTreeFrom(viewedEntries), list, 0);
    viewedWrap.appendChild(list);
  }

  updateTreeCounts();
}

// Tree badges answer "what is still on my plate in this file?": they count
// threads (not individual comments, so a long back-and-forth stays 1), drop
// settled ones entirely, and take their colour from 要確認 — the state where
// the ball is in the user's court. 未解決 waits on the agent, so it gets the
// quieter blue.
function updateTreeCounts() {
  const counts = {}; // path -> { check, open }
  const s = threadStructure(state.comments);
  s.tops.forEach(function (top) {
    if (top.file === null || top.file === undefined) return;
    const state = threadState(top, s.repliesByParent[top.id] || []);
    if (state === 'settled') return;
    const entry = counts[top.file] || (counts[top.file] = { check: 0, open: 0 });
    entry[state] += 1;
  });
  document.querySelectorAll('.tree-count[data-file]').forEach(function (el: any) {
    const entry = counts[el.dataset.file];
    const n = entry ? entry.check + entry.open : 0;
    el.textContent = n ? String(n) : '';
    el.style.display = n ? '' : 'none';
    el.className = 'tree-count' + (n && !entry.check ? ' tree-count-open' : '');
    el.title = n ? '要確認 ' + entry.check + ' / 未解決 ' + entry.open : '';
  });
}

export function focusComment(id) {
  const card = document.querySelector(
    '.comment-card[data-comment-id="' + id + '"]'
  );
  if (!card) return;
  // A collapsed file box (chevron or 確認済み) hides everything but its
  // header, so a card inside it has no layout and scrollIntoView is a no-op.
  // Expand the box first; the viewed mark itself stays on.
  const fileBox = card.closest('.file');
  if (fileBox && fileBox.classList.contains('collapsed')) {
    setCollapsed(fileBox, false);
  }
  // A collapsed thread hides its cards; expand it before scrolling so the
  // jump from the sidebar always lands on something visible.
  const block: any = card.closest('.comment-thread-block');
  if (block && block.classList.contains('collapsed')) {
    block.classList.remove('collapsed');
    if (block.dataset.topId) setThreadCollapsed(block.dataset.topId, false);
    const caret = block.querySelector('.thread-caret');
    if (caret) caret.textContent = '▾';
  }
  if (typeof card.scrollIntoView === 'function') {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  card.classList.add('comment-flash');
  setTimeout(function () { card.classList.remove('comment-flash'); }, 1500);
}

// One sidebar row per thread. Replies get no row of their own — their
// statuses are already folded into `state` — so a thread reads as a single
// unresolved/settled unit; only the reply count is shown.
function threadListItem(top, replies, state) {
  const item = document.createElement('div');
  item.className = 'comment-item comment-item-' + state;
  item.title = commentLocShort(top) + ' — ' + top.body +
    (replies.length ? '\n（返信 ' + replies.length + '）' : '');

  const pill = document.createElement('span');
  pill.className = 'status-pill thread-state-' + state;
  pill.textContent = THREAD_STATE_LABEL[state];

  const loc = document.createElement('span');
  loc.className = 'comment-item-loc';
  loc.textContent = commentLocShort(top);

  const body = document.createElement('span');
  body.className = 'comment-item-body';
  body.textContent = bodySnippet(top.body);

  if (isAgentComment(top)) {
    const who = document.createElement('span');
    who.className = 'who-pill';
    who.textContent = 'AI';
    item.appendChild(who);
  }
  item.appendChild(pill);
  item.appendChild(loc);
  item.appendChild(body);
  if (replies.length) {
    const count = document.createElement('span');
    count.className = 'comment-item-replies';
    count.textContent = '↳' + replies.length;
    item.appendChild(count);
  }
  item.addEventListener('click', function () { focusComment(top.id); });
  return item;
}

// Re-render the sidebar comment list. Called on the same cadence as
// updateTreeCounts (from renderComments) so it tracks every refresh. Threads
// are ordered 要確認 → 未解決 → 解決済み — 要確認 first because that is the
// only group the user can act on. Within a group, createdAt asc
// (threadStructure already sorts the top-level comments).
function renderCommentList() {
  const list = document.querySelector('.sidebar .comment-list');
  if (!list) return;
  list.innerHTML = '';

  const s = threadStructure(state.comments);
  const groups = { open: [], check: [], settled: [] };
  s.tops.forEach(function (top) {
    const replies = s.repliesByParent[top.id] || [];
    groups[threadState(top, replies)].push({ top: top, replies: replies });
  });

  const title = document.getElementById('sidebar-comments-title');
  if (title) {
    let text = 'コメント (';
    if (groups.check.length) text += '要確認 ' + groups.check.length + ' / ';
    title.textContent = text + '未解決 ' + groups.open.length +
      ' / 全 ' + s.tops.length + ')';
  }

  function append(target, entries, state) {
    entries.forEach(function (e) {
      target.appendChild(threadListItem(e.top, e.replies, state));
    });
  }
  append(list, groups.check, 'check');
  append(list, groups.open, 'open');
  if (!groups.settled.length) return;

  const heading = document.createElement('div');
  heading.className = 'comment-resolved-title';
  heading.title = 'クリックで開閉';
  const holder = document.createElement('div');
  append(holder, groups.settled, 'settled');
  function syncHeading() {
    heading.textContent = (state.resolvedListOpen ? '▾' : '▸') +
      ' 解決済み (' + groups.settled.length + ')';
    holder.style.display = state.resolvedListOpen ? '' : 'none';
  }
  heading.addEventListener('click', function () {
    state.resolvedListOpen = !state.resolvedListOpen;
    syncHeading();
  });
  syncHeading();
  list.appendChild(heading);
  list.appendChild(holder);
}

function numCell(file, side, cell, interactive) {
  const td = document.createElement('td');
  td.className = 'num';
  if (!cell) {
    td.className += ' empty';
    return td;
  }
  if (cell.kind === 'add') td.className += ' add';
  if (cell.kind === 'del') td.className += ' del';
  td.textContent = cell.line;
  // Display-only cells (pin panel) carry no data-file, so the document-level
  // mousedown/mouseover handlers (which match td.num[data-file]) never pick
  // them up for comment selection.
  if (interactive === false) {
    td.classList.add('static');
    return td;
  }
  td.dataset.file = file.path;
  td.dataset.side = side;
  td.dataset.line = cell.line;
  td.dataset.diffLine = cell.diffLine;
  td.title = 'クリックでコメント / Shift+クリックで範囲';
  return td;
}

function codeCell(cell, changedKind) {
  const td = document.createElement('td');
  td.className = 'code';
  if (!cell) {
    td.className += ' empty';
    return td;
  }
  if (cell.kind === changedKind) td.className += ' ' + changedKind;
  const prefix = cell.kind === 'add' ? '+' : cell.kind === 'del' ? '-' : ' ';
  const prefixHtml = '<span class="prefix">' + prefix + '</span>';
  // Syntax highlighting is baked in at generate time (Shiki, github-dark):
  // cell.html is pre-colored inner markup. When absent (unsupported language
  // or highlight failure) fall back to escaped plain text.
  const body = typeof cell.html === 'string' ? cell.html : esc(cell.text);
  td.innerHTML = prefixHtml + body;
  return td;
}

/* ---------- selection ---------- */

function cellInfo(td) {
  return {
    file: td.dataset.file,
    side: td.dataset.side,
    line: parseInt(td.dataset.line, 10),
    diffLine: parseInt(td.dataset.diffLine, 10),
  };
}

function clearSelectionHighlight() {
  document.querySelectorAll('td.selected').forEach(function (td) {
    td.classList.remove('selected');
  });
}

function selectionRange() {
  if (!state.selection) return null;
  const a = state.selection.anchor;
  const b = state.selection.head;
  const startLine = Math.min(a.line, b.line);
  const endLine = Math.max(a.line, b.line);
  const startDiffLine = Math.min(a.diffLine, b.diffLine);
  const endDiffLine = Math.max(a.diffLine, b.diffLine);
  return {
    file: state.selection.file,
    side: state.selection.side,
    startLine: startLine,
    endLine: endLine,
    startDiffLine: startDiffLine,
    endDiffLine: endDiffLine,
  };
}

function highlightSelection() {
  clearSelectionHighlight();
  const r = selectionRange();
  if (!r) return;
  document.querySelectorAll('td.num[data-file]').forEach(function (td) {
    const c = cellInfo(td);
    if (c.file === r.file && c.side === r.side && c.line >= r.startLine && c.line <= r.endLine) {
      td.classList.add('selected');
      if (td.nextElementSibling) td.nextElementSibling.classList.add('selected');
    }
  });
}

function beginSelection(td, extend) {
  const c = cellInfo(td);
  if (extend && state.selection && state.selection.file === c.file && state.selection.side === c.side) {
    state.selection.head = { line: c.line, diffLine: c.diffLine };
  } else {
    state.selection = {
      file: c.file,
      side: c.side,
      anchor: { line: c.line, diffLine: c.diffLine },
      head: { line: c.line, diffLine: c.diffLine },
    };
  }
  highlightSelection();
}

document.addEventListener('mousedown', function (e: any) {
  const td = e.target.closest && e.target.closest('td.num[data-file]');
  if (!td) return;
  e.preventDefault();
  beginSelection(td, e.shiftKey);
  state.dragging = true;
});

document.addEventListener('mouseover', function (e: any) {
  if (!state.dragging || !state.selection) return;
  const td = e.target.closest && e.target.closest('td.num[data-file]');
  if (!td) return;
  const c = cellInfo(td);
  if (c.file !== state.selection.file || c.side !== state.selection.side) return;
  state.selection.head = { line: c.line, diffLine: c.diffLine };
  highlightSelection();
});

document.addEventListener('mouseup', function () {
  if (!state.dragging) return;
  state.dragging = false;
  if (state.selection) showCommentForm();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') cancelForm();
});

/* ---------- comment form ---------- */

// The exact text the review is showing for new-side lines start..end of a
// file, reconstructed from the embedded diff data (full newLines when
// present, hunk rows otherwise). Returns null when any line is not part of
// the rendered diff — manual edit is only offered on content the user can
// actually see. \r is stripped so a CRLF file compares cleanly server-side.
function newSideText(filePath, startLine, endLine) {
  var f = null;
  for (var i = 0; i < DIFF.files.length; i++) {
    if (DIFF.files[i].path === filePath) { f = DIFF.files[i]; break; }
  }
  if (!f || f.status === 'deleted' || f.status === 'binary') return null;
  var out = [];
  if (f.newLines) {
    if (endLine > f.newLines.length) return null;
    for (var l = startLine; l <= endLine; l++) out.push(f.newLines[l - 1]);
  } else {
    var byLine = {};
    f.hunks.forEach(function (h) {
      h.rows.forEach(function (row) {
        if (row.right) byLine[row.right.line] = row.right.text;
      });
    });
    for (var l2 = startLine; l2 <= endLine; l2++) {
      if (!(l2 in byLine)) return null;
      out.push(byLine[l2]);
    }
  }
  return out.map(function (s) { return String(s).replace(/\r$/, ''); }).join('\n');
}

function findRowFor(file, side, line) {
  const tds: any = document.querySelectorAll(
    'td.num[data-file][data-side="' + side + '"][data-line="' + line + '"]'
  );
  for (let i = 0; i < tds.length; i++) {
    if (tds[i].dataset.file === file) return tds[i].closest('tr');
  }
  return null;
}

function cancelForm() {
  if (state.openForm) {
    state.openForm.remove();
    state.openForm = null;
  }
  state.selection = null;
  clearSelectionHighlight();
}

function showCommentForm() {
  const r = selectionRange();
  if (!r) return;
  if (state.openForm) state.openForm.remove();

  const anchorRow = findRowFor(r.file, r.side, r.endLine);
  if (!anchorRow) return;

  const tr = document.createElement('tr');
  tr.className = 'widget-row comment-form-row';
  const td = document.createElement('td');
  td.colSpan = 4;

  const rangeText = r.startLine === r.endLine
    ? 'L' + r.startLine
    : 'L' + r.startLine + '-L' + r.endLine;
  const sideText = r.side === 'new' ? '変更後' : '変更前';

  // Manual edit needs the on-screen text of the range: only offered on the
  // new side (the old side is the base), outside read-only mode, and when
  // every selected line is part of the rendered diff.
  const editableText = r.side === 'new' && !state.readOnlyMode
    ? newSideText(r.file, r.startLine, r.endLine)
    : null;

  const wrap = document.createElement('div');
  wrap.className = 'comment-form';
  wrap.innerHTML =
    '<div class="form-meta">' + esc(r.file) + ' / ' + sideText + ' ' + rangeText + ' にコメント</div>' +
    '<textarea placeholder="コメントを入力（Ctrl+Enterで送信）"></textarea>' +
    intentFieldHtml() +
    '<div class="buttons">' +
    '<button class="primary submit">コメントを追加</button>' +
    (editableText !== null
      ? '<button class="manual-edit" title="選択範囲のコードをその場で書き換えてファイルに直接適用する">✏️ 手動修正</button>'
      : '') +
    '<button class="cancel">キャンセル</button>' +
    '</div>';
  td.appendChild(wrap);
  tr.appendChild(td);
  anchorRow.after(tr);
  state.openForm = tr;
  syncIntentFields(wrap);

  const textarea = wrap.querySelector('textarea');
  textarea.focus();

  function submit() {
    const body = textarea.value.trim();
    if (!body) return;
    (wrap.querySelector('.submit') as any).disabled = true;
    api('POST', '/api/comments', {
      file: r.file,
      side: r.side,
      startLine: r.startLine,
      endLine: r.endLine,
      startDiffLine: r.startDiffLine,
      endDiffLine: r.endDiffLine,
      body: body,
      intent: selectedIntent(wrap),
    }).then(function () {
      cancelForm();
      refresh();
    }).catch(function (err) {
      alert('コメントの保存に失敗しました: ' + err);
      (wrap.querySelector('.submit') as any).disabled = false;
    });
  }

  // Swap the form into manual-edit mode: a code textarea prefilled with
  // exactly what the diff shows for the range. Saving applies the change to
  // the file via POST /api/edit; the server regenerates the review before
  // answering, so a plain reload lands on the fresh diff.
  function showManualEdit() {
    wrap.innerHTML =
      '<div class="form-meta">' + esc(r.file) + ' / 変更後 ' + rangeText +
      ' を手動修正（保存でファイルへ直接適用）</div>' +
      '<textarea class="code-edit" spellcheck="false"></textarea>' +
      '<div class="buttons">' +
      '<button class="primary save">保存してファイルに適用</button>' +
      '<button class="cancel">キャンセル</button>' +
      '<span class="edit-hint">Ctrl+Enter で保存 / 空にして保存すると行を削除</span>' +
      '</div>';
    const ta = wrap.querySelector('textarea');
    ta.value = editableText;
    ta.rows = Math.min(30, Math.max(3, editableText.split('\n').length + 1));
    ta.focus();

    function save() {
      const saveBtn: any = wrap.querySelector('.save');
      saveBtn.disabled = true;
      api('POST', '/api/edit', {
        file: r.file,
        startLine: r.startLine,
        endLine: r.endLine,
        startDiffLine: r.startDiffLine,
        endDiffLine: r.endDiffLine,
        expectedText: editableText,
        newText: ta.value,
      }).then(function () {
        cancelForm();
        location.reload();
      }).catch(function (err) {
        const msg = String((err && err.message) || err);
        if (msg.indexOf('409') === 0 && msg.indexOf('stale') !== -1) {
          alert('ファイルの内容が表示中の差分と一致しません（差分が古くなっています）。ページを再読み込みします。');
          location.reload();
          return;
        }
        alert('手動修正の適用に失敗しました: ' + msg);
        saveBtn.disabled = false;
      });
    }
    wrap.querySelector('.save').addEventListener('click', save);
    wrap.querySelector('.cancel').addEventListener('click', cancelForm);
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
    });
  }

  wrap.querySelector('.submit').addEventListener('click', submit);
  wrap.querySelector('.cancel').addEventListener('click', cancelForm);
  const editBtn = wrap.querySelector('.manual-edit');
  if (editBtn) editBtn.addEventListener('click', showManualEdit);
  textarea.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
  });
}

function renderComments() {
  pruneThreadCollapse();
  document.querySelectorAll('tr.thread-row, .orphan-section').forEach(function (el) {
    el.remove();
  });

  const orphans = [];
  const byAnchor = {};
  const overall = [];

  const overallList = document.querySelector('.overall-list');
  if (overallList) overallList.innerHTML = '';

  state.comments.forEach(function (c) {
    if (c.file === null || c.file === undefined) {
      overall.push(c);
      return;
    }
    const key = c.file + '\u0000' + c.side + '\u0000' + c.endLine;
    (byAnchor[key] = byAnchor[key] || []).push(c);
  });

  // Overall comments render as one thread: parents with their replies nested.
  // A reply to an overall comment also has file === null (anchor copied), so
  // it lands in this same bucket.
  if (overallList && overall.length) {
    renderThread(overallList, overall);
  }

  Object.keys(byAnchor).forEach(function (key) {
    const list = byAnchor[key];
    const c0 = list[0];
    let row = findRowFor(c0.file, c0.side, c0.endLine);
    // A comment on an expanded context line loses its row after a reload
    // (gaps start collapsed); re-expand to it instead of orphaning it.
    if (!row && tryExpandTo(c0.file, c0.side, c0.endLine)) {
      row = findRowFor(c0.file, c0.side, c0.endLine);
    }
    if (!row) {
      orphans.push.apply(orphans, list);
      return;
    }
    const tr = document.createElement('tr');
    tr.className = 'widget-row thread-row';
    const td = document.createElement('td');
    td.colSpan = 4;
    renderThread(td, list);
    tr.appendChild(td);
    // Keep the open form directly under its anchor row.
    const after = row.nextElementSibling && row.nextElementSibling.classList.contains('comment-form-row')
      ? row.nextElementSibling : row;
    after.after(tr);
  });

  if (orphans.length) {
    const sec = document.createElement('section');
    sec.className = 'orphan-section';
    sec.innerHTML = '<h2>現在の差分に位置づけできないコメント</h2>' +
      '<p class="hint">差分の再生成により行が変わった可能性があります。</p>';
    renderThread(sec, orphans);
    app.appendChild(sec);
  }

  updateTreeCounts();
  renderCommentList();
}

/* ---------- agent response toasts ---------- */

// Notify (top-right toast) when the agent responds to a comment. The last
// notified state of each agentResponse is persisted in localStorage so a
// response is announced exactly once per browser, surviving the automatic
// page reload that follows `generate`.
const AGENT_SEEN_KEY = 'ark-agent-seen';
const TOAST_MS = 10000;

function ensureToastStack() {
  if (state.toastStack && document.body.contains(state.toastStack)) return state.toastStack;
  state.toastStack = document.createElement('div');
  state.toastStack.id = 'toast-stack';
  document.body.appendChild(state.toastStack);
  return state.toastStack;
}

function showToast(title, bodyText, onClick) {
  const stack = ensureToastStack();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');

  const head = document.createElement('div');
  head.className = 'toast-title';
  head.textContent = title;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', '通知を閉じる');

  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = bodyText;

  head.appendChild(close);
  t.appendChild(head);
  t.appendChild(body);
  stack.appendChild(t);

  function dismiss() {
    if (!t.parentNode) return;
    t.classList.add('toast-out');
    setTimeout(function () { t.remove(); }, 300);
  }
  close.addEventListener('click', function (e) {
    e.stopPropagation();
    dismiss();
  });
  if (onClick) {
    t.classList.add('clickable');
    t.addEventListener('click', function () {
      onClick();
      dismiss();
    });
  }
  setTimeout(dismiss, TOAST_MS);
}

// agentResponse.updatedAt changes on every agent resolve, so it (plus the
// message) uniquely identifies a response state. Comment status alone is
// excluded on purpose: the user's own Resolve click must not notify.
function agentFingerprint(c) {
  return c.agentResponse.updatedAt + ' ' + c.agentResponse.message;
}

export function notifyAgentUpdates(list) {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(AGENT_SEEN_KEY)); } catch (e) { stored = null; }
  // First run in this browser: record the baseline silently instead of
  // toasting every historical response at once.
  const first = !stored || typeof stored !== 'object';
  const seen = first ? {} : stored;
  const next = {};
  list.forEach(function (c) {
    if (!c.agentResponse || !c.agentResponse.message) return;
    const fp = agentFingerprint(c);
    next[c.id] = fp;
    if (!first && seen[c.id] !== fp) {
      showToast('エージェントが返信しました (' + c.status + ')',
        commentLocShort(c) + ' — ' + bodySnippet(c.agentResponse.message),
        function () { focusComment(c.id); });
    }
  });
  try { localStorage.setItem(AGENT_SEEN_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
}

export function renderBadge(status) {
  const unresolved = status ? status.unresolved : null;
  if (unresolved === null || unresolved === undefined) {
    badge.textContent = '-';
    return;
  }
  badge.textContent = '未解決 ' + unresolved;
  badge.className = 'badge' + (unresolved === 0 ? ' zero' : '');
}

// True while the user has an in-progress draft in any comment/reply form:
// either the textarea is focused, or it holds unsent text. Used to defer the
// 3s auto-refresh so re-rendering (which rebuilds thread rows) or a reload
// never wipes what they are typing. Deferral ends as soon as the draft is
// submitted, cleared, or blurred-empty; the next tick then catches up.
export function isEditingDraft() {
  const areas = document.querySelectorAll('.comment-form textarea, .reply-form textarea');
  for (let i = 0; i < areas.length; i++) {
    const ta: any = areas[i];
    if (document.activeElement === ta) return true;
    if (ta.value && ta.value.trim() !== '') return true;
  }
  return false;
}

// Shared entry point: every "something changed, re-sync" call site uses
// refresh(), so it dispatches on the page mode.
export function refresh() {
  return DOC ? docRefresh() : diffRefresh();
}

function diffRefresh() {
  return Promise.all([
    api('GET', '/api/comments'),
    api('GET', '/api/status'),
  ]).then(function (results) {
    // Soft-deleted comments never render, and HTML-document comments
    // (documentId set, file null) belong to their /doc/<id> page — without
    // this filter they would leak into the overall section here. Manual-edit
    // records (manualEdit) are agent-facing notifications, never shown.
    // Filtering at the single entry point covers every consumer: threads,
    // sidebar list and tree counts.
    const cs = (results[0].comments || []).filter(function (c) {
      return !c.deleted && !c.documentId && !c.manualEdit;
    });
    const status = results[1];
    // Never yank the DOM out from under an in-progress draft. Leave
    // lastCommentsJson untouched so the change is re-detected next tick.
    if (isEditingDraft()) {
      connState.textContent = '入力中のため更新を保留中…';
      return;
    }
    connState.textContent = '';
    if (status.generatedAt && DIFF.generatedAt && status.generatedAt !== DIFF.generatedAt) {
      location.reload();
      return;
    }
    // status.unresolved is branch-wide (it includes HTML-document
    // comments); this page's badge counts only what it can show.
    let unresolved = 0;
    cs.forEach(function (c) {
      if (c.status === 'open' || c.status === 'seen') unresolved++;
    });
    renderBadge({ unresolved: unresolved });
    applySettings(status.settings);
    updateBranchLabel(status.branch);
    const json = JSON.stringify(cs);
    if (json !== state.lastCommentsJson) {
      state.lastCommentsJson = json;
      state.comments = cs;
      renderComments();
      notifyAgentUpdates(cs);
    }
  }).catch(function () {
    connState.textContent = 'サーバー未接続（agent-review-kit serve を起動してください）';
  });
}

/* ---------- topbar controls (settings gear + mode badge) ---------- */

// Every place that learns the current settings (status poll, settings PUT
// response) routes through here, so the read-only badge and the intent
// selectors can never disagree with the server.
export function applySettings(settings) {
  if (!settings) return;
  state.readOnlyMode = !!settings.readOnlyMode;
  syncIntentFields();
  if (state.modeBadge) state.modeBadge.hidden = !state.readOnlyMode;
}

export function updateBranchLabel(branch) {
  if (!state.branchLabel || !branch) return;
  state.branchLabel.textContent = '⎇ ' + branch;
  state.branchLabel.title = 'レビュー対象ブランチ（コメント等はブランチ単位で管理されます）';
}

function closeSettingsPanel() {
  if (state.settingsPanel) {
    state.settingsPanel.remove();
    state.settingsPanel = null;
  }
}

function openSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.innerHTML =
    '<div class="settings-title">設定</div>' +
    '<label class="settings-row"><input type="checkbox" data-key="snapshotsEnabled">' +
    '<span>修正スナップショットを保存する' +
    '<span class="settings-hint">修正ごとに差分ページを作る（コミットは作らない）</span></span></label>' +
    '<label class="settings-row"><input type="checkbox" data-key="readOnlyMode">' +
    '<span>読み取り専用モード' +
    '<span class="settings-hint">エージェントはコードを修正せず、コメントへの回答のみ行う</span></span></label>' +
    '<label class="settings-row"><input type="checkbox" data-key="viewedAutoReset">' +
    '<span>差分が変わったファイルの確認済みを自動解除' +
    '<span class="settings-hint">OFFにすると、修正で差分が変わっても確認済みを維持する（手動解除は可能）</span></span></label>' +
    '<label class="settings-row"><input type="checkbox" data-key="deliveryNoteEnabled">' +
    '<span>コメント配信時に指示（note）を同梱' +
    '<span class="settings-hint">受信のたびに下のテキストを処理指示としてエージェントに渡す</span></span></label>' +
    '<label class="settings-row settings-row-text"><span>同梱する指示テキスト' +
    '<span class="settings-hint">既定は「修正はサブエージェントに委譲する」指示。自由に書き換えられる（空なら送らない）</span>' +
    '<textarea data-text-key="deliveryNoteText" rows="3" ' +
    'placeholder="例: 修正後は必ず npm test を実行すること"></textarea></span></label>' +
    '<div class="settings-footnote">ここでの変更は現在のブランチにだけ保存されます。' +
    '自分の定番の初期値（指示テキスト等）は <code>.agent-review/.env</code> に ' +
    '<code>ARK_*</code> で定義でき、全ブランチに効きます（書式は README「設定のデフォルト（.env）」参照）。</div>';
  document.body.appendChild(panel);
  state.settingsPanel = panel;

  api('GET', '/api/settings').then(function (data) {
    panel.querySelectorAll('input[data-key]').forEach(function (input: any) {
      input.checked = !!(data.settings && data.settings[input.dataset.key]);
      input.addEventListener('change', function () {
        const body = {};
        body[input.dataset.key] = input.checked;
        api('PUT', '/api/settings', body).then(function (r) {
          applySettings(r.settings);
        }).catch(function (err) {
          input.checked = !input.checked;
          alert('設定の保存に失敗しました: ' + err);
        });
      });
    });
    panel.querySelectorAll('textarea[data-text-key]').forEach(function (area: any) {
      const saved = (data.settings && data.settings[area.dataset.textKey]) || '';
      area.value = saved;
      // Saved on change (= blur after an edit), not per keystroke.
      area.addEventListener('change', function () {
        const body = {};
        body[area.dataset.textKey] = area.value;
        api('PUT', '/api/settings', body).then(function (r) {
          applySettings(r.settings);
        }).catch(function (err) {
          alert('設定の保存に失敗しました: ' + err);
        });
      });
    });
  }).catch(function () {
    panel.innerHTML = '<div class="settings-title">設定を読み込めませんでした</div>';
  });
}

export function setupTopbarControls() {
  const inner = document.querySelector('#topbar .topbar-inner');
  if (!inner) return;

  // conn-state carries margin-left:auto, so everything appended after it
  // (badge, gear) sits at the right edge of the topbar.
  state.branchLabel = document.createElement('span');
  state.branchLabel.id = 'branch-label';
  inner.appendChild(state.branchLabel);

  state.modeBadge = document.createElement('span');
  state.modeBadge.id = 'mode-badge';
  state.modeBadge.textContent = '読み取り専用';
  state.modeBadge.title = '読み取り専用モード: エージェントはコードを修正せず回答のみ行います';
  state.modeBadge.hidden = true;
  inner.appendChild(state.modeBadge);

  const finishBtn = document.createElement('button');
  finishBtn.id = 'finish-btn';
  finishBtn.type = 'button';
  finishBtn.textContent = 'レビュー終了';
  finishBtn.title = 'レビューを終了する（コメント待機とサーバーを停止）';
  finishBtn.addEventListener('click', finishReview);
  inner.appendChild(finishBtn);

  const gear = document.createElement('button');
  gear.id = 'settings-btn';
  gear.type = 'button';
  gear.textContent = '⚙';
  gear.title = '設定';
  gear.addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.settingsPanel) closeSettingsPanel();
    else openSettingsPanel();
  });
  inner.appendChild(gear);

  // Click anywhere outside closes the panel.
  document.addEventListener('click', function (e) {
    if (state.settingsPanel && !state.settingsPanel.contains(e.target)) closeSettingsPanel();
  });
}

// End the review from the browser. The server dismisses untouched AI
// findings, signals wait-comments to exit, and then shuts itself down —
// so stop polling and cover the page with a done overlay.
function finishReview() {
  const msg =
    'レビューを終了しますか？\n' +
    '未対応の AI 指摘は見送り（dismissed）になり、コメント待機とサーバーを停止します。';
  if (!confirm(msg)) return;
  api('POST', '/api/finish', {}).then(function () {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    connState.textContent = 'レビューを終了しました';
    const overlay = document.createElement('div');
    overlay.id = 'finish-overlay';
    overlay.innerHTML =
      '<div class="finish-box">' +
      '<div class="finish-title">レビューを終了しました</div>' +
      '<div class="finish-note">サーバーは停止しました。このタブは閉じて構いません。<br>' +
      'レビューを再開するには agent-review-kit generate / serve を再実行してください。</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }).catch(function (err) {
    alert('レビュー終了に失敗しました: ' + err);
  });
}

/* ---------- back to top ---------- */

// Fixed round button (bottom-right) that scrolls to the top. Shown only once
// the page is scrolled past a threshold so it stays out of the way otherwise.
function setupScrollTop() {
  const btn = document.createElement('button');
  btn.id = 'scroll-top';
  btn.type = 'button';
  btn.title = 'TOPへ戻る';
  btn.setAttribute('aria-label', 'ページ上部へ戻る');
  btn.textContent = '↑';
  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.body.appendChild(btn);

  const THRESHOLD = 400;
  function update() {
    const y = window.pageYOffset || window.scrollY || 0;
    btn.classList.toggle('visible', y > THRESHOLD);
  }
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// Standalone read-only page for one repository file (/file/<path>,
// window.__FILE__ set): just the file header and the full-file table.
function renderFilePage() {
  const f = window.__FILE__;
  diffMeta.textContent = f.path;
  const box = document.createElement('section');
  box.className = 'file';
  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML = '<span class="file-name"></span>';
  header.querySelector('.file-name').textContent = f.path;
  header.appendChild(copyPathButton(f.path));
  box.appendChild(header);
  box.appendChild(buildFileTable(f));
  app.appendChild(box);
}

// Standalone views: /commit/<sha> (window.__COMMIT__), /snapshot/<id>
// (window.__SNAPSHOT__) and /file/<path> (window.__FILE__). All reuse the
// read-only renderers and skip the interactive review chrome — no comments,
// forms, polling or reloads. Bail out before any of that is wired.
function main() {
  if (window.__COMMIT__ || window.__SNAPSHOT__ || window.__FILE__) {
    restorePersistedWidths();
    if (window.__COMMIT__) renderCommitPage();
    else if (window.__SNAPSHOT__) renderSnapshotPage();
    else renderFilePage();
    setupScrollTop();
    return;
  }

  // HTML document review (/doc/<id>): its own layout and refresh loop; none
  // of the diff chrome below applies.
  if (DOC) {
    initDocMode();
    return;
  }

  restorePersistedWidths();
  setupTopbarControls();
  renderDiff();
  refresh();
  state.refreshTimer = setInterval(refresh, 3000);
  setupScrollTop();
}

main();
