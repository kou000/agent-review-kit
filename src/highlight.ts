import type { createHighlighter, Highlighter, ThemedToken } from 'shiki';
import { CommentFences, FenceToken, FileDiff } from './types';

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
  tf: 'terraform',
  tfvars: 'terraform',
  toml: 'toml',
  sql: 'sql',
  java: 'java',
  xml: 'xml',
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

// Highlighter cached for the life of the process, used by the per-request
// repo-file viewer (GET /api/file, GET /file/<path>). generate-time baking
// keeps its own short-lived instance (bakeHighlight below); serve would pay
// the full Shiki init on every file open without this cache.
let fileHlPromise: Promise<Highlighter> | null = null;

function fileHighlighter(): Promise<Highlighter> {
  if (!fileHlPromise) {
    fileHlPromise = importShiki().then(({ createHighlighter }) =>
      createHighlighter({ themes: [THEME], langs: ALL_LANGS })
    );
  }
  return fileHlPromise;
}

// Highlight a full standalone file for the repo-file viewer. Returns per-line
// inner HTML (index 0 = line 1), or null when the language is unknown or
// Shiki fails — callers fall back to escaped plain text.
export async function highlightFile(
  filePath: string,
  lines: string[]
): Promise<string[] | null> {
  const lang = langForPath(filePath);
  if (!lang) return null;
  const hl = await fileHighlighter();
  const out = highlightLines(hl, lines, lang);
  return out && out.length === lines.length ? out : null;
}

// Resolve a fence info string (the "ts" of ```ts) to a Shiki language id.
// The first word is looked up in LANG_MAP, so file extensions work the way
// people write them (```ts, ```py); a word that already is a loaded language
// id (```typescript, ```bash) is accepted as-is. Anything else — including a
// bare ``` — returns null and the fence stays plain.
export function langForFenceInfo(info: string): string | null {
  const word = String(info ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (!word) return null;
  return LANG_MAP[word] ?? (ALL_LANGS.includes(word) ? word : null);
}

// One ``` fence of a comment body: the info string of its opening line (the
// "ts" of ```ts, possibly empty) and the code between the markers.
export interface CommentFence {
  info: string;
  code: string;
}

// Extract the ``` fences from a comment body with exactly the rules the
// client's liftFences (client/markdown.ts) uses to find them — NUL strip and
// newline normalization first, /^\s*```/ opens and closes, an unclosed fence
// runs to the end of the text — so fence i here is fence i there.
export function extractCommentFences(body: string): CommentFence[] {
  const lines = String(body ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const fences: CommentFence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*```(.*)$/.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    i++;
    const code: string[] = [];
    while (i < lines.length && !/^\s*```/.test(lines[i])) {
      code.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++;
    fences.push({ info: open[1], code: code.join('\n') });
  }
  return fences;
}

function fenceToken(token: ThemedToken): FenceToken {
  const s = styleAttr(token);
  return s ? { t: token.content, s } : { t: token.content };
}

// Tokenize every ``` fence of a comment body for client-side rendering (see
// CommentFences in types.ts). Returns null when no fence could be highlighted
// — callers then leave the field off the stored comment entirely — and skips
// the Shiki import in that case, so a fence-less body posted from a
// short-lived CLI process (add-comment, resolve-comment) stays as cheap as
// before, same policy as bakeHighlight.
export async function highlightFences(body: string): Promise<CommentFences | null> {
  const fences = extractCommentFences(body);
  const langs = fences.map((f) => langForFenceInfo(f.info));
  if (!langs.some((lang) => lang !== null)) return null;
  const hl = await fileHighlighter();
  const out: CommentFences = fences.map((f, i) => {
    const lang = langs[i];
    if (!lang) return null;
    try {
      const tokenLines = hl.codeToTokensBase(f.code, {
        lang: lang as never,
        theme: THEME,
      });
      return { lines: tokenLines.map((line) => line.map(fenceToken)) };
    } catch {
      return null;
    }
  });
  return out.some((f) => f !== null) ? out : null;
}

/**
 * Tokenize a comment's code snapshot (see CommentCodeSnapshot) for
 * client-side rendering, the same way highlightFences does for a comment's
 * ``` fences. `lines` is the whole block — context before, the commented
 * lines, context after — tokenized in one pass so constructs that span the
 * boundary (template literals, block comments) stay coloured correctly, and
 * the result is parallel to that concatenation. Returns null when the file's
 * language is unknown, Shiki throws, or the token lines don't line up with
 * the input; callers then leave the field off and the browser renders escaped
 * plain text.
 */
export async function highlightSnapshot(
  filePath: string,
  lines: string[]
): Promise<FenceToken[][] | null> {
  const lang = langForPath(filePath);
  if (!lang) return null;
  const hl = await fileHighlighter();
  try {
    const tokenLines = hl.codeToTokensBase(lines.join('\n'), {
      lang: lang as never,
      theme: THEME,
    });
    if (tokenLines.length !== lines.length) return null;
    return tokenLines.map((line) => line.map(fenceToken));
  } catch {
    return null;
  }
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
// come straight from a patch. New-side context comes from `newLines` when the
// route embedded it (embedNewSideFromTree — also feeds context expansion);
// there is no old-side source, so old-side cells use single-line highlighting.
// Either way these pages get the same Shiki (github-dark) coloring as the main
// review page.
export async function bakeDiffHighlight(files: FileDiff[]): Promise<void> {
  await bakeHighlight(files, { oldByPath: new Map() });
}
