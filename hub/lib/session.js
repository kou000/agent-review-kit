'use strict';

// review-hub のセッション状態管理。状態はすべて ~/.review-hub/ 配下のファイルで持つ。
// CLI とサーバの双方が session.json を書くため、書き込みは tmp+rename の
// アトミック置換 + mkdir ベースの簡易ロックで直列化する（agent-review-kit と同思想）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HUB_ROOT = process.env.REVIEW_HUB_STATE_DIR || path.join(os.homedir(), '.review-hub');

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAB_TYPES = ['ark-doc', 'ark-diff', 'static'];

// 既定フェーズ（計画→実装→PR の流れ）。フローに合わせて start --phases で差し替え可
const DEFAULT_PHASES = ['計画', '実装', '差分レビュー', 'E2E', 'PR'];

function hubRoot() {
  return HUB_ROOT;
}

function serverJsonPath() {
  return path.join(HUB_ROOT, 'server.json');
}

function sessionsDir() {
  return path.join(HUB_ROOT, 'sessions');
}

function sessionDir(id) {
  return path.join(sessionsDir(), id);
}

function sessionJsonPath(id) {
  return path.join(sessionDir(id), 'session.json');
}

function docspaceDir(id) {
  return path.join(sessionDir(id), 'docspace');
}

function eventsPath(id) {
  return path.join(sessionDir(id), 'events.jsonl');
}

function validateSessionId(id) {
  if (!id || !SESSION_ID_RE.test(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(id)} (allowed: ${SESSION_ID_RE})`);
  }
}

function validateTabId(id) {
  if (!id || !TAB_ID_RE.test(id)) {
    throw new Error(`invalid tab id: ${JSON.stringify(id)} (allowed: ${TAB_ID_RE})`);
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// mkdir ロック。保持側が死んだ場合に備え、古いロックは奪う。
const LOCK_RETRY_MS = 25;
const LOCK_RETRIES = 200; // 最大 5 秒
const LOCK_STALE_MS = 5000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(id, fn) {
  const lockDir = path.join(sessionDir(id), '.lock');
  fs.mkdirSync(sessionDir(id), { recursive: true });
  let acquired = false;
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // 消えた直後なら次のループで取れる
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  if (!acquired) throw new Error(`could not acquire lock for session ${id}`);
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* ignore */
    }
  }
}

// イベントログ（events.jsonl）。状況再構築（status コマンド・再開手順）用の補助情報で、
// 書けなくても本体の状態更新は止めない
function appendEvent(id, type, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), type, ...data });
  try {
    fs.appendFileSync(eventsPath(id), `${line}\n`);
  } catch {
    /* ignore */
  }
}

function readEvents(id, limit = 20) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath(id), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const tail = limit > 0 ? lines.slice(-limit) : lines;
  return tail
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadSession(id) {
  validateSessionId(id);
  return readJson(sessionJsonPath(id));
}

function requireSession(id) {
  const session = loadSession(id);
  if (!session) {
    throw new Error(`session not found: ${id}. Run \`review-hub start --session ${id}\` first.`);
  }
  return session;
}

function listSessions() {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of entries) {
    const session = readJson(sessionJsonPath(name));
    if (session) sessions.push(session);
  }
  sessions.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return sessions;
}

function createSession(id, title, phases) {
  validateSessionId(id);
  const result = withLock(id, () => {
    const existing = readJson(sessionJsonPath(id));
    if (existing) {
      // 再実行は上書きせず既存を返す（同一チケットのフロー再開を想定）。
      // phases はフェーズ列の後付け・差し替え用に更新を許す
      let changed = false;
      if (title && existing.title !== title) {
        existing.title = title;
        changed = true;
      }
      if (Array.isArray(phases) && phases.length) {
        existing.phases = phases;
        changed = true;
      }
      if (changed) atomicWriteJson(sessionJsonPath(id), existing);
      return { session: existing, created: false };
    }
    fs.mkdirSync(docspaceDir(id), { recursive: true });
    const session = {
      id,
      title: title || id,
      createdAt: new Date().toISOString(),
      docspaceDir: docspaceDir(id),
      phases: Array.isArray(phases) && phases.length ? phases : DEFAULT_PHASES.slice(),
      status: { phase: null, note: null, updatedAt: null },
      interrupted: null,
      tabs: [],
    };
    atomicWriteJson(sessionJsonPath(id), session);
    return { session, created: true };
  });
  if (result.created) appendEvent(id, 'session-created', { title: result.session.title });
  return result;
}

function mutateSession(id, fn) {
  validateSessionId(id);
  return withLock(id, () => {
    const session = readJson(sessionJsonPath(id));
    if (!session) throw new Error(`session not found: ${id}`);
    const result = fn(session);
    atomicWriteJson(sessionJsonPath(id), session);
    return result !== undefined ? result : session;
  });
}

function normalizeTab(input) {
  validateTabId(input.id);
  if (!TAB_TYPES.includes(input.type)) {
    throw new Error(`invalid tab type: ${input.type} (allowed: ${TAB_TYPES.join(', ')})`);
  }
  const tab = {
    id: input.id,
    title: input.title || input.id,
    type: input.type,
  };
  if (input.type === 'ark-doc') {
    if (!input.projectDir || !input.docId) throw new Error('ark-doc tab requires --project-dir and --doc-id');
    tab.projectDir = path.resolve(input.projectDir);
    tab.docId = input.docId;
  } else if (input.type === 'ark-diff') {
    if (!input.projectDir) throw new Error('ark-diff tab requires --project-dir');
    tab.projectDir = path.resolve(input.projectDir);
  } else if (input.type === 'static') {
    if (!input.path) throw new Error('static tab requires --path');
    tab.path = path.resolve(input.path);
    tab.entry = input.entry || 'index.html';
    if (!fs.existsSync(tab.path)) throw new Error(`static tab path not found: ${tab.path}`);
  }
  if (input.approvalLabel) {
    tab.approval = { required: true, label: input.approvalLabel, approvedAt: null, note: null };
  }
  return tab;
}

function addTab(sessionId, input) {
  const tab = normalizeTab(input);
  const result = mutateSession(sessionId, (session) => {
    const idx = session.tabs.findIndex((t) => t.id === tab.id);
    if (idx >= 0) {
      // 既存タブは承認状態を保ったまま定義を更新する（再登録 = 更新）
      const prev = session.tabs[idx];
      if (prev.approval && tab.approval) tab.approval = prev.approval;
      if (prev.hidden) tab.hidden = true; // 非表示はユーザーの選択なので定義更新では戻さない
      session.tabs[idx] = tab;
      return { tab, updated: true };
    }
    session.tabs.push(tab);
    return { tab, updated: false };
  });
  appendEvent(sessionId, result.updated ? 'tab-updated' : 'tab-added', { tabId: tab.id, title: tab.title });
  return result;
}

function removeTab(sessionId, tabId) {
  validateTabId(tabId);
  const result = mutateSession(sessionId, (session) => {
    const before = session.tabs.length;
    session.tabs = session.tabs.filter((t) => t.id !== tabId);
    return { removed: session.tabs.length < before };
  });
  if (result.removed) appendEvent(sessionId, 'tab-removed', { tabId });
  return result;
}

// タブの非表示（ブラウザの右クリック / CLI）。表示上の好みだが、エージェントが
// 「非表示のタブ宛のコメント待ち受けは要らない」と判断できるよう session.json に持つ
function setTabHidden(sessionId, tabId, hidden, source) {
  validateTabId(tabId);
  const result = mutateSession(sessionId, (session) => {
    const tab = session.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`tab not found: ${tabId}`);
    const changed = Boolean(tab.hidden) !== Boolean(hidden);
    if (hidden) tab.hidden = true;
    else delete tab.hidden;
    return { tab, changed };
  });
  if (result.changed) appendEvent(sessionId, hidden ? 'tab-hidden' : 'tab-shown', { tabId, source: source || 'cli' });
  return result;
}

// wait-comments の要否判定用: ark タブを projectDir（= waiter のスコープ）ごとに束ね、
// そのスコープのタブがすべて非表示かを返す
function waiterScopes(session) {
  const byDir = new Map();
  for (const t of session.tabs) {
    if (t.type !== 'ark-doc' && t.type !== 'ark-diff') continue;
    if (!byDir.has(t.projectDir)) byDir.set(t.projectDir, []);
    byDir.get(t.projectDir).push(t);
  }
  return Array.from(byDir, ([projectDir, tabs]) => ({
    projectDir,
    tabs: tabs.map((t) => t.id),
    hiddenTabs: tabs.filter((t) => t.hidden).map((t) => t.id),
    allHidden: tabs.every((t) => t.hidden),
  }));
}

// delivery: ブラウザ承認で ark に投稿した承認コメントの所在 { projectDir, commentId }。
// hub がエージェントの受信（open → seen）を表示するために持つ。CLI 承認では無い
function approveTab(sessionId, tabId, note, source, delivery) {
  const result = mutateSession(sessionId, (session) => {
    const tab = session.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`tab not found: ${tabId}`);
    if (!tab.approval) {
      tab.approval = { required: true, label: null, approvedAt: null, note: null };
    }
    tab.approval.approvedAt = new Date().toISOString();
    tab.approval.note = note || null;
    tab.approval.delivery = delivery || null;
    return { tab };
  });
  appendEvent(sessionId, 'approved', {
    tabId,
    label: result.tab.approval.label,
    note: result.tab.approval.note,
    source: source || 'cli',
    delivery: result.tab.approval.delivery,
  });
  return result;
}

// ステータス（フェーズ + 作業メモ）。phase は session.phases のいずれかに限定し、
// ステータスバーのフェーズ進行表示と必ず対応させる
function setStatus(sessionId, { phase, note }) {
  const result = mutateSession(sessionId, (session) => {
    if (!Array.isArray(session.phases)) session.phases = [];
    if (!session.status) session.status = { phase: null, note: null, updatedAt: null };
    if (phase !== undefined) {
      if (session.phases.length && !session.phases.includes(phase)) {
        throw new Error(`unknown phase: ${phase} (allowed: ${session.phases.join(', ')})`);
      }
      session.status.phase = phase;
    }
    if (note !== undefined) session.status.note = note;
    session.status.updatedAt = new Date().toISOString();
    return { status: session.status };
  });
  appendEvent(sessionId, 'status', { phase: result.status.phase, note: result.status.note });
  return result;
}

// 中断（ブラウザの中断ボタン / CLI）。互換用の wait-approval はこれを検知して interrupted を返す
function interruptSession(sessionId, note, source) {
  const result = mutateSession(sessionId, (session) => {
    session.interrupted = { at: new Date().toISOString(), note: note || null };
    return { interrupted: session.interrupted };
  });
  appendEvent(sessionId, 'interrupted', { note: result.interrupted.note, source: source || 'cli' });
  return result;
}

function resumeSession(sessionId) {
  const result = mutateSession(sessionId, (session) => {
    const previous = session.interrupted || null;
    session.interrupted = null;
    // 中断メモは再開後もブラウザ（ヘッダの中断メモボタン）から参照できるよう保持する
    if (previous) session.lastInterrupt = previous;
    return { previous };
  });
  if (result.previous) appendEvent(sessionId, 'resumed', { interruptedAt: result.previous.at });
  return { resumed: true, previousInterrupt: result.previous };
}

function loadServerInfo() {
  return readJson(serverJsonPath());
}

function writeServerInfo(info) {
  atomicWriteJson(serverJsonPath(), info);
}

function removeServerInfo() {
  try {
    fs.unlinkSync(serverJsonPath());
  } catch {
    /* ignore */
  }
}

module.exports = {
  hubRoot,
  serverJsonPath,
  sessionDir,
  docspaceDir,
  loadSession,
  requireSession,
  listSessions,
  createSession,
  mutateSession,
  addTab,
  removeTab,
  approveTab,
  setTabHidden,
  waiterScopes,
  setStatus,
  interruptSession,
  resumeSession,
  appendEvent,
  readEvents,
  loadServerInfo,
  writeServerInfo,
  removeServerInfo,
  validateSessionId,
  validateTabId,
  DEFAULT_PHASES,
};
