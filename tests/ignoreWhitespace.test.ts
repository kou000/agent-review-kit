import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { alignIgnoreWhitespaceFiles } from '../src/client/diff/whitespace';
import { parseUnifiedDiff, runGitDiff } from '../src/gitDiff';
import { DiffCell, FileDiff } from '../src/types';

let tmp: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-ignore-ws-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'a_ws_only.py'), 'def f():\n  return 1\n');
  fs.writeFileSync(path.join(tmp, 'b_mixed.py'), 'a = 1\n  b = 2\nc = 3\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
  fs.writeFileSync(path.join(tmp, 'a_ws_only.py'), 'def f():\n    return 1\n');
  fs.writeFileSync(path.join(tmp, 'b_mixed.py'), 'a = 1\n    b = 2\nc = 30\n');
  fs.writeFileSync(path.join(tmp, 'c_new.py'), 'x = 1\n');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// generate と同じ材料: 通常の差分（newLines 付き）と空白無視の差分（newLines なし）。
function diffs(): { files: FileDiff[]; wsFiles: FileDiff[] } {
  const files = parseUnifiedDiff(runGitDiff(undefined, tmp));
  for (const f of files) {
    f.newLines = fs.readFileSync(path.join(tmp, f.path), 'utf8').split('\n').slice(0, -1);
  }
  const wsFiles = parseUnifiedDiff(runGitDiff(undefined, tmp, { ignoreWhitespace: true }));
  return { files, wsFiles };
}

function cellAt(file: FileDiff, side: 'old' | 'new', line: number): DiffCell | undefined {
  for (const h of file.hunks) {
    for (const r of h.rows) {
      const c = side === 'old' ? r.left : r.right;
      if (c && c.line === line) return c;
    }
  }
  return undefined;
}

test('通常の差分と同じ順序・同じファイル集合に揃え、newLines を共有する', () => {
  const { files, wsFiles } = diffs();
  const aligned = alignIgnoreWhitespaceFiles(files, wsFiles);
  assert.deepEqual(
    aligned.map((f) => f.path),
    files.map((f) => f.path)
  );
  aligned.forEach((f, i) => assert.equal(f.newLines, files[i].newLines));
});

test('空白の変更しかないファイルは差分なし（whitespaceOnly）として残る', () => {
  const { files, wsFiles } = diffs();
  const ws = alignIgnoreWhitespaceFiles(files, wsFiles).find((f) => f.path === 'a_ws_only.py')!;
  assert.equal(ws.hunks.length, 0);
  assert.equal(ws.whitespaceOnly, true);
  // 本物の変更のあるファイルには付かない。
  const mixed = alignIgnoreWhitespaceFiles(files, wsFiles).find((f) => f.path === 'b_mixed.py')!;
  assert.equal(mixed.whitespaceOnly, false);
});

test('diffLine は空白無視の差分ではなく通常の差分上の行番号になる', () => {
  const { files, wsFiles } = diffs();
  const full = files.find((f) => f.path === 'b_mixed.py')!;
  const ws = alignIgnoreWhitespaceFiles(files, wsFiles).find((f) => f.path === 'b_mixed.py')!;

  // 空白だけを変えた 2 行目: 空白無視では文脈行、通常の差分では左右別々の変更行。
  const wsNew2 = cellAt(ws, 'new', 2)!;
  const wsOld2 = cellAt(ws, 'old', 2)!;
  assert.equal(wsNew2.kind, 'context');
  assert.equal(wsNew2.diffLine, cellAt(full, 'new', 2)!.diffLine);
  assert.equal(wsOld2.diffLine, cellAt(full, 'old', 2)!.diffLine);
  assert.notEqual(wsNew2.diffLine, wsOld2.diffLine);

  // 本物の変更（3 行目）と変更のない 1 行目も通常の差分の位置。
  for (const side of ['old', 'new'] as const) {
    for (const line of [1, 3]) {
      assert.equal(cellAt(ws, side, line)!.diffLine, cellAt(full, side, line)!.diffLine);
    }
  }

  // 元の空白無視の差分（入力）は書き換えない。
  const raw = wsFiles.find((f) => f.path === 'b_mixed.py')!;
  assert.notEqual(cellAt(raw, 'new', 2)!.diffLine, wsNew2.diffLine);
});

test('展開した行にも通常の差分上の diffLine を引ける（refDiffLines）', () => {
  const { files, wsFiles } = diffs();
  const full = files.find((f) => f.path === 'a_ws_only.py')!;
  const ws = alignIgnoreWhitespaceFiles(files, wsFiles).find((f) => f.path === 'a_ws_only.py')!;
  // 2 行目は空白無視の表示では展開して見る行。通常の差分では変更行。
  assert.equal(ws.refDiffLines!.new[2], cellAt(full, 'new', 2)!.diffLine);
  assert.equal(ws.refDiffLines!.old[2], cellAt(full, 'old', 2)!.diffLine);
  // 通常の差分に無い行は引けない（呼び出し側は 0 = 展開した文脈行 にする）。
  assert.equal(ws.refDiffLines!.new[99], undefined);
});
