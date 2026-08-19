import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { ensureDir, reviewPaths } from '../paths';
import { loadComments, loadFinished, loadSettings, mutateComments, nowIso } from '../store';
import { ReviewComment, ReviewSettings, commentAuthor } from '../types';

export interface WaitOptions {
  timeout?: number; // seconds, 0 = wait forever
  // Deliver only comments belonging to this published HTML document
  // (comment.documentId matches). Without it every comment — diff review and
  // all documents — is delivered, as before.
  documentId?: string;
  // Exclude comments addressed to an HTML document (comment.documentId is
  // set), delivering only diff review comments. Mutually exclusive with
  // documentId (enforced in cli.ts).
  diffOnly?: boolean;
  // On the first wait after an agent/session restart, also return user
  // comments that a previous waiter already marked as seen but did not finish.
  resume?: boolean;
  cwd?: string;
}

const POLL_INTERVAL_MS = 1000;
const WAIT_LOCK_NAME = '.wait-comments.lock';
const WAIT_RETIRED_NAME = '.wait-comments.retired';
const WAIT_LOCK_STALE_MS = 60_000;
const GENERATION_PATTERN = /^[a-f0-9]{24}$/;
const WITNESS_FILE_PATTERN = /^\.alive-[a-f0-9]{24}$/;

interface WaitLockOwner {
  token: string;
  pid: number;
  startedAt: string;
  processStart?: string;
  witness?: WaitLockWitness;
  generation: string;
}

interface WaitLockWitness {
  file: string;
  dev: number;
  ino: number;
}

interface HeldWaitLockWitness extends WaitLockWitness {
  fd: number;
}

interface OwnerClaim {
  kind: 'owner';
  owner: WaitLockOwner;
}

interface RecoveryClaim {
  kind: 'recovery';
  generation: string;
  token: string;
  claimedAt: string;
}

type DirectoryClaim = OwnerClaim | RecoveryClaim;

interface WaitLock {
  heartbeat: () => void;
  release: () => void;
}

interface ExistingWaitLock {
  generation: string;
  owner: WaitLockOwner | null;
  reclaimable: boolean;
}

function generationKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function fallbackGeneration(stat: fs.Stats): string {
  // Retired directories are kept, so the inode cannot be reused while an old
  // observer could still act on this generation. Do not include birthtime:
  // on APFS it can change when utimes adjusts a directory's timestamps.
  return generationKey(`${stat.dev}:${stat.ino}`);
}

function claimFile(lockDir: string, generation: string): string {
  return path.join(lockDir, `.claim-${generation}.json`);
}

let selfProcessStart: string | null | undefined;

function readProcessStartToken(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return null;
      // The fields after the command start at proc field 3; starttime is 22.
      const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : null;
    }
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim();
    return started ? `${process.platform}:${started}` : null;
  } catch {
    return null;
  }
}

function newLockOwner(generation: string): WaitLockOwner {
  if (selfProcessStart === undefined) {
    selfProcessStart = readProcessStartToken(process.pid);
  }
  return {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(selfProcessStart ? { processStart: selfProcessStart } : {}),
    generation,
  };
}

function isWaitLockWitness(value: unknown): value is WaitLockWitness {
  if (!value || typeof value !== 'object') return false;
  const witness = value as Partial<WaitLockWitness>;
  return (
    typeof witness.file === 'string' &&
    WITNESS_FILE_PATTERN.test(witness.file) &&
    typeof witness.dev === 'number' &&
    Number.isFinite(witness.dev) &&
    typeof witness.ino === 'number' &&
    Number.isFinite(witness.ino)
  );
}

function isWaitLockOwner(value: unknown): value is WaitLockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<WaitLockOwner>;
  return (
    typeof owner.token === 'string' &&
    Number.isInteger(owner.pid) &&
    typeof owner.startedAt === 'string' &&
    typeof owner.generation === 'string' &&
    GENERATION_PATTERN.test(owner.generation) &&
    (owner.processStart === undefined || typeof owner.processStart === 'string') &&
    (owner.witness === undefined || isWaitLockWitness(owner.witness))
  );
}

function readDirectoryClaim(file: string): DirectoryClaim | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DirectoryClaim>;
    if (value.kind === 'owner' && 'owner' in value && isWaitLockOwner(value.owner)) {
      return { kind: 'owner', owner: value.owner };
    }
    if (
      value.kind === 'recovery' &&
      'generation' in value &&
      typeof value.generation === 'string' &&
      GENERATION_PATTERN.test(value.generation) &&
      'token' in value &&
      typeof value.token === 'string' &&
      'claimedAt' in value &&
      typeof value.claimedAt === 'string'
    ) {
      return {
        kind: 'recovery',
        generation: value.generation,
        token: value.token,
        claimedAt: value.claimedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function createLivenessWitness(lockDir: string, token: string): HeldWaitLockWitness | null {
  const file = `.alive-${generationKey(token)}`;
  const witnessPath = path.join(lockDir, file);
  let fd: number | null = null;
  try {
    // A FIFO reader is a kernel-held liveness witness. Unlike a timestamp
    // lease it survives SIGSTOP, while a crash closes it immediately. mkfifo
    // is available on macOS/Linux; unsupported platforms fall back to PID
    // identity below.
    execFileSync('mkfifo', ['-m', '600', witnessPath], { stdio: 'ignore' });
    fd = fs.openSync(witnessPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const descriptor = fs.fstatSync(fd);
    const target = fs.lstatSync(witnessPath);
    if (
      !descriptor.isFIFO() ||
      !target.isFIFO() ||
      descriptor.dev !== target.dev ||
      descriptor.ino !== target.ino
    ) {
      fs.closeSync(fd);
      return null;
    }
    return { file, dev: descriptor.dev, ino: descriptor.ino, fd };
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor is already unusable; PID identity is the fallback.
      }
    }
    return null;
  }
}

function heldWitnessIsCurrent(
  lockDir: string,
  expected: WaitLockWitness,
  held: HeldWaitLockWitness | null
): boolean {
  if (
    !held ||
    held.file !== expected.file ||
    held.dev !== expected.dev ||
    held.ino !== expected.ino
  ) {
    return false;
  }
  try {
    const descriptor = fs.fstatSync(held.fd);
    const target = fs.lstatSync(path.join(lockDir, expected.file));
    return (
      descriptor.isFIFO() &&
      target.isFIFO() &&
      descriptor.dev === expected.dev &&
      descriptor.ino === expected.ino &&
      target.dev === expected.dev &&
      target.ino === expected.ino
    );
  } catch {
    return false;
  }
}

// true/false is a definitive FIFO result; null means the platform or
// filesystem cannot probe it and the caller should use PID identity.
function witnessOwnerIsAlive(lockDir: string, witness: WaitLockWitness): boolean | null {
  const witnessPath = path.join(lockDir, witness.file);
  try {
    const target = fs.lstatSync(witnessPath);
    if (
      !target.isFIFO() ||
      target.dev !== witness.dev ||
      target.ino !== witness.ino
    ) {
      return false;
    }
    const fd = fs.openSync(witnessPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENXIO' || code === 'ENOENT' || code === 'ENOTDIR') return false;
    return null;
  }
}

// Prefer the FIFO witness because it cannot be confused by PID reuse. On a
// platform without FIFO support, require a matching process-start token when
// available; otherwise fail closed and keep a live PID's lock.
function ownerProcessIsAlive(owner: WaitLockOwner, lockDir: string): boolean {
  if (owner.witness) {
    const witnessAlive = witnessOwnerIsAlive(lockDir, owner.witness);
    if (witnessAlive !== null) return witnessAlive;
  }
  if (!processIsAlive(owner.pid)) return false;
  if (!owner.processStart) return true;
  const currentStart = readProcessStartToken(owner.pid);
  return currentStart === null || currentStart === owner.processStart;
}

function readLockStat(lockDir: string): fs.Stats | null {
  try {
    return fs.lstatSync(lockDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function sameLockGeneration(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function claimsEqual(a: DirectoryClaim, b: DirectoryClaim): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'owner' && b.kind === 'owner') {
    return a.owner.token === b.owner.token && a.owner.generation === b.owner.generation;
  }
  return (
    a.kind === 'recovery' &&
    b.kind === 'recovery' &&
    a.token === b.token &&
    a.generation === b.generation
  );
}

function publishClaim(
  reviewDir: string,
  destination: string,
  claim: DirectoryClaim
): boolean {
  const identity =
    claim.kind === 'owner' ? claim.owner.token : `${claim.generation}-${claim.token}`;
  const candidate = path.join(
    reviewDir,
    `.wait-comments-claim-${generationKey(identity)}-${Math.random().toString(36).slice(2)}.tmp`
  );
  let candidateCreated = false;

  try {
    // Prepare the complete JSON first, then hard-link it into the lock. The
    // link is an atomic, no-replace publication point shared by the creator
    // and stale recovery; a half-written owner can never race a recovery.
    fs.writeFileSync(candidate, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' });
    candidateCreated = true;
    try {
      fs.linkSync(candidate, destination);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOENT') return false;
      throw e;
    }
  } finally {
    if (candidateCreated) {
      try {
        fs.unlinkSync(candidate);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
}

function inspectExistingWaitLock(lockDir: string, reviewDir: string): ExistingWaitLock | null {
  const before = readLockStat(lockDir);
  if (!before) return null;
  const generation = fallbackGeneration(before);
  const canonicalClaimFile = claimFile(lockDir, generation);
  const claimExists = fs.existsSync(canonicalClaimFile);
  const claim = readDirectoryClaim(canonicalClaimFile);
  const after = readLockStat(lockDir);
  if (!after || !sameLockGeneration(before, after)) return null;

  if (
    claim?.kind === 'owner' &&
    claim.owner.generation === generation
  ) {
    return {
      generation,
      owner: claim.owner,
      // A valid live owner is never reclaimed merely because it was paused.
      reclaimable: !ownerProcessIsAlive(claim.owner, lockDir),
    };
  }
  if (claim?.kind === 'recovery' && claim.generation === generation) {
    return { generation, owner: null, reclaimable: true };
  }

  const stale = Date.now() - after.mtimeMs > WAIT_LOCK_STALE_MS;
  if (!stale) return { generation, owner: null, reclaimable: false };

  if (!claimExists) {
    const recovery: RecoveryClaim = {
      kind: 'recovery',
      generation,
      token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      claimedAt: new Date().toISOString(),
    };
    if (!publishClaim(reviewDir, canonicalClaimFile, recovery)) {
      // A creator or another recoverer won the same atomic publication point.
      return null;
    }
    const finalStat = readLockStat(lockDir);
    const finalClaim = readDirectoryClaim(canonicalClaimFile);
    if (
      !finalStat ||
      !sameLockGeneration(after, finalStat) ||
      !finalClaim ||
      !claimsEqual(finalClaim, recovery)
    ) {
      return null;
    }
  }

  // An invalid canonical claim can only be corruption or an artifact from an
  // older implementation: current claims are published fully by hard link.
  return { generation, owner: null, reclaimable: true };
}

function retireDirectoryLock(
  lockDir: string,
  retiredRoot: string,
  generation: string
): boolean {
  ensureDir(retiredRoot);
  const retired = path.join(retiredRoot, generation);
  try {
    // Every participant derives the same generation from this directory's
    // inode. The retained non-empty destination is an ABA fence: a delayed
    // rename for this generation cannot move a later lock onto the same path.
    fs.renameSync(lockDir, retired);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    throw e;
  }
}

function directoryLockIsOwned(
  lockDir: string,
  generation: string,
  expectedOwner: WaitLockOwner,
  expectedStat: fs.Stats,
  heldWitness: HeldWaitLockWitness | null
): boolean {
  const before = readLockStat(lockDir);
  if (!before || !sameLockGeneration(expectedStat, before)) return false;
  if (fallbackGeneration(before) !== generation) return false;
  const claim = readDirectoryClaim(claimFile(lockDir, generation));
  const after = readLockStat(lockDir);
  return (
    after !== null &&
    sameLockGeneration(expectedStat, after) &&
    claim?.kind === 'owner' &&
    claim.owner.generation === generation &&
    claim.owner.token === expectedOwner.token &&
    (expectedOwner.witness === undefined ||
      heldWitnessIsCurrent(lockDir, expectedOwner.witness, heldWitness))
  );
}

function acquireWaitLock(cwd: string): WaitLock {
  const paths = reviewPaths(cwd);
  ensureDir(paths.dir);
  const lockDir = path.join(paths.dir, WAIT_LOCK_NAME);
  const retiredRoot = path.join(paths.dir, WAIT_RETIRED_NAME);

  for (;;) {
    try {
      // mkdir is the cross-platform no-replace primitive. It is sufficient on
      // its own once creator and recovery also share one canonical claim.
      fs.mkdirSync(lockDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = inspectExistingWaitLock(lockDir, paths.dir);
      if (!existing) continue;
      if (!existing.reclaimable) {
        const ownerLabel = existing.owner ? ` (pid: ${existing.owner.pid})` : '';
        throw new Error(
          `another wait-comments process is already running${ownerLabel}; do not start a second waiter`
        );
      }
      if (!retireDirectoryLock(lockDir, retiredRoot, existing.generation)) continue;
      continue;
    }

    const createdStat = readLockStat(lockDir);
    if (!createdStat) throw new Error('wait-comments lock disappeared during startup');
    const generation = fallbackGeneration(createdStat);
    const owner = newLockOwner(generation);
    const heldWitness = createLivenessWitness(lockDir, owner.token);
    if (heldWitness) {
      owner.witness = {
        file: heldWitness.file,
        dev: heldWitness.dev,
        ino: heldWitness.ino,
      };
    }
    let witnessClosed = false;
    const closeWitness = (): void => {
      if (!heldWitness || witnessClosed) return;
      witnessClosed = true;
      try {
        fs.closeSync(heldWitness.fd);
      } catch {
        // Best effort during process teardown.
      }
    };
    const ownerClaim: OwnerClaim = { kind: 'owner', owner };
    let published: boolean;
    try {
      published = publishClaim(paths.dir, claimFile(lockDir, generation), ownerClaim);
    } catch (e) {
      closeWitness();
      throw e;
    }
    if (
      !published ||
      !directoryLockIsOwned(lockDir, generation, owner, createdStat, heldWitness)
    ) {
      // If recovery won, it owns retirement. If this directory was replaced,
      // its generation-specific stray claim is ignored by the new instance.
      if (directoryLockIsOwned(lockDir, generation, owner, createdStat, heldWitness)) {
        retireDirectoryLock(lockDir, retiredRoot, generation);
      }
      closeWitness();
      throw new Error('wait-comments lock ownership was lost during startup');
    }

    const stillOwned = (): boolean =>
      directoryLockIsOwned(lockDir, generation, owner, createdStat, heldWitness);
    return {
      heartbeat: () => {
        if (!stillOwned()) throw new Error('wait-comments lock ownership was lost');
        const now = new Date();
        fs.utimesSync(lockDir, now, now);
        if (!stillOwned()) throw new Error('wait-comments lock ownership was lost');
      },
      release: () => {
        try {
          if (stillOwned()) retireDirectoryLock(lockDir, retiredRoot, generation);
        } finally {
          closeWitness();
        }
      },
    };
  }
}

// Standing instruction delivered alongside every received batch (settings
// deliveryNoteEnabled / deliveryNoteText). Skill-file instructions decay with
// context distance by the time comments arrive; a note riding along with the
// batch sits right next to the data it applies to.
const DELEGATION_NOTE =
  '修正を伴うコメントは、メインセッションで直接コードを編集せず、Agent ツールでサブエージェントに委譲すること（1件だけでも委譲する）。' +
  '複数件ある場合は1つのメッセージで並行起動し、完了を待たずに次のコメントの委譲へ進む。' +
  'メインセッションは委譲・回答・resolve のオーケストレーションに徹する。';

function buildDeliveryNote(settings: ReviewSettings): string | undefined {
  const parts: string[] = [];
  // The built-in note instructs how to fix; in read-only mode fixing itself
  // is forbidden, so including it would only contradict the mode.
  if (settings.deliveryNoteEnabled && !settings.readOnlyMode) parts.push(DELEGATION_NOTE);
  const custom = settings.deliveryNoteText.trim();
  if (custom) parts.push(custom);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

// Normally only the user's live open comments are deliverable. Resume mode also
// returns seen user comments left behind by an interrupted agent session.
// Agent-authored findings stay open until the user replies or the review ends;
// the reply is what flows to the agent. documentId / diffOnly narrow delivery
// to one published HTML document or to the diff review respectively.
function isDeliverable(c: ReviewComment, opts: WaitOptions): boolean {
  if (opts.documentId !== undefined && c.documentId !== opts.documentId) return false;
  if (opts.diffOnly && c.documentId !== undefined) return false;
  return (
    (c.status === 'open' || (opts.resume === true && c.status === 'seen')) &&
    !c.deleted &&
    commentAuthor(c) === 'user'
  );
}

function takeDeliverable(commentsFile: string, opts: WaitOptions): ReviewComment[] {
  return mutateComments(commentsFile, (comments) => {
    const now = nowIso();
    const deliverable = comments.filter((c) => isDeliverable(c, opts));
    for (const c of deliverable) {
      if (c.status === 'open') {
        c.status = 'seen';
        c.updatedAt = now;
      }
    }
    return deliverable;
  });
}

export async function waitComments(opts: WaitOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutSec = opts.timeout ?? 0;
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;
  const waitLock = acquireWaitLock(cwd);

  // SIGTERM/SIGINT here means the user stopped the session (interrupt button,
  // shell teardown), not a crash. Without a handler the process dies with exit
  // 143, which agents have misread as a failure and "recovered" by restarting
  // everything. Exit 0 with an explicit status so the intent is unambiguous.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try {
        waitLock.release();
      } catch {
        // The lock dies with the process anyway (FIFO witness closes on exit);
        // never let cleanup mask the intentional-stop status below.
      }
      console.log(
        JSON.stringify(
          {
            status: 'interrupted',
            note: 'ユーザー操作（シグナル）による停止。エージェントは自動で再起動しないこと。',
            comments: [],
          },
          null,
          2
        )
      );
      process.exit(0);
    });
  }

  try {
    for (;;) {
      waitLock.heartbeat();
      // Re-resolved every poll: review data is branch-scoped, and a checkout
      // while waiting should shift the watch to the new branch's comments.
      const paths = reviewPaths(cwd);
      // Unlocked probe: reads always see a consistent snapshot (rename is atomic).
      const hasDeliverable = loadComments(paths.comments).some((c) => isDeliverable(c, opts));
      if (hasDeliverable) {
        // Fence a waiter that lost ownership before it mutates comments.
        waitLock.heartbeat();
        // Re-extract deliverable comments inside the comments lock so any that
        // appeared between the probe and lock acquisition join the batch.
        const received = takeDeliverable(paths.comments, opts);
        // A comment may be resolved between the unlocked probe and mutation.
        // An empty batch is not a receipt — keep waiting.
        if (received.length > 0) {
          // The current settings ride along with every delivery so the consumer
          // (the agent) always has readOnlyMode etc. in front of it at triage.
          const settings = loadSettings(paths.settings);
          const note = buildDeliveryNote(settings);
          console.log(
            JSON.stringify(
              { status: 'received', ...(note !== undefined && { note }), settings, comments: received },
              null,
              2
            )
          );
          return;
        }
      }
      // Checked only after the delivery attempt: a comment posted just before
      // the finish button was pressed is still delivered, never dropped.
      if (loadFinished(paths.finished)) {
        // The unlocked probe above may have run immediately before a comment
        // was committed and the finish marker was written. Re-check under the
        // comments lock; the server rejects any posts ordered after finish.
        waitLock.heartbeat();
        const finalReceived = takeDeliverable(paths.comments, opts);
        if (finalReceived.length > 0) {
          const settings = loadSettings(paths.settings);
          const note = buildDeliveryNote(settings);
          console.log(
            JSON.stringify(
              {
                status: 'received',
                ...(note !== undefined && { note }),
                settings,
                comments: finalReceived,
              },
              null,
              2
            )
          );
          return;
        }
        console.log(JSON.stringify({ status: 'finished', comments: [] }, null, 2));
        return;
      }
      if (deadline !== null && Date.now() >= deadline) {
        console.log(JSON.stringify({ status: 'timeout', comments: [] }, null, 2));
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } finally {
    waitLock.release();
  }
}
