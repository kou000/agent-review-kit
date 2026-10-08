import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  THREAD_FOLD_MIN_MESSAGES,
  messageCount,
  threadFoldLabel,
  threadFoldPlan,
} from '../src/client/threadFold';

function msg(id: string, answered = false) {
  return {
    id,
    body: id,
    agentResponse: answered ? { message: 'ok' } : undefined,
  };
}

test('threshold is 4 messages', () => {
  assert.equal(THREAD_FOLD_MIN_MESSAGES, 4);
});

test('counts an agentResponse as its own message', () => {
  assert.equal(messageCount(msg('a')), 1);
  assert.equal(messageCount(msg('a', true)), 2);
  assert.equal(messageCount({ id: 'a', agentResponse: { message: '' } }), 1);
});

test('short threads are not folded', () => {
  const plan = threadFoldPlan(msg('t'), [msg('r1'), msg('r2')], false);
  assert.equal(plan.totalMessages, 3);
  assert.equal(plan.foldable, false);
  assert.equal(plan.folded, false);
  assert.equal(plan.hiddenMessages, 0);
});

test('a thread with only one reply is never folded (nothing between first and last)', () => {
  const plan = threadFoldPlan(msg('t', true), [msg('r1', true)], false);
  assert.equal(plan.totalMessages, 4);
  assert.equal(plan.foldable, false);
});

test('folds the replies between the first card and the latest reply', () => {
  const replies = [msg('r1', true), msg('r2'), msg('r3', true)];
  const plan = threadFoldPlan(msg('t', true), replies, false);
  assert.equal(plan.totalMessages, 7);
  assert.equal(plan.foldable, true);
  assert.equal(plan.folded, true);
  assert.deepEqual(plan.middle.map((c) => c.id), ['r1', 'r2']);
  assert.equal(plan.hiddenMessages, 3);
  assert.equal(threadFoldLabel(plan), '3 件のやりとりを表示');
});

test('the latest reply stays visible when a new reply arrives', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3')];
  const before = threadFoldPlan(msg('t'), replies, false);
  assert.equal(before.last.id, 'r3');
  const after = threadFoldPlan(msg('t'), replies.concat(msg('r4')), false);
  assert.equal(after.folded, true);
  assert.equal(after.last.id, 'r4');
  assert.deepEqual(after.middle.map((c) => c.id), ['r1', 'r2', 'r3']);
  assert.ok(!after.middle.some((c) => c.id === 'r4'));
});

test('expanded threads show everything and offer to fold again', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3')];
  const plan = threadFoldPlan(msg('t'), replies, true);
  assert.equal(plan.foldable, true);
  assert.equal(plan.folded, false);
  assert.equal(threadFoldLabel(plan), '折りたたむ');
});
