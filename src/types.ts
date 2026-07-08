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
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  startDiffLine: number;
  endDiffLine: number;
  body: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
  agentResponse?: AgentResponse;
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
