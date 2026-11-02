import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLineJumpHref, parseLineJump } from '../src/client/lineJump';

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
