/* agent-review-kit review UI (no build step, plain JS) */
(function () {
  'use strict';

  const DIFF = window.__DIFF__ || { files: [], base: null, generatedAt: '' };
  const app = document.getElementById('app');
  const badge = document.getElementById('unresolved-badge');
  const diffMeta = document.getElementById('diff-meta');
  const connState = document.getElementById('conn-state');

  let comments = [];
  let selection = null; // {file, side, anchor:{line,diffLine}, head:{line,diffLine}}
  let openForm = null; // form row element currently shown
  let dragging = false;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- diff rendering ---------- */

  function statusLabel(st) {
    return { modified: 'modified', added: 'added', deleted: 'deleted', renamed: 'renamed', binary: 'binary' }[st] || st;
  }

  function renderDiff() {
    diffMeta.textContent = (DIFF.base ? 'base: ' + DIFF.base : 'working tree vs HEAD') +
      ' / generated: ' + fmtDate(DIFF.generatedAt);

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
        esc(statusLabel(file.status)) + '</span><span>' + title + '</span>';
      box.appendChild(header);

      if (file.status === 'binary' || !file.hunks.length) {
        const p = document.createElement('div');
        p.className = 'empty-diff';
        p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
        box.appendChild(p);
        frag.appendChild(box);
        return;
      }

      const table = document.createElement('table');
      table.className = 'diff';
      const colgroup = document.createElement('colgroup');
      colgroup.innerHTML =
        '<col class="col-num"><col class="col-code"><col class="col-num"><col class="col-code">';
      table.appendChild(colgroup);
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);

      file.hunks.forEach(function (hunk) {
        const hr = document.createElement('tr');
        hr.className = 'hunk';
        hr.innerHTML = '<td colspan="4">' + esc(hunk.header) + '</td>';
        tbody.appendChild(hr);

        hunk.rows.forEach(function (row) {
          const tr = document.createElement('tr');
          tr.className = 'diff-row';
          tr.appendChild(numCell(file, 'old', row.left));
          tr.appendChild(codeCell(row.left, 'del'));
          tr.appendChild(numCell(file, 'new', row.right));
          tr.appendChild(codeCell(row.right, 'add'));
          tbody.appendChild(tr);
        });
      });

      box.appendChild(table);
      frag.appendChild(box);
    });

    app.innerHTML = '';
    app.appendChild(frag);
    buildSidebar();
    renderComments();
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
      '<textarea placeholder="レビュー全体へのコメント（Ctrl+Enterで送信）"></textarea>' +
      '<div class="buttons"><button class="primary overall-submit">コメントを追加</button></div>' +
      '</div>';

    const textarea = sec.querySelector('textarea');
    const btn = sec.querySelector('.overall-submit');

    function submit() {
      const body = textarea.value.trim();
      if (!body) return;
      btn.disabled = true;
      api('POST', '/api/comments', { body: body }).then(function () {
        textarea.value = '';
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

  /* ---------- file tree sidebar ---------- */

  let sidebarBuilt = false;

  function statusMark(st) {
    return { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', binary: 'B' }[st] || 'M';
  }

  function buildTree(files) {
    const root = { dirs: {}, files: [] };
    files.forEach(function (file, fi) {
      const parts = String(file.path).split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        node.dirs[seg] = node.dirs[seg] || { dirs: {}, files: [] };
        node = node.dirs[seg];
      }
      node.files.push({ name: parts[parts.length - 1], index: fi, file: file });
    });
    return root;
  }

  // Shared comparator for files within a tree node (by name). Kept identical to
  // the directory ordering (default string sort) so the tree and the main diff
  // agree exactly.
  function byName(a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }

  // The order in which files appear when walking the tree: directories first
  // (recursively, name-sorted), then this node's own files (name-sorted).
  // Returns the list of original DIFF.files indices in that display order.
  // renderDiff and renderTreeNode both follow this exact ordering.
  function treeOrder(files) {
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
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      container.appendChild(fEl);
    });
  }

  function buildSidebar() {
    if (sidebarBuilt || !DIFF.files.length) return;
    const parent = app.parentNode;
    if (!parent) return;

    const layout = document.createElement('div');
    layout.className = 'layout';
    parent.insertBefore(layout, app);

    const sidebar = document.createElement('aside');
    sidebar.id = 'file-tree';
    sidebar.className = 'sidebar';
    const heading = document.createElement('div');
    heading.className = 'sidebar-title';
    heading.textContent = 'ファイル (' + DIFF.files.length + ')';
    sidebar.appendChild(heading);

    const treeWrap = document.createElement('div');
    treeWrap.className = 'tree';
    renderTreeNode(buildTree(DIFF.files), treeWrap, 0);
    sidebar.appendChild(treeWrap);

    // Comment management list (filled/updated by renderCommentList on refresh).
    const cHeading = document.createElement('div');
    cHeading.className = 'sidebar-title sidebar-comments-title';
    cHeading.id = 'sidebar-comments-title';
    cHeading.textContent = 'コメント (0)';
    sidebar.appendChild(cHeading);

    const cList = document.createElement('div');
    cList.className = 'comment-list';
    sidebar.appendChild(cList);

    layout.appendChild(sidebar);
    layout.appendChild(app); // move #app into the flex layout
    sidebarBuilt = true;
  }

  function updateTreeCounts() {
    const counts = {};
    comments.forEach(function (c) {
      if (c.file === null || c.file === undefined) return;
      counts[c.file] = (counts[c.file] || 0) + 1;
    });
    document.querySelectorAll('.tree-count[data-file]').forEach(function (el) {
      const n = counts[el.dataset.file] || 0;
      el.textContent = n ? String(n) : '';
      el.style.display = n ? '' : 'none';
    });
  }

  function commentLocShort(c) {
    if (c.file === null || c.file === undefined) return '全体';
    const range = c.startLine === c.endLine
      ? 'L' + c.startLine
      : 'L' + c.startLine + '-' + c.endLine;
    return c.file + ':' + range;
  }

  function bodySnippet(s) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }

  function focusComment(id) {
    const card = document.querySelector(
      '.comment-card[data-comment-id="' + id + '"]'
    );
    if (!card) return;
    if (typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    card.classList.add('comment-flash');
    setTimeout(function () { card.classList.remove('comment-flash'); }, 1500);
  }

  // Re-render the sidebar comment list. Called on the same cadence as
  // updateTreeCounts (from renderComments) so it tracks every refresh.
  function renderCommentList() {
    const list = document.querySelector('.sidebar .comment-list');
    if (!list) return;
    const title = document.getElementById('sidebar-comments-title');
    const sorted = comments.slice().sort(function (a, b) {
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
    if (title) title.textContent = 'コメント (' + sorted.length + ')';
    list.innerHTML = '';
    sorted.forEach(function (c) {
      const item = document.createElement('div');
      item.className = 'comment-item';
      item.title = commentLocShort(c) + ' — ' + c.body;

      const pill = document.createElement('span');
      pill.className = 'status-pill status-' + c.status;
      pill.textContent = c.status;

      const loc = document.createElement('span');
      loc.className = 'comment-item-loc';
      loc.textContent = commentLocShort(c);

      const body = document.createElement('span');
      body.className = 'comment-item-body';
      body.textContent = bodySnippet(c.body);

      item.appendChild(pill);
      item.appendChild(loc);
      item.appendChild(body);
      item.addEventListener('click', function () { focusComment(c.id); });
      list.appendChild(item);
    });
  }

  function numCell(file, side, cell) {
    const td = document.createElement('td');
    td.className = 'num';
    if (!cell) {
      td.className += ' empty';
      return td;
    }
    if (cell.kind === 'add') td.className += ' add';
    if (cell.kind === 'del') td.className += ' del';
    td.textContent = cell.line;
    td.dataset.file = file.path;
    td.dataset.side = side;
    td.dataset.line = cell.line;
    td.dataset.diffLine = cell.diffLine;
    td.title = 'クリックでコメント / Shift+クリックで範囲';
    return td;
  }

  function codeCell(cell, changedKind) {
    const td = document.createElement('td');
    td.className = 'code';
    if (!cell) {
      td.className += ' empty';
      return td;
    }
    if (cell.kind === changedKind) td.className += ' ' + changedKind;
    const prefix = cell.kind === 'add' ? '+' : cell.kind === 'del' ? '-' : ' ';
    td.innerHTML = '<span class="prefix">' + prefix + '</span>' + esc(cell.text);
    return td;
  }

  /* ---------- selection ---------- */

  function cellInfo(td) {
    return {
      file: td.dataset.file,
      side: td.dataset.side,
      line: parseInt(td.dataset.line, 10),
      diffLine: parseInt(td.dataset.diffLine, 10),
    };
  }

  function clearSelectionHighlight() {
    document.querySelectorAll('td.selected').forEach(function (td) {
      td.classList.remove('selected');
    });
  }

  function selectionRange() {
    if (!selection) return null;
    const a = selection.anchor;
    const b = selection.head;
    const startLine = Math.min(a.line, b.line);
    const endLine = Math.max(a.line, b.line);
    const startDiffLine = Math.min(a.diffLine, b.diffLine);
    const endDiffLine = Math.max(a.diffLine, b.diffLine);
    return {
      file: selection.file,
      side: selection.side,
      startLine: startLine,
      endLine: endLine,
      startDiffLine: startDiffLine,
      endDiffLine: endDiffLine,
    };
  }

  function highlightSelection() {
    clearSelectionHighlight();
    const r = selectionRange();
    if (!r) return;
    document.querySelectorAll('td.num[data-file]').forEach(function (td) {
      const c = cellInfo(td);
      if (c.file === r.file && c.side === r.side && c.line >= r.startLine && c.line <= r.endLine) {
        td.classList.add('selected');
        if (td.nextElementSibling) td.nextElementSibling.classList.add('selected');
      }
    });
  }

  function beginSelection(td, extend) {
    const c = cellInfo(td);
    if (extend && selection && selection.file === c.file && selection.side === c.side) {
      selection.head = { line: c.line, diffLine: c.diffLine };
    } else {
      selection = {
        file: c.file,
        side: c.side,
        anchor: { line: c.line, diffLine: c.diffLine },
        head: { line: c.line, diffLine: c.diffLine },
      };
    }
    highlightSelection();
  }

  document.addEventListener('mousedown', function (e) {
    const td = e.target.closest && e.target.closest('td.num[data-file]');
    if (!td) return;
    e.preventDefault();
    beginSelection(td, e.shiftKey);
    dragging = true;
  });

  document.addEventListener('mouseover', function (e) {
    if (!dragging || !selection) return;
    const td = e.target.closest && e.target.closest('td.num[data-file]');
    if (!td) return;
    const c = cellInfo(td);
    if (c.file !== selection.file || c.side !== selection.side) return;
    selection.head = { line: c.line, diffLine: c.diffLine };
    highlightSelection();
  });

  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    if (selection) showCommentForm();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') cancelForm();
  });

  /* ---------- comment form ---------- */

  function findRowFor(file, side, line) {
    const tds = document.querySelectorAll(
      'td.num[data-file][data-side="' + side + '"][data-line="' + line + '"]'
    );
    for (let i = 0; i < tds.length; i++) {
      if (tds[i].dataset.file === file) return tds[i].closest('tr');
    }
    return null;
  }

  function cancelForm() {
    if (openForm) {
      openForm.remove();
      openForm = null;
    }
    selection = null;
    clearSelectionHighlight();
  }

  function showCommentForm() {
    const r = selectionRange();
    if (!r) return;
    if (openForm) openForm.remove();

    const anchorRow = findRowFor(r.file, r.side, r.endLine);
    if (!anchorRow) return;

    const tr = document.createElement('tr');
    tr.className = 'widget-row comment-form-row';
    const td = document.createElement('td');
    td.colSpan = 4;

    const rangeText = r.startLine === r.endLine
      ? 'L' + r.startLine
      : 'L' + r.startLine + '-L' + r.endLine;
    const sideText = r.side === 'new' ? '変更後' : '変更前';

    const wrap = document.createElement('div');
    wrap.className = 'comment-form';
    wrap.innerHTML =
      '<div class="form-meta">' + esc(r.file) + ' / ' + sideText + ' ' + rangeText + ' にコメント</div>' +
      '<textarea placeholder="コメントを入力（Ctrl+Enterで送信）"></textarea>' +
      '<div class="buttons">' +
      '<button class="primary submit">コメントを追加</button>' +
      '<button class="cancel">キャンセル</button>' +
      '</div>';
    td.appendChild(wrap);
    tr.appendChild(td);
    anchorRow.after(tr);
    openForm = tr;

    const textarea = wrap.querySelector('textarea');
    textarea.focus();

    function submit() {
      const body = textarea.value.trim();
      if (!body) return;
      wrap.querySelector('.submit').disabled = true;
      api('POST', '/api/comments', {
        file: r.file,
        side: r.side,
        startLine: r.startLine,
        endLine: r.endLine,
        startDiffLine: r.startDiffLine,
        endDiffLine: r.endDiffLine,
        body: body,
      }).then(function () {
        cancelForm();
        refresh();
      }).catch(function (err) {
        alert('コメントの保存に失敗しました: ' + err);
        wrap.querySelector('.submit').disabled = false;
      });
    }

    wrap.querySelector('.submit').addEventListener('click', submit);
    wrap.querySelector('.cancel').addEventListener('click', cancelForm);
    textarea.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
    });
  }

  /* ---------- comment threads ---------- */

  function commentCard(c) {
    const div = document.createElement('div');
    div.className = 'comment-card';
    div.dataset.commentId = c.id;

    let posText;
    if (c.file === null || c.file === undefined) {
      posText = 'レビュー全体';
    } else {
      const range = c.startLine === c.endLine ? 'L' + c.startLine : 'L' + c.startLine + '-L' + c.endLine;
      posText = esc(c.file) + ' ' + (c.side === 'new' ? '' : '(旧) ') + esc(range);
    }
    let html =
      '<div class="meta">' +
      '<span class="status-pill status-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
      '<span>' + posText + '</span>' +
      '<span>' + esc(fmtDate(c.createdAt)) + '</span>' +
      '</div>' +
      '<div class="body">' + esc(c.body) + '</div>';
    if (c.agentResponse && c.agentResponse.message) {
      html += '<div class="agent-response"><span class="who">agent</span>' +
        esc(c.agentResponse.message) + '</div>';
    }
    div.innerHTML = html;

    if (c.status !== 'resolved') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const btn = document.createElement('button');
      btn.textContent = 'Resolve';
      btn.addEventListener('click', function () {
        api('POST', '/api/comments/' + encodeURIComponent(c.id) + '/resolve', {})
          .then(refresh)
          .catch(function (err) { alert('更新に失敗しました: ' + err); });
      });
      actions.appendChild(btn);
      div.appendChild(actions);
    }
    return div;
  }

  function renderComments() {
    document.querySelectorAll('tr.thread-row, .orphan-section').forEach(function (el) {
      el.remove();
    });

    const orphans = [];
    const byAnchor = {};

    const overallList = document.querySelector('.overall-list');
    if (overallList) overallList.innerHTML = '';

    comments.forEach(function (c) {
      if (c.file === null || c.file === undefined) {
        if (overallList) overallList.appendChild(commentCard(c));
        return;
      }
      const key = c.file + ' ' + c.side + ' ' + c.endLine;
      (byAnchor[key] = byAnchor[key] || []).push(c);
    });

    Object.keys(byAnchor).forEach(function (key) {
      const list = byAnchor[key];
      const c0 = list[0];
      const row = findRowFor(c0.file, c0.side, c0.endLine);
      if (!row) {
        orphans.push.apply(orphans, list);
        return;
      }
      const tr = document.createElement('tr');
      tr.className = 'widget-row thread-row';
      const td = document.createElement('td');
      td.colSpan = 4;
      list.forEach(function (c) { td.appendChild(commentCard(c)); });
      appendReplyUI(td, c0);
      tr.appendChild(td);
      // Keep the open form directly under its anchor row.
      const after = row.nextElementSibling && row.nextElementSibling.classList.contains('comment-form-row')
        ? row.nextElementSibling : row;
      after.after(tr);
    });

    if (orphans.length) {
      const sec = document.createElement('section');
      sec.className = 'orphan-section';
      sec.innerHTML = '<h2>現在の差分に位置づけできないコメント</h2>' +
        '<p class="hint">差分の再生成により行が変わった可能性があります。</p>';
      orphans.forEach(function (c) { sec.appendChild(commentCard(c)); });
      app.appendChild(sec);
    }

    updateTreeCounts();
    renderCommentList();
  }

  function appendReplyUI(td, anchor) {
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
        '<textarea placeholder="返信を入力（Ctrl+Enterで送信）"></textarea>' +
        '<div class="buttons">' +
        '<button class="primary reply-submit">返信する</button>' +
        '<button class="reply-cancel">キャンセル</button>' +
        '</div>';
      wrap.appendChild(form);
      const textarea = form.querySelector('textarea');
      textarea.focus();

      function close() {
        form.remove();
        btn.style.display = '';
      }
      function submit() {
        const body = textarea.value.trim();
        if (!body) return;
        form.querySelector('.reply-submit').disabled = true;
        api('POST', '/api/comments', {
          file: anchor.file,
          side: anchor.side,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          startDiffLine: anchor.startDiffLine,
          endDiffLine: anchor.endDiffLine,
          body: body,
        }).then(function () {
          refresh();
        }).catch(function (err) {
          alert('返信の保存に失敗しました: ' + err);
          form.querySelector('.reply-submit').disabled = false;
        });
      }
      form.querySelector('.reply-submit').addEventListener('click', submit);
      form.querySelector('.reply-cancel').addEventListener('click', close);
      textarea.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
      });
    });
  }

  function renderBadge(status) {
    const unresolved = status ? status.unresolved : null;
    if (unresolved === null || unresolved === undefined) {
      badge.textContent = '-';
      return;
    }
    badge.textContent = '未解決 ' + unresolved;
    badge.className = 'badge' + (unresolved === 0 ? ' zero' : '');
  }

  /* ---------- api ---------- */

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error(res.status + ' ' + t); });
      }
      return res.json();
    });
  }

  let lastCommentsJson = '';

  function refresh() {
    return Promise.all([
      api('GET', '/api/comments'),
      api('GET', '/api/status'),
    ]).then(function (results) {
      const cs = results[0].comments || [];
      const status = results[1];
      connState.textContent = '';
      if (status.generatedAt && DIFF.generatedAt && status.generatedAt !== DIFF.generatedAt) {
        location.reload();
        return;
      }
      renderBadge(status);
      const json = JSON.stringify(cs);
      if (json !== lastCommentsJson) {
        lastCommentsJson = json;
        comments = cs;
        renderComments();
      }
    }).catch(function () {
      connState.textContent = 'サーバー未接続（agent-review-kit serve を起動してください）';
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

  renderDiff();
  refresh();
  setInterval(refresh, 3000);
  setupScrollTop();
})();
