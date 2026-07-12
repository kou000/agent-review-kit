import { reviewPaths } from '../paths';
import { loadComments, loadFinished, loadSettings, mutateComments, nowIso } from '../store';
import { ReviewComment, commentAuthor } from '../types';

export interface WaitOptions {
  timeout?: number; // seconds, 0 = wait forever
  // Deliver only comments belonging to this published HTML document
  // (comment.documentId matches). Without it every comment — diff review and
  // all documents — is delivered, as before.
  documentId?: string;
  // Exclude comments addressed to an HTML document (comment.documentId is
  // set), delivering only diff review comments. Mutually exclusive with
  // documentId (enforced in cli.ts).
  diffOnly?: boolean;
  cwd?: string;
}

const POLL_INTERVAL_MS = 1000;

// Only the user's live open comments are deliverable. Agent-authored comments
// (AI review findings posted via add-comment) stay open until the user replies
// or the review finishes; the reply is what flows to the agent.
function isDeliverable(c: ReviewComment, documentId?: string, diffOnly?: boolean): boolean {
  if (documentId !== undefined && c.documentId !== documentId) return false;
  if (diffOnly && c.documentId !== undefined) return false;
  return c.status === 'open' && !c.deleted && commentAuthor(c) === 'user';
}

export async function waitComments(opts: WaitOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutSec = opts.timeout ?? 0;
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;

  for (;;) {
    // Re-resolved every poll: review data is branch-scoped, and a checkout
    // while waiting should shift the watch to the new branch's comments.
    const paths = reviewPaths(cwd);
    // Unlocked probe: reads always see a consistent snapshot (rename is atomic).
    const hasOpen = loadComments(paths.comments).some((c) =>
      isDeliverable(c, opts.documentId, opts.diffOnly)
    );
    if (hasOpen) {
      // Re-extract open comments inside the lock so any that appeared between
      // the probe and lock acquisition are included in the received set.
      const received = mutateComments(paths.comments, (comments) => {
        const now = nowIso();
        const open = comments.filter((c) => isDeliverable(c, opts.documentId, opts.diffOnly));
        for (const c of open) {
          c.status = 'seen';
          c.updatedAt = now;
        }
        return open;
      });
      // The probe can win while another consumer (a concurrent wait-comments,
      // or the user resolving the comment) drains the open set before we take
      // the lock. An empty batch is not a receipt — keep waiting.
      if (received.length > 0) {
        // The current settings ride along with every delivery so the consumer
        // (the agent) always has readOnlyMode etc. in front of it at triage
        // time — no separate status check to remember, nothing to forget.
        const settings = loadSettings(paths.settings);
        console.log(JSON.stringify({ status: 'received', settings, comments: received }, null, 2));
        return;
      }
    }
    // Checked only after the delivery attempt: a comment posted just before
    // the finish button was pressed is still delivered, never dropped.
    if (loadFinished(paths.finished)) {
      console.log(JSON.stringify({ status: 'finished', comments: [] }, null, 2));
      return;
    }
    if (deadline !== null && Date.now() >= deadline) {
      console.log(JSON.stringify({ status: 'timeout', comments: [] }, null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
