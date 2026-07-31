const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { waitComments } = require('../dist/commands/waitComments');
const { reviewPaths } = require('../dist/paths');
const CLI = path.join(__dirname, '..', 'dist', 'cli.js');

function generationKey(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function lockGeneration(lockDir) {
  const stat = fs.lstatSync(lockDir);
  return generationKey(`${stat.dev}:${stat.ino}`);
}

function claimPath(lockDir, generation = lockGeneration(lockDir)) {
  return path.join(lockDir, `.claim-${generation}.json`);
}

function writeOwnerClaim(lockDir, overrides = {}) {
  const generation = lockGeneration(lockDir);
  const owner = {
    token: 'fixture-owner',
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00.000Z',
    generation,
    ...overrides,
  };
  fs.writeFileSync(
    claimPath(lockDir, generation),
    `${JSON.stringify({ kind: 'owner', owner }, null, 2)}\n`
  );
  return { generation, owner };
}

function writeRecoveryClaim(lockDir) {
  const generation = lockGeneration(lockDir);
  const recovery = {
    kind: 'recovery',
    generation,
    token: 'fixture-recovery',
    claimedAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(claimPath(lockDir, generation), `${JSON.stringify(recovery, null, 2)}\n`);
  return generation;
}

function comment(id, status, overrides = {}) {
  return {
    id,
    file: null,
    side: null,
    startLine: null,
    endLine: null,
    startDiffLine: null,
    endDiffLine: null,
    body: id,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fixture(comments) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-kit-test-'));
  execFileSync('git', ['init', '-q'], { cwd });
  fs.mkdirSync(path.join(cwd, '.agent-review'));
  const paths = reviewPaths(cwd);
  fs.mkdirSync(path.dirname(paths.comments), { recursive: true });
  fs.writeFileSync(paths.comments, `${JSON.stringify({ comments }, null, 2)}\n`);
  return { cwd, paths };
}

async function captureWait(options) {
  let output = '';
  const originalLog = console.log;
  console.log = (value) => {
    output += String(value);
  };
  try {
    await waitComments(options);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(output);
}

async function waitForLockClaim(lockDir, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const generation = lockGeneration(lockDir);
      const file = claimPath(lockDir, generation);
      if (fs.existsSync(file)) return { generation, file };
    } catch {
      // The lock directory has not been published yet.
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for claim in ${lockDir}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('normal wait delivers only new user comments and marks them seen', async (t) => {
  const existingSeen = comment('seen-before', 'seen');
  const { cwd, paths } = fixture([
    existingSeen,
    comment('new-user', 'open'),
    comment('agent-finding', 'open', { author: 'agent' }),
    comment('deleted-user', 'open', { deleted: true }),
  ]);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = await captureWait({ cwd });

  assert.equal(result.status, 'received');
  assert.deepEqual(result.comments.map((item) => item.id), ['new-user']);
  const stored = JSON.parse(fs.readFileSync(paths.comments, 'utf8')).comments;
  assert.equal(stored.find((item) => item.id === 'new-user').status, 'seen');
  assert.equal(stored.find((item) => item.id === 'seen-before').updatedAt, existingSeen.updatedAt);
  assert.equal(stored.find((item) => item.id === 'agent-finding').status, 'open');
});

test('resume wait recovers existing seen user comments without retimestamping them', async (t) => {
  const seen = comment('interrupted', 'seen');
  const { cwd, paths } = fixture([
    seen,
    comment('agent-seen', 'seen', { author: 'agent' }),
  ]);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = await captureWait({ cwd, resume: true });

  assert.equal(result.status, 'received');
  assert.deepEqual(result.comments.map((item) => item.id), ['interrupted']);
  const stored = JSON.parse(fs.readFileSync(paths.comments, 'utf8')).comments;
  assert.equal(stored.find((item) => item.id === 'interrupted').status, 'seen');
  assert.equal(stored.find((item) => item.id === 'interrupted').updatedAt, seen.updatedAt);
});

test('a repository allows only one live wait-comments process', async (t) => {
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  const first = spawn(process.execPath, [CLI, 'wait-comments', '--timeout', '30'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstStdout = '';
  let firstStderr = '';
  first.stdout.on('data', (chunk) => {
    firstStdout += chunk;
  });
  first.stderr.on('data', (chunk) => {
    firstStderr += chunk;
  });
  const firstClosed = new Promise((resolve) => first.once('close', resolve));
  t.after(() => {
    if (first.exitCode === null) first.kill('SIGTERM');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const { generation, file } = await waitForLockClaim(lockDir);
  const claim = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(claim.kind, 'owner');
  assert.equal(claim.owner.generation, generation);
  if (process.platform === 'darwin' || process.platform === 'linux') {
    assert.ok(claim.owner.witness, 'live waiter should publish a FIFO witness');
    assert.equal(fs.lstatSync(path.join(lockDir, claim.owner.witness.file)).isFIFO(), true);
  }

  const second = spawnSync(
    process.execPath,
    [CLI, 'wait-comments', '--timeout', '1', '--resume'],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another wait-comments process is already running/);

  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  const firstExit = await firstClosed;
  assert.equal(firstExit, 0, firstStderr);
  assert.equal(JSON.parse(firstStdout).status, 'finished');
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(
    fs.existsSync(path.join(cwd, '.agent-review', '.wait-comments.retired', generation)),
    true
  );
});

test('a stale waiter lock with a live owner is not reclaimed', (t) => {
  const { cwd } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  const { owner } = writeOwnerClaim(lockDir, { token: 'live-main-owner' });
  const staleAt = new Date(Date.now() - 61_000);
  fs.utimesSync(lockDir, staleAt, staleAt);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /another wait-comments process is already running/);
  assert.equal(JSON.parse(fs.readFileSync(claimPath(lockDir), 'utf8')).owner.token, owner.token);
});

test('concurrent contenders reclaim one dead waiter lock without dual ownership', async (t) => {
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  writeOwnerClaim(lockDir, { token: 'dead', pid: 2_147_483_647 });

  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, [CLI, 'wait-comments', '--timeout', '30'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = { child, stdout: '', stderr: '', closed: null };
    child.stdout.on('data', (chunk) => {
      result.stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      result.stderr += chunk;
    });
    result.closed = new Promise((resolve) => {
      child.once('close', (code) => resolve({ code, result }));
    });
    return result;
  });
  t.after(() => {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const loser = await Promise.race(children.map((item) => item.closed));
  assert.equal(loser.code, 1);
  assert.match(loser.result.stderr, /another wait-comments process/);

  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  const winner = await children.find((item) => item !== loser.result).closed;
  assert.equal(winner.code, 0, winner.result.stderr);
  assert.equal(JSON.parse(winner.result.stdout).status, 'finished');
  assert.equal(fs.existsSync(lockDir), false);
});

test('a stale unclaimed waiter lock is recovered instead of blocking forever', (t) => {
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  const generation = lockGeneration(lockDir);
  const staleAt = new Date(Date.now() - 61_000);
  fs.utimesSync(lockDir, staleAt, staleAt);
  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'finished');
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(
    fs.existsSync(path.join(cwd, '.agent-review', '.wait-comments.retired', generation)),
    true
  );
});

test('another contender completes an already published recovery immediately', (t) => {
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  const generation = writeRecoveryClaim(lockDir);
  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'finished');
  assert.equal(
    fs.existsSync(path.join(cwd, '.agent-review', '.wait-comments.retired', generation)),
    true
  );
});

test('a fresh unclaimed lock is not overwritten during its startup grace period', (t) => {
  const { cwd } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /another wait-comments process is already running/);
  assert.equal(fs.existsSync(lockDir), true);
});

test('a reused PID start token does not keep a waiter lock alive', (t) => {
  if (process.platform !== 'linux') {
    t.skip('process start identity is read from /proc on Linux');
    return;
  }
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  writeOwnerClaim(lockDir, {
    token: 'reused-pid-owner',
    processStart: 'not-the-current-process',
  });
  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'finished');
});

test('a closed FIFO witness permits recovery even when its PID is live', (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('FIFO liveness witnesses are used on macOS and Linux');
    return;
  }
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  const witnessFile = `.alive-${generationKey('closed-witness')}`;
  const witnessPath = path.join(lockDir, witnessFile);
  execFileSync('mkfifo', ['-m', '600', witnessPath]);
  const witnessStat = fs.lstatSync(witnessPath);
  writeOwnerClaim(lockDir, {
    token: 'crashed-owner-with-reused-pid',
    witness: { file: witnessFile, dev: witnessStat.dev, ino: witnessStat.ino },
  });
  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'finished');
});

test('a stray claim from an old generation cannot poison the current lock', (t) => {
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  const currentGeneration = lockGeneration(lockDir);
  const oldGeneration = generationKey('old-generation');
  fs.writeFileSync(
    claimPath(lockDir, oldGeneration),
    `${JSON.stringify({
      kind: 'owner',
      owner: {
        token: 'old-owner',
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        generation: oldGeneration,
      },
    })}\n`
  );
  const staleAt = new Date(Date.now() - 61_000);
  fs.utimesSync(lockDir, staleAt, staleAt);
  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'wait-comments', '--timeout', '1'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'finished');
  assert.equal(
    fs.existsSync(path.join(cwd, '.agent-review', '.wait-comments.retired', currentGeneration)),
    true
  );
});

test('concurrent contenders safely reclaim a stale unclaimed lock', async (t) => {
  const { cwd, paths } = fixture([]);
  const lockDir = path.join(cwd, '.agent-review', '.wait-comments.lock');
  fs.mkdirSync(lockDir);
  const staleAt = new Date(Date.now() - 61_000);
  fs.utimesSync(lockDir, staleAt, staleAt);

  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, [CLI, 'wait-comments', '--timeout', '30'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = { child, stdout: '', stderr: '', closed: null };
    child.stdout.on('data', (chunk) => {
      result.stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      result.stderr += chunk;
    });
    result.closed = new Promise((resolve) => {
      child.once('close', (code) => resolve({ code, result }));
    });
    return result;
  });
  t.after(() => {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const loser = await Promise.race(children.map((item) => item.closed));
  assert.equal(loser.code, 1);
  assert.match(loser.result.stderr, /another wait-comments process|ownership was lost/);

  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');
  const winner = await children.find((item) => item !== loser.result).closed;
  assert.equal(winner.code, 0, winner.result.stderr);
  assert.equal(JSON.parse(winner.result.stdout).status, 'finished');
});

test('CLI accepts bare --resume and rejects misspelled or valued forms', (t) => {
  const { cwd } = fixture([comment('cli-resume', 'seen')]);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const valid = spawnSync(process.execPath, [CLI, 'wait-comments', '--resume'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout).comments.map((item) => item.id), ['cli-resume']);

  for (const option of ['--resum', '--resume=true']) {
    const invalid = spawnSync(process.execPath, [CLI, 'wait-comments', option], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /unknown option/);
  }
});

test('snapshot path prints the active branch-scoped directory through the CLI', (t) => {
  const { cwd, paths } = fixture([]);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI, 'snapshot', 'path'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const expected = path.join(fs.realpathSync(cwd), path.relative(cwd, paths.snapshotsDir));
  assert.equal(result.stdout.trim(), expected);
});
