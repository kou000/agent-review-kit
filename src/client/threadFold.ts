/* ---------- long-thread folding ---------- */

// A thread with many back-and-forths grows one card tall enough to bury the
// rest of the page. Once it reaches this many messages, only the first card
// (the original comment) and the last card (the latest exchange) stay
// visible and everything between them folds into one "N 件のやりとりを表示"
// link. A message is one block stacked in the thread: a comment's own body,
// or the agentResponse rendered under it.
//
// Kept free of DOM/state imports so it can be unit-tested under plain node.
export const THREAD_FOLD_MIN_MESSAGES = 4;

// 1 for the comment itself (an agent reply appended by resolve-comment has no
// body, but still renders as a card) plus 1 for its agentResponse, if any.
export function messageCount(c) {
  return 1 + (c && c.agentResponse && c.agentResponse.message ? 1 : 0);
}

// Decide how a thread renders. `replies` is the thread's replies in display
// order (createdAt asc). The top card and the last reply are always visible,
// so the newest message never hides behind the fold; only replies strictly
// between them can fold. `open` is the reader's expand toggle for this
// thread.
export function threadFoldPlan(top, replies, open) {
  const all = [top].concat(replies);
  let total = 0;
  all.forEach(function (c) { total += messageCount(c); });
  const middle = replies.slice(0, -1);
  let hiddenMessages = 0;
  middle.forEach(function (c) { hiddenMessages += messageCount(c); });
  const foldable = total >= THREAD_FOLD_MIN_MESSAGES && middle.length > 0;
  return {
    foldable: foldable,
    folded: foldable && !open,
    totalMessages: total,
    // Replies between the top card and the latest reply (what the fold hides).
    middle: middle,
    last: replies.length ? replies[replies.length - 1] : null,
    hiddenMessages: foldable ? hiddenMessages : 0,
  };
}

export function threadFoldLabel(plan) {
  return plan.folded ? plan.hiddenMessages + ' 件のやりとりを表示' : '折りたたむ';
}
