/* Line-jump links: `/?file=<path>&line=<n>[-<m>][&side=old]`.
 *
 * An agent writes these in comment bodies (e.g. "見るべき箇所" in an
 * overview comment) so the reader can jump to a line of the diff. Opening the
 * URL directly also lands on the line. Pure helpers only, so the parsing and
 * the scroll position can be unit-tested without a DOM; the DOM side lives in
 * diff/lineJump.ts. */

export type LineJumpTarget = {
  file: string;
  side: 'new' | 'old';
  start: number;
  end: number;
};

// The only relative href renderMarkdown lets through. Anything else that is
// not http(s)/mailto stays plain text, as before.
export const LINE_JUMP_HREF_RE = /^\/\?file=/;

export function isLineJumpHref(url: string): boolean {
  return LINE_JUMP_HREF_RE.test(url);
}

// Parse a location.search string (with or without the leading '?').
// Returns null when there is no file; a missing or malformed line jumps to
// the file box only (start/end = 0).
export function parseLineJump(search: string): LineJumpTarget | null {
  const params = new URLSearchParams(search);
  const file = params.get('file');
  if (!file) return null;
  const side = params.get('side') === 'old' ? 'old' : 'new';
  const m = /^(\d+)(?:-(\d+))?$/.exec(params.get('line') || '');
  if (!m) return { file, side, start: 0, end: 0 };
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  return { file, side, start: Math.min(start, end), end: Math.max(start, end) };
}

// Viewport measurements (getBoundingClientRect / window values) taken right
// before the jump. All `*Top`/`*Bottom` are viewport coordinates.
export type JumpMetrics = {
  scrollY: number;
  viewportHeight: number;
  // The file header's sticky `top` (just under the sticky topbar).
  stickyTop: number;
  // Top of the target file's header (the file band) where it sits in the
  // flow — not where it is stuck — and its height.
  headerTop: number;
  headerHeight: number;
  // Top of the first and bottom of the last target row; null for a jump to
  // the file only, or when none of the lines are in the rendered hunks.
  rowsTop: number | null;
  rowsBottom: number | null;
};

// Where to scroll (window.scrollY) for a line-jump.
// 1. Put the target file's header in its sticky slot, so the band reads as
//    the top of the page and the file starts right under it.
// 2. If the target rows are not fully visible from there (long file, line far
//    down), scroll further so the first row sits just under the band, which
//    stays stuck at the top. A range taller than the viewport shows its start.
export function jumpScrollTop(m: JumpMetrics): number {
  const headerAligned = m.scrollY + m.headerTop - m.stickyTop;
  if (m.rowsTop === null || m.rowsBottom === null) return Math.max(0, headerAligned);
  const shift = headerAligned - m.scrollY;
  if (m.rowsBottom - shift <= m.viewportHeight) return Math.max(0, headerAligned);
  const rowUnderBand = m.scrollY + m.rowsTop - (m.stickyTop + m.headerHeight);
  return Math.max(0, rowUnderBand);
}
