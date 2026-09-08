/* Shared DOM/text helpers (escaping, dates, clipboard, snippets). */

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Turns literal "\n" / "\r\n" escape sequences into real newlines. Agent
// replies arrive from the CLI (resolve-comment --message), where a line break
// is almost always passed as the two characters backslash-n rather than a real
// newline; without this the Markdown renderer sees one long line and the break
// shows up as a literal "\n". User comment bodies come from the browser
// textarea (real newlines) and never need this.
export function unescapeNl(s) {
  return String(s == null ? '' : s).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

// Only accept self-contained base64 image data URIs for inline agent images.
// This blocks javascript:, http(s):, and any other scheme, so a crafted
// comments.json can never turn an attached "image" into an external request
// or script. The value is still esc()'d before it lands in an attribute.
export function isSafeImageDataUri(s) {
  return typeof s === 'string' &&
    /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d as any)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------- copy path ---------- */

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(
      function () { return true; },
      function () { return copyTextFallback(text); }
    );
  }
  return Promise.resolve(copyTextFallback(text));
}

function copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

// Idle label of copyPathButton. Emoji (U+1F4CB) rather than a symbol glyph such
// as U+29C9 '⧉': those live in fonts that many environments don't ship, so the
// button rendered as tofu (□). The emoji matches the 📌 / 💬 / ✏️ / 🔧 buttons
// already used elsewhere, which are known to render here.
const COPY_PATH_IDLE = '📋';
// Flashed for COPY_PATH_FLASH_MS after a click, then reverted to the idle label.
const COPY_PATH_OK = '✓';
const COPY_PATH_FAIL = '✕';
const COPY_PATH_FLASH_MS = 1200;

// Small button that copies `path` to the clipboard and flashes ✓ on success.
export function copyPathButton(path) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-path-btn';
  btn.textContent = COPY_PATH_IDLE;
  btn.title = 'パスをコピー: ' + path;
  btn.setAttribute('aria-label', 'ファイルパスをコピー');
  btn.addEventListener('click', function () {
    copyText(path).then(function (ok) {
      btn.textContent = ok ? COPY_PATH_OK : COPY_PATH_FAIL;
      btn.classList.toggle('copied', ok);
      setTimeout(function () {
        btn.textContent = COPY_PATH_IDLE;
        btn.classList.remove('copied');
      }, COPY_PATH_FLASH_MS);
    });
  });
  return btn;
}

// Where every 「このファイルを別タブで開く」 affordance points: the /files
// browser with that file already open in its viewer and the left tree
// expanded down to it (see renderTreePage / revealTreeFile). The standalone
// /file/<path> page still exists and still works — it just isn't what these
// links choose, because arriving with the tree in place is what makes the
// neighbouring files reachable.
export function fileTabUrl(path) {
  return '/files?file=' + encodeURIComponent(path);
}

// Small link in a file's diff header (帯) that opens that file in a new tab:
// the whole current file, not just the changed hunks. Deleted files have no
// working-tree content, so callers skip them. Uses an <a> (not a button) so
// 中クリック / 右クリックの「新しいタブで開く」 も普通に効く。
export function openFileTabButton(path) {
  const link = document.createElement('a');
  link.className = 'open-file-btn';
  link.href = fileTabUrl(path);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '↗';
  link.title = path + ' の全文を別タブで開く（左にファイルツリー付き）';
  link.setAttribute('aria-label', 'このファイルを別タブで開く');
  return link;
}

export function bodySnippet(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}
