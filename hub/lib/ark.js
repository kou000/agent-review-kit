'use strict';

// agent-review-kit (ark) 連携。ark は改修しない前提で、公開されている
// <projectDir>/.agent-review/server.json と HTTP API（/api/status・/api/comments）だけに依存する。
// ark は再起動でポートが変わり得るため、URL 解決は毎回ファイルから行う。

const fs = require('fs');
const http = require('http');
const path = require('path');

const STATUS_TIMEOUT_MS = 800;

function arkServerInfo(projectDir) {
  try {
    const raw = fs.readFileSync(path.join(projectDir, '.agent-review', 'server.json'), 'utf8');
    const info = JSON.parse(raw);
    if (typeof info.port !== 'number') return null;
    return info;
  } catch {
    return null;
  }
}

// 画像付きコメント（data URI・1件で数百KBになる）を含むため上限は大きめに取る
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

function fetchArkJson(port, apiPath) {
  // destroy 経路（サイズ超過・タイムアウト）では 'end' も 'error' も発火しないことがあり、
  // resolve 漏れがあると resolveSession 全体（= hub のセッション詳細 API）がハングする。
  // どの経路でも必ず一度 resolve する
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: apiPath, timeout: STATUS_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > BODY_LIMIT_BYTES) {
            req.destroy();
            settle(null);
          }
        });
        res.on('end', () => {
          try {
            settle(JSON.parse(body));
          } catch {
            settle(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      settle(null);
    });
    req.on('error', () => settle(null));
    req.on('close', () => settle(null));
  });
}

function postArkJson(port, apiPath, payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: apiPath,
        method: 'POST',
        timeout: STATUS_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* 非 JSON 応答はエラー扱い */
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ statusCode: 0, body: { error: err.message } }));
    req.end(data);
  });
}

// 生きていて projectDir が一致する ark のポートを返す（取り違え防止）。無ければ null
async function livePort(projectDir) {
  const info = arkServerInfo(projectDir);
  if (!info) return null;
  const status = await fetchArkJson(info.port, '/api/status');
  return status && status.projectDir === projectDir ? info.port : null;
}

// 承認をコメントとして ark に投稿する。wait-comments で通常のコメントと同じ経路で
// エージェントに届き、resolve されるまで未解決として残る（承認の取りこぼしを見える化する）。
// 返り値: { ok: true, commentId } / { ok: false, error }
async function postArkComment(projectDir, payload) {
  const port = await livePort(projectDir);
  if (!port) return { ok: false, error: `ark が起動していません: ${projectDir}` };
  const { statusCode, body } = await postArkJson(port, '/api/comments', payload);
  if (statusCode === 201 && body && body.comment) return { ok: true, commentId: body.comment.id };
  return { ok: false, error: `ark がコメントを受け付けませんでした (${statusCode}): ${(body && body.error) || ''}` };
}

// 承認コメントがエージェントに届いたか。wait-comments が配達すると open → seen になる。
// 判定できない（ark 停止・コメント消失）ときは null
async function commentReceived(projectDir, commentId) {
  const port = await livePort(projectDir);
  if (!port) return null;
  const data = await fetchArkJson(port, '/api/comments');
  if (!data || !Array.isArray(data.comments)) return null;
  const c = data.comments.find((x) => x.id === commentId);
  return c ? c.status !== 'open' : null;
}

// タブに対応するコメント件数。ark の /api/status の集計は ark サーバ（ブランチスコープ）
// 全体の合計で、同じ docspace に複数の doc を載せると他の doc のコメントまで混ざる。
// タブ単位で正しく出すために /api/comments を documentId で絞って数える。
//
// 数え方は ark サイドバーの「コメント (要確認 N / 未解決 M)」と同じ**スレッド単位**
// （ark client/threads.ts の threadState と同じ規則。返信の多いスレッドも 1 と数える）:
//   未解決 (open)  — ユーザー名義の open/seen コメントを含むスレッド。エージェントの作業待ち
//   要確認 (check) — 回答・修正済み / wontfix / dismissed の確認待ち、または AI 指摘
//                    （エージェント名義の open/seen）への返信待ち。ユーザーの確認待ち
//   解決済み       — 全コメントが resolved。数えない
function threadState(comments) {
  let needsCheck = false;
  for (const c of comments) {
    if (c.status === 'open' || c.status === 'seen') {
      if ((c.author || 'user') === 'agent') {
        needsCheck = true;
        continue;
      }
      return 'open';
    }
    if (c.status !== 'resolved') needsCheck = true;
  }
  return needsCheck ? 'check' : 'settled';
}

async function countThreads(port, tab) {
  const data = await fetchArkJson(port, '/api/comments');
  if (!data || !Array.isArray(data.comments)) return null;
  // 削除済みと手動修正の通知コメントは ark の集計と同様に無視する。
  // ark-doc タブは自分の documentId 宛のみ、ark-diff タブは diff 宛（documentId なし）のみ
  // （返信は親の documentId を継承しているのでコメント単位で絞ってよい）
  const scoped = data.comments.filter(
    (c) => !c.deleted && !c.manualEdit && (tab.type === 'ark-doc' ? c.documentId === tab.docId : !c.documentId)
  );
  const threads = new Map(); // top id -> comments
  for (const c of scoped) if (!c.parentId) threads.set(c.id, [c]);
  for (const c of scoped) if (c.parentId && threads.has(c.parentId)) threads.get(c.parentId).push(c);
  const counts = { open: 0, check: 0 };
  for (const comments of threads.values()) {
    const state = threadState(comments);
    if (state !== 'settled') counts[state] += 1;
  }
  return counts;
}

// タブ定義から iframe 用 URL と死活情報を解決する。
// 返り値: { url, alive, unresolved, check, finished, arkPort } （ark 不在時は url:null, alive:false）
//   unresolved = 未解決スレッド数（エージェントの作業待ち）、check = 要確認スレッド数（ユーザーの確認待ち）
async function resolveArkTab(tab) {
  const info = arkServerInfo(tab.projectDir);
  if (!info) return { url: null, alive: false, unresolved: null, check: null, finished: null, arkPort: null };
  const status = await fetchArkJson(info.port, '/api/status');
  // 別プロジェクトの ark が同ポートを取った場合（取り違え）を projectDir で検知
  const alive = Boolean(status) && status.projectDir === tab.projectDir;
  const base = `http://localhost:${info.port}`;
  const url = tab.type === 'ark-doc' ? `${base}/doc/${encodeURIComponent(tab.docId)}` : `${base}/`;
  const counts = alive ? await countThreads(info.port, tab) : null;
  return {
    url,
    alive,
    unresolved: counts ? counts.open : null,
    check: counts ? counts.check : null,
    finished: alive ? status.finished : null,
    arkPort: info.port,
  };
}

// 中断時のセッション ark 停止。server.json の pid を kill するが、pid 再利用や
// server.json の残骸による誤 kill を避けるため、「その projectDir の ark がいま
// 生きている」ことを /api/status で確認できた場合だけ SIGTERM を送る
async function stopArkServer(projectDir) {
  const info = arkServerInfo(projectDir);
  if (!info || typeof info.pid !== 'number') return { stopped: false, reason: 'not-running' };
  if (info.projectDir && info.projectDir !== projectDir) return { stopped: false, reason: 'foreign-server' };
  const status = await fetchArkJson(info.port, '/api/status');
  if (!status || status.projectDir !== projectDir) return { stopped: false, reason: 'not-running' };
  try {
    process.kill(info.pid, 'SIGTERM');
    return { stopped: true, pid: info.pid, port: info.port };
  } catch {
    return { stopped: false, reason: 'kill-failed' };
  }
}

function arkDirs(sessions) {
  return [
    ...new Set(
      sessions
        .flatMap((s) => s.tabs)
        .filter((t) => t.type === 'ark-doc' || t.type === 'ark-diff')
        .map((t) => t.projectDir)
    ),
  ];
}

// 中断で止める ark スコープを決める。hub は同じホストで複数起動しても状態フォルダ
// （~/.review-hub）を共有しているため、全セッション分を止めると別チケットの hub の
// タブまで全部つながらなくなる。all でなければ、中断するセッションのスコープのうち
// 稼働中の他セッションが使っていないものだけを止める。
// 稼働中 = 中断されておらず、中断するセッションと共有していないスコープで ark が生きている
// （共有スコープの ark は中断するセッションが立てたものかもしれず、放置された古い
// セッションを稼働中と誤認するため数えない）
// 返り値: { dirs: 止めるスコープ, otherActive: 稼働中の他セッション ID }
async function planInterrupt(session, sessions, all) {
  if (all) return { dirs: arkDirs(sessions), otherActive: [] };
  const own = new Set(arkDirs([session]));
  const keep = new Set();
  const otherActive = [];
  for (const s of sessions) {
    if (s.id === session.id || s.interrupted) continue;
    const dirs = arkDirs([s]);
    const alive = await Promise.all(dirs.filter((d) => !own.has(d)).map(livePort));
    if (!alive.some(Boolean)) continue;
    otherActive.push(s.id);
    for (const d of dirs) keep.add(d);
  }
  return { dirs: [...own].filter((d) => !keep.has(d)), otherActive };
}

// 指定スコープの ark serve と wait-comments を止める。static タブ（hub 配信）は対象外
async function stopArks(dirs) {
  const results = [];
  for (const projectDir of dirs) {
    results.push({ projectDir, ...(await stopArkServer(projectDir)) });
  }
  return { servers: results, waiters: stopWaiters(dirs) };
}

// node で動いているプロセスの { pid, argv, cwd }。/proc を使うので Linux 専用。読めない環境では空
function nodeProcesses() {
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const procs = [];
  for (const pid of pids) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      // bash ラッパ等のコマンドラインにも文字列が含まれるので、node 本体だけを対象にする
      if (!/(^|\/)node$/.test(argv[0])) continue;
      procs.push({ pid: Number(pid), argv, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) });
    } catch {
      /* 途中で終了したプロセス・権限外は無視 */
    }
  }
  return procs;
}

// 中断時に、そのスコープの wait-comments を SIGTERM で止める。wait-comments は SIGTERM で
// {"status":"interrupted"} を出して終わるので、これがエージェントへの中断の通知になる
// （承認をコメントに統一して wait-approval を常駐させなくなったため、中断を伝える経路はこれだけ）
function stopWaiters(dirs) {
  const stopped = [];
  for (const p of nodeProcesses()) {
    if (!p.argv.includes('wait-comments') || !dirs.includes(p.cwd)) continue;
    try {
      process.kill(p.pid, 'SIGTERM');
      stopped.push({ pid: p.pid, projectDir: p.cwd });
    } catch {
      /* 既に終了 */
    }
  }
  return stopped;
}

// 同じホストで動いている hub サーバ（review-hub.js serve）の pid
function hubPids() {
  return nodeProcesses()
    .filter((p) => p.argv.some((a) => /(^|\/)review-hub\.js$/.test(a)) && p.argv.includes('serve'))
    .map((p) => p.pid);
}

module.exports = {
  arkServerInfo,
  resolveArkTab,
  stopArkServer,
  planInterrupt,
  stopArks,
  hubPids,
  postArkComment,
  commentReceived,
};
