import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { ReviewPaths } from './paths';
import { loadComments, loadState, mutateComments, newCommentId, nowIso } from './store';
import { COMMENT_STATUSES, CommentStatus, ReviewComment } from './types';

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
  const comments = loadComments(paths.comments);
  const counts: Record<CommentStatus, number> = {
    open: 0,
    seen: 0,
    fixed: 0,
    answered: 0,
    wontfix: 0,
    resolved: 0,
  };
  for (const c of comments) counts[c.status] += 1;
  const state = loadState(paths.state);
  return {
    // どのプロジェクトを serve しているかをクライアント側が検証できるようにする
    // （複数プロジェクト同時レビュー時のポート取り違え検知用）。
    projectDir: path.dirname(paths.dir),
    total: comments.length,
    unresolved: counts.open + counts.seen,
    counts,
    base: state?.base ?? null,
    generatedAt: state?.generatedAt ?? null,
  };
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

export function createServer(paths: ReviewPaths): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, paths).catch((e: unknown) => {
      json(res, 500, { error: String(e) });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  paths: ReviewPaths
): Promise<void> {
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
  if (method === 'GET' && p === '/highlight.min.js') {
    serveFile(res, paths.hljsJs, 'text/javascript; charset=utf-8');
    return;
  }
  if (method === 'GET' && p === '/hljs-theme.css') {
    serveFile(res, paths.hljsCss, 'text/css; charset=utf-8');
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
