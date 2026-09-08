import { highlightFences } from '../highlight';
import { reviewPaths } from '../paths';
import { mutateComments, newCommentId, nowIso } from '../store';
import { ReviewComment } from '../types';

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

  const paths = reviewPaths(cwd);
  mutateComments(paths.comments, (comments) => comments.push(comment));
  console.log(JSON.stringify({ status: 'created', comment }, null, 2));
}
