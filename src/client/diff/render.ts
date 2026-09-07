import { api } from '../api.js';
import { copyPathButton, esc, fmtDate, openFileTabButton } from '../dom.js';
import { attachImagePaste } from '../images.js';
import { intentFieldHtml, selectedIntent, syncIntentFields } from '../intent.js';
import { app, connState, DIFF, diffMeta, state } from '../state.js';
import {
  applySettings,
  isEditingDraft,
  notifyAgentUpdates,
  refresh,
  renderBadge,
  updateBranchLabel,
} from '../app.js';
import { appendCollapseToggle, setCollapsed } from './collapse.js';
import { renderComments } from './comments.js';
import { togglePin } from './pins.js';
import { buildFileTable } from './repoView.js';
import { buildReadOnlySidebar, buildSidebar, renderSidebarTree, treeOrder } from './sidebar.js';
import { buildDiffTable } from './table.js';
import {
  applyViewedState,
  computeFileHashes,
  isViewed,
  loadViewed,
  setFileViewed,
  updateViewedButton,
} from './viewed.js';

/* ---------- diff rendering ---------- */

/* ---------- syntax highlighting ----------
 * Highlighting is baked at generate time by Shiki (github-dark) into each
 * diff cell's `html` field (see codeCell). The client only renders that
 * pre-colored markup, so there is no runtime highlighter here. */

function statusLabel(st) {
  return { modified: 'modified', added: 'added', deleted: 'deleted', renamed: 'renamed', binary: 'binary' }[st] || st;
}

export function renderDiff() {
  diffMeta.textContent = (DIFF.base ? 'base: ' + DIFF.base : 'working tree vs HEAD') +
    ' / generated: ' + fmtDate(DIFF.generatedAt);

  // Compute per-file content hashes up front. Persisted viewed state is
  // fetched from the server asynchronously (see below) and applied once the
  // boxes exist, so `viewed` starts empty and every file builds as unviewed.
  computeFileHashes();
  state.viewed = {};

  state.expanders = {};

  const frag = document.createDocumentFragment();

  if (DIFF.files.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '行番号をクリックでコメント、Shift+クリックまたはドラッグで範囲選択できます。';
    frag.appendChild(hint);
  }

  // Overall (not tied to a file/line) comments section, always present.
  frag.appendChild(buildOverallSection());

  if (!DIFF.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-diff';
    empty.innerHTML = '差分がありません。変更を加えてから <code>agent-review-kit generate</code> を再実行してください。';
    frag.appendChild(empty);
    app.innerHTML = '';
    app.appendChild(frag);
    renderComments();
    return;
  }

  // Render .file boxes in tree-traversal order (see treeOrder) so the main
  // diff order matches the sidebar tree. `fi` stays the file's original index
  // in DIFF.files, keeping id (file-<index>) and tree data-target in sync.
  treeOrder(DIFF.files).forEach(function (fi) {
    const file = DIFF.files[fi];
    const box = document.createElement('div');
    box.className = 'file';
    box.id = 'file-' + fi;
    box.dataset.file = file.path;

    const header = document.createElement('div');
    header.className = 'file-header';
    let title = esc(file.path);
    if (file.status === 'renamed' && file.oldPath !== file.path) {
      title = esc(file.oldPath) + ' → ' + esc(file.path);
    }
    header.innerHTML = '<span class="file-status ' + esc(file.status) + '">' +
      esc(statusLabel(file.status)) + '</span><span class="file-name">' + title + '</span>';

    // Collapse toggle (chevron at the far left of the header): hides/shows the
    // file body only. Independent of 確認済み (viewed) and not persisted.
    appendCollapseToggle(header, box);

    header.appendChild(copyPathButton(file.path));
    // 削除されたファイルは working tree に無いので /file/<path> が開けない。
    if (file.status !== 'deleted') header.appendChild(openFileTabButton(file.path));

    // 確認済み (Viewed) toggle: collapses this file's body (via the shared
    // 'collapsed' class) and moves it to the "確認済み" section of the tree.
    // Placed to the left of 📌. Checkbox-like.
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'viewed-btn';
    viewBtn.dataset.file = file.path;
    viewBtn.setAttribute('aria-label', 'このファイルを確認済みにする');
    viewBtn.innerHTML =
      '<span class="viewed-check" aria-hidden="true"></span>' +
      '<span class="viewed-label">確認済み</span>';
    viewBtn.addEventListener('click', function () {
      const on = !isViewed(file.path);
      setFileViewed(file.path, on);
      box.classList.toggle('viewed', on);
      setCollapsed(box, on);
      updateViewedButton(viewBtn, on);
      renderSidebarTree();
    });
    header.appendChild(viewBtn);

    // 📌 pin button: opens/refreshes the right-side display-only panel for
    // this file. `fi` is the file's original index in DIFF.files.
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'pin-btn';
    pinBtn.textContent = '📌';
    pinBtn.title = 'このファイルを右側パネルに固定表示（表示専用）';
    pinBtn.setAttribute('aria-label', 'このファイルを右側パネルに固定表示');
    pinBtn.dataset.fileIndex = fi;
    pinBtn.addEventListener('click', function () { togglePin(fi); });
    header.appendChild(pinBtn);

    // Apply persisted viewed state (collapse + button visuals) up front.
    // At initial build time `viewed` is always empty (loaded async below),
    // so these are effectively no-ops; kept for consistency.
    if (isViewed(file.path)) {
      box.classList.add('viewed');
      setCollapsed(box, true);
    }
    updateViewedButton(viewBtn, isViewed(file.path));

    box.appendChild(header);

    if (file.status === 'binary' || !file.hunks.length) {
      const p = document.createElement('div');
      p.className = 'empty-diff';
      p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
      box.appendChild(p);
      frag.appendChild(box);
      return;
    }

    box.appendChild(buildDiffTable(file, true));
    frag.appendChild(box);
  });

  app.innerHTML = '';
  app.appendChild(frag);
  buildSidebar();
  renderComments();

  // Fetch persisted viewed state and apply it to the freshly built boxes.
  // Done after the DOM exists (and after renderComments) so async ordering
  // never leaves comments unrendered; a brief all-unviewed flash is fine.
  loadViewed().then(applyViewedState);
}

// Shared by the standalone /commit and /snapshot pages: same file boxes and
// diff tables as renderDiff (tree-traversal order, matching the sidebar
// tree). Collapse chevrons are included (same as the main diff); viewed/pin
// buttons and comment wiring are not. Context expanders still appear when the
// server embedded new-side content (newLines) for the page.
function renderReadOnlyFiles(frag, emptyText) {
  if (!DIFF.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-diff';
    empty.textContent = emptyText;
    frag.appendChild(empty);
  }

  treeOrder(DIFF.files).forEach(function (fi) {
    const file = DIFF.files[fi];
    const box = document.createElement('div');
    box.className = 'file';
    box.id = 'file-' + fi;
    box.dataset.file = file.path;

    const header = document.createElement('div');
    header.className = 'file-header';
    let title = esc(file.path);
    if (file.status === 'renamed' && file.oldPath !== file.path) {
      title = esc(file.oldPath) + ' → ' + esc(file.path);
    }
    header.innerHTML = '<span class="file-status ' + esc(file.status) + '">' +
      esc(statusLabel(file.status)) + '</span><span class="file-name">' + title + '</span>';
    appendCollapseToggle(header, box);
    header.appendChild(copyPathButton(file.path));
    if (file.status !== 'deleted') header.appendChild(openFileTabButton(file.path));
    box.appendChild(header);

    if (file.status === 'binary' || !file.hunks.length) {
      const p = document.createElement('div');
      p.className = 'empty-diff';
      p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
      box.appendChild(p);
    } else {
      box.appendChild(buildDiffTable(file, false));
    }
    frag.appendChild(box);
  });
}

// Read-only render for the /commit/<sha> page (window.__COMMIT__ set).
export function renderCommitPage() {
  const c = window.__COMMIT__;
  diffMeta.textContent = c.shortSha + ' / ' + c.author + ' / ' + fmtDate(c.date);

  state.expanders = {};

  const frag = document.createDocumentFragment();

  const banner = document.createElement('div');
  banner.className = 'commit-banner';
  banner.innerHTML =
    '<div class="commit-subject"></div><div class="commit-meta-line"></div>';
  banner.querySelector('.commit-subject').textContent = c.subject;
  banner.querySelector('.commit-meta-line').textContent =
    'commit ' + c.sha + ' — ' + c.author + ' — ' + fmtDate(c.date);
  frag.appendChild(banner);

  renderReadOnlyFiles(frag, 'このコミットには差分がありません。');

  app.innerHTML = '';
  app.appendChild(frag);
  buildReadOnlySidebar();
}

// Read-only render for the /snapshot/<id> page (window.__SNAPSHOT__ set):
// one fix's diff, captured as a patch instead of a commit. The banner names
// the review comment the fix responds to.
export function renderSnapshotPage() {
  const s = window.__SNAPSHOT__;
  diffMeta.textContent = '修正 #' + s.seq + ' / ' + fmtDate(s.createdAt);

  state.expanders = {};

  const frag = document.createDocumentFragment();

  const banner = document.createElement('div');
  banner.className = 'commit-banner';
  banner.innerHTML =
    '<div class="commit-subject"></div><div class="commit-meta-line"></div>' +
    '<div class="snapshot-comment"></div>';
  banner.querySelector('.commit-subject').textContent =
    s.title || ('修正スナップショット #' + s.seq);
  banner.querySelector('.commit-meta-line').textContent =
    'snapshot ' + s.id + ' — 修正 #' + s.seq + ' — ' + fmtDate(s.createdAt) +
    ' — コメント ' + s.commentId;
  const commentEl = banner.querySelector('.snapshot-comment');
  if (s.commentBody) {
    commentEl.textContent = '対象コメント: ' + s.commentBody;
  } else {
    commentEl.remove();
  }
  frag.appendChild(banner);

  renderReadOnlyFiles(frag, 'このスナップショットには差分がありません。');

  app.innerHTML = '';
  app.appendChild(frag);
  buildReadOnlySidebar();
}

/* ---------- overall comments ---------- */

// A fresh section is created on every renderDiff (which wipes #app). It holds
// the list of file:null comments (filled by renderComments) plus a post form.
function buildOverallSection() {
  const sec = document.createElement('section');
  sec.className = 'overall-section';
  sec.innerHTML =
    '<h2>全体コメント</h2>' +
    '<p class="hint">ファイルや行に紐づかない、レビュー全体への指摘・質問。</p>' +
    '<div class="overall-list"></div>' +
    '<div class="overall-form comment-form">' +
    '<textarea placeholder="レビュー全体へのコメント（Ctrl+Enterで送信 / 画像はペーストで添付）"></textarea>' +
    intentFieldHtml() +
    '<div class="buttons"><button class="primary overall-submit">コメントを追加</button></div>' +
    '</div>';

  const form = sec.querySelector('.overall-form');
  const textarea = sec.querySelector('textarea');
  const btn: any = sec.querySelector('.overall-submit');
  syncIntentFields(form);
  const attachments = attachImagePaste(form, textarea);

  function submit() {
    const images = attachments.ids();
    if (attachments.busy()) {
      alert('画像をアップロード中です。完了までお待ちください。');
      return;
    }
    // An image alone is a valid comment; the server still requires a body.
    const body = textarea.value.trim() || (images.length ? '（画像添付）' : '');
    if (!body) return;
    btn.disabled = true;
    api('POST', '/api/comments', {
      body: body,
      intent: selectedIntent(form),
      images: images,
    }).then(function () {
      textarea.value = '';
      attachments.clear();
      // Blur so a Ctrl+Enter submit (which keeps focus) doesn't leave the
      // textarea as activeElement — isEditingDraft() would otherwise defer
      // the refresh forever and the new comment would never appear.
      textarea.blur();
      btn.disabled = false;
      refresh();
    }).catch(function (err) {
      alert('コメントの保存に失敗しました: ' + err);
      btn.disabled = false;
    });
  }

  btn.addEventListener('click', submit);
  textarea.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
  });
  return sec;
}

// Standalone read-only page for one repository file (/file/<path>,
// window.__FILE__ set): just the file header and the full-file table.
export function renderFilePage() {
  const f = window.__FILE__;
  diffMeta.textContent = f.path;
  const box = document.createElement('section');
  box.className = 'file';
  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML = '<span class="file-name"></span>';
  header.querySelector('.file-name').textContent = f.path;
  header.appendChild(copyPathButton(f.path));
  box.appendChild(header);
  box.appendChild(buildFileTable(f));
  app.appendChild(box);
}

export function diffRefresh() {
  return Promise.all([
    api('GET', '/api/comments'),
    api('GET', '/api/status'),
  ]).then(function (results) {
    // Soft-deleted comments never render, and HTML-document comments
    // (documentId set, file null) belong to their /doc/<id> page — without
    // this filter they would leak into the overall section here. Manual-edit
    // records (manualEdit) are agent-facing notifications, never shown.
    // Filtering at the single entry point covers every consumer: threads,
    // sidebar list and tree counts.
    const cs = (results[0].comments || []).filter(function (c) {
      return !c.deleted && !c.documentId && !c.manualEdit;
    });
    const status = results[1];
    // Never yank the DOM out from under an in-progress draft. Leave
    // lastCommentsJson untouched so the change is re-detected next tick.
    if (isEditingDraft()) {
      connState.textContent = '入力中のため更新を保留中…';
      return;
    }
    connState.textContent = '';
    if (status.generatedAt && DIFF.generatedAt && status.generatedAt !== DIFF.generatedAt) {
      location.reload();
      return;
    }
    // status.unresolved is branch-wide (it includes HTML-document
    // comments); this page's badge counts only what it can show.
    let unresolved = 0;
    cs.forEach(function (c) {
      if (c.status === 'open' || c.status === 'seen') unresolved++;
    });
    renderBadge({ unresolved: unresolved });
    applySettings(status.settings);
    updateBranchLabel(status.branch);
    const json = JSON.stringify(cs);
    if (json !== state.lastCommentsJson) {
      state.lastCommentsJson = json;
      state.comments = cs;
      renderComments();
      notifyAgentUpdates(cs);
    }
  }).catch(function () {
    connState.textContent = 'サーバー未接続（agent-review-kit serve を起動してください）';
  });
}
