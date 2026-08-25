import { esc } from '../dom.js';
import { state } from '../state.js';
import { pruneThreadCollapse, renderThread, threadStructure } from '../threads.js';
import { clearDocMarks, docJumpTo, markDocElement, wrapDocRange } from './marks.js';
import { docResolveTarget, docTextIndex, frameDoc } from './resolve.js';

/* ---------- document comment rendering ---------- */

export function docSection(title: string, hint?: string) {
  const sec = document.createElement('section');
  sec.className = 'doc-thread-section';
  let html = '<h2>' + esc(title) + '</h2>';
  if (hint) html += '<p class="hint">' + esc(hint) + '</p>';
  sec.innerHTML = html;
  return sec;
}

// Render one thread and add a 📍 jump chip to its summary when the target
// was located in the document.
export function docAppendThread(container, list, canJump, topId) {
  const holder = document.createElement('div');
  renderThread(holder, list);
  if (canJump) {
    const summary = holder.querySelector('.thread-summary');
    if (summary) {
      const jump = document.createElement('button');
      jump.className = 'doc-jump';
      jump.type = 'button';
      jump.textContent = '📍';
      jump.title = 'ドキュメント内の対象へ移動';
      jump.addEventListener('click', function (e) {
        e.stopPropagation();
        docJumpTo(topId);
      });
      summary.appendChild(jump);
    }
  }
  while (holder.firstChild) container.appendChild(holder.firstChild);
}

export function docRenderComments() {
  pruneThreadCollapse();
  if (!state.docThreadsEl) return;
  const doc = frameDoc();
  // Until the frame has loaded there is nothing to resolve against; the
  // load handler forces a re-render.
  if (!state.docFrameWired || !doc || !doc.body) return;

  if (state.docCountEl) state.docCountEl.textContent = 'コメント (' + state.comments.length + ')';
  state.docThreadsEl.innerHTML = '';
  clearDocMarks(doc);
  const index = docTextIndex(doc.body);

  const s = threadStructure(state.comments);
  const anchored = []; // {top, list, res}
  const overall = [];
  const orphans = []; // [{top, list}]
  s.tops.forEach(function (top) {
    const list = [top].concat(s.repliesByParent[top.id] || []);
    if (!top.htmlTarget) {
      overall.push.apply(overall, list);
      return;
    }
    const res = docResolveTarget(doc, index, top.htmlTarget);
    if (!res) {
      orphans.push({ top: top, list: list });
      return;
    }
    anchored.push({ top: top, list: list, res: res });
  });

  // Text marks are applied in reverse document order so splitText never
  // invalidates an earlier segment; element outlines are just classes.
  anchored
    .filter(function (a) { return a.res.kind === 'text'; })
    .sort(function (a, b) { return b.res.start - a.res.start; })
    .forEach(function (a) { wrapDocRange(doc, index, a.res.start, a.res.end, a.top); });
  anchored
    .filter(function (a) { return a.res.kind === 'element'; })
    .forEach(function (a) { markDocElement(a.res.el, a.top); });

  anchored.sort(function (a, b) { return a.res.pos - b.res.pos; });
  if (anchored.length) {
    const sec = docSection('ドキュメント内のコメント');
    anchored.forEach(function (a) {
      docAppendThread(sec, a.list, true, a.top.id);
    });
    state.docThreadsEl.appendChild(sec);
  }
  if (overall.length) {
    const sec = docSection('ドキュメント全体');
    renderThread(sec, overall);
    state.docThreadsEl.appendChild(sec);
  }
  if (orphans.length) {
    const sec = docSection(
      '位置を特定できないコメント',
      'ドキュメントの更新により対象が見つからなくなった可能性があります。コメントは保持されています。'
    );
    orphans.forEach(function (o) {
      docAppendThread(sec, o.list, false, o.top.id);
    });
    state.docThreadsEl.appendChild(sec);
  }
  if (!state.comments.length) {
    const empty = document.createElement('p');
    empty.className = 'hint doc-empty';
    empty.textContent =
      'コメントはまだありません。本文の文章をドラッグ選択するか、「要素を選択してコメント」を使ってください。';
    state.docThreadsEl.appendChild(empty);
  }
}
