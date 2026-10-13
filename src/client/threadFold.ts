/* ---------- long-thread folding ---------- */

// A thread with many back-and-forths grows one card tall enough to bury the
// rest of the page. Once it reaches this many messages, only the first card
// (the original comment) and the last THREAD_FOLD_TAIL replies (the latest
// exchange and the one before it) stay visible, and everything between them
// folds. The reader can reveal the folded replies one at a time, newest
// first, or all at once. A message is one block stacked in the thread: a
// comment's own body, or the agentResponse rendered under it.
//
// Kept free of DOM/state imports so it can be unit-tested under plain node.
export const THREAD_FOLD_MIN_MESSAGES = 4;
export const THREAD_FOLD_TAIL = 2;

// 1 for the comment itself (an agent reply appended by resolve-comment has no
// body, but still renders as a card) plus 1 for its agentResponse, if any.
export function messageCount(c) {
  return 1 + (c && c.agentResponse && c.agentResponse.message ? 1 : 0);
}

function sumMessages(list) {
  let n = 0;
  list.forEach(function (c) { n += messageCount(c); });
  return n;
}

// Decide how a thread renders. `replies` is the thread's replies in display
// order (createdAt asc). The top card and the last THREAD_FOLD_TAIL replies
// are always visible, so the newest messages never hide behind the fold; only
// replies strictly between them (`middle`) can fold. `openFrom` is the id of
// the oldest middle reply the reader revealed (falsy = none revealed). Keying
// it by id rather than a count keeps the revealed range put when a new reply
// arrives and shifts the tail.
export function threadFoldPlan(top, replies, openFrom) {
  const middle = replies.slice(0, Math.max(0, replies.length - THREAD_FOLD_TAIL));
  const tail = replies.slice(middle.length);
  const total = sumMessages([top].concat(replies));
  const foldable = total >= THREAD_FOLD_MIN_MESSAGES && middle.length > 0;
  let firstShown = middle.length;
  if (openFrom) {
    const i = middle.findIndex(function (c) { return c.id === openFrom; });
    if (i >= 0) firstShown = i;
  }
  const hidden = foldable ? middle.slice(0, firstShown) : [];
  return {
    foldable: foldable,
    folded: hidden.length > 0,
    // Some middle replies are on screen, so "fold again" makes sense.
    revealed: foldable && firstShown < middle.length,
    totalMessages: total,
    middle: middle,
    hidden: hidden,
    tail: tail,
    hiddenMessages: sumMessages(hidden),
  };
}

// The toggle buttons to show above the middle replies, in order. Each sets
// the thread's openFrom to `open` (null = fold everything again).
export function threadFoldActions(plan) {
  const actions = [];
  if (plan.folded) {
    actions.push({
      label: '1 つ前のやりとりを表示',
      title: '折りたたまれたやりとりを 1 つずつ展開する',
      open: plan.hidden[plan.hidden.length - 1].id,
    });
    if (plan.hidden.length > 1) {
      actions.push({
        label: plan.hiddenMessages + ' 件のやりとりをすべて表示',
        title: '折りたたまれたやりとりをすべて展開する',
        open: plan.middle[0].id,
      });
    }
  }
  if (plan.revealed) {
    actions.push({
      label: '折りたたむ',
      title: '最初と最新 ' + THREAD_FOLD_TAIL + ' 件以外のやりとりを折りたたむ',
      open: null,
    });
  }
  return actions;
}
