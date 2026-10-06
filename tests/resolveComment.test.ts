import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveComment } from '../src/commands/resolveComment';
import { waitComments } from '../src/commands/waitComments';
import { reviewPaths } from '../src/paths';
import { buildStatus } from '../src/server';
import { loadComments, saveComments } from '../src/store';
import { ReviewComment } from '../src/types';

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-resolve-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), '# tmp repo\n');
  git(['add', 'README.md'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  return tmp;
}

// A top-level diff comment with a code snapshot, and a user reply to it whose
// anchor was copied from the top-level comment (as POST /api/comments does).
function seed(tmp: string): { top: ReviewComment; reply: ReviewComment } {
  const now = new Date().toISOString();
  const top: ReviewComment = {
    id: 'top',
    file: 'a.ts',
    side: 'new',
    startLine: 3,
    endLine: 4,
    startDiffLine: 10,
    endDiffLine: 11,
    body: 'ここは null チェックが必要では？',
    status: 'open',
    createdAt: now,
    updatedAt: now,
    code: { before: ['x'], lines: ['y', 'z'], after: [] },
  };
  const reply: ReviewComment = {
    id: 'reply',
    file: 'a.ts',
    side: 'new',
    startLine: 3,
    endLine: 4,
    startDiffLine: 10,
    endDiffLine: 11,
    body: '追加の質問',
    status: 'open',
    createdAt: now,
    updatedAt: now,
    parentId: 'top',
  };
  saveComments(reviewPaths(tmp).comments, [top, reply]);
  return { top, reply };
}

// Capture stdout (resolveComment prints its JSON result there).
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let out = '';
  console.log = (s: string) => {
    out += s;
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out;
}

test('初回の --message は対象コメントの agentResponse に保存され、返信は追加されない', async () => {
  const tmp = makeTmpRepo();
  try {
    seed(tmp);
    const out = await captureLog(() =>
      resolveComment({ id: 'top', status: 'answered', message: '最初の回答', cwd: tmp })
    );
    const result = JSON.parse(out) as { status: string; reply?: unknown };
    assert.equal(result.status, 'updated');
    assert.equal(result.reply, undefined);

    const comments = loadComments(reviewPaths(tmp).comments);
    assert.equal(comments.length, 2);
    const top = comments.find((c) => c.id === 'top');
    assert.equal(top?.status, 'answered');
    assert.equal(top?.agentResponse?.message, '最初の回答');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('2 回目の --message は前の agentResponse を残し、スレッドに agent の返信を追加する', async () => {
  const tmp = makeTmpRepo();
  try {
    seed(tmp);
    await captureLog(() =>
      resolveComment({ id: 'top', status: 'answered', message: '最初の回答', cwd: tmp })
    );
    const first = loadComments(reviewPaths(tmp).comments).find((c) => c.id === 'top')
      ?.agentResponse;

    const out = await captureLog(() =>
      resolveComment({ id: 'top', status: 'fixed', message: '訂正: 直しました', cwd: tmp })
    );
    const result = JSON.parse(out) as { comment: ReviewComment; reply: ReviewComment };

    const comments = loadComments(reviewPaths(tmp).comments);
    assert.equal(comments.length, 3);
    const top = comments.find((c) => c.id === 'top');
    assert.deepEqual(top?.agentResponse, first);
    assert.equal(top?.status, 'fixed');

    const added = comments.find((c) => c.id === result.reply.id);
    assert.ok(added);
    assert.equal(added.author, 'agent');
    assert.equal(added.parentId, 'top');
    assert.equal(added.body, '');
    assert.equal(added.status, 'fixed');
    assert.equal(added.agentResponse?.message, '訂正: 直しました');
    assert.equal(added.file, 'a.ts');
    assert.equal(added.side, 'new');
    assert.equal(added.startLine, 3);
    assert.equal(added.endLine, 4);
    assert.equal(added.startDiffLine, 10);
    assert.equal(added.endDiffLine, 11);
    assert.deepEqual(added.code, { before: ['x'], lines: ['y', 'z'], after: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('回答済みの返信への 2 回目の --message は大元のスレッドに返信を追加する', async () => {
  const tmp = makeTmpRepo();
  try {
    seed(tmp);
    // The user reply has no agentResponse yet: the first message lands on it.
    await captureLog(() =>
      resolveComment({ id: 'reply', status: 'answered', message: '返信への回答', cwd: tmp })
    );
    let comments = loadComments(reviewPaths(tmp).comments);
    assert.equal(comments.length, 2);
    assert.equal(comments.find((c) => c.id === 'reply')?.agentResponse?.message, '返信への回答');

    const out = await captureLog(() =>
      resolveComment({ id: 'reply', status: 'answered', message: '補足', cwd: tmp })
    );
    const result = JSON.parse(out) as { reply: ReviewComment };
    comments = loadComments(reviewPaths(tmp).comments);
    assert.equal(comments.length, 3);
    assert.equal(comments.find((c) => c.id === 'reply')?.agentResponse?.message, '返信への回答');
    const added = comments.find((c) => c.id === result.reply.id);
    assert.equal(added?.parentId, 'top');
    assert.equal(added?.author, 'agent');
    assert.equal(added?.agentResponse?.message, '補足');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--message なしの状態更新は返信を追加せず agentResponse も変えない', async () => {
  const tmp = makeTmpRepo();
  try {
    seed(tmp);
    await captureLog(() =>
      resolveComment({ id: 'top', status: 'answered', message: '最初の回答', cwd: tmp })
    );
    const out = await captureLog(() => resolveComment({ id: 'top', status: 'resolved', cwd: tmp }));
    assert.equal((JSON.parse(out) as { reply?: unknown }).reply, undefined);

    const comments = loadComments(reviewPaths(tmp).comments);
    assert.equal(comments.length, 2);
    const top = comments.find((c) => c.id === 'top');
    assert.equal(top?.status, 'resolved');
    assert.equal(top?.agentResponse?.message, '最初の回答');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('追加された agent の返信は wait-comments で配達されない', async () => {
  const tmp = makeTmpRepo();
  try {
    seed(tmp);
    // Answer both user comments, then send a second message to the top-level
    // one: the only open comment left is the appended agent reply's thread.
    await captureLog(() =>
      resolveComment({ id: 'reply', status: 'answered', message: '返信への回答', cwd: tmp })
    );
    await captureLog(() =>
      resolveComment({ id: 'top', status: 'answered', message: '最初の回答', cwd: tmp })
    );
    const out = await captureLog(() =>
      resolveComment({ id: 'top', status: 'answered', message: '訂正', cwd: tmp })
    );
    assert.ok((JSON.parse(out) as { reply?: ReviewComment }).reply);

    const waited = await captureLog(() => waitComments({ timeout: 1, cwd: tmp }));
    const result = JSON.parse(waited) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'timeout');
    assert.equal(result.comments.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--status open/seen で追加した agent の返信は answered になり未解決に数えない', async () => {
  const tmp = makeTmpRepo();
  try {
    seed(tmp);
    await captureLog(() =>
      resolveComment({ id: 'top', status: 'answered', message: '最初の回答', cwd: tmp })
    );
    const out = await captureLog(() =>
      resolveComment({ id: 'top', status: 'open', message: '訂正', cwd: tmp })
    );
    const { comment, reply } = JSON.parse(out) as { comment: ReviewComment; reply: ReviewComment };
    assert.equal(comment.status, 'open');
    assert.equal(reply.status, 'answered');
    // Only the reopened top-level comment is open (the seeded user reply was
    // settled by the first answered call's cascade).
    assert.equal(buildStatus(reviewPaths(tmp)).unresolved, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
