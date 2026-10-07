import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff } from '../src/gitDiff';
import {
  bakeHighlight,
  extractCommentFences,
  highlightFences,
  langForFenceInfo,
  overlayRanges,
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

// Every <span ...> must be closed in order, i.e. the overlay never interleaves
// its wrapper with Shiki's token spans.
function assertBalanced(html: string): void {
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)span\b[^>]*>/g)) {
    depth += m[1] ? -1 : 1;
    assert.ok(depth >= 0, `unbalanced close in ${html}`);
  }
  assert.equal(depth, 0, `unclosed span in ${html}`);
}

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, '');

test('overlayRanges splits the wrapper at token span boundaries', () => {
  const html = '<span style="color:#F00">foo</span> <span style="color:#0F0">bar</span>';
  // [2, 5) = the last "o", the space, and "b".
  const out = overlayRanges(html, [[2, 5]], 'word-add');
  assert.equal(
    out,
    '<span style="color:#F00">fo<span class="word-add">o</span></span>' +
      '<span class="word-add"> </span>' +
      '<span style="color:#0F0"><span class="word-add">b</span>ar</span>'
  );
  assertBalanced(out);
  assert.equal(stripTags(out), stripTags(html));
});

test('overlayRanges counts an entity as one source character', () => {
  // Source text: "a <= b && c"; [7, 9) is "&&".
  assert.equal(
    overlayRanges('a &lt;= b &amp;&amp; c', [[7, 9]], 'word-del'),
    'a &lt;= b <span class="word-del">&amp;&amp;</span> c'
  );
  // A numeric reference outside the BMP stands for two UTF-16 units.
  assert.equal(
    overlayRanges('&#x1F600;xy', [[2, 3]], 'word-add'),
    '&#x1F600;<span class="word-add">x</span>y'
  );
  assert.equal(overlayRanges('a &lt; b', [], 'word-add'), 'a &lt; b');
});

test('bakeHighlight overlays word spans on Shiki markup and on plain text', async () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,1 @@',
    '-if (left < right && foo) return bar;',
    '+if (left <= right && qux) return bar;',
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1,1 +1,1 @@',
    '-if (a < b) keep',
    '+if (a <= b) keep',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  await bakeHighlight(files, { oldByPath: new Map() });

  // .ts: Shiki colors survive, the changed words are wrapped, tags balance.
  const ts = files[0].hunks[0].rows[0];
  assert.ok(ts.left?.html && ts.right?.html);
  for (const html of [ts.left.html, ts.right.html]) {
    assertBalanced(html);
    assert.match(html, /color:#[0-9a-fA-F]{6}/);
  }
  assert.match(ts.left.html, /<span class="word-del">foo<\/span>/);
  assert.match(ts.right.html, /<span class="word-add">=<\/span>/);
  assert.match(ts.right.html, /<span class="word-add">qux<\/span>/);
  assert.equal(
    stripTags(ts.right.html).replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
    'if (left <= right && qux) return bar;'
  );

  // .txt: no Shiki, so the wrapped html is built from escaped text; the old
  // side has nothing to emphasize and keeps no html at all.
  const txt = files[1].hunks[0].rows[0];
  assert.equal(txt.left?.html, undefined);
  assert.equal(txt.right?.html, 'if (a &lt;<span class="word-add">=</span> b) keep');
});
