import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { parseUnifiedDiff, runGitDiff, runGitLsFiles, runGitUncommitted, UncommittedFile } from '../src/gitDiff';
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

test('runGitLsFiles lists tracked + untracked files, ignored excluded (diff と同じ境界)', () => {
  const files = runGitLsFiles(tmp);

  // tracked
  assert.ok(files.includes('tracked.txt'));
  assert.ok(files.includes('.gitignore'));
  // untracked (not ignored): 差分に出る新規ファイルはツリーにも出る
  assert.ok(files.includes('root_untracked.txt'));
  assert.ok(files.includes('newdir/sub/newfile.rs'));
  // ignored: .env 等の秘密ファイルは従来どおり出ない
  assert.equal(files.includes('debug.log'), false);
  assert.equal(files.includes('ignored_dir/f.txt'), false);
});

test('untracked binary files are marked binary, matching tracked binary handling', () => {
  fs.writeFileSync(path.join(tmp, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0]));
  const files = parseUnifiedDiff(runGitDiff(undefined, tmp));
  const m = byPath(files);
  assert.equal(m.get('blob.bin')?.status, 'binary');
  fs.rmSync(path.join(tmp, 'blob.bin'));
});

// 空白の変更だけのファイル・本物の変更を含むファイル・未追跡ファイルを持つ
// 使い捨てリポジトリ（「空白の変更を無視」の差分用）。
function makeWhitespaceRepo(): { dir: string; base: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-gitdiff-ws-'));
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  fs.writeFileSync(path.join(dir, 'ws_only.py'), 'def f():\n  return 1\n');
  fs.writeFileSync(path.join(dir, 'mixed.py'), 'a = 1\n  b = 2\nc = 3\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  const base = git(['rev-parse', 'HEAD'], dir).trim();
  // インデントだけを変更
  fs.writeFileSync(path.join(dir, 'ws_only.py'), 'def f():\n    return 1\n');
  // インデント変更（2 行目）と本物の変更（3 行目）
  fs.writeFileSync(path.join(dir, 'mixed.py'), 'a = 1\n    b = 2\nc = 30\n');
  fs.writeFileSync(path.join(dir, 'untracked.py'), 'x = 1\n');
  return { dir, base };
}

test('ignoreWhitespace: 空白だけの変更は出ず、本物の変更と未追跡ファイルは出る', () => {
  const { dir, base: wsBase } = makeWhitespaceRepo();
  try {
    for (const b of [undefined, wsBase]) {
      // 通常の差分には空白だけの変更も出る。
      const full = byPath(parseUnifiedDiff(runGitDiff(b, dir)));
      assert.equal(full.get('ws_only.py')?.hunks.length, 1);

      const ws = byPath(parseUnifiedDiff(runGitDiff(b, dir, { ignoreWhitespace: true })));
      // 空白だけを変えたファイルは差分から消える。
      assert.equal(ws.has('ws_only.py'), false);
      // 本物の変更は残り、空白だけを変えた 2 行目は変更行ではなく文脈行になる。
      const mixed = ws.get('mixed.py')!;
      const rows = mixed.hunks.flatMap((h) => h.rows);
      const changed = rows.filter((r) => r.left?.kind === 'del' || r.right?.kind === 'add');
      assert.deepEqual(
        changed.map((r) => [r.left?.text, r.right?.text]),
        [['c = 3', 'c = 30']]
      );
      const line2 = rows.find((r) => r.right?.line === 2);
      assert.equal(line2?.right?.kind, 'context');
      assert.equal(line2?.left?.line, 2);
      // 未追跡ファイルは通常の差分と同じく追加ファイルとして含まれる。
      assert.equal(ws.get('untracked.py')?.status, 'added');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGitUncommitted lists staged, unstaged and untracked files with verbatim paths, ignored and .agent-review excluded', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-uncommitted-'));
  try {
    git(['init'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test User'], repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'both.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'old name.txt'), 'rename me\n');
    fs.writeFileSync(path.join(repo, 'clean.txt'), 'a\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'initial commit'], repo);
    // 何も変えていなければ空
    assert.deepEqual(runGitUncommitted(repo), []);

    fs.writeFileSync(path.join(repo, 'staged.txt'), 'b\n');
    git(['add', 'staged.txt'], repo);
    fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'b\n');
    fs.writeFileSync(path.join(repo, 'both.txt'), 'b\n');
    git(['add', 'both.txt'], repo);
    fs.writeFileSync(path.join(repo, 'both.txt'), 'c\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    git(['mv', 'old name.txt', '新しい 名前.txt'], repo);
    fs.writeFileSync(path.join(repo, 'staged new.txt'), 'x\n');
    git(['add', 'staged new.txt'], repo);
    // 未追跡はディレクトリではなくファイル単位で出る
    fs.mkdirSync(path.join(repo, 'new dir', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'new dir', 'sub', '日本語 ファイル.ts'), 'x\n');
    // ignore 対象と、generate が self-ignore する .agent-review/ は出ない
    fs.writeFileSync(path.join(repo, 'debug.log'), 'x\n');
    fs.mkdirSync(path.join(repo, '.agent-review'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agent-review', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(repo, '.agent-review', 'comments.json'), '[]\n');

    const m = new Map<string, UncommittedFile>(runGitUncommitted(repo).map((f) => [f.path, f]));
    assert.deepEqual(m.get('staged.txt'), { path: 'staged.txt', status: 'modified', staged: true, unstaged: false });
    assert.deepEqual(m.get('unstaged.txt'), { path: 'unstaged.txt', status: 'modified', staged: false, unstaged: true });
    assert.deepEqual(m.get('both.txt'), { path: 'both.txt', status: 'modified', staged: true, unstaged: true });
    assert.deepEqual(m.get('gone.txt'), { path: 'gone.txt', status: 'deleted', staged: false, unstaged: true });
    assert.deepEqual(m.get('新しい 名前.txt'), { path: '新しい 名前.txt', status: 'renamed', staged: true, unstaged: false });
    assert.deepEqual(m.get('staged new.txt'), { path: 'staged new.txt', status: 'added', staged: true, unstaged: false });
    assert.deepEqual(m.get('new dir/sub/日本語 ファイル.ts'), {
      path: 'new dir/sub/日本語 ファイル.ts',
      status: 'untracked',
      staged: false,
      unstaged: false,
    });
    // リネーム元のパスは別の行として読まれない
    assert.equal(m.has('old name.txt'), false);
    assert.equal(m.has('clean.txt'), false);
    assert.equal(m.has('debug.log'), false);
    assert.equal([...m.keys()].some((p) => p.startsWith('.agent-review')), false);
    assert.equal(m.size, 7);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runGitUncommitted returns [] outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-uncommitted-nogit-'));
  try {
    assert.deepEqual(runGitUncommitted(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
