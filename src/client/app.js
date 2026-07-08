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

    if (!DIFF.files.length) {
      app.innerHTML = '<div class="empty-diff">差分がありません。変更を加えてから <code>agent-review-kit generate</code> を再実行してください。</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '行番号をクリックでコメント、Shift+クリックまたはドラッグで範囲選択できます。';
    frag.appendChild(hint);

    DIFF.files.forEach(function (file, fi) {
      const box = document.createElement('div');
      box.className = 'file';
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
    renderComments();
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

    const range = c.startLine === c.endLine ? 'L' + c.startLine : 'L' + c.startLine + '-L' + c.endLine;
    let html =
      '<div class="meta">' +
      '<span class="status-pill status-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
      '<span>' + esc(c.file) + ' ' + (c.side === 'new' ? '' : '(旧) ') + esc(range) + '</span>' +
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
    comments.forEach(function (c) {
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

  renderDiff();
  refresh();
  setInterval(refresh, 3000);
})();
