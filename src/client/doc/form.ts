import { api } from '../api.js';
import { bodySnippet, esc } from '../dom.js';
import { attachImagePaste } from '../images.js';
import { intentFieldHtml, selectedIntent, syncIntentFields } from '../intent.js';
import { DOC, state } from '../state.js';
import { focusComment, refresh } from '../app.js';
import { docCssPath, docElementLabel, docRangeOffsets, docTextIndex, frameDoc } from './resolve.js';

/* ---------- document comment creation ---------- */

export function closeDocForm() {
  if (state.docFormSlot) state.docFormSlot.innerHTML = '';
}

// Plain text; the caller esc()'s it before it lands in innerHTML (the
// selected text / label come from the reviewed document, which is untrusted).
function docTargetPreview(target) {
  if (!target) return 'ドキュメント全体にコメント';
  if (target.kind === 'text') return '“' + bodySnippet(target.selectedText) + '” にコメント';
  return target.label + ' にコメント';
}

export function openDocCommentForm(target) {
  if (!state.docFormSlot) return;
  closeDocForm();
  hideDocFloatBtn();
  // Manual edit rewrites the target element (for a text selection, the
  // element containing it), located by the stored selector. Offered only
  // outside read-only mode and when there is a concrete anchor.
  const canEdit = !state.readOnlyMode && target && target.selector;
  const wrap = document.createElement('div');
  wrap.className = 'comment-form doc-comment-form';
  wrap.innerHTML =
    '<div class="form-meta">' + esc(docTargetPreview(target)) + '</div>' +
    '<textarea placeholder="コメントを入力（Ctrl+Enterで送信 / 画像はペーストで添付）"></textarea>' +
    intentFieldHtml() +
    '<div class="buttons">' +
    '<button class="primary submit">コメントを追加</button>' +
    (canEdit
      ? '<button class="manual-edit" title="この要素のHTMLをその場で書き換えて文書に直接適用する">✏️ 手動修正</button>'
      : '') +
    '<button class="cancel">キャンセル</button>' +
    '</div>';
  state.docFormSlot.appendChild(wrap);
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
      documentId: DOC.id,
      htmlTarget: target,
      body: body,
      intent: selectedIntent(wrap),
      images: images,
    }).then(function () {
      closeDocForm();
      refresh();
    }).catch(function (err) {
      alert('コメントの保存に失敗しました: ' + err);
      (wrap.querySelector('.submit') as any).disabled = false;
    });
  }
  wrap.querySelector('.submit').addEventListener('click', submit);
  wrap.querySelector('.cancel').addEventListener('click', closeDocForm);
  const editBtn = wrap.querySelector('.manual-edit');
  if (editBtn) {
    editBtn.addEventListener('click', function () {
      docManualEdit(wrap, target);
    });
  }
  textarea.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
  });
}

// Manual edit of the published document. The live iframe DOM carries
// synthetic comment marks and pick-mode classes, so it is never serialized:
// instead the pristine stored body is fetched and parsed detached, the
// target element is located there by its selector, the user rewrites that
// element's outerHTML, and the whole re-serialized document is saved via
// POST /api/documents/<id>/edit. The server bumps the revision, which every
// open page reloads on; expectedRevision makes a concurrent re-publish fail
// as stale instead of being overwritten.
function docManualEdit(wrap, target) {
  Promise.all([
    fetch('/doc/' + encodeURIComponent(DOC.id) + '/content').then(function (r) {
      if (!r.ok) throw new Error('文書本文を取得できません: ' + r.status);
      return r.text();
    }),
    api('GET', '/api/documents/' + encodeURIComponent(DOC.id)),
  ]).then(function (results) {
    const source = results[0];
    const revision = (results[1].document || {}).revision;
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const el = parsed.querySelector(target.selector);
    if (!el) {
      alert('対象要素を保存済みの文書内で特定できないため手動修正できません（文書が更新された可能性があります）。');
      return;
    }
    wrap.innerHTML =
      '<div class="form-meta">' + esc(target.label || target.tag) +
      ' のHTMLを手動修正（保存で文書に直接適用）</div>' +
      '<textarea class="code-edit" spellcheck="false"></textarea>' +
      '<div class="buttons">' +
      '<button class="primary save">保存して文書に適用</button>' +
      '<button class="cancel">キャンセル</button>' +
      '<span class="edit-hint">Ctrl+Enter で保存 / 空にして保存すると要素を削除</span>' +
      '</div>';
    const ta = wrap.querySelector('textarea');
    ta.value = el.outerHTML;
    ta.rows = Math.min(30, Math.max(3, el.outerHTML.split('\n').length + 1));
    ta.focus();

    function save() {
      const saveBtn = wrap.querySelector('.save');
      saveBtn.disabled = true;
      // Re-parse from the pristine source on every attempt: assigning
      // outerHTML detaches the located element, so reusing one parse would
      // make a retry after a failure silently drop the latest textarea text.
      const doc2 = new DOMParser().parseFromString(source, 'text/html');
      const el2 = doc2.querySelector(target.selector);
      if (!el2) {
        alert('対象要素を特定できなくなりました。ページを再読み込みしてください。');
        saveBtn.disabled = false;
        return;
      }
      if (ta.value.trim() === '') {
        el2.remove();
      } else {
        el2.outerHTML = ta.value;
      }
      const doctype = doc2.doctype ? '<!DOCTYPE ' + doc2.doctype.name + '>\n' : '';
      api('POST', '/api/documents/' + encodeURIComponent(DOC.id) + '/edit', {
        html: doctype + doc2.documentElement.outerHTML + '\n',
        expectedRevision: revision,
        htmlTarget: target,
        newHtml: ta.value,
      }).then(function () {
        closeDocForm();
        location.reload();
      }).catch(function (err) {
        const msg = String((err && err.message) || err);
        if (msg.indexOf('409') === 0 && msg.indexOf('stale') !== -1) {
          alert('文書が更新されています。ページを再読み込みします。');
          location.reload();
          return;
        }
        alert('手動修正の適用に失敗しました: ' + msg);
        saveBtn.disabled = false;
      });
    }
    wrap.querySelector('.save').addEventListener('click', save);
    wrap.querySelector('.cancel').addEventListener('click', closeDocForm);
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
    });
  }).catch(function (err) {
    alert('手動修正の準備に失敗しました: ' + err);
  });
}

export function hideDocFloatBtn() {
  if (state.docFloatBtn) {
    state.docFloatBtn.remove();
    state.docFloatBtn = null;
  }
}

// Floating「コメント」button just under the text selection, positioned in
// parent coordinates (frame rect + in-frame rect).
function showDocFloatBtn(rect, target) {
  hideDocFloatBtn();
  const frameRect = state.docFrame.getBoundingClientRect();
  const btn = document.createElement('button');
  btn.id = 'doc-float-btn';
  btn.type = 'button';
  btn.textContent = '💬 コメント';
  const left = Math.max(8, frameRect.left + rect.left);
  const top = Math.min(window.innerHeight - 40, frameRect.top + rect.bottom + 6);
  btn.style.left = left + 'px';
  btn.style.top = top + 'px';
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  btn.addEventListener('click', function () {
    openDocCommentForm(target);
    const win = state.docFrame.contentWindow;
    if (win && win.getSelection) win.getSelection().removeAllRanges();
  });
  document.body.appendChild(btn);
  state.docFloatBtn = btn;
}

export function setDocPickMode(on) {
  state.docPickMode = on;
  if (state.docPickBtn) state.docPickBtn.classList.toggle('active', on);
  const doc = frameDoc();
  if (doc && doc.body) doc.body.classList.toggle('ark-picking', on);
  if (!on && state.docHoverEl) {
    state.docHoverEl.classList.remove('ark-pick-hover');
    state.docHoverEl = null;
  }
}

// Comment marks are synthetic elements this tool injects and rebuilds on
// every render — a selector that includes one can never resolve again.
// Targets picked on (or inside) a mark climb out to the real element.
// Marks wrap only text nodes, so the chain is at most a few marks deep.
function climbOutOfMarks(el) {
  while (
    el && el.nodeType === 1 && el.nodeName === 'MARK' &&
    el.classList.contains('ark-mark')
  ) {
    el = el.parentElement;
  }
  return el;
}

function buildElementTarget(el) {
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  const target: any = {
    kind: 'element',
    selector: docCssPath(el),
    tag: el.nodeName.toLowerCase(),
    label: docElementLabel(el),
  };
  if (text) target.elementText = text.slice(0, 120);
  return target;
}

function buildTextTarget(index, off, range) {
  let container = range.commonAncestorContainer;
  if (container.nodeType !== 1) container = container.parentElement;
  container = climbOutOfMarks(container);
  const CONTEXT = 60;
  return {
    kind: 'text',
    selector: container ? docCssPath(container) : 'body',
    tag: container ? container.nodeName.toLowerCase() : 'body',
    label: container ? docElementLabel(container) : 'body',
    selectedText: index.text.slice(off.start, off.end),
    contextBefore: index.text.slice(Math.max(0, off.start - CONTEXT), off.start),
    contextAfter: index.text.slice(off.end, off.end + CONTEXT),
  };
}

export function onDocFrameMouseUp() {
  if (state.docPickMode) return;
  // Selection is finalized after mouseup; read it on the next tick.
  setTimeout(function () {
    const doc = frameDoc();
    const win = state.docFrame && state.docFrame.contentWindow;
    if (!doc || !win || !win.getSelection) return;
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !String(sel.toString()).trim()) {
      hideDocFloatBtn();
      return;
    }
    const range = sel.getRangeAt(0);
    const index = docTextIndex(doc.body);
    const off = docRangeOffsets(range, index);
    if (!off) {
      hideDocFloatBtn();
      return;
    }
    showDocFloatBtn(range.getBoundingClientRect(), buildTextTarget(index, off, range));
  }, 0);
}

export function onDocFrameClick(e) {
  if (state.docPickMode) {
    e.preventDefault();
    e.stopPropagation();
    let el = e.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    el = climbOutOfMarks(el);
    if (!el || el.nodeName === 'HTML' || el.nodeName === 'BODY') return;
    setDocPickMode(false);
    openDocCommentForm(buildElementTarget(el));
    return;
  }
  // Click on an existing mark/outline focuses its thread in the panel.
  const marked = e.target.closest && e.target.closest('[data-ark-comment]');
  if (marked) {
    e.preventDefault();
    focusComment(marked.getAttribute('data-ark-comment'));
    return;
  }
  // Links: never navigate the review frame. External links open a new tab,
  // in-document anchors scroll inside the frame.
  const a = e.target.closest && e.target.closest('a[href]');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
    } else if (href.charAt(0) === '#') {
      const doc = frameDoc();
      const dest = doc && doc.getElementById(href.slice(1));
      if (dest && typeof dest.scrollIntoView === 'function') {
        dest.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }
}

export function onDocFrameMouseOver(e) {
  if (!state.docPickMode) return;
  let el = e.target;
  if (el && el.nodeType !== 1) el = el.parentElement;
  if (!el || el.nodeName === 'HTML' || el.nodeName === 'BODY') return;
  if (state.docHoverEl) state.docHoverEl.classList.remove('ark-pick-hover');
  state.docHoverEl = el;
  el.classList.add('ark-pick-hover');
}
