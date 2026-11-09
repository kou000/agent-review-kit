import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseLabel } from '../src/client/baseLabel';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('base が無い（未コミット差分だけ）ときは null', () => {
  assert.equal(baseLabel({ base: null }), null);
});

test('ハッシュで渡された base はブランチ名で出し、ハッシュはツールチップに回す', () => {
  const label = baseLabel({ base: SHA, baseName: 'origin/main', baseSha: SHA });
  assert.equal(label?.text, 'origin/main');
  assert.match(label!.title, new RegExp(SHA));
});

test('ref 名で渡された base はその名前で出し、解決済みのコミットをツールチップに添える', () => {
  const label = baseLabel({ base: 'origin/main', baseName: 'origin/main', baseSha: SHA });
  assert.equal(label?.text, 'origin/main');
  assert.match(label!.title, /--base）: origin\/main/);
  assert.match(label!.title, new RegExp('コミット: ' + SHA));
});

test('baseName の無い古いデータでもハッシュは短縮し、ref 名はそのまま出す', () => {
  assert.equal(baseLabel({ base: SHA })?.text, SHA.slice(0, 7));
  assert.equal(baseLabel({ base: 'main' })?.text, 'main');
  assert.equal(baseLabel({ base: 'abc1234^' })?.text, 'abc1234^');
});
