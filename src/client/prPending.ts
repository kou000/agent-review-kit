/* ---------- PR/MR pending review comment requests ----------
 * The 「PR に下書き投稿」 buttons ask the agent to add a comment to the PR/MR
 * as a pending (unpublished) review comment. Like the push / PR import
 * requests there is no dedicated API: the request is an ordinary comment
 * whose body starts with PR_PENDING_PREFIX, delivered by wait-comments, and
 * its anchor (file / side / lines) says where on the PR the comment goes.
 *
 * Kept free of DOM/state imports so it can be unit-tested under plain node. */

export const PR_PENDING_PREFIX = '【PR Pending コメント依頼】';
export const PR_PENDING_LABEL = 'PR に下書き投稿';
export const PR_PENDING_TITLE =
  'この文面を PR/MR の Pending（未公開）レビューコメントとして投稿するようエージェントに依頼する（レビューの公開はしない）';

// The buttons show only while settings.prPendingCommentEnabled is on and a
// PR/MR is registered (set-pr). `prUrl` is state.prUrl, already reduced to an
// https URL or null by updatePrLink; checked again here all the same.
export function prPendingAvailable(enabled, prUrl) {
  return enabled === true && typeof prUrl === 'string' && /^https:\/\//.test(prUrl);
}

// The severity tag add-comment findings start with (see the AI review mode in
// the my-interactive-review skill). It is ark-internal triage, not part of
// what the reviewer wants to say on the PR.
const SEVERITY_PREFIX = /^\[(?:Critical|Warning|Info)\] /;

// Initial text of the pending-comment form opened from a comment card: the
// comment's own body, minus the severity tag on AI findings and minus the
// request prefix on an earlier request. An agent reply appended by
// resolve-comment has no body; its text is the agentResponse, so that is
// offered instead.
export function prPendingInitialText(c) {
  if (!c) return '';
  let text = typeof c.body === 'string' ? c.body : '';
  if (!text.trim() && c.agentResponse && typeof c.agentResponse.message === 'string') {
    text = c.agentResponse.message;
  }
  if (text.indexOf(PR_PENDING_PREFIX) === 0) {
    text = text.slice(PR_PENDING_PREFIX.length).replace(/^\r?\n/, '');
  }
  if ((c.author || 'user') === 'agent') text = text.replace(SEVERITY_PREFIX, '');
  return text;
}

// Body of the request comment: the prefix on its own line, then the text to
// post on the PR/MR verbatim.
export function prPendingBody(text) {
  return PR_PENDING_PREFIX + '\n' + text;
}
