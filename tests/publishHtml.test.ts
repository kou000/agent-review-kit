import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { publishHtml } from '../src/commands/publishHtml';

let tmp: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-publish-'));
  git(['init'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test User'], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), '# tmp repo\n');
  git(['add', 'README.md'], tmp);
  git(['commit', '-m', 'initial commit'], tmp);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Capture console.log output produced by a synchronous fn, always restoring
// the original console.log afterwards (even if fn throws).
function captureLog(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function writeHtmlFile(name: string, html: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, html);
  return file;
}

test('初回 publish で revision 1、<title> からタイトル抽出、本文はそのまま保存される', () => {
  const input = writeHtmlFile(
    'doc1.html',
    '<html><head><title>My Doc</title></head><body><script>alert(1)</script><p>hi</p></body></html>'
  );
  const lines = captureLog(() => {
    publishHtml({ input, documentId: 'doc-1', cwd: tmp });
  });
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]) as {
    status: string;
    documentId: string;
    title: string;
    revision: number;
    htmlFile: string;
  };
  assert.equal(result.status, 'published');
  assert.equal(result.documentId, 'doc-1');
  assert.equal(result.title, 'My Doc');
  assert.equal(result.revision, 1);
  assert.ok(fs.existsSync(result.htmlFile));
  // The body is stored verbatim (scripts are neutralized at display time by
  // the no-script CSP, not by rewriting the stored file).
  const saved = fs.readFileSync(result.htmlFile, 'utf8');
  assert.ok(saved.includes('<script>alert(1)</script>'));
  assert.ok(saved.includes('<p>hi</p>'));
});

test('同じ id で再 publish すると revision が上がり createdAt は維持される', () => {
  const input1 = writeHtmlFile(
    'doc2.html',
    '<html><head><title>Doc Two</title></head><body><p>v1</p></body></html>'
  );
  const first = JSON.parse(
    captureLog(() => publishHtml({ input: input1, documentId: 'doc-2', cwd: tmp }))[0]
  ) as { revision: number };
  assert.equal(first.revision, 1);

  const indexPath = path.join(tmp, '.agent-review', 'branches');
  const branchDirs = fs.readdirSync(indexPath);
  assert.equal(branchDirs.length, 1);
  const documentsIndexFile = path.join(
    indexPath,
    branchDirs[0],
    'documents',
    'index.json'
  );
  const indexBefore = JSON.parse(fs.readFileSync(documentsIndexFile, 'utf8')) as {
    documents: { id: string; createdAt: string }[];
  };
  const createdAtBefore = indexBefore.documents.find((d) => d.id === 'doc-2')?.createdAt;
  assert.ok(createdAtBefore);

  const input2 = writeHtmlFile(
    'doc2b.html',
    '<html><head><title>Doc Two v2</title></head><body><p>v2</p></body></html>'
  );
  const second = JSON.parse(
    captureLog(() => publishHtml({ input: input2, documentId: 'doc-2', cwd: tmp }))[0]
  ) as { revision: number };
  assert.equal(second.revision, 2);

  const indexAfter = JSON.parse(fs.readFileSync(documentsIndexFile, 'utf8')) as {
    documents: { id: string; createdAt: string }[];
  };
  const createdAtAfter = indexAfter.documents.find((d) => d.id === 'doc-2')?.createdAt;
  assert.equal(createdAtAfter, createdAtBefore);
});

test('--title 指定でタイトルが更新される', () => {
  const input = writeHtmlFile(
    'doc3.html',
    '<html><head><title>Original</title></head><body><p>x</p></body></html>'
  );
  const lines1 = captureLog(() =>
    publishHtml({ input, documentId: 'doc-3', cwd: tmp, title: 'Custom Title' })
  );
  const result1 = JSON.parse(lines1[0]) as { title: string; revision: number };
  assert.equal(result1.title, 'Custom Title');
  assert.equal(result1.revision, 1);

  const lines2 = captureLog(() =>
    publishHtml({ input, documentId: 'doc-3', cwd: tmp, title: 'Updated Title' })
  );
  const result2 = JSON.parse(lines2[0]) as { title: string; revision: number };
  assert.equal(result2.title, 'Updated Title');
  assert.equal(result2.revision, 2);
});

test('不正な document id は throw する', () => {
  const input = writeHtmlFile('doc4.html', '<p>x</p>');
  assert.throws(() => publishHtml({ input, documentId: '../x', cwd: tmp }));
  assert.throws(() => publishHtml({ input, documentId: '', cwd: tmp }));
});
