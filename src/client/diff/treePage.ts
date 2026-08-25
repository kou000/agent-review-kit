import { api } from '../api.js';
import { copyPathButton } from '../dom.js';
import { attachTreeSideResize, restoreTreeSideWidth } from '../resize.js';
import { app, diffMeta } from '../state.js';
import { buildFileTable, renderRepoTree } from './repoView.js';

/* ---------- standalone repository tree page (/files) ---------- */

// api() puts the whole response body in the Error message ("400 {…}"), which
// is unreadable in the UI. Pull out the JSON error field when there is one.
function errorText(err) {
  const raw = String(err && err.message ? err.message : err);
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    try {
      const body = JSON.parse(m[0]);
      if (body && body.error) return String(body.error);
    } catch (e) {
      // 本文が JSON でなければそのまま見せる。
    }
  }
  return raw;
}

// Time the matched line stays highlighted after a jump from a search result,
// matching focusComment's flash.
const LINE_FLASH_MS = 1500;

// Two-pane page for browsing every tracked repository file (window.__TREE__
// set): the left pane reuses the sidebar's repo tree, the right pane shows
// the selected file read-only. Unlike the review page this one never polls
// or reloads, so expanded directories and the open file survive the agent
// regenerating the diff.
export function renderTreePage() {
  diffMeta.textContent = 'リポジトリのファイル';
  restoreTreeSideWidth();

  // Same shell trick as buildSidebarShell: wrap the left pane and #app in a
  // .layout flex row (#app becomes the viewer pane).
  const parent = app.parentNode;
  const layout = document.createElement('div');
  layout.className = 'layout tree-page';
  parent.insertBefore(layout, app);

  const side = document.createElement('aside');
  side.className = 'sidebar tree-page-side';
  const heading = document.createElement('div');
  heading.className = 'sidebar-title';
  heading.textContent = 'リポジトリのファイル';
  side.appendChild(heading);

  // 検索ボックス（左ペイン上部）: git grep をサーバ側で実行し、結果でツリー
  // の表示を差し替える。
  const search = document.createElement('div');
  search.className = 'tree-search';
  const searchRow = document.createElement('div');
  searchRow.className = 'tree-search-row';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'tree-search-input';
  input.placeholder = 'ファイルの中を検索';
  input.setAttribute('aria-label', 'リポジトリのファイル内を検索');
  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.textContent = '検索';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'クリア';
  clearBtn.title = 'ファイルツリーに戻る';
  clearBtn.hidden = true;
  searchRow.appendChild(input);
  searchRow.appendChild(runBtn);
  searchRow.appendChild(clearBtn);
  search.appendChild(searchRow);

  const optRow = document.createElement('div');
  optRow.className = 'tree-search-opts';
  function optCheckbox(labelText) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    label.appendChild(box);
    label.appendChild(document.createTextNode(labelText));
    optRow.appendChild(label);
    return box;
  }
  const regexBox = optCheckbox('正規表現');
  const caseBox = optCheckbox('大文字小文字を区別');
  search.appendChild(optRow);
  side.appendChild(search);

  const treeWrap = document.createElement('div');
  treeWrap.className = 'repo-tree';
  treeWrap.textContent = '読み込み中…';
  side.appendChild(treeWrap);

  // Search results live next to the tree rather than replacing it: the tree
  // can hold thousands of rows (built lazily per directory), so hiding it is
  // much cheaper than rebuilding it on every クリア — and its expanded state
  // survives a search.
  const results = document.createElement('div');
  results.className = 'tree-search-results';
  results.hidden = true;
  side.appendChild(results);

  // Vertical drag handle between the tree pane and the viewer, same element
  // (and same drag machinery) as the review page's sidebar resizer.
  const resizer = document.createElement('div');
  resizer.className = 'sidebar-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.title = 'ドラッグでツリーの幅を調整';
  attachTreeSideResize(resizer, side);

  layout.appendChild(side);
  layout.appendChild(resizer);
  layout.appendChild(app);

  // Right pane: hint / error / file table. Replaced wholesale on each state
  // change, mirroring how renderDiff owns #app.
  function showMessage(text) {
    app.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty-diff';
    box.textContent = text;
    app.appendChild(box);
  }
  showMessage('左のツリーからファイルを選択してください');

  // Single selection: reuse the sidebar tree's .active style to mark the
  // file currently shown in the viewer.
  function markActive(filePath) {
    treeWrap.querySelectorAll('.tree-file.active').forEach(function (el) {
      el.classList.remove('active');
    });
    treeWrap.querySelectorAll('.tree-file').forEach(function (el: any) {
      if (el.dataset.path === filePath) el.classList.add('active');
    });
  }

  // Jump to one line of the file just rendered in the viewer and flash it.
  // buildFileTable emits one tr per line, so the nth row is the nth line;
  // the number cell is checked anyway before trusting the index.
  function flashLine(table, line) {
    const rows = table.querySelectorAll('tr');
    function lineNumOf(el) {
      const num = el ? el.querySelector('td.num') : null;
      return num ? num.textContent : '';
    }
    let tr: any = rows[line - 1];
    if (lineNumOf(tr) !== String(line)) {
      tr = null;
      for (let i = 0; i < rows.length; i++) {
        if (lineNumOf(rows[i]) === String(line)) {
          tr = rows[i];
          break;
        }
      }
    }
    if (!tr) return;
    if (typeof tr.scrollIntoView === 'function') {
      tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    tr.classList.add('grep-line-flash');
    setTimeout(function () { tr.classList.remove('grep-line-flash'); }, LINE_FLASH_MS);
  }

  // Fetch on every click so the content always reflects the working tree at
  // that moment (same policy as openRepoFile). Failures render inside the
  // viewer — no alert, the tree stays usable. `line` (search results only)
  // scrolls to and highlights that line once the file is rendered.
  function openInViewer(filePath, line?) {
    markActive(filePath);
    api('GET', '/api/file?path=' + encodeURIComponent(filePath)).then(function (data) {
      const f = data.file;
      const box = document.createElement('section');
      box.className = 'file';
      const header = document.createElement('div');
      header.className = 'file-header';
      header.innerHTML = '<span class="file-name"></span>';
      const nameEl: any = header.querySelector('.file-name');
      nameEl.textContent = f.path;
      nameEl.title = f.path;
      header.appendChild(copyPathButton(f.path));
      // 「新しいタブで開く」: the standalone /file/<path> page for this file.
      const open = document.createElement('a');
      open.className = 'file-open-tab';
      open.href = '/file/' + encodeURIComponent(f.path);
      open.target = '_blank';
      open.rel = 'noopener';
      open.title = f.path + ' を新しいタブで開く';
      open.textContent = '新しいタブで開く ↗';
      header.appendChild(open);
      box.appendChild(header);
      const table = buildFileTable(f);
      box.appendChild(table);
      app.innerHTML = '';
      app.appendChild(box);
      // バイナリ・サイズ超過は table ではなくメッセージ div が返る。
      if (line && table.tagName === 'TABLE') flashLine(table, line);
    }).catch(function (err) {
      showMessage('ファイルを読み込めませんでした（' + filePath + '）: ' + errorText(err));
    });
  }

  /* ---------- search (GET /api/grep) ---------- */

  function showTree() {
    results.hidden = true;
    results.textContent = '';
    treeWrap.hidden = false;
    clearBtn.hidden = true;
  }

  // Replace the tree with the results area, headed by `text` (status line,
  // error, or the result count).
  function showResults(text) {
    treeWrap.hidden = true;
    results.hidden = false;
    results.textContent = '';
    const note = document.createElement('div');
    note.className = 'tree-search-note';
    note.textContent = text;
    results.appendChild(note);
    clearBtn.hidden = false;
  }

  function renderHits(query, data) {
    const hits = data.results || [];
    if (!hits.length) {
      showResults('「' + query + '」に一致する行はありません');
      return;
    }
    showResults('検索結果 (' + hits.length + '件' + (data.truncated ? '以上' : '') + ')');
    hits.forEach(function (hit) {
      const row = document.createElement('div');
      row.className = 'grep-hit';
      const loc = document.createElement('div');
      loc.className = 'grep-hit-loc';
      loc.textContent = hit.path + ':' + hit.line;
      loc.title = hit.path + ':' + hit.line;
      const text = document.createElement('div');
      text.className = 'grep-hit-text';
      // textContent 固定: マッチ行はリポジトリの中身そのままなので、HTML と
      // して解釈させない。
      text.textContent = hit.text;
      text.title = hit.text;
      row.appendChild(loc);
      row.appendChild(text);
      row.addEventListener('click', function () {
        results.querySelectorAll('.grep-hit.active').forEach(function (el) {
          el.classList.remove('active');
        });
        row.classList.add('active');
        openInViewer(hit.path, hit.line);
      });
      results.appendChild(row);
    });
    if (data.truncated) {
      const more = document.createElement('div');
      more.className = 'tree-search-note tree-search-more';
      more.textContent = '結果が多いため打ち切りました。検索語を絞ってください。';
      results.appendChild(more);
    }
  }

  function runSearch() {
    const query = input.value.trim();
    if (!query) {
      showTree();
      return;
    }
    showResults('検索中…');
    api(
      'GET',
      '/api/grep?q=' + encodeURIComponent(query) +
        (regexBox.checked ? '&regex=1' : '') +
        (caseBox.checked ? '&case=1' : '')
    ).then(function (data) {
      renderHits(query, data);
    }).catch(function (err) {
      showResults('検索に失敗しました: ' + errorText(err));
    });
  }

  runBtn.addEventListener('click', runSearch);
  // Enter は検索 UI 全体で拾う: チェックボックスにフォーカスがあると入力欄
  // だけの keydown では Enter を拾えず、「検索語を入れる → 正規表現を
  // クリック → Enter」で何も起きなかった。ボタン上の Enter はそのボタンを
  // 押す既定挙動（クリアなど）を残すため素通しする。
  search.addEventListener('keydown', function (e: any) {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (target && target.tagName === 'BUTTON') return;
    e.preventDefault();
    runSearch();
  });
  // オプション変更は即時に結果へ反映する。まだ検索していない（結果が出て
  // いない・検索語が空）ときは何もしない。
  function rerunIfSearching() {
    if (results.hidden || !input.value.trim()) return;
    runSearch();
  }
  regexBox.addEventListener('change', rerunIfSearching);
  caseBox.addEventListener('change', rerunIfSearching);
  clearBtn.addEventListener('click', function () {
    input.value = '';
    showTree();
    input.focus();
  });

  api('GET', '/api/repo-files').then(function (data) {
    const files = data.files || [];
    treeWrap.textContent = '';
    renderRepoTree(files, treeWrap, openInViewer);
    heading.textContent = 'リポジトリのファイル (' + files.length + ')';
    if (!files.length) treeWrap.textContent = '追跡中のファイルがありません';
  }).catch(function (err) {
    treeWrap.textContent = '取得に失敗しました: ' + errorText(err);
  });
}
