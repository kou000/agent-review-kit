import { copyPathButton } from '../dom.js';
import { attachPinResize, clampPinWidth, PIN_MIN, savedPinDefault } from '../resize.js';
import { DIFF, state } from '../state.js';
import { buildDiffTable } from './table.js';

/* ---------- pinned split view (right panels) ---------- */

// Total width (viewport %) the stack may occupy. A newcomer first shrinks to
// whatever room is left; only when even a minimum-width panel (PIN_MIN) won't
// fit do we drop the oldest pin. Defaults (first 45, subsequent 25) are chosen
// so three usable panels still fit under this cap (45 + 25 + 15 = 85).
const PIN_TOTAL_MAX = 85;
const PIN_NEXT_DEFAULT = 25; // subsequent panels; first uses savedPinDefault()

function ensurePinStack() {
  if (state.pinStack) return state.pinStack;
  state.pinStack = document.createElement('div');
  state.pinStack.id = 'pin-stack';
  document.body.appendChild(state.pinStack);
  return state.pinStack;
}

function pinTotalWidth() {
  return state.pins.reduce(function (sum, p) { return sum + p.width; }, 0);
}

// Push panel widths and the combined right-side gutter into the DOM. The
// main content's margin-right tracks --pin-total-width so it never overlaps.
export function updatePinLayout() {
  state.pins.forEach(function (p) { p.el.style.width = p.width + 'vw'; });
  document.documentElement.style.setProperty('--pin-total-width', pinTotalWidth() + 'vw');
  document.body.classList.toggle('has-pin', state.pins.length > 0);
}

export function updatePinButtons() {
  const pinned = {};
  state.pins.forEach(function (p) { pinned[String(p.index)] = true; });
  document.querySelectorAll('.pin-btn').forEach(function (b: any) {
    const active = !!pinned[b.dataset.fileIndex];
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  // Repo-file tree rows: mark the ones whose panel is currently open.
  document.querySelectorAll('.repo-tree .tree-file').forEach(function (r: any) {
    r.classList.toggle('active', !!pinned['repo:' + r.dataset.path]);
  });
}

// Build a single display-only panel element for DIFF.files[fi].
function buildPinPanel(fi) {
  const file = DIFF.files[fi];
  const panel = document.createElement('aside');
  panel.className = 'pin-panel';
  panel.dataset.fileIndex = fi;
  panel.innerHTML =
    '<div class="pin-panel-header">' +
    '<span class="pin-panel-file"></span>' +
    '<span class="pin-panel-note">表示専用</span>' +
    '<button class="pin-panel-close" type="button" title="固定を解除">✕</button>' +
    '</div>' +
    '<div class="pin-panel-body"></div>';
  panel.querySelector('.pin-panel-file').textContent = file.path;
  (panel.querySelector('.pin-panel-file') as any).title = file.path;
  const panelHeader = panel.querySelector('.pin-panel-header');
  panelHeader.insertBefore(
    copyPathButton(file.path),
    panel.querySelector('.pin-panel-note')
  );
  panel.querySelector('.pin-panel-close').addEventListener('click', function () {
    removePin(fi);
  });

  const bodyEl = panel.querySelector('.pin-panel-body');
  if (file.status === 'binary' || !file.hunks.length) {
    const p = document.createElement('div');
    p.className = 'empty-diff';
    p.textContent = file.status === 'binary' ? 'バイナリファイル（表示できません）' : '内容の変更はありません';
    bodyEl.appendChild(p);
  } else {
    // Display-only table (interactive=false): number cells get no data-file,
    // so document-level selection handlers skip them.
    bodyEl.appendChild(buildDiffTable(file, false));
  }

  // Left-edge drag handle for resizing this panel individually.
  const resizer = document.createElement('div');
  resizer.className = 'pin-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでパネル幅を調整';
  attachPinResize(resizer, panel);
  panel.appendChild(resizer);

  // Belt-and-suspenders: even though the panel's number cells carry no
  // data-file, stop mousedown from ever reaching the document-level selection
  // handler so the panel can never start a main-diff selection.
  panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  return panel;
}

export function removePin(fi) {
  const i = state.pins.findIndex(function (p) { return p.index === fi; });
  if (i < 0) return;
  state.pins[i].el.remove();
  state.pins.splice(i, 1);
  if (!state.pins.length && state.pinStack) {
    state.pinStack.remove();
    state.pinStack = null;
  }
  updatePinLayout();
  updatePinButtons();
}

// Shared pin-stack insertion for any panel kind. `key` identifies the panel:
// a DIFF.files index for diff panels, 'repo:<path>' for repo-file panels.
export function addPin(key, panel) {
  if (state.pins.some(function (p) { return p.index === key; })) return;

  // Target width: first panel uses the last-used width (default 45%), the rest
  // use PIN_NEXT_DEFAULT. Shrink the newcomer to whatever room is left; if even
  // PIN_MIN won't fit, drop the oldest pin(s) until it does (with a warning).
  const target = state.pins.length === 0 ? clampPinWidth(savedPinDefault()) : PIN_NEXT_DEFAULT;
  let width = Math.min(target, PIN_TOTAL_MAX - pinTotalWidth());
  if (width < PIN_MIN) {
    while (state.pins.length && PIN_TOTAL_MAX - pinTotalWidth() < PIN_MIN) {
      const oldest = state.pins[0];
      console.warn('agent-review-kit: pinned panels exceed available width; unpinning ' +
        String(oldest.index));
      removePin(oldest.index);
    }
    width = Math.min(target, PIN_TOTAL_MAX - pinTotalWidth());
  }
  width = clampPinWidth(width);

  const stack = ensurePinStack();
  state.pins.push({ index: key, width: width, el: panel });
  stack.appendChild(panel); // newest at the right edge
  updatePinLayout();
  updatePinButtons();
}

function pinFile(fi) {
  const file = DIFF.files[fi];
  if (!file) return;
  if (state.pins.some(function (p) { return p.index === fi; })) return;
  addPin(fi, buildPinPanel(fi));
}

// Re-📌 an already-pinned file unpins just that panel; 📌 a new file adds one.
export function togglePin(fi) {
  if (state.pins.some(function (p) { return p.index === fi; })) removePin(fi);
  else pinFile(fi);
}
