import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { setSettings } from '../src/commands/setSettings';
import { reviewPaths } from '../src/paths';
import { loadSettings } from '../src/store';

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-setsettings-'));
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

function load(tmp: string) {
  const paths = reviewPaths(tmp);
  return loadSettings(paths.settings, paths.envFile);
}

test('setSettings は指定した設定だけを現在のブランチで ON にする', () => {
  const tmp = makeTmpRepo();
  assert.equal(load(tmp).readOnlyMode, false);
  assert.equal(load(tmp).prPendingCommentEnabled, false);

  quiet(() => setSettings({ cwd: tmp, readOnly: true }));
  assert.equal(load(tmp).readOnlyMode, true);
  assert.equal(load(tmp).prPendingCommentEnabled, false);

  quiet(() => setSettings({ cwd: tmp, prPendingComment: true }));
  assert.equal(load(tmp).readOnlyMode, true);
  assert.equal(load(tmp).prPendingCommentEnabled, true);
  assert.ok(reviewPaths(tmp).settings.includes(path.join('branches', 'feature-x')));
});

test('setSettings は --read-only と --pr-pending-comment を同時に ON にできる', () => {
  const tmp = makeTmpRepo();
  quiet(() => setSettings({ cwd: tmp, readOnly: true, prPendingComment: true }));
  assert.equal(load(tmp).readOnlyMode, true);
  assert.equal(load(tmp).prPendingCommentEnabled, true);
});
