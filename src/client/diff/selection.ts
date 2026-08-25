import { state } from '../state.js';
import { cancelForm, showCommentForm } from './form.js';

/* ---------- selection ---------- */

function cellInfo(td) {
  return {
    file: td.dataset.file,
    side: td.dataset.side,
    line: parseInt(td.dataset.line, 10),
    diffLine: parseInt(td.dataset.diffLine, 10),
  };
}

export function clearSelectionHighlight() {
  document.querySelectorAll('td.selected').forEach(function (td) {
    td.classList.remove('selected');
  });
}

export function selectionRange() {
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
