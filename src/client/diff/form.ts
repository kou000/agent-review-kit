import { api } from '../api.js';
import { esc } from '../dom.js';
import { attachImagePaste } from '../images.js';
import { intentFieldHtml, selectedIntent, syncIntentFields } from '../intent.js';
import { DIFF, state } from '../state.js';
import { refresh } from '../app.js';
import { clearSelectionHighlight, selectionRange } from './selection.js';

/* ---------- comment form ---------- */

// The exact text the review is showing for new-side lines start..end of a
// file, reconstructed from the embedded diff data (full newLines when
// present, hunk rows otherwise). Returns null when any line is not part of
// the rendered diff — manual edit is only offered on content the user can
// actually see. \r is stripped so a CRLF file compares cleanly server-side.
function newSideText(filePath, startLine, endLine) {
  var f = null;
  for (var i = 0; i < DIFF.files.length; i++) {
    if (DIFF.files[i].path === filePath) { f = DIFF.files[i]; break; }
  }
  if (!f || f.status === 'deleted' || f.status === 'binary') return null;
  var out = [];
  if (f.newLines) {
    if (endLine > f.newLines.length) return null;
    for (var l = startLine; l <= endLine; l++) out.push(f.newLines[l - 1]);
  } else {
    var byLine = {};
    f.hunks.forEach(function (h) {
      h.rows.forEach(function (row) {
        if (row.right) byLine[row.right.line] = row.right.text;
      });
    });
    for (var l2 = startLine; l2 <= endLine; l2++) {
      if (!(l2 in byLine)) return null;
      out.push(byLine[l2]);
    }
  }
  return out.map(function (s) { return String(s).replace(/\r$/, ''); }).join('\n');
}

export function findRowFor(file, side, line) {
  const tds: any = document.querySelectorAll(
    'td.num[data-file][data-side="' + side + '"][data-line="' + line + '"]'
  );
  for (let i = 0; i < tds.length; i++) {
    if (tds[i].dataset.file === file) return tds[i].closest('tr');
  }
  return null;
}

export function cancelForm() {
  if (state.openForm) {
    state.openForm.remove();
    state.openForm = null;
  }
  state.selection = null;
  clearSelectionHighlight();
}

export function showCommentForm() {
  const r = selectionRange();
  if (!r) return;
  if (state.openForm) state.openForm.remove();

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

  // Manual edit needs the on-screen text of the range: only offered on the
  // new side (the old side is the base), outside read-only mode, and when
  // every selected line is part of the rendered diff.
  const editableText = r.side === 'new' && !state.readOnlyMode
    ? newSideText(r.file, r.startLine, r.endLine)
    : null;

  const wrap = document.createElement('div');
  wrap.className = 'comment-form';
  wrap.innerHTML =
    '<div class="form-meta">' + esc(r.file) + ' / ' + sideText + ' ' + rangeText + ' にコメント</div>' +
    '<textarea placeholder="コメントを入力（Ctrl+Enterで送信 / 画像はペーストで添付）"></textarea>' +
    intentFieldHtml() +
    '<div class="buttons">' +
    '<button class="primary submit">コメントを追加</button>' +
    (editableText !== null
      ? '<button class="manual-edit" title="選択範囲のコードをその場で書き換えてファイルに直接適用する">✏️ 手動修正</button>'
      : '') +
    '<button class="cancel">キャンセル</button>' +
    '</div>';
  td.appendChild(wrap);
  tr.appendChild(td);
  anchorRow.after(tr);
  state.openForm = tr;
  syncIntentFields(wrap);

  const textarea = wrap.querySelector('textarea');
  const attachments = attachImagePaste(wrap, textarea);
  textarea.focus();

  function submit() {
    const images = attachments.ids();
    if (attachments.busy()) {
      alert('画像をアップロード中です。完了までお待ちください。');
      return;
    }
    // An image alone is a valid comment; the server still requires a body.
    const body = textarea.value.trim() || (images.length ? '（画像添付）' : '');
    if (!body) return;
    (wrap.querySelector('.submit') as any).disabled = true;
    api('POST', '/api/comments', {
      file: r.file,
      side: r.side,
      startLine: r.startLine,
      endLine: r.endLine,
      startDiffLine: r.startDiffLine,
      endDiffLine: r.endDiffLine,
      body: body,
      intent: selectedIntent(wrap),
      images: images,
    }).then(function () {
      cancelForm();
      refresh();
    }).catch(function (err) {
      alert('コメントの保存に失敗しました: ' + err);
      (wrap.querySelector('.submit') as any).disabled = false;
    });
  }

  // Swap the form into manual-edit mode: a code textarea prefilled with
  // exactly what the diff shows for the range. Saving applies the change to
  // the file via POST /api/edit; the server regenerates the review before
  // answering, so a plain reload lands on the fresh diff.
  function showManualEdit() {
    wrap.innerHTML =
      '<div class="form-meta">' + esc(r.file) + ' / 変更後 ' + rangeText +
      ' を手動修正（保存でファイルへ直接適用）</div>' +
      '<textarea class="code-edit" spellcheck="false"></textarea>' +
      '<div class="buttons">' +
      '<button class="primary save">保存してファイルに適用</button>' +
      '<button class="cancel">キャンセル</button>' +
      '<span class="edit-hint">Ctrl+Enter で保存 / 空にして保存すると行を削除</span>' +
      '</div>';
    const ta = wrap.querySelector('textarea');
    ta.value = editableText;
    ta.rows = Math.min(30, Math.max(3, editableText.split('\n').length + 1));
    ta.focus();

    function save() {
      const saveBtn: any = wrap.querySelector('.save');
      saveBtn.disabled = true;
      api('POST', '/api/edit', {
        file: r.file,
        startLine: r.startLine,
        endLine: r.endLine,
        startDiffLine: r.startDiffLine,
        endDiffLine: r.endDiffLine,
        expectedText: editableText,
        newText: ta.value,
      }).then(function () {
        cancelForm();
        location.reload();
      }).catch(function (err) {
        const msg = String((err && err.message) || err);
        if (msg.indexOf('409') === 0 && msg.indexOf('stale') !== -1) {
          alert('ファイルの内容が表示中の差分と一致しません（差分が古くなっています）。ページを再読み込みします。');
          location.reload();
          return;
        }
        alert('手動修正の適用に失敗しました: ' + msg);
        saveBtn.disabled = false;
      });
    }
    wrap.querySelector('.save').addEventListener('click', save);
    wrap.querySelector('.cancel').addEventListener('click', cancelForm);
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
    });
  }

  wrap.querySelector('.submit').addEventListener('click', submit);
  wrap.querySelector('.cancel').addEventListener('click', cancelForm);
  const editBtn = wrap.querySelector('.manual-edit');
  if (editBtn) editBtn.addEventListener('click', showManualEdit);
  textarea.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
  });
}
