import { reviewPaths } from '../paths';
import { loadComments, mutateComments, nowIso } from '../store';

export interface WaitOptions {
  timeout?: number; // seconds, 0 = wait forever
  cwd?: string;
}

const POLL_INTERVAL_MS = 1000;

export async function waitComments(opts: WaitOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutSec = opts.timeout ?? 0;
  const paths = reviewPaths(cwd);
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;

  for (;;) {
    // Unlocked probe: reads always see a consistent snapshot (rename is atomic).
    const hasOpen = loadComments(paths.comments).some((c) => c.status === 'open');
    if (hasOpen) {
      // Re-extract open comments inside the lock so any that appeared between
      // the probe and lock acquisition are included in the received set.
      const received = mutateComments(paths.comments, (comments) => {
        const now = nowIso();
        const open = comments.filter((c) => c.status === 'open');
        for (const c of open) {
          c.status = 'seen';
          c.updatedAt = now;
        }
        return open;
      });
      console.log(JSON.stringify({ status: 'received', comments: received }, null, 2));
      return;
    }
    if (deadline !== null && Date.now() >= deadline) {
      console.log(JSON.stringify({ status: 'timeout', comments: [] }, null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
