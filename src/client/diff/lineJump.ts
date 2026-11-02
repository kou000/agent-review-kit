import { isLineJumpHref, parseLineJump } from '../lineJump.js';
import { DIFF } from '../state.js';
import { setCollapsed } from './collapse.js';
import { findRowFor } from './form.js';

const LINE_FLASH_MS = 2500;

// Scroll the main diff to the target of a line-jump URL and flash the rows.
// Falls back to the file box when the lines are outside the rendered hunks.
export function jumpToLocation(search) {
  const target = parseLineJump(search);
  if (!target) return;
  const fi = (DIFF.files || []).findIndex(function (f) { return f.path === target.file; });
  const box = fi >= 0 ? document.getElementById('file-' + fi) : null;
  if (!box) return;
  // 確認済み・折りたたみ中でも飛んだ先が読めるように展開する（マークは維持）。
  if (box.classList.contains('collapsed')) setCollapsed(box, false);

  const rows = [];
  for (let line = target.start; line > 0 && line <= target.end; line++) {
    const tr = findRowFor(target.file, target.side, line);
    if (tr) rows.push(tr);
  }
  const dest: any = rows[0] || box;
  if (typeof dest.scrollIntoView === 'function') {
    dest.scrollIntoView({ behavior: 'smooth', block: rows.length ? 'center' : 'start' });
  }
  rows.forEach(function (tr) { tr.classList.add('grep-line-flash'); });
  setTimeout(function () {
    rows.forEach(function (tr) { tr.classList.remove('grep-line-flash'); });
  }, LINE_FLASH_MS);
}

// Line-jump links in comment cards move within the page instead of
// reloading it; the back button returns through the same jumps.
export function setupLineJumpLinks() {
  document.addEventListener('click', function (e: any) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !isLineJumpHref(a.getAttribute('href'))) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    history.pushState(null, '', href);
    jumpToLocation(href.slice(href.indexOf('?')));
  });
  window.addEventListener('popstate', function () {
    jumpToLocation(location.search);
  });
}
