import { execFileSync } from 'child_process';
import { DiffCell, DiffRow, FileDiff } from './types';

export function runGitDiff(base: string | undefined, cwd: string): string {
  const run = (args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  if (base) {
    return run(['diff', '--no-color', '--no-ext-diff', base]);
  }
  try {
    // Working tree vs HEAD: covers both staged and unstaged changes.
    return run(['diff', '--no-color', '--no-ext-diff', 'HEAD']);
  } catch {
    // Repo without any commit yet: fall back to index diff.
    return run(['diff', '--no-color', '--no-ext-diff']);
  }
}

interface RawHunkLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  diffLine: number;
}

export function parseUnifiedDiff(diffText: string): FileDiff[] {
  const lines = diffText.split('\n');
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let i = 0;

  const gitHeader = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/;
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    const m = gitHeader.exec(line);
    if (m) {
      current = {
        oldPath: m[1],
        path: m[2],
        status: 'modified',
        hunks: [],
      };
      files.push(current);
      i++;
      continue;
    }
    if (current) {
      if (line.startsWith('new file mode')) current.status = 'added';
      else if (line.startsWith('deleted file mode')) current.status = 'deleted';
      else if (line.startsWith('rename from')) current.status = 'renamed';
      else if (line.startsWith('Binary files') || line === 'GIT binary patch')
        current.status = 'binary';
    }
    const h = hunkHeader.exec(line);
    if (h && current) {
      const hunkStartDiffLine = i + 1;
      let oldLine = parseInt(h[1], 10);
      let newLine = parseInt(h[3], 10);
      const rawLines: RawHunkLine[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (
          l.startsWith('diff --git ') ||
          hunkHeader.test(l) ||
          (l === '' && i === lines.length - 1)
        ) {
          break;
        }
        const c = l[0];
        const diffLine = i + 1;
        if (c === ' ' || l === '') {
          rawLines.push({
            kind: 'context',
            oldLine,
            newLine,
            text: l.slice(1),
            diffLine,
          });
          oldLine++;
          newLine++;
        } else if (c === '-') {
          rawLines.push({
            kind: 'del',
            oldLine,
            newLine: null,
            text: l.slice(1),
            diffLine,
          });
          oldLine++;
        } else if (c === '+') {
          rawLines.push({
            kind: 'add',
            oldLine: null,
            newLine,
            text: l.slice(1),
            diffLine,
          });
          newLine++;
        } else if (c === '\\') {
          // "\ No newline at end of file" — skip.
        } else {
          break;
        }
        i++;
      }
      current.hunks.push({
        header: lines[hunkStartDiffLine - 1],
        rows: buildRows(rawLines),
      });
      continue;
    }
    i++;
  }
  return files;
}

function cell(l: RawHunkLine, side: 'old' | 'new'): DiffCell {
  return {
    line: (side === 'old' ? l.oldLine : l.newLine) as number,
    text: l.text,
    diffLine: l.diffLine,
    kind: l.kind,
  };
}

function buildRows(rawLines: RawHunkLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let dels: RawHunkLine[] = [];
  let adds: RawHunkLine[] = [];

  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      rows.push({
        left: k < dels.length ? cell(dels[k], 'old') : null,
        right: k < adds.length ? cell(adds[k], 'new') : null,
      });
    }
    dels = [];
    adds = [];
  };

  for (const l of rawLines) {
    if (l.kind === 'del') {
      dels.push(l);
    } else if (l.kind === 'add') {
      adds.push(l);
    } else {
      flush();
      rows.push({ left: cell(l, 'old'), right: cell(l, 'new') });
    }
  }
  flush();
  return rows;
}
