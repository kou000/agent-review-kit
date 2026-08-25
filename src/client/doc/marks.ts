import { bodySnippet } from '../dom.js';
import { frameDoc } from './resolve.js';

/* ---------- frame annotation (marks / element outlines) ---------- */

export function clearDocMarks(doc) {
  const marks = doc.querySelectorAll('mark.ark-mark');
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  }
  const els = doc.querySelectorAll('.ark-el-anchor');
  for (let j = 0; j < els.length; j++) {
    els[j].classList.remove('ark-el-anchor', 'ark-flash');
    els[j].removeAttribute('data-ark-comment');
  }
  doc.body.normalize();
}

// Wrap [s, e) of one text node in a comment mark. splitText keeps the
// leading part on the original node, so processing segments in reverse
// document order leaves earlier offsets valid.
function wrapTextNodeSegment(doc, node, s, e, topId, title) {
  const len = node.nodeValue.length;
  s = Math.max(0, Math.min(s, len));
  e = Math.max(s, Math.min(e, len));
  if (s === e) return;
  const target = s > 0 ? node.splitText(s) : node;
  if (e - s < target.nodeValue.length) target.splitText(e - s);
  const mark = doc.createElement('mark');
  mark.className = 'ark-mark';
  mark.setAttribute('data-ark-comment', topId);
  mark.title = title;
  target.parentNode.insertBefore(mark, target);
  mark.appendChild(target);
}

export function wrapDocRange(doc, index, start, end, top) {
  const title = 'コメント: ' + bodySnippet(top.body);
  const segs = [];
  for (let i = 0; i < index.nodes.length; i++) {
    const entry = index.nodes[i];
    if (entry.end <= start || entry.start >= end) continue;
    segs.push({
      node: entry.node,
      s: Math.max(0, start - entry.start),
      e: Math.min(entry.end, end) - entry.start,
    });
  }
  for (let j = segs.length - 1; j >= 0; j--) {
    try {
      wrapTextNodeSegment(doc, segs[j].node, segs[j].s, segs[j].e, top.id, title);
    } catch (e) {
      // Overlapping ranges can invalidate a segment; skip it rather than
      // losing the whole render.
    }
  }
}

export function markDocElement(el, top) {
  el.classList.add('ark-el-anchor');
  el.setAttribute('data-ark-comment', top.id);
  if (!el.title) el.title = 'コメント: ' + bodySnippet(top.body);
}

export function docJumpTo(topId) {
  const doc = frameDoc();
  if (!doc) return;
  const el = doc.querySelector('[data-ark-comment="' + topId + '"]');
  if (!el) return;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  el.classList.add('ark-flash');
  setTimeout(function () { el.classList.remove('ark-flash'); }, 1500);
}
