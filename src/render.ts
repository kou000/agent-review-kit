import * as fs from 'fs';
import * as path from 'path';
import { CommitMeta } from './gitDiff';
import { clientAssetDir, ReviewPaths } from './paths';
import { DiffData } from './types';

function escapeForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderHtml(data: DiffData): string {
  const payload = escapeForScript(JSON.stringify(data));
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-review-kit</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
<script>window.__DIFF__ = ${payload};</script>
<header id="topbar">
  <div class="topbar-inner">
    <span class="brand">agent-review-kit</span>
    <span id="diff-meta"></span>
    <span id="unresolved-badge" class="badge">-</span>
    <span id="conn-state" class="conn"></span>
  </div>
</header>
<main id="app"></main>
<script src="./app.js"></script>
</body>
</html>
`;
}

// Standalone page for a single commit's diff, opened in a new tab from a
// commit link in an agent response. Reuses the same client bundle (app.js
// switches to a read-only commit view when window.__COMMIT__ is set) and the
// same styles. Asset URLs are absolute because this page is served at
// /commit/<sha>, not at the site root like review.html.
export function renderCommitHtml(data: DiffData, meta: CommitMeta): string {
  const payload = escapeForScript(JSON.stringify(data));
  const commitPayload = escapeForScript(JSON.stringify(meta));
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.shortSha)} — ${escapeHtml(meta.subject)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<script>window.__DIFF__ = ${payload};</script>
<script>window.__COMMIT__ = ${commitPayload};</script>
<header id="topbar">
  <div class="topbar-inner">
    <span class="brand">agent-review-kit</span>
    <span id="diff-meta"></span>
    <span id="unresolved-badge" class="badge" hidden>-</span>
    <span id="conn-state" class="conn"></span>
  </div>
</header>
<main id="app"></main>
<script src="/app.js"></script>
</body>
</html>
`;
}

export function writeAssets(paths: ReviewPaths): void {
  const assetDir = clientAssetDir();
  fs.copyFileSync(path.join(assetDir, 'app.js'), paths.appJs);
  fs.copyFileSync(path.join(assetDir, 'style.css'), paths.styleCss);
}
