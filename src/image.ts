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
