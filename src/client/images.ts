/* Comment attachment images: paste-to-upload plumbing shared by every
 * comment form (line / overall / reply / document), plus the card renderer.
 * Images are uploaded to POST /api/images at paste time and the form only
 * posts the returned ids — comments.json never carries pixels. */

import { esc } from './dom.js';
import { renderMarkdown } from './markdown.js';

// Longest edge the upload is downscaled to. Claude processes anything larger
// by scaling it down to about this size anyway, so storing more pixels only
// costs disk and upload time without ever improving what the agent sees.
const MAX_IMAGE_EDGE = 1568;

// Mirrors the server's COMMENT_IMAGE_ID_RE. Ids land in <img src> / hrefs, so
// only ids that match this narrow shape are ever rendered.
const IMAGE_ID_RE = /^img_[a-z0-9]+\.(png|jpg|gif|webp)$/;

export function isSafeImageId(s) {
  return typeof s === 'string' && IMAGE_ID_RE.test(s);
}

export function imageUrl(id) {
  return '/api/images/' + encodeURIComponent(id);
}

// HTML for the images attached to a stored comment, rendered inside its card.
// Each image links to itself so a click opens the full-size capture.
export function commentImagesHtml(images) {
  let html = '';
  (images || []).forEach(function (id) {
    if (!isSafeImageId(id)) return;
    const src = imageUrl(id);
    html += '<a class="comment-image-link" href="' + esc(src) +
      '" target="_blank" rel="noopener" title="原寸を新しいタブで開く">' +
      '<img class="comment-image" src="' + esc(src) + '" alt="添付画像"></a>';
  });
  return html ? '<div class="comment-images">' + html + '</div>' : '';
}

// Same markup as commentImagesHtml's per-image link, but block-level (its own
// line, small margin) so it drops inline at the marker's position inside
// .body instead of sitting in the flush-left thumbnail row.
function inlineImageHtml(id) {
  const src = imageUrl(id);
  return '<a class="comment-image-link comment-image-inline-link" href="' + esc(src) +
    '" target="_blank" rel="noopener" title="原寸を新しいタブで開く">' +
    '<img class="comment-image" src="' + esc(src) + '" alt="添付画像"></a>';
}

// Marker inserted by attachImagePaste once an upload finishes; see
// insertMarker/replaceMarker below.
const IMAGE_MARKER_RE = /\[画像: ([^\]]+)\]/g;

/**
 * HTML for a comment card's body text: the body is rendered as Markdown
 * (see markdown.ts) and each `[画像: <id>]` marker is replaced by the
 * attached image inline at that position. A marker only becomes an image
 * when its id is both (a) present in `images` and (b) shaped like a real
 * image id (isSafeImageId) — anything else is left as plain text, so a
 * comment body can never be tricked into rendering an arbitrary id as an
 * <img src>.
 *
 * The markers are handed to renderMarkdown's liftInline hook rather than
 * substituted before or after it: that way the emitted <a><img></a> is
 * never re-read as Markdown, and a marker written inside a code fence stays
 * literal like the rest of the block.
 *
 * `fences` is the comment's stored server-side fence highlighting, passed
 * through to renderMarkdown untouched (it validates every token itself).
 *
 * Returns { html, usedIds }: `html` is ready to drop inside the card's
 * `.body` div, and `usedIds` marks which attached images were placed inline
 * so the caller can render the rest (unreferenced attachments) in the usual
 * below-the-body strip via commentImagesHtml, without showing an image twice.
 */
export function commentBodyHtml(body, images, fences?) {
  const attached = {};
  (images || []).forEach(function (id) { if (isSafeImageId(id)) attached[id] = true; });

  const usedIds = {};
  const html = renderMarkdown(body, function (line, hold) {
    return line.replace(IMAGE_MARKER_RE, function (m, id) {
      if (!attached[id]) return m;
      usedIds[id] = true;
      return hold(inlineImageHtml(id));
    });
  }, fences);

  return { html: html, usedIds: usedIds };
}

// Downscale a pasted image so its longest edge is MAX_IMAGE_EDGE. GIFs are
// passed through (canvas would drop the animation), as is anything already
// small enough or that fails to decode — the server still enforces the size
// cap and format check.
function normalizeImage(blob) {
  if (blob.type === 'image/gif') return Promise.resolve(blob);
  return createImageBitmap(blob).then(function (bmp) {
    const scale = MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height);
    if (scale >= 1) {
      bmp.close();
      return blob;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    // Screenshots (the common case) compress best as PNG; photos keep JPEG.
    const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return new Promise(function (resolve) {
      canvas.toBlob(function (out) { resolve(out || blob); }, type, 0.92);
    });
  }).catch(function () { return blob; });
}

function uploadImage(blob) {
  return fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error(res.status + ' ' + t); });
    }
    return res.json();
  });
}

/**
 * Wire paste-to-attach onto one comment form: pasting an image into
 * `textarea` uploads it and shows a removable thumbnail in a strip appended
 * after the textarea. Returns { ids, busy, clear }:
 *   ids()   — uploaded image ids to include in the comment POST
 *   busy()  — an upload is still in flight (block submit)
 *   clear() — empty the strip (after a successful submit of a persistent form)
 * While anything is attached, `wrap` carries the `has-images` class so
 * isEditingDraft treats the form as an in-progress draft.
 */
export function attachImagePaste(wrap, textarea) {
  const strip = document.createElement('div');
  strip.className = 'image-strip';
  textarea.after(strip);

  let pending = 0;
  let markerSeq = 0;

  function syncDraftMark() {
    wrap.classList.toggle('has-images', pending > 0 || strip.querySelector('.image-chip') !== null);
  }

  // Replace the first occurrence of `marker` in the textarea with
  // `replacement`, keeping the caret/selection anchored relative to the
  // surrounding text. Returns false (no-op) if the marker is no longer
  // present — the user may have already deleted it by hand.
  function replaceMarker(marker, replacement) {
    const value = textarea.value;
    const idx = value.indexOf(marker);
    if (idx === -1) return false;
    const selStart = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;
    const delta = replacement.length - marker.length;
    function adjust(pos) {
      if (pos <= idx) return pos;
      if (pos <= idx + marker.length) return idx + replacement.length;
      return pos + delta;
    }
    textarea.value = value.slice(0, idx) + replacement + value.slice(idx + marker.length);
    textarea.selectionStart = adjust(selStart);
    textarea.selectionEnd = adjust(selEnd);
    return true;
  }

  // Insert a placeholder marker at the caret so the pasted image's position
  // in the text is visible while the upload is in flight (and after, once
  // it's rewritten to `[画像: <id>]`). The paste handler already called
  // preventDefault(), so no text was auto-inserted — we build the new value
  // by hand.
  function insertMarker(marker) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    textarea.value = value.slice(0, start) + marker + value.slice(end);
    const pos = start + marker.length;
    textarea.selectionStart = textarea.selectionEnd = pos;
    textarea.focus();
  }

  function addImage(file) {
    markerSeq += 1;
    const marker = '[画像アップロード中…#' + markerSeq + ']';
    insertMarker(marker);

    const chip = document.createElement('span');
    chip.className = 'image-chip uploading';
    chip.dataset.marker = marker;
    const img = document.createElement('img');
    img.alt = 'アップロード中…';
    img.src = URL.createObjectURL(file);
    chip.appendChild(img);
    strip.appendChild(chip);
    pending += 1;
    syncDraftMark();

    normalizeImage(file).then(uploadImage).then(function (data) {
      chip.classList.remove('uploading');
      chip.dataset.imageId = data.id;
      replaceMarker(marker, '[画像: ' + data.id + ']');
      chip.dataset.marker = '[画像: ' + data.id + ']';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'image-remove';
      remove.textContent = '✕';
      remove.title = 'この画像を取り除く';
      remove.addEventListener('click', function () {
        URL.revokeObjectURL(img.src);
        replaceMarker(chip.dataset.marker, '');
        chip.remove();
        syncDraftMark();
      });
      chip.appendChild(remove);
    }).catch(function (err) {
      URL.revokeObjectURL(img.src);
      replaceMarker(marker, '');
      chip.remove();
      alert('画像のアップロードに失敗しました: ' + err);
    }).then(function () {
      pending -= 1;
      syncDraftMark();
    });
  }

  textarea.addEventListener('paste', function (e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImage);
  });

  return {
    ids: function () {
      const out = [];
      strip.querySelectorAll('.image-chip[data-image-id]').forEach(function (chip: any) {
        out.push(chip.dataset.imageId);
      });
      return out;
    },
    busy: function () { return pending > 0; },
    clear: function () {
      strip.querySelectorAll('.image-chip img').forEach(function (img: any) {
        URL.revokeObjectURL(img.src);
      });
      strip.innerHTML = '';
      syncDraftMark();
    },
  };
}
