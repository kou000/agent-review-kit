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

  // Only accept self-contained base64 image data URIs for inline agent images.
  // This blocks javascript:, http(s):, and any other scheme, so a crafted
  // comments.json can never turn an attached "image" into an external request
  // or script. The value is still esc()'d before it lands in an attribute.
  function isSafeImageDataUri(s) {
    return typeof s === 'string' &&
      /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- syntax highlighting ----------
   * Highlighting is baked at generate time by Shiki (github-dark) into each
   * diff cell's `html` field (see codeCell). The client only renders that
   * pre-colored markup, so there is no runtime highlighter here. */

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

    expanders = {};

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
      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'collapse-btn';
      collapseBtn.textContent = '▾';
      collapseBtn.title = '折りたたむ';
      collapseBtn.setAttribute('aria-label', 'このファイルの表示を折りたたむ');
      collapseBtn.setAttribute('aria-expanded', 'true');
      collapseBtn.addEventListener('click', function () {
        const on = !box.classList.contains('collapsed');
        box.classList.toggle('collapsed', on);
        collapseBtn.textContent = on ? '▸' : '▾';
        collapseBtn.title = on ? '展開する' : '折りたたむ';
        collapseBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
      });
      header.insertBefore(collapseBtn, header.firstChild);

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
  }

  // Read-only render for the /commit/<sha> page (window.__COMMIT__ set). Same
  // file boxes and diff tables as renderDiff, but with none of the interactive
  // chrome: no collapse/viewed/pin buttons, no comment wiring, no sidebar.
  function renderCommitPage() {
    const c = window.__COMMIT__;
    diffMeta.textContent = c.shortSha + ' / ' + c.author + ' / ' + fmtDate(c.date);

    expanders = {};

    const frag = document.createDocumentFragment();

    const banner = document.createElement('div');
    banner.className = 'commit-banner';
    banner.innerHTML =
      '<div class="commit-subject"></div><div class="commit-meta-line"></div>';
    banner.querySelector('.commit-subject').textContent = c.subject;
    banner.querySelector('.commit-meta-line').textContent =
      'commit ' + c.sha + ' — ' + c.author + ' — ' + fmtDate(c.date);
    frag.appendChild(banner);

    if (!DIFF.files.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-diff';
      empty.textContent = 'このコミットには差分がありません。';
      frag.appendChild(empty);
    }

    DIFF.files.forEach(function (file, fi) {
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

    app.innerHTML = '';
    app.appendChild(frag);
  }

  /* ---------- context expansion (GitHub-style) ---------- */

  const EXPAND_STEP = 20;

  // Per-file gap controllers for the main (interactive) diff table, rebuilt on
  // every renderDiff. renderComments uses them (via tryExpandTo) to reveal a
  // commented line that is hidden inside a still-collapsed gap.
  let expanders = {};

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
    const list = expanders[path];
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
    if (interactive !== false) expanders[file.path] = controllers;
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
        esc(c.agentResponse.message);
      // A linked fix commit renders as a chip; clicking opens /commit/<sha>
      // (this commit's diff) in a new tab. sha is hex-only so it needs no
      // attribute escaping beyond esc() for the visible text.
      if (c.agentResponse.commit) {
        var sha = c.agentResponse.commit;
        html += '<a class="commit-link" href="/commit/' + encodeURIComponent(sha) +
          '" target="_blank" rel="noopener" title="このコミットの差分を新しいタブで開く">🔗 ' +
          esc(sha.slice(0, 7)) + '</a>';
      }
      // Inline images attached by the agent. Only data: image URIs pass the
      // sanitizer; anything else (javascript:, http:, ...) is silently dropped
      // so the UI never emits an external request or an unsafe src. Each image
      // links to itself so a click opens the full-size capture in a new tab.
      if (c.agentResponse.images && c.agentResponse.images.length) {
        var imgs = '';
        for (var ii = 0; ii < c.agentResponse.images.length; ii++) {
          var uri = c.agentResponse.images[ii];
          if (!isSafeImageDataUri(uri)) continue;
          imgs += '<a class="agent-image-link" href="' + esc(uri) +
            '" target="_blank" rel="noopener" title="原寸を新しいタブで開く">' +
            '<img class="agent-image" src="' + esc(uri) + '" alt="agent の添付画像"></a>';
        }
        if (imgs) html += '<div class="agent-images">' + imgs + '</div>';
      }
      html += '</div>';
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
      // seen のまま応答が滞留したコメントの復旧手段: open に戻して wait-comments
      // に再配達させる。エージェント処理中に押すと同じ id で二重に届くので、
      // 応答がないときのための手動リカバリと位置づける。
      if (c.status === 'seen') {
        const resend = document.createElement('button');
        resend.textContent = 'エージェントに再送';
        resend.title = '応答がないまま止まっているコメントを open に戻し、エージェントに再度配達する';
        resend.addEventListener('click', function () {
          api('PATCH', '/api/comments/' + encodeURIComponent(c.id), { status: 'open' })
            .then(refresh)
            .catch(function (err) { alert('更新に失敗しました: ' + err); });
        });
        actions.appendChild(resend);
      }
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
          // Close the form (removing its textarea) before refreshing so the
          // just-submitted text no longer counts as an in-progress draft;
          // otherwise the refresh defers forever and the form stays frozen.
          close();
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

  /* ---------- agent response toasts ---------- */

  // Notify (top-right toast) when the agent responds to a comment. The last
  // notified state of each agentResponse is persisted in localStorage so a
  // response is announced exactly once per browser, surviving the automatic
  // page reload that follows `generate`.
  const AGENT_SEEN_KEY = 'ark-agent-seen';
  const TOAST_MS = 10000;
  let toastStack = null;

  function ensureToastStack() {
    if (toastStack && document.body.contains(toastStack)) return toastStack;
    toastStack = document.createElement('div');
    toastStack.id = 'toast-stack';
    document.body.appendChild(toastStack);
    return toastStack;
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

  function notifyAgentUpdates(list) {
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

  // True while the user has an in-progress draft in any comment/reply form:
  // either the textarea is focused, or it holds unsent text. Used to defer the
  // 3s auto-refresh so re-rendering (which rebuilds thread rows) or a reload
  // never wipes what they are typing. Deferral ends as soon as the draft is
  // submitted, cleared, or blurred-empty; the next tick then catches up.
  function isEditingDraft() {
    const areas = document.querySelectorAll('.comment-form textarea, .reply-form textarea');
    for (let i = 0; i < areas.length; i++) {
      const ta = areas[i];
      if (document.activeElement === ta) return true;
      if (ta.value && ta.value.trim() !== '') return true;
    }
    return false;
  }

  function refresh() {
    return Promise.all([
      api('GET', '/api/comments'),
      api('GET', '/api/status'),
    ]).then(function (results) {
      const cs = results[0].comments || [];
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
      renderBadge(status);
      const json = JSON.stringify(cs);
      if (json !== lastCommentsJson) {
        lastCommentsJson = json;
        comments = cs;
        renderComments();
        notifyAgentUpdates(cs);
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

  // Commit view: served at /commit/<sha> with window.__COMMIT__ set. It reuses
  // the diff renderer read-only and skips all review chrome — no sidebar,
  // comments, forms, polling or reloads. Bail out before any of that is wired.
  if (window.__COMMIT__) {
    renderCommitPage();
    setupScrollTop();
    return;
  }

  restorePersistedWidths();
  renderDiff();
  refresh();
  setInterval(refresh, 3000);
  setupScrollTop();
})();
