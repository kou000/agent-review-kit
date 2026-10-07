import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TOKENS, tokenize, wordDiff } from '../src/wordDiff';

const texts = (s: string): string[] => tokenize(s).map((t) => t.text);

test('tokenize keeps ASCII word runs and whitespace runs whole', () => {
  assert.deepEqual(texts('foo_bar1  + baz'), ['foo_bar1', '  ', '+', ' ', 'baz']);
  assert.deepEqual(
    tokenize('ab cd').map((t) => [t.start, t.end]),
    [
      [0, 2],
      [2, 3],
      [3, 5],
    ]
  );
});

test('tokenize splits symbols one per token', () => {
  assert.deepEqual(texts('a.b(c)=>d;'), ['a', '.', 'b', '(', 'c', ')', '=', '>', 'd', ';']);
});

test('tokenize splits CJK one character per token', () => {
  assert.deepEqual(texts('データ削除ー'), ['デ', 'ー', 'タ', '削', '除', 'ー']);
  assert.deepEqual(texts('ひらがな（ＡＢ）'), ['ひ', 'ら', 'が', 'な', '（', 'Ａ', 'Ｂ', '）']);
  // Mixed with ASCII words: the run boundary falls at the script change.
  assert.deepEqual(texts('id列'), ['id', '列']);
});

test('tokenize keeps a surrogate pair as one token with UTF-16 offsets', () => {
  assert.deepEqual(
    tokenize('𠮷x').map((t) => [t.text, t.start, t.end]),
    [
      ['𠮷', 0, 2],
      ['x', 2, 3],
    ]
  );
});

test('wordDiff marks a single changed word on both sides', () => {
  assert.deepEqual(wordDiff('foo bar baz', 'foo qux baz'), {
    left: [[4, 7]],
    right: [[4, 7]],
  });
});

test('wordDiff marks the removed part of a Japanese comment', () => {
  assert.deepEqual(wordDiff('// 作成・更新・削除', '// 作成・更新'), {
    left: [[8, 11]],
    right: [],
  });
});

test('wordDiff merges changed words separated by a single whitespace token', () => {
  assert.deepEqual(
    wordDiff('alpha beta gamma delta epsilon', 'alpha one two delta epsilon'),
    {
      left: [[6, 16]],
      right: [[6, 13]],
    }
  );
});

test('wordDiff suppresses lines that mostly changed', () => {
  assert.equal(wordDiff('const a = 1;', 'return foo();'), null);
  // One side over the threshold is enough.
  assert.equal(wordDiff('x', 'x + somethingLonger'), null);
});

test('wordDiff still emphasizes lines changed up to the threshold', () => {
  // 7 of 9 non-whitespace chars changed (78%) is under the 80% threshold.
  assert.notEqual(wordDiff('const a = 1;', 'let b = 2;'), null);
});

test('wordDiff returns null for identical or blank sides', () => {
  assert.equal(wordDiff('same line', 'same line'), null);
  assert.equal(wordDiff('', 'foo'), null);
  assert.equal(wordDiff('foo', '   '), null);
});

test('wordDiff gives up above the token cap', () => {
  // 'x ' * k + tail = 2k + 1 tokens.
  const line = (k: number, tail: string): string => 'x '.repeat(k) + tail;
  assert.ok(2 * 100 + 1 <= MAX_TOKENS);
  assert.deepEqual(wordDiff(line(100, 'a'), line(100, 'b')), {
    left: [[200, 201]],
    right: [[200, 201]],
  });
  assert.ok(2 * 250 + 1 > MAX_TOKENS);
  assert.equal(wordDiff(line(250, 'a'), line(250, 'b')), null);
});
