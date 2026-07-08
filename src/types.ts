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
}

export interface DiffData {
  base: string | null;
  generatedAt: string;
  files: FileDiff[];
}
