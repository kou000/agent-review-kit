export type CommentStatus =
  | 'open'
  | 'seen'
  | 'fixed'
  | 'answered'
  | 'wontfix'
  | 'resolved';

export const COMMENT_STATUSES: CommentStatus[] = [
  'open',
  'seen',
  'fixed',
  'answered',
  'wontfix',
  'resolved',
];

export interface AgentResponse {
  message: string;
  updatedAt: string;
  // Full 40-hex sha of the commit that carries this fix, when the agent
  // resolved with --commit. The UI renders it as a link to /commit/<sha>,
  // which opens that commit's diff in a new tab. Omitted = no linked commit.
  commit?: string;
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
  // A reply to another comment. When set, this comment's anchor (file/side/all
  // line numbers) is copied from its parent, and parentId always points at a
  // top-level comment (threads are one level deep). Omitted/null = top-level.
  parentId?: string | null;
}

export interface CommentsFile {
  comments: ReviewComment[];
}

export interface ReviewState {
  base: string | null;
  generatedAt: string;
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
