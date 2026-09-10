import * as fs from 'fs';
import * as path from 'path';
import { readOldSideContent } from '../gitDiff';
import { highlightFences, highlightSnapshot } from '../highlight';
import { reviewPaths } from '../paths';
import { loadState, mutateComments, newCommentId, nowIso } from '../store';
import { CommentCodeSnapshot, ReviewComment } from '../types';

// How many lines around the commented range to capture, mirroring the
// browser's CODE_CONTEXT_LINES (src/client/diff/form.ts) so an agent-posted
// comment gets the same neighborhood as one made by hand.
const CODE_CONTEXT_LINES = 5;

// Same caps the server enforces on a browser-posted snapshot (see
// validateCode in src/server.ts): keeps a huge selection or line from
// ballooning comments.json.
const MAX_CODE_LINES = 400;
const MAX_CODE_LINE = 2000;

// The text of `side` for `file`, as whole-file lines (index 0 = line 1).
// new = the working tree file; old = the content as of the last generate's
// base (falls back to HEAD when there was no generate yet, same default
// readOldSideContent itself applies). null = unreadable.
function readSideLines(file: string, side: 'old' | 'new', cwd: string): string[] | null {
  if (side === 'new') {
    try {
      const lines = fs.readFileSync(path.join(cwd, file), 'utf8').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines;
    } catch {
      return null;
    }
  }
  const paths = reviewPaths(cwd);
  const state = loadState(paths.state);
  return readOldSideContent(file, state?.base ?? undefined, cwd);
}

// Build the code snapshot for a line/range comment, mirroring captureCode in
// src/client/diff/form.ts: the commented lines plus up to CODE_CONTEXT_LINES
// of contiguous context on each side. Never throws: returns undefined (no
// snapshot, comment still posted) when the file can't be read, the range
// falls outside it, or the result is over the storage caps that
// validateCode (src/server.ts) also enforces.
async function buildCodeSnapshot(
  file: string,
  side: 'old' | 'new',
  startLine: number,
  endLine: number,
  cwd: string
): Promise<CommentCodeSnapshot | undefined> {
  const lines = readSideLines(file, side, cwd);
  if (!lines || startLine < 1 || endLine > lines.length) return undefined;

  const target = lines.slice(startLine - 1, endLine);
  const before = lines.slice(Math.max(0, startLine - 1 - CODE_CONTEXT_LINES), startLine - 1);
  const after = lines.slice(endLine, Math.min(lines.length, endLine + CODE_CONTEXT_LINES));

  const block = [...before, ...target, ...after];
  if (block.length > MAX_CODE_LINES || block.some((l) => l.length > MAX_CODE_LINE)) {
    return undefined;
  }

  const snapshot: CommentCodeSnapshot = { before, lines: target, after };
  const tokens = await highlightSnapshot(file, block);
  if (tokens) snapshot.tokens = tokens;
  return snapshot;
}

export interface AddCommentOptions {
  body?: string;
  file?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  side?: string;
  cwd?: string;
}

// Post an AI review finding as an agent-authored comment, straight into
// comments.json (no server needed). Agent comments are shown in the UI with
// an AI badge but are NOT delivered by wait-comments: only the user's reply
// to one flows back to the agent. Without --file the comment is an overall
// (file-less) one; with --file but no line it is a file-level comment, shown
// under that file's header.
export async function addComment(opts: AddCommentOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const body = opts.body?.trim();
  if (!body) {
    console.error('error: --body <本文> を指定してください');
    process.exit(1);
  }

  let file: string | null = null;
  let side: 'old' | 'new' | null = null;
  let startLine: number | null = null;
  let endLine: number | null = null;
  if (opts.file) {
    if (opts.line !== undefined && (opts.startLine !== undefined || opts.endLine !== undefined)) {
      console.error('error: --line と --start-line/--end-line は同時に指定できません');
      process.exit(1);
    }
    if (opts.line !== undefined) {
      startLine = endLine = opts.line;
    } else if (opts.startLine !== undefined && opts.endLine !== undefined) {
      startLine = opts.startLine;
      endLine = opts.endLine;
    } else if (opts.side !== undefined) {
      // --side without a line is ambiguous: it names a column of the diff but
      // no row. A file-level comment has no side at all.
      console.error('error: --side を指定する場合は --line または --start-line と --end-line も指定してください');
      process.exit(1);
    }
    if (startLine !== null && endLine !== null && startLine > endLine) {
      console.error('error: --start-line は --end-line 以下にしてください');
      process.exit(1);
    }
    if (opts.side !== undefined && opts.side !== 'old' && opts.side !== 'new') {
      console.error('error: --side は old または new を指定してください');
      process.exit(1);
    }
    file = opts.file;
    // A file-level comment (no line) keeps side null: its anchor is the whole
    // file, and a side would claim a position it doesn't have.
    side = startLine === null ? null : (opts.side as 'old' | 'new' | undefined) ?? 'new';
  } else if (opts.line !== undefined || opts.startLine !== undefined || opts.endLine !== undefined) {
    console.error('error: 行番号を指定する場合は --file も指定してください');
    process.exit(1);
  }

  // Highlight any ``` fences in the body before taking the comments lock
  // (highlighting is async, the store API is synchronous). A fence-less body
  // never imports Shiki, so the common short-lived CLI post stays cheap.
  const fences = await highlightFences(body);

  // Same snapshot the browser attaches (see CommentCodeSnapshot), so an
  // agent-posted finding shows "指摘時のコード" too. Only a line/range
  // comment has an anchor to snapshot.
  const code =
    file !== null && startLine !== null && endLine !== null
      ? await buildCodeSnapshot(file, side ?? 'new', startLine, endLine, cwd)
      : undefined;

  const now = nowIso();
  const comment: ReviewComment = {
    id: newCommentId(),
    file,
    side,
    startLine,
    endLine,
    // Not tied to a position in the diff text. 0 puts the comment on the same
    // footing as one made on an expanded context row: the client resolves the
    // row from file/side/line, and falls back to the orphan section when the
    // line is outside the rendered diff. A file-level comment has no row to
    // resolve at all, so it stays null like an overall comment.
    startDiffLine: startLine === null ? null : 0,
    endDiffLine: startLine === null ? null : 0,
    body,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    author: 'agent',
  };
  if (fences) comment.fences = fences;
  if (code) comment.code = code;

  const paths = reviewPaths(cwd);
  mutateComments(paths.comments, (comments) => comments.push(comment));
  console.log(JSON.stringify({ status: 'created', comment }, null, 2));
}
