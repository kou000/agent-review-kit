/* Page context and shared mutable state.
 *
 * The server-rendered pages inject exactly one window.__*__ payload (see
 * src/render.ts); DIFF/DOC are read once here and shared by every module.
 * ES module import bindings cannot be reassigned from another module, so
 * every top-level `let` that used to be reassigned across sections of the
 * old single-file app.js lives here as a property of `state` instead. */

export const DIFF = window.__DIFF__ || { files: [], base: null, generatedAt: '' };
// HTML document review mode (/doc/<id>): set by renderDocumentHtml. The
// document body renders in an iframe; all review chrome stays out here.
export const DOC = window.__DOC__ || null;
export const app = document.getElementById('app');
export const badge = document.getElementById('unresolved-badge');
export const diffMeta = document.getElementById('diff-meta');
export const connState = document.getElementById('conn-state');

export const state: any = {
  comments: [],
  refreshTimer: null, // 3s polling handle; cleared when the review finishes
  selection: null, // {file, side, anchor:{line,diffLine}, head:{line,diffLine}}
  openForm: null, // form row element currently shown
  dragging: false,
  // Multiple files can be pinned at once; each becomes a panel in a right-side
  // horizontal stack. `pins` holds them in visual left→right order (oldest
  // first, newest appended at the right edge). `width` is a viewport percentage.
  pins: [], // [{ index, width, el }]
  pinStack: null, // right-side flex-row container (created lazily)
  viewed: {}, // { [filePath]: contentHash } for currently-viewed files
  fileHashes: {}, // { [filePath]: contentHash } for the current diff
  intentSeq: 0,
  // Mirrors settings.readOnlyMode, refreshed by applySettings on every poll.
  readOnlyMode: false,
  // Per-file gap controllers for the main (interactive) diff table, rebuilt on
  // every renderDiff. renderComments uses them (via tryExpandTo) to reveal a
  // commented line that is hidden inside a still-collapsed gap.
  expanders: {},
  sidebarBuilt: false,
  // Settled threads live in a collapsed section at the bottom of the list, the
  // same idea as the 確認済み file section. In-memory only: the list re-renders
  // on every refresh, and defaulting back to collapsed is the useful default.
  resolvedListOpen: false,
  // Persisted thread-collapse toggles; loaded from localStorage in threads.ts.
  threadCollapse: {},
  toastStack: null,
  lastCommentsJson: '',
  modeBadge: null,
  branchLabel: null,
  settingsPanel: null,
  // ---- HTML document review (/doc/<id>) ----
  docFrame: null, // iframe element
  docFrameWired: false, // load fired and listeners attached
  docThreadsEl: null, // right-panel threads container
  docFormSlot: null, // right-panel slot for the comment form
  docCountEl: null, // right-panel comment count heading
  docPickMode: false,
  docPickBtn: null,
  docFloatBtn: null, // floating「コメント」button over a text selection
  docHoverEl: null, // element currently outlined in pick mode
  docLayoutEl: null, // .doc-layout root; carries the panel-collapsed class
  docReopenBtn: null, // right-edge tab shown while the panel is collapsed
  docPanelCollapsed: false, // mirrored into the iframe as ark-marks-hidden
};
