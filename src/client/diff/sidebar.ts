import { api } from '../api.js';
import { bodySnippet, esc } from '../dom.js';
import { attachSidebarResize } from '../resize.js';
import { app, DIFF, state } from '../state.js';
import {
  commentLocShort,
  isAgentComment,
  threadState,
  THREAD_STATE_LABEL,
  threadStructure,
} from '../threads.js';
import { focusComment } from '../app.js';
import { setCollapsed } from './collapse.js';
import { appendEditorLink } from './editorLink.js';
import { updatePinButtons } from './pins.js';
import { openRepoFile, renderRepoTree } from './repoView.js';
import { applyViewedState, isViewed, saveViewed } from './viewed.js';

/* ---------- file tree sidebar ---------- */

function statusMark(st) {
  return { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', binary: 'B' }[st] || 'M';
}

// Build a nested tree from a list of { file, index } entries, preserving each
// file's ORIGINAL DIFF.files index (so data-target file-<index> stays correct
// even when the entry list is a filtered subset). Directory branches are only
// created along included files' paths, so filtering also prunes empty dirs.
function buildTreeFrom(entries) {
  const root = { dirs: {}, files: [] };
  entries.forEach(function (e) {
    const parts = String(e.file.path).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      node.dirs[seg] = node.dirs[seg] || { dirs: {}, files: [] };
      node = node.dirs[seg];
    }
    node.files.push({ name: parts[parts.length - 1], index: e.index, file: e.file });
  });
  return root;
}

function buildTree(files) {
  return buildTreeFrom(files.map(function (file, fi) {
    return { file: file, index: fi };
  }));
}

// Shared comparator for files within a tree node (by name). Kept identical to
// the directory ordering (default string sort) so the tree and the main diff
// agree exactly.
export function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// The order in which files appear when walking the tree: directories first
// (recursively, name-sorted), then this node's own files (name-sorted).
// Returns the list of original DIFF.files indices in that display order.
// renderDiff and renderTreeNode both follow this exact ordering.
export function treeOrder(files) {
  const order = [];
  (function walk(node) {
    Object.keys(node.dirs).sort().forEach(function (name) {
      walk(node.dirs[name]);
    });
    node.files.slice().sort(byName).forEach(function (f) {
      order.push(f.index);
    });
  })(buildTree(files));
  return order;
}

function renderTreeNode(node, container, depth) {
  Object.keys(node.dirs).sort().forEach(function (name) {
    const dEl = document.createElement('div');
    dEl.className = 'tree-dir';
    dEl.style.paddingLeft = (4 + depth * 12) + 'px';
    dEl.textContent = name + '/';
    container.appendChild(dEl);
    renderTreeNode(node.dirs[name], container, depth + 1);
  });
  node.files.slice().sort(byName).forEach(function (f) {
    const fEl = document.createElement('div');
    fEl.className = 'tree-file';
    fEl.style.paddingLeft = (4 + depth * 12) + 'px';
    fEl.dataset.target = 'file-' + f.index;

    const mark = document.createElement('span');
    mark.className = 'tree-status tree-status-' + esc(f.file.status);
    mark.textContent = statusMark(f.file.status);

    const label = document.createElement('span');
    label.className = 'tree-name';
    label.textContent = f.name;
    label.title = f.file.path;

    const badge = document.createElement('span');
    badge.className = 'tree-count';
    badge.dataset.file = f.file.path;

    fEl.appendChild(mark);
    fEl.appendChild(label);
    fEl.appendChild(badge);
    fEl.addEventListener('click', function () {
      const el = document.getElementById('file-' + f.index);
      if (!el) return;
      // 確認済み等で折りたたまれていても、クリックで飛んだ先が読めるように
      // 展開してからスクロールする（確認済みマーク自体は維持する）。
      if (el.classList.contains('collapsed')) setCollapsed(el, false);
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    container.appendChild(fEl);
  });
}

// Create the .layout flex wrapper holding the (empty) tree sidebar, its drag
// resizer, and #app. Shared by the main review page and the standalone
// read-only pages. Returns the sidebar element, or null when already built /
// nothing to show.
function buildSidebarShell() {
  if (state.sidebarBuilt || !DIFF.files.length) return null;
  const parent = app.parentNode;
  if (!parent) return null;

  const layout = document.createElement('div');
  layout.className = 'layout';
  parent.insertBefore(layout, app);

  const sidebar = document.createElement('aside');
  sidebar.id = 'file-tree';
  sidebar.className = 'sidebar';

  // Vertical drag handle between the sidebar and #app.
  const resizer = document.createElement('div');
  resizer.className = 'sidebar-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでサイドバー幅を調整';
  attachSidebarResize(resizer, sidebar);

  layout.appendChild(sidebar);
  layout.appendChild(resizer);
  layout.appendChild(app); // move #app into the flex layout
  state.sidebarBuilt = true;
  return sidebar;
}

// File-tree-only sidebar for the standalone /commit and /snapshot pages:
// jump navigation over the read-only file boxes. No viewed split, comment
// list, or commits section — none of those apply there.
export function buildReadOnlySidebar() {
  const sidebar = buildSidebarShell();
  if (!sidebar) return;

  const heading = document.createElement('div');
  heading.className = 'sidebar-title';
  heading.textContent = 'ファイル (' + DIFF.files.length + ')';
  sidebar.appendChild(heading);

  const treeWrap = document.createElement('div');
  treeWrap.className = 'tree';
  renderTreeNode(buildTree(DIFF.files), treeWrap, 0);
  sidebar.appendChild(treeWrap);
  // No comments here: hide the (empty) per-file count badges the tree
  // renderer always creates.
  updateTreeCounts();
}

export function buildSidebar() {
  const sidebar = buildSidebarShell();
  if (!sidebar) return;
  const heading = document.createElement('div');
  heading.className = 'sidebar-title';
  heading.id = 'file-tree-title';
  sidebar.appendChild(heading);

  // Unviewed files render as the normal nested tree; viewed files move to a
  // flat "確認済み" section below it. Both are (re)filled by renderSidebarTree.
  const treeWrap = document.createElement('div');
  treeWrap.className = 'tree';
  sidebar.appendChild(treeWrap);

  const viewedWrap = document.createElement('div');
  viewedWrap.className = 'viewed-tree';
  viewedWrap.id = 'viewed-tree';
  sidebar.appendChild(viewedWrap);

  // Comment management list (filled/updated by renderCommentList on refresh).
  const cHeading = document.createElement('div');
  cHeading.className = 'sidebar-title sidebar-comments-title';
  cHeading.id = 'sidebar-comments-title';
  cHeading.textContent = 'コメント (0)';
  sidebar.appendChild(cHeading);

  const cList = document.createElement('div');
  cList.className = 'comment-list';
  sidebar.appendChild(cList);

  // Commits under review (base..HEAD), like GitHub's Commits tab. Fetched
  // once per page load; `generate` triggers a full reload, which refetches.
  const commitHeading = document.createElement('div');
  commitHeading.className = 'sidebar-title sidebar-commits-title';
  commitHeading.id = 'sidebar-commits-title';
  const commitList = document.createElement('div');
  commitList.className = 'commit-list';
  commitList.id = 'sidebar-commit-list';
  sidebar.appendChild(commitHeading);
  sidebar.appendChild(commitList);
  loadCommitList(commitHeading, commitList);

  // Repository file viewer (support feature): a collapsed-by-default section
  // listing every repository file (untracked included, ignored excluded).
  // The list loads lazily on first expand;
  // clicking a file opens it read-only in the pin stack (see openRepoFile).
  const repoHeading = document.createElement('div');
  repoHeading.className = 'sidebar-title repo-tree-title';
  repoHeading.title = 'クリックで開閉。差分に含まれないファイルも参照できます';
  // The toggle rewrites the label text, so it lives in its own span — the
  // ↗ link after it survives every open/close.
  const repoLabel = document.createElement('span');
  repoLabel.textContent = '▸ リポジトリのファイル';
  repoHeading.appendChild(repoLabel);
  // Both heading buttons live in one box so the narrow sidebar can drop them
  // to a second row as a group (see .repo-tree-actions): with the buttons as
  // direct flex children of the heading, there was no room left for the label
  // at the default 260px width and it wrapped one character per line.
  const repoActions = document.createElement('div');
  repoActions.className = 'repo-tree-actions';
  repoHeading.appendChild(repoActions);
  // 「ツリーを別タブで開く」: the standalone /files page keeps its tree state
  // across the review page's auto reloads.
  const repoTreeOpen = document.createElement('a');
  repoTreeOpen.className = 'repo-tree-open';
  repoTreeOpen.href = '/files';
  repoTreeOpen.target = '_blank';
  repoTreeOpen.rel = 'noopener';
  repoTreeOpen.title = 'リポジトリのファイル一覧を別タブで開く';
  repoTreeOpen.textContent = '別タブで開く ↗';
  repoTreeOpen.addEventListener('click', function (e) { e.stopPropagation(); });
  repoActions.appendChild(repoTreeOpen);
  // 「<editor> で開く」: opens this repository (not a single file) in the local
  // editor via settings.editorUriTemplate. Appended asynchronously — it needs
  // projectDir from GET /api/status.
  appendEditorLink(repoActions);
  sidebar.appendChild(repoHeading);
  const repoWrap = document.createElement('div');
  repoWrap.className = 'repo-tree';
  repoWrap.hidden = true;
  sidebar.appendChild(repoWrap);
  let repoLoaded = false;
  repoHeading.addEventListener('click', function () {
    const open = repoWrap.hidden;
    repoWrap.hidden = !open;
    repoLabel.textContent = (open ? '▾' : '▸') + ' リポジトリのファイル';
    if (open && !repoLoaded) {
      repoLoaded = true;
      repoWrap.textContent = '読み込み中…';
      api('GET', '/api/repo-files').then(function (data) {
        repoWrap.textContent = '';
        renderRepoTree(data.files || [], repoWrap);
        updatePinButtons(); // mark rows whose panel is already open
      }).catch(function (err) {
        repoLoaded = false;
        repoWrap.textContent = '取得に失敗しました: ' + err;
      });
    }
  });

  // Populate the tree/確認済み sections now that the sidebar is in the DOM
  // (renderSidebarTree looks its containers up by id/selector).
  renderSidebarTree();
}

// Fill the sidebar commits section: base..HEAD, newest first, each row
// opening the existing /commit/<sha> diff page in a new tab. The heading
// toggles the list (collapsed by default to keep the sidebar compact). With
// no base or no commits the whole section stays hidden.
function loadCommitList(heading, list) {
  heading.style.display = 'none';
  list.style.display = 'none';
  api('GET', '/api/commits').then(function (data) {
    const commits = data.commits || [];
    if (!commits.length) return;
    heading.style.display = '';
    let collapsed = true;
    function syncHeading() {
      heading.textContent = (collapsed ? '▸' : '▾') + ' コミット (' + commits.length + ')';
      list.style.display = collapsed ? 'none' : '';
    }
    heading.addEventListener('click', function () {
      collapsed = !collapsed;
      syncHeading();
    });
    heading.title = 'クリックで開閉';
    syncHeading();

    commits.forEach(function (cm) {
      const item = document.createElement('div');
      item.className = 'commit-item';
      item.title = cm.subject + '\n' + cm.author + ' — ' + cm.date;

      const sha = document.createElement('span');
      sha.className = 'commit-item-sha';
      sha.textContent = cm.shortSha;

      const subject = document.createElement('span');
      subject.className = 'commit-item-subject';
      subject.textContent = cm.subject;

      item.appendChild(sha);
      item.appendChild(subject);
      item.addEventListener('click', function () {
        window.open('/commit/' + encodeURIComponent(cm.sha), '_blank', 'noopener');
      });
      list.appendChild(item);
    });
  }).catch(function () { /* auxiliary; ignore fetch failures */ });
}

// (Re)render the sidebar tree: unviewed files as the nested tree, viewed files
// as the nested "確認済み" tree below it, plus the progress title. Called after every
// viewed toggle and once on initial sidebar build. Refreshes comment counts on
// both lists since it recreates their badge elements.
export function renderSidebarTree() {
  const title = document.getElementById('file-tree-title');
  const treeWrap = document.querySelector('.sidebar .tree');
  const viewedWrap = document.getElementById('viewed-tree');
  if (!treeWrap || !viewedWrap) return;

  const unviewedEntries = [];
  const viewedEntries = [];
  DIFF.files.forEach(function (f, i) {
    (isViewed(f.path) ? viewedEntries : unviewedEntries).push({ file: f, index: i });
  });

  if (title) {
    title.textContent = 'ファイル (未確認 ' + unviewedEntries.length +
      ' / 全 ' + DIFF.files.length + ')';
  }

  treeWrap.innerHTML = '';
  renderTreeNode(buildTreeFrom(unviewedEntries), treeWrap, 0);

  viewedWrap.innerHTML = '';
  if (viewedEntries.length) {
    const h = document.createElement('div');
    h.className = 'sidebar-title viewed-title';
    h.textContent = '確認済み (' + viewedEntries.length + ')';

    // Bulk revert: clears every mark and re-expands the file boxes, so a
    // full re-review never needs a per-file un-toggle.
    const clearBtn = document.createElement('button');
    clearBtn.className = 'viewed-clear-btn';
    clearBtn.type = 'button';
    clearBtn.textContent = 'すべて解除';
    clearBtn.title = 'すべてのファイルの確認済みを解除する';
    clearBtn.addEventListener('click', function () {
      if (!confirm('すべてのファイルの確認済みを解除しますか？')) return;
      state.viewed = {};
      saveViewed();
      applyViewedState();
    });
    h.appendChild(clearBtn);
    viewedWrap.appendChild(h);

    const list = document.createElement('div');
    list.className = 'viewed-list';
    renderTreeNode(buildTreeFrom(viewedEntries), list, 0);
    viewedWrap.appendChild(list);
  }

  updateTreeCounts();
}

// Tree badges answer "what is still on my plate in this file?": they count
// threads (not individual comments, so a long back-and-forth stays 1), drop
// settled ones entirely, and take their colour from 要確認 — the state where
// the ball is in the user's court. 未解決 waits on the agent, so it gets the
// quieter blue.
export function updateTreeCounts() {
  const counts = {}; // path -> { check, open }
  const s = threadStructure(state.comments);
  s.tops.forEach(function (top) {
    if (top.file === null || top.file === undefined) return;
    const state = threadState(top, s.repliesByParent[top.id] || []);
    if (state === 'settled') return;
    const entry = counts[top.file] || (counts[top.file] = { check: 0, open: 0 });
    entry[state] += 1;
  });
  document.querySelectorAll('.tree-count[data-file]').forEach(function (el: any) {
    const entry = counts[el.dataset.file];
    const n = entry ? entry.check + entry.open : 0;
    el.textContent = n ? String(n) : '';
    el.style.display = n ? '' : 'none';
    el.className = 'tree-count' + (n && !entry.check ? ' tree-count-open' : '');
    el.title = n ? '要確認 ' + entry.check + ' / 未解決 ' + entry.open : '';
  });
}

// One sidebar row per thread. Replies get no row of their own — their
// statuses are already folded into `state` — so a thread reads as a single
// unresolved/settled unit; only the reply count is shown.
function threadListItem(top, replies, state) {
  const item = document.createElement('div');
  item.className = 'comment-item comment-item-' + state;
  item.title = commentLocShort(top) + ' — ' + top.body +
    (replies.length ? '\n（返信 ' + replies.length + '）' : '');

  const pill = document.createElement('span');
  pill.className = 'status-pill thread-state-' + state;
  pill.textContent = THREAD_STATE_LABEL[state];

  const loc = document.createElement('span');
  loc.className = 'comment-item-loc';
  loc.textContent = commentLocShort(top);

  const body = document.createElement('span');
  body.className = 'comment-item-body';
  body.textContent = bodySnippet(top.body);

  if (isAgentComment(top)) {
    const who = document.createElement('span');
    who.className = 'who-pill';
    who.textContent = 'AI';
    item.appendChild(who);
  }
  item.appendChild(pill);
  item.appendChild(loc);
  item.appendChild(body);
  if (replies.length) {
    const count = document.createElement('span');
    count.className = 'comment-item-replies';
    count.textContent = '↳' + replies.length;
    item.appendChild(count);
  }
  item.addEventListener('click', function () { focusComment(top.id); });
  return item;
}

// Re-render the sidebar comment list. Called on the same cadence as
// updateTreeCounts (from renderComments) so it tracks every refresh. Threads
// are ordered 要確認 → 未解決 → 解決済み — 要確認 first because that is the
// only group the user can act on. Within a group, createdAt asc
// (threadStructure already sorts the top-level comments).
export function renderCommentList() {
  const list = document.querySelector('.sidebar .comment-list');
  if (!list) return;
  list.innerHTML = '';

  const s = threadStructure(state.comments);
  const groups = { open: [], check: [], settled: [] };
  s.tops.forEach(function (top) {
    const replies = s.repliesByParent[top.id] || [];
    groups[threadState(top, replies)].push({ top: top, replies: replies });
  });

  const title = document.getElementById('sidebar-comments-title');
  if (title) {
    let text = 'コメント (';
    if (groups.check.length) text += '要確認 ' + groups.check.length + ' / ';
    title.textContent = text + '未解決 ' + groups.open.length +
      ' / 全 ' + s.tops.length + ')';
  }

  function append(target, entries, state) {
    entries.forEach(function (e) {
      target.appendChild(threadListItem(e.top, e.replies, state));
    });
  }
  append(list, groups.check, 'check');
  append(list, groups.open, 'open');
  if (!groups.settled.length) return;

  const heading = document.createElement('div');
  heading.className = 'comment-resolved-title';
  heading.title = 'クリックで開閉';
  const holder = document.createElement('div');
  append(holder, groups.settled, 'settled');
  function syncHeading() {
    heading.textContent = (state.resolvedListOpen ? '▾' : '▸') +
      ' 解決済み (' + groups.settled.length + ')';
    holder.style.display = state.resolvedListOpen ? '' : 'none';
  }
  heading.addEventListener('click', function () {
    state.resolvedListOpen = !state.resolvedListOpen;
    syncHeading();
  });
  syncHeading();
  list.appendChild(heading);
  list.appendChild(holder);
}
