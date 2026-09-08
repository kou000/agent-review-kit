import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { generate } from './commands/generate';
import {
  embedNewSideFromTree,
  getCommitMeta,
  isGitRepo,
  MAX_GREP_QUERY_CHARS,
  parseUnifiedDiff,
  runGitCommitDiff,
  runGitCommitLog,
  runGitGrep,
  runGitLsFiles,
} from './gitDiff';
import {
  bakeDiffHighlight,
  highlightFences,
  highlightFile,
  highlightSnapshot,
} from './highlight';
import { documentHtmlPath, findDocument } from './htmlDocument';
import {
  COMMENT_IMAGE_ID_RE,
  MAX_IMAGE_BYTES,
  mimeForImageId,
  newCommentImageId,
  sniffImageExt,
} from './image';
import { ensureDir, ReviewPaths, reviewPaths } from './paths';
import {
  renderCommitHtml,
  renderDocumentHtml,
  renderFileHtml,
  renderRepoTreeHtml,
  renderSnapshotHtml,
  RepoFilePage,
} from './render';
import { findSnapshot, readSnapshotPatch, SNAPSHOT_ID_RE } from './snapshot';
import {
  loadComments,
  loadDocumentIndex,
  loadFinished,
  loadSettings,
  loadSnapshotIndex,
  loadState,
  loadViewed,
  mutateComments,
  mutateDocumentIndex,
  mutateSettings,
  mutateViewed,
  newCommentId,
  nowIso,
  reconcileViewed,
  saveFinished,
} from './store';
import {
  COMMENT_STATUSES,
  CommentCodeSnapshot,
  CommentFences,
  CommentIntent,
  CommentStatus,
  DiffData,
  HtmlTarget,
  ReviewComment,
  commentAuthor,
} from './types';

export const DEFAULT_PORT = 5179;

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Read a raw (binary) request body up to maxBytes. Returns null when the body
// exceeds the cap — the caller answers 413 and the connection is dropped so an
// oversized upload never buffers fully in memory.
function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

function serveFile(res: http.ServerResponse, file: string, type: string): void {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found. Run `agent-review-kit generate` first.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

export function buildStatus(paths: ReviewPaths): Record<string, unknown> {
  // Soft-deleted comments are invisible everywhere: counts, totals and the
  // unresolved badge all ignore them. Manual-edit records are notifications,
  // not review feedback, so they stay out of every count too.
  const comments = loadComments(paths.comments).filter((c) => !c.deleted && !c.manualEdit);
  const counts: Record<CommentStatus, number> = {
    open: 0,
    seen: 0,
    fixed: 0,
    answered: 0,
    wontfix: 0,
    resolved: 0,
    dismissed: 0,
  };
  for (const c of comments) counts[c.status] += 1;
  const state = loadState(paths.state);
  const finished = loadFinished(paths.finished);
  return {
    // どのプロジェクトを serve しているかをクライアント側が検証できるようにする
    // （複数プロジェクト同時レビュー時のポート取り違え検知用）。
    projectDir: path.dirname(paths.dir),
    branch: paths.branch,
    total: comments.length,
    // 未解決 = open + seen。unresolved はエージェント側の作業待ちを表す。
    // wontfix / dismissed は解決済みではないが、待っているのはユーザーの確認
    // （画面では「要確認」）でありエージェントの作業ではないので、ここには含めない。
    unresolved: counts.open + counts.seen,
    counts,
    base: state?.base ?? null,
    generatedAt: state?.generatedAt ?? null,
    settings: loadSettings(paths.settings, paths.envFile),
    finished: finished?.finishedAt ?? null,
    snapshots: loadSnapshotIndex(paths.snapshotsIndex).snapshots.length,
    documents: loadDocumentIndex(paths.documentsIndex).documents.length,
  };
}

// Cap on every free-text field inside an htmlTarget, so a crafted request
// can't balloon comments.json. Real selectors/snippets are far below this.
const MAX_TARGET_FIELD = 2000;

// Cap on the text fields of a manual edit (POST /api/edit). Matches the order
// of MAX_EMBED_BYTES in generate: anything bigger has no business going
// through a browser textarea.
const MAX_EDIT_TEXT = 1024 * 1024;

// How much of the hand-edited code is quoted inside the auto-recorded
// 【手動修正】comment before it is truncated.
const MAX_EDIT_QUOTE = 3000;

// Cap on a manually edited document body (POST /api/documents/:id/edit),
// matching publish-html's MAX_HTML_BYTES.
const MAX_DOC_EDIT_BYTES = 5 * 1024 * 1024;

// Appended to every auto-recorded 【手動修正】 comment body. The comment is a
// notification, not user feedback, and it never renders in the browser — so
// the body itself must tell the agent that a reply is pointless (skill-file
// instructions decay with context distance; text riding with the comment
// does not).
const MANUAL_EDIT_NOTE =
  'このコメントは自動記録の通知でブラウザには表示されないため、返信は不要（内容を確認したら resolve のみ行うこと）。';

function targetStr(v: unknown, required: boolean): string | null | 'bad' {
  if (v === undefined || v === null) return required ? 'bad' : null;
  if (typeof v !== 'string' || (required && !v)) return 'bad';
  return v.slice(0, MAX_TARGET_FIELD);
}

// Bounds on a viewed-state map (PUT /api/viewed, POST /api/viewed/reconcile),
// so a crafted request can't balloon viewed.json. Real diffs are far below
// these; keys are file paths, values are short djb2 hashes.
const MAX_VIEWED_ENTRIES = 5000;
const MAX_VIEWED_KEY = 2000;
const MAX_VIEWED_VALUE = 128;

// Coerce an untrusted value into a { [filePath]: hash } string map, or return
// null if it is the wrong shape / over the bounds. undefined/null map to {}.
function sanitizeHashMap(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== 'string') return null;
    if (key.length > MAX_VIEWED_KEY || value.length > MAX_VIEWED_VALUE) return null;
    if (++n > MAX_VIEWED_ENTRIES) return null;
    out[key] = value;
  }
  return out;
}

// Validate the browser-supplied anchor of an HTML-review comment. Returns the
// normalized target, null for an explicit "whole document" comment, or an
// error string.
function validateHtmlTarget(v: unknown): HtmlTarget | null | string {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return 'htmlTarget must be an object';
  const b = v as Record<string, unknown>;
  if (b.kind !== 'element' && b.kind !== 'text') {
    return 'htmlTarget.kind must be "element" or "text"';
  }
  const selector = targetStr(b.selector, true);
  const tag = targetStr(b.tag, true);
  const label = targetStr(b.label, true);
  if (selector === 'bad' || tag === 'bad' || label === 'bad' || !selector || !tag || !label) {
    return 'htmlTarget.selector/tag/label are required strings';
  }
  const target: HtmlTarget = { kind: b.kind, selector, tag, label };
  const optional = ['elementText', 'selectedText', 'contextBefore', 'contextAfter'] as const;
  for (const key of optional) {
    const s = targetStr(b[key], false);
    if (s === 'bad') return `htmlTarget.${key} must be a string`;
    if (s !== null) target[key] = s;
  }
  if (target.kind === 'text' && !target.selectedText) {
    return 'htmlTarget.selectedText is required for kind "text"';
  }
  return target;
}

interface CommentInput {
  file: string | null;
  side: 'old' | 'new' | null;
  startLine: number | null;
  endLine: number | null;
  startDiffLine: number | null;
  endDiffLine: number | null;
  body: string;
}

function validateCommentInput(b: Record<string, unknown>): CommentInput | string {
  if (typeof b.body !== 'string' || !b.body.trim()) return 'body is required';
  const body = b.body.trim();

  // Overall comment: no file (undefined or null) means the comment is not tied
  // to any file or line. Only a non-empty body is required.
  if (b.file === undefined || b.file === null) {
    return {
      file: null,
      side: null,
      startLine: null,
      endLine: null,
      startDiffLine: null,
      endDiffLine: null,
      body,
    };
  }

  if (typeof b.file !== 'string' || !b.file) return 'file is required';

  // File-level comment: a file with no position at all — the anchor is the
  // whole file, so it renders under the file header instead of inside the
  // diff table. `side` is what tells the two apart: send a side and the full
  // line anchor is required, exactly as before.
  const anchorKeys = ['side', 'startLine', 'endLine', 'startDiffLine', 'endDiffLine'] as const;
  if (anchorKeys.every((k) => b[k] === undefined || b[k] === null)) {
    return {
      file: b.file,
      side: null,
      startLine: null,
      endLine: null,
      startDiffLine: null,
      endDiffLine: null,
      body,
    };
  }

  if (b.side !== 'old' && b.side !== 'new') return 'side must be "old" or "new"';
  const nums = ['startLine', 'endLine', 'startDiffLine', 'endDiffLine'] as const;
  for (const k of nums) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k] as number)) {
      return `${k} must be a number`;
    }
  }
  return {
    file: b.file,
    side: b.side,
    startLine: b.startLine as number,
    endLine: b.endLine as number,
    startDiffLine: b.startDiffLine as number,
    endDiffLine: b.endDiffLine as number,
    body,
  };
}

// Cap on attached images per comment. Screenshots of one finding are a
// handful at most; the cap only stops a crafted request from ballooning
// comments.json with references.
const MAX_COMMENT_IMAGES = 8;

/**
 * Validate the optional `images` of a comment post: an array of previously
 * uploaded image ids (POST /api/images). Every id must match the strict id
 * shape AND exist on disk, so a comment can never reference a path outside
 * imagesDir or an image that was never uploaded. Returns a spreadable
 * fragment — `{}` when absent/empty — or an error message.
 */
function validateImages(v: unknown, imagesDir: string): { images?: string[] } | string {
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v)) return 'images must be an array of image ids';
  if (v.length > MAX_COMMENT_IMAGES) return `too many images (max ${MAX_COMMENT_IMAGES})`;
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== 'string' || !COMMENT_IMAGE_ID_RE.test(id)) {
      return `invalid image id: ${String(id)}`;
    }
    if (!fs.existsSync(path.join(imagesDir, id))) return `image not found: ${id}`;
    out.push(id);
  }
  return out.length ? { images: out } : {};
}

// Caps on a stored code snapshot (see CommentCodeSnapshot). A drag over a
// whole hunk is well under these; the caps only stop a crafted request from
// ballooning comments.json.
const MAX_CODE_LINES = 400;
const MAX_CODE_LINE = 2000;

function codeLines(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const line of v) {
    if (typeof line !== 'string' || line.length > MAX_CODE_LINE) return null;
    out.push(line);
  }
  return out;
}

/**
 * Validate the optional `code` of a diff comment post (see
 * CommentCodeSnapshot). Returns a spreadable fragment — `{}` when the field is
 * absent, malformed, or over the caps. Deliberately never an error: the
 * snapshot is a reading aid, and losing the user's comment over it would be a
 * far worse outcome than saving the comment without one.
 */
function validateCode(v: unknown): { code?: CommentCodeSnapshot } {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const b = v as Record<string, unknown>;
  const before = codeLines(b.before);
  const lines = codeLines(b.lines);
  const after = codeLines(b.after);
  if (!before || !lines || !after || lines.length === 0) return {};
  if (before.length + lines.length + after.length > MAX_CODE_LINES) return {};
  return { code: { before, lines, after } };
}

/**
 * Validate the optional `intent` of a comment post (see CommentIntent).
 * Returns a spreadable fragment — `{}` when the field is absent — or an error
 * message. Every comment shape (diff, reply, document) accepts it.
 */
function validateIntent(v: unknown): { intent?: CommentIntent } | string {
  if (v === undefined || v === null) return {};
  if (v !== 'fix' && v !== 'question') return 'intent must be "fix" or "question"';
  return { intent: v };
}

/**
 * Server-side highlighting for the ``` fences of a comment body about to be
 * stored (see highlightFences). Returns a spreadable fragment — `{}` when the
 * body has no highlightable fence, so the field stays off the stored comment.
 * Computed before the comments lock is taken: highlighting is async and the
 * store API is synchronous.
 */
async function fenceFragment(body: string): Promise<{ fences?: CommentFences }> {
  const fences = await highlightFences(body);
  return fences ? { fences } : {};
}

// Cap on a repo-file viewer payload (GET /api/file, GET /file/<path>),
// matching generate's newLines embed cap.
const MAX_FILE_VIEW_BYTES = 1024 * 1024;

// Read one repository file (tracked or untracked-but-not-ignored, matching
// the diff's boundary) for the repo-file viewer. Only files listed by
// runGitLsFiles are served — the list is both the path validation (no
// traversal, no .agent-review internals) and a guard against exposing
// ignored secrets (.env etc.). Returns the /api/file payload shape shared
// with the standalone /file/<path> page, or null for anything not servable.
async function readRepoFile(projectDir: string, relPath: string): Promise<RepoFilePage | null> {
  if (!relPath) return null;
  try {
    if (!runGitLsFiles(projectDir).includes(relPath)) return null;
  } catch {
    return null; // not a git repo
  }
  const abs = path.join(projectDir, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return null;
  }
  // Symlinks are rejected too: following one could read outside the project.
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_VIEW_BYTES) return { path: relPath, tooLarge: true };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { path: relPath, binary: true };
  const lines = buf.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { path: relPath, lines, html: await highlightFile(relPath, lines) };
}

export interface ServerHooks {
  // Called after POST /api/finish has been fully processed and answered.
  // serve() uses this to shut the process down gracefully.
  onFinish?: () => void;
}

export function createServer(paths: ReviewPaths, hooks: ServerHooks = {}): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, paths, hooks).catch((e: unknown) => {
      json(res, 500, { error: String(e) });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  basePaths: ReviewPaths,
  hooks: ServerHooks = {}
): Promise<void> {
  // Review data is branch-scoped and the branch can change under a running
  // server (checkout + regenerate), so resolve the paths per request instead
  // of trusting the ones captured at serve startup.
  const paths = reviewPaths(path.dirname(basePaths.dir));
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (p === '/' || p === '/review.html' || p === '/index.html')) {
    serveFile(res, paths.html, 'text/html; charset=utf-8');
    return;
  }
  // Client ES modules (app.js plus everything it imports), copied into
  // .agent-review/client/ by writeAssets. The pathname is matched before any
  // decoding, so the whitelist regex (no '%', no '\\') plus the per-segment
  // check make traversal outside clientDir impossible.
  const clientMatch = /^\/client\/([A-Za-z0-9._/-]+\.js)$/.exec(p);
  if (method === 'GET' && clientMatch) {
    const rel = clientMatch[1];
    const segments = rel.split('/');
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    serveFile(res, path.join(paths.clientDir, ...segments), 'text/javascript; charset=utf-8');
    return;
  }
  if (method === 'GET' && p === '/style.css') {
    serveFile(res, paths.styleCss, 'text/css; charset=utf-8');
    return;
  }

  // Standalone diff page for a single commit, opened from a commit link in an
  // agent response. The project git root is the parent of the .agent-review dir.
  const commitMatch = /^\/commit\/([0-9a-f]{4,40})$/.exec(p);
  if (method === 'GET' && commitMatch) {
    const sha = commitMatch[1];
    const projectDir = path.dirname(paths.dir);
    try {
      const meta = getCommitMeta(sha, projectDir);
      const files = parseUnifiedDiff(runGitCommitDiff(sha, projectDir));
      // New-side content comes from the commit itself, enabling GitHub-style
      // context expansion around hunks on this page too.
      embedNewSideFromTree(files, sha, projectDir);
      // Bake syntax highlighting like the main review page (generate) does, so
      // the standalone commit diff isn't rendered as plain uncolored text.
      await bakeDiffHighlight(files);
      const data: DiffData = { base: `${meta.shortSha}^`, generatedAt: meta.date, files };
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(renderCommitHtml(data, meta));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`commit not found: ${sha}`);
    }
    return;
  }

  // Standalone diff page for one fix snapshot, opened from a snapshot link in
  // an agent response. Same shape as the commit page, but the diff comes from
  // the stored patch file instead of the object database.
  const snapshotMatch = /^\/snapshot\/([^/]+)$/.exec(p);
  if (method === 'GET' && snapshotMatch) {
    const id = decodeURIComponent(snapshotMatch[1]);
    if (!SNAPSHOT_ID_RE.test(id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`invalid snapshot id: ${id}`);
      return;
    }
    const meta = findSnapshot(paths, id);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`snapshot not found: ${id}`);
      return;
    }
    try {
      const files = parseUnifiedDiff(readSnapshotPatch(paths, meta));
      // Snapshots record the post-fix tree at create time; reading new-side
      // content from it enables context expansion. Older snapshots (no tree)
      // simply render without expanders.
      if (meta.tree) embedNewSideFromTree(files, meta.tree, path.dirname(paths.dir));
      // Bake syntax highlighting like the main review page (generate) does, so
      // the fix-snapshot diff isn't rendered as plain uncolored text.
      await bakeDiffHighlight(files);
      const data: DiffData = { base: null, generatedAt: meta.createdAt, files };
      const comment = loadComments(paths.comments).find((c) => c.id === meta.commentId);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(renderSnapshotHtml(data, { ...meta, commentBody: comment?.body ?? null }));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`snapshot patch not readable: ${id}`);
    }
    return;
  }

  // Standalone two-pane page for browsing every repository file (tracked and
  // untracked, ignored files excluded), opened from the sidebar's
  //「リポジトリのファイル」heading. The file list
  // is fetched client-side (/api/repo-files) and the page never auto-reloads,
  // so tree state survives the agent regenerating the diff.
  if (method === 'GET' && p === '/files') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(renderRepoTreeHtml());
    return;
  }

  // Standalone read-only page for one repository file, opened from a
  // repo-file pin panel's「新しいタブで開く」. Same guard as /api/file: only
  // regular files listed by runGitLsFiles (tracked + untracked, ignored
  // excluded) are served.
  const fileMatch = /^\/file\/(.+)$/.exec(p);
  if (method === 'GET' && fileMatch) {
    const rel = decodeURIComponent(fileMatch[1]);
    const info = await readRepoFile(path.dirname(paths.dir), rel);
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`file not found (not a repository file): ${rel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(renderFileHtml(info));
    return;
  }

  // Review page for one published HTML document. The page shell only carries
  // the document meta; the body is loaded into an iframe from .../content.
  const docPageMatch = /^\/doc\/([^/]+)$/.exec(p);
  if (method === 'GET' && docPageMatch) {
    const id = decodeURIComponent(docPageMatch[1]);
    const meta = findDocument(paths, id);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`document not found: ${id}. Run \`agent-review-kit publish-html\` first.`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(renderDocumentHtml(meta));
    return;
  }

  // The rendered document body, served for the review page's iframe. The CSP
  // is the sole no-script guarantee (the body is stored verbatim): nothing in
  // default-src allows scripts, external fetches, form posts or <base> tricks.
  // Inline styles and data: images stay usable so agent-generated documents
  // render as intended.
  const docContentMatch = /^\/doc\/([^/]+)\/content$/.exec(p);
  if (method === 'GET' && docContentMatch) {
    const id = decodeURIComponent(docContentMatch[1]);
    const meta = findDocument(paths, id);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`document not found: ${id}`);
      return;
    }
    fs.readFile(documentHtmlPath(paths, meta.id), (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`document body not found: ${id}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
    return;
  }

  if (method === 'GET' && p === '/api/documents') {
    json(res, 200, { documents: loadDocumentIndex(paths.documentsIndex).documents });
    return;
  }

  // Meta of one document. The review page polls this to detect a re-publish
  // (revision bump) and reload, the same way the diff page watches generatedAt.
  const docApiMatch = /^\/api\/documents\/([^/]+)$/.exec(p);
  if (method === 'GET' && docApiMatch) {
    const id = decodeURIComponent(docApiMatch[1]);
    const meta = findDocument(paths, id);
    if (!meta) {
      json(res, 404, { error: `document not found: ${id}` });
      return;
    }
    json(res, 200, { document: meta });
    return;
  }

  // Manual edit of a published HTML document — the document analog of
  // POST /api/edit. The browser rewrites one element in a detached parse of
  // the pristine stored body (the live iframe DOM carries synthetic comment
  // marks and must never be serialized) and sends the whole re-serialized
  // document here. `expectedRevision` is the revision that parse was based
  // on; a mismatch (re-published or edited meanwhile) is refused as stale.
  // Records a manualEdit comment so the agent learns the stored document
  // changed — and that a re-publish would overwrite the hand edit.
  const docEditMatch = /^\/api\/documents\/([^/]+)\/edit$/.exec(p);
  if (method === 'POST' && docEditMatch) {
    const id = decodeURIComponent(docEditMatch[1]);
    if (loadSettings(paths.settings, paths.envFile).readOnlyMode) {
      json(res, 403, { error: '読み取り専用モードのため手動修正はできません' });
      return;
    }
    if (loadFinished(paths.finished)) {
      json(res, 409, { error: 'review is already finished' });
      return;
    }
    const meta = findDocument(paths, id);
    if (!meta) {
      json(res, 404, { error: `document not found: ${id}` });
      return;
    }
    const body = await readBody(req);
    if (typeof body.html !== 'string' || !body.html.trim()) {
      json(res, 400, { error: 'html is required' });
      return;
    }
    if (Buffer.byteLength(body.html, 'utf8') > MAX_DOC_EDIT_BYTES) {
      json(res, 400, { error: `html too large (max ${MAX_DOC_EDIT_BYTES} bytes)` });
      return;
    }
    if (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision)) {
      json(res, 400, { error: 'expectedRevision must be an integer' });
      return;
    }
    const expectedRevision = body.expectedRevision;
    const target = validateHtmlTarget(body.htmlTarget);
    if (typeof target === 'string') {
      json(res, 400, { error: target });
      return;
    }
    // The edited element's HTML as the user typed it, quoted in the record
    // comment (the full document would be far too much). Empty = 要素を削除.
    const newHtml = typeof body.newHtml === 'string' ? body.newHtml.trim() : '';

    // Revision check, body write and bump all under the documents lock, so a
    // concurrent publish/edit can never leave the revision pointing at the
    // wrong content or silently lose a bump.
    const result = mutateDocumentIndex(paths.documentsIndex, (index) => {
      const doc = index.documents.find((d) => d.id === id);
      if (!doc) return { kind: 'missing' } as const;
      if (doc.revision !== expectedRevision) return { kind: 'stale' } as const;
      // Body first, revision second (publish-html's order): a bumped revision
      // must always point at the new content.
      fs.writeFileSync(documentHtmlPath(paths, id), body.html as string);
      doc.revision += 1;
      doc.updatedAt = nowIso();
      return { kind: 'updated', revision: doc.revision } as const;
    });
    if (result.kind === 'missing') {
      json(res, 404, { error: `document not found: ${id}` });
      return;
    }
    if (result.kind === 'stale') {
      json(res, 409, {
        error: 'stale: 文書が更新されています。ページを再読み込みしてください。',
      });
      return;
    }

    const quoted =
      newHtml.length > MAX_EDIT_QUOTE ? `${newHtml.slice(0, MAX_EDIT_QUOTE)}\n…（省略）` : newHtml;
    const where = target ? target.label : '文書全体';
    const docPath = path.relative(path.dirname(paths.dir), documentHtmlPath(paths, id));
    const commentBody =
      `【手動修正】ユーザーがブラウザ上で文書「${meta.title}」の ${where} を直接編集しました` +
      `（保存済み・対応不要）。この文書を publish-html で再公開すると手動編集が上書きされるため、` +
      `以後この文書を更新する場合は保存済みの現在の内容（${docPath}）を基にすること。` +
      MANUAL_EDIT_NOTE +
      (newHtml ? `\n修正後のHTML:\n\`\`\`\n${quoted}\n\`\`\`` : '\n（対象要素を削除）');
    // The quote fence itself has no info string, but quoted text containing
    // its own ```lang blocks splits into further fences the client will
    // render, so this body goes through the same highlighting as any other.
    const fences = await fenceFragment(commentBody);
    const now = nowIso();
    const comment: ReviewComment = {
      id: newCommentId(),
      file: null,
      side: null,
      startLine: null,
      endLine: null,
      startDiffLine: null,
      endDiffLine: null,
      body: commentBody,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      ...fences,
      documentId: id,
      htmlTarget: target,
      manualEdit: true,
    };
    mutateComments(paths.comments, (comments) => {
      // A finish that raced the write above: skip the record comment so no
      // undeliverable open comment is left behind (the edit itself stands).
      if (!loadFinished(paths.finished)) comments.push(comment);
    });
    json(res, 200, { status: 'applied', revision: result.revision, comment });
    return;
  }

  if (method === 'GET' && p === '/api/comments') {
    json(res, 200, { comments: loadComments(paths.comments) });
    return;
  }

  if (method === 'GET' && p === '/api/status') {
    json(res, 200, buildStatus(paths));
    return;
  }

  if (method === 'GET' && p === '/api/settings') {
    json(res, 200, { settings: loadSettings(paths.settings, paths.envFile) });
    return;
  }

  // Partial update: only known keys with the right type are applied, anything
  // else in the body is ignored. Returns the full settings after the merge.
  // editorUriTemplate is intentionally missing: it is a machine-local path
  // translation set in ~/.agent-review/.env only, and its value ends up in an
  // href, so the browser must not be able to change it.
  if (method === 'PUT' && p === '/api/settings') {
    const body = await readBody(req);
    const settings = mutateSettings(paths.settings, (s) => {
      if (typeof body.snapshotsEnabled === 'boolean') s.snapshotsEnabled = body.snapshotsEnabled;
      if (typeof body.readOnlyMode === 'boolean') s.readOnlyMode = body.readOnlyMode;
      if (typeof body.viewedAutoReset === 'boolean') s.viewedAutoReset = body.viewedAutoReset;
      if (typeof body.deliveryNoteEnabled === 'boolean')
        s.deliveryNoteEnabled = body.deliveryNoteEnabled;
      if (typeof body.deliveryNoteText === 'string')
        s.deliveryNoteText = body.deliveryNoteText.slice(0, MAX_TARGET_FIELD);
    }, paths.envFile);
    json(res, 200, { settings });
    return;
  }

  // "確認済み" (Viewed) state, persisted server-side so marks survive a serve
  // restart (the port changes, which used to strand browser-localStorage marks).
  if (method === 'GET' && p === '/api/viewed') {
    json(res, 200, { viewed: loadViewed(paths.viewed) });
    return;
  }

  // Full replace of the viewed map. Used by a viewed toggle (the client keeps
  // the whole map and re-sends it) and by the one-time localStorage migration.
  if (method === 'PUT' && p === '/api/viewed') {
    const body = await readBody(req);
    const map = sanitizeHashMap(body.viewed);
    if (map === null) {
      json(res, 400, { error: 'viewed must be an object of string hashes' });
      return;
    }
    const viewed = mutateViewed(paths.viewed, () => map);
    json(res, 200, { viewed });
    return;
  }

  // Reconcile the stored viewed map against the current diff's per-file content
  // hashes: entries whose hash no longer matches (the file's diff changed) or
  // whose file is gone are dropped, and the pruned map is persisted. This is
  // the "auto-revert on diff change" rule, moved off the browser.
  if (method === 'POST' && p === '/api/viewed/reconcile') {
    const body = await readBody(req);
    const hashes = sanitizeHashMap(body.hashes);
    if (hashes === null) {
      json(res, 400, { error: 'hashes must be an object of string hashes' });
      return;
    }
    // When viewedAutoReset is disabled, skip pruning and return the stored map
    // as-is so marks survive diff changes until the user clears them manually.
    const { viewedAutoReset } = loadSettings(paths.settings, paths.envFile);
    const viewed = mutateViewed(paths.viewed, (saved) =>
      viewedAutoReset ? reconcileViewed(saved, hashes) : saved
    );
    json(res, 200, { viewed });
    return;
  }

  // Every repository file (tracked + untracked, ignored excluded), for the
  // sidebar's repo-file tree (support feature: view unchanged files next to
  // the diff).
  if (method === 'GET' && p === '/api/repo-files') {
    try {
      json(res, 200, { files: runGitLsFiles(path.dirname(paths.dir)) });
    } catch {
      json(res, 200, { files: [] }); // not a git repo
    }
    return;
  }

  // Content of one repository file (repo-file viewer pin panel). Highlighted
  // per request with the same Shiki setup as generate.
  if (method === 'GET' && p === '/api/file') {
    const rel = url.searchParams.get('path') ?? '';
    const info = await readRepoFile(path.dirname(paths.dir), rel);
    if (!info) {
      json(res, 404, { error: `file not found (not a repository file): ${rel}` });
      return;
    }
    json(res, 200, { file: info });
    return;
  }

  // Full-text search for the /files page's search box. `git grep` is the
  // whole implementation: tracked files only (deliberately narrower than the
  // tree/viewer, which also cover untracked files — see runGitGrep) and
  // binaries excluded. Literal search by default; regex=1 / case=1 switch the
  // two flags.
  if (method === 'GET' && p === '/api/grep') {
    const q = url.searchParams.get('q') ?? '';
    if (!q) {
      json(res, 400, { error: 'q is required' });
      return;
    }
    if (q.length > MAX_GREP_QUERY_CHARS) {
      json(res, 400, { error: `q is too long (max ${MAX_GREP_QUERY_CHARS} chars)` });
      return;
    }
    const projectDir = path.dirname(paths.dir);
    try {
      json(
        res,
        200,
        runGitGrep(
          q,
          {
            regex: url.searchParams.get('regex') === '1',
            caseSensitive: url.searchParams.get('case') === '1',
          },
          projectDir
        )
      );
    } catch (e) {
      // git リポジトリでなければ /api/repo-files と同じく空結果。リポジトリな
      // のに失敗したのは検索式の問題（不正な正規表現など）なので 400。
      if (!isGitRepo(projectDir)) {
        json(res, 200, { results: [], truncated: false });
        return;
      }
      json(res, 400, { error: `検索できませんでした: ${e instanceof Error ? e.message : String(e)}` });
    }
    return;
  }

  // Commits under review (base..HEAD, newest first). With no base the review
  // is working-tree-vs-HEAD only, so there is nothing to list.
  if (method === 'GET' && p === '/api/commits') {
    const state = loadState(paths.state);
    const base = state?.base ?? null;
    const projectDir = path.dirname(paths.dir);
    json(res, 200, { commits: base ? runGitCommitLog(base, projectDir) : [] });
    return;
  }

  // Manual edit from the browser: replace the new-side lines
  // startLine..endLine of `file` with `newText` in the working tree, record
  // the edit as a manualEdit comment (hidden from the UI, but delivered by
  // wait-comments — the agent's picture of the file is stale after a hand
  // edit), then regenerate the review so every open page reloads onto the
  // fresh diff. `expectedText` is what the browser was displaying for the
  // range; the edit is refused as stale when the file on disk no longer
  // matches it (e.g. the agent changed the file after the last generate).
  if (method === 'POST' && p === '/api/edit') {
    if (loadSettings(paths.settings, paths.envFile).readOnlyMode) {
      json(res, 403, { error: '読み取り専用モードのため手動修正はできません' });
      return;
    }
    if (loadFinished(paths.finished)) {
      json(res, 409, { error: 'review is already finished' });
      return;
    }
    const body = await readBody(req);
    if (typeof body.file !== 'string' || !body.file) {
      json(res, 400, { error: 'file is required' });
      return;
    }
    for (const k of ['startLine', 'endLine', 'startDiffLine', 'endDiffLine'] as const) {
      if (typeof body[k] !== 'number' || !Number.isInteger(body[k] as number)) {
        json(res, 400, { error: `${k} must be an integer` });
        return;
      }
    }
    const startLine = body.startLine as number;
    const endLine = body.endLine as number;
    if (startLine < 1 || endLine < startLine) {
      json(res, 400, { error: 'invalid line range' });
      return;
    }
    if (typeof body.expectedText !== 'string' || typeof body.newText !== 'string') {
      json(res, 400, { error: 'expectedText and newText must be strings' });
      return;
    }
    if (body.expectedText.length > MAX_EDIT_TEXT || body.newText.length > MAX_EDIT_TEXT) {
      json(res, 400, { error: 'text too large' });
      return;
    }

    // The target must resolve inside the project and outside .agent-review.
    // Symlinks are rejected so a write can never follow a link out of the tree.
    const projectDir = path.dirname(paths.dir);
    const abs = path.resolve(projectDir, body.file);
    const rel = path.relative(projectDir, abs);
    if (
      !rel ||
      rel.startsWith('..') ||
      path.isAbsolute(rel) ||
      abs === paths.dir ||
      abs.startsWith(paths.dir + path.sep)
    ) {
      json(res, 400, { error: `file is outside the project: ${body.file}` });
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      json(res, 404, { error: `file not found: ${body.file}` });
      return;
    }
    if (!stat.isFile()) {
      json(res, 400, { error: `not a regular file: ${body.file}` });
      return;
    }

    // Split by either EOL so a CRLF file compares cleanly against the
    // browser-side text (which strips \r); the dominant EOL and the presence
    // of a trailing newline are preserved on write.
    const raw = fs.readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingNewline = raw.endsWith('\n');
    const lines = raw === '' ? [] : raw.split(/\r\n|\n/);
    if (hadTrailingNewline) lines.pop();
    const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
    if (
      endLine > lines.length ||
      lines.slice(startLine - 1, endLine).join('\n') !== normalize(body.expectedText)
    ) {
      json(res, 409, {
        error: 'stale: ファイルの内容が表示中の差分と一致しません。ページを再読み込みしてください。',
      });
      return;
    }

    // An emptied textarea deletes the range. concat instead of splice(...):
    // a spread of one array element per line would hit the argument limit on
    // large pastes.
    const replacement = body.newText === '' ? [] : normalize(body.newText).split('\n');
    const merged = lines.slice(0, startLine - 1).concat(replacement, lines.slice(endLine));
    const out = merged.join(eol);
    fs.writeFileSync(abs, out && hadTrailingNewline ? out + eol : out);

    // Anchor the record comment to the post-edit range (the regenerated diff
    // is what the comment will render against).
    const quoted =
      body.newText.length > MAX_EDIT_QUOTE
        ? `${body.newText.slice(0, MAX_EDIT_QUOTE)}\n…（省略）`
        : body.newText;
    const commentBody =
      replacement.length === 0
        ? `【手動修正】ユーザーがブラウザ上で L${startLine}-L${endLine} を削除しました（ファイルに適用済み・コード対応は不要）。${MANUAL_EDIT_NOTE}`
        : `【手動修正】ユーザーがブラウザ上でこの範囲を直接修正しました（ファイルに適用済み・コード対応は不要）。${MANUAL_EDIT_NOTE}\n修正後の内容:\n\`\`\`\n${quoted}\n\`\`\``;
    // Same policy as the document-edit record comment: the quote fence is
    // plain, but quoted text can carry ```lang blocks of its own.
    const fences = await fenceFragment(commentBody);
    const now = nowIso();
    const comment: ReviewComment = {
      id: newCommentId(),
      file: body.file,
      side: 'new',
      startLine,
      endLine: replacement.length ? startLine + replacement.length - 1 : startLine,
      startDiffLine: body.startDiffLine as number,
      endDiffLine: body.endDiffLine as number,
      body: commentBody,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      ...fences,
      manualEdit: true,
    };
    mutateComments(paths.comments, (comments) => {
      // A finish that raced the file write above: skip the record comment so
      // no undeliverable open comment is left behind (the edit itself stands).
      if (!loadFinished(paths.finished)) comments.push(comment);
    });

    try {
      await generate({ cwd: projectDir, preserveFinished: true, quiet: true });
    } catch (e) {
      json(res, 500, { error: `編集は適用されましたが差分の再生成に失敗しました: ${String(e)}` });
      return;
    }
    json(res, 200, { status: 'applied', comment });
    return;
  }

  // Upload one comment-attachment image (the raw image bytes are the request
  // body). The magic bytes decide the stored format — the Content-Type header
  // is ignored — and the returned id is what the comment form later posts in
  // its `images` array. Files are stored per branch next to comments.json and
  // are deliberately kept on delete (comments are soft-deleted too).
  if (method === 'POST' && p === '/api/images') {
    if (loadFinished(paths.finished)) {
      json(res, 409, { error: 'review is already finished' });
      return;
    }
    const buf = await readRawBody(req, MAX_IMAGE_BYTES);
    if (buf === null) {
      json(res, 413, { error: `image too large (max ${MAX_IMAGE_BYTES} bytes)` });
      return;
    }
    const ext = sniffImageExt(buf);
    if (!ext) {
      json(res, 400, { error: 'unsupported image format (png/jpeg/gif/webp only)' });
      return;
    }
    ensureDir(paths.imagesDir);
    const id = newCommentImageId(ext);
    fs.writeFileSync(path.join(paths.imagesDir, id), buf);
    json(res, 201, { id });
    return;
  }

  // Serve one stored comment image. The id pattern is the whole path
  // validation (no separators can match), and ids are immutable — a given id
  // never changes content — so the response is cacheable, unlike everything
  // else this server serves.
  const imageMatch = /^\/api\/images\/([A-Za-z0-9._-]+)$/.exec(p);
  if (method === 'GET' && imageMatch) {
    const id = imageMatch[1];
    const mime = COMMENT_IMAGE_ID_RE.test(id) ? mimeForImageId(id) : null;
    if (!mime) {
      json(res, 404, { error: `image not found: ${id}` });
      return;
    }
    fs.readFile(path.join(paths.imagesDir, id), (err, data) => {
      if (err) {
        json(res, 404, { error: `image not found: ${id}` });
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
    return;
  }

  if (method === 'POST' && p === '/api/comments') {
    const body = await readBody(req);

    const validatedIntent = validateIntent(body.intent);
    if (typeof validatedIntent === 'string') {
      json(res, 400, { error: validatedIntent });
      return;
    }
    // Read-only mode forbids code changes, so every comment posted while it is
    // on is a question, whatever the form sent (it may have been rendered
    // before the setting was switched on). The browser locks the selector to
    // 質問 too; this is the authoritative side.
    const intent: { intent?: CommentIntent } = loadSettings(paths.settings, paths.envFile)
      .readOnlyMode
      ? { intent: 'question' }
      : validatedIntent;

    // Pasted images, previously uploaded via POST /api/images. Every comment
    // shape (diff, reply, document) accepts them.
    const images = validateImages(body.images, paths.imagesDir);
    if (typeof images === 'string') {
      json(res, 400, { error: images });
      return;
    }

    // A reply carries a parentId. Its anchor is copied from the parent (the
    // request's position fields are ignored), and the stored parentId is
    // normalized to the top-level comment so threads stay one level deep.
    let parentId: string | undefined;
    if (body.parentId !== undefined && body.parentId !== null) {
      if (typeof body.parentId !== 'string') {
        json(res, 400, { error: 'parentId must be a string' });
        return;
      }
      parentId = body.parentId;
    }

    if (parentId !== undefined) {
      if (typeof body.body !== 'string' || !body.body.trim()) {
        json(res, 400, { error: 'body is required' });
        return;
      }
      const replyBody = body.body.trim();
      const fences = await fenceFragment(replyBody);
      const result = mutateComments(paths.comments, (comments) => {
        if (loadFinished(paths.finished)) return { kind: 'finished' } as const;
        const parent = comments.find((c) => c.id === parentId);
        if (!parent) return { kind: 'missing-parent' } as const;
        // Copy the anchor from the top-level comment of the thread.
        const topId = parent.parentId ?? parent.id;
        const anchor = comments.find((c) => c.id === topId) ?? parent;
        const now = nowIso();
        const comment: ReviewComment = {
          id: newCommentId(),
          file: anchor.file,
          side: anchor.side,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          startDiffLine: anchor.startDiffLine,
          endDiffLine: anchor.endDiffLine,
          body: replyBody,
          status: 'open',
          createdAt: now,
          updatedAt: now,
          ...intent,
          ...images,
          ...fences,
          parentId: topId,
        };
        // The code snapshot rides along with the anchor for the same reason:
        // a reply delivered on its own (its parent already answered) still
        // tells the agent which code the thread is about, even after later
        // fixes moved the line numbers.
        if (anchor.code) comment.code = anchor.code;
        // HTML-review threads: replies inherit the document anchor too, so a
        // reply delivered by wait-comments is self-describing.
        if (anchor.documentId) {
          comment.documentId = anchor.documentId;
          comment.htmlTarget = anchor.htmlTarget ?? null;
        }
        comments.push(comment);
        return { kind: 'created', comment } as const;
      });
      if (result.kind === 'finished') {
        json(res, 409, { error: 'review is already finished' });
        return;
      }
      if (result.kind === 'missing-parent') {
        json(res, 400, { error: `parent comment not found: ${String(parentId)}` });
        return;
      }
      json(res, 201, { comment: result.comment });
      return;
    }

    // HTML-review comment: anchored inside a published document instead of
    // the diff. file/side/line are all null; the anchor is the htmlTarget
    // (or null for a whole-document comment).
    if (body.documentId !== undefined && body.documentId !== null) {
      if (typeof body.documentId !== 'string' || !findDocument(paths, body.documentId)) {
        json(res, 400, { error: `unknown documentId: ${String(body.documentId)}` });
        return;
      }
      if (typeof body.body !== 'string' || !body.body.trim()) {
        json(res, 400, { error: 'body is required' });
        return;
      }
      const target = validateHtmlTarget(body.htmlTarget);
      if (typeof target === 'string') {
        json(res, 400, { error: target });
        return;
      }
      const docBody = body.body.trim();
      const fences = await fenceFragment(docBody);
      const now = nowIso();
      const comment: ReviewComment = {
        id: newCommentId(),
        file: null,
        side: null,
        startLine: null,
        endLine: null,
        startDiffLine: null,
        endDiffLine: null,
        body: docBody,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        ...intent,
        ...images,
        ...fences,
        documentId: body.documentId,
        htmlTarget: target,
      };
      mutateComments(paths.comments, (comments) => comments.push(comment));
      json(res, 201, { comment });
      return;
    }

    const input = validateCommentInput(body);
    if (typeof input === 'string') {
      json(res, 400, { error: input });
      return;
    }
    const fences = await fenceFragment(input.body);
    // Only an anchored comment has code to snapshot; an overall comment
    // (file === null) points at nothing in particular.
    const code = input.file === null ? {} : validateCode(body.code);
    // Colour the snapshot here, at write time, so the browser can render it
    // without Shiki (same policy as the comment body's fences). The whole
    // block is tokenized in one pass; failure just leaves the field off.
    if (code.code && input.file !== null) {
      const block = [...code.code.before, ...code.code.lines, ...code.code.after];
      const tokens = await highlightSnapshot(input.file, block);
      if (tokens) code.code.tokens = tokens;
    }
    const now = nowIso();
    const comment: ReviewComment = {
      id: newCommentId(),
      ...input,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      ...intent,
      ...images,
      ...fences,
      ...code,
    };
    const accepted = mutateComments(paths.comments, (comments) => {
      if (loadFinished(paths.finished)) return false;
      comments.push(comment);
      return true;
    });
    if (!accepted) {
      json(res, 409, { error: 'review is already finished' });
      return;
    }
    json(res, 201, { comment });
    return;
  }

  const patchMatch = /^\/api\/comments\/([^/]+)$/.exec(p);
  if (method === 'PATCH' && patchMatch) {
    const id = decodeURIComponent(patchMatch[1]);
    const body = await readBody(req);
    // Validate inputs before taking the lock.
    let newBody: string | undefined;
    if (body.body !== undefined) {
      if (typeof body.body !== 'string' || !body.body.trim()) {
        json(res, 400, { error: 'body must be a non-empty string' });
        return;
      }
      newBody = body.body.trim();
    }
    let newStatus: CommentStatus | undefined;
    if (body.status !== undefined) {
      if (!COMMENT_STATUSES.includes(body.status as CommentStatus)) {
        json(res, 400, { error: `invalid status: ${String(body.status)}` });
        return;
      }
      newStatus = body.status as CommentStatus;
    }
    // An edited body invalidates the stored fence highlighting (the entries
    // are positional), so it is recomputed here and dropped when the new body
    // has no highlightable fence.
    const newFences = newBody !== undefined ? await highlightFences(newBody) : null;
    const result = mutateComments(paths.comments, (comments) => {
      // Reopening a comment makes it deliverable to wait-comments. Order that
      // transition against /api/finish just like comment creation: either the
      // reopen happens first and the final drain delivers it, or it is rejected
      // after the finish marker has been stored.
      if ((newStatus === 'open' || newStatus === 'seen') && loadFinished(paths.finished)) {
        return { kind: 'finished' } as const;
      }
      const comment = comments.find((c) => c.id === id);
      if (!comment) return { kind: 'missing' } as const;
      if (newBody !== undefined) {
        comment.body = newBody;
        if (newFences) comment.fences = newFences;
        else delete comment.fences;
      }
      if (newStatus !== undefined) comment.status = newStatus;
      comment.updatedAt = nowIso();
      return { kind: 'updated', comment } as const;
    });
    if (result.kind === 'finished') {
      json(res, 409, { error: 'review is already finished' });
      return;
    }
    if (result.kind === 'missing') {
      json(res, 404, { error: `comment not found: ${id}` });
      return;
    }
    json(res, 200, { comment: result.comment });
    return;
  }

  // End the review: AI findings the user never acted on are dismissed in
  // bulk (server-side, so the skill doesn't have to), the finished marker is
  // written for wait-comments to pick up, and the server shuts itself down
  // via the onFinish hook. `generate` clears the marker, starting fresh.
  if (method === 'POST' && p === '/api/finish') {
    const dismissed = mutateComments(paths.comments, (comments) => {
      const now = nowIso();
      let n = 0;
      for (const c of comments) {
        if (
          !c.deleted &&
          commentAuthor(c) === 'agent' &&
          (c.status === 'open' || c.status === 'seen')
        ) {
          c.status = 'dismissed';
          c.updatedAt = now;
          n += 1;
        }
      }
      // Store the finish marker while holding the same lock used by comment
      // creation. A post is therefore ordered entirely before finish (and can
      // be drained by wait-comments) or rejected entirely after it.
      saveFinished(paths.finished);
      return n;
    });
    json(res, 200, { status: 'finished', dismissed });
    hooks.onFinish?.();
    return;
  }

  const deleteMatch = /^\/api\/comments\/([^/]+)\/delete$/.exec(p);
  if (method === 'POST' && deleteMatch) {
    const id = decodeURIComponent(deleteMatch[1]);
    const updated = mutateComments(paths.comments, (comments) => {
      const comment = comments.find((c) => c.id === id);
      if (!comment) return null;
      const now = nowIso();
      comment.deleted = true;
      comment.updatedAt = now;
      // Deleting a top-level comment takes its replies with it; otherwise
      // threadStructure would promote them to orphaned top-level comments.
      if (!comment.parentId) {
        for (const reply of comments) {
          if (reply.parentId === id && !reply.deleted) {
            reply.deleted = true;
            reply.updatedAt = now;
          }
        }
      }
      return comment;
    });
    if (!updated) {
      json(res, 404, { error: `comment not found: ${id}` });
      return;
    }
    json(res, 200, { comment: updated });
    return;
  }

  const resolveMatch = /^\/api\/comments\/([^/]+)\/resolve$/.exec(p);
  if (method === 'POST' && resolveMatch) {
    const id = decodeURIComponent(resolveMatch[1]);
    const updated = mutateComments(paths.comments, (comments) => {
      const comment = comments.find((c) => c.id === id);
      if (!comment) return null;
      const now = nowIso();
      comment.status = 'resolved';
      comment.updatedAt = now;
      // Resolving a top-level comment settles the whole thread (mirrors
      // delete's cascade): replies still open/seen, plus replies only
      // answered/fixed (handled but not signed off), go with it. Replies
      // deliberately parked as wontfix/dismissed — and replies already
      // resolved — keep their status so the record of what was skipped or
      // rejected survives.
      if (!comment.parentId) {
        for (const reply of comments) {
          if (
            reply.parentId === id &&
            !reply.deleted &&
            (reply.status === 'open' ||
              reply.status === 'seen' ||
              reply.status === 'answered' ||
              reply.status === 'fixed')
          ) {
            reply.status = 'resolved';
            reply.updatedAt = now;
          }
        }
      }
      return comment;
    });
    if (!updated) {
      json(res, 404, { error: `comment not found: ${id}` });
      return;
    }
    json(res, 200, { comment: updated });
    return;
  }

  json(res, 404, { error: `no route: ${method} ${p}` });
}
