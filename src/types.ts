export type CommentStatus =
  | 'open'
  | 'seen'
  | 'fixed'
  | 'answered'
  | 'wontfix'
  | 'resolved'
  // An AI review finding the user never acted on. Set in bulk when the review
  // is finished (POST /api/finish); excluded from the unresolved count.
  | 'dismissed';

export const COMMENT_STATUSES: CommentStatus[] = [
  'open',
  'seen',
  'fixed',
  'answered',
  'wontfix',
  'resolved',
  'dismissed',
];

// Who wrote a comment. 'agent' marks AI review findings posted via
// `add-comment`; they are skipped by wait-comments (only replies from the
// user flow to the agent) and auto-dismissed on finish. Comments without an
// author field (older comments.json files) are treated as 'user'.
export type CommentAuthor = 'user' | 'agent';

export function commentAuthor(c: ReviewComment): CommentAuthor {
  return c.author ?? 'user';
}

export interface AgentResponse {
  message: string;
  updatedAt: string;
  // Full 40-hex sha of the commit that carries this fix, when the agent
  // resolved with --commit. The UI renders it as a link to /commit/<sha>,
  // which opens that commit's diff in a new tab. Omitted = no linked commit.
  commit?: string;
  // Inline images attached to the reply, each a self-contained base64 data URI
  // (e.g. "data:image/png;base64,..."). The agent supplies them via --image;
  // the UI renders each as an <img> below the message. Only data: image URIs
  // are accepted (validated at write time and again in the client). Omitted =
  // no images. Kept optional for backward compatibility with older
  // comments.json files.
  images?: string[];
  // Id of the snapshot (see SnapshotMeta) that carries this fix, when the
  // agent resolved with --snapshot. The UI renders it as a link to
  // /snapshot/<id>. Lets a fix be reviewed as its own diff page without
  // creating a commit on the branch. Omitted = no linked snapshot.
  snapshot?: string;
}

// Where an HTML-review comment points inside the rendered document. Captured
// by the browser at comment time; re-resolved (selector first, then text
// search with context) on every render, so a re-published document keeps its
// comments as long as the target still exists. Unresolvable targets render in
// the "位置を特定できないコメント" section — never dropped.
export interface HtmlTarget {
  // 'element' = a whole element was picked; 'text' = a drag-selected range.
  kind: 'element' | 'text';
  // CSS selector path of the target element (element comments) or of the
  // element containing the selection (text comments).
  selector: string;
  // Lowercase tag name of that element (fallback matching + display).
  tag: string;
  // Human-readable label shown in comment cards, e.g. 'h2 「認証フロー」'.
  label: string;
  // Element comments: leading text of the element, used to re-find it when
  // the selector no longer matches after a re-publish.
  elementText?: string;
  // Text comments: the exact selected text and its surrounding context in
  // document order, used to re-locate (and disambiguate) the range.
  selectedText?: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface ReviewComment {
  id: string;
  // An "overall" comment is not tied to any file or line: file/side and all
  // line numbers are null. A line/range comment has all of them set.
  file: string | null;
  side: 'old' | 'new' | null;
  startLine: number | null;
  endLine: number | null;
  startDiffLine: number | null;
  endDiffLine: number | null;
  body: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
  agentResponse?: AgentResponse;
  // HTML-review comment: the id of the published document (see
  // HtmlDocumentMeta) this comment belongs to. Diff-review comments omit it.
  // file/side/line fields are all null for document comments.
  documentId?: string | null;
  // Anchor inside the rendered document. null/omitted = a comment on the
  // whole document (the HTML-review analog of an overall comment).
  htmlTarget?: HtmlTarget | null;
  // A reply to another comment. When set, this comment's anchor (file/side/all
  // line numbers) is copied from its parent, and parentId always points at a
  // top-level comment (threads are one level deep). Omitted/null = top-level.
  parentId?: string | null;
  // See CommentAuthor. Omitted = 'user' (backward compatible).
  author?: CommentAuthor;
  // Soft delete. Deleted comments stay in comments.json (recoverable by
  // hand-editing) but are hidden from the UI, excluded from status counts and
  // never delivered by wait-comments. Omitted/false = live.
  deleted?: boolean;
}

export interface CommentsFile {
  comments: ReviewComment[];
}

export interface ReviewState {
  base: string | null;
  generatedAt: string;
}

// Persisted to .agent-review/settings.json, edited from the browser via
// GET/PUT /api/settings. Missing file or missing keys fall back to defaults,
// so the file only ever needs to hold what the user changed.
export interface ReviewSettings {
  // When false, `snapshot create` becomes a no-op (exits with
  // {"status":"skipped"}), so no per-fix diff pages are produced.
  snapshotsEnabled: boolean;
  // Review-only mode for someone else's MR: the agent answers comments but
  // must not modify code. Enforced by the skill; surfaced as a badge in the UI.
  readOnlyMode: boolean;
}

export const DEFAULT_SETTINGS: ReviewSettings = {
  snapshotsEnabled: true,
  readOnlyMode: false,
};

// One captured fix: a git-format patch stored under .agent-review/snapshots/.
// seq is a 1-based counter that fixes the chronological replay order (the
// patch files are also prefixed with it, e.g. 0001_snap_xxx.patch).
export interface SnapshotMeta {
  id: string;
  seq: number;
  // The review comment this fix responds to.
  commentId: string;
  title?: string;
  createdAt: string;
  // File name relative to the snapshots directory.
  patchFile: string;
}

export interface SnapshotIndex {
  // Working-tree state at the FIRST `snapshot begin` of the review, as a git
  // tree sha. A per-comment commit replay restores this state first, then
  // applies the patches in seq order — required for a clean replay when the
  // review started with uncommitted changes (patch #1's context lines exist
  // in this tree, not in HEAD).
  baselineTree?: string;
  snapshots: SnapshotMeta[];
}

// One published HTML document under review (an agent-generated plan, design
// doc, report, ...). The HTML body is stored verbatim next to the index as
// documents/<id>.html and only ever served under a no-script CSP (see
// server.ts); re-publishing the same id bumps `revision`, which the browser
// polls to reload the rendered view.
export interface HtmlDocumentMeta {
  id: string;
  title: string;
  // 1-based, incremented on every publish of the same id.
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface HtmlDocumentIndex {
  documents: HtmlDocumentMeta[];
}

// Presence of .agent-review/finished.json means the review was ended from the
// browser (POST /api/finish): wait-comments exits with status "finished" and
// the server shuts down. `generate` deletes the file, starting a new review.
export interface FinishState {
  finishedAt: string;
}

export interface DiffCell {
  line: number;
  text: string;
  diffLine: number;
  kind: 'context' | 'add' | 'del';
  // Pre-highlighted inner HTML for this line, baked at generate time by Shiki
  // (github-dark, inline styles). The client renders it verbatim after the
  // +/-/space prefix span. Omitted when the file's language is unsupported or
  // highlighting failed, in which case the client falls back to escaped text.
  html?: string;
}

export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
}

export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

export interface FileDiff {
  path: string;
  oldPath: string;
  status: FileStatus;
  hunks: DiffHunk[];
  // Full new-side (working tree) content at generate time, one entry per line.
  // Enables GitHub-style context expansion in the review UI. Omitted for
  // deleted/binary files and files over the embed size cap.
  newLines?: string[];
  // Pre-highlighted inner HTML for each newLines entry (parallel array, baked by
  // Shiki at generate time). Lets expanded context rows match the highlighted
  // diff rows. Omitted when the language is unsupported or highlighting failed.
  newLinesHtml?: string[];
}

export interface DiffData {
  base: string | null;
  generatedAt: string;
  files: FileDiff[];
}
