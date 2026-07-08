import * as fs from 'fs';
import * as path from 'path';
import { parseUnifiedDiff, runGitDiff } from '../gitDiff';
import { ensureDir, reviewPaths } from '../paths';
import { renderHtml, writeAssets } from '../render';
import { loadState, nowIso, saveComments, saveState } from '../store';
import { DiffData } from '../types';

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
