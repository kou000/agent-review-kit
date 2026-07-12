import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { publishHtml } from '../src/commands/publishHtml';
import { reviewPaths } from '../src/paths';
import { createServer } from '../src/server';

let tmp: string;
let server: http.Server;
let baseUrl: string;
let documentId: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function silence<T>(fn: () => T): T {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-server-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), '# tmp repo\n');
  git(['add', 'README.md'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);

  const inputFile = path.join(tmp, 'doc.html');
  fs.writeFileSync(
    inputFile,
    '<html><head><title>Server Test Doc</title></head><body><h1>Heading</h1><script>alert(1)</script></body></html>'
  );
  documentId = 'server-doc';
  silence(() => publishHtml({ input: inputFile, documentId, cwd: tmp }));

  server = createServer(reviewPaths(tmp));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('unexpected server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /doc/<id> は 200 で HTML を返す', async () => {
  const res = await fetch(`${baseUrl}/doc/${documentId}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Server Test Doc'));
  assert.ok(res.headers.get('content-type')?.includes('text/html'));
});

test('GET /doc/<id>/content は 200 で no-script CSP ヘッダ付きで本文をそのまま返す', async () => {
  const res = await fetch(`${baseUrl}/doc/${documentId}/content`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp);
  // The CSP is the no-script guarantee: script execution and external
  // requests are blocked at display time, so the body is served verbatim.
  assert.ok(csp!.includes("default-src 'none'"));
  assert.ok(!/script-src/.test(csp!));
  const body = await res.text();
  assert.ok(body.includes('<h1>Heading</h1>'));
  assert.ok(body.includes('<script>alert(1)</script>'));
});

test('GET /api/documents に登録した文書がある', async () => {
  const res = await fetch(`${baseUrl}/api/documents`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { documents: { id: string }[] };
  assert.ok(data.documents.some((d) => d.id === documentId));
});

test('POST /api/comments（kind: element）は 201 で documentId/htmlTarget を返す', async () => {
  const res = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId,
      htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1' },
      body: 'この見出しについて',
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as {
    comment: { id: string; documentId: string; htmlTarget: { kind: string; selector: string } };
  };
  assert.equal(data.comment.documentId, documentId);
  assert.equal(data.comment.htmlTarget.kind, 'element');
  assert.equal(data.comment.htmlTarget.selector, 'h1');
});

test('POST /api/comments（kind: text, selectedText 無し）は 400 になる', async () => {
  const res = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId,
      htmlTarget: { kind: 'text', selector: 'p', tag: 'p', label: 'p' },
      body: 'x',
    }),
  });
  assert.equal(res.status, 400);
});

test('未知の documentId は 400 になる', async () => {
  const res = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: 'no-such-doc',
      htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1' },
      body: 'x',
    }),
  });
  assert.equal(res.status, 400);
});

test('documentId コメントへの返信は documentId/htmlTarget を継承する', async () => {
  const created = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId,
      htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1' },
      body: '親コメント',
    }),
  });
  const parent = ((await created.json()) as { comment: { id: string } }).comment;

  const replyRes = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: parent.id, body: '返信です' }),
  });
  assert.equal(replyRes.status, 201);
  const reply = ((await replyRes.json()) as {
    comment: { documentId: string; htmlTarget: { selector: string } | null; parentId: string };
  }).comment;
  assert.equal(reply.documentId, documentId);
  assert.equal(reply.htmlTarget?.selector, 'h1');
  assert.equal(reply.parentId, parent.id);
});

test('既存 diff コメント投稿は回帰なく動作する', async () => {
  const res = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file: 'a.ts',
      side: 'new',
      startLine: 1,
      endLine: 1,
      startDiffLine: 1,
      endDiffLine: 1,
      body: 'x',
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { comment: { file: string } };
  assert.equal(data.comment.file, 'a.ts');
});
