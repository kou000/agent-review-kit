import { app, state } from '../state.js';
import { updateCommentsToggle } from '../app.js';
import { pruneThreadCollapse, renderThread } from '../threads.js';
import { findRowFor } from './form.js';
import { renderCommentList, updateTreeCounts } from './sidebar.js';
import { tryExpandTo } from './table.js';

export function renderComments() {
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
  updateCommentsToggle();
}
