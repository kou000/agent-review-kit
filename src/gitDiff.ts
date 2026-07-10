import { execFileSync } from 'child_process';
import { DiffCell, DiffRow, FileDiff } from './types';

function git(args: string[], cwd: string): string {
  // core.quotePath=false: 非ASCIIパス（日本語ファイル名等）をオクタルエスケープ
  // せず素の UTF-8 で出力させる。エスケープされたままだとパス表示が壊れ、
  // working tree からの newLines 埋め込み（コンテキスト展開）も失敗する。
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function runGitDiff(base: string | undefined, cwd: string): string {
  if (base) {
    return git(['diff', '--no-color', '--no-ext-diff', base], cwd);
  }
  try {
    // Working tree vs HEAD: covers both staged and unstaged changes.
    return git(['diff', '--no-color', '--no-ext-diff', 'HEAD'], cwd);
  } catch {
    // Repo without any commit yet: fall back to index diff.
    return git(['diff', '--no-color', '--no-ext-diff'], cwd);
  }
}

// A raw hex sha is the only shape we ever pass to git for a commit lookup. The
// value comes from comments.json (agent-written) and the /commit/<sha> URL, so
// it is validated against this before ever reaching execFile — belt to the
// suspenders of execFile already not going through a shell.
const SHA_RE = /^[0-9a-f]{4,40}$/;

export interface CommitMeta {
  sha: string; // canonical full sha
  shortSha: string;
  subject: string;
  author: string;
  date: string; // ISO
}

// Resolve a (possibly abbreviated) sha to its commit metadata. Throws if the
// value isn't a plausible sha or doesn't name a commit in this repo.
export function getCommitMeta(sha: string, cwd: string): CommitMeta {
  if (!SHA_RE.test(sha)) throw new Error(`invalid commit sha: ${sha}`);
  // %x00 = NUL field separator: subjects can contain anything but NUL.
  const out = git(
    ['show', '-s', '--no-color', '--date=iso', '--format=%H%x00%h%x00%s%x00%an%x00%ad', `${sha}^{commit}`],
    cwd
  );
  const [full, short, subject, author, date] = out.replace(/\n$/, '').split('\0');
  return { sha: full, shortSha: short, subject, author, date };
}

// Commits between base and HEAD (newest first), for the review's commit list
// (GitHub PR "Commits" tab equivalent). An unresolvable base yields [] rather
// than an error: the list is auxiliary and must never break the review page.
export function runGitCommitLog(base: string, cwd: string): CommitMeta[] {
  let out: string;
  try {
    out = git(
      ['log', '--no-color', '--date=iso', '--format=%H%x00%h%x00%s%x00%an%x00%ad', `${base}..HEAD`],
      cwd
    );
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [full, short, subject, author, date] = line.split('\0');
      return { sha: full, shortSha: short, subject, author, date };
    });
}

// Unified diff introduced by a single commit (vs its first parent; a root
// commit shows as all-additions). `--format=` suppresses the commit header so
// only the diff body remains for parseUnifiedDiff.
export function runGitCommitDiff(sha: string, cwd: string): string {
  if (!SHA_RE.test(sha)) throw new Error(`invalid commit sha: ${sha}`);
  return git(
    ['show', '--no-color', '--no-ext-diff', '--first-parent', '--format=', `${sha}^{commit}`],
    cwd
  );
}

// Old-side (pre-image) content of a file, one entry per line, or null when it
// can't be read (added file, binary, or the ref/path doesn't resolve). Used to
// give Shiki full-file language context when highlighting deleted/context lines.
// The old side is `base:path` when a base ref is given, else `HEAD:path`
// (working-tree-vs-HEAD diff), matching what runGitDiff compared against.
export function readOldSideContent(
  oldPath: string,
  base: string | undefined,
  cwd: string
): string[] | null {
  const ref = base ?? 'HEAD';
  try {
    const out = git(['show', `${ref}:${oldPath}`], cwd);
    const lines = out.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  } catch {
    return null;
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
