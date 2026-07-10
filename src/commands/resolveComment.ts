import { getCommitMeta } from '../gitDiff';
import { encodeImageToDataUri } from '../image';
import { reviewPaths } from '../paths';
import { findSnapshot } from '../snapshot';
import { mutateComments, nowIso } from '../store';
import { COMMENT_STATUSES, CommentStatus } from '../types';

export interface ResolveOptions {
  id: string;
  status?: string;
  message?: string;
  commit?: string;
  snapshot?: string;
  images?: string[];
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

  // Like --commit, --snapshot is validated up front (the id must exist in the
  // snapshot index) so a typo fails here instead of rendering a dead link.
  const paths = reviewPaths(cwd);
  let snapshotId: string | undefined;
  if (opts.snapshot) {
    if (!opts.message) {
      console.error('error: --snapshot には --message が必要です（返信にスナップショットリンクを添える）');
      process.exit(1);
    }
    if (!findSnapshot(paths, opts.snapshot)) {
      console.error(`error: snapshot が見つかりません: ${opts.snapshot}`);
      process.exit(1);
    }
    snapshotId = opts.snapshot;
  }

  // Encode --image files to data URIs before taking the file lock so a bad
  // path / unsupported format / oversize image fails loudly without leaving a
  // half-updated comment. Like --commit, images ride on the agentResponse and
  // therefore require --message.
  let imageDataUris: string[] | undefined;
  if (opts.images && opts.images.length > 0) {
    if (!opts.message) {
      console.error('error: --image には --message が必要です（返信に画像を添える）');
      process.exit(1);
    }
    try {
      imageDataUris = opts.images.map((p) => encodeImageToDataUri(p));
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  const updated = mutateComments(paths.comments, (comments) => {
    const comment = comments.find((c) => c.id === opts.id);
    if (!comment) return null;
    const now = nowIso();
    comment.status = status;
    comment.updatedAt = now;
    if (opts.message) {
      comment.agentResponse = { message: opts.message, updatedAt: now };
      if (commitSha) comment.agentResponse.commit = commitSha;
      if (snapshotId) comment.agentResponse.snapshot = snapshotId;
      if (imageDataUris) comment.agentResponse.images = imageDataUris;
    }
    return comment;
  });
  if (!updated) {
    console.error(`error: comment not found: ${opts.id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'updated', comment: updated }, null, 2));
}
