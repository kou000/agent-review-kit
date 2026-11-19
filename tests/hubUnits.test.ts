import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// review-hub の作業の単位（MR1・MR2…）: 一覧の置き換え時の状態の引き継ぎと、開始ボタンのコメント本文・投稿先。
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
const hubCli = path.join(__dirname, '../hub/bin/review-hub.js');

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

function runHub(stateDir: string, args: string[]) {
  const r = spawnSync(process.execPath, [hubCli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_HUB_STATE_DIR: stateDir },
  });
  return { code: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

test('開始コメントは set-units --plan-tab で保存した計画タブのドキュメント宛（htmlTarget なし）に投稿する', () => {
  const docspaceDir = '/home/u/.review-hub/sessions/UNITS-3/docspace';
  const tabs = [
    { id: 'diff', type: 'ark-diff', projectDir: '/repo' },
    {
      id: 'e2e-plan',
      type: 'ark-doc',
      projectDir: docspaceDir,
      docId: 'e2e-plan',
      approval: { required: true, label: 'E2E 実行を承認' },
    },
    { id: 'plan', type: 'ark-doc', projectDir: '/home/u/plan-docs', docId: 'plan-doc' },
  ];
  assert.deepEqual(server.startCommentTarget({ docspaceDir, tabs, unitsPlanTab: 'plan' }, '【開始】本文'), {
    projectDir: '/home/u/plan-docs',
    payload: { body: '【開始】本文', intent: 'fix', documentId: 'plan-doc' },
  });
});

test('plan-tab が未指定、またはそのタブが削除済みなら、開始コメントは docspace の全体コメントとして投稿する', () => {
  const docspaceDir = '/home/u/.review-hub/sessions/UNITS-4/docspace';
  const planTab = { id: 'plan', type: 'ark-doc', projectDir: docspaceDir, docId: 'plan' };
  const diffTab = { id: 'diff', type: 'ark-diff', projectDir: '/repo', approval: { required: true, label: 'PR 作成を承認' } };
  const docspaceTarget = { projectDir: docspaceDir, payload: { body: '【開始】本文', intent: 'fix' } };
  // 未指定なら id が plan の ark-doc タブがあっても推測しない
  assert.deepEqual(
    server.startCommentTarget({ docspaceDir, tabs: [diffTab, planTab], unitsPlanTab: null }, '【開始】本文'),
    docspaceTarget
  );
  assert.deepEqual(server.startCommentTarget({ docspaceDir, tabs: [diffTab, planTab] }, '【開始】本文'), docspaceTarget);
  assert.deepEqual(server.startCommentTarget({ docspaceDir, tabs: [diffTab], unitsPlanTab: 'plan' }, '【開始】本文'), docspaceTarget);
  assert.equal(server.startCommentTarget({ tabs: [] }, '【開始】本文'), null);
});

test('set-units は --plan-tab を保存し、省略時は前回の値を引き継ぎ、--clear で消す', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-units-'));
  const store = loadStore(stateDir);
  const { session } = store.createSession('UNITS-5', 'テスト', undefined, undefined);
  store.addTab('UNITS-5', { id: 'plan', type: 'ark-doc', projectDir: session.docspaceDir, docId: 'plan' });

  assert.equal(store.setUnits('UNITS-5', [{ key: 'MR1', label: 'a' }], 'plan').planTab, 'plan');
  assert.equal(store.setUnits('UNITS-5', [{ key: 'MR1', label: 'a' }, { key: 'MR2', label: 'b' }]).planTab, 'plan');
  assert.equal(store.loadSession('UNITS-5').unitsPlanTab, 'plan');
  assert.equal(store.unitsPlanTabOf(store.loadSession('UNITS-5')).docId, 'plan');

  // タブを消したら投稿先としては無いものとして扱う
  store.removeTab('UNITS-5', 'plan');
  assert.equal(store.unitsPlanTabOf(store.loadSession('UNITS-5')), null);

  assert.deepEqual(store.setUnits('UNITS-5', [], null), { units: [], planTab: null });
  assert.equal(store.loadSession('UNITS-5').unitsPlanTab, null);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('set-units は --plan-tab が存在しないタブ・ark-doc でないタブならエラーにして何も保存しない', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-units-'));
  const store = loadStore(stateDir);
  store.createSession('UNITS-6', 'テスト', undefined, undefined);
  store.addTab('UNITS-6', { id: 'diff', type: 'ark-diff', projectDir: '/repo' });
  store.setUnits('UNITS-6', [{ key: 'MR1', label: 'a' }]);

  assert.throws(() => store.setUnits('UNITS-6', [{ key: 'MR2', label: 'b' }], 'plan'), /tab not found: plan/);
  assert.throws(() => store.setUnits('UNITS-6', [{ key: 'MR2', label: 'b' }], 'diff'), /plan tab must be an ark-doc tab: diff/);
  const saved = store.loadSession('UNITS-6');
  assert.deepEqual(saved.units.map((u: { key: string }) => u.key), ['MR1']);
  assert.equal(saved.unitsPlanTab, null);

  const r = runHub(stateDir, ['set-units', '--session', 'UNITS-6', '--plan-tab', 'diff', '--unit', 'MR2:b']);
  assert.equal(r.code, 1);
  assert.equal(r.out.status, 'error');
  assert.deepEqual(store.loadSession('UNITS-6').units.map((u: { key: string }) => u.key), ['MR1']);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('set-units を --plan-tab なしで登録すると、出力と stderr に docspace の全体コメントになる旨の警告を出す', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-units-'));
  const store = loadStore(stateDir);
  const { session } = store.createSession('UNITS-7', 'テスト', undefined, undefined);

  const noPlan = runHub(stateDir, ['set-units', '--session', 'UNITS-7', '--unit', 'MR1:a']);
  assert.equal(noPlan.code, 0);
  assert.deepEqual(noPlan.out.units.map((u: { key: string }) => u.key), ['MR1']);
  assert.equal(noPlan.out.planTab, null);
  assert.match(noPlan.out.warning, /docspace の全体コメント/);
  assert.match(noPlan.stderr, /^warning: .*docspace の全体コメント.*\n$/);

  store.addTab('UNITS-7', { id: 'plan', type: 'ark-doc', projectDir: session.docspaceDir, docId: 'plan' });
  const withPlan = runHub(stateDir, ['set-units', '--session', 'UNITS-7', '--plan-tab', 'plan', '--unit', 'MR1:a']);
  assert.equal(withPlan.out.planTab, 'plan');
  assert.equal(withPlan.out.warning, undefined);
  assert.equal(withPlan.stderr, '');

  // 省略しても前回の値を引き継いでいれば警告は出さない
  const inherited = runHub(stateDir, ['set-units', '--session', 'UNITS-7', '--unit', 'MR1:a', '--unit', 'MR2:b']);
  assert.equal(inherited.out.planTab, 'plan');
  assert.equal(inherited.out.warning, undefined);

  const cleared = runHub(stateDir, ['set-units', '--session', 'UNITS-7', '--clear']);
  assert.equal(cleared.out.planTab, null);
  assert.equal(cleared.out.warning, undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
});
