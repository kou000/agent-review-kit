import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractCommentFences,
  highlightFences,
  langForFenceInfo,
} from '../src/highlight';

// Must stay in sync with FENCE_STYLE_RE in src/client/markdown.ts: every
// style the server stores has to pass the client's validator, or the
// highlighting would be silently dropped at render time.
const CLIENT_STYLE_RE =
  /^color:#[0-9a-fA-F]{3,8}(;font-style:italic)?(;font-weight:bold)?(;text-decoration:underline)?$/;

test('langForFenceInfo resolves extensions, ids and rejects the rest', () => {
  assert.equal(langForFenceInfo('ts'), 'typescript');
  assert.equal(langForFenceInfo('py'), 'python');
  assert.equal(langForFenceInfo('typescript'), 'typescript');
  assert.equal(langForFenceInfo('TS'), 'typescript');
  // Only the first word of the info string counts (```ts title=foo).
  assert.equal(langForFenceInfo(' ts title=foo'), 'typescript');
  assert.equal(langForFenceInfo(''), null);
  assert.equal(langForFenceInfo('   '), null);
  assert.equal(langForFenceInfo('nosuchlang'), null);
});

test('extractCommentFences finds fences with the client liftFences rules', () => {
  assert.deepEqual(
    extractCommentFences('前\n```ts\nconst x = 1\n```\n後\n```\nplain\n```'),
    [
      { info: 'ts', code: 'const x = 1' },
      { info: '', code: 'plain' },
    ]
  );
});

test('extractCommentFences handles indent, CRLF and an unclosed fence', () => {
  // Markers may be indented (/^\s*```/), CRLF is normalized first, and an
  // unclosed fence runs to the end of the text — same as the client.
  assert.deepEqual(extractCommentFences('  ```js\r\na\r\nb\r\n  ```\r\n```sh\r\necho hi'), [
    { info: 'js', code: 'a\nb' },
    { info: 'sh', code: 'echo hi' },
  ]);
});

test('extractCommentFences returns nothing for fence-less text', () => {
  assert.deepEqual(extractCommentFences('コードなし `inline` のみ'), []);
});

test('highlightFences returns null when nothing is highlightable', async () => {
  // No fence at all, and a fence without a resolvable language: both must
  // yield null (the field is then left off the stored comment) without ever
  // importing Shiki.
  assert.equal(await highlightFences('フェンスなしの本文'), null);
  assert.equal(await highlightFences('```\nplain text\n```'), null);
});

test('highlightFences tokenizes fences and nulls the unknown ones', async () => {
  const fences = await highlightFences(
    '説明\n```nosuchlang\nx\n```\n\n```ts\nconst x = 1\n// note\n```'
  );
  assert.ok(fences);
  assert.equal(fences.length, 2);
  assert.equal(fences[0], null);

  const ts = fences[1];
  assert.ok(ts);
  // One token-line per code line, each reassembling that line exactly —
  // the client refuses to render tokens that don't (see fenceHtml).
  assert.deepEqual(
    ts.lines.map((line) => line.map((tok) => tok.t).join('')),
    ['const x = 1', '// note']
  );
  // At least the keyword is colored, and every stored style passes the
  // client-side validator.
  const tokens = ts.lines.flat();
  assert.ok(tokens.some((tok) => tok.s !== undefined));
  for (const tok of tokens) {
    if (tok.s !== undefined) assert.match(tok.s, CLIENT_STYLE_RE);
  }
});
