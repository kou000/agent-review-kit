import * as fs from 'fs';
import * as path from 'path';
import { CommentsFile, ReviewComment, ReviewState } from './types';

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

export function newCommentId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `comment_${Date.now().toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
