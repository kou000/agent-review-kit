/* ---------- 「空白の変更を無視」用の差分の下ごしらえ ----------
 *
 * generate は通常の差分（DIFF.files）に加えて `git diff -w` の差分
 * （DIFF.ignoreWhitespaceFiles）を埋め込む。トグルで DIFF.files をこちらに
 * 差し替えて描画し直すので、その前に通常の差分と同じ形に揃える:
 *
 * - ファイルの並び・集合を通常の差分と同じにする。ファイル箱の id
 *   （file-<index>）・サイドバー・確認済み・ピンはすべて DIFF.files の添字で
 *   つながっているため。空白だけを変えたファイルは -w の差分に現れないので、
 *   ハンク無し（whitespaceOnly）の項目で埋める。
 * - newLines / newLinesHtml（文脈の展開用の全文）は HTML に重複して
 *   埋め込まないので、通常の差分の同じファイルから引き継ぐ。
 * - 各セルの diffLine を「通常の差分上の位置」に付け替える。diffLine は
 *   コメントの startDiffLine / endDiffLine として保存される値で、-w の差分
 *   上の位置のまま保存すると、どちらの表示で付けたかで意味が変わってしまう。
 *   展開した行（table.ts の contextRow）でも引けるよう、左右・行番号 →
 *   diffLine の表（refDiffLines）も持たせる。通常の差分に無い行は 0
 *   （= 展開した文脈行。通常の表示と同じ扱い）。
 *
 * DOM も state も import しないので plain node で unit test できる。 */

export interface LineIndex {
  old: Record<number, number>;
  new: Record<number, number>;
}

// 通常の差分の 1 ファイルについて、左右・行番号 → diffLine の表を作る。
function diffLineIndex(file): LineIndex {
  const idx: LineIndex = { old: {}, new: {} };
  (file.hunks || []).forEach(function (h) {
    h.rows.forEach(function (r) {
      if (r.left) idx.old[r.left.line] = r.left.diffLine;
      if (r.right) idx.new[r.right.line] = r.right.diffLine;
    });
  });
  return idx;
}

function remapCell(cell, table: Record<number, number>) {
  if (!cell) return null;
  const d = table[cell.line];
  return Object.assign({}, cell, { diffLine: typeof d === 'number' ? d : 0 });
}

// files（通常の差分）と同じ順序・同じ長さの、空白無視の表示用ファイル一覧を
// 返す。入力はどちらも書き換えない。
export function alignIgnoreWhitespaceFiles(files: any[], wsFiles: any[]): any[] {
  const wsByPath = {};
  (wsFiles || []).forEach(function (f) { wsByPath[f.path] = f; });
  return files.map(function (full) {
    const src = wsByPath[full.path];
    const ref = diffLineIndex(full);
    const hunks = src
      ? src.hunks.map(function (h) {
          return {
            header: h.header,
            rows: h.rows.map(function (r) {
              return { left: remapCell(r.left, ref.old), right: remapCell(r.right, ref.new) };
            }),
          };
        })
      : [];
    const out = Object.assign({}, src || full, {
      hunks: hunks,
      refDiffLines: ref,
      // 通常の差分では内容が変わっているのに、空白を無視すると何も残らない。
      whitespaceOnly: full.hunks.length > 0 && hunks.length === 0,
    });
    delete out.newLines;
    delete out.newLinesHtml;
    if (full.newLines) out.newLines = full.newLines;
    if (full.newLinesHtml) out.newLinesHtml = full.newLinesHtml;
    return out;
  });
}
