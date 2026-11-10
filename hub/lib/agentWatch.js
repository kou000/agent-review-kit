'use strict';

// エージェントが対応中のまま放置したコメントの検出と催促。
//
// エージェントがコメントを受け取って（seen）「調べます」と返したあと、結果をスレッドに返さず
// ターミナルにだけ書いて止まる事故が続いたため、hub サーバが各セッションの ark スコープの
// コメントを定期的に見て、エージェント待ちのまま時間が経ったスレッドに催促コメントを返信する。
//
// スレッドの状態は「最新のコメント」（返信を含めて createdAt が最も新しいもの）で判断する:
//   seen    — 配達済み（エージェントが持っている）。SEEN_LIMIT_MS を超えたら催促
//   working — エージェントが「バックグラウンドで作業中・終わったら返信する」と宣言した。
//             WORKING_LIMIT_MS を超えたら、現状（何をしていて、いつ頃終わるか）を書くよう催促
//   open    — 未配達。待ち受け（wait-comments）が止まっているので催促しても届かない。
//             OPEN_LIMIT_MS を超えたらステータスバーで警告するだけにする
// 経過時間は最新のコメントの updatedAt（状態を変えた時刻）から数える。
//
// 催促はユーザー名義の open の返信として ark の POST /api/comments で投稿する
// （承認ボタンの【承認】・作業の単位の開始ボタンの【開始】コメントと同じ経路）。wait-comments に配達され、止まっている
// エージェントのターンが始まる。本文の先頭【催促】で hub の自動投稿だと分かるようにし、
// 重複防止にも使う: 最新のコメントが未対応（open/seen）の催促なら、エージェントが状態を
// 更新するまで再催促しない。エージェントが催促や元のコメントの状態を変える（working にする・
// 返信する）と最新のコメントの状態・時刻が変わり、そこから数え直しになる。
//
// 判定はすべて純粋関数（tests/agentWatch.test.ts）。I/O は createAgentWatch に注入する。

const SEEN_LIMIT_MS = 3 * 60 * 1000;
const WORKING_LIMIT_MS = 5 * 60 * 1000;
const OPEN_LIMIT_MS = 3 * 60 * 1000;
const WATCH_INTERVAL_MS = 30 * 1000;

const NUDGE_PREFIX = '【催促】';
const APPROVAL_PREFIX = '【承認】';
const START_PREFIX = '【開始】';

function authorOf(c) {
  return c.author || 'user';
}

// hub が投稿した催促コメントか。催促はユーザー名義（エージェントに配達させるため）で投稿する
function isNudge(c) {
  return authorOf(c) === 'user' && typeof c.body === 'string' && c.body.startsWith(NUDGE_PREFIX);
}

// スレッド単位に束ねる。キーはトップレベルのコメント id（返信は parentId）。
// 削除済みと手動修正の通知（ブラウザに表示されない）は ark の集計と同様に除く
function groupThreads(comments) {
  const threads = new Map();
  for (const c of comments) {
    if (!c || c.deleted || c.manualEdit) continue;
    const key = c.parentId || c.id;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(c);
  }
  return threads;
}

// スレッドの最新のコメント。createdAt（ISO 8601）が同じなら comments.json で後ろにある方
function latestComment(thread) {
  let latest = null;
  for (const c of thread) {
    if (!latest || String(c.createdAt) >= String(latest.createdAt)) latest = c;
  }
  return latest;
}

// エージェント待ちのスレッドなら { topId, state, commentId, since, elapsedMs, nudgePending, approval, start, documentId }、
// そうでなければ null。
//   state        — 'open' | 'seen' | 'working'（最新のコメントの状態）
//   nudgePending — 最新のコメントが未対応（open/seen）の催促。エージェントがまだ状態を更新していない
//   approval     — 承認ボタンのコメント（トップレベルの本文が【承認】で始まる）のスレッド
//   start        — 作業の単位の開始ボタンのコメント（トップレベルの本文が【開始】で始まる）のスレッド
// エージェント名義の open/seen は AI 指摘でユーザーの返事待ちなので対象外。
// working はエージェントしか付けないので、誰の名義でも対象
function threadWait(topId, thread, now) {
  const latest = latestComment(thread);
  if (!latest) return null;
  const st = latest.status;
  let state = null;
  if (st === 'working') state = 'working';
  else if ((st === 'open' || st === 'seen') && authorOf(latest) === 'user') state = st;
  if (!state) return null;
  const sinceMs = Date.parse(latest.updatedAt || latest.createdAt);
  if (!Number.isFinite(sinceMs)) return null;
  const top = thread.find((c) => c.id === topId);
  return {
    topId,
    state,
    commentId: latest.id,
    since: new Date(sinceMs).toISOString(),
    elapsedMs: Math.max(0, now - sinceMs),
    nudgePending: isNudge(latest) && (st === 'open' || st === 'seen'),
    approval: Boolean(top && typeof top.body === 'string' && top.body.startsWith(APPROVAL_PREFIX)),
    start: Boolean(top && typeof top.body === 'string' && top.body.startsWith(START_PREFIX)),
    documentId: (top && top.documentId) || latest.documentId || null,
  };
}

function threadWaits(comments, now) {
  const waits = [];
  for (const [topId, thread] of groupThreads(comments)) {
    const w = threadWait(topId, thread, now);
    if (w) waits.push(w);
  }
  return waits;
}

// 1 スレッドへの対応: 'nudge'（催促を投稿する）/ 'warn'（未配達の警告）/ 'none'
function decide(wait) {
  if (!wait) return 'none';
  if (wait.state === 'open') return wait.elapsedMs > OPEN_LIMIT_MS ? 'warn' : 'none';
  if (wait.nudgePending) return 'none'; // 催促済み。エージェントが状態を更新するまで再催促しない
  if (wait.state === 'seen') return wait.elapsedMs > SEEN_LIMIT_MS ? 'nudge' : 'none';
  if (wait.state === 'working') return wait.elapsedMs > WORKING_LIMIT_MS ? 'nudge' : 'none';
  return 'none';
}

function minutesLabel(ms) {
  return `${Math.round(ms / 60000)} 分`;
}

// 催促コメントの本文。先頭は必ず NUDGE_PREFIX（重複防止の判定に使う）
function nudgeBody(wait) {
  const head = `${NUDGE_PREFIX}（review-hub の自動投稿）`;
  if (wait.state === 'working') {
    return (
      `${head}このコメントは ${minutesLabel(WORKING_LIMIT_MS)}以上「作業中（working）」のままです。` +
      '作業が終わっていれば、結果をこのスレッドに返信してください。' +
      '本当に作業中なら、現状（何をしていて、いつ頃終わる見込みか）をこのスレッドに書いてください' +
      '（`resolve-comment <id> --status working --message "<現状>"`。書いた時刻から数え直します）。' +
      '止まっているなら、その理由とユーザーへの依頼を書いて `--status answered` にしてください。'
    );
  }
  return (
    `${head}このコメントは ${minutesLabel(SEEN_LIMIT_MS)}以上エージェントの対応中のままです。` +
    '結果か、止まっている理由・ユーザーへの依頼をこのスレッドに返信してください' +
    '（バックグラウンドで作業を続けているなら `--status working --message "<現状>"` にしてください）。'
  );
}

// ステータスバー用の集計。
//   active               — 対応中（seen・working）のスレッド数
//   activeLongestMs      — その最長の経過時間
//   working              — うち working の数
//   undelivered          — 未配達（open）のまま OPEN_LIMIT_MS を超えたスレッド数（警告）
//   undeliveredLongestMs — その最長の経過時間
//   threads              — 対応中・未配達警告のスレッド（ホバー表示用）
function summarize(waits) {
  const summary = { active: 0, activeLongestMs: 0, working: 0, undelivered: 0, undeliveredLongestMs: 0, threads: [] };
  for (const w of waits) {
    if (w.state === 'open') {
      if (decide(w) !== 'warn') continue;
      summary.undelivered += 1;
      summary.undeliveredLongestMs = Math.max(summary.undeliveredLongestMs, w.elapsedMs);
    } else {
      summary.active += 1;
      if (w.state === 'working') summary.working += 1;
      summary.activeLongestMs = Math.max(summary.activeLongestMs, w.elapsedMs);
    }
    summary.threads.push(w);
  }
  return summary;
}

// 複数スコープの集計を 1 つにまとめる
function mergeSummaries(summaries) {
  const merged = { active: 0, activeLongestMs: 0, working: 0, undelivered: 0, undeliveredLongestMs: 0, threads: [] };
  for (const s of summaries) {
    if (!s) continue;
    merged.active += s.active;
    merged.working += s.working;
    merged.undelivered += s.undelivered;
    merged.activeLongestMs = Math.max(merged.activeLongestMs, s.activeLongestMs);
    merged.undeliveredLongestMs = Math.max(merged.undeliveredLongestMs, s.undeliveredLongestMs);
    merged.threads.push(...s.threads);
  }
  return merged;
}

// 監視するスコープ: タブの projectDir（waiterScopes）に加え、承認コメントのフォールバック先の
// docspace。返り値: projectDir の配列（重複なし）
function sessionScopes(session, waiterScopes) {
  const dirs = waiterScopes(session).map((s) => s.projectDir);
  if (session.docspaceDir) dirs.push(session.docspaceDir);
  return [...new Set(dirs)];
}

// 中断されていないセッションのスコープ → それを使うセッション id の一覧
function activeScopes(sessions, waiterScopes) {
  const byDir = new Map();
  for (const s of sessions) {
    if (!s || s.interrupted) continue;
    for (const dir of sessionScopes(s, waiterScopes)) {
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(s.id);
    }
  }
  return byDir;
}

// 監視ループ。依存はすべて注入する:
//   listSessions()               — セッション一覧（session.json）
//   waiterScopes(session)        — タブの projectDir ごとの束（session.js）
//   fetchComments(projectDir)    — その ark のコメント配列。ark 停止などで読めなければ null
//   postComment(projectDir, payload) — { ok, commentId } / { ok: false, error }
//   appendEvent(sessionId, type, data)
//   now()                        — 現在時刻（ms）
// tick() を 1 回走らせると、催促の要るスレッドすべてに催促を投稿し、投稿結果の配列を返す
function createAgentWatch(deps) {
  const now = deps.now || Date.now;
  // 同じ「最新のコメントの状態」への催促は 1 回だけ（投稿直後の再読込が古い内容を返した場合の保険）
  const posted = new Set();
  let running = false;

  async function tick() {
    if (running) return [];
    running = true;
    const results = [];
    try {
      for (const [dir, sessionIds] of activeScopes(deps.listSessions(), deps.waiterScopes)) {
        const comments = await deps.fetchComments(dir);
        if (!Array.isArray(comments)) continue;
        for (const w of threadWaits(comments, now())) {
          if (decide(w) !== 'nudge') continue;
          const key = `${dir}\0${w.topId}\0${w.commentId}\0${w.since}`;
          if (posted.has(key)) continue;
          posted.add(key);
          const r = await deps.postComment(dir, { body: nudgeBody(w), parentId: w.topId });
          const result = {
            projectDir: dir,
            topId: w.topId,
            state: w.state,
            elapsedMs: w.elapsedMs,
            approval: w.approval,
            start: w.start,
            ok: Boolean(r && r.ok),
            commentId: r && r.ok ? r.commentId : undefined,
            error: r && !r.ok ? r.error : undefined,
          };
          results.push(result);
          for (const id of sessionIds) deps.appendEvent(id, result.ok ? 'nudged' : 'nudge-failed', result);
        }
      }
    } finally {
      running = false;
    }
    return results;
  }

  return { tick };
}

// hub サーバから呼ぶ常駐監視。ark・session への依存はここでだけ解決する（判定関数のテストを軽くするため）
function startAgentWatch(intervalMs = WATCH_INTERVAL_MS) {
  const store = require('./session');
  const ark = require('./ark');
  const watch = createAgentWatch({
    listSessions: store.listSessions,
    waiterScopes: store.waiterScopes,
    fetchComments: ark.fetchArkComments,
    postComment: ark.postArkComment,
    appendEvent: store.appendEvent,
  });
  const timer = setInterval(() => {
    watch.tick().catch((err) => {
      process.stderr.write(`review-hub: agent watch failed: ${err && err.message}\n`);
    });
  }, intervalMs);
  timer.unref();
  return { timer, tick: watch.tick };
}

// セッション詳細 API（ステータスバー）・status --session 用の集計。中断中は監視しないので集計もしない
async function sessionSummary(session, fetchComments, waiterScopes, now = Date.now()) {
  if (session.interrupted) return null;
  const summaries = await Promise.all(
    sessionScopes(session, waiterScopes).map(async (dir) => {
      const comments = await fetchComments(dir);
      if (!Array.isArray(comments)) return null;
      const s = summarize(threadWaits(comments, now));
      for (const t of s.threads) t.projectDir = dir;
      return s;
    })
  );
  return mergeSummaries(summaries);
}

module.exports = {
  SEEN_LIMIT_MS,
  WORKING_LIMIT_MS,
  OPEN_LIMIT_MS,
  WATCH_INTERVAL_MS,
  NUDGE_PREFIX,
  START_PREFIX,
  isNudge,
  groupThreads,
  latestComment,
  threadWait,
  threadWaits,
  decide,
  nudgeBody,
  summarize,
  mergeSummaries,
  sessionScopes,
  activeScopes,
  createAgentWatch,
  startAgentWatch,
  sessionSummary,
};
