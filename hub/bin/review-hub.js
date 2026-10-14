#!/usr/bin/env node
'use strict';

// review-hub CLI。すべてのコマンドが JSON を stdout に出す（LLM から扱いやすくするため）。
// セッション状態は ~/.review-hub/ のファイルを直接読み書きし、サーバ未起動でも
// serve 以外のコマンドは機能する。

const store = require('../lib/session');

function usage() {
  return [
    'usage: review-hub <command> [options]',
    '',
    '  serve [--port N]                                 hub サーバを起動（フォアグラウンド常駐）',
    '  start --session <id> [--title <t>]               セッション作成（docspace も作成、既存なら再利用）',
    '        [--phases <a,b,c>]                          フェーズ列（省略時: 計画,実装,差分レビュー,E2E,PR）',
    '  set-status --session <id> [--phase <p>] [--note <t>]  現在フェーズ・作業メモを更新（ステータスバーに表示）',
    '  interrupt --session <id> [--note <t>]            中断を記録（wait-approval が interrupted を返す）',
    '  resume --session <id>                            中断状態を解除（再開時に実行）',
    '  add-tab --session <id> --id <tabId> --title <t>',
    '          --type ark-doc|ark-diff|static',
    '          [--project-dir <dir>] [--doc-id <id>]    (ark-doc / ark-diff 用)',
    '          [--path <dir>] [--entry <file>]          (static 用)',
    '          [--approval-label <text>]                承認ボタンを付ける',
    '  remove-tab --session <id> --id <tabId>',
    '  hide-tab --session <id> --id <tabId>               タブを非表示にする（ブラウザの右クリックと同じ）',
    '  show-tab --session <id> --id <tabId>               非表示を解除する',
    '  approve --session <id> --tab <tabId> [--note <t>]  CLI から承認（主にテスト用）',
    '  approve-status --session <id> [--tab <tabId>]',
    '  wait-approval --session <id> --tab <tabId> [--timeout <sec>]  承認までブロック（0=無期限, 既定 0）。中断で interrupted を返す',
    '  url [--session <id>]                             ブラウザで開く URL を出力',
    '  status [--session <id>] [--events <n>]           サーバ情報とセッション一覧 / セッション詳細（現況サマリ）',
    '  stop                                             サーバ停止',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stdout.write(`${JSON.stringify({ status: 'error', error: message })}\n`);
  process.exit(1);
}

function require_(args, keys) {
  for (const key of keys) {
    if (!args[key] || args[key] === true) fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
}

function hubUrl(sessionId) {
  const info = store.loadServerInfo();
  if (!info) return null;
  return sessionId ? `http://localhost:${info.port}/s/${encodeURIComponent(sessionId)}` : `http://localhost:${info.port}/`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'serve': {
      const { startServer } = require('../lib/server');
      const port = args.port ? Number(args.port) : undefined;
      const { port: actual } = await startServer(port);
      // serve だけは常駐するため、起動情報を 1 行出してそのまま待つ
      out({ status: 'serving', port: actual, url: `http://localhost:${actual}/`, pid: process.pid });
      break;
    }

    case 'start': {
      require_(args, ['session']);
      const phases =
        typeof args.phases === 'string'
          ? args.phases.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      const { session, created } = store.createSession(args.session, args.title, phases);
      out({
        status: created ? 'created' : 'exists',
        session,
        url: hubUrl(session.id),
        hint: hubUrl(session.id) ? undefined : 'hub server is not running. Start it with `review-hub serve` (background).',
      });
      break;
    }

    case 'add-tab': {
      require_(args, ['session', 'id', 'type']);
      store.requireSession(args.session);
      const { tab, updated } = store.addTab(args.session, {
        id: args.id,
        title: args.title,
        type: args.type,
        projectDir: args.projectDir,
        docId: args.docId,
        path: args.path,
        entry: args.entry,
        approvalLabel: args.approvalLabel,
      });
      out({ status: updated ? 'updated' : 'added', tab, url: hubUrl(args.session) });
      break;
    }

    case 'remove-tab': {
      require_(args, ['session', 'id']);
      const { removed } = store.removeTab(args.session, args.id);
      out({ status: removed ? 'removed' : 'not-found', tabId: args.id });
      break;
    }

    case 'hide-tab':
    case 'show-tab': {
      require_(args, ['session', 'id']);
      store.requireSession(args.session);
      const { tab, changed } = store.setTabHidden(args.session, args.id, cmd === 'hide-tab', 'cli');
      out({ status: changed ? 'ok' : 'unchanged', tab });
      break;
    }

    case 'approve': {
      require_(args, ['session', 'tab']);
      const { tab } = store.approveTab(args.session, args.tab, args.note, 'cli');
      out({ status: 'approved', tab });
      break;
    }

    case 'set-status': {
      require_(args, ['session']);
      if (typeof args.phase !== 'string' && typeof args.note !== 'string') {
        fail('--phase or --note is required');
      }
      store.requireSession(args.session);
      const { status } = store.setStatus(args.session, {
        phase: typeof args.phase === 'string' ? args.phase : undefined,
        note: typeof args.note === 'string' ? args.note : undefined,
      });
      out({ status: 'ok', current: status });
      break;
    }

    case 'interrupt': {
      // 中断 = サインアウト前の全停止（ブラウザの中断ボタンと同じ）:
      // 全セッションの ark serve と hub サーバを停止する
      require_(args, ['session']);
      store.requireSession(args.session);
      const { interrupted } = store.interruptSession(args.session, typeof args.note === 'string' ? args.note : undefined, 'cli');
      const arkLib = require('../lib/ark');
      const stoppedArks = await arkLib.stopArks(store.listSessions());
      const stopped = stoppedArks.filter((r) => r.stopped);
      if (stopped.length > 0) {
        store.appendEvent(args.session, 'arks-stopped', {
          servers: stopped.map((r) => ({ projectDir: r.projectDir, pid: r.pid })),
        });
      }
      const info = store.loadServerInfo();
      let hubStopped = false;
      if (info) {
        try {
          process.kill(info.pid, 'SIGTERM');
          hubStopped = true;
          store.appendEvent(args.session, 'hub-stopped', {});
        } catch {
          store.removeServerInfo(); // 残骸
        }
      }
      out({ status: 'interrupted', interrupted, stoppedArks, hubStopped });
      break;
    }

    case 'resume': {
      require_(args, ['session']);
      store.requireSession(args.session);
      out({ status: 'resumed', ...store.resumeSession(args.session) });
      break;
    }

    case 'approve-status': {
      require_(args, ['session']);
      const session = store.requireSession(args.session);
      const tabs = session.tabs
        .filter((t) => t.approval)
        .filter((t) => !args.tab || t.id === args.tab)
        .map((t) => ({ id: t.id, title: t.title, label: t.approval.label, approvedAt: t.approval.approvedAt, note: t.approval.note }));
      out({ status: 'ok', tabs });
      break;
    }

    case 'wait-approval': {
      require_(args, ['session', 'tab']);
      store.requireSession(args.session);
      const timeoutSec = args.timeout !== undefined ? Number(args.timeout) : 0;
      const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;
      for (;;) {
        const session = store.requireSession(args.session);
        const tab = session.tabs.find((t) => t.id === args.tab);
        if (!tab) fail(`tab not found: ${args.tab}`);
        if (tab.approval && tab.approval.approvedAt) {
          out({ status: 'approved', tabId: tab.id, approvedAt: tab.approval.approvedAt, note: tab.approval.note });
          return;
        }
        // 中断ボタン（interrupt）で承認待ちを解く。承認済みが先に立つ
        if (session.interrupted) {
          out({ status: 'interrupted', tabId: args.tab, interruptedAt: session.interrupted.at, note: session.interrupted.note });
          return;
        }
        if (deadline && Date.now() >= deadline) {
          out({ status: 'timeout', tabId: args.tab });
          return;
        }
        await sleep(1000);
      }
    }

    case 'url': {
      const sessions = store.listSessions();
      const id = args.session || (sessions[0] && sessions[0].id);
      const url = hubUrl(id);
      if (!url) fail('hub server is not running. Start it with `review-hub serve`.');
      out({ status: 'ok', url });
      break;
    }

    case 'status': {
      // --session 付き: 再開時の現況把握用サマリ（フェーズ・承認・未解決コメント・直近イベント）
      if (args.session) {
        const session = store.requireSession(args.session);
        const arkLib = require('../lib/ark');
        const tabs = await Promise.all(
          session.tabs.map(async (t) => {
            const info = { id: t.id, title: t.title, type: t.type };
            if (t.hidden) info.hidden = true;
            if (t.type === 'ark-doc' || t.type === 'ark-diff') {
              const r = await arkLib.resolveArkTab(t);
              info.alive = r.alive;
              info.unresolved = r.unresolved; // 未解決スレッド数（エージェントの作業待ち）
              info.check = r.check; // 要確認スレッド数（ユーザーの確認待ち）
            }
            if (t.approval) {
              info.approval = { label: t.approval.label, approvedAt: t.approval.approvedAt, note: t.approval.note };
            }
            return info;
          })
        );
        out({
          status: 'ok',
          session: { id: session.id, title: session.title, createdAt: session.createdAt },
          phases: session.phases || [],
          current: session.status || null,
          interrupted: session.interrupted || null,
          lastInterrupt: session.lastInterrupt || null,
          pendingApprovals: tabs.filter((t) => t.approval && !t.approval.approvedAt).map((t) => t.approval.label || t.id),
          unresolvedTotal: tabs.reduce((n, t) => n + (typeof t.unresolved === 'number' ? t.unresolved : 0), 0),
          checkTotal: tabs.reduce((n, t) => n + (typeof t.check === 'number' ? t.check : 0), 0),
          tabs,
          // wait-comments が必要なスコープ。allHidden のスコープは waiter 不要（Stop フックも咎めない）
          waiterScopes: store.waiterScopes(session),
          recentEvents: store.readEvents(args.session, args.events ? Number(args.events) : 10),
          url: hubUrl(session.id),
        });
        break;
      }
      const info = store.loadServerInfo();
      out({
        status: 'ok',
        server: info || null,
        sessions: store.listSessions().map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          phase: s.status ? s.status.phase : undefined,
          interrupted: s.interrupted ? s.interrupted.at : undefined,
          tabs: s.tabs.map((t) => ({ id: t.id, type: t.type, approvedAt: t.approval ? t.approval.approvedAt : undefined })),
        })),
      });
      break;
    }

    case 'stop': {
      const info = store.loadServerInfo();
      if (!info) {
        out({ status: 'not-running' });
        return;
      }
      try {
        process.kill(info.pid, 'SIGTERM');
        out({ status: 'stopped', pid: info.pid });
      } catch {
        store.removeServerInfo();
        out({ status: 'stale', note: 'server.json was stale and has been removed' });
      }
      break;
    }

    default:
      process.stderr.write(`${usage()}\n`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => fail(err.message));
