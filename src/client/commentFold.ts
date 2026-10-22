/* ---------- long comment body folding ---------- */

// terraform plan の出力をそのまま貼ったコメントのように、本文（とエージェント
// 応答）が長いとスレッドが縦に伸びてページの他の部分を押し流す。描画後の
// 高さが一定を超えた本文だけ上部を残して折りたたみ、「続きを表示」で全文を
// 出す。行数ではなく描画後の高さ（scrollHeight）で判定するのは、折り返し・
// 見出し・画像・コードブロックで 1 行の高さがまちまちだから。
//
// threadFold.ts と同じく DOM/state を import しないので plain node で
// unit test できる。DOM への組み込みは threads.ts の attachCommentFold。

// style.css の .comment-fold.folded { max-height: 400px } と同じ値。本文の
// 1 行は差分ページ（12px / line-height 20px）でも doc ページ（14px / normal）
// でも約 20px なので、およそ 20 行分。
export const COMMENT_FOLD_MAX_PX = 400;
// 折りたたんでも隠れるのが数行だけなら、ボタンを押させるより全文を出した方が
// 早い。しきい値をこの分（約 3 行）だけ超えたときに初めて折りたたむ。
export const COMMENT_FOLD_SLACK_PX = 60;

// 本文要素を折りたたむか。scrollHeight は折りたたみ中でも中身全体の高さを
// 返すので、展開・折りたたみのどちらの状態で測っても同じ答えになる。
// 0 は非表示（display: none のスレッド内など）で測れていないので折りたたまない。
export function shouldFoldComment(scrollHeight: number) {
  if (!(scrollHeight > 0)) return false;
  return scrollHeight > COMMENT_FOLD_MAX_PX + COMMENT_FOLD_SLACK_PX;
}

// 折りたたんだ本文の下に出すボタン。open は読み手が展開済みかどうか。
export function commentFoldToggle(open: boolean) {
  return open
    ? { label: '折りたたむ', title: '長いコメントを先頭部分だけの表示に戻す' }
    : { label: '続きを表示', title: '折りたたまれたコメントの全文を表示する' };
}
