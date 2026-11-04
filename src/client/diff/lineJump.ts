import { isLineJumpHref, jumpScrollTop, parseLineJump } from '../lineJump.js';
import { DIFF } from '../state.js';
import { setCollapsed } from './collapse.js';
import { findRowFor } from './form.js';

const LINE_FLASH_MS = 2500;

// Scroll the main diff to the target of a line-jump URL and flash the rows.
// The file band comes to the top of the page; falls back to the file box
// alone when the lines are outside the rendered hunks.
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
  scrollToTarget(box, rows);
  rows.forEach(function (tr) { tr.classList.add('grep-line-flash'); });
  setTimeout(function () {
    rows.forEach(function (tr) { tr.classList.remove('grep-line-flash'); });
  }, LINE_FLASH_MS);
}

// Bring the file band (sticky .file-header) to the top of the page, then make
// sure the target rows are visible below it (see jumpScrollTop).
function scrollToTarget(box, rows) {
  const header: any = box.querySelector('.file-header');
  if (!header || typeof window.scrollTo !== 'function') {
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // The header is sticky, so its own rect is where it is stuck right now, not
  // where it sits in the flow. It is the box's first child: its unstuck top
  // is the box top plus the border.
  const boxRect = box.getBoundingClientRect();
  const first = rows.length ? rows[0].getBoundingClientRect() : null;
  const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null;
  const top = jumpScrollTop({
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    stickyTop: parseFloat(getComputedStyle(header).top) || 0,
    headerTop: boxRect.top + box.clientTop,
    headerHeight: header.getBoundingClientRect().height,
    rowsTop: first ? first.top : null,
    rowsBottom: last ? last.bottom : null,
  });
  window.scrollTo({ top, behavior: 'smooth' });
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
