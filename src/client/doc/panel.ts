import { state } from '../state.js';
import { frameDoc } from './resolve.js';

// Collapsed state is a flag independent of the width, so reopening restores
// the previous (persisted) width untouched.
const DOC_PANEL_COLLAPSED_KEY = 'ark-doc-panel-collapsed';

export function setDocPanelCollapsed(on) {
  if (!state.docLayoutEl) return;
  state.docPanelCollapsed = on;
  state.docLayoutEl.classList.toggle('panel-collapsed', on);
  if (state.docReopenBtn) state.docReopenBtn.classList.toggle('visible', on);
  syncDocMarksHidden();
  try { localStorage.setItem(DOC_PANEL_COLLAPSED_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

// With the panel hidden the in-document comment highlights are noise, so the
// collapsed flag is mirrored into the iframe as a root class that neutralizes
// them. Also called from docFrameReady: on a reload the frame loads after the
// persisted collapsed state was already restored.
export function syncDocMarksHidden() {
  const doc = frameDoc();
  if (doc && doc.documentElement) {
    doc.documentElement.classList.toggle('ark-marks-hidden', state.docPanelCollapsed);
  }
}

export function restoreDocPanelCollapsed() {
  try {
    if (localStorage.getItem(DOC_PANEL_COLLAPSED_KEY) === '1') setDocPanelCollapsed(true);
  } catch (e) { /* ignore */ }
}
