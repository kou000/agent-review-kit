import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { publishHtml } from '../src/commands/publishHtml';
import { resolveComment } from '../src/commands/resolveComment';
import { reviewPaths } from '../src/paths';
import { createServer } from '../src/server';
import { createSnapshot } from '../src/snapshot';
import { reconcileViewed } from '../src/store';

let tmp: string;
let server: http.Server;
let baseUrl: string;
let documentId: string;

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory); point HOME at an
// empty temp dir so every test starts from the built-in defaults.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

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

test('POST /api/comments/<id>/resolve は大元のコメントの未解決の返信もまとめて resolve する', async () => {
  const post = async (payload: Record<string, unknown>): Promise<{ id: string }> => {
    const res = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { comment: { id: string } }).comment;
  };
  const parent = await post({ body: 'カスケード親' });
  const reply1 = await post({ parentId: parent.id, body: '返信1' });
  const reply2 = await post({ parentId: parent.id, body: '返信2' });

  const res = await fetch(
    `${baseUrl}/api/comments/${parent.id}/resolve`,
    { method: 'POST' }
  );
  assert.equal(res.status, 200);

  const all = ((await (await fetch(`${baseUrl}/api/comments`)).json()) as {
    comments: { id: string; status: string }[];
  }).comments;
  const byId = new Map(all.map((c) => [c.id, c.status]));
  assert.equal(byId.get(parent.id), 'resolved');
  assert.equal(byId.get(reply1.id), 'resolved');
  assert.equal(byId.get(reply2.id), 'resolved');
});

test('resolve-comment CLI でも大元を settled にすると未解決の返信が resolve される', async () => {
  const post = async (payload: Record<string, unknown>): Promise<{ id: string }> => {
    const res = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { comment: { id: string } }).comment;
  };
  const parent = await post({ body: 'CLI カスケード親' });
  const reply = await post({ parentId: parent.id, body: 'CLI 返信' });

  silence(() => resolveComment({ id: parent.id, status: 'fixed', message: '直しました', cwd: tmp }));

  const all = ((await (await fetch(`${baseUrl}/api/comments`)).json()) as {
    comments: { id: string; status: string }[];
  }).comments;
  const byId = new Map(all.map((c) => [c.id, c.status]));
  assert.equal(byId.get(parent.id), 'fixed');
  assert.equal(byId.get(reply.id), 'resolved');
});

test('resolve-comment CLI で --status seen のときは返信へカスケードしない', async () => {
  const post = async (payload: Record<string, unknown>): Promise<{ id: string }> => {
    const res = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { comment: { id: string } }).comment;
  };
  const parent = await post({ body: 'seen 親' });
  const reply = await post({ parentId: parent.id, body: 'seen 返信' });

  silence(() => resolveComment({ id: parent.id, status: 'seen', cwd: tmp }));

  const all = ((await (await fetch(`${baseUrl}/api/comments`)).json()) as {
    comments: { id: string; status: string }[];
  }).comments;
  const byId = new Map(all.map((c) => [c.id, c.status]));
  assert.equal(byId.get(parent.id), 'seen');
  assert.equal(byId.get(reply.id), 'open');
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

test('intent は diff コメント・全体コメント・返信・ドキュメントコメントに保存される', async () => {
  const post = async (payload: Record<string, unknown>): Promise<{ id: string; intent?: string }> => {
    const res = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { comment: { id: string; intent?: string } }).comment;
  };

  const diff = await post({
    file: 'a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    startDiffLine: 1,
    endDiffLine: 1,
    body: 'これは何のため？',
    intent: 'question',
  });
  assert.equal(diff.intent, 'question');

  const overall = await post({ body: '全体への質問', intent: 'question' });
  assert.equal(overall.intent, 'question');

  const reply = await post({ parentId: overall.id, body: '追撃質問', intent: 'question' });
  assert.equal(reply.intent, 'question');

  const doc = await post({
    documentId,
    htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1' },
    body: 'ここは？',
    intent: 'question',
  });
  assert.equal(doc.intent, 'question');
});

test('intent 省略時はフィールドごと省かれ、不正な値は 400 になる', async () => {
  const created = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'intent なし' }),
  });
  assert.equal(created.status, 201);
  const comment = ((await created.json()) as { comment: Record<string, unknown> }).comment;
  assert.ok(!('intent' in comment));

  const bad = await fetch(`${baseUrl}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'x', intent: 'refactor' }),
  });
  assert.equal(bad.status, 400);
});

test('readOnlyMode の間は intent が question に強制される', async () => {
  const setReadOnly = async (on: boolean): Promise<void> => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readOnlyMode: on }),
    });
    assert.equal(res.status, 200);
  };
  const post = async (payload: Record<string, unknown>): Promise<{ intent?: string }> => {
    const res = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { comment: { intent?: string } }).comment;
  };

  await setReadOnly(true);
  try {
    // Explicit 修正依頼 and an omitted intent both land on question: a form
    // rendered before the toggle must not slip a fix request through.
    assert.equal((await post({ body: '直して', intent: 'fix' })).intent, 'question');
    assert.equal((await post({ body: 'intent なし' })).intent, 'question');
    // Validation still runs first.
    const bad = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x', intent: 'refactor' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await setReadOnly(false);
  }
  assert.equal((await post({ body: '解除後は修正依頼', intent: 'fix' })).intent, 'fix');
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

test('viewedAutoReset: false のとき POST /api/viewed/reconcile は間引きをスキップしてエントリを維持する', async () => {
  // Disable auto-reset via the settings API.
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewedAutoReset: false }),
  });

  // Seed the viewed map with entries that would normally be pruned.
  await fetch(`${baseUrl}/api/viewed`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewed: { 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h3' } }),
  });

  // Reconcile: b.ts changed, gone.ts absent — both should be kept when
  // viewedAutoReset is false.
  const rec = await fetch(`${baseUrl}/api/viewed/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: { 'a.ts': 'h1', 'b.ts': 'CHANGED', 'c.ts': 'h4' } }),
  });
  assert.equal(rec.status, 200);
  const recData = (await rec.json()) as { viewed: Record<string, string> };
  // All three original entries must survive (no pruning).
  assert.deepEqual(recData.viewed, { 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h3' });

  // The unpruned map is also persisted.
  const get = await fetch(`${baseUrl}/api/viewed`);
  const getData = (await get.json()) as { viewed: Record<string, string> };
  assert.deepEqual(getData.viewed, { 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h3' });

  // Restore default so subsequent tests are unaffected.
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewedAutoReset: true }),
  });
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

/* ---------- 手動修正 (POST /api/edit) ---------- */

function postEdit(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 1,
      startDiffLine: 1,
      endDiffLine: 1,
      ...payload,
    }),
  });
}

test('POST /api/edit は行範囲を書き換え、記録コメントを作り、review.html を再生成する', async () => {
  const target = path.join(tmp, 'edit-target.txt');
  fs.writeFileSync(target, 'line1\nline2\nline3\n');
  git(['add', 'edit-target.txt'], tmp);
  git(['commit', '-m', 'add edit-target'], tmp);
  fs.writeFileSync(target, 'line1\nline2 modified\nline3\n');

  const statusBefore = (await (await fetch(`${baseUrl}/api/status`)).json()) as {
    total: number;
    unresolved: number;
  };

  const res = await postEdit({
    file: 'edit-target.txt',
    startLine: 2,
    endLine: 2,
    expectedText: 'line2 modified',
    newText: 'line2 hand-fixed\nline2b added',
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    status: string;
    comment: { file: string; side: string; startLine: number; endLine: number; status: string; body: string; author?: string; manualEdit?: boolean };
  };
  assert.equal(data.status, 'applied');
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    'line1\nline2 hand-fixed\nline2b added\nline3\n'
  );
  // 記録コメント: 修正後の範囲にアンカーされ、user 作として open（wait-comments で配達可能）。
  assert.equal(data.comment.status, 'open');
  assert.equal(data.comment.side, 'new');
  assert.equal(data.comment.startLine, 2);
  assert.equal(data.comment.endLine, 3);
  assert.ok(data.comment.body.includes('手動修正'));
  assert.ok(data.comment.body.includes('返信は不要'));
  assert.ok(data.comment.body.includes('line2 hand-fixed'));
  assert.notEqual(data.comment.author, 'agent');
  // 通知専用の属性: UI 非表示・集計除外の対象マーカー。
  assert.equal(data.comment.manualEdit, true);
  // 再生成: review.html が書かれ、state.json に generatedAt が入る。
  const paths = reviewPaths(tmp);
  assert.ok(fs.existsSync(paths.html));
  const status = (await (await fetch(`${baseUrl}/api/status`)).json()) as {
    generatedAt: string | null;
    total: number;
    unresolved: number;
  };
  assert.ok(status.generatedAt);
  // 記録コメントは open だが、total / unresolved のどちらにも数えられない。
  assert.equal(status.total, statusBefore.total);
  assert.equal(status.unresolved, statusBefore.unresolved);
});

test('POST /api/edit は内容不一致（stale）なら 409 でファイルを変更しない', async () => {
  const target = path.join(tmp, 'edit-target.txt');
  const before = fs.readFileSync(target, 'utf8');
  const res = await postEdit({
    file: 'edit-target.txt',
    startLine: 1,
    endLine: 1,
    expectedText: 'そんな行はない',
    newText: 'x',
  });
  assert.equal(res.status, 409);
  const err = (await res.json()) as { error: string };
  assert.ok(err.error.includes('stale'));
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('POST /api/edit は範囲がファイル末尾を超えるときも 409（stale）になる', async () => {
  const res = await postEdit({
    file: 'edit-target.txt',
    startLine: 100,
    endLine: 200,
    expectedText: 'x',
    newText: 'y',
  });
  assert.equal(res.status, 409);
});

test('POST /api/edit はプロジェクト外・.agent-review 配下・symlink を拒否する', async () => {
  const outside = await postEdit({ file: '../outside.txt', expectedText: 'a', newText: 'b' });
  assert.equal(outside.status, 400);

  const reviewDir = await postEdit({
    file: '.agent-review/review.html',
    expectedText: 'a',
    newText: 'b',
  });
  assert.equal(reviewDir.status, 400);

  fs.symlinkSync(path.join(tmp, 'edit-target.txt'), path.join(tmp, 'edit-link.txt'));
  const link = await postEdit({ file: 'edit-link.txt', expectedText: 'line1', newText: 'x' });
  assert.equal(link.status, 400);
});

test('readOnlyMode 中の POST /api/edit は 403 でファイルを変更しない', async () => {
  const target = path.join(tmp, 'edit-target.txt');
  const before = fs.readFileSync(target, 'utf8');
  const set = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readOnlyMode: true }),
  });
  assert.equal(set.status, 200);
  try {
    const res = await postEdit({
      file: 'edit-target.txt',
      startLine: 1,
      endLine: 1,
      expectedText: 'line1',
      newText: 'x',
    });
    assert.equal(res.status, 403);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  } finally {
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readOnlyMode: false }),
    });
  }
});

test('POST /api/edit で空文字を保存すると行が削除される', async () => {
  const target = path.join(tmp, 'edit-target.txt');
  // 現在の内容: line1 / line2 hand-fixed / line2b added / line3
  const res = await postEdit({
    file: 'edit-target.txt',
    startLine: 3,
    endLine: 3,
    expectedText: 'line2b added',
    newText: '',
  });
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(target, 'utf8'), 'line1\nline2 hand-fixed\nline3\n');
  const data = (await res.json()) as { comment: { body: string } };
  assert.ok(data.comment.body.includes('削除'));
});

/* ---------- 手動修正（HTMLドキュメント: POST /api/documents/:id/edit） ---------- */

function postDocEdit(id: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/documents/${encodeURIComponent(id)}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function docRevision(id: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(id)}`);
  return ((await res.json()) as { document: { revision: number } }).document.revision;
}

test('POST /api/documents/:id/edit は本文を差し替え revision を上げ manualEdit コメントを記録する', async () => {
  const revision = await docRevision(documentId);
  const statusBefore = (await (await fetch(`${baseUrl}/api/status`)).json()) as {
    total: number;
    unresolved: number;
  };

  const newBody =
    '<html><head><title>Server Test Doc</title></head><body><h1>Heading edited</h1></body></html>';
  const res = await postDocEdit(documentId, {
    html: newBody,
    expectedRevision: revision,
    htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1 「Heading」' },
    newHtml: '<h1>Heading edited</h1>',
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    status: string;
    revision: number;
    comment: { documentId?: string | null; manualEdit?: boolean; status: string; body: string };
  };
  assert.equal(data.status, 'applied');
  assert.equal(data.revision, revision + 1);
  // 保存済み本文が差し替わり、配信もその内容になる。
  const served = await (await fetch(`${baseUrl}/doc/${documentId}/content`)).text();
  assert.ok(served.includes('<h1>Heading edited</h1>'));
  // 記録コメント: 文書に紐づく manualEdit 通知（open で wait-comments 配達対象）。
  assert.equal(data.comment.documentId, documentId);
  assert.equal(data.comment.manualEdit, true);
  assert.equal(data.comment.status, 'open');
  assert.ok(data.comment.body.includes('手動修正'));
  assert.ok(data.comment.body.includes('上書き'));
  assert.ok(data.comment.body.includes('返信は不要'));
  // 集計には数えられない。
  const statusAfter = (await (await fetch(`${baseUrl}/api/status`)).json()) as {
    total: number;
    unresolved: number;
  };
  assert.equal(statusAfter.total, statusBefore.total);
  assert.equal(statusAfter.unresolved, statusBefore.unresolved);
});

test('POST /api/documents/:id/edit は revision 不一致なら 409 で本文を変更しない', async () => {
  const revision = await docRevision(documentId);
  const before = await (await fetch(`${baseUrl}/doc/${documentId}/content`)).text();
  const res = await postDocEdit(documentId, {
    html: '<html><body><p>should not land</p></body></html>',
    expectedRevision: revision - 1,
  });
  assert.equal(res.status, 409);
  const err = (await res.json()) as { error: string };
  assert.ok(err.error.includes('stale'));
  assert.equal(await (await fetch(`${baseUrl}/doc/${documentId}/content`)).text(), before);
  assert.equal(await docRevision(documentId), revision);
});

test('POST /api/documents/:id/edit は未知の id なら 404、readOnlyMode 中なら 403 になる', async () => {
  const unknown = await postDocEdit('no-such-doc', { html: '<p>x</p>', expectedRevision: 1 });
  assert.equal(unknown.status, 404);

  const set = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readOnlyMode: true }),
  });
  assert.equal(set.status, 200);
  try {
    const revision = await docRevision(documentId);
    const res = await postDocEdit(documentId, { html: '<p>x</p>', expectedRevision: revision });
    assert.equal(res.status, 403);
  } finally {
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readOnlyMode: false }),
    });
  }
});
