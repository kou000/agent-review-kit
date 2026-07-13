import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { getCommitMeta, parseUnifiedDiff, runGitCommitDiff, runGitCommitLog } from './gitDiff';
import { bakeDiffHighlight } from './highlight';
import { documentHtmlPath, findDocument } from './htmlDocument';
import { ReviewPaths, reviewPaths } from './paths';
import { renderCommitHtml, renderDocumentHtml, renderSnapshotHtml } from './render';
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
  mutateSettings,
  mutateViewed,
  newCommentId,
  nowIso,
  reconcileViewed,
  saveFinished,
} from './store';
import {
  COMMENT_STATUSES,
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
  // unresolved badge all ignore them.
  const comments = loadComments(paths.comments).filter((c) => !c.deleted);
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
    unresolved: counts.open + counts.seen,
    counts,
    base: state?.base ?? null,
    generatedAt: state?.generatedAt ?? null,
    settings: loadSettings(paths.settings),
    finished: finished?.finishedAt ?? null,
    snapshots: loadSnapshotIndex(paths.snapshotsIndex).snapshots.length,
    documents: loadDocumentIndex(paths.documentsIndex).documents.length,
  };
}

// Cap on every free-text field inside an htmlTarget, so a crafted request
// can't balloon comments.json. Real selectors/snippets are far below this.
const MAX_TARGET_FIELD = 2000;

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
  if (method === 'GET' && p === '/app.js') {
    serveFile(res, paths.appJs, 'text/javascript; charset=utf-8');
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

  if (method === 'GET' && p === '/api/comments') {
    json(res, 200, { comments: loadComments(paths.comments) });
    return;
  }

  if (method === 'GET' && p === '/api/status') {
    json(res, 200, buildStatus(paths));
    return;
  }

  if (method === 'GET' && p === '/api/settings') {
    json(res, 200, { settings: loadSettings(paths.settings) });
    return;
  }

  // Partial update: only known keys with the right type are applied, anything
  // else in the body is ignored. Returns the full settings after the merge.
  if (method === 'PUT' && p === '/api/settings') {
    const body = await readBody(req);
    const settings = mutateSettings(paths.settings, (s) => {
      if (typeof body.snapshotsEnabled === 'boolean') s.snapshotsEnabled = body.snapshotsEnabled;
      if (typeof body.readOnlyMode === 'boolean') s.readOnlyMode = body.readOnlyMode;
    });
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
    const viewed = mutateViewed(paths.viewed, (saved) => reconcileViewed(saved, hashes));
    json(res, 200, { viewed });
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

  if (method === 'POST' && p === '/api/comments') {
    const body = await readBody(req);

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
      const created = mutateComments(paths.comments, (comments) => {
        const parent = comments.find((c) => c.id === parentId);
        if (!parent) return null;
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
          parentId: topId,
        };
        // HTML-review threads: replies inherit the document anchor too, so a
        // reply delivered by wait-comments is self-describing.
        if (anchor.documentId) {
          comment.documentId = anchor.documentId;
          comment.htmlTarget = anchor.htmlTarget ?? null;
        }
        comments.push(comment);
        return comment;
      });
      if (!created) {
        json(res, 400, { error: `parent comment not found: ${String(parentId)}` });
        return;
      }
      json(res, 201, { comment: created });
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
      const now = nowIso();
      const comment: ReviewComment = {
        id: newCommentId(),
        file: null,
        side: null,
        startLine: null,
        endLine: null,
        startDiffLine: null,
        endDiffLine: null,
        body: body.body.trim(),
        status: 'open',
        createdAt: now,
        updatedAt: now,
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
    const now = nowIso();
    const comment: ReviewComment = {
      id: newCommentId(),
      ...input,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    mutateComments(paths.comments, (comments) => comments.push(comment));
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
    const updated = mutateComments(paths.comments, (comments) => {
      const comment = comments.find((c) => c.id === id);
      if (!comment) return null;
      if (newBody !== undefined) comment.body = newBody;
      if (newStatus !== undefined) comment.status = newStatus;
      comment.updatedAt = nowIso();
      return comment;
    });
    if (!updated) {
      json(res, 404, { error: `comment not found: ${id}` });
      return;
    }
    json(res, 200, { comment: updated });
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
      return n;
    });
    saveFinished(paths.finished);
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
      comment.status = 'resolved';
      comment.updatedAt = nowIso();
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
