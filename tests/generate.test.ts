import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { generate } from '../src/commands/generate';
import { reviewPaths } from '../src/paths';
import { DiffData, FileDiff } from '../src/types';

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// review.html に埋め込まれた window.__DIFF__ を取り出す。
function readDiffData(cwd: string): DiffData {
  const html = fs.readFileSync(reviewPaths(cwd).html, 'utf8');
  const m = /<script>window\.__DIFF__ = (.*);<\/script>/.exec(html);
  assert.ok(m, 'review.html に __DIFF__ がない');
  return JSON.parse(m[1]) as DiffData;
}

function byPath(files: FileDiff[]): Map<string, FileDiff> {
  return new Map(files.map((f) => [f.path, f]));
}

test('generate は通常の差分と空白の変更を無視した差分の両方を review.html に入れる', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-generate-'));
  try {
    git(['init'], tmp);
    git(['config', 'user.email', 'test@example.com'], tmp);
    git(['config', 'user.name', 'Test User'], tmp);
    fs.writeFileSync(path.join(tmp, 'ws_only.txt'), 'one\n  two\nthree\n');
    fs.writeFileSync(path.join(tmp, 'real.txt'), 'x\ny\n');
    git(['add', '.'], tmp);
    git(['commit', '-m', 'initial commit'], tmp);
    fs.writeFileSync(path.join(tmp, 'ws_only.txt'), 'one\n\ttwo\nthree  \n');
    fs.writeFileSync(path.join(tmp, 'real.txt'), 'x\nY\n');
    fs.writeFileSync(path.join(tmp, 'new.txt'), 'brand new\n');

    await generate({ cwd: tmp, quiet: true });
    const data = readDiffData(tmp);

    // 通常の差分（既定の表示）は今までどおり空白だけの変更も含む。
    const full = byPath(data.files);
    assert.equal(full.get('ws_only.txt')?.hunks.length, 1);
    assert.ok(full.get('real.txt'));
    assert.equal(full.get('new.txt')?.status, 'added');

    // 空白無視の差分: 空白だけの変更は出ず、本物の変更と未追跡ファイルは出る。
    assert.ok(Array.isArray(data.ignoreWhitespaceFiles));
    const ws = byPath(data.ignoreWhitespaceFiles!);
    assert.equal(ws.has('ws_only.txt'), false);
    const real = ws.get('real.txt')!;
    const texts = real.hunks.flatMap((h) =>
      h.rows.filter((r) => r.right?.kind === 'add').map((r) => r.right!.text)
    );
    assert.deepEqual(texts, ['Y']);
    assert.equal(ws.get('new.txt')?.status, 'added');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
