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

// Run git and return stdout regardless of exit status. `git diff --no-index`
// exits 1 whenever the two inputs differ (its documented "differences found"
// signal, not an error), so the throwing `git()` helper can't be used for it.
function gitAllowDiffExit(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch (err) {
    // execFileSync surfaces the child's stdout on the thrown error; a genuine
    // failure (invalid path, not a repo) yields empty stdout, so returning it
    // is a safe no-op in that case.
    const stdout = (err as { stdout?: Buffer | string }).stdout;
    if (stdout == null) throw err;
    return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
  }
}

// Repository files for the repo-file viewer: tracked (--cached) plus
// untracked-but-not-ignored (--others --exclude-standard), the same boundary
// as runUntrackedDiff — a brand-new file that shows up in the diff must also
// show up in the tree. -z avoids git's path quoting so non-ASCII names come
// through verbatim. The list doubles as the serving allowlist: no traversal,
// no .agent-review internals (self-ignored by generate/publishHtml, so
// --exclude-standard drops them), no ignored secrets like .env.
export function runGitLsFiles(cwd: string): string[] {
  return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd)
    .split('\0')
    .filter((p) => p.length > 0);
}

// Whether cwd sits inside a git work tree. Used to tell a genuine `git grep`
// failure (invalid regex → 400) apart from「そもそも git リポジトリでない」,
// which every repo-file endpoint answers with an empty result instead.
export function isGitRepo(cwd: string): boolean {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

/* ---------- repo-file grep (search box on the /files page) ---------- */

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepOutcome {
  results: GrepMatch[];
  truncated: boolean; // 上限に達して打ち切ったか
}

export interface GrepOptions {
  regex?: boolean; // 既定はリテラル検索 (-F)
  caseSensitive?: boolean; // 既定は大文字小文字を区別しない (-i)
}

// 検索語の長さ上限（リクエストの検証は呼び出し側）。
export const MAX_GREP_QUERY_CHARS = 200;
// 返す結果の総行数上限。git grep の -m はファイル毎なので、全体で切るのは
// こちらの責任。
export const MAX_GREP_RESULTS = 500;
// 1 マッチ行の表示文字数上限（minify 済みの長大な行で応答が膨らむのを防ぐ）。
export const MAX_GREP_LINE_CHARS = 400;

// `git grep` across the repository. Tracked files ONLY (git grep's default),
// deliberately narrower than the repo-file tree/viewer (runGitLsFiles), which
// also lists untracked files: the accepted asymmetry is that search skips
// untracked files. Ignored secrets and .agent-review internals stay out
// either way, and -I keeps binaries out. The query always goes
// in behind `-e`, never as a bare argument, so a value starting with '-' can
// never be taken for an option.
export function runGitGrep(query: string, opts: GrepOptions, cwd: string): GrepOutcome {
  // -z makes each match a `path\0line\0text` record, so a path containing ':'
  // still parses unambiguously (same reason runGitLsFiles uses it).
  const args = ['grep', '-n', '--no-color', '-I', '-z'];
  // -E: git grep の既定は POSIX 基本正規表現(BRE)で ( | + ? がリテラル扱いに
  // なるため、ripgrep や GitHub と同じ拡張正規表現(ERE)を明示する。
  if (opts.regex) args.push('-E');
  else args.push('-F');
  if (!opts.caseSensitive) args.push('-i');
  args.push('-e', query);
  let out: string;
  try {
    out = git(args, cwd);
  } catch (err) {
    // exit 1 は「マッチなし」で、git grep の正常な結果。それ以外（不正な正規
    // 表現なら 128）は stderr を載せて投げ直し、呼び出し側が 400 にする。
    const e = err as { status?: number; stderr?: Buffer | string };
    if (e.status === 1) return { results: [], truncated: false };
    const stderr = e.stderr == null ? '' : e.stderr.toString().trim();
    throw new Error(stderr || String(err));
  }
  const results: GrepMatch[] = [];
  let truncated = false;
  for (const record of out.split('\n')) {
    if (!record) continue;
    if (results.length >= MAX_GREP_RESULTS) {
      truncated = true;
      break;
    }
    const pathEnd = record.indexOf('\0');
    const lineEnd = record.indexOf('\0', pathEnd + 1);
    if (pathEnd < 0 || lineEnd < 0) continue;
    const line = parseInt(record.slice(pathEnd + 1, lineEnd), 10);
    if (!Number.isFinite(line)) continue;
    results.push({
      path: record.slice(0, pathEnd),
      line,
      text: record.slice(lineEnd + 1).slice(0, MAX_GREP_LINE_CHARS),
    });
  }
  return { results, truncated };
}

// Synthesize an "added file" diff for every untracked (but not ignored) file, so
// brand-new files/directories that haven't been `git add`-ed yet still show up in
// the review. Ignored files are excluded via --exclude-standard (honors
// .gitignore). Each file is diffed against /dev/null, producing exactly the
// `diff --git … / new file mode …` shape parseUnifiedDiff already handles for
// added files — binary untracked files come through as "Binary files … differ",
// matching how tracked binaries are rendered.
function runUntrackedDiff(cwd: string): string {
  let listed: string;
  try {
    listed = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  } catch {
    return '';
  }
  const files = listed.split('\0').filter((p) => p.length > 0);
  let out = '';
  for (const file of files) {
    out += gitAllowDiffExit(
      ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file],
      cwd
    );
  }
  return out;
}

export function runGitDiff(base: string | undefined, cwd: string): string {
  let tracked: string;
  if (base) {
    tracked = git(['diff', '--no-color', '--no-ext-diff', base], cwd);
  } else {
    try {
      // Working tree vs HEAD: covers both staged and unstaged changes.
      tracked = git(['diff', '--no-color', '--no-ext-diff', 'HEAD'], cwd);
    } catch {
      // Repo without any commit yet: fall back to index diff.
      tracked = git(['diff', '--no-color', '--no-ext-diff'], cwd);
    }
  }
  // Untracked files are absent from every `git diff` variant above regardless of
  // --base (the base only moves the old side; untracked files have no old side
  // in either the index or any commit), so append them unconditionally.
  const untracked = runUntrackedDiff(cwd);
  if (!untracked) return tracked;
  return tracked && !tracked.endsWith('\n') ? `${tracked}\n${untracked}` : tracked + untracked;
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

// Files larger than this get no expansion content, keeping the page bounded
// (same cap as generate's working-tree embedding).
const MAX_EMBED_BYTES = 1024 * 1024;

// Embed each file's full new-side content from a git tree-ish (commit sha or
// tree object sha) so the standalone diff pages (/commit, /snapshot) can expand
// context around hunks like the main review page does from the working tree.
export function embedNewSideFromTree(files: FileDiff[], treeish: string, cwd: string): void {
  if (!SHA_RE.test(treeish)) return;
  for (const f of files) {
    if (f.status === 'deleted' || f.status === 'binary') continue;
    try {
      const size = parseInt(git(['cat-file', '-s', `${treeish}:${f.path}`], cwd).trim(), 10);
      if (!Number.isFinite(size) || size > MAX_EMBED_BYTES) continue;
      const lines = git(['show', `${treeish}:${f.path}`], cwd).split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      f.newLines = lines;
    } catch {
      // Path missing from the tree (e.g. hand-edited patch): skip expansion.
    }
  }
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
