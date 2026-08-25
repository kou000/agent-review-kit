/* Shared DOM/text helpers (escaping, dates, clipboard, snippets). */

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Like esc(), but also turns literal "\n" / "\r\n" escape sequences into real
// newlines. Agent replies arrive from the CLI (resolve-comment --message),
// where a line break is almost always passed as the two characters backslash-n
// rather than a real newline; without this they render as a literal "\n" on a
// single line. User comment bodies come from the browser textarea (real
// newlines) and never need this. esc() runs first, so only the literal escape
// text is rewritten — real HTML stays escaped (sanitize behavior unchanged);
// the white-space: pre-wrap on .agent-response then lays the lines out, the
// same mechanism that already works for real newlines in .body.
export function escNl(s) {
  return esc(s).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
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

// Small button that copies `path` to the clipboard and flashes ✓ on success.
export function copyPathButton(path) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-path-btn';
  btn.textContent = '⧉';
  btn.title = 'パスをコピー: ' + path;
  btn.setAttribute('aria-label', 'ファイルパスをコピー');
  btn.addEventListener('click', function () {
    copyText(path).then(function (ok) {
      btn.textContent = ok ? '✓' : '✕';
      btn.classList.toggle('copied', ok);
      setTimeout(function () {
        btn.textContent = '⧉';
        btn.classList.remove('copied');
      }, 1200);
    });
  });
  return btn;
}

export function bodySnippet(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}
