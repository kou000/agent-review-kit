import * as fs from 'fs';
import * as path from 'path';
import {
  CommentsFile,
  DEFAULT_SETTINGS,
  FinishState,
  HtmlDocumentIndex,
  ReviewComment,
  ReviewSettings,
  ReviewState,
  SnapshotIndex,
} from './types';

function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // Only a missing file falls back to the default. Parse/IO errors must
    // propagate so a corrupt comments.json is never silently treated as empty
    // (which would let the next write wipe out existing comments).
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
  return JSON.parse(raw) as T;
}

function writeJsonAtomic(file: string, value: unknown): void {
  // tmp + rename only prevents torn writes (a reader never sees a partial
  // file). It does NOT provide mutual exclusion between concurrent
  // read-modify-write cycles; that is the job of withFileLock below.
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}`
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const LOCK_NAME = '.comments.lock';
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;

function sleepSync(ms: number): void {
  // Block the current (synchronous) thread without busy-waiting.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock<T>(lockDir: string, fn: () => T): T {
  const lockPath = path.join(lockDir, LOCK_NAME);
  const start = Date.now();
  for (;;) {
    try {
      // mkdir is atomic across processes: exactly one caller wins.
      fs.mkdirSync(lockPath);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Someone else holds the lock. Reclaim it if it is stale (the holder
      // likely crashed without releasing it).
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between stat and now; just retry acquisition.
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`could not acquire lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // Best effort: if the lock was already reclaimed as stale, ignore.
    }
  }
}

export function loadComments(file: string): ReviewComment[] {
  return readJson<CommentsFile>(file, { comments: [] }).comments;
}

export function saveComments(file: string, comments: ReviewComment[]): void {
  writeJsonAtomic(file, { comments });
}

/**
 * Perform a read-modify-write on the comments file under an exclusive lock.
 * The comments are re-loaded inside the lock so concurrent writers never
 * clobber each other's updates. The callback's return value is passed through.
 */
export function mutateComments<T>(
  commentsFile: string,
  fn: (comments: ReviewComment[]) => T
): T {
  // First write may precede `generate` (e.g. add-comment on a fresh branch):
  // the branch data dir must exist before a lock can be taken inside it.
  fs.mkdirSync(path.dirname(commentsFile), { recursive: true });
  return withFileLock(path.dirname(commentsFile), () => {
    const comments = loadComments(commentsFile);
    const result = fn(comments);
    saveComments(commentsFile, comments);
    return result;
  });
}

export function loadState(file: string): ReviewState | null {
  return readJson<ReviewState | null>(file, null);
}

export function saveState(file: string, state: ReviewState): void {
  writeJsonAtomic(file, state);
}

export function loadSettings(file: string): ReviewSettings {
  // Merge over the defaults key by key so a settings.json written by an older
  // version (or edited by hand) never yields undefined for a known setting,
  // and unknown keys are dropped.
  const raw = readJson<Partial<ReviewSettings>>(file, {});
  return {
    snapshotsEnabled:
      typeof raw.snapshotsEnabled === 'boolean'
        ? raw.snapshotsEnabled
        : DEFAULT_SETTINGS.snapshotsEnabled,
    readOnlyMode:
      typeof raw.readOnlyMode === 'boolean'
        ? raw.readOnlyMode
        : DEFAULT_SETTINGS.readOnlyMode,
  };
}

export function saveSettings(file: string, settings: ReviewSettings): void {
  writeJsonAtomic(file, settings);
}

/**
 * Read-modify-write on settings.json under the same lock as comments.json
 * (updates are rare, so sharing the lock keeps things simple).
 */
export function mutateSettings(
  settingsFile: string,
  fn: (settings: ReviewSettings) => void
): ReviewSettings {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  return withFileLock(path.dirname(settingsFile), () => {
    const settings = loadSettings(settingsFile);
    fn(settings);
    saveSettings(settingsFile, settings);
    return settings;
  });
}

export function loadFinished(file: string): FinishState | null {
  return readJson<FinishState | null>(file, null);
}

export function saveFinished(file: string): void {
  writeJsonAtomic(file, { finishedAt: nowIso() } satisfies FinishState);
}

export function clearFinished(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function loadSnapshotIndex(file: string): SnapshotIndex {
  return readJson<SnapshotIndex>(file, { snapshots: [] });
}

export function saveSnapshotIndex(file: string, index: SnapshotIndex): void {
  writeJsonAtomic(file, index);
}

export function loadDocumentIndex(file: string): HtmlDocumentIndex {
  return readJson<HtmlDocumentIndex>(file, { documents: [] });
}

export function saveDocumentIndex(file: string, index: HtmlDocumentIndex): void {
  writeJsonAtomic(file, index);
}

/**
 * Read-modify-write on documents/index.json under a lock in the documents
 * directory (its own lock: document publishes never contend with comment
 * writes). The callback's return value is passed through.
 */
export function mutateDocumentIndex<T>(
  indexFile: string,
  fn: (index: HtmlDocumentIndex) => T
): T {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  return withFileLock(path.dirname(indexFile), () => {
    const index = loadDocumentIndex(indexFile);
    const result = fn(index);
    saveDocumentIndex(indexFile, index);
    return result;
  });
}

export function newCommentId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `comment_${Date.now().toString(36)}${rand}`;
}

export function newSnapshotId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `snap_${Date.now().toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
