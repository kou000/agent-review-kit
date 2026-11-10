import { reviewPaths } from '../paths';
import { mutateSettings } from '../store';

export interface SetSettingsOptions {
  readOnly?: boolean;
  prPendingComment?: boolean;
  cwd?: string;
}

// Turn settings on for the current branch (saved to its settings.json, which
// a running serve re-reads on every request). There is deliberately no way to
// turn anything off here: switching read-only mode off stays a browser-only
// action (the gear menu), so an agent cannot loosen it from the CLI.
export function setSettings(opts: SetSettingsOptions): void {
  if (!opts.readOnly && !opts.prPendingComment) {
    console.error('error: --read-only か --pr-pending-comment を 1 つ以上指定してください');
    process.exit(1);
  }
  const paths = reviewPaths(opts.cwd ?? process.cwd());
  const settings = mutateSettings(
    paths.settings,
    (s) => {
      if (opts.readOnly) s.readOnlyMode = true;
      if (opts.prPendingComment) s.prPendingCommentEnabled = true;
    },
    paths.envFile
  );
  console.log(JSON.stringify({ status: 'set', branch: paths.branch, settings }, null, 2));
}
