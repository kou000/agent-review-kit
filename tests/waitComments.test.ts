import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { waitComments } from '../src/commands/waitComments';
import { reviewPaths } from '../src/paths';
import { loadComments, saveComments } from '../src/store';
import { ReviewComment } from '../src/types';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-wait-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), '# tmp repo\n');
  git(['add', 'README.md'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  return tmp;
}

function docComment(id: string, documentId: string): ReviewComment {
  const now = new Date().toISOString();
  return {
    id,
    file: null,
    side: null,
    startLine: null,
    endLine: null,
    startDiffLine: null,
    endDiffLine: null,
    body: `doc comment for ${documentId}`,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    documentId,
    htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1' },
  };
}

function diffComment(id: string): ReviewComment {
  const now = new Date().toISOString();
  return {
    id,
    file: 'a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    startDiffLine: 1,
    endDiffLine: 1,
    body: 'diff comment',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  return fn()
    .then(() => lines)
    .finally(() => {
      console.log = original;
    });
}

test('documentId 指定時はその文書のコメントだけ received で届き status が seen になる', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const c1 = docComment('c1', 'doc-a');
    const c2 = diffComment('c2');
    saveComments(paths.comments, [c1, c2]);

    const lines = await captureLog(() => waitComments({ timeout: 2, documentId: 'doc-a', cwd: tmp }));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].id, 'c1');

    const after = loadComments(paths.comments);
    const after1 = after.find((c) => c.id === 'c1');
    const after2 = after.find((c) => c.id === 'c2');
    assert.equal(after1?.status, 'seen');
    assert.equal(after2?.status, 'open');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('documentId 指定なしの場合は両方のコメントが届く', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const c1 = docComment('c3', 'doc-b');
    const c2 = diffComment('c4');
    saveComments(paths.comments, [c1, c2]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    const ids = result.comments.map((c) => c.id).sort();
    assert.deepEqual(ids, ['c3', 'c4']);

    const after = loadComments(paths.comments);
    assert.ok(after.every((c) => c.status === 'seen'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diffOnly 指定時は diff コメントだけ received で届き、doc コメントは open のまま', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const c1 = docComment('c6', 'doc-c');
    const c2 = diffComment('c7');
    saveComments(paths.comments, [c1, c2]);

    const lines = await captureLog(() => waitComments({ timeout: 2, diffOnly: true, cwd: tmp }));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].id, 'c7');

    const after = loadComments(paths.comments);
    const after1 = after.find((c) => c.id === 'c6');
    const after2 = after.find((c) => c.id === 'c7');
    assert.equal(after1?.status, 'open');
    assert.equal(after2?.status, 'seen');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('該当するコメントがなければ timeout する', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    // A comment exists, but for a different documentId than requested.
    saveComments(paths.comments, [docComment('c5', 'doc-other')]);

    const lines = await captureLog(() =>
      waitComments({ timeout: 1, documentId: 'doc-a', cwd: tmp })
    );
    const result = JSON.parse(lines[0]) as { status: string; comments: unknown[] };
    assert.equal(result.status, 'timeout');
    assert.equal(result.comments.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
