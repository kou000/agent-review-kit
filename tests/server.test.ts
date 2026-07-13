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
import { createSnapshot } from '../src/snapshot';
import { reconcileViewed } from '../src/store';

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

// Regression: the standalone /snapshot/<id> diff page must carry the same
// baked Shiki highlighting as the main review page. Before the fix the snapshot
// route built DiffData straight from the patch without calling bakeHighlight,
// so every cell rendered as uncolored plain text.
test('GET /snapshot/<id> は Shiki のハイライト（inline color span）を含む', async () => {
  const gitOut = (args: string[]): string =>
    execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });

  // A TypeScript change to highlight, captured as a snapshot off a commit.
  fs.writeFileSync(path.join(tmp, 'snap.ts'), 'export const answer: number = 42;\n');
  git(['add', 'snap.ts'], tmp);
  git(['commit', '-m', 'add snap.ts'], tmp);
  const sha = gitOut(['rev-parse', 'HEAD']).trim();

  const created = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'スナップショット対象コメント' }),
  });
  const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;

  const paths = reviewPaths(tmp);
  const snap = silence(() => createSnapshot(paths, tmp, { commentId, commit: sha }));

  const res = await fetch(`${baseUrl}/snapshot/${snap.id}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  // Shiki bakes token colors as inline <span style="color:…"> into the diff
  // payload; that inline color is the highlighting the main page also emits
  // (the stylesheet itself only uses CSS vars, never a literal color:#hex).
  assert.match(body, /color:#[0-9a-fA-F]{6}/);
  // The colors live on the diff cell's per-line `html` field, proving it is the
  // diff content that is highlighted (not incidental chrome).
  assert.ok(body.includes('"html":'));
});

/* ---------- viewed ("確認済み") state ---------- */

test('reconcileViewed は現在ハッシュと一致するエントリだけ残す', () => {
  const saved = { 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h3' };
  const current = { 'a.ts': 'h1', 'b.ts': 'CHANGED' };
  // a.ts matches (kept); b.ts hash changed (dropped); gone.ts absent from the
  // current diff (dropped). Nothing not in `current` is ever kept.
  assert.deepEqual(reconcileViewed(saved, current), { 'a.ts': 'h1' });
});

test('GET /api/viewed は初期状態で空マップを返す', async () => {
  const res = await fetch(`${baseUrl}/api/viewed`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { viewed: Record<string, string> };
  assert.deepEqual(data.viewed, {});
});

test('PUT /api/viewed は全置換で保存し GET で取得できる', async () => {
  const put = await fetch(`${baseUrl}/api/viewed`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewed: { 'a.ts': 'h1', 'b.ts': 'h2' } }),
  });
  assert.equal(put.status, 200);
  const putData = (await put.json()) as { viewed: Record<string, string> };
  assert.deepEqual(putData.viewed, { 'a.ts': 'h1', 'b.ts': 'h2' });

  const get = await fetch(`${baseUrl}/api/viewed`);
  const getData = (await get.json()) as { viewed: Record<string, string> };
  assert.deepEqual(getData.viewed, { 'a.ts': 'h1', 'b.ts': 'h2' });
});

test('POST /api/viewed/reconcile はハッシュ不一致・消えたファイルを無効化して永続化する', async () => {
  await fetch(`${baseUrl}/api/viewed`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewed: { 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h3' } }),
  });

  const rec = await fetch(`${baseUrl}/api/viewed/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // b.ts changed, gone.ts no longer in the diff, c.ts is new & unviewed.
    body: JSON.stringify({ hashes: { 'a.ts': 'h1', 'b.ts': 'CHANGED', 'c.ts': 'h4' } }),
  });
  assert.equal(rec.status, 200);
  const recData = (await rec.json()) as { viewed: Record<string, string> };
  assert.deepEqual(recData.viewed, { 'a.ts': 'h1' });

  // The pruned map is persisted, not just returned.
  const get = await fetch(`${baseUrl}/api/viewed`);
  const getData = (await get.json()) as { viewed: Record<string, string> };
  assert.deepEqual(getData.viewed, { 'a.ts': 'h1' });
});

test('PUT /api/viewed に不正な形（配列や非文字列値）を渡すと 400 になる', async () => {
  const arr = await fetch(`${baseUrl}/api/viewed`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewed: ['a.ts'] }),
  });
  assert.equal(arr.status, 400);

  const nonString = await fetch(`${baseUrl}/api/viewed`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewed: { 'a.ts': 123 } }),
  });
  assert.equal(nonString.status, 400);
});
