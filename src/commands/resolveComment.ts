import { getCommitMeta } from '../gitDiff';
import { reviewPaths } from '../paths';
import { mutateComments, nowIso } from '../store';
import { COMMENT_STATUSES, CommentStatus } from '../types';

export interface ResolveOptions {
  id: string;
  status?: string;
  message?: string;
  commit?: string;
  cwd?: string;
}

export function resolveComment(opts: ResolveOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const status = (opts.status ?? 'resolved') as CommentStatus;
  if (!COMMENT_STATUSES.includes(status)) {
    console.error(
      `error: invalid status "${opts.status}". valid: ${COMMENT_STATUSES.join(', ')}`
    );
    process.exit(1);
  }

  // Normalize --commit to a canonical full sha up front so a typo fails loudly
  // here rather than producing a dead commit link in the UI. A message is
  // required to attach a commit (the link lives on the agentResponse).
  let commitSha: string | undefined;
  if (opts.commit) {
    if (!opts.message) {
      console.error('error: --commit には --message が必要です（返信にコミットリンクを添える）');
      process.exit(1);
    }
    try {
      commitSha = getCommitMeta(opts.commit, cwd).sha;
    } catch {
      console.error(`error: commit が見つかりません: ${opts.commit}`);
      process.exit(1);
    }
  }

  const paths = reviewPaths(cwd);
  const updated = mutateComments(paths.comments, (comments) => {
    const comment = comments.find((c) => c.id === opts.id);
    if (!comment) return null;
    const now = nowIso();
    comment.status = status;
    comment.updatedAt = now;
    if (opts.message) {
      comment.agentResponse = { message: opts.message, updatedAt: now };
      if (commitSha) comment.agentResponse.commit = commitSha;
    }
    return comment;
  });
  if (!updated) {
    console.error(`error: comment not found: ${opts.id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'updated', comment: updated }, null, 2));
}
