import { api } from '../api.js';

/* ---------- 自分用メモ（diff ページ専用） ----------
 * 全体コメントの右に置く、レビュアー本人だけのメモ。サーバー側の memo.json
 * （GET/PUT /api/memo）に保存する。wait-comments は comments.json しか読まない
 * ので、メモがエージェントに届くことはない。
 *
 * textarea には comment-form / reply-form のクラスを付けない。付けると
 * isEditingDraft() が「非空なら下書き」と判定し、メモに何か書いてある限り
 * 自動更新が止まり続ける。メモはフォーカス中だけ更新を保留する
 * （isEditingDraft の memo-textarea 判定）。
 *
 * 値はこのモジュールに保持し、#app が組み直されても新しい textarea に
 * 最新の入力（未保存分を含む）を入れ直す。 */

// 入力が止まってから保存するまでの待ち時間。
const MEMO_SAVE_DELAY_MS = 1000;

let loaded = false;
let loadStarted = false;
// textarea の最新値（未保存の入力を含む）。
let currentText = '';
// サーバーに保存済みの値。
let savedText = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;

function memoTextarea(): HTMLTextAreaElement | null {
  return document.querySelector('.memo-textarea');
}

function setStatus(text: string, isError?: boolean) {
  const el = document.querySelector('.memo-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // 保存は 1 本ずつ送る。完了後に差分が残っていれば続けて送るので、
  // 古い内容が後から届いて新しい内容を上書きすることはない。
  if (saving || !loaded) return;
  const text = currentText;
  if (text === savedText) {
    setStatus('保存済み');
    return;
  }
  saving = true;
  setStatus('保存中…');
  api('PUT', '/api/memo', { text: text }).then(function () {
    saving = false;
    savedText = text;
    if (currentText !== savedText) {
      if (!saveTimer) flush();
    } else {
      setStatus('保存済み');
    }
  }, function () {
    saving = false;
    // 入力を続けるかフォーカスを外すと再送する。
    setStatus('保存に失敗しました', true);
  });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, MEMO_SAVE_DELAY_MS);
  setStatus('未保存');
}

// タブを閉じる・リロードする直前に、待機中の入力を keepalive で送る。
// api() は keepalive を指定できないので fetch を直接使う。
window.addEventListener('pagehide', function () {
  if (!loaded || currentText === savedText) return;
  try {
    fetch('/api/memo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: currentText }),
      keepalive: true,
    });
  } catch (e) { /* best effort */ }
});

// メモ欄（見出し + textarea + 保存状態）。読み込み完了までは readOnly にして、
// 読み込み前の入力が保存済みのメモを上書きしないようにする。
export function buildMemoColumn() {
  const col = document.createElement('div');
  col.className = 'memo-column';
  col.innerHTML =
    '<h3 class="memo-title">自分用メモ（エージェントには送られません）</h3>' +
    '<textarea class="memo-textarea" placeholder="レビュー中の自分用メモ（自動保存）"></textarea>' +
    '<div class="memo-status" aria-live="polite"></div>';
  const ta: HTMLTextAreaElement = col.querySelector('.memo-textarea');
  ta.value = currentText;
  ta.readOnly = !loaded;
  ta.addEventListener('input', function () {
    currentText = ta.value;
    scheduleSave();
  });
  ta.addEventListener('blur', function () {
    if (currentText !== savedText) flush();
  });
  return col;
}

// 保存済みのメモを 1 回だけ読み込み、表示中の textarea に反映する。
export function loadMemo() {
  if (loadStarted) return;
  loadStarted = true;
  api('GET', '/api/memo').then(function (data) {
    const text = data && typeof data.text === 'string' ? data.text : '';
    currentText = text;
    savedText = text;
    loaded = true;
    const ta = memoTextarea();
    if (ta) {
      ta.value = text;
      ta.readOnly = false;
    }
  }, function () {
    // 読み込めないまま書かせると保存済みのメモを上書きしかねないので、
    // readOnly のままにする（再読み込みで再試行）。
    loadStarted = false;
    setStatus('メモを読み込めませんでした（ページを再読み込みしてください）', true);
  });
}
