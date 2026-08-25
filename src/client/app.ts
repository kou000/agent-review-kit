/* agent-review-kit review UI — entry module (compiled to ES modules, no bundler) */

import { api } from './api.js';
import { bodySnippet } from './dom.js';
import { syncIntentFields } from './intent.js';
import { restorePersistedWidths } from './resize.js';
import { badge, connState, DOC, state } from './state.js';
import { commentLocShort, setThreadCollapsed } from './threads.js';
import { setCollapsed } from './diff/collapse.js';
import {
  diffRefresh,
  renderCommitPage,
  renderDiff,
  renderFilePage,
  renderSnapshotPage,
} from './diff/render.js';
import { docRefresh, initDocMode } from './doc/index.js';

export function focusComment(id) {
  const card = document.querySelector(
    '.comment-card[data-comment-id="' + id + '"]'
  );
  if (!card) return;
  // A collapsed file box (chevron or 確認済み) hides everything but its
  // header, so a card inside it has no layout and scrollIntoView is a no-op.
  // Expand the box first; the viewed mark itself stays on.
  const fileBox = card.closest('.file');
  if (fileBox && fileBox.classList.contains('collapsed')) {
    setCollapsed(fileBox, false);
  }
  // A collapsed thread hides its cards; expand it before scrolling so the
  // jump from the sidebar always lands on something visible.
  const block: any = card.closest('.comment-thread-block');
  if (block && block.classList.contains('collapsed')) {
    block.classList.remove('collapsed');
    if (block.dataset.topId) setThreadCollapsed(block.dataset.topId, false);
    const caret = block.querySelector('.thread-caret');
    if (caret) caret.textContent = '▾';
  }
  if (typeof card.scrollIntoView === 'function') {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  card.classList.add('comment-flash');
  setTimeout(function () { card.classList.remove('comment-flash'); }, 1500);
}

/* ---------- agent response toasts ---------- */

// Notify (top-right toast) when the agent responds to a comment. The last
// notified state of each agentResponse is persisted in localStorage so a
// response is announced exactly once per browser, surviving the automatic
// page reload that follows `generate`.
// The key is per page (diff / each document): both page kinds overwrite the
// stored map with only the comments they can see, so sharing one key would
// let concurrently open pages wipe each other's baseline and re-notify.
const AGENT_SEEN_KEY = 'ark-agent-seen' + (DOC ? '-doc-' + DOC.id : '');
const TOAST_MS = 10000;

function ensureToastStack() {
  if (state.toastStack && document.body.contains(state.toastStack)) return state.toastStack;
  state.toastStack = document.createElement('div');
  state.toastStack.id = 'toast-stack';
  document.body.appendChild(state.toastStack);
  return state.toastStack;
}

function showToast(title, bodyText, onClick) {
  const stack = ensureToastStack();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');

  const head = document.createElement('div');
  head.className = 'toast-title';
  head.textContent = title;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', '通知を閉じる');

  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = bodyText;

  head.appendChild(close);
  t.appendChild(head);
  t.appendChild(body);
  stack.appendChild(t);

  function dismiss() {
    if (!t.parentNode) return;
    t.classList.add('toast-out');
    setTimeout(function () { t.remove(); }, 300);
  }
  close.addEventListener('click', function (e) {
    e.stopPropagation();
    dismiss();
  });
  if (onClick) {
    t.classList.add('clickable');
    t.addEventListener('click', function () {
      onClick();
      dismiss();
    });
  }
  setTimeout(dismiss, TOAST_MS);
}

// agentResponse.updatedAt changes on every agent resolve, so it (plus the
// message) uniquely identifies a response state. Comment status alone is
// excluded on purpose: the user's own Resolve click must not notify.
function agentFingerprint(c) {
  return c.agentResponse.updatedAt + '\u0000' + c.agentResponse.message;
}

export function notifyAgentUpdates(list) {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(AGENT_SEEN_KEY)); } catch (e) { stored = null; }
  // First run in this browser: record the baseline silently instead of
  // toasting every historical response at once.
  const first = !stored || typeof stored !== 'object';
  const seen = first ? {} : stored;
  const next = {};
  list.forEach(function (c) {
    if (!c.agentResponse || !c.agentResponse.message) return;
    const fp = agentFingerprint(c);
    next[c.id] = fp;
    if (!first && seen[c.id] !== fp) {
      showToast('エージェントが返信しました (' + c.status + ')',
        commentLocShort(c) + ' — ' + bodySnippet(c.agentResponse.message),
        function () { focusComment(c.id); });
    }
  });
  try { localStorage.setItem(AGENT_SEEN_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
}

export function renderBadge(status) {
  const unresolved = status ? status.unresolved : null;
  if (unresolved === null || unresolved === undefined) {
    badge.textContent = '-';
    return;
  }
  badge.textContent = '未解決 ' + unresolved;
  badge.className = 'badge' + (unresolved === 0 ? ' zero' : '');
}

// True while the user has an in-progress draft in any comment/reply form:
// either the textarea is focused, or it holds unsent text. Used to defer the
// 3s auto-refresh so re-rendering (which rebuilds thread rows) or a reload
// never wipes what they are typing. Deferral ends as soon as the draft is
// submitted, cleared, or blurred-empty; the next tick then catches up.
export function isEditingDraft() {
  const areas = document.querySelectorAll('.comment-form textarea, .reply-form textarea');
  for (let i = 0; i < areas.length; i++) {
    const ta: any = areas[i];
    if (document.activeElement === ta) return true;
    if (ta.value && ta.value.trim() !== '') return true;
  }
  return false;
}

// Shared entry point: every "something changed, re-sync" call site uses
// refresh(), so it dispatches on the page mode.
export function refresh() {
  return DOC ? docRefresh() : diffRefresh();
}

/* ---------- topbar controls (settings gear + mode badge) ---------- */

// Every place that learns the current settings (status poll, settings PUT
// response) routes through here, so the read-only badge and the intent
// selectors can never disagree with the server.
export function applySettings(settings) {
  if (!settings) return;
  state.readOnlyMode = !!settings.readOnlyMode;
  syncIntentFields();
  if (state.modeBadge) state.modeBadge.hidden = !state.readOnlyMode;
}

export function updateBranchLabel(branch) {
  if (!state.branchLabel || !branch) return;
  state.branchLabel.textContent = '⎇ ' + branch;
  state.branchLabel.title = 'レビュー対象ブランチ（コメント等はブランチ単位で管理されます）';
}

function closeSettingsPanel() {
  if (state.settingsPanel) {
    state.settingsPanel.remove();
    state.settingsPanel = null;
  }
}

function openSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.innerHTML =
    '<div class="settings-title">設定</div>' +
    '<label class="settings-row"><input type="checkbox" data-key="snapshotsEnabled">' +
    '<span>修正スナップショットを保存する' +
    '<span class="settings-hint">修正ごとに差分ページを作る（コミットは作らない）</span></span></label>' +
    '<label class="settings-row"><input type="checkbox" data-key="readOnlyMode">' +
    '<span>読み取り専用モード' +
    '<span class="settings-hint">エージェントはコードを修正せず、コメントへの回答のみ行う</span></span></label>' +
    '<label class="settings-row"><input type="checkbox" data-key="viewedAutoReset">' +
    '<span>差分が変わったファイルの確認済みを自動解除' +
    '<span class="settings-hint">OFFにすると、修正で差分が変わっても確認済みを維持する（手動解除は可能）</span></span></label>' +
    '<label class="settings-row"><input type="checkbox" data-key="deliveryNoteEnabled">' +
    '<span>コメント配信時に指示（note）を同梱' +
    '<span class="settings-hint">受信のたびに下のテキストを処理指示としてエージェントに渡す</span></span></label>' +
    '<label class="settings-row settings-row-text"><span>同梱する指示テキスト' +
    '<span class="settings-hint">既定は「修正はサブエージェントに委譲する」指示。自由に書き換えられる（空なら送らない）</span>' +
    '<textarea data-text-key="deliveryNoteText" rows="3" ' +
    'placeholder="例: 修正後は必ず npm test を実行すること"></textarea></span></label>' +
    '<div class="settings-footnote">ここでの変更は現在のブランチにだけ保存されます。' +
    '自分の定番の初期値（指示テキスト等）は <code>.agent-review/.env</code> に ' +
    '<code>ARK_*</code> で定義でき、全ブランチに効きます（書式は README「設定のデフォルト（.env）」参照）。</div>';
  document.body.appendChild(panel);
  state.settingsPanel = panel;

  api('GET', '/api/settings').then(function (data) {
    panel.querySelectorAll('input[data-key]').forEach(function (input: any) {
      input.checked = !!(data.settings && data.settings[input.dataset.key]);
      input.addEventListener('change', function () {
        const body = {};
        body[input.dataset.key] = input.checked;
        api('PUT', '/api/settings', body).then(function (r) {
          applySettings(r.settings);
        }).catch(function (err) {
          input.checked = !input.checked;
          alert('設定の保存に失敗しました: ' + err);
        });
      });
    });
    panel.querySelectorAll('textarea[data-text-key]').forEach(function (area: any) {
      const saved = (data.settings && data.settings[area.dataset.textKey]) || '';
      area.value = saved;
      // Saved on change (= blur after an edit), not per keystroke.
      area.addEventListener('change', function () {
        const body = {};
        body[area.dataset.textKey] = area.value;
        api('PUT', '/api/settings', body).then(function (r) {
          applySettings(r.settings);
        }).catch(function (err) {
          alert('設定の保存に失敗しました: ' + err);
        });
      });
    });
  }).catch(function () {
    panel.innerHTML = '<div class="settings-title">設定を読み込めませんでした</div>';
  });
}

export function setupTopbarControls() {
  const inner = document.querySelector('#topbar .topbar-inner');
  if (!inner) return;

  // conn-state carries margin-left:auto, so everything appended after it
  // (badge, gear) sits at the right edge of the topbar.
  state.branchLabel = document.createElement('span');
  state.branchLabel.id = 'branch-label';
  inner.appendChild(state.branchLabel);

  state.modeBadge = document.createElement('span');
  state.modeBadge.id = 'mode-badge';
  state.modeBadge.textContent = '読み取り専用';
  state.modeBadge.title = '読み取り専用モード: エージェントはコードを修正せず回答のみ行います';
  state.modeBadge.hidden = true;
  inner.appendChild(state.modeBadge);

  const finishBtn = document.createElement('button');
  finishBtn.id = 'finish-btn';
  finishBtn.type = 'button';
  finishBtn.textContent = 'レビュー終了';
  finishBtn.title = 'レビューを終了する（コメント待機とサーバーを停止）';
  finishBtn.addEventListener('click', finishReview);
  inner.appendChild(finishBtn);

  const gear = document.createElement('button');
  gear.id = 'settings-btn';
  gear.type = 'button';
  gear.textContent = '⚙';
  gear.title = '設定';
  gear.addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.settingsPanel) closeSettingsPanel();
    else openSettingsPanel();
  });
  inner.appendChild(gear);

  // Click anywhere outside closes the panel.
  document.addEventListener('click', function (e) {
    if (state.settingsPanel && !state.settingsPanel.contains(e.target)) closeSettingsPanel();
  });
}

// End the review from the browser. The server dismisses untouched AI
// findings, signals wait-comments to exit, and then shuts itself down —
// so stop polling and cover the page with a done overlay.
function finishReview() {
  const msg =
    'レビューを終了しますか？\n' +
    '未対応の AI 指摘は見送り（dismissed）になり、コメント待機とサーバーを停止します。';
  if (!confirm(msg)) return;
  api('POST', '/api/finish', {}).then(function () {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    connState.textContent = 'レビューを終了しました';
    const overlay = document.createElement('div');
    overlay.id = 'finish-overlay';
    overlay.innerHTML =
      '<div class="finish-box">' +
      '<div class="finish-title">レビューを終了しました</div>' +
      '<div class="finish-note">サーバーは停止しました。このタブは閉じて構いません。<br>' +
      'レビューを再開するには agent-review-kit generate / serve を再実行してください。</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }).catch(function (err) {
    alert('レビュー終了に失敗しました: ' + err);
  });
}

/* ---------- back to top ---------- */

// Fixed round button (bottom-right) that scrolls to the top. Shown only once
// the page is scrolled past a threshold so it stays out of the way otherwise.
function setupScrollTop() {
  const btn = document.createElement('button');
  btn.id = 'scroll-top';
  btn.type = 'button';
  btn.title = 'TOPへ戻る';
  btn.setAttribute('aria-label', 'ページ上部へ戻る');
  btn.textContent = '↑';
  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.body.appendChild(btn);

  const THRESHOLD = 400;
  function update() {
    const y = window.pageYOffset || window.scrollY || 0;
    btn.classList.toggle('visible', y > THRESHOLD);
  }
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// Standalone views: /commit/<sha> (window.__COMMIT__), /snapshot/<id>
// (window.__SNAPSHOT__) and /file/<path> (window.__FILE__). All reuse the
// read-only renderers and skip the interactive review chrome — no comments,
// forms, polling or reloads. Bail out before any of that is wired.
function main() {
  if (window.__COMMIT__ || window.__SNAPSHOT__ || window.__FILE__) {
    restorePersistedWidths();
    if (window.__COMMIT__) renderCommitPage();
    else if (window.__SNAPSHOT__) renderSnapshotPage();
    else renderFilePage();
    setupScrollTop();
    return;
  }

  // HTML document review (/doc/<id>): its own layout and refresh loop; none
  // of the diff chrome below applies.
  if (DOC) {
    initDocMode();
    return;
  }

  restorePersistedWidths();
  setupTopbarControls();
  renderDiff();
  refresh();
  state.refreshTimer = setInterval(refresh, 3000);
  setupScrollTop();
}

main();
