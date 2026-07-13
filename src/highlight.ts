import type { createHighlighter, Highlighter, ThemedToken } from 'shiki';
import { FileDiff } from './types';

// Shiki 3.x is ESM-only (no CommonJS entry). With module:commonjs, TypeScript
// downlevels a plain `import('shiki')` to `require('shiki')`, which throws
// ERR_REQUIRE_ESM on Node <22. This indirection keeps a real native dynamic
// import() in the emitted JS, so it works on Node 18+ regardless of the CJS
// output. Typed via the imported createHighlighter signature.
const importShiki = new Function(
  'return import("shiki")'
) as () => Promise<{ createHighlighter: typeof createHighlighter }>;

// SSR syntax highlighting with Shiki (github-dark), baked into the diff data at
// generate time. Nothing Shiki-related ships to the browser: we emit per-line
// HTML (spans with inline color/font-style) straight into each diff cell, so the
// generated review.html is self-contained (no CDN, no runtime highlighter) and
// renders VS Code-quality colors even when opened as a bare file.

// The theme we bake. Kept in sync with the client CSS background/foreground.
export const THEME = 'github-dark';

// File extension -> Shiki language id. Extensions not listed fall back to plain
// escaped text (no highlighting), matching the previous highlight.js behavior of
// never throwing on unknown languages. .vue uses Shiki's 'vue' grammar so that
// <script lang="ts"> is tokenized as TypeScript (not delegated to plain XML).
const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  rs: 'rust',
  py: 'python',
};

// Every language we may need to load. Passed to createHighlighter up front so
// tokenization is synchronous per file afterward.
const ALL_LANGS = Array.from(new Set(Object.values(LANG_MAP)));

export function langForPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p));
  if (!m) return null;
  return LANG_MAP[m[1].toLowerCase()] ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Shiki FontStyle bitmask (from @shikijs/vscode-textmate): 1 italic, 2 bold,
// 4 underline. -1 = "not set".
function styleAttr(token: ThemedToken): string {
  const parts: string[] = [];
  if (token.color) parts.push(`color:${token.color}`);
  const fs = token.fontStyle ?? 0;
  if (fs > 0) {
    if (fs & 1) parts.push('font-style:italic');
    if (fs & 2) parts.push('font-weight:bold');
    if (fs & 4) parts.push('text-decoration:underline');
  }
  return parts.join(';');
}

function lineHtml(tokens: ThemedToken[]): string {
  let out = '';
  for (const t of tokens) {
    const style = styleAttr(t);
    const content = escapeHtml(t.content);
    out += style ? `<span style="${style}">${content}</span>` : content;
  }
  return out;
}

// Highlight a full file's content and return per-line inner HTML (index 0 =
// line 1). Returns null when the language is unknown or Shiki throws, so callers
// fall back to escaped plain text.
function highlightLines(
  hl: Highlighter,
  content: string[],
  lang: string
): string[] | null {
  try {
    const code = content.join('\n');
    const tokenLines = hl.codeToTokensBase(code, {
      lang: lang as never,
      theme: THEME,
    });
    return tokenLines.map(lineHtml);
  } catch {
    return null;
  }
}

// Highlight a single isolated line (fallback when full-file content is missing,
// e.g. old side of a file we can't read from git). Loses cross-line context but
// still colors most tokens correctly.
function highlightSingle(
  hl: Highlighter,
  text: string,
  lang: string
): string | null {
  const res = highlightLines(hl, [text], lang);
  return res && res.length ? res[0] : null;
}

export interface HighlightSources {
  // Full old-side content per file path (b-side path key), when readable.
  oldByPath: Map<string, string[] | null>;
}

// Bake per-line highlighted HTML into every diff cell of every file, in place.
// `newLines` (already embedded on the file) supplies new-side context; `sources`
// supplies old-side context. Cells whose line number is within the full content
// use the full-file-context line; otherwise they fall back to single-line
// highlighting so nothing is left unstyled.
export async function bakeHighlight(
  files: FileDiff[],
  sources: HighlightSources
): Promise<void> {
  // Only pull in Shiki when there is at least one highlightable file, keeping
  // the no-highlightable-diff path free of the (heavier) highlighter init.
  const needed = files.some((f) => langForPath(f.path));
  if (!needed) return;

  const { createHighlighter } = await importShiki();
  const hl = await createHighlighter({ themes: [THEME], langs: ALL_LANGS });

  try {
    for (const f of files) {
      const lang = langForPath(f.path);
      if (!lang) continue;

      const newLines = f.newLines ?? null;
      const oldLines = sources.oldByPath.get(f.path) ?? null;
      const newHl = newLines ? highlightLines(hl, newLines, lang) : null;
      const oldHl = oldLines ? highlightLines(hl, oldLines, lang) : null;

      // Parallel highlighted array for context expansion (GitHub-style). Only
      // when every line highlighted, so indices stay aligned with newLines.
      if (newHl && newLines && newHl.length === newLines.length) {
        f.newLinesHtml = newHl;
      }

      for (const hunk of f.hunks) {
        for (const row of hunk.rows) {
          if (row.left) {
            const idx = row.left.line - 1;
            let html: string | null = null;
            if (oldHl && idx >= 0 && idx < oldHl.length) html = oldHl[idx];
            if (html === null) html = highlightSingle(hl, row.left.text, lang);
            if (html !== null) row.left.html = html;
          }
          if (row.right) {
            const idx = row.right.line - 1;
            let html: string | null = null;
            if (newHl && idx >= 0 && idx < newHl.length) html = newHl[idx];
            if (html === null) html = highlightSingle(hl, row.right.text, lang);
            if (html !== null) row.right.html = html;
          }
        }
      }
    }
  } finally {
    hl.dispose();
  }
}

// Bake highlighting for a standalone diff page (/commit, /snapshot) whose files
// come straight from a patch and carry no embedded full-file content. Without
// old/new sources every cell falls back to single-line highlighting, so these
// pages get the same Shiki (github-dark) coloring as the main review page
// (minus cross-line context, which they don't render anyway — no expansion).
export async function bakeDiffHighlight(files: FileDiff[]): Promise<void> {
  await bakeHighlight(files, { oldByPath: new Map() });
}
