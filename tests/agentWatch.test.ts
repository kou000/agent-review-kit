import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as watch from '../hub/lib/agentWatch.js';
import { ReviewComment } from '../src/types';

// review-hub のエージェント対応中監視（hub/lib/agentWatch.js）の判定ロジック。
// 共通の準備は各テストで下のヘルパーを明示的に呼んで組み立てる。

const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-09T12:00:00.000Z');

// NOW から ago ミリ秒前の ISO 時刻
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

// コメント 1 件。createdAt と updatedAt は既定で同じ時刻（ageMs 前）
function comment(
  id: string,
  status: ReviewComment['status'],
  ageMs: number,
  extra: Partial<ReviewComment> = {}
): ReviewComment {
  return {
    id,
    file: null,
    side: null,
    startLine: null,
    endLine: null,
    startDiffLine: null,
    endDiffLine: null,
    body: `${id} の本文`,
    status,
    createdAt: ago(ageMs),
    updatedAt: ago(ageMs),
    ...extra,
  };
}

// hub が投稿した催促コメント（ユーザー名義の返信）
function nudge(id: string, parentId: string, status: ReviewComment['status'], ageMs: number): ReviewComment {
  return comment(id, status, ageMs, { parentId, body: `${watch.NUDGE_PREFIX}（review-hub の自動投稿）対応中のままです` });
}

// コメント列からスレッドごとの待ち状態を出し、トップレベル id で引けるようにする
function waitsById(comments: ReviewComment[]): Map<string, ReturnType<typeof watch.threadWait>> {
  return new Map(watch.threadWaits(comments, NOW).map((w: { topId: string }) => [w.topId, w]));
}

function decisionFor(comments: ReviewComment[], topId: string): string {
  return watch.decide(waitsById(comments).get(topId) ?? null);
}

// createAgentWatch に渡す偽の依存。投稿・イベントを記録し、投稿したコメントは次の読込に反映する
function fakeDeps(sessions: unknown[], commentsByDir: Record<string, ReviewComment[]>) {
  const posts: Array<{ dir: string; payload: { body: string; parentId: string } }> = [];
  const events: Array<{ sessionId: string; type: string }> = [];
  let seq = 0;
  return {
    posts,
    events,
    deps: {
      listSessions: () => sessions,
      waiterScopes: (s: { tabs: Array<{ projectDir: string }> }) =>
        [...new Set(s.tabs.map((t) => t.projectDir))].map((projectDir) => ({ projectDir })),
      fetchComments: async (dir: string) => commentsByDir[dir] ?? null,
      postComment: async (dir: string, payload: { body: string; parentId: string }) => {
        posts.push({ dir, payload });
        seq += 1;
        const id = `nudge-${seq}`;
        commentsByDir[dir].push(nudge(id, payload.parentId, 'open', 0));
        return { ok: true, commentId: id };
      },
      appendEvent: (sessionId: string, type: string) => {
        events.push({ sessionId, type });
      },
      now: () => NOW,
    },
  };
}

function session(id: string, dirs: string[], extra: Record<string, unknown> = {}) {
  return { id, tabs: dirs.map((projectDir) => ({ projectDir })), interrupted: null, ...extra };
}

test('seen のまま 3 分を超えたら催促し、3 分以内なら催促しない', () => {
  assert.equal(decisionFor([comment('a', 'seen', 3 * MIN - 1000)], 'a'), 'none');
  assert.equal(decisionFor([comment('a', 'seen', 3 * MIN + 1000)], 'a'), 'nudge');
});

test('working のまま 5 分を超えたら催促し、5 分以内なら催促しない', () => {
  assert.equal(decisionFor([comment('a', 'working', 4 * MIN)], 'a'), 'none');
  assert.equal(decisionFor([comment('a', 'working', 5 * MIN + 1000)], 'a'), 'nudge');
});

test('open（未配達）のまま 3 分を超えても催促せず、警告にする', () => {
  assert.equal(decisionFor([comment('a', 'open', 2 * MIN)], 'a'), 'none');
  assert.equal(decisionFor([comment('a', 'open', 3 * MIN + 1000)], 'a'), 'warn');
});

test('エージェント名義の open/seen（AI 指摘）はユーザーの返事待ちなので対象外', () => {
  const waits = waitsById([comment('a', 'open', 30 * MIN, { author: 'agent' })]);
  assert.equal(waits.size, 0);
});

test('エージェント名義でも working は対象（エージェントが作業中と宣言した返信）', () => {
  const comments = [
    comment('a', 'working', 20 * MIN),
    comment('r1', 'working', 6 * MIN, { parentId: 'a', author: 'agent' }),
  ];
  const w = waitsById(comments).get('a');
  assert.equal(w?.state, 'working');
  assert.equal(w?.commentId, 'r1');
  assert.equal(watch.decide(w), 'nudge');
});

test('スレッドの状態は最新のコメント（返信を含む）で決まる', () => {
  // 大元は seen のまま古いが、最新の返信がエージェントの回答なら待ちではない
  const answered = [
    comment('a', 'seen', 30 * MIN),
    comment('r1', 'answered', 1 * MIN, { parentId: 'a' }),
  ];
  assert.equal(waitsById(answered).size, 0);
  // 回答済みのスレッドにユーザーが返信し、配達されたまま 3 分超
  const replied = [
    comment('a', 'answered', 30 * MIN),
    comment('r1', 'seen', 4 * MIN, { parentId: 'a' }),
  ];
  assert.equal(decisionFor(replied, 'a'), 'nudge');
});

test('経過時間は最新のコメントの updatedAt から数える', () => {
  const c = comment('a', 'working', 30 * MIN, { updatedAt: ago(2 * MIN) });
  const w = waitsById([c]).get('a');
  assert.equal(w?.elapsedMs, 2 * MIN);
  assert.equal(watch.decide(w), 'none');
});

test('削除済みと手動修正の通知は無視する', () => {
  const comments = [
    comment('a', 'seen', 30 * MIN, { deleted: true }),
    comment('b', 'seen', 30 * MIN, { manualEdit: true }),
  ];
  assert.equal(waitsById(comments).size, 0);
});

test('催促が未対応（seen）のうちは何分経っても再催促しない', () => {
  const comments = [comment('a', 'seen', 60 * MIN), nudge('n1', 'a', 'seen', 30 * MIN)];
  const w = waitsById(comments).get('a');
  assert.equal(w?.nudgePending, true);
  assert.equal(watch.decide(w), 'none');
});

test('催促が配達されないまま 3 分を超えたら未配達の警告にする（催促は重ねない）', () => {
  const comments = [comment('a', 'seen', 60 * MIN), nudge('n1', 'a', 'open', 4 * MIN)];
  assert.equal(decisionFor(comments, 'a'), 'warn');
});

test('エージェントが催促を working にしたら、そこから 5 分で再び催促する', () => {
  const base = [comment('a', 'seen', 60 * MIN)];
  const fresh = [...base, nudge('n1', 'a', 'working', 10 * MIN)];
  fresh[1].updatedAt = ago(3 * MIN);
  assert.equal(decisionFor(fresh, 'a'), 'none');
  const stale = [...base, nudge('n1', 'a', 'working', 10 * MIN)];
  stale[1].updatedAt = ago(5 * MIN + 1000);
  assert.equal(decisionFor(stale, 'a'), 'nudge');
});

test('承認ボタンのコメントも同じ規則で催促し、approval として印を付ける', () => {
  const c = comment('a', 'seen', 4 * MIN, { body: '【承認】「計画を承認して修正開始」が押されました（タブ: 計画）' });
  const w = waitsById([c]).get('a');
  assert.equal(w?.approval, true);
  assert.equal(watch.decide(w), 'nudge');
});

test('催促の本文は【催促】で始まり、working には現状を書くよう求める文を入れる', () => {
  const seenBody = watch.nudgeBody({ state: 'seen' });
  assert.ok(seenBody.startsWith(watch.NUDGE_PREFIX));
  assert.match(seenBody, /3 分以上エージェントの対応中のままです/);
  assert.match(seenBody, /結果か、止まっている理由・ユーザーへの依頼をこのスレッドに返信してください/);

  const workingBody = watch.nudgeBody({ state: 'working' });
  assert.ok(workingBody.startsWith(watch.NUDGE_PREFIX));
  assert.match(workingBody, /5 分以上/);
  assert.match(workingBody, /本当に作業中なら、現状（何をしていて、いつ頃終わる見込みか）をこのスレッドに書いてください/);
  // 催促自身も催促として判定される（重複防止の前提）
  assert.equal(watch.isNudge(comment('n', 'open', 0, { body: workingBody })), true);
});

test('集計: 対応中（seen・working）の件数と最長、3 分超の未配達だけを警告として数える', () => {
  const comments = [
    comment('a', 'seen', 1 * MIN),
    comment('b', 'working', 7 * MIN),
    comment('c', 'open', 10 * 1000),
    comment('d', 'open', 4 * MIN),
    comment('e', 'answered', 60 * MIN),
  ];
  const s = watch.summarize(watch.threadWaits(comments, NOW));
  assert.equal(s.active, 2);
  assert.equal(s.working, 1);
  assert.equal(s.activeLongestMs, 7 * MIN);
  assert.equal(s.undelivered, 1);
  assert.equal(s.undeliveredLongestMs, 4 * MIN);
  assert.deepEqual(
    s.threads.map((t: { topId: string }) => t.topId).sort(),
    ['a', 'b', 'd']
  );
});

test('監視スコープはタブの projectDir と docspace。中断中のセッションは除く', () => {
  const scopes = watch.activeScopes(
    [
      session('s1', ['/repo', '/docs1'], { docspaceDir: '/docs1' }),
      session('s2', ['/repo'], { docspaceDir: '/docs2' }),
      session('s3', ['/other'], { interrupted: { at: ago(0), note: null } }),
    ],
    (s: { tabs: Array<{ projectDir: string }> }) => s.tabs.map((t) => ({ projectDir: t.projectDir }))
  );
  assert.deepEqual([...scopes.keys()].sort(), ['/docs1', '/docs2', '/repo']);
  assert.deepEqual(scopes.get('/repo'), ['s1', 's2']);
});

test('tick: 催促が要るスレッドにだけ返信として投稿し、次の tick では重ねない', async () => {
  const commentsByDir: Record<string, ReviewComment[]> = {
    '/repo': [
      comment('stuck', 'seen', 4 * MIN),
      comment('busy', 'working', 6 * MIN),
      comment('fresh', 'seen', 1 * MIN),
      comment('lost', 'open', 10 * MIN),
    ],
  };
  const { deps, posts, events } = fakeDeps([session('s1', ['/repo'])], commentsByDir);
  const w = watch.createAgentWatch(deps);

  const first = await w.tick();
  assert.deepEqual(first.map((r: { topId: string }) => r.topId).sort(), ['busy', 'stuck']);
  assert.deepEqual(posts.map((p) => p.payload.parentId).sort(), ['busy', 'stuck']);
  const busyPost = posts.find((p) => p.payload.parentId === 'busy');
  assert.match(busyPost?.payload.body ?? '', /現状（何をしていて、いつ頃終わる見込みか）/);
  assert.deepEqual(events.map((e) => e.type), ['nudged', 'nudged']);

  const second = await w.tick();
  assert.equal(second.length, 0);
  assert.equal(posts.length, 2);
});

test('tick: 投稿が読込に反映されなくても、同じ状態のスレッドには一度しか催促しない', async () => {
  const commentsByDir: Record<string, ReviewComment[]> = { '/repo': [comment('stuck', 'seen', 4 * MIN)] };
  const { deps, posts } = fakeDeps([session('s1', ['/repo'])], commentsByDir);
  // 投稿をコメント列に反映しない ark を模す
  deps.postComment = async (dir: string, payload: { body: string; parentId: string }) => {
    posts.push({ dir, payload });
    return { ok: true, commentId: 'x' };
  };
  const w = watch.createAgentWatch(deps);
  await w.tick();
  await w.tick();
  assert.equal(posts.length, 1);
});

test('tick: 中断中のセッションのスコープは監視しない', async () => {
  const commentsByDir: Record<string, ReviewComment[]> = { '/repo': [comment('stuck', 'seen', 30 * MIN)] };
  const { deps, posts } = fakeDeps(
    [session('s1', ['/repo'], { interrupted: { at: ago(0), note: null } })],
    commentsByDir
  );
  await watch.createAgentWatch(deps).tick();
  assert.equal(posts.length, 0);
});

test('sessionSummary: 中断中は null、それ以外はスコープをまとめて集計する', async () => {
  const commentsByDir: Record<string, ReviewComment[]> = {
    '/repo': [comment('a', 'seen', 2 * MIN)],
    '/docs': [comment('b', 'working', 8 * MIN), comment('c', 'open', 5 * MIN)],
  };
  const fetch = async (dir: string) => commentsByDir[dir] ?? null;
  const scopesOf = (s: { tabs: Array<{ projectDir: string }> }) => s.tabs.map((t) => ({ projectDir: t.projectDir }));

  const interrupted = session('s1', ['/repo'], { interrupted: { at: ago(0), note: null } });
  assert.equal(await watch.sessionSummary(interrupted, fetch, scopesOf, NOW), null);

  const s = await watch.sessionSummary(session('s2', ['/repo'], { docspaceDir: '/docs' }), fetch, scopesOf, NOW);
  assert.equal(s.active, 2);
  assert.equal(s.activeLongestMs, 8 * MIN);
  assert.equal(s.undelivered, 1);
  assert.equal(s.undeliveredLongestMs, 5 * MIN);
});
