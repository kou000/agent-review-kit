import { api } from './api.js';
import { bodySnippet, esc, fmtDate, isSafeImageDataUri, unescapeNl } from './dom.js';
import { attachImagePaste, commentBodyHtml, commentImagesHtml } from './images.js';
import { renderMarkdown, stripMarkdown, tokenLineHtml } from './markdown.js';
import { intentFieldHtml, selectedIntent, syncIntentFields } from './intent.js';
import { state } from './state.js';
import { refresh } from './app.js';

/* ---------- comment threads ---------- */

export function isAgentComment(c) {
  return (c.author || 'user') === 'agent';
}

export function docTargetText(c) {
  const t = c.htmlTarget;
  if (!t) return 'ドキュメント全体';
  if (t.kind === 'text' && t.selectedText) return '“' + bodySnippet(t.selectedText) + '”';
  return t.label || t.tag || '要素';
}

export function commentLocShort(c) {
  if (c.documentId) return docTargetText(c);
  if (c.file === null || c.file === undefined) return '全体';
  // File-level comment: a file with no line anchor (see ReviewComment.file).
  if (c.startLine === null || c.startLine === undefined) return c.file + ' 全体';
  const range = c.startLine === c.endLine
    ? 'L' + c.startLine
    : 'L' + c.startLine + '-' + c.endLine;
  return c.file + ':' + range;
}

function byCreatedAsc(a, b) {
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

// Split a flat list of comments (sharing one anchor, or the overall bucket)
// into top-level comments (createdAt asc) each with its replies grouped by
// parentId. A reply whose parent is absent from the list is surfaced as a
// top-level entry so it is never silently hidden.
export function threadStructure(list) {
  const tops = [];
  const topIds = {};
  const repliesByParent = {};
  list.forEach(function (c) {
    if (c.parentId === null || c.parentId === undefined) {
      tops.push(c);
      topIds[c.id] = true;
    }
  });
  list.forEach(function (c) {
    if (c.parentId === null || c.parentId === undefined) return;
    if (topIds[c.parentId]) {
      (repliesByParent[c.parentId] = repliesByParent[c.parentId] || []).push(c);
    } else {
      tops.push(c);
    }
  });
  tops.sort(byCreatedAsc);
  Object.keys(repliesByParent).forEach(function (k) {
    repliesByParent[k].sort(byCreatedAsc);
  });
  return { tops: tops, repliesByParent: repliesByParent };
}

/* ---------- thread collapse state ---------- */

// A thread whose every comment is settled (resolved) starts collapsed to a
// one-line summary, like GitHub's resolved threads.
// Only an explicit user toggle is persisted (localStorage); the default is
// recomputed from statuses on every render, so a thread that gets reopened
// expands again by itself.
const THREAD_COLLAPSE_KEY = 'ark-thread-collapse';

try { state.threadCollapse = JSON.parse(localStorage.getItem(THREAD_COLLAPSE_KEY)) || {}; } catch (e) { state.threadCollapse = {}; }

function saveThreadCollapse() {
  try { localStorage.setItem(THREAD_COLLAPSE_KEY, JSON.stringify(state.threadCollapse)); } catch (e) { /* ignore */ }
}

export function setThreadCollapsed(topId, on) {
  state.threadCollapse[topId] = on ? 1 : 0;
  saveThreadCollapse();
}

// Drop persisted toggles for comments that no longer exist (same pattern as
// loadViewed's pruning).
export function pruneThreadCollapse() {
  const ids = {};
  state.comments.forEach(function (c) { ids[c.id] = true; });
  let changed = false;
  Object.keys(state.threadCollapse).forEach(function (k) {
    if (!ids[k]) { delete state.threadCollapse[k]; changed = true; }
  });
  if (changed) saveThreadCollapse();
}

// Only an explicit resolve settles a comment. wontfix / dismissed are records
// of a judgement (or of an untouched AI finding at review end), so treating
// them as done would quietly clear things the user never confirmed; they stay
// on the list as 要確認 instead.
export const SETTLED_STATUSES = { resolved: true };

export function isThreadCollapsed(top, replies) {
  if (Object.prototype.hasOwnProperty.call(state.threadCollapse, top.id)) {
    return !!state.threadCollapse[top.id];
  }
  if (!SETTLED_STATUSES[top.status]) return false;
  for (let i = 0; i < replies.length; i++) {
    if (!SETTLED_STATUSES[replies[i].status]) return false;
  }
  return true;
}

// Rolls a whole thread up into one of three states, so the sidebar can say
// whose turn it is at a glance:
//   open    — something is still on the agent (an open/seen user comment)
//   check   — the ball is in the user's court: the agent answered/fixed, a
//             wontfix/dismissed judgement awaits confirmation, or an AI review
//             finding (open/seen agent comment) awaits a reply
//   settled — every comment is resolved
export function threadState(top, replies) {
  const all = [top].concat(replies);
  let needsCheck = false;
  for (let i = 0; i < all.length; i++) {
    const st = all[i].status;
    if (st === 'open' || st === 'seen') {
      // An open agent comment is an AI finding waiting on the user, not on
      // the agent (wait-comments never delivers agent comments), so it must
      // not push the thread into 未解決.
      if (isAgentComment(all[i])) { needsCheck = true; continue; }
      return 'open';
    }
    if (!SETTLED_STATUSES[st]) needsCheck = true;
  }
  return needsCheck ? 'check' : 'settled';
}

export const THREAD_STATE_LABEL = { open: '未解決', check: '要確認', settled: '解決済み' };

// The code the comment was written against, captured at comment time (see
// CommentCodeSnapshot). Line anchors drift as fixes land, so this is the only
// reliable record of what the comment pointed at — but it is bulky next to the
// comment text, so it stays folded until the reader asks for it. Rendered from
// escaped text only: comments.json is hand-editable, so nothing here is
// trusted as markup, and no highlighting is attempted.
function codeSnapshotHtml(c) {
  const code = c.code;
  if (!code || !Array.isArray(code.lines) || !code.lines.length) return '';
  const before = Array.isArray(code.before) ? code.before : [];
  const after = Array.isArray(code.after) ? code.after : [];
  // Server-baked Shiki tokens, one entry per line of before+lines+after (see
  // CommentCodeSnapshot.tokens). Applied per line: a line whose tokens don't
  // reassemble its stored text renders as plain escaped text, and the rest of
  // the block still gets its colours.
  const tokens = Array.isArray(code.tokens) ? code.tokens : null;
  // `before` ends at startLine - 1 and `after` starts at endLine + 1, so the
  // whole block numbers contiguously from there. A comment with a non-numeric
  // anchor (hand-edited file) renders without line numbers rather than with
  // wrong ones.
  let n = typeof c.startLine === 'number' ? c.startLine - before.length : null;
  let row = 0;
  const rows = [];
  const push = function (text, cls) {
    const num = n === null ? '' : String(n);
    if (n !== null) n++;
    const plain = String(text);
    const highlighted = tokens ? tokenLineHtml(tokens[row], plain) : null;
    row++;
    rows.push('<tr class="' + cls + '"><td class="n">' + esc(num) +
      '</td><td class="t">' + (highlighted === null ? esc(plain) : highlighted) + '</td></tr>');
  };
  before.forEach(function (t) { push(t, 'ctx'); });
  code.lines.forEach(function (t) { push(t, 'hit'); });
  after.forEach(function (t) { push(t, 'ctx'); });
  const range = typeof c.startLine === 'number'
    ? ' ' + (c.startLine === c.endLine ? 'L' + c.startLine : 'L' + c.startLine + '-L' + c.endLine)
    : '';
  const sideText = c.side === 'old' ? '（変更前）' : '';
  return '<details class="code-snapshot">' +
    '<summary title="コメントを書いた時点で表示されていたコード（その後の修正では変化しない）">' +
    'コメント当時のコード' + sideText + esc(range) + '</summary>' +
    '<table>' + rows.join('') + '</table></details>';
}

export function commentCard(c: any, isReply?: boolean) {
  const div = document.createElement('div');
  div.className = 'comment-card' + (isReply ? ' reply-card' : '') +
    (isAgentComment(c) ? ' agent-comment' : '');
  div.dataset.commentId = c.id;

  // Replies are visually nested under their parent, so the anchor location is
  // already implied; show a "↳ 返信" marker instead of repeating it.
  let posText;
  if (isReply) {
    posText = '↳ 返信';
  } else if (c.documentId) {
    posText = esc(docTargetText(c));
  } else if (c.file === null || c.file === undefined) {
    posText = 'レビュー全体';
  } else if (c.startLine === null || c.startLine === undefined) {
    posText = esc(c.file) + '（ファイル全体）';
  } else {
    const range = c.startLine === c.endLine ? 'L' + c.startLine : 'L' + c.startLine + '-L' + c.endLine;
    posText = esc(c.file) + ' ' + (c.side === 'new' ? '' : '(旧) ') + esc(range);
  }
  // Body rendered as Markdown, with [画像: <id>] markers rewritten to their
  // inline image;
  // whatever attachment isn't referenced by a marker still falls through to
  // the below-the-body strip (commentImagesHtml), so nothing goes unshown.
  const bodyRendered = commentBodyHtml(c.body, c.images, c.fences);
  const remainingImages = (c.images || []).filter(function (id) { return !bodyRendered.usedIds[id]; });
  let html =
    '<div class="meta">' +
    (isAgentComment(c) ? '<span class="who-pill">AI</span>' : '') +
    '<span class="status-pill status-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
    // 修正依頼 is the default, so only the answer-only choice is marked.
    (c.intent === 'question' ? '<span class="intent-pill">質問</span>' : '') +
    '<span>' + posText + '</span>' +
    '<span>' + esc(fmtDate(c.createdAt)) + '</span>' +
    '</div>' +
    // The snapshot belongs to the thread, not to each message, so it renders
    // once on the top-level card even though replies carry an inherited copy.
    (isReply ? '' : codeSnapshotHtml(c)) +
    '<div class="body">' + bodyRendered.html + '</div>' +
    // Images the user pasted into the comment form (stored ids, served from
    // /api/images/<id>; only ids matching the strict shape render).
    commentImagesHtml(remainingImages);
  if (c.agentResponse && c.agentResponse.message) {
    // The reply's fences were highlighted after the same unescapeNl
    // normalization applied here, so fence positions line up.
    html += '<div class="agent-response"><span class="who">agent</span>' +
      renderMarkdown(unescapeNl(c.agentResponse.message), null, c.agentResponse.fences);
    // A linked fix commit renders as a chip; clicking opens /commit/<sha>
    // (this commit's diff) in a new tab. sha is hex-only so it needs no
    // attribute escaping beyond esc() for the visible text.
    if (c.agentResponse.commit) {
      var sha = c.agentResponse.commit;
      html += '<a class="commit-link" href="/commit/' + encodeURIComponent(sha) +
        '" target="_blank" rel="noopener" title="このコミットの差分を新しいタブで開く">🔗 ' +
        esc(sha.slice(0, 7)) + '</a>';
    }
    // A linked fix snapshot renders like a commit link but opens
    // /snapshot/<id>. The id is validated against its fixed shape before it
    // lands in an href, same policy as image data URIs.
    if (c.agentResponse.snapshot && /^snap_[a-z0-9]+$/.test(c.agentResponse.snapshot)) {
      html += '<a class="commit-link" href="/snapshot/' +
        encodeURIComponent(c.agentResponse.snapshot) +
        '" target="_blank" rel="noopener" title="この修正の差分を新しいタブで開く">📄 修正差分</a>';
    }
    // Inline images attached by the agent. Only data: image URIs pass the
    // sanitizer; anything else (javascript:, http:, ...) is silently dropped
    // so the UI never emits an external request or an unsafe src. Each image
    // links to itself so a click opens the full-size capture in a new tab.
    if (c.agentResponse.images && c.agentResponse.images.length) {
      var imgs = '';
      for (var ii = 0; ii < c.agentResponse.images.length; ii++) {
        var uri = c.agentResponse.images[ii];
        if (!isSafeImageDataUri(uri)) continue;
        imgs += '<a class="agent-image-link" href="' + esc(uri) +
          '" target="_blank" rel="noopener" title="原寸を新しいタブで開く">' +
          '<img class="agent-image" src="' + esc(uri) + '" alt="agent の添付画像"></a>';
      }
      if (imgs) html += '<div class="agent-images">' + imgs + '</div>';
    }
    html += '</div>';
  }
  div.innerHTML = html;

  const actions = document.createElement('div');
  actions.className = 'actions';
  // One-click fix request: posts a canned reply as the user, which rides the
  // normal reply pipeline (wait-comments only delivers user comments). The
  // canned text is a self-contained instruction, so the consumer needs no
  // knowledge of this button. Shown on every unresolved card, not just AI
  // findings and not just the head of a thread: the usual moment for it is
  // right after reading the agent's last answer — which, in a long thread,
  // is the bottom card, not the top one. Posting from a reply lands in the
  // same thread (the server normalizes parentId to the top-level comment).
  if (c.status !== 'resolved') {
    const fixBtn = document.createElement('button');
    fixBtn.className = 'primary';
    fixBtn.textContent = '🔧 修正を依頼';
    fixBtn.title = !isReply && isAgentComment(c)
      ? '返信を書かずに、この指摘の修正をエージェントに依頼する'
      : '返信を書かずに、このスレッドのやりとりどおりの修正をエージェントに依頼する';
    fixBtn.addEventListener('click', function () {
      fixBtn.disabled = true;
      api('POST', '/api/comments', {
        parentId: c.id,
        body: !isReply && isAgentComment(c)
          ? '上記の指摘の通り修正してください'
          : '上記のやりとりの通り修正してください',
        intent: 'fix',
      })
        .then(refresh)
        .catch(function (err) {
          fixBtn.disabled = false;
          alert('修正依頼に失敗しました: ' + err);
        });
    });
    actions.appendChild(fixBtn);
  }
  if (c.status !== 'resolved') {
    const btn = document.createElement('button');
    btn.textContent = 'Resolve';
    // A top-level resolve settles the whole thread server-side (replies
    // still open/seen are resolved too), so say so in the tooltip.
    btn.title = isReply
      ? 'この返信を解決する'
      : 'このコメントを解決する（未解決の返信もまとめて解決）';
    btn.addEventListener('click', function () {
      api('POST', '/api/comments/' + encodeURIComponent(c.id) + '/resolve', {})
        .then(refresh)
        .catch(function (err) { alert('更新に失敗しました: ' + err); });
    });
    actions.appendChild(btn);
    // エージェントへ「もう一度届ける」唯一の手段: open に戻して wait-comments
    // に再配達させる。対象は 2 つの状況 —
    //   seen     … 配達済みだが応答が返ってこないまま止まっている（手動リカバリ）
    //   answered … 応答済み、または Unresolve で解決を取り消した後の再依頼
    // エージェント処理中に押すと同じ id で二重に届く点は変わらないので、
    // あくまで手動の再依頼と位置づける。wait-comments はユーザーのコメントしか
    // 配達しないため、AI 指摘（agent 発）では押しても何も起きない = 出さない。
    if (!isAgentComment(c) && (c.status === 'seen' || c.status === 'answered')) {
      const resend = document.createElement('button');
      resend.textContent = 'エージェントに再送';
      resend.title = 'このコメントを open に戻してエージェントに再度配達する（応答が止まったときの再送・解決取り消し後の再依頼）';
      resend.addEventListener('click', function () {
        api('PATCH', '/api/comments/' + encodeURIComponent(c.id), { status: 'open' })
          .then(refresh)
          .catch(function (err) { alert('更新に失敗しました: ' + err); });
      });
      actions.appendChild(resend);
    }
  } else {
    // resolved の取り消し。誤って解決したコメントや、解決後に議論が再開した
    // スレッドを戻す手段で、トップレベル・返信の両方に出す（Resolve ボタンは
    // status !== 'resolved' のときだけなので、両者は自然に排他になる）。
    // open ではなく answered に戻すのは、これが「表示上の解決取り消し」だから:
    // 画面には要確認として残るが、wait-comments の配達対象（open）には入らず
    // 待機中のエージェントを叩き起こさない。エージェントへの再依頼は上の
    // 「エージェントに再送」ボタンの役割（answered からも押せる）。
    const reopen = document.createElement('button');
    reopen.textContent = 'Unresolve';
    // resolve はトップレベルから返信へカスケードするが、サーバーはこの PATCH
    // では対象コメントの status しか書き換えない（非対称）。まとめて解決された
    // 返信は戻らないので、その旨をトップレベルの tooltip に添える。
    reopen.title = isReply
      ? '解決を取り消して要確認に戻す（エージェントには通知しない）'
      : '解決を取り消して要確認に戻す（エージェントには通知しない／まとめて解決された返信は元に戻らない）';
    reopen.addEventListener('click', function () {
      api('PATCH', '/api/comments/' + encodeURIComponent(c.id), { status: 'answered' })
        .then(refresh)
        .catch(function (err) { alert('更新に失敗しました: ' + err); });
    });
    actions.appendChild(reopen);
  }
  // Soft delete (any status, any author). A top-level delete takes its
  // replies with it on the server side, so warn accordingly.
  const del = document.createElement('button');
  del.className = 'delete-btn';
  del.textContent = '削除';
  del.title = 'コメントを削除する（画面と集計から消える。データ上は論理削除）';
  del.addEventListener('click', function () {
    const isTop = c.parentId === null || c.parentId === undefined;
    const msg = isTop
      ? 'このコメントを削除しますか？返信もまとめて削除されます。'
      : 'この返信を削除しますか？';
    if (!confirm(msg)) return;
    api('POST', '/api/comments/' + encodeURIComponent(c.id) + '/delete', {})
      .then(refresh)
      .catch(function (err) { alert('削除に失敗しました: ' + err); });
  });
  actions.appendChild(del);
  div.appendChild(actions);
  return div;
}

// Render a thread (top-level cards, each followed by its nested replies and a
// reply form) into a container. Shared by line threads, the overall section
// and the orphan section. Each thread gets a slim summary header that
// toggles the body; settled threads start collapsed.
export function renderThread(container, list) {
  const s = threadStructure(list);
  s.tops.forEach(function (top) {
    const block = document.createElement('div');
    block.className = 'comment-thread-block';
    block.dataset.topId = top.id;
    const replies = s.repliesByParent[top.id] || [];

    const summary = document.createElement('div');
    summary.className = 'thread-summary';
    const caret = document.createElement('span');
    caret.className = 'thread-caret';
    const pill = document.createElement('span');
    pill.className = 'status-pill status-' + top.status;
    pill.textContent = top.status;
    const snippet = document.createElement('span');
    snippet.className = 'thread-snippet';
    snippet.textContent = bodySnippet(stripMarkdown(top.body));
    summary.appendChild(caret);
    if (isAgentComment(top)) {
      const who = document.createElement('span');
      who.className = 'who-pill';
      who.textContent = 'AI';
      summary.appendChild(who);
    }
    summary.appendChild(pill);
    summary.appendChild(snippet);
    if (replies.length) {
      const count = document.createElement('span');
      count.className = 'thread-reply-count';
      count.textContent = '返信 ' + replies.length;
      summary.appendChild(count);
    }

    const body = document.createElement('div');
    body.className = 'thread-body';
    body.appendChild(commentCard(top));
    if (replies.length) {
      const nest = document.createElement('div');
      nest.className = 'reply-thread';
      replies.forEach(function (r) { nest.appendChild(commentCard(r, true)); });
      body.appendChild(nest);
    }
    appendReplyUI(body, top);

    function syncCaret() {
      const on = block.classList.contains('collapsed');
      caret.textContent = on ? '▸' : '▾';
      summary.title = on ? 'クリックで展開' : 'クリックで折りたたむ';
    }
    summary.addEventListener('click', function () {
      const on = !block.classList.contains('collapsed');
      block.classList.toggle('collapsed', on);
      setThreadCollapsed(top.id, on);
      syncCaret();
    });

    if (isThreadCollapsed(top, replies)) block.classList.add('collapsed');
    syncCaret();
    block.appendChild(summary);
    block.appendChild(body);
    container.appendChild(block);
  });
}

// `top` is the top-level comment of the thread. Replies POST only parentId +
// body; the server copies the anchor from the parent (so a reply can never
// drift from its thread) and normalizes parentId to the top-level id.
export function appendReplyUI(td, top) {
  const wrap = document.createElement('div');
  wrap.className = 'reply-wrap';
  const btn = document.createElement('button');
  btn.className = 'reply-toggle';
  btn.textContent = '返信';
  wrap.appendChild(btn);
  td.appendChild(wrap);

  btn.addEventListener('click', function () {
    btn.style.display = 'none';
    const form = document.createElement('div');
    form.className = 'reply-form';
    form.innerHTML =
      '<textarea placeholder="返信を入力（Ctrl+Enterで送信 / 画像はペーストで添付）"></textarea>' +
      intentFieldHtml() +
      '<div class="buttons">' +
      '<button class="primary reply-submit">返信する</button>' +
      '<button class="reply-cancel">キャンセル</button>' +
      '</div>';
    wrap.appendChild(form);
    syncIntentFields(form);
    const textarea = form.querySelector('textarea');
    const attachments = attachImagePaste(form, textarea);
    textarea.focus();

    function close() {
      form.remove();
      btn.style.display = '';
    }
    function submit() {
      const images = attachments.ids();
      if (attachments.busy()) {
        alert('画像をアップロード中です。完了までお待ちください。');
        return;
      }
      // An image alone is a valid reply; the server still requires a body.
      const body = textarea.value.trim() || (images.length ? '（画像添付）' : '');
      if (!body) return;
      (form.querySelector('.reply-submit') as any).disabled = true;
      api('POST', '/api/comments', {
        parentId: top.id,
        body: body,
        intent: selectedIntent(form),
        images: images,
      }).then(function () {
        // Close the form (removing its textarea) before refreshing so the
        // just-submitted text no longer counts as an in-progress draft;
        // otherwise the refresh defers forever and the form stays frozen.
        close();
        refresh();
      }).catch(function (err) {
        alert('返信の保存に失敗しました: ' + err);
        (form.querySelector('.reply-submit') as any).disabled = false;
      });
    }
    form.querySelector('.reply-submit').addEventListener('click', submit);
    form.querySelector('.reply-cancel').addEventListener('click', close);
    textarea.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
    });
  });
}
