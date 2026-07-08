/* agent-review-kit review UI (no build step, plain JS) */
(function () {
  'use strict';

  const DIFF = window.__DIFF__ || { files: [], base: null, generatedAt: '' };
  const app = document.getElementById('app');
  const badge = document.getElementById('unresolved-badge');
  const diffMeta = document.getElementById('diff-meta');
  const connState = document.getElementById('conn-state');

  let comments = [];
  let selection = null; // {file, side, anchor:{line,diffLine}, head:{line,diffLine}}
  let openForm = null; // form row element currently shown
  let dragging = false;
  // Multiple files can be pinned at once; each becomes a panel in a right-side
  // horizontal stack. `pins` holds them in visual left→right order (oldest
  // first, newest appended at the right edge). `width` is a viewport percentage.
  let pins = []; // [{ index, width, el }]
  let pinStack = null; // right-side flex-row container (created lazily)

  // Syntax highlighting (highlight.js, loaded via <script> before app.js).
  // For large diffs we defer highlighting to idle time so the UI never freezes.
  const HIGHLIGHT_SYNC_LIMIT = 3000; // total diff rows; above this, defer
  let hlDeferMode = false;
  let hlPending = []; // [{td, text, lang, prefixHtml}] queued for deferred pass

  // Viewed ("確認済み") state, GitHub "Viewed" semantics. Persisted in
  // localStorage as { [filePath]: contentHash }. On load a file counts as viewed
  // only when its stored hash still matches the current diff's hash, so a file
  // whose diff changed automatically reverts to unviewed. `fileHashes` caches the
  // current hash of every file (path -> hash).
  const VIEWED_KEY = 'ark-viewed';
  let viewed = {}; // { [filePath]: contentHash } for currently-viewed files
  let fileHashes = {}; // { [filePath]: contentHash } for the current diff

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- syntax highlighting ---------- */

  // File extension -> highlight.js language. Extensions not listed get no
  // highlighting (plain escaped text).
  const LANG_MAP = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json',
    css: 'css',
    md: 'markdown', markdown: 'markdown',
    html: 'xml', htm: 'xml',
    rs: 'rust',
    py: 'python',
    sh: 'bash', bash: 'bash',
    yml: 'yaml', yaml: 'yaml',
  };

  function langForPath(p) {
    if (!p) return null;
    const m = /\.([A-Za-z0-9]+)$/.exec(String(p));
    if (!m) return null;
    return LANG_MAP[m[1].toLowerCase()] || null;
  }

  // Returns hljs-escaped highlighted HTML, or null to signal "fall back to
  // esc(text)". Safe when hljs is absent, language is unknown, or it throws.
  function highlightHtml(text, lang) {
    if (!lang) return null;
    if (typeof hljs === 'undefined' || !hljs || typeof hljs.highlight !== 'function') {
      return null;
    }
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch (e) {
      return null;
    }
  }

  function totalDiffRows() {
    let n = 0;
    (DIFF.files || []).forEach(function (f) {
      (f.hunks || []).forEach(function (h) { n += (h.rows || []).length; });
    });
    return n;
  }

  // Process the deferred-highlight queue in idle-time chunks so a large diff
  // never blocks the main thread. Falls back to setTimeout where
  // requestIdleCallback is unavailable (e.g. jsdom).
  function scheduleHighlight() {
    if (!hlPending.length) return;
    const queue = hlPending;
    hlPending = [];
    let i = 0;
    const CHUNK = 400;
    const ric = window.requestIdleCallback || function (cb) {
      return setTimeout(function () { cb(); }, 16);
    };
    function step() {
      const end = Math.min(i + CHUNK, queue.length);
      for (; i < end; i++) {
        const item = queue[i];
        const html = highlightHtml(item.text, item.lang);
        if (html !== null) item.td.innerHTML = item.prefixHtml + html;
      }
      if (i < queue.length) ric(step);
    }
    ric(step);
  }

  /* ---------- copy path ---------- */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return copyTextFallback(text); }
      );
    }
    return Promise.resolve(copyTextFallback(text));
  }

  function copyTextFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // Small button that copies `path` to the clipboard and flashes ✓ on success.
  function copyPathButton(path) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-path-btn';
    btn.textContent = '⧉';
    btn.title = 'パスをコピー: ' + path;
    btn.setAttribute('aria-label', 'ファイルパスをコピー');
    btn.addEventListener('click', function () {
      copyText(path).then(function (ok) {
        btn.textContent = ok ? '✓' : '✕';
        btn.classList.toggle('copied', ok);
        setTimeout(function () {
          btn.textContent = '⧉';
          btn.classList.remove('copied');
        }, 1200);
      });
    });
    return btn;
  }

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
    fileHashes = {};
    (DIFF.files || []).forEach(function (f) { fileHashes[f.path] = fileHash(f); });
  }

  // Load persisted viewed state, keeping only entries whose stored hash still
  // matches the current file (auto-reset on diff change) and whose file still
  // exists. Stale/mismatched entries are pruned and the cleaned map is saved.
  function loadViewed() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(VIEWED_KEY)) || {}; } catch (e) { saved = {}; }
    const next = {};
    (DIFF.files || []).forEach(function (f) {
      if (saved[f.path] && saved[f.path] === fileHashes[f.path]) {
        next[f.path] = fileHashes[f.path];
      }
    });
    viewed = next;
    saveViewed();
  }

  function saveViewed() {
    try { localStorage.setItem(VIEWED_KEY, JSON.stringify(viewed)); } catch (e) { /* ignore */ }
  }

  function isViewed(path) {
    return Object.prototype.hasOwnProperty.call(viewed, path);
  }

  function setFileViewed(path, on) {
    if (on) viewed[path] = fileHashes[path];
    else delete viewed[path];
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

  function statusLabel(st) {
    return { modified: 'modified', added: 'added', deleted: 'deleted', renamed: 'renamed', binary: 'binary' }[st] || st;
  }

  function renderDiff() {
    diffMeta.textContent = (DIFF.base ? 'base: ' + DIFF.base : 'working tree vs HEAD') +
      ' / generated: ' + fmtDate(DIFF.generatedAt);

    // Compute per-file content hashes and load persisted viewed state (which
    // auto-resets files whose diff changed) before building any boxes.
    computeFileHashes();
    loadViewed();

    // Decide up front whether to highlight synchronously or defer to idle time.
    hlDeferMode = totalDiffRows() > HIGHLIGHT_SYNC_LIMIT;
    hlPending = [];

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

      header.appendChild(copyPathButton(file.path));

      // 確認済み (Viewed) toggle: collapses this file's body and moves it to the
      // "確認済み" section of the tree. Placed to the left of 📌. Checkbox-like.
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
      if (isViewed(file.path)) box.classList.add('viewed');
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
    scheduleHighlight();
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

    const lang = langForPath(file.path);

    file.hunks.forEach(function (hunk) {
      const hr = document.createElement('tr');
      hr.className = 'hunk';
      hr.innerHTML = '<td colspan="4">' + esc(hunk.header) + '</td>';
      tbody.appendChild(hr);

      hunk.rows.forEach(function (row) {
        const tr = document.createElement('tr');
        tr.className = 'diff-row';
        tr.appendChild(numCell(file, 'old', row.left, interactive));
        tr.appendChild(codeCell(row.left, 'del', lang));
        tr.appendChild(numCell(file, 'new', row.right, interactive));
        tr.appendChild(codeCell(row.right, 'add', lang));
        tbody.appendChild(tr);
      });
    });
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
    if (pinStack) return pinStack;
    pinStack = document.createElement('div');
    pinStack.id = 'pin-stack';
    document.body.appendChild(pinStack);
    return pinStack;
  }

  function pinTotalWidth() {
    return pins.reduce(function (sum, p) { return sum + p.width; }, 0);
  }

  // Push panel widths and the combined right-side gutter into the DOM. The
  // main content's margin-right tracks --pin-total-width so it never overlaps.
  function updatePinLayout() {
    pins.forEach(function (p) { p.el.style.width = p.width + 'vw'; });
    document.documentElement.style.setProperty('--pin-total-width', pinTotalWidth() + 'vw');
    document.body.classList.toggle('has-pin', pins.length > 0);
  }

  function updatePinButtons() {
    const pinned = {};
    pins.forEach(function (p) { pinned[String(p.index)] = true; });
    document.querySelectorAll('.pin-btn').forEach(function (b) {
      const active = !!pinned[b.dataset.fileIndex];
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
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
    panel.querySelector('.pin-panel-file').title = file.path;
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
    const i = pins.findIndex(function (p) { return p.index === fi; });
    if (i < 0) return;
    pins[i].el.remove();
    pins.splice(i, 1);
    if (!pins.length && pinStack) {
      pinStack.remove();
      pinStack = null;
    }
    updatePinLayout();
    updatePinButtons();
  }

  function pinFile(fi) {
    const file = DIFF.files[fi];
    if (!file) return;
    if (pins.some(function (p) { return p.index === fi; })) return;

    // Target width: first panel uses the last-used width (default 45%), the rest
    // use PIN_NEXT_DEFAULT. Shrink the newcomer to whatever room is left; if even
    // PIN_MIN won't fit, drop the oldest pin(s) until it does (with a warning).
    const target = pins.length === 0 ? clampPinWidth(savedPinDefault()) : PIN_NEXT_DEFAULT;
    let width = Math.min(target, PIN_TOTAL_MAX - pinTotalWidth());
    if (width < PIN_MIN) {
      while (pins.length && PIN_TOTAL_MAX - pinTotalWidth() < PIN_MIN) {
        const oldest = pins[0];
        console.warn('agent-review-kit: pinned panels exceed available width; unpinning ' +
          DIFF.files[oldest.index].path);
        removePin(oldest.index);
      }
      width = Math.min(target, PIN_TOTAL_MAX - pinTotalWidth());
    }
    width = clampPinWidth(width);

    const stack = ensurePinStack();
    const panel = buildPinPanel(fi);
    pins.push({ index: fi, width: width, el: panel });
    stack.appendChild(panel); // newest at the right edge
    updatePinLayout();
    updatePinButtons();
    // In deferred mode the new panel's cells were queued; drain them now.
    scheduleHighlight();
  }

  // Re-📌 an already-pinned file unpins just that panel; 📌 a new file adds one.
  function togglePin(fi) {
    if (pins.some(function (p) { return p.index === fi; })) removePin(fi);
    else pinFile(fi);
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
      '<div class="buttons"><button class="primary overall-submit">コメントを追加</button></div>' +
      '</div>';

    const textarea = sec.querySelector('textarea');
    const btn = sec.querySelector('.overall-submit');

    function submit() {
      const body = textarea.value.trim();
      if (!body) return;
      btn.disabled = true;
      api('POST', '/api/comments', { body: body }).then(function () {
        textarea.value = '';
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

  let sidebarBuilt = false;

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

  function buildSidebar() {
    if (sidebarBuilt || !DIFF.files.length) return;
    const parent = app.parentNode;
    if (!parent) return;

    const layout = document.createElement('div');
    layout.className = 'layout';
    parent.insertBefore(layout, app);

    const sidebar = document.createElement('aside');
    sidebar.id = 'file-tree';
    sidebar.className = 'sidebar';
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
    sidebarBuilt = true;

    // Populate the tree/確認済み sections now that the sidebar is in the DOM
    // (renderSidebarTree looks its containers up by id/selector).
    renderSidebarTree();
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
      viewedWrap.appendChild(h);

      const list = document.createElement('div');
      list.className = 'viewed-list';
      renderTreeNode(buildTreeFrom(viewedEntries), list, 0);
      viewedWrap.appendChild(list);
    }

    updateTreeCounts();
  }

  function updateTreeCounts() {
    const counts = {};
    comments.forEach(function (c) {
      if (c.file === null || c.file === undefined) return;
      counts[c.file] = (counts[c.file] || 0) + 1;
    });
    document.querySelectorAll('.tree-count[data-file]').forEach(function (el) {
      const n = counts[el.dataset.file] || 0;
      el.textContent = n ? String(n) : '';
      el.style.display = n ? '' : 'none';
    });
  }

  function commentLocShort(c) {
    if (c.file === null || c.file === undefined) return '全体';
    const range = c.startLine === c.endLine
      ? 'L' + c.startLine
      : 'L' + c.startLine + '-' + c.endLine;
    return c.file + ':' + range;
  }

  function bodySnippet(s) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }

  function focusComment(id) {
    const card = document.querySelector(
      '.comment-card[data-comment-id="' + id + '"]'
    );
    if (!card) return;
    if (typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    card.classList.add('comment-flash');
    setTimeout(function () { card.classList.remove('comment-flash'); }, 1500);
  }

  function commentListItem(c, isReply) {
    const item = document.createElement('div');
    item.className = 'comment-item' + (isReply ? ' comment-item-reply' : '');
    item.title = commentLocShort(c) + ' — ' + c.body;

    const pill = document.createElement('span');
    pill.className = 'status-pill status-' + c.status;
    pill.textContent = c.status;

    const loc = document.createElement('span');
    loc.className = 'comment-item-loc';
    loc.textContent = isReply ? '↳ 返信' : commentLocShort(c);

    const body = document.createElement('span');
    body.className = 'comment-item-body';
    body.textContent = bodySnippet(c.body);

    item.appendChild(pill);
    item.appendChild(loc);
    item.appendChild(body);
    item.addEventListener('click', function () { focusComment(c.id); });
    return item;
  }

  // Re-render the sidebar comment list. Called on the same cadence as
  // updateTreeCounts (from renderComments) so it tracks every refresh. Replies
  // are nested (indented) directly under their top-level parent.
  function renderCommentList() {
    const list = document.querySelector('.sidebar .comment-list');
    if (!list) return;
    const title = document.getElementById('sidebar-comments-title');
    if (title) title.textContent = 'コメント (' + comments.length + ')';
    list.innerHTML = '';

    const s = threadStructure(comments);
    s.tops.forEach(function (top) {
      list.appendChild(commentListItem(top, false));
      (s.repliesByParent[top.id] || []).forEach(function (r) {
        list.appendChild(commentListItem(r, true));
      });
    });
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

  function codeCell(cell, changedKind, lang) {
    const td = document.createElement('td');
    td.className = 'code';
    if (!cell) {
      td.className += ' empty';
      return td;
    }
    if (cell.kind === changedKind) td.className += ' ' + changedKind;
    const prefix = cell.kind === 'add' ? '+' : cell.kind === 'del' ? '-' : ' ';
    const prefixHtml = '<span class="prefix">' + prefix + '</span>';
    if (lang && hlDeferMode) {
      // Render plain now; queue for idle-time highlighting.
      td.innerHTML = prefixHtml + esc(cell.text);
      hlPending.push({ td: td, text: cell.text, lang: lang, prefixHtml: prefixHtml });
    } else if (lang) {
      const html = highlightHtml(cell.text, lang);
      td.innerHTML = prefixHtml + (html !== null ? html : esc(cell.text));
    } else {
      td.innerHTML = prefixHtml + esc(cell.text);
    }
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
    if (!selection) return null;
    const a = selection.anchor;
    const b = selection.head;
    const startLine = Math.min(a.line, b.line);
    const endLine = Math.max(a.line, b.line);
    const startDiffLine = Math.min(a.diffLine, b.diffLine);
    const endDiffLine = Math.max(a.diffLine, b.diffLine);
    return {
      file: selection.file,
      side: selection.side,
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
    if (extend && selection && selection.file === c.file && selection.side === c.side) {
      selection.head = { line: c.line, diffLine: c.diffLine };
    } else {
      selection = {
        file: c.file,
        side: c.side,
        anchor: { line: c.line, diffLine: c.diffLine },
        head: { line: c.line, diffLine: c.diffLine },
      };
    }
    highlightSelection();
  }

  document.addEventListener('mousedown', function (e) {
    const td = e.target.closest && e.target.closest('td.num[data-file]');
    if (!td) return;
    e.preventDefault();
    beginSelection(td, e.shiftKey);
    dragging = true;
  });

  document.addEventListener('mouseover', function (e) {
    if (!dragging || !selection) return;
    const td = e.target.closest && e.target.closest('td.num[data-file]');
    if (!td) return;
    const c = cellInfo(td);
    if (c.file !== selection.file || c.side !== selection.side) return;
    selection.head = { line: c.line, diffLine: c.diffLine };
    highlightSelection();
  });

  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    if (selection) showCommentForm();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') cancelForm();
  });

  /* ---------- comment form ---------- */

  function findRowFor(file, side, line) {
    const tds = document.querySelectorAll(
      'td.num[data-file][data-side="' + side + '"][data-line="' + line + '"]'
    );
    for (let i = 0; i < tds.length; i++) {
      if (tds[i].dataset.file === file) return tds[i].closest('tr');
    }
    return null;
  }

  function cancelForm() {
    if (openForm) {
      openForm.remove();
      openForm = null;
    }
    selection = null;
    clearSelectionHighlight();
  }

  function showCommentForm() {
    const r = selectionRange();
    if (!r) return;
    if (openForm) openForm.remove();

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

    const wrap = document.createElement('div');
    wrap.className = 'comment-form';
    wrap.innerHTML =
      '<div class="form-meta">' + esc(r.file) + ' / ' + sideText + ' ' + rangeText + ' にコメント</div>' +
      '<textarea placeholder="コメントを入力（Ctrl+Enterで送信）"></textarea>' +
      '<div class="buttons">' +
      '<button class="primary submit">コメントを追加</button>' +
      '<button class="cancel">キャンセル</button>' +
      '</div>';
    td.appendChild(wrap);
    tr.appendChild(td);
    anchorRow.after(tr);
    openForm = tr;

    const textarea = wrap.querySelector('textarea');
    textarea.focus();

    function submit() {
      const body = textarea.value.trim();
      if (!body) return;
      wrap.querySelector('.submit').disabled = true;
      api('POST', '/api/comments', {
        file: r.file,
        side: r.side,
        startLine: r.startLine,
        endLine: r.endLine,
        startDiffLine: r.startDiffLine,
        endDiffLine: r.endDiffLine,
        body: body,
      }).then(function () {
        cancelForm();
        refresh();
      }).catch(function (err) {
        alert('コメントの保存に失敗しました: ' + err);
        wrap.querySelector('.submit').disabled = false;
      });
    }

    wrap.querySelector('.submit').addEventListener('click', submit);
    wrap.querySelector('.cancel').addEventListener('click', cancelForm);
    textarea.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
    });
  }

  /* ---------- comment threads ---------- */

  function commentCard(c, isReply) {
    const div = document.createElement('div');
    div.className = 'comment-card' + (isReply ? ' reply-card' : '');
    div.dataset.commentId = c.id;

    // Replies are visually nested under their parent, so the anchor location is
    // already implied; show a "↳ 返信" marker instead of repeating it.
    let posText;
    if (isReply) {
      posText = '↳ 返信';
    } else if (c.file === null || c.file === undefined) {
      posText = 'レビュー全体';
    } else {
      const range = c.startLine === c.endLine ? 'L' + c.startLine : 'L' + c.startLine + '-L' + c.endLine;
      posText = esc(c.file) + ' ' + (c.side === 'new' ? '' : '(旧) ') + esc(range);
    }
    let html =
      '<div class="meta">' +
      '<span class="status-pill status-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
      '<span>' + posText + '</span>' +
      '<span>' + esc(fmtDate(c.createdAt)) + '</span>' +
      '</div>' +
      '<div class="body">' + esc(c.body) + '</div>';
    if (c.agentResponse && c.agentResponse.message) {
      html += '<div class="agent-response"><span class="who">agent</span>' +
        esc(c.agentResponse.message) + '</div>';
    }
    div.innerHTML = html;

    if (c.status !== 'resolved') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const btn = document.createElement('button');
      btn.textContent = 'Resolve';
      btn.addEventListener('click', function () {
        api('POST', '/api/comments/' + encodeURIComponent(c.id) + '/resolve', {})
          .then(refresh)
          .catch(function (err) { alert('更新に失敗しました: ' + err); });
      });
      actions.appendChild(btn);
      div.appendChild(actions);
    }
    return div;
  }

  function byCreatedAsc(a, b) {
    return String(a.createdAt).localeCompare(String(b.createdAt));
  }

  // Split a flat list of comments (sharing one anchor, or the overall bucket)
  // into top-level comments (createdAt asc) each with its replies grouped by
  // parentId. A reply whose parent is absent from the list is surfaced as a
  // top-level entry so it is never silently hidden.
  function threadStructure(list) {
    const tops = [];
    const topIds = {};
    const repliesByParent = {};
    list.forEach(function (c) {
      if (c.parentId === null || c.parentId === undefined) {
        tops.push(c);
        topIds[c.id] = true;
      }
    });
    list.forEach(function (c) {
      if (c.parentId === null || c.parentId === undefined) return;
      if (topIds[c.parentId]) {
        (repliesByParent[c.parentId] = repliesByParent[c.parentId] || []).push(c);
      } else {
        tops.push(c);
      }
    });
    tops.sort(byCreatedAsc);
    Object.keys(repliesByParent).forEach(function (k) {
      repliesByParent[k].sort(byCreatedAsc);
    });
    return { tops: tops, repliesByParent: repliesByParent };
  }

  // Render a thread (top-level cards, each followed by its nested replies and a
  // reply form) into a container. Shared by line threads, the overall section
  // and the orphan section.
  function renderThread(container, list) {
    const s = threadStructure(list);
    s.tops.forEach(function (top) {
      const block = document.createElement('div');
      block.className = 'comment-thread-block';
      block.appendChild(commentCard(top));
      const replies = s.repliesByParent[top.id] || [];
      if (replies.length) {
        const nest = document.createElement('div');
        nest.className = 'reply-thread';
        replies.forEach(function (r) { nest.appendChild(commentCard(r, true)); });
        block.appendChild(nest);
      }
      appendReplyUI(block, top);
      container.appendChild(block);
    });
  }

  function renderComments() {
    document.querySelectorAll('tr.thread-row, .orphan-section').forEach(function (el) {
      el.remove();
    });

    const orphans = [];
    const byAnchor = {};
    const overall = [];

    const overallList = document.querySelector('.overall-list');
    if (overallList) overallList.innerHTML = '';

    comments.forEach(function (c) {
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
      const row = findRowFor(c0.file, c0.side, c0.endLine);
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

  // `top` is the top-level comment of the thread. Replies POST only parentId +
  // body; the server copies the anchor from the parent (so a reply can never
  // drift from its thread) and normalizes parentId to the top-level id.
  function appendReplyUI(td, top) {
    const wrap = document.createElement('div');
    wrap.className = 'reply-wrap';
    const btn = document.createElement('button');
    btn.className = 'reply-toggle';
    btn.textContent = '返信';
    wrap.appendChild(btn);
    td.appendChild(wrap);

    btn.addEventListener('click', function () {
      btn.style.display = 'none';
      const form = document.createElement('div');
      form.className = 'reply-form';
      form.innerHTML =
        '<textarea placeholder="返信を入力（Ctrl+Enterで送信）"></textarea>' +
        '<div class="buttons">' +
        '<button class="primary reply-submit">返信する</button>' +
        '<button class="reply-cancel">キャンセル</button>' +
        '</div>';
      wrap.appendChild(form);
      const textarea = form.querySelector('textarea');
      textarea.focus();

      function close() {
        form.remove();
        btn.style.display = '';
      }
      function submit() {
        const body = textarea.value.trim();
        if (!body) return;
        form.querySelector('.reply-submit').disabled = true;
        api('POST', '/api/comments', {
          parentId: top.id,
          body: body,
        }).then(function () {
          refresh();
        }).catch(function (err) {
          alert('返信の保存に失敗しました: ' + err);
          form.querySelector('.reply-submit').disabled = false;
        });
      }
      form.querySelector('.reply-submit').addEventListener('click', submit);
      form.querySelector('.reply-cancel').addEventListener('click', close);
      textarea.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
      });
    });
  }

  function renderBadge(status) {
    const unresolved = status ? status.unresolved : null;
    if (unresolved === null || unresolved === undefined) {
      badge.textContent = '-';
      return;
    }
    badge.textContent = '未解決 ' + unresolved;
    badge.className = 'badge' + (unresolved === 0 ? ' zero' : '');
  }

  /* ---------- api ---------- */

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error(res.status + ' ' + t); });
      }
      return res.json();
    });
  }

  let lastCommentsJson = '';

  function refresh() {
    return Promise.all([
      api('GET', '/api/comments'),
      api('GET', '/api/status'),
    ]).then(function (results) {
      const cs = results[0].comments || [];
      const status = results[1];
      connState.textContent = '';
      if (status.generatedAt && DIFF.generatedAt && status.generatedAt !== DIFF.generatedAt) {
        location.reload();
        return;
      }
      renderBadge(status);
      const json = JSON.stringify(cs);
      if (json !== lastCommentsJson) {
        lastCommentsJson = json;
        comments = cs;
        renderComments();
      }
    }).catch(function () {
      connState.textContent = 'サーバー未接続（agent-review-kit serve を起動してください）';
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

  /* ---------- draggable panel widths ---------- */

  // Sidebar width (px) and pin-panel width (viewport %) are driven by CSS
  // variables so the pin margin-right stays in sync with the panel width by
  // construction. Both are clamped and persisted in localStorage.
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_KEY = 'ark-sidebar-width';
  const PIN_MIN = 15; // % of viewport (per panel)
  const PIN_MAX = 75;
  const PIN_KEY = 'ark-pin-width'; // last-used panel width, reused as a default

  function setSidebarWidth(px) {
    const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    return w;
  }

  function clampPinWidth(pct) {
    return Math.max(PIN_MIN, Math.min(PIN_MAX, pct));
  }

  // Last-used panel width, reused as the default for the first pinned panel.
  function savedPinDefault() {
    try {
      const p = parseFloat(localStorage.getItem(PIN_KEY));
      if (!isNaN(p)) return p;
    } catch (e) { /* ignore */ }
    return 45;
  }

  // Shared drag loop. onMove(clientX) runs on each pointermove; document-level
  // listeners (capture phase) guarantee the drag ends even if the pointer
  // leaves the handle. body.resizing disables text selection for the duration.
  function startDrag(handle, onMove) {
    document.body.classList.add('resizing');
    if (handle) handle.classList.add('dragging');
    function move(ev) {
      if (typeof ev.clientX !== 'number') return;
      onMove(ev.clientX);
    }
    function up() {
      document.body.classList.remove('resizing');
      if (handle) handle.classList.remove('dragging');
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    }
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }

  // Wire the sidebar drag handle. stopPropagation keeps the handle's pointerdown
  // from ever reaching the document-level diff-selection handlers.
  function attachSidebarResize(handle, sidebar) {
    handle.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const left = sidebar.getBoundingClientRect().left;
      startDrag(handle, function (clientX) {
        const w = setSidebarWidth(clientX - left);
        try { localStorage.setItem(SIDEBAR_KEY, String(w)); } catch (e2) { /* ignore */ }
      });
    });
  }

  // Resize a single pin panel. The panel's right edge is fixed during its own
  // drag (the stack is right-anchored; only this panel's left edge moves), so
  // the width is (rightEdge - pointerX). Persist it as the reusable default.
  function attachPinResize(handle, panel) {
    handle.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const entry = pins.find(function (p) { return p.el === panel; });
      if (!entry) return;
      const rightPx = panel.getBoundingClientRect().right;
      startDrag(handle, function (clientX) {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1;
        const pct = clampPinWidth((rightPx - clientX) / vw * 100);
        entry.width = pct;
        updatePinLayout();
        try { localStorage.setItem(PIN_KEY, String(pct)); } catch (e2) { /* ignore */ }
      });
    });
  }

  function restorePersistedWidths() {
    try {
      const s = parseFloat(localStorage.getItem(SIDEBAR_KEY));
      if (!isNaN(s)) setSidebarWidth(s);
    } catch (e) { /* ignore */ }
    // Pin widths are per-panel and applied when a panel is created; nothing to
    // restore globally (the last-used width is read via savedPinDefault).
  }

  restorePersistedWidths();
  renderDiff();
  refresh();
  setInterval(refresh, 3000);
  setupScrollTop();
})();
