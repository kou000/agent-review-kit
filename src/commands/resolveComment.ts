import { getCommitMeta } from '../gitDiff';
import { highlightFences } from '../highlight';
import { encodeImageToDataUri } from '../image';
import { reviewPaths } from '../paths';
import { findSnapshot } from '../snapshot';
import { mutateComments, newCommentId, nowIso, replyAnchor } from '../store';
import {
  AgentResponse,
  COMMENT_STATUSES,
  CommentFences,
  CommentStatus,
  ReviewComment,
} from '../types';

export interface ResolveOptions {
  id: string;
  status?: string;
  message?: string;
  commit?: string;
  snapshot?: string;
  images?: string[];
  cwd?: string;
}

export async function resolveComment(opts: ResolveOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const status = (opts.status ?? 'answered') as CommentStatus;
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

  // Highlight any ``` fences in the reply. The client renders the message
  // after turning literal "\n" escapes into real newlines (unescapeNl in
  // client/dom.ts), so fence extraction must see the same text: apply the
  // same normalization before highlighting. Fence-less messages skip the
  // Shiki import entirely (see highlightFences).
  let messageFences: CommentFences | null = null;
  if (opts.message) {
    messageFences = await highlightFences(
      opts.message.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')
    );
  }

  const updated = mutateComments(paths.comments, (comments) => {
    const comment = comments.find((c) => c.id === opts.id);
    if (!comment) return null;
    const now = nowIso();
    comment.status = status;
    comment.updatedAt = now;
    let reply: ReviewComment | undefined;
    if (opts.message) {
      const response: AgentResponse = { message: opts.message, updatedAt: now };
      if (commitSha) response.commit = commitSha;
      if (snapshotId) response.snapshot = snapshotId;
      if (imageDataUris) response.images = imageDataUris;
      if (messageFences) response.fences = messageFences;
      if (comment.agentResponse) {
        // An earlier agent answer is never overwritten: a second message
        // (e.g. a correction) becomes a new agent reply in the same thread.
        // The message lives on the reply's agentResponse, not its body, so it
        // renders like any other agent answer (commit/snapshot links, images,
        // fences, toast). Its status follows the target's, except that an
        // agent message is never open/seen work: those would count toward
        // the unresolved badge and be dismissed at finish.
        reply = {
          id: newCommentId(),
          ...replyAnchor(comments, comment),
          body: '',
          status: status === 'open' || status === 'seen' ? 'answered' : status,
          createdAt: now,
          updatedAt: now,
          author: 'agent',
          agentResponse: response,
        };
      } else {
        comment.agentResponse = response;
      }
    }
    // Updating a top-level comment carries its thread along:
    // - resolved: the thread is closed — replies still open/seen, plus
    //   replies only answered/fixed (handled but not signed off), become
    //   resolved.
    // - answered/fixed/wontfix/dismissed: only replies still open/seen take
    //   the same status, so the user's pending replies stop looking like
    //   agent work without the agent closing the thread. Replies already
    //   answered/fixed/wontfix/dismissed/resolved keep their status.
    // - open/seen: replies are left alone.
    // Replies deliberately parked as wontfix/dismissed — and replies already
    // resolved — never change, so the record of what was skipped or rejected
    // survives.
    if (!comment.parentId && status !== 'open' && status !== 'seen') {
      for (const reply of comments) {
        if (reply.parentId !== comment.id || reply.deleted) continue;
        const pending = reply.status === 'open' || reply.status === 'seen';
        const handled = reply.status === 'answered' || reply.status === 'fixed';
        if (pending || (status === 'resolved' && handled)) {
          reply.status = status;
          reply.updatedAt = now;
        }
      }
    }
    // Appended after the cascade so the new reply keeps the status set above.
    if (reply) comments.push(reply);
    return { comment, reply };
  });
  if (!updated) {
    console.error(`error: comment not found: ${opts.id}`);
    process.exit(1);
  }
  const { comment, reply } = updated;
  console.log(
    JSON.stringify({ status: 'updated', comment, ...(reply && { reply }) }, null, 2)
  );
}
