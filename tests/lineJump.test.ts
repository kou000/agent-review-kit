import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLineJumpHref, jumpScrollTop, parseLineJump } from '../src/client/lineJump';

test('parses a single line and a range on the new side by default', () => {
  assert.deepEqual(parseLineJump('?file=src/a.rs&line=42'),
    { file: 'src/a.rs', side: 'new', start: 42, end: 42 });
  assert.deepEqual(parseLineJump('file=src/a.rs&line=10-12'),
    { file: 'src/a.rs', side: 'new', start: 10, end: 12 });
});

test('reads side=old and normalizes a reversed range', () => {
  assert.deepEqual(parseLineJump('?file=a.rs&line=12-10&side=old'),
    { file: 'a.rs', side: 'old', start: 10, end: 12 });
});

test('falls back to the file box when the line is missing or malformed', () => {
  assert.deepEqual(parseLineJump('?file=a.rs'), { file: 'a.rs', side: 'new', start: 0, end: 0 });
  assert.deepEqual(parseLineJump('?file=a.rs&line=abc'), { file: 'a.rs', side: 'new', start: 0, end: 0 });
});

test('returns null without a file', () => {
  assert.equal(parseLineJump(''), null);
  assert.equal(parseLineJump('?line=3'), null);
});

test('accepts only the /?file= href form', () => {
  assert.equal(isLineJumpHref('/?file=a.rs&line=1'), true);
  assert.equal(isLineJumpHref('?file=a.rs'), false);
  assert.equal(isLineJumpHref('/api/finish'), false);
  assert.equal(isLineJumpHref('https://example.com/?file=a'), false);
});

// Page scrolled to 1000, 800px viewport, topbar 41px (the band's sticky top),
// band 34px tall. The target file box starts 600px below the viewport top.
const base = { scrollY: 1000, viewportHeight: 800, stickyTop: 41, headerTop: 600, headerHeight: 34 };

test('a file-only jump puts the file band right under the topbar', () => {
  assert.equal(jumpScrollTop({ ...base, rowsTop: null, rowsBottom: null }), 1000 + 600 - 41);
});

test('a line visible below the band keeps the band at the top', () => {
  // Header aligned => scroll by 559; a row at 1200-1220 lands at 641-661.
  assert.equal(jumpScrollTop({ ...base, rowsTop: 1200, rowsBottom: 1220 }), 1559);
  // The last row ending exactly at the viewport bottom still counts as visible.
  assert.equal(jumpScrollTop({ ...base, rowsTop: 1339, rowsBottom: 800 + 559 }), 1559);
});

test('a line out of view from the band-aligned position sits just under the band', () => {
  // Row at 3000: scroll so it starts at 41 + 34 = 75.
  assert.equal(jumpScrollTop({ ...base, rowsTop: 3000, rowsBottom: 3020 }), 1000 + 3000 - 75);
  // A range taller than the viewport shows its first line under the band.
  assert.equal(jumpScrollTop({ ...base, rowsTop: 1200, rowsBottom: 2400 }), 1000 + 1200 - 75);
});

test('works when the target file is above the current position', () => {
  // Box 500px above the viewport top (its band may be stuck; headerTop is
  // the flow position, not the stuck one).
  assert.equal(jumpScrollTop({ ...base, headerTop: -500, rowsTop: -400, rowsBottom: -380 }), 1000 - 500 - 41);
});

test('never returns a negative scroll position', () => {
  assert.equal(jumpScrollTop({ ...base, scrollY: 0, headerTop: 20, rowsTop: null, rowsBottom: null }), 0);
});
