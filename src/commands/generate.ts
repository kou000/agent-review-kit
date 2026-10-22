import * as fs from 'fs';
import * as path from 'path';
import { parseUnifiedDiff, readOldSideContent, runGitDiff } from '../gitDiff';
import { bakeHighlight, HighlightSources } from '../highlight';
import { ensureDir, reviewPaths } from '../paths';
import { renderHtml, writeAssets } from '../render';
import { clearFinished, loadState, nowIso, saveComments, saveState } from '../store';
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
  // Routine refreshes inside an active review must not erase a finish signal
  // that may have arrived concurrently from the browser.
  preserveFinished?: boolean;
  cwd?: string;
  // Suppress the JSON status line on stdout. Set by server-internal
  // regenerations (POST /api/edit), whose stdout belongs to `serve`.
  quiet?: boolean;
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
  ensureDir(paths.branchDir);
  // Self-ignoring directory: keep review artifacts out of the project's git diff.
  fs.writeFileSync(path.join(paths.dir, '.gitignore'), '*\n');
  // The initial generate starts a new review. Routine refreshes in the skill
  // opt out so a concurrent browser finish cannot be erased before the waiter
  // observes it.
  if (!opts.preserveFinished) clearFinished(paths.finished);

  // --base 省略時は前回 generate の base を引き継ぐ（修正コミット後の再生成で
  // ブランチ全体レビューが working-tree-only に化けてコメントが orphan 化する
  // のを防ぐ）。working tree vs HEAD に戻すには --base HEAD を指定する。
  const prev = loadState(paths.state);
  const base = opts.base ?? prev?.base ?? undefined;

  const diffText = runGitDiff(base, cwd);
  const files = parseUnifiedDiff(diffText);
  embedNewSideContent(files, cwd);

  // 「空白の変更を無視」トグル用の差分（git diff -w）。新側の内容は同じ
  // working tree なので files のものを共有し、ハイライトの文脈に使う。
  const wsFiles = parseUnifiedDiff(runGitDiff(base, cwd, { ignoreWhitespace: true }));
  const newLinesByPath = new Map(files.map((f) => [f.path, f.newLines]));
  for (const f of wsFiles) {
    const lines = newLinesByPath.get(f.path);
    if (lines) f.newLines = lines;
  }

  // SSR syntax highlighting: bake per-line Shiki HTML into each diff cell so the
  // client renders pre-colored markup (no runtime highlighter, self-contained).
  // 旧側の内容も files と同じ配列を使い回す（ハイライトは配列ごとに 1 回）。
  const oldSources = collectOldSources(files, base, cwd);
  const wsOnlySources = collectOldSources(
    wsFiles.filter((f) => !oldSources.oldByPath.has(f.path)),
    base,
    cwd
  );
  for (const [p, lines] of wsOnlySources.oldByPath) oldSources.oldByPath.set(p, lines);
  await bakeHighlight([...files, ...wsFiles], oldSources);
  // newLines / newLinesHtml は files 側にだけ載せる（ブラウザが引き継ぐ。
  // DiffData.ignoreWhitespaceFiles 参照）。
  for (const f of wsFiles) {
    delete f.newLines;
    delete f.newLinesHtml;
  }

  const data: DiffData = {
    base: base ?? null,
    generatedAt: nowIso(),
    files,
    ignoreWhitespaceFiles: wsFiles,
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

  if (opts.quiet) return;
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
