/* ---------- 「リポジトリをエディタで開く」リンク ---------- */

/* One button per repository (not per file), shown next to the 「リポジトリの
 * ファイル」 headings on the review sidebar and the /files page. The URI is
 * built from settings.editorUriTemplate (env-file only, see types.ts) with
 * `{path}` replaced by the project directory from GET /api/status. */

import { api } from '../api.js';

// The template comes from the user's ~/.agent-review/.env and lands directly in
// an href, so only editor custom schemes are allowed — this whitelist is what
// keeps a javascript: / data: value out of the link (such a value simply gets
// no button).
const EDITOR_SCHEME = /^(vscode|vscode-insiders|vscodium|cursor|windsurf):/i;

// Scheme → display name, so the label matches whatever editor the template
// points at. Unknown-but-allowed schemes can't happen (same list as above).
const EDITOR_NAME = {
  'vscode': 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  'vscodium': 'VSCodium',
  'cursor': 'Cursor',
  'windsurf': 'Windsurf',
};

// Returns { uri, editor } for a valid editor template, or null when the
// template (or the path) can't be trusted / is missing.
export function editorUriFrom(template, projectDir) {
  if (typeof template !== 'string' || typeof projectDir !== 'string' || !projectDir) return null;
  const tpl = template.trim();
  const m = EDITOR_SCHEME.exec(tpl);
  if (!m) return null;
  // `{path}` is the only placeholder.
  const uri = tpl.split('{path}').join(projectDir);
  // Re-check after substitution: the scheme must still be the allowed one.
  if (!EDITOR_SCHEME.test(uri)) return null;
  return { uri: uri, editor: EDITOR_NAME[m[1].toLowerCase()] || 'エディタ' };
}

// Bordered link styled exactly like 「別タブで開く ↗」 (.repo-tree-open), or
// null when the template fails the scheme check — an invalid template shows no
// button at all rather than a dead one.
export function buildEditorLink(template, projectDir) {
  const parsed = editorUriFrom(template, projectDir);
  if (!parsed) return null;
  const a = document.createElement('a');
  a.className = 'repo-tree-open';
  a.href = parsed.uri;
  a.textContent = parsed.editor + ' で開く';
  a.title = projectDir + ' を ' + parsed.editor + ' で開く（' + parsed.uri + '）';
  // The review sidebar heading is a toggle; a click on the link must not
  // collapse/expand the tree (same handling as .repo-tree-open).
  a.addEventListener('click', function (e) { e.stopPropagation(); });
  return a;
}

// Append the button to a heading (or to the heading's button box, see
// .repo-tree-actions) once GET /api/status answers — it carries both projectDir
// and the settings. Auxiliary UI: a failed fetch just means no button, like
// loadCommitList's silent catch.
export function appendEditorLink(container) {
  api('GET', '/api/status').then(function (status) {
    const link = buildEditorLink(
      status.settings ? status.settings.editorUriTemplate : null,
      status.projectDir
    );
    if (link) container.appendChild(link);
  }).catch(function () { /* auxiliary; ignore fetch failures */ });
}
