import * as fs from 'fs';
import * as path from 'path';
import { parseUnifiedDiff, runGitDiff } from '../gitDiff';
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

export function generate(opts: GenerateOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const paths = reviewPaths(cwd);
  ensureDir(paths.dir);
  // Self-ignoring directory: keep review artifacts out of the project's git diff.
  fs.writeFileSync(path.join(paths.dir, '.gitignore'), '*\n');

  const diffText = runGitDiff(opts.base, cwd);
  const files = parseUnifiedDiff(diffText);
  embedNewSideContent(files, cwd);

  const data: DiffData = {
    base: opts.base ?? null,
    generatedAt: nowIso(),
    files,
  };

  fs.writeFileSync(paths.html, renderHtml(data));
  writeAssets(paths);

  // Preserve existing comments across regenerations; only initialize when absent.
  if (!fs.existsSync(paths.comments)) {
    saveComments(paths.comments, []);
  }

  const prev = loadState(paths.state);
  saveState(paths.state, {
    base: opts.base ?? prev?.base ?? null,
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
