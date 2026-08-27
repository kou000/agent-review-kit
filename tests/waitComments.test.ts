import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { waitComments } from '../src/commands/waitComments';
import { reviewPaths } from '../src/paths';
import { loadComments, loadSettings, mutateSettings, saveComments } from '../src/store';
import { ReviewComment } from '../src/types';

// The developer's real ~/.agent-review/.env must not leak into the tests
// (reviewPaths resolves envFile from the home directory); point HOME at an
// empty temp dir so every test starts from the built-in defaults.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-home-'));

// waitComments はテストごとに SIGINT/SIGTERM ハンドラを登録する（本番では
// 1 プロセス 1 回なので問題ない）。テストが 10 回を超えると
// MaxListenersExceededWarning が出るため、このプロセスに限り上限を外す。
process.setMaxListeners(0);

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-wait-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), '# tmp repo\n');
  git(['add', 'README.md'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
  fs.mkdirSync(path.join(tmp, '.agent-review'), { recursive: true });
  return tmp;
}

function docComment(id: string, documentId: string): ReviewComment {
  const now = new Date().toISOString();
  return {
    id,
    file: null,
    side: null,
    startLine: null,
    endLine: null,
    startDiffLine: null,
    endDiffLine: null,
    body: `doc comment for ${documentId}`,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    documentId,
    htmlTarget: { kind: 'element', selector: 'h1', tag: 'h1', label: 'h1' },
  };
}

function diffComment(id: string): ReviewComment {
  const now = new Date().toISOString();
  return {
    id,
    file: 'a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    startDiffLine: 1,
    endDiffLine: 1,
    body: 'diff comment',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  return fn()
    .then(() => lines)
    .finally(() => {
      console.log = original;
    });
}

test('documentId 指定時はその文書のコメントだけ received で届き status が seen になる', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const c1 = docComment('c1', 'doc-a');
    const c2 = diffComment('c2');
    saveComments(paths.comments, [c1, c2]);

    const lines = await captureLog(() => waitComments({ timeout: 2, documentId: 'doc-a', cwd: tmp }));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].id, 'c1');

    const after = loadComments(paths.comments);
    const after1 = after.find((c) => c.id === 'c1');
    const after2 = after.find((c) => c.id === 'c2');
    assert.equal(after1?.status, 'seen');
    assert.equal(after2?.status, 'open');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('documentId 指定なしの場合は両方のコメントが届く', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const c1 = docComment('c3', 'doc-b');
    const c2 = diffComment('c4');
    saveComments(paths.comments, [c1, c2]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    const ids = result.comments.map((c) => c.id).sort();
    assert.deepEqual(ids, ['c3', 'c4']);

    const after = loadComments(paths.comments);
    assert.ok(after.every((c) => c.status === 'seen'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diffOnly 指定時は diff コメントだけ received で届き、doc コメントは open のまま', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const c1 = docComment('c6', 'doc-c');
    const c2 = diffComment('c7');
    saveComments(paths.comments, [c1, c2]);

    const lines = await captureLog(() => waitComments({ timeout: 2, diffOnly: true, cwd: tmp }));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].id, 'c7');

    const after = loadComments(paths.comments);
    const after1 = after.find((c) => c.id === 'c6');
    const after2 = after.find((c) => c.id === 'c7');
    assert.equal(after1?.status, 'open');
    assert.equal(after2?.status, 'seen');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('既定設定（deliveryNoteEnabled: false）ではテキストがあっても note が付かない', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    // 前提を明示: テキストは既定の委譲指示のまま非空
    assert.notEqual(loadSettings(paths.settings).deliveryNoteText, '');
    saveComments(paths.comments, [diffComment('n1')]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; note?: string };
    assert.equal(result.status, 'received');
    assert.equal(result.note, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deliveryNoteEnabled: true にすると received に委譲指示の note が同乗する', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    mutateSettings(paths.settings, (s) => {
      s.deliveryNoteEnabled = true;
    });
    saveComments(paths.comments, [diffComment('n2')]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; note?: string };
    assert.equal(result.status, 'received');
    assert.ok(result.note);
    assert.match(result.note!, /サブエージェントに委譲/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deliveryNoteText を書き換えると note がその内容になる', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    mutateSettings(paths.settings, (s) => {
      s.deliveryNoteEnabled = true;
      s.deliveryNoteText = '修正後は必ず npm test を実行すること';
    });
    saveComments(paths.comments, [diffComment('n3')]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; note?: string };
    assert.equal(result.status, 'received');
    assert.equal(result.note, '修正後は必ず npm test を実行すること');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readOnlyMode は note に影響しない（既定の委譲指示がそのまま届く）', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    mutateSettings(paths.settings, (s) => {
      s.readOnlyMode = true;
      s.deliveryNoteEnabled = true;
    });
    saveComments(paths.comments, [diffComment('n4')]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; note?: string };
    assert.equal(result.status, 'received');
    assert.match(result.note ?? '', /サブエージェントに委譲/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deliveryNoteText を空にすると enabled でも note が付かない', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    mutateSettings(paths.settings, (s) => {
      s.deliveryNoteEnabled = true;
      s.deliveryNoteText = '';
    });
    saveComments(paths.comments, [diffComment('n5')]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; note?: string };
    assert.equal(result.status, 'received');
    assert.equal(result.note, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('該当するコメントがなければ timeout する', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    // A comment exists, but for a different documentId than requested.
    saveComments(paths.comments, [docComment('c5', 'doc-other')]);

    const lines = await captureLog(() =>
      waitComments({ timeout: 1, documentId: 'doc-a', cwd: tmp })
    );
    const result = JSON.parse(lines[0]) as { status: string; comments: unknown[] };
    assert.equal(result.status, 'timeout');
    assert.equal(result.comments.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manualEdit コメント（手動修正の記録）も received で配達され seen になる', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const manual: ReviewComment = { ...diffComment('m1'), manualEdit: true, body: '【手動修正】…' };
    saveComments(paths.comments, [manual]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; comments: ReviewComment[] };
    assert.equal(result.status, 'received');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].id, 'm1');
    // 配達ペイロードにマーカーがそのまま乗る（エージェントは manualEdit で判別できる）。
    assert.equal(result.comments[0].manualEdit, true);

    const after = loadComments(paths.comments);
    assert.equal(after.find((c) => c.id === 'm1')?.status, 'seen');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('画像付きコメントは images を imagePaths（絶対パス）に差し替えて配達し、保存側は images のまま', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    const withImage: ReviewComment = { ...diffComment('i1'), images: ['img_abc123.png'] };
    saveComments(paths.comments, [withImage, diffComment('i2')]);

    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as {
      status: string;
      imagesNote?: string;
      comments: Array<ReviewComment & { imagePaths?: string[] }>;
    };
    assert.equal(result.status, 'received');
    // 画像があるバッチにだけ、参照方法の note が同梱される。
    assert.ok(result.imagesNote);

    const delivered = result.comments.find((c) => c.id === 'i1');
    assert.deepEqual(delivered?.imagePaths, [path.join(paths.imagesDir, 'img_abc123.png')]);
    assert.ok(path.isAbsolute(delivered!.imagePaths![0]));
    // エージェントのコンテキストに base64 を流さないため images は落とす。
    assert.ok(!('images' in delivered!));
    // 画像なしコメントには imagePaths を付けない。
    assert.ok(!('imagePaths' in result.comments.find((c) => c.id === 'i2')!));

    // 配達時の差し替えが comments.json に書き戻されないこと。
    const stored = loadComments(paths.comments).find((c) => c.id === 'i1');
    assert.deepEqual(stored?.images, ['img_abc123.png']);
    assert.ok(!('imagePaths' in stored!));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('画像なしバッチには imagesNote が乗らない', async () => {
  const tmp = makeTmpRepo();
  try {
    const paths = reviewPaths(tmp);
    saveComments(paths.comments, [diffComment('n1')]);
    const lines = await captureLog(() => waitComments({ timeout: 2, cwd: tmp }));
    const result = JSON.parse(lines[0]) as { status: string; imagesNote?: string };
    assert.equal(result.status, 'received');
    assert.ok(!('imagesNote' in result));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
