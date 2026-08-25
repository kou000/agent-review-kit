import { state } from './state.js';
import { updatePinLayout } from './diff/pins.js';

/* ---------- draggable panel widths ---------- */

// Sidebar width (px) and pin-panel width (viewport %) are driven by CSS
// variables so the pin margin-right stays in sync with the panel width by
// construction. Both are clamped and persisted in localStorage.
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_KEY = 'ark-sidebar-width';
export const PIN_MIN = 15; // % of viewport (per panel)
const PIN_MAX = 75;
const PIN_KEY = 'ark-pin-width'; // last-used panel width, reused as a default

export function setSidebarWidth(px) {
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  return w;
}

export function clampPinWidth(pct) {
  return Math.max(PIN_MIN, Math.min(PIN_MAX, pct));
}

// Last-used panel width, reused as the default for the first pinned panel.
export function savedPinDefault() {
  try {
    const p = parseFloat(localStorage.getItem(PIN_KEY));
    if (!isNaN(p)) return p;
  } catch (e) { /* ignore */ }
  return 45;
}

// Shared drag loop. onMove(clientX) runs on each pointermove; document-level
// listeners (capture phase) guarantee the drag ends even if the pointer
// leaves the handle. body.resizing disables text selection for the duration.
export function startDrag(handle, onMove) {
  document.body.classList.add('resizing');
  if (handle) handle.classList.add('dragging');
  function move(ev) {
    if (typeof ev.clientX !== 'number') return;
    onMove(ev.clientX);
  }
  function up() {
    document.body.classList.remove('resizing');
    if (handle) handle.classList.remove('dragging');
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', up, true);
  }
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
}

// Wire a drag handle sitting on the right edge of a left-hand pane: the pane's
// left edge stays put during the drag, so its width is (pointerX - left).
// `apply` clamps/applies the width and returns the value stored under `key`.
// stopPropagation keeps the handle's pointerdown from ever reaching the
// document-level diff-selection handlers.
function attachLeftPaneResize(handle, pane, apply, key) {
  handle.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  handle.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const left = pane.getBoundingClientRect().left;
    startDrag(handle, function (clientX) {
      const w = apply(clientX - left);
      try { localStorage.setItem(key, String(w)); } catch (e2) { /* ignore */ }
    });
  });
}

export function attachSidebarResize(handle, sidebar) {
  attachLeftPaneResize(handle, sidebar, setSidebarWidth, SIDEBAR_KEY);
}

// Resize a single pin panel. The panel's right edge is fixed during its own
// drag (the stack is right-anchored; only this panel's left edge moves), so
// the width is (rightEdge - pointerX). Persist it as the reusable default.
export function attachPinResize(handle, panel) {
  handle.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  handle.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const entry = state.pins.find(function (p) { return p.el === panel; });
    if (!entry) return;
    const rightPx = panel.getBoundingClientRect().right;
    startDrag(handle, function (clientX) {
      const vw = window.innerWidth || document.documentElement.clientWidth || 1;
      const pct = clampPinWidth((rightPx - clientX) / vw * 100);
      entry.width = pct;
      updatePinLayout();
      try { localStorage.setItem(PIN_KEY, String(pct)); } catch (e2) { /* ignore */ }
    });
  });
}

export function restorePersistedWidths() {
  try {
    const s = parseFloat(localStorage.getItem(SIDEBAR_KEY));
    if (!isNaN(s)) setSidebarWidth(s);
  } catch (e) { /* ignore */ }
  // Pin widths are per-panel and applied when a panel is created; nothing to
  // restore globally (the last-used width is read via savedPinDefault).
}

// Tree-pane width (px) on the /files page. Deliberately NOT sharing
// --sidebar-width / ark-sidebar-width with the review sidebar: there the tree
// is a side navigation next to the diff, while on /files it IS the page — it
// lists every tracked file, so deep paths routinely need more room than the
// review sidebar's 480px cap, and a wider pane there should not shrink the
// diff on the review page. Same flavour as setSidebarWidth otherwise (clamp,
// CSS variable, localStorage), with the identical minimum so the drag feels
// the same on both pages.
const TREE_SIDE_MIN = SIDEBAR_MIN;
const TREE_SIDE_MAX = 720;
const TREE_SIDE_KEY = 'ark-tree-width';

export function setTreeSideWidth(px) {
  const w = Math.max(TREE_SIDE_MIN, Math.min(TREE_SIDE_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--tree-side-width', w + 'px');
  return w;
}

export function attachTreeSideResize(handle, side) {
  attachLeftPaneResize(handle, side, setTreeSideWidth, TREE_SIDE_KEY);
}

export function restoreTreeSideWidth() {
  try {
    const w = parseFloat(localStorage.getItem(TREE_SIDE_KEY));
    if (!isNaN(w)) setTreeSideWidth(w);
  } catch (e) { /* ignore */ }
}

// Comment-panel width (px) on the /doc/<id> page, same CSS-variable +
// localStorage pattern as the sidebar. The max is relative to the viewport
// so the document iframe always keeps a usable sliver.
const DOC_PANEL_MIN = 260;
const DOC_PANEL_KEY = 'ark-doc-panel-width';

export function setDocPanelWidth(px) {
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const max = Math.max(DOC_PANEL_MIN, Math.round(vw * 0.85));
  const w = Math.max(DOC_PANEL_MIN, Math.min(max, Math.round(px)));
  document.documentElement.style.setProperty('--doc-panel-width', w + 'px');
  return w;
}

// Wire the /doc page's drag handle. The panel's right edge is pinned to the
// viewport, so its width is (rightEdge - pointerX). While dragging, CSS
// disables pointer events on the iframe (body.resizing) so the frame never
// swallows the pointermove stream.
export function attachDocPanelResize(handle, panel) {
  handle.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  handle.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const right = panel.getBoundingClientRect().right;
    startDrag(handle, function (clientX) {
      const w = setDocPanelWidth(right - clientX);
      try { localStorage.setItem(DOC_PANEL_KEY, String(w)); } catch (e2) { /* ignore */ }
    });
  });
}

export function restoreDocPanelWidth() {
  try {
    const w = parseFloat(localStorage.getItem(DOC_PANEL_KEY));
    if (!isNaN(w)) setDocPanelWidth(w);
  } catch (e) { /* ignore */ }
}
