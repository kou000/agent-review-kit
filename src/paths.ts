import * as fs from 'fs';
import * as path from 'path';

export interface ReviewPaths {
  dir: string;
  html: string;
  comments: string;
  state: string;
  appJs: string;
  styleCss: string;
  hljsJs: string;
  hljsCss: string;
}

export function reviewPaths(cwd: string = process.cwd()): ReviewPaths {
  const dir = path.join(cwd, '.agent-review');
  return {
    dir,
    html: path.join(dir, 'review.html'),
    comments: path.join(dir, 'comments.json'),
    state: path.join(dir, 'state.json'),
    appJs: path.join(dir, 'app.js'),
    styleCss: path.join(dir, 'style.css'),
    hljsJs: path.join(dir, 'highlight.min.js'),
    hljsCss: path.join(dir, 'hljs-theme.css'),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function clientAssetDir(): string {
  return path.join(__dirname, 'client');
}
