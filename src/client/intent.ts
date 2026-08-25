import { state } from './state.js';

/* ---------- comment intent (修正依頼 / 質問) ----------
 * Every comment form carries the same 修正依頼 / 質問 choice, posted as
 * `intent`. "質問" means the agent answers without changing code — the
 * per-comment version of the read-only mode setting. Radio groups need a
 * unique name because several forms can be open at once (overall form,
 * a line form, one reply form per thread). */

export function intentFieldHtml() {
  const name = 'ark-intent-' + ++state.intentSeq;
  return '<div class="intent-field">' +
    '<label><input type="radio" name="' + name + '" value="fix" checked>' +
    '<span>修正依頼</span></label>' +
    '<label><input type="radio" name="' + name + '" value="question">' +
    '<span>質問（回答のみ・修正しない）</span></label>' +
    '</div>';
}

// Read-only mode forbids code changes, so 修正依頼 has no meaning there: lock
// every selector to 質問. Called with a freshly built form, and with no
// argument on each settings load so forms already open follow the toggle. The
// server applies the same rule on POST, which covers a form that was
// rendered before the setting flipped.
export function syncIntentFields(root?: any) {
  (root || document).querySelectorAll('.intent-field').forEach(function (field) {
    const fix = field.querySelector('input[value="fix"]');
    const question = field.querySelector('input[value="question"]');
    if (!fix || !question) return;
    if (state.readOnlyMode) question.checked = true;
    fix.disabled = state.readOnlyMode;
    question.disabled = state.readOnlyMode;
    field.classList.toggle('locked', state.readOnlyMode);
    let note = field.querySelector('.intent-locked-note');
    if (state.readOnlyMode && !note) {
      note = document.createElement('span');
      note.className = 'intent-locked-note';
      note.textContent = '読み取り専用モード中は質問のみ';
      field.appendChild(note);
    } else if (!state.readOnlyMode && note) {
      note.remove();
    }
  });
}

// `root` is the element the form markup was inserted into.
export function selectedIntent(root) {
  if (state.readOnlyMode) return 'question';
  const checked = root.querySelector('.intent-field input:checked');
  return checked ? checked.value : 'fix';
}
