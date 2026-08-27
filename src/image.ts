import * as fs from 'fs';
import * as path from 'path';

// Per-image size cap for the encoded source bytes. Images are inlined as base64
// data URIs into comments.json, so a large image bloats the JSON that both the
// agent and the browser must load on every read. 3MB keeps a single screenshot
// comfortable while stopping accidental huge attachments.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// Extension -> MIME. Only raster formats a browser renders inline via <img>
// with a data URI are allowed; anything else is rejected so the UI never gets
// a data URI it cannot (or should not) display.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const SUPPORTED_IMAGE_EXTS = Object.keys(MIME_BY_EXT);

/**
 * Read an image file and return it as a base64 data URI. The MIME type is
 * derived from the file extension (content is not sniffed). Throws with a
 * user-facing message on unsupported extension, missing file, or size overflow.
 */
export function encodeImageToDataUri(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `対応していない画像形式です: ${filePath} (対応: ${SUPPORTED_IMAGE_EXTS.join(', ')})`
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`画像ファイルが見つかりません: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`画像ファイルではありません: ${filePath}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    const cap = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(
      `画像が大きすぎます: ${filePath} (${mb}MB, 上限 ${cap}MB)`
    );
  }

  const base64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${base64}`;
}

/* ---------- comment attachment images (user-pasted, stored as files) ---------- */

// Shape of a stored comment-image id. It doubles as the file name under the
// branch's images/ directory and appears in URLs (/api/images/<id>), so the
// pattern is deliberately narrow: no separators, no dots outside the single
// extension — an id that matches can never traverse out of imagesDir.
export const COMMENT_IMAGE_ID_RE = /^img_[a-z0-9]+\.(png|jpg|gif|webp)$/;

export function newCommentImageId(ext: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `img_${Date.now().toString(36)}${rand}.${ext}`;
}

// Detect the actual image format from the file's magic bytes. The upload's
// Content-Type header is untrusted; the signature decides both the stored
// extension and (via MIME_BY_EXT) the MIME the file is served back with.
// Returns the canonical extension, or null for anything not a supported image.
export function sniffImageExt(buf: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

// MIME for serving a stored comment image, from its (validated) id.
export function mimeForImageId(id: string): string | null {
  return MIME_BY_EXT[path.extname(id).toLowerCase()] ?? null;
}
