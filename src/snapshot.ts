import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, ReviewPaths } from './paths';
import {
  loadComments,
  loadSnapshotIndex,
  newSnapshotId,
  nowIso,
  saveSnapshotIndex,
  withFileLock,
} from './store';
import { SnapshotMeta } from './types';

// Local git runner (gitDiff.ts's does not take env): GIT_INDEX_FILE is how a
// temporary index is swapped in without touching the real one.
function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: env ?? process.env,
  });
}

const SHA_RE = /^[0-9a-f]{4,40}$/;
export const SNAPSHOT_ID_RE = /^snap_[a-z0-9]+$/;

interface PendingSnapshot {
  tree: string;
  createdAt: string;
}

function pendingFile(paths: ReviewPaths): string {
  return path.join(paths.snapshotsDir, 'pending.json');
}

// Capture the current working tree (tracked changes AND untracked files,
// minus ignored ones) as a git tree object, via a throwaway index. The real
// index, working tree and refs are untouched; the only side effect is
// unreferenced objects in .git/objects (reclaimed by gc eventually).
export function captureWorkingTree(paths: ReviewPaths, cwd: string): string {
  ensureDir(paths.snapshotsDir);
  const tmpIndex = path.join(paths.snapshotsDir, '.tmp-index');
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  fs.rmSync(tmpIndex, { force: true });
  try {
    // Seed the temp index from HEAD before `add -A`. Starting from an empty
    // index would silently drop two classes of tracked entries from the
    // captured tree: force-added files matched by .gitignore (ignore rules
    // only apply to untracked paths, so an empty index treats them as
    // ignorable) and gitlinks of uninitialized submodules (add cannot record
    // a gitlink it cannot see). Seeded, `add -A` then applies exactly the
    // working tree's modifications/additions/deletions on top.
    try {
      git(['read-tree', 'HEAD'], cwd, env);
    } catch {
      // Repo without any commit yet: fall back to the empty index.
    }
    git(['add', '-A'], cwd, env);
    return git(['write-tree'], cwd, env).trim();
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

export function beginSnapshot(paths: ReviewPaths, cwd: string): PendingSnapshot {
  const tree = captureWorkingTree(paths, cwd);
  // The first begin of a review records the pre-fix baseline (see
  // SnapshotIndex.baselineTree); later begins leave it untouched.
  withFileLock(paths.dir, () => {
    const index = loadSnapshotIndex(paths.snapshotsIndex);
    if (!index.baselineTree) {
      index.baselineTree = tree;
      saveSnapshotIndex(paths.snapshotsIndex, index);
    }
  });
  const pending: PendingSnapshot = { tree, createdAt: nowIso() };
  fs.writeFileSync(pendingFile(paths), JSON.stringify(pending, null, 2) + '\n');
  return pending;
}

function loadPending(paths: ReviewPaths): PendingSnapshot | null {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(paths), 'utf8')) as PendingSnapshot;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export interface CreateSnapshotOptions {
  commentId: string;
  title?: string;
  // Patch source, mutually exclusive. Default (neither): diff the tree
  // recorded by `snapshot begin` against the working tree now.
  commit?: string;
  patchFile?: string;
}

// Produce the patch text for a new snapshot, plus the git tree of its new side
// (null when unknown, i.e. --patch-file). --binary --full-index makes the
// patch replayable with `git apply` even for binary changes.
function buildPatch(
  paths: ReviewPaths,
  cwd: string,
  opts: CreateSnapshotOptions
): { patch: string; tree: string | null } {
  if (opts.commit) {
    if (!SHA_RE.test(opts.commit)) throw new Error(`invalid commit sha: ${opts.commit}`);
    // A commit made by a subagent in a worktree resolves here too: worktrees
    // share the repository's object database.
    const patch = git(
      ['show', '--no-color', '--no-ext-diff', '--first-parent', '--binary', '--full-index', '--format=', `${opts.commit}^{commit}`],
      cwd
    );
    return { patch, tree: git(['rev-parse', `${opts.commit}^{tree}`], cwd).trim() };
  }
  if (opts.patchFile) {
    return { patch: fs.readFileSync(opts.patchFile, 'utf8'), tree: null };
  }
  const pending = loadPending(paths);
  if (!pending) {
    throw new Error(
      'snapshot begin が実行されていません。修正を適用する前に `agent-review-kit snapshot begin` を実行してください'
    );
  }
  const after = captureWorkingTree(paths, cwd);
  const patch = git(
    ['diff-tree', '-p', '--no-color', '--binary', '--full-index', pending.tree, after],
    cwd
  );
  return { patch, tree: after };
}

export function createSnapshot(
  paths: ReviewPaths,
  cwd: string,
  opts: CreateSnapshotOptions
): SnapshotMeta {
  // Fail loudly on a bad comment id so a snapshot is never orphaned from its
  // review thread.
  const comment = loadComments(paths.comments).find((c) => c.id === opts.commentId);
  if (!comment) throw new Error(`comment not found: ${opts.commentId}`);

  const { patch, tree } = buildPatch(paths, cwd, opts);
  if (!patch.trim()) {
    throw new Error(
      '差分が空です（snapshot begin 以降に変更がないか、パッチが空です）。スナップショットは作成しません'
    );
  }

  ensureDir(paths.snapshotsDir);
  const meta = withFileLock(paths.dir, () => {
    const index = loadSnapshotIndex(paths.snapshotsIndex);
    const seq = index.snapshots.length + 1;
    const id = newSnapshotId();
    const patchFileName = `${String(seq).padStart(4, '0')}_${id}.patch`;
    const m: SnapshotMeta = {
      id,
      seq,
      commentId: opts.commentId,
      createdAt: nowIso(),
      patchFile: patchFileName,
    };
    if (opts.title) m.title = opts.title;
    if (tree) m.tree = tree;
    fs.writeFileSync(path.join(paths.snapshotsDir, patchFileName), patch);
    index.snapshots.push(m);
    saveSnapshotIndex(paths.snapshotsIndex, index);
    return m;
  });

  // The pending marker is consumed by a successful create; only the default
  // (begin/diff) source uses it, but clearing it unconditionally is harmless
  // and avoids a stale tree leaking into the next default-source create.
  fs.rmSync(pendingFile(paths), { force: true });
  return meta;
}

export function findSnapshot(paths: ReviewPaths, id: string): SnapshotMeta | null {
  if (!SNAPSHOT_ID_RE.test(id)) return null;
  return loadSnapshotIndex(paths.snapshotsIndex).snapshots.find((s) => s.id === id) ?? null;
}

export function readSnapshotPatch(paths: ReviewPaths, meta: SnapshotMeta): string {
  // patchFile comes from index.json which the agent writes, but guard against
  // a hand-edited path escaping the snapshots dir anyway.
  const file = path.join(paths.snapshotsDir, path.basename(meta.patchFile));
  return fs.readFileSync(file, 'utf8');
}
