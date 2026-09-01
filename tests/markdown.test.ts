import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, stripMarkdown } from '../src/client/markdown';

test('renders paragraphs with single newlines as line breaks', () => {
  assert.equal(renderMarkdown('一行目\n二行目'), '<p>一行目<br>二行目</p>');
  assert.equal(renderMarkdown('段落1\n\n段落2'), '<p>段落1</p><p>段落2</p>');
});

test('renders headings, emphasis and inline code', () => {
  assert.equal(renderMarkdown('## 見出し'), '<h2>見出し</h2>');
  assert.equal(renderMarkdown('**太字** と *斜体* と ~~打消~~'),
    '<p><strong>太字</strong> と <em>斜体</em> と <del>打消</del></p>');
  assert.equal(renderMarkdown('`foo()` を呼ぶ'), '<p><code>foo()</code> を呼ぶ</p>');
});

test('leaves snake_case identifiers alone', () => {
  assert.equal(renderMarkdown('user_id と order_id'), '<p>user_id と order_id</p>');
});

test('does not apply markdown inside code spans or fences', () => {
  assert.equal(renderMarkdown('`**not bold**`'), '<p><code>**not bold**</code></p>');
  assert.equal(renderMarkdown('```\n- not a list\n**not bold**\n```'),
    '<pre><code>- not a list\n**not bold**</code></pre>');
});

test('renders nested lists', () => {
  assert.equal(renderMarkdown('- a\n  - b\n    - c\n- d'),
    '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
});

test('renders an ordered list nested in a bulleted one', () => {
  assert.equal(renderMarkdown('- a\n  1. one\n  2. two\n- b'),
    '<ul><li>a<ol><li>one</li><li>two</li></ol></li><li>b</li></ul>');
});

test('switching marker at the same depth starts a new list', () => {
  assert.equal(renderMarkdown('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
});

test('a plain line under a list item continues that item', () => {
  assert.equal(renderMarkdown('- a\n  つづき\n- b'),
    '<ul><li>a<br>つづき</li><li>b</li></ul>');
});

test('renders task list items', () => {
  assert.equal(renderMarkdown('- [ ] todo\n- [x] done'),
    '<ul><li class="task-item"><input type="checkbox" disabled> todo</li>' +
    '<li class="task-item"><input type="checkbox" disabled checked> done</li></ul>');
});

test('renders blockquotes and horizontal rules', () => {
  assert.equal(renderMarkdown('> 引用1\n> 引用2'), '<blockquote>引用1<br>引用2</blockquote>');
  assert.equal(renderMarkdown('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('renders links and bare urls, and drops unsafe schemes', () => {
  assert.equal(renderMarkdown('[ここ](https://example.com/x)'),
    '<p><a href="https://example.com/x" target="_blank" rel="noopener">ここ</a></p>');
  assert.equal(renderMarkdown('見て https://example.com/x'),
    '<p>見て <a href="https://example.com/x" target="_blank" rel="noopener">https://example.com/x</a></p>');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
});

test('escapes html in every context', () => {
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'),
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(renderMarkdown('`<script>`'), '<p><code>&lt;script&gt;</code></p>');
  assert.equal(renderMarkdown('```\n<script>\n```'), '<pre><code>&lt;script&gt;</code></pre>');
  assert.equal(renderMarkdown('# <b>x</b>'), '<h1>&lt;b&gt;x&lt;/b&gt;</h1>');
});

test('strips placeholder tokens injected through the source text', () => {
  // A body that carries a NUL-delimited token must not be able to reach into
  // the placeholder store and inject markup lifted from elsewhere.
  assert.equal(renderMarkdown('\u0000C0\u0000 `real`'), '<p>C0 <code>real</code></p>');
});

test('liftInline output survives markdown parsing verbatim', () => {
  const html = renderMarkdown('前 [画像: img_a.png] 後\n\n```\n[画像: img_a.png]\n```',
    (line, hold) => line.replace(/\[画像: ([^\]]+)\]/g, () => hold('<img src="x">')));
  assert.equal(html, '<p>前 <img src="x"> 後</p><pre><code>[画像: img_a.png]</code></pre>');
});

test('renders server-highlighted fence tokens as styled spans', () => {
  const fences = [{
    lines: [
      [{ t: 'const', s: 'color:#ff7b72' }, { t: ' x = ' }, { t: '1', s: 'color:#79c0ff' }],
      [{ t: '// note', s: 'color:#8b949e;font-style:italic' }],
    ],
  }];
  assert.equal(renderMarkdown('```ts\nconst x = 1\n// note\n```', undefined, fences),
    '<pre><code><span style="color:#ff7b72">const</span> x = ' +
    '<span style="color:#79c0ff">1</span>\n' +
    '<span style="color:#8b949e;font-style:italic">// note</span></code></pre>');
});

test('escapes fence token text and pairs fences with entries by index', () => {
  const fences = [
    null,
    { lines: [[{ t: '<b>', s: 'color:#abc' }]] },
  ];
  assert.equal(renderMarkdown('```\nplain\n```\n\n```html\n<b>\n```', undefined, fences),
    '<pre><code>plain</code></pre>' +
    '<pre><code><span style="color:#abc">&lt;b&gt;</span></code></pre>');
});

test('drops a fence token style that is not the allowed shape', () => {
  const fences = [{
    lines: [[{ t: 'x', s: 'color:red;background:url(https://evil.example/)' }]],
  }];
  assert.equal(renderMarkdown('```ts\nx\n```', undefined, fences),
    '<pre><code>x</code></pre>');
});

test('falls back to plain text when fence tokens do not match the fence', () => {
  // Token text that does not reassemble the fence's own lines (a stale or
  // hand-edited fences field) must never be displayed as the code.
  const fences = [{ lines: [[{ t: 'forged', s: 'color:#fff' }]] }];
  assert.equal(renderMarkdown('```ts\nreal\n```', undefined, fences),
    '<pre><code>real</code></pre>');
});

test('renders fences plainly when the fences argument is absent', () => {
  assert.equal(renderMarkdown('```ts\nconst x = 1\n```'),
    '<pre><code>const x = 1</code></pre>');
});

test('renders a GFM table', () => {
  assert.equal(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>');
});

test('table alignment becomes classes, not inline styles', () => {
  assert.equal(renderMarkdown('| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |'),
    '<table><thead><tr>' +
    '<th>l</th><th class="md-center">c</th><th class="md-right">r</th>' +
    '</tr></thead><tbody><tr>' +
    '<td>1</td><td class="md-center">2</td><td class="md-right">3</td>' +
    '</tr></tbody></table>');
});

test('table cells render inline markdown', () => {
  assert.equal(renderMarkdown('| code | 強調 |\n| --- | --- |\n| `x` | **太** |'),
    '<table><thead><tr><th>code</th><th>強調</th></tr></thead>' +
    '<tbody><tr><td><code>x</code></td><td><strong>太</strong></td></tr></tbody></table>');
});

test('an escaped pipe stays inside its cell', () => {
  assert.equal(renderMarkdown('| a |\n| --- |\n| x \\| y |'),
    '<table><thead><tr><th>a</th></tr></thead>' +
    '<tbody><tr><td>x | y</td></tr></tbody></table>');
});

test('pads short rows and truncates long ones to the header width', () => {
  assert.equal(renderMarkdown('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |'),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
    '<tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
});

test('a pipe line without a delimiter row stays a paragraph', () => {
  assert.equal(renderMarkdown('| a | b |\nただの文'), '<p>| a | b |<br>ただの文</p>');
  assert.equal(renderMarkdown('a | b'), '<p>a | b</p>');
});

test('a table ends at a blank line or a line without a pipe', () => {
  assert.equal(renderMarkdown('| a |\n| --- |\n| 1 |\n\n後段'),
    '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>' +
    '<p>後段</p>');
  assert.equal(renderMarkdown('| a |\n| --- |\n地の文'),
    '<table><thead><tr><th>a</th></tr></thead><tbody></tbody></table><p>地の文</p>');
});

test('escapes html inside table cells', () => {
  assert.equal(renderMarkdown('| x |\n| --- |\n| <b>y</b> |'),
    '<table><thead><tr><th>x</th></tr></thead>' +
    '<tbody><tr><td>&lt;b&gt;y&lt;/b&gt;</td></tr></tbody></table>');
});

test('stripMarkdown flattens tables', () => {
  assert.equal(
    stripMarkdown('| a | b |\n| --- | --- |\n| **1** | 2 |').replace(/\s+/g, ' ').trim(),
    'a b 1 2');
});

test('stripMarkdown reduces syntax to plain text', () => {
  assert.equal(stripMarkdown('## 見出し'), '見出し');
  assert.equal(stripMarkdown('- **太字** の `code`'), '太字 の code');
  assert.equal(stripMarkdown('[ラベル](https://example.com)'), 'ラベル');
  assert.equal(stripMarkdown('user_id は残る'), 'user_id は残る');
});
