import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PR_PENDING_PREFIX,
  prPendingAvailable,
  prPendingBody,
  prPendingInitialText,
} from '../src/client/prPending';

test('ボタンは設定 ON かつ PR/MR 登録中（https の URL）のときだけ出る', () => {
  const url = 'https://github.com/o/r/pull/1';
  assert.equal(prPendingAvailable(true, url), true);
  assert.equal(prPendingAvailable(false, url), false);
  assert.equal(prPendingAvailable(undefined, url), false);
  assert.equal(prPendingAvailable(true, null), false);
  assert.equal(prPendingAvailable(true, 'javascript:alert(1)'), false);
});

test('AI 指摘は先頭の severity タグを除いた本文が初期値になる', () => {
  for (const tag of ['Critical', 'Warning', 'Info']) {
    assert.equal(
      prPendingInitialText({ author: 'agent', body: `[${tag}] null チェックが無い` }),
      'null チェックが無い'
    );
  }
  // 先頭以外・未知のタグはそのまま。
  assert.equal(
    prPendingInitialText({ author: 'agent', body: '本文 [Critical] 途中' }),
    '本文 [Critical] 途中'
  );
  assert.equal(
    prPendingInitialText({ author: 'agent', body: '[Nit] 細かい' }),
    '[Nit] 細かい'
  );
});

test('ユーザーのコメントは本文をそのまま初期値にする（タグも残す）', () => {
  assert.equal(prPendingInitialText({ body: '[Info] ここは?' }), '[Info] ここは?');
  assert.equal(prPendingInitialText({ author: 'user', body: '複数行\n本文' }), '複数行\n本文');
});

test('本文の無い agent の返信カードは agentResponse を初期値にする', () => {
  assert.equal(
    prPendingInitialText({ author: 'agent', body: '', agentResponse: { message: '回答です' } }),
    '回答です'
  );
});

test('以前の依頼コメントからは接頭辞の行を除く', () => {
  assert.equal(prPendingInitialText({ body: prPendingBody('PR に書く文面') }), 'PR に書く文面');
});

test('依頼本文は接頭辞の次の行から文面が続く', () => {
  assert.equal(prPendingBody('文面'), PR_PENDING_PREFIX + '\n文面');
  assert.equal(PR_PENDING_PREFIX, '【PR Pending コメント依頼】');
});
