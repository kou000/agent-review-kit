import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { addComment } from '../src/commands/addComment';
import { generate } from '../src/commands/generate';
import { reviewPaths } from '../src/paths';
import { loadComments } from '../src/store';

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-addcomment-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(tmp, 'main.tf'), lines.join('\n') + '\n');
  git(['add', 'main.tf'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
  return tmp;
}

// Capture stdout (addComment prints its JSON result there) without polluting
// the test runner's own output.
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

test('addComment attaches a code snapshot on the new side', async () => {
  const tmp = makeTmpRepo();
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  await generate({ cwd: tmp, quiet: true });

  await captureLog(() =>
    addComment({ cwd: tmp, file: 'main.tf', line: 3, body: 'test' })
  );

  const paths = reviewPaths(tmp);
  const comments = loadComments(paths.comments);
  assert.equal(comments.length, 1);
  const c = comments[0];
  assert.equal(c.side, 'new');
  assert.deepEqual(c.code?.lines, ['line 3']);
  assert.deepEqual(c.code?.before, ['line 1', 'line 2']);
  assert.deepEqual(c.code?.after, ['line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
});

test('addComment attaches a code snapshot on the old side', async () => {
  const tmp = makeTmpRepo();
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  await generate({ cwd: tmp, quiet: true });

  // Modify the working tree so old (HEAD) and new (working tree) content
  // diverge, then comment on the old side.
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  lines[2] = 'changed line 3';
  fs.writeFileSync(path.join(tmp, 'main.tf'), lines.join('\n') + '\n');

  await captureLog(() =>
    addComment({ cwd: tmp, file: 'main.tf', line: 3, side: 'old', body: 'test-old' })
  );

  const paths = reviewPaths(tmp);
  const comments = loadComments(paths.comments);
  assert.equal(comments.length, 1);
  const c = comments[0];
  assert.equal(c.side, 'old');
  assert.deepEqual(c.code?.lines, ['line 3']);
});

test('addComment skips the snapshot silently when the file is unreadable', async () => {
  const tmp = makeTmpRepo();
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  await generate({ cwd: tmp, quiet: true });

  await captureLog(() =>
    addComment({ cwd: tmp, file: 'does-not-exist.tf', line: 1, body: 'test' })
  );

  const paths = reviewPaths(tmp);
  const comments = loadComments(paths.comments);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].code, undefined);
});
