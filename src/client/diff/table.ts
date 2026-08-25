import { esc } from '../dom.js';
import { state } from '../state.js';

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

export function tryExpandTo(path, side, line) {
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
export function buildDiffTable(file, interactive) {
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

export function numCell(file, side, cell, interactive) {
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

export function codeCell(cell, changedKind) {
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
