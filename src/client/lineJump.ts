/* Line-jump links: `/?file=<path>&line=<n>[-<m>][&side=old]`.
 *
 * An agent writes these in comment bodies (e.g. "見るべき箇所" in an
 * overview comment) so the reader can jump to a line of the diff. Opening the
 * URL directly also lands on the line. Pure helpers only, so the parsing can
 * be unit-tested without a DOM; the scrolling lives in diff/lineJump.ts. */

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
