'use strict';

// review-hub の HTTP サーバ。127.0.0.1 バインドのローカル専用（認証なし）。
// フェーズを跨いで常駐する。例外は中断 API（/interrupt）で、そのセッションの ark serve を
// 止めたうえで、他セッションの表示が途切れない場合は hub 自身も終了する。

const fs = require('fs');
const http = require('http');
const path = require('path');

const store = require('./session');
const ark = require('./ark');
const staticFiles = require('./staticFiles');

// ark のスキャン範囲 5179-5199 と重ならないようにする
const DEFAULT_PORT = 5280;
const PORT_SCAN = 20;
const LISTEN_HOST = '127.0.0.1';

const CLIENT_DIR = path.join(__dirname, '..', 'client');

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function notFound(res, message) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message || 'not found');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// タブ定義に iframe URL・死活・承認状態などランタイム情報を同乗させる
async function resolveSession(session, hubPort) {
  const tabs = await Promise.all(
    session.tabs.map(async (tab) => {
      const resolved = { ...tab };
      if (tab.type === 'ark-doc' || tab.type === 'ark-diff') {
        Object.assign(resolved, await ark.resolveArkTab(tab));
      } else if (tab.type === 'static') {
        resolved.url = `http://localhost:${hubPort}/static/${encodeURIComponent(session.id)}/${encodeURIComponent(tab.id)}/${tab.entry}`;
        resolved.alive = fs.existsSync(tab.path);
      }
      const delivery = tab.approval && tab.approval.delivery;
      if (delivery) {
        resolved.approval = {
          ...tab.approval,
          received: await ark.commentReceived(delivery.projectDir, delivery.commentId),
        };
      }
      return resolved;
    })
  );
  return { ...session, tabs };
}

// 承認ボタンの押下を ark のコメントとしてエージェントに届ける（push 依頼ボタンと同じ方式）。
// 承認専用の待ち受け（wait-approval）が止まっていると承認が黙って失われるため、
// 待ち受けの棚卸し・再起動時の再配達・未解決表示が効く wait-comments の経路に乗せる。
// 投稿先: ark-doc はそのドキュメント宛、ark-diff はその ark の全体コメント、
// static は自前の ark が無いので docspace の全体コメント。タブの ark に投稿できない
// （停止・レビュー終了済み）ときは docspace へフォールバックする
const APPROVAL_PREFIX = '【承認】';

async function postApprovalComment(session, tab, note) {
  const label = (tab.approval && tab.approval.label) || `${tab.title} を承認`;
  const body = `${APPROVAL_PREFIX}「${label}」が押されました（タブ: ${tab.title}）${note ? `\n\n${note}` : ''}`;
  const candidates = [];
  if (tab.type === 'ark-doc') candidates.push({ projectDir: tab.projectDir, payload: { body, intent: 'fix', documentId: tab.docId } });
  if (tab.type === 'ark-diff') candidates.push({ projectDir: tab.projectDir, payload: { body, intent: 'fix' } });
  if (session.docspaceDir && !candidates.some((c) => c.projectDir === session.docspaceDir && !c.payload.documentId)) {
    candidates.push({ projectDir: session.docspaceDir, payload: { body, intent: 'fix' } });
  }
  const errors = [];
  for (const c of candidates) {
    const r = await ark.postArkComment(c.projectDir, c.payload);
    if (r.ok) return { ok: true, delivery: { projectDir: c.projectDir, commentId: r.commentId } };
    errors.push(r.error);
  }
  return { ok: false, error: errors.join(' / ') || '投稿先の ark がありません' };
}

function shellPage(sessionId) {
  const template = fs.readFileSync(path.join(CLIENT_DIR, 'shell.html'), 'utf8');
  // セッション ID は英数と ._- のみ（validateSessionId 済み）なので文字列連結で安全
  return template.replace('%%SESSION_ID%%', sessionId);
}

async function handle(req, res, hubPort) {
  const url = new URL(req.url, `http://localhost:${hubPort}`);
  const p = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  if (method === 'GET' && p === '/') {
    const sessions = store.listSessions();
    if (sessions.length === 0) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('review-hub: no sessions yet. Run `review-hub start --session <id>` first.');
      return;
    }
    res.writeHead(302, { Location: `/s/${encodeURIComponent(sessions[0].id)}` });
    res.end();
    return;
  }

  const sessionPage = /^\/s\/([^/]+)$/.exec(p);
  if (method === 'GET' && sessionPage) {
    const id = sessionPage[1];
    if (!store.loadSession(id)) {
      notFound(res, `session not found: ${id}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(shellPage(id));
    return;
  }

  const clientFile = /^\/client\/(shell\.js|shell\.css)$/.exec(p);
  if (method === 'GET' && clientFile) {
    staticFiles.serveStatic(res, CLIENT_DIR, clientFile[1], null, req.headers.range);
    return;
  }

  if (method === 'GET' && p === '/api/sessions') {
    json(res, 200, { sessions: store.listSessions().map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })) });
    return;
  }

  const apiSession = /^\/api\/session\/([^/]+)$/.exec(p);
  if (method === 'GET' && apiSession) {
    const session = store.loadSession(apiSession[1]);
    if (!session) {
      json(res, 404, { error: `session not found: ${apiSession[1]}` });
      return;
    }
    json(res, 200, await resolveSession(session, hubPort));
    return;
  }

  const apiApprove = /^\/api\/session\/([^/]+)\/approve$/.exec(p);
  if (method === 'POST' && apiApprove) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: err.message });
      return;
    }
    if (!body.tabId) {
      json(res, 400, { error: 'tabId is required' });
      return;
    }
    const session = store.loadSession(apiApprove[1]);
    const target = session && session.tabs.find((t) => t.id === body.tabId);
    if (!target) {
      json(res, 400, { error: `tab not found: ${body.tabId}` });
      return;
    }
    // 二重押し・別ウィンドウからの再押下で承認コメントを重複投稿しない
    if (target.approval && target.approval.approvedAt) {
      json(res, 200, { status: 'approved', tab: target });
      return;
    }
    const delivered = await postApprovalComment(session, target, body.note);
    if (!delivered.ok) {
      // 承認として記録しない（ボタンを残してユーザーが押し直せるようにする）
      json(res, 502, { error: `エージェントに承認を届けられませんでした: ${delivered.error}` });
      return;
    }
    try {
      const { tab } = store.approveTab(apiApprove[1], body.tabId, body.note, 'browser', delivered.delivery);
      json(res, 200, { status: 'approved', tab });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  const apiVisibility = /^\/api\/session\/([^/]+)\/tab-visibility$/.exec(p);
  if (method === 'POST' && apiVisibility) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: err.message });
      return;
    }
    if (!body.tabId || typeof body.hidden !== 'boolean') {
      json(res, 400, { error: 'tabId and hidden (boolean) are required' });
      return;
    }
    try {
      const { tab } = store.setTabHidden(apiVisibility[1], body.tabId, body.hidden, 'browser');
      json(res, 200, { status: 'ok', tab });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  const apiInterrupt = /^\/api\/session\/([^/]+)\/interrupt$/.exec(p);
  if (method === 'POST' && apiInterrupt) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: err.message });
      return;
    }
    try {
      // 中断 = このセッションの作業を止める（サインアウト前用）。止めるのはこのセッションの
      // ark serve と wait-comments だけで、稼働中の他セッション（同じホストの別 hub の
      // チケットを含む）が使うスコープは残す（ark.planInterrupt）。
      // hub 自身は、止めても他セッションの表示が途切れない場合だけ終了する:
      // 別の hub プロセスが動いている、または稼働中の他セッションが無い
      const { interrupted } = store.interruptSession(apiInterrupt[1], body.note, 'browser');
      const session = store.loadSession(apiInterrupt[1]);
      const { dirs, otherActive } = await ark.planInterrupt(session, store.listSessions(), false);
      const { servers, waiters: stoppedWaiters } = await ark.stopArks(dirs);
      const stopped = servers.filter((r) => r.stopped);
      if (stopped.length > 0) {
        store.appendEvent(apiInterrupt[1], 'arks-stopped', {
          servers: stopped.map((r) => ({ projectDir: r.projectDir, pid: r.pid })),
        });
      }
      if (stoppedWaiters.length > 0) store.appendEvent(apiInterrupt[1], 'waiters-stopped', { waiters: stoppedWaiters });
      const otherHubs = ark.hubPids().filter((pid) => pid !== process.pid);
      const hubStopping = otherActive.length === 0 || otherHubs.length > 0;
      if (hubStopping) store.appendEvent(apiInterrupt[1], 'hub-stopped', {});
      json(res, 200, { status: 'interrupted', interrupted, stoppedArks: servers, stoppedWaiters, otherActive, hubStopping });
      if (hubStopping) setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  const staticMatch = /^\/static\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (method === 'GET' && staticMatch) {
    const [, sessionId, tabId, rest] = staticMatch;
    const session = store.loadSession(sessionId);
    const tab = session && session.tabs.find((t) => t.id === tabId && t.type === 'static');
    if (!tab) {
      notFound(res, `static tab not found: ${sessionId}/${tabId}`);
      return;
    }
    staticFiles.serveStatic(res, tab.path, rest || '', tab.entry, req.headers.range);
    return;
  }

  notFound(res);
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res, port).catch((err) => {
        try {
          json(res, 500, { error: err.message });
        } catch {
          /* response already sent */
        }
      });
    });
    server.on('error', reject);
    server.listen(port, LISTEN_HOST, () => resolve(server));
  });
}

async function startServer(requestedPort) {
  let lastErr = null;
  const ports = requestedPort ? [requestedPort] : Array.from({ length: PORT_SCAN + 1 }, (_, i) => DEFAULT_PORT + i);
  for (const port of ports) {
    try {
      const server = await listen(port);
      store.writeServerInfo({ port, pid: process.pid, startedAt: new Date().toISOString() });
      const cleanup = () => {
        const info = store.loadServerInfo();
        if (info && info.pid === process.pid) store.removeServerInfo();
      };
      process.on('exit', cleanup);
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
          // 中断ボタン等のユーザー操作による停止。エージェントが障害と誤読して
          // 勝手に再起動しないよう、意図を出力に残す
          console.log(`review-hub: ${sig} により停止（ユーザーの中断操作。エージェントは自動で再起動しないこと）`);
          cleanup();
          process.exit(0);
        });
      }
      return { server, port };
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastErr || new Error('no free port');
}

module.exports = { startServer, DEFAULT_PORT };
