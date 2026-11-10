import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// review-hub の作業の単位（MR1・MR2…）: 一覧の置き換え時の状態の引き継ぎと、開始ボタンのコメント本文。
// session.js は読み込み時に状態フォルダ（REVIEW_HUB_STATE_DIR）を決めるので、
// 本物の ~/.review-hub を触らないよう環境変数を設定してから読み込む。

const requireHub = createRequire(__filename);

function loadStore(stateDir: string) {
  process.env.REVIEW_HUB_STATE_DIR = stateDir;
  const modPath = requireHub.resolve('../hub/lib/session.js');
  delete requireHub.cache[modPath];
  return requireHub(modPath);
}

const server = requireHub('../hub/lib/server.js');

test('set-units は同じ key の state・mr・startedAt を引き継ぎ、新しい key は pending で足す', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-units-'));
  const store = loadStore(stateDir);
  store.createSession('UNITS-1', 'テスト', undefined, undefined);
  store.setUnits('UNITS-1', [
    { key: 'MR1', label: 'ロールの作成' },
    { key: 'MR2', label: 'バッチの切り替え' },
  ]);
  store.setUnitState('UNITS-1', 'MR1', { state: 'mr-created', mr: '!441' });
  store.setUnitState('UNITS-1', 'MR2', { state: 'started' });
  const started = store.loadSession('UNITS-1').units.find((u: { key: string }) => u.key === 'MR2');

  const { units } = store.setUnits('UNITS-1', [
    { key: 'MR1', label: 'ロールの作成（説明を直した）' },
    { key: 'MR2', label: 'バッチの切り替え' },
    { key: 'MR3', label: 'ECS と RDS Proxy' },
  ]);

  assert.deepEqual(
    units.map((u: { key: string; label: string; state: string; mr: string | null }) => [u.key, u.label, u.state, u.mr]),
    [
      ['MR1', 'ロールの作成（説明を直した）', 'mr-created', '!441'],
      ['MR2', 'バッチの切り替え', 'started', null],
      ['MR3', 'ECS と RDS Proxy', 'pending', null],
    ]
  );
  assert.equal(units[1].startedAt, started.startedAt);
  assert.equal(units[2].startedAt, null);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('set-units は外した key を消し、key の重複・不正な key・空の説明を拒む', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-units-'));
  const store = loadStore(stateDir);
  const now = '2026-11-10T00:00:00.000Z';
  const prev = [{ key: 'MR1', label: 'a', state: 'done', mr: '!1', updatedAt: now, startedAt: now }];
  assert.deepEqual(store.mergeUnits(prev, [{ key: 'MR2', label: 'b' }], now), [
    { key: 'MR2', label: 'b', state: 'pending', mr: null, updatedAt: now, startedAt: null },
  ]);
  assert.throws(() => store.mergeUnits([], [{ key: 'MR1', label: 'a' }, { key: 'MR1', label: 'b' }], now), /duplicate/);
  assert.throws(() => store.mergeUnits([], [{ key: 'MR 1', label: 'a' }], now), /invalid unit key/);
  assert.throws(() => store.mergeUnits([], [{ key: 'MR1', label: ' ' }], now), /label is required/);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('set-unit は state を検査し、pending に戻すと startedAt を消す', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-units-'));
  const store = loadStore(stateDir);
  store.createSession('UNITS-2', 'テスト', undefined, undefined);
  store.setUnits('UNITS-2', [{ key: 'MR1', label: 'a' }]);
  assert.throws(() => store.setUnitState('UNITS-2', 'MR1', { state: 'merged' }), /invalid unit state/);
  assert.throws(() => store.setUnitState('UNITS-2', 'MR9', { state: 'done' }), /unit not found/);
  const { unit: started } = store.setUnitState('UNITS-2', 'MR1', { state: 'started' });
  assert.ok(started.startedAt);
  const { unit: created } = store.setUnitState('UNITS-2', 'MR1', { state: 'mr-created', mr: '!444' });
  assert.equal(created.startedAt, started.startedAt);
  assert.equal(created.mr, '!444');
  const { unit: reset } = store.setUnitState('UNITS-2', 'MR1', { state: 'pending' });
  assert.equal(reset.startedAt, null);
  assert.equal(reset.mr, '!444'); // --mr を渡さなければ据え置き
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('開始コメントの本文は【開始】で始まり、実行中のスキルの SKILL.md の読み直しを指示する', () => {
  const body = server.startUnitBody(
    { key: 'MR2', label: 'バッチの切り替え' },
    { name: 'my-feature-ct', path: '/home/u/.claude/skills/my-feature-ct/SKILL.md' }
  );
  assert.equal(
    body,
    '【開始】「バッチの切り替え」（MR2）の作業を始めてください\n\n' +
      '作業を始める前に、実行中のスキル my-feature-ct の SKILL.md（/home/u/.claude/skills/my-feature-ct/SKILL.md）を Read で全体を読み直し、' +
      'これから進める Step の手順をこのスレッドに書き出してから、Step 5（ブランチ作成）から順に進めること。' +
      '差分タブを追加したら、AI レビューの前にすぐ hub の URL を案内すること。'
  );
});

test('スキルが設定されていなければ、スキル名なしで SKILL.md の読み直しを指示する', () => {
  const body = server.startUnitBody({ key: 'MR2', label: 'バッチの切り替え' }, null);
  assert.ok(body.startsWith('【開始】「バッチの切り替え」（MR2）の作業を始めてください\n\n'));
  assert.ok(body.includes('作業を始める前に、実行中のフローのスキルの SKILL.md を Read で全体を読み直し、'));
  assert.ok(!body.includes('null') && !body.includes('undefined'));
});
