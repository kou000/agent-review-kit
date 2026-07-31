const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { generate } = require('../dist/commands/generate');
const { waitComments } = require('../dist/commands/waitComments');
const { reviewPaths } = require('../dist/paths');
const { createServer } = require('../dist/server');

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-kit-finish-test-'));
  execFileSync('git', ['init', '-q'], { cwd });
  fs.mkdirSync(path.join(cwd, '.agent-review'));
  return { cwd, paths: reviewPaths(cwd) };
}

function request(server, method, url, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(payload);
    req.method = method;
    req.url = url;
    let statusCode = 0;
    const res = {
      writeHead(code) {
        statusCode = code;
      },
      end(data = '') {
        resolve({ statusCode, body: JSON.parse(String(data)) });
      },
    };
    server.emit('request', req, res);
  });
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

test('finish and comment creation are ordered, and accepted final comments are drained', async (t) => {
  const { cwd, paths } = fixture();
  const server = createServer(paths);
  t.after(() => {
    server.removeAllListeners();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const [post, finish] = await Promise.all([
    request(server, 'POST', '/api/comments', { body: 'last comment' }),
    request(server, 'POST', '/api/finish'),
  ]);

  assert.equal(finish.statusCode, 200);
  assert.ok(post.statusCode === 201 || post.statusCode === 409, JSON.stringify(post));
  const comments = JSON.parse(fs.readFileSync(paths.comments, 'utf8')).comments;
  assert.equal(comments.length, post.statusCode === 201 ? 1 : 0);

  const firstWait = await captureWait({ cwd });
  if (post.statusCode === 201) {
    assert.equal(firstWait.status, 'received');
    assert.equal(firstWait.comments[0].body, 'last comment');
    assert.equal((await captureWait({ cwd })).status, 'finished');
  } else {
    assert.equal(firstWait.status, 'finished');
  }

  const late = await request(server, 'POST', '/api/comments', { body: 'too late' });
  assert.equal(late.statusCode, 409);
  assert.match(late.body.error, /already finished/);
});

test('finish and comment reopen are ordered, and a late resend is rejected', async (t) => {
  const { cwd, paths } = fixture();
  const server = createServer(paths);
  t.after(() => {
    server.removeAllListeners();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const created = await request(server, 'POST', '/api/comments', { body: 'reopen me' });
  assert.equal(created.statusCode, 201);
  const id = created.body.comment.id;
  const resolved = await request(
    server,
    'POST',
    `/api/comments/${encodeURIComponent(id)}/resolve`,
    {}
  );
  assert.equal(resolved.statusCode, 200);

  const [reopen, finish] = await Promise.all([
    request(server, 'PATCH', `/api/comments/${encodeURIComponent(id)}`, { status: 'open' }),
    request(server, 'POST', '/api/finish'),
  ]);

  assert.equal(finish.statusCode, 200);
  assert.ok(reopen.statusCode === 200 || reopen.statusCode === 409, JSON.stringify(reopen));

  const firstWait = await captureWait({ cwd });
  if (reopen.statusCode === 200) {
    assert.equal(firstWait.status, 'received');
    assert.equal(firstWait.comments[0].id, id);
    assert.equal((await captureWait({ cwd })).status, 'finished');
  } else {
    assert.equal(firstWait.status, 'finished');
  }

  const statusBeforeLateResends = JSON.parse(
    fs.readFileSync(paths.comments, 'utf8')
  ).comments.find((item) => item.id === id).status;
  for (const status of ['open', 'seen']) {
    const late = await request(server, 'PATCH', `/api/comments/${encodeURIComponent(id)}`, {
      status,
    });
    assert.equal(late.statusCode, 409);
    assert.match(late.body.error, /already finished/);
  }
  const stored = JSON.parse(fs.readFileSync(paths.comments, 'utf8')).comments;
  assert.equal(stored.find((item) => item.id === id).status, statusBeforeLateResends);
});

test('a review refresh preserves a concurrent finish signal', async (t) => {
  const { cwd, paths } = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init'],
    { cwd, stdio: 'ignore' }
  );

  fs.mkdirSync(path.dirname(paths.finished), { recursive: true });
  fs.writeFileSync(paths.finished, '{"finishedAt":"2026-01-01T00:00:00.000Z"}\n');

  const originalLog = console.log;
  console.log = () => {};
  try {
    await generate({ cwd, preserveFinished: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(fs.existsSync(paths.finished), true);
  assert.equal((await captureWait({ cwd })).status, 'finished');

  console.log = () => {};
  try {
    await generate({ cwd });
  } finally {
    console.log = originalLog;
  }
  assert.equal(fs.existsSync(paths.finished), false);
});
