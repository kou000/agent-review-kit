import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { parseUnifiedDiff, runGitDiff } from '../src/gitDiff';
import { FileDiff } from '../src/types';

let tmp: string;
let base: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function byPath(files: FileDiff[]): Map<string, FileDiff> {
  return new Map(files.map((f) => [f.path, f]));
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-gitdiff-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'tracked.txt'), 'line1\nline2\n');
  fs.writeFileSync(path.join(tmp, '.gitignore'), '*.log\nignored_dir/\n');
  git(['add', 'tracked.txt', '.gitignore'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
  base = git(['rev-parse', 'HEAD'], tmp).trim();

  // tracked modification
  fs.writeFileSync(path.join(tmp, 'tracked.txt'), 'line1\nCHANGED\nline2\n');
  // untracked file inside a brand-new directory
  fs.mkdirSync(path.join(tmp, 'newdir', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'newdir', 'sub', 'newfile.rs'), 'fn main() {}\n');
  // untracked file at repo root
  fs.writeFileSync(path.join(tmp, 'root_untracked.txt'), 'hello\nworld\n');
  // ignored files (must NOT appear)
  fs.writeFileSync(path.join(tmp, 'debug.log'), 'secret\n');
  fs.mkdirSync(path.join(tmp, 'ignored_dir'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'ignored_dir', 'f.txt'), 'x\n');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('working-tree diff (no base) includes untracked files as added, tracked as modified, ignored excluded', () => {
  const files = parseUnifiedDiff(runGitDiff(undefined, tmp));
  const m = byPath(files);

  assert.equal(m.get('tracked.txt')?.status, 'modified');
  assert.equal(m.get('newdir/sub/newfile.rs')?.status, 'added');
  assert.equal(m.get('root_untracked.txt')?.status, 'added');

  // .gitignore is honored: ignored files never enter the diff.
  assert.equal(m.has('debug.log'), false);
  assert.equal(m.has('ignored_dir/f.txt'), false);

  // The added file's body is present so the review shows the real content.
  const added = m.get('newdir/sub/newfile.rs')!;
  const body = added.hunks.flatMap((h) => h.rows.map((r) => r.right?.text ?? '')).join('\n');
  assert.match(body, /fn main\(\) \{\}/);
});

test('--base diff also includes untracked files as added and excludes ignored', () => {
  const files = parseUnifiedDiff(runGitDiff(base, tmp));
  const m = byPath(files);

  assert.equal(m.get('tracked.txt')?.status, 'modified');
  assert.equal(m.get('newdir/sub/newfile.rs')?.status, 'added');
  assert.equal(m.get('root_untracked.txt')?.status, 'added');
  assert.equal(m.has('debug.log'), false);
  assert.equal(m.has('ignored_dir/f.txt'), false);
});

test('untracked binary files are marked binary, matching tracked binary handling', () => {
  fs.writeFileSync(path.join(tmp, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0]));
  const files = parseUnifiedDiff(runGitDiff(undefined, tmp));
  const m = byPath(files);
  assert.equal(m.get('blob.bin')?.status, 'binary');
  fs.rmSync(path.join(tmp, 'blob.bin'));
});
