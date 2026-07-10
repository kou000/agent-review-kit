import { reviewPaths } from '../paths';
import { beginSnapshot, createSnapshot } from '../snapshot';
import { loadSettings, loadSnapshotIndex } from '../store';

// `snapshot begin`: record the working tree state right before a fix is
// applied. The matching `snapshot create` then captures exactly that fix.
export function snapshotBegin(cwd: string = process.cwd()): void {
  const paths = reviewPaths(cwd);
  const pending = beginSnapshot(paths, cwd);
  console.log(JSON.stringify({ status: 'begun', tree: pending.tree, createdAt: pending.createdAt }, null, 2));
}

export interface SnapshotCreateOptions {
  comment?: string;
  title?: string;
  commit?: string;
  patchFile?: string;
  cwd?: string;
}

export function snapshotCreate(opts: SnapshotCreateOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const paths = reviewPaths(cwd);

  if (!opts.comment) {
    console.error('error: --comment <コメントid> を指定してください');
    process.exit(1);
  }
  const sources = [opts.commit, opts.patchFile].filter((s) => s !== undefined);
  if (sources.length > 1) {
    console.error('error: --commit と --patch-file は同時に指定できません');
    process.exit(1);
  }

  // Snapshots switched off in the review settings: succeed as a no-op so the
  // skill can run the same command sequence regardless of the setting.
  if (!loadSettings(paths.settings).snapshotsEnabled) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'snapshots disabled in settings' }, null, 2));
    return;
  }

  try {
    const meta = createSnapshot(paths, cwd, {
      commentId: opts.comment,
      title: opts.title,
      commit: opts.commit,
      patchFile: opts.patchFile,
    });
    console.log(JSON.stringify({ status: 'created', snapshot: meta }, null, 2));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function snapshotList(cwd: string = process.cwd()): void {
  const paths = reviewPaths(cwd);
  console.log(JSON.stringify(loadSnapshotIndex(paths.snapshotsIndex), null, 2));
}
