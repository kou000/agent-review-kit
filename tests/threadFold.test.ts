import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  THREAD_FOLD_MIN_MESSAGES,
  THREAD_FOLD_TAIL,
  messageCount,
  threadFoldActions,
  threadFoldPlan,
} from '../src/client/threadFold';

function msg(id: string, answered = false) {
  return {
    id,
    body: id,
    agentResponse: answered ? { message: 'ok' } : undefined,
  };
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);

test('threshold is 4 messages and the last 2 replies always stay visible', () => {
  assert.equal(THREAD_FOLD_MIN_MESSAGES, 4);
  assert.equal(THREAD_FOLD_TAIL, 2);
});

test('counts an agentResponse as its own message', () => {
  assert.equal(messageCount(msg('a')), 1);
  assert.equal(messageCount(msg('a', true)), 2);
  assert.equal(messageCount({ id: 'a', agentResponse: { message: '' } }), 1);
});

test('short threads are not folded', () => {
  const plan = threadFoldPlan(msg('t'), [msg('r1'), msg('r2')], null);
  assert.equal(plan.totalMessages, 3);
  assert.equal(plan.foldable, false);
  assert.equal(plan.folded, false);
  assert.equal(plan.hiddenMessages, 0);
  assert.deepEqual(threadFoldActions(plan), []);
});

test('a thread with two replies is never folded (both are the visible tail)', () => {
  const plan = threadFoldPlan(msg('t', true), [msg('r1', true), msg('r2', true)], null);
  assert.equal(plan.totalMessages, 6);
  assert.equal(plan.foldable, false);
  assert.deepEqual(ids(plan.tail), ['r1', 'r2']);
});

test('folds the replies before the latest two, keeping the one before the latest visible', () => {
  const replies = [msg('r1', true), msg('r2'), msg('r3'), msg('r4', true)];
  const plan = threadFoldPlan(msg('t', true), replies, null);
  assert.equal(plan.totalMessages, 8);
  assert.equal(plan.folded, true);
  assert.deepEqual(ids(plan.middle), ['r1', 'r2']);
  assert.deepEqual(ids(plan.hidden), ['r1', 'r2']);
  assert.deepEqual(ids(plan.tail), ['r3', 'r4']);
  assert.equal(plan.hiddenMessages, 3);
  assert.deepEqual(
    threadFoldActions(plan).map((a) => [a.label, a.open]),
    [
      ['1 つ前のやりとりを表示', 'r2'],
      ['3 件のやりとりをすべて表示', 'r1'],
    ],
  );
});

test('reveals folded replies one at a time, newest first', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3'), msg('r4'), msg('r5')];
  const plan = threadFoldPlan(msg('t'), replies, 'r3');
  assert.equal(plan.folded, true);
  assert.equal(plan.revealed, true);
  assert.deepEqual(ids(plan.hidden), ['r1', 'r2']);
  assert.deepEqual(
    threadFoldActions(plan).map((a) => [a.label, a.open]),
    [
      ['1 つ前のやりとりを表示', 'r2'],
      ['2 件のやりとりをすべて表示', 'r1'],
      ['折りたたむ', null],
    ],
  );
});

test('with one reply left folded, only the one-step button is offered', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3'), msg('r4'), msg('r5')];
  const plan = threadFoldPlan(msg('t'), replies, 'r2');
  assert.deepEqual(ids(plan.hidden), ['r1']);
  assert.deepEqual(
    threadFoldActions(plan).map((a) => a.label),
    ['1 つ前のやりとりを表示', '折りたたむ'],
  );
});

test('the revealed range stays put when a new reply arrives', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3'), msg('r4')];
  const before = threadFoldPlan(msg('t'), replies, 'r2');
  assert.deepEqual(ids(before.hidden), ['r1']);
  const after = threadFoldPlan(msg('t'), replies.concat(msg('r5')), 'r2');
  assert.deepEqual(ids(after.hidden), ['r1']);
  assert.deepEqual(ids(after.tail), ['r4', 'r5']);
});

test('the latest replies stay visible when a new reply arrives to a folded thread', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3')];
  const after = threadFoldPlan(msg('t'), replies.concat(msg('r4')), null);
  assert.equal(after.folded, true);
  assert.deepEqual(ids(after.hidden), ['r1', 'r2']);
  assert.deepEqual(ids(after.tail), ['r3', 'r4']);
});

test('fully expanded threads show everything and offer to fold again', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3'), msg('r4')];
  const plan = threadFoldPlan(msg('t'), replies, 'r1');
  assert.equal(plan.foldable, true);
  assert.equal(plan.folded, false);
  assert.deepEqual(plan.hidden, []);
  assert.deepEqual(
    threadFoldActions(plan).map((a) => [a.label, a.open]),
    [['折りたたむ', null]],
  );
});

test('an unknown revealed id (e.g. a deleted reply) falls back to fully folded', () => {
  const replies = [msg('r1'), msg('r2'), msg('r3'), msg('r4')];
  const plan = threadFoldPlan(msg('t'), replies, 'gone');
  assert.deepEqual(ids(plan.hidden), ['r1', 'r2']);
  assert.equal(plan.revealed, false);
});
