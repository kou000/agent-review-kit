import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parsePrUrl, setPr } from '../src/commands/setPr';
import { reviewPaths } from '../src/paths';
import { loadPr } from '../src/store';

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-setpr-'));
  execFileSync('git', ['init', '-b', 'feature/x'], { cwd: tmp, stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  return tmp;
}

function quiet(fn: () => void): void {
  const orig = console.log;
  console.log = () => {};
  try {
    fn();
  } finally {
    console.log = orig;
  }
}

test('parsePrUrl accepts GitHub PR and GitLab MR URLs', () => {
  assert.deepEqual(parsePrUrl('https://github.com/o/r/pull/12'), { provider: 'github', number: 12 });
  assert.deepEqual(parsePrUrl('https://github.com/o/r/pull/12/files'), { provider: 'github', number: 12 });
  assert.deepEqual(parsePrUrl('https://gitlab.com/g/sub/p/-/merge_requests/34'), {
    provider: 'gitlab',
    number: 34,
  });
  assert.deepEqual(parsePrUrl('https://git.example.com/g/p/-/merge_requests/5#note_9'), {
    provider: 'gitlab',
    number: 5,
  });
});

test('parsePrUrl rejects URLs that are not a PR/MR', () => {
  assert.equal(parsePrUrl('https://github.com/o/r/issues/12'), null);
  assert.equal(parsePrUrl('http://github.com/o/r/pull/12'), null);
  assert.equal(parsePrUrl('https://gitlab.com/g/p/merge_requests/3'), null);
});

test('setPr stores the PR for the current branch and --clear removes it', () => {
  const tmp = makeTmpRepo();
  quiet(() => setPr({ cwd: tmp, url: 'https://github.com/o/r/pull/12' }));

  const paths = reviewPaths(tmp);
  assert.ok(paths.pr.includes(path.join('branches', 'feature-x')));
  const pr = loadPr(paths.pr);
  assert.equal(pr?.url, 'https://github.com/o/r/pull/12');
  assert.equal(pr?.provider, 'github');
  assert.equal(pr?.number, 12);

  quiet(() => setPr({ cwd: tmp, clear: true }));
  assert.equal(loadPr(paths.pr), null);
});
