'use strict';

// review-hub の HTTP サーバ。127.0.0.1 バインドのローカル専用（認証なし）。
// フェーズを跨いで常駐する。例外は中断 API（/interrupt）で、これはサインアウト前の
// 全停止用途なので ark serve を止めたうえで hub 自身も終了する。

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
      return resolved;
    })
  );
  return { ...session, tabs };
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
    try {
      const { tab } = store.approveTab(apiApprove[1], body.tabId, body.note, 'browser');
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
      // 中断 = サインアウト前の全停止。全セッションの ark serve を止め、応答を返してから
      // hub 自身も終了する（SIGTERM ハンドラが server.json を掃除する）
      const { interrupted } = store.interruptSession(apiInterrupt[1], body.note, 'browser');
      const stoppedArks = await ark.stopArks(store.listSessions());
      const stopped = stoppedArks.filter((r) => r.stopped);
      if (stopped.length > 0) {
        store.appendEvent(apiInterrupt[1], 'arks-stopped', {
          servers: stopped.map((r) => ({ projectDir: r.projectDir, pid: r.pid })),
        });
      }
      store.appendEvent(apiInterrupt[1], 'hub-stopped', {});
      json(res, 200, { status: 'interrupted', interrupted, stoppedArks, hubStopping: true });
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
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
