import * as fs from 'fs';
import * as path from 'path';
import { parseUnifiedDiff, readOldSideContent, runGitDiff } from '../gitDiff';
import { bakeHighlight, HighlightSources } from '../highlight';
import { ensureDir, reviewPaths } from '../paths';
import { renderHtml, writeAssets } from '../render';
import { loadState, nowIso, saveComments, saveState } from '../store';
import { DiffData, FileDiff } from '../types';

// Files larger than this are embedded without expansion content, keeping the
// generated HTML bounded.
const MAX_EMBED_BYTES = 1024 * 1024;

// Embed each file's full new-side (working tree) content so the review UI can
// expand context around hunks, GitHub-style. The new side of the diff is the
// working tree both with and without --base, so reading from disk here always
// matches the diff being rendered.
function embedNewSideContent(files: FileDiff[], cwd: string): void {
  for (const f of files) {
    if (f.status === 'deleted' || f.status === 'binary') continue;
    try {
      const p = path.join(cwd, f.path);
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size > MAX_EMBED_BYTES) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      f.newLines = lines;
    } catch {
      // Unreadable (e.g. removed from the working tree after the diff ran):
      // just skip expansion for this file.
    }
  }
}

export interface GenerateOptions {
  base?: string;
  cwd?: string;
}

// Read the old-side (pre-image) content of every file so Shiki can highlight
// deleted/context lines with full-file language context. Added/binary files have
// no readable old side and map to null (single-line highlighting is used there).
function collectOldSources(
  files: FileDiff[],
  base: string | undefined,
  cwd: string
): HighlightSources {
  const oldByPath = new Map<string, string[] | null>();
  for (const f of files) {
    if (f.status === 'added' || f.status === 'binary') {
      oldByPath.set(f.path, null);
      continue;
    }
    oldByPath.set(f.path, readOldSideContent(f.oldPath, base, cwd));
  }
  return { oldByPath };
}

export async function generate(opts: GenerateOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = reviewPaths(cwd);
  ensureDir(paths.dir);
  // Self-ignoring directory: keep review artifacts out of the project's git diff.
  fs.writeFileSync(path.join(paths.dir, '.gitignore'), '*\n');

  // --base 省略時は前回 generate の base を引き継ぐ（修正コミット後の再生成で
  // ブランチ全体レビューが working-tree-only に化けてコメントが orphan 化する
  // のを防ぐ）。working tree vs HEAD に戻すには --base HEAD を指定する。
  const prev = loadState(paths.state);
  const base = opts.base ?? prev?.base ?? undefined;

  const diffText = runGitDiff(base, cwd);
  const files = parseUnifiedDiff(diffText);
  embedNewSideContent(files, cwd);

  // SSR syntax highlighting: bake per-line Shiki HTML into each diff cell so the
  // client renders pre-colored markup (no runtime highlighter, self-contained).
  const oldSources = collectOldSources(files, base, cwd);
  await bakeHighlight(files, oldSources);

  const data: DiffData = {
    base: base ?? null,
    generatedAt: nowIso(),
    files,
  };

  fs.writeFileSync(paths.html, renderHtml(data));
  writeAssets(paths);

  // Preserve existing comments across regenerations; only initialize when absent.
  if (!fs.existsSync(paths.comments)) {
    saveComments(paths.comments, []);
  }

  saveState(paths.state, {
    base: data.base,
    generatedAt: data.generatedAt,
  });

  console.log(
    JSON.stringify(
      {
        status: 'generated',
        html: paths.html,
        files: files.length,
        base: data.base,
        generatedAt: data.generatedAt,
      },
      null,
      2
    )
  );
}
