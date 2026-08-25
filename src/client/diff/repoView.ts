import { api } from '../api.js';
import { copyPathButton, esc } from '../dom.js';
import { attachPinResize } from '../resize.js';
import { DIFF, state } from '../state.js';
import { addPin, removePin } from './pins.js';
import { byName } from './sidebar.js';

/* ---------- repository file viewer (support feature) ---------- */

// Render a full repo file as a read-only two-column table (line number +
// highlighted line). Shared by the repo-file pin panel and the standalone
// /file/<path> page. f mirrors the /api/file payload.
export function buildFileTable(f) {
  if (f.binary || f.tooLarge) {
    const d = document.createElement('div');
    d.className = 'empty-diff';
    d.textContent = f.binary
      ? 'バイナリファイル（表示できません）'
      : 'ファイルが大きすぎるため表示できません';
    return d;
  }
  const table = document.createElement('table');
  table.className = 'diff file-view';
  const lines = f.lines || [];
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const body = f.html && typeof f.html[i] === 'string' ? f.html[i] : esc(lines[i]);
    rows.push(
      '<tr><td class="num static">' + (i + 1) + '</td><td class="code">' + body + '</td></tr>'
    );
  }
  table.innerHTML = rows.join('');
  return table;
}

function buildRepoPinPanel(key, f) {
  const panel = document.createElement('aside');
  panel.className = 'pin-panel repo-pin-panel';
  panel.innerHTML =
    '<div class="pin-panel-header">' +
    '<span class="pin-panel-file"></span>' +
    '<a class="pin-panel-open" target="_blank" rel="noopener" title="新しいタブで開く">↗</a>' +
    '<span class="pin-panel-note">表示専用</span>' +
    '<button class="pin-panel-close" type="button" title="閉じる">✕</button>' +
    '</div>' +
    '<div class="pin-panel-body"></div>';
  const nameEl: any = panel.querySelector('.pin-panel-file');
  nameEl.textContent = f.path;
  nameEl.title = f.path;
  (panel.querySelector('.pin-panel-open') as any).href = '/file/' + encodeURIComponent(f.path);
  panel.querySelector('.pin-panel-header').insertBefore(
    copyPathButton(f.path),
    panel.querySelector('.pin-panel-open')
  );
  panel.querySelector('.pin-panel-close').addEventListener('click', function () {
    removePin(key);
  });
  panel.querySelector('.pin-panel-body').appendChild(buildFileTable(f));

  const resizer = document.createElement('div');
  resizer.className = 'pin-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでパネル幅を調整';
  attachPinResize(resizer, panel);
  panel.appendChild(resizer);
  panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  return panel;
}

// Open a repository file in the pin stack; clicking the same file again
// closes its panel. Content is fetched on open, so it always reflects the
// working tree at that moment.
export function openRepoFile(filePath) {
  const key = 'repo:' + filePath;
  if (state.pins.some(function (p) { return p.index === key; })) {
    removePin(key);
    return;
  }
  api('GET', '/api/file?path=' + encodeURIComponent(filePath)).then(function (data) {
    addPin(key, buildRepoPinPanel(key, data.file));
  }).catch(function (err) {
    alert('ファイルを開けませんでした: ' + err);
  });
}

// Nested tree of every tracked file, for the sidebar's「リポジトリのファイル」
// section and the standalone /files page. Directories start collapsed and
// their children render lazily on first expand (repos can hold thousands of
// files). Files already in the diff are dimmed — their content is on the main
// page. Clicking a file toggles its pin panel; the /files page swaps that
// behavior via onOpenFile (omitted = review-page behavior, unchanged).
export function renderRepoTree(files, container, onOpenFile?) {
  const inDiff = {};
  DIFF.files.forEach(function (f) { inDiff[f.path] = true; });
  const root = { dirs: {}, files: [] };
  files.forEach(function (p) {
    const parts = String(p).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
      node = node.dirs[parts[i]];
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  });
  (function render(node, parent, depth) {
    Object.keys(node.dirs).sort().forEach(function (name) {
      const dEl = document.createElement('div');
      dEl.className = 'tree-dir repo-dir';
      dEl.style.paddingLeft = (4 + depth * 12) + 'px';
      dEl.textContent = '▸ ' + name + '/';
      parent.appendChild(dEl);
      const children = document.createElement('div');
      children.hidden = true;
      parent.appendChild(children);
      let built = false;
      dEl.addEventListener('click', function () {
        const open = children.hidden;
        children.hidden = !open;
        dEl.textContent = (open ? '▾ ' : '▸ ') + name + '/';
        if (open && !built) {
          built = true;
          render(node.dirs[name], children, depth + 1);
        }
      });
    });
    node.files.sort(byName).forEach(function (f) {
      const fEl = document.createElement('div');
      fEl.className = 'tree-file repo-file' + (inDiff[f.path] ? ' in-diff' : '');
      fEl.style.paddingLeft = (4 + depth * 12) + 'px';
      fEl.dataset.path = f.path;
      const label = document.createElement('span');
      label.className = 'tree-name';
      label.textContent = f.name;
      label.title = inDiff[f.path] ? f.path + '（差分に含まれるファイル）' : f.path;
      fEl.appendChild(label);
      // 「新しいタブで開く」 link: pin panels vanish on the page's auto reload,
      // so offer a standalone /file/<path> tab as a stable alternative.
      const open = document.createElement('a');
      open.className = 'repo-file-open';
      open.href = '/file/' + encodeURIComponent(f.path);
      open.target = '_blank';
      open.rel = 'noopener';
      open.title = f.path + ' を新しいタブで開く';
      open.setAttribute('aria-label', 'このファイルを新しいタブで開く');
      open.textContent = '↗';
      open.addEventListener('click', function (e) { e.stopPropagation(); });
      fEl.appendChild(open);
      fEl.addEventListener('click', function () { (onOpenFile || openRepoFile)(f.path); });
      parent.appendChild(fEl);
    });
  })(root, container, 0);
}
