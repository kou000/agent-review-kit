import { api } from '../api.js';
import { attachDocPanelResize, restoreDocPanelWidth } from '../resize.js';
import { connState, diffMeta, DOC, app, state } from '../state.js';
import {
  applySettings,
  isEditingDraft,
  notifyAgentUpdates,
  refresh,
  renderBadge,
  setupTopbarControls,
  updateBranchLabel,
} from '../app.js';
import {
  closeDocForm,
  hideDocFloatBtn,
  onDocFrameClick,
  onDocFrameMouseOver,
  onDocFrameMouseUp,
  openDocCommentForm,
  setDocPickMode,
} from './form.js';
import { restoreDocPanelCollapsed, setDocPanelCollapsed, syncDocMarksHidden } from './panel.js';
import { docRenderComments } from './render.js';
import { frameDoc } from './resolve.js';

const DOC_FRAME_CSS =
  'mark.ark-mark { background: rgba(210, 153, 34, 0.35); border-bottom: 2px solid rgba(210, 153, 34, 0.9); ' +
  'color: inherit; cursor: pointer; }\n' +
  '.ark-el-anchor { outline: 2px solid rgba(88, 166, 255, 0.7); outline-offset: 2px; cursor: pointer; }\n' +
  '.ark-pick-hover { outline: 2px dashed rgba(88, 166, 255, 0.95) !important; outline-offset: 2px; }\n' +
  'body.ark-picking, body.ark-picking * { cursor: crosshair !important; }\n' +
  '.ark-flash, mark.ark-mark.ark-flash { background: rgba(88, 166, 255, 0.35) !important; }\n' +
  'html.ark-marks-hidden mark.ark-mark { background: transparent; border-bottom: 0; cursor: inherit; }\n' +
  'html.ark-marks-hidden .ark-el-anchor { outline: none; cursor: inherit; }';

export function docFrameReady() {
  const doc = frameDoc();
  if (!doc || !doc.body) return;
  const style = doc.createElement('style');
  style.textContent = DOC_FRAME_CSS;
  (doc.head || doc.documentElement).appendChild(style);
  doc.addEventListener('mouseup', onDocFrameMouseUp);
  doc.addEventListener('click', onDocFrameClick, true);
  doc.addEventListener('mouseover', onDocFrameMouseOver);
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      setDocPickMode(false);
      hideDocFloatBtn();
    }
  });
  state.docFrameWired = true;
  syncDocMarksHidden();
  // Anchors could not be resolved before the frame existed: force a
  // comment re-render against the loaded DOM.
  state.lastCommentsJson = '';
  refresh();
}

export function buildDocLayout() {
  const layout = document.createElement('div');
  layout.className = 'doc-layout';
  state.docLayoutEl = layout;

  const frameWrap = document.createElement('div');
  frameWrap.className = 'doc-frame-wrap';
  state.docFrame = document.createElement('iframe');
  state.docFrame.id = 'doc-frame';
  state.docFrame.title = DOC.title;
  state.docFrame.addEventListener('load', docFrameReady);
  state.docFrame.src = '/doc/' + encodeURIComponent(DOC.id) + '/content';
  frameWrap.appendChild(state.docFrame);
  layout.appendChild(frameWrap);

  const panel = document.createElement('aside');
  panel.className = 'doc-comments';

  // Vertical drag handle between the document iframe and the comment panel.
  const resizer = document.createElement('div');
  resizer.className = 'doc-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでコメント欄の幅を調整';
  attachDocPanelResize(resizer, panel);
  layout.appendChild(resizer);
  restoreDocPanelWidth();

  const toolbar = document.createElement('div');
  toolbar.className = 'doc-toolbar';
  state.docPickBtn = document.createElement('button');
  state.docPickBtn.id = 'doc-pick-btn';
  state.docPickBtn.type = 'button';
  state.docPickBtn.textContent = '要素を選択してコメント';
  state.docPickBtn.title = 'クリックした要素にコメントする（Escで解除）。文章はドラッグ選択でもコメントできます';
  state.docPickBtn.addEventListener('click', function () {
    hideDocFloatBtn();
    setDocPickMode(!state.docPickMode);
  });
  toolbar.appendChild(state.docPickBtn);

  const overallBtn = document.createElement('button');
  overallBtn.type = 'button';
  overallBtn.textContent = 'ドキュメント全体にコメント';
  overallBtn.addEventListener('click', function () {
    setDocPickMode(false);
    openDocCommentForm(null);
  });
  toolbar.appendChild(overallBtn);

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.textContent = 'コメント欄を隠す »';
  collapseBtn.title = 'コメント欄を折りたたむ（画面右端のタブで再表示）';
  collapseBtn.addEventListener('click', function () { setDocPanelCollapsed(true); });
  toolbar.appendChild(collapseBtn);
  panel.appendChild(toolbar);

  state.docFormSlot = document.createElement('div');
  state.docFormSlot.id = 'doc-form-slot';
  panel.appendChild(state.docFormSlot);

  state.docCountEl = document.createElement('div');
  state.docCountEl.className = 'sidebar-title';
  state.docCountEl.textContent = 'コメント (0)';
  panel.appendChild(state.docCountEl);

  state.docThreadsEl = document.createElement('div');
  state.docThreadsEl.id = 'doc-threads';
  panel.appendChild(state.docThreadsEl);

  layout.appendChild(panel);

  state.docReopenBtn = document.createElement('button');
  state.docReopenBtn.type = 'button';
  state.docReopenBtn.className = 'doc-panel-reopen';
  state.docReopenBtn.textContent = '«';
  state.docReopenBtn.title = 'コメント欄を開く';
  state.docReopenBtn.setAttribute('aria-label', 'コメント欄を開く');
  state.docReopenBtn.addEventListener('click', function () { setDocPanelCollapsed(false); });
  layout.appendChild(state.docReopenBtn);
  restoreDocPanelCollapsed();

  app.appendChild(layout);
}

export function docRefresh() {
  return Promise.all([
    api('GET', '/api/comments'),
    api('GET', '/api/status'),
    api('GET', '/api/documents/' + encodeURIComponent(DOC.id)),
  ]).then(function (results) {
    // Only this document's live comments; everything else (diff comments,
    // other documents) belongs to other pages. Manual-edit records
    // (manualEdit) are agent-facing notifications, never shown.
    const cs = (results[0].comments || []).filter(function (c) {
      return !c.deleted && c.documentId === DOC.id && !c.manualEdit;
    });
    const status = results[1];
    const meta = results[2].document || {};
    if (isEditingDraft()) {
      connState.textContent = '入力中のため更新を保留中…';
      return;
    }
    connState.textContent = '';
    // A re-publish bumps the revision: reload to pick up the new body (the
    // same pattern as the diff page watching generatedAt).
    if (meta.revision && DOC.revision && meta.revision !== DOC.revision) {
      location.reload();
      return;
    }
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
      docRenderComments();
      notifyAgentUpdates(cs);
    }
  }).catch(function () {
    connState.textContent = 'サーバー未接続（agent-review-kit serve を起動してください）';
  });
}

export function initDocMode() {
  document.title = DOC.title + ' — agent-review-kit';
  diffMeta.textContent = 'ドキュメント: ' + DOC.title + ' (rev.' + DOC.revision + ')';
  setupTopbarControls();
  buildDocLayout();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      setDocPickMode(false);
      hideDocFloatBtn();
      closeDocForm();
    }
  });
  refresh();
  state.refreshTimer = setInterval(refresh, 3000);
}
