/* 差分ページに出す比較元（base）の表示。ハッシュで渡された base は、generate
 * が見つけたブランチ名（baseName）で見せ、ハッシュはツールチップに回す。
 * baseName の無い古い review.html でもハッシュは短縮して出す。 */

export interface BaseLabelSource {
  base: string | null;
  baseName?: string;
  baseSha?: string;
}

const HASH_RE = /^[0-9a-f]{4,40}$/i;

function shortHash(s: string): string {
  return HASH_RE.test(s) ? s.slice(0, 7) : s;
}

// base が無い（未コミット差分だけ）ときは null。
export function baseLabel(data: BaseLabelSource): { text: string; title: string } | null {
  if (!data.base) return null;
  const name = data.baseName || shortHash(data.base);
  const lines = ['比較元の ref（generate の --base）: ' + data.base];
  const sha = data.baseSha || (HASH_RE.test(data.base) ? data.base : '');
  if (sha && sha !== data.base) lines.push('コミット: ' + sha);
  return { text: name, title: lines.join('\n') };
}
