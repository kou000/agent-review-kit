import { state } from '../state.js';

/* ---------- HTML document review (window.__DOC__) ---------- */

// The published document renders inside an iframe whose response carries a
// no-script CSP, so nothing in the agent-generated HTML can execute; all
// interaction below runs in this (parent) page and only reads/annotates the
// frame's DOM. Comment anchors are re-resolved on every render — CSS
// selector first, then selected-text search scored by surrounding context —
// so a re-published document keeps its comments wherever the target still
// exists, and everything else lands in the "位置を特定できない" section.

export function frameDoc() {
  try {
    return state.docFrame && state.docFrame.contentDocument;
  } catch (e) {
    return null;
  }
}

export function cssEscapeIdent(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Selector path for an element: a unique #id if it has one, otherwise a
// body-rooted tag:nth-of-type chain. Computed at comment time and stored in
// the htmlTarget; querySelector'd back on every render.
export function docCssPath(el) {
  const doc = el.ownerDocument;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const tag = cur.nodeName.toLowerCase();
    if (tag === 'html') break;
    if (cur.id && doc.querySelectorAll('#' + cssEscapeIdent(cur.id)).length === 1) {
      parts.unshift('#' + cssEscapeIdent(cur.id));
      return parts.join(' > ');
    }
    if (tag === 'body') {
      parts.unshift('body');
      break;
    }
    let nth = 1;
    let sib = cur;
    while ((sib = sib.previousElementSibling)) {
      if (sib.nodeName === cur.nodeName) nth++;
    }
    parts.unshift(tag + ':nth-of-type(' + nth + ')');
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

export function docElementLabel(el) {
  const tag = el.nodeName.toLowerCase();
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? tag + ' 「' + (text.length > 24 ? text.slice(0, 24) + '…' : text) + '」' : tag;
}

// Concatenated text of the frame body plus a map back to its text nodes.
// Marks are unwrapped before this is built, so offsets are stable across
// renders of the same revision.
export function docTextIndex(root) {
  const parts = [];
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  let n;
  while ((n = walker.nextNode())) {
    const parent = n.parentNode && n.parentNode.nodeName;
    if (parent === 'STYLE' || parent === 'SCRIPT' || parent === 'NOSCRIPT') continue;
    const len = n.nodeValue.length;
    nodes.push({ node: n, start: pos, end: pos + len });
    parts.push(n.nodeValue);
    pos += len;
  }
  return { text: parts.join(''), nodes: nodes };
}

// Map a live selection Range to [start, end) offsets in the text index.
export function docRangeOffsets(range, index) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < index.nodes.length; i++) {
    const entry = index.nodes[i];
    let intersects = false;
    try { intersects = range.intersectsNode(entry.node); } catch (e) { intersects = false; }
    if (!intersects) continue;
    let s = entry.start;
    let e2 = entry.end;
    if (range.startContainer === entry.node) s = entry.start + range.startOffset;
    if (range.endContainer === entry.node) e2 = entry.start + range.endOffset;
    if (start === -1) start = s;
    end = e2;
  }
  if (start === -1 || end <= start) return null;
  return { start: start, end: end };
}

function commonSuffixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Find the best occurrence of `sel` in `text`: score each hit by how much of
// the stored before/after context still matches, with a bonus for landing
// inside the originally recorded element (`prefer` = its text span).
export function docFindOccurrence(text, sel, before, after, prefer) {
  const hits = [];
  let i = text.indexOf(sel);
  while (i !== -1 && hits.length < 500) {
    hits.push(i);
    i = text.indexOf(sel, i + 1);
  }
  if (!hits.length) return -1;
  if (hits.length === 1) return hits[0];
  let best = hits[0];
  let bestScore = -1;
  hits.forEach(function (h) {
    let score = 0;
    if (before) score += commonSuffixLen(text.slice(Math.max(0, h - before.length), h), before);
    if (after) score += commonPrefixLen(text.slice(h + sel.length, h + sel.length + after.length), after);
    if (prefer && h >= prefer.start && h < prefer.end) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  });
  return best;
}

export function docSafeQuery(doc, selector) {
  if (!selector) return null;
  try {
    const el = doc.querySelector(selector);
    return el && doc.body.contains(el) ? el : null;
  } catch (e) {
    return null;
  }
}

// Text span [start, end) of an element within the index, or null when it has
// no text nodes of its own.
export function docElementSpan(index, el) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < index.nodes.length; i++) {
    if (!el.contains(index.nodes[i].node)) continue;
    if (start === -1) start = index.nodes[i].start;
    end = index.nodes[i].end;
  }
  return start === -1 ? null : { start: start, end: end };
}

export function docResolveElement(doc, index, t) {
  const bySelector = docSafeQuery(doc, t.selector);
  if (bySelector) return bySelector;
  // Selector broke (document re-published): fall back to the smallest
  // same-tag element that still contains the recorded leading text.
  const needle = String(t.elementText || '').trim();
  if (!needle) return null;
  const cands = doc.body.querySelectorAll(t.tag || '*');
  let best = null;
  let bestLen = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const txt = cands[i].textContent || '';
    if (txt.indexOf(needle) === -1) continue;
    if (txt.length < bestLen) {
      best = cands[i];
      bestLen = txt.length;
    }
  }
  return best;
}

// Resolve one htmlTarget against the current frame DOM. Returns
// {kind:'element', el, pos} or {kind:'text', start, end, pos}, or null when
// the target no longer exists (the comment then renders as unlocatable).
export function docResolveTarget(doc, index, t) {
  if (t.kind === 'element') {
    const el = docResolveElement(doc, index, t);
    if (!el) return null;
    const span = docElementSpan(index, el);
    return { kind: 'element', el: el, pos: span ? span.start : 0 };
  }
  if (!t.selectedText) return null;
  const container = docSafeQuery(doc, t.selector);
  const prefer = container ? docElementSpan(index, container) : null;
  const hit = docFindOccurrence(
    index.text, t.selectedText, t.contextBefore || '', t.contextAfter || '', prefer
  );
  if (hit === -1) return null;
  return { kind: 'text', start: hit, end: hit + t.selectedText.length, pos: hit };
}
