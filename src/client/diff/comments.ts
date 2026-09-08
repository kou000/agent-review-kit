import { app, state } from '../state.js';
import { updateCommentsToggle } from '../app.js';
import { pruneThreadCollapse, renderThread } from '../threads.js';
import { findRowFor } from './form.js';
import { renderCommentList, updateTreeCounts } from './sidebar.js';
import { tryExpandTo, widgetRow } from './table.js';

// The container a file box keeps for its file-level comments (built by
// renderDiff, right under the header). Matched on dataset rather than a
// selector so a path with a quote in it can never break the lookup.
function fileCommentList(filePath) {
  const boxes: any = document.querySelectorAll('.file[data-file]');
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].dataset.file === filePath) return boxes[i].querySelector('.file-comments');
  }
  return null;
}

export function renderComments() {
  pruneThreadCollapse();
  document.querySelectorAll('tr.thread-row, .orphan-section').forEach(function (el) {
    el.remove();
  });
  document.querySelectorAll('.file-comments').forEach(function (el) {
    el.innerHTML = '';
  });

  const orphans = [];
  const byAnchor = {};
  const byFile = {};
  const overall = [];

  const overallList = document.querySelector('.overall-list');
  if (overallList) overallList.innerHTML = '';

  state.comments.forEach(function (c) {
    if (c.file === null || c.file === undefined) {
      overall.push(c);
      return;
    }
    // File-level comment: a file but no line anchor. It belongs to the file
    // box as a whole, not to a row of its diff table.
    if (c.startLine === null || c.startLine === undefined) {
      (byFile[c.file] = byFile[c.file] || []).push(c);
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

  // File-level threads render directly under their file's header. A file that
  // has dropped out of the diff has no box, so its comments fall through to
  // the orphan section like a line comment whose row is gone.
  Object.keys(byFile).forEach(function (filePath) {
    const holder = fileCommentList(filePath);
    if (!holder) {
      orphans.push.apply(orphans, byFile[filePath]);
      return;
    }
    renderThread(holder, byFile[filePath]);
  });

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
    // The thread sits in the half of the split view its anchor belongs to.
    const w = widgetRow('thread-row', c0.side);
    const tr = w.tr;
    renderThread(w.td, list);
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
  updateCommentsToggle();
}
