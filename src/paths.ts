import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ReviewPaths {
  // Repo-level: one per repository.
  dir: string;
  html: string;
  serverJson: string;
  // Optional per-user env file overriding DEFAULT_SETTINGS (see envDefaults.ts).
  // Global (~/.agent-review/.env), not per-repo: it holds the person's
  // preferred defaults, which every review in every repository starts from.
  envFile: string;
  // Compiled client ES modules (app.js + the modules it imports), copied here
  // by writeAssets and served under /client/*.
  clientDir: string;
  styleCss: string;
  // Review data is scoped per git branch (branches/<slug>/...), so comments,
  // snapshots and settings from one review never leak into another branch's
  // review. `branch` is the raw name for display.
  branch: string;
  branchDir: string;
  comments: string;
  viewed: string;
  state: string;
  settings: string;
  finished: string;
  snapshotsDir: string;
  snapshotsIndex: string;
  documentsDir: string;
  documentsIndex: string;
  // Comment attachment images (user-pasted), one file per image id.
  imagesDir: string;
}

// Raw current-branch name. Detached HEAD falls back to the short sha (each
// detached checkout is its own review scope); outside a git repo everything
// lands in a single 'no-git' scope.
function currentBranch(cwd: string): string {
  try {
    // symbolic-ref works on an unborn branch too (fresh `git init`).
    const name = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (name) return name;
  } catch {
    // Detached HEAD or not a repo; try the sha next.
  }
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    return `detached-${sha}`;
  } catch {
    return 'no-git';
  }
}

// Branch names become directory names: keep it filesystem-safe (slashes in
// feature/xxx would otherwise nest) while staying readable.
function branchSlug(branch: string): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120);
  return slug || 'no-branch';
}

// One-time migration from the flat pre-branch layout: data files that used to
// live directly under .agent-review/ move into the current branch's dir, so an
// in-flight review keeps its comments across the upgrade.
const LEGACY_FILES = ['comments.json', 'state.json', 'settings.json', 'finished.json'];

function migrateLegacyLayout(dir: string, branchDir: string): void {
  if (!fs.existsSync(path.join(dir, 'comments.json')) || fs.existsSync(branchDir)) return;
  fs.mkdirSync(branchDir, { recursive: true });
  for (const name of LEGACY_FILES.concat('snapshots')) {
    try {
      fs.renameSync(path.join(dir, name), path.join(branchDir, name));
    } catch {
      // Missing file (or concurrent migration winner): nothing to move.
    }
  }
}

export function reviewPaths(cwd: string = process.cwd()): ReviewPaths {
  const dir = path.join(cwd, '.agent-review');
  const branch = currentBranch(cwd);
  const branchDir = path.join(dir, 'branches', branchSlug(branch));
  // Only prepare per-branch storage when a review already exists here —
  // running `status` in an unrelated directory must not scatter empty
  // .agent-review dirs around.
  if (fs.existsSync(dir)) {
    migrateLegacyLayout(dir, branchDir);
    fs.mkdirSync(branchDir, { recursive: true });
  }
  const snapshotsDir = path.join(branchDir, 'snapshots');
  const documentsDir = path.join(branchDir, 'documents');
  return {
    dir,
    html: path.join(dir, 'review.html'),
    serverJson: path.join(dir, 'server.json'),
    envFile: path.join(os.homedir(), '.agent-review', '.env'),
    clientDir: path.join(dir, 'client'),
    styleCss: path.join(dir, 'style.css'),
    branch,
    branchDir,
    comments: path.join(branchDir, 'comments.json'),
    viewed: path.join(branchDir, 'viewed.json'),
    state: path.join(branchDir, 'state.json'),
    settings: path.join(branchDir, 'settings.json'),
    finished: path.join(branchDir, 'finished.json'),
    snapshotsDir,
    snapshotsIndex: path.join(snapshotsDir, 'index.json'),
    documentsDir,
    documentsIndex: path.join(documentsDir, 'index.json'),
    imagesDir: path.join(branchDir, 'images'),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function clientAssetDir(): string {
  // Compiled layout: dist/paths.js sits next to dist/client/. Under tsx the
  // sources in src/client are TypeScript (nothing servable), so fall back to
  // the built assets — `npm run build:client` must have run first.
  const sibling = path.join(__dirname, 'client');
  if (fs.existsSync(path.join(sibling, 'app.js'))) return sibling;
  return path.join(__dirname, '..', 'dist', 'client');
}
