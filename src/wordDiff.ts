// Intra-line (word-level) diff for a paired deleted/added line, GitHub-style:
// tokenize both sides, take the LCS of the token sequences, and report the
// characters outside it as changed ranges. Used at generate time to emphasize
// what actually changed inside a modified line (see bakeWordDiff).

export interface WordToken {
  text: string;
  start: number;
  end: number;
}

// [start, end) in UTF-16 offsets of the original line text.
export type CharRange = [number, number];

export interface WordDiffRanges {
  left: CharRange[];
  right: CharRange[];
}

// Above this many tokens on either side the O(n*m) LCS is skipped.
export const MAX_TOKENS = 500;
// More than this share of a side's non-whitespace chars changed = the line was
// rewritten, so nothing is emphasized (GitHub does the same).
const MAX_CHANGED_RATIO = 0.8;

// Runs of [A-Za-z0-9_] and runs of whitespace are one token each. Everything
// else is one token per code point: punctuation, symbols, and CJK (Hiragana,
// Katakana incl. ー, ideographs, fullwidth forms), which has no word breaks.
const TOKEN_RE = /[A-Za-z0-9_]+|\s+|[\s\S]/gu;

export function tokenize(text: string): WordToken[] {
  const out: WordToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    out.push({ text: m[0], start, end: start + m[0].length });
  }
  return out;
}

const isSpace = (t: WordToken): boolean => /^\s+$/.test(t.text);

// Mark the tokens of each side that are NOT part of the LCS.
function changedFlags(a: WordToken[], b: WordToken[]): [boolean[], boolean[]] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // dp[i*w+j] = LCS length of a[i..] and b[j..].
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i].text === b[j].text
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ca = new Array<boolean>(n).fill(true);
  const cb = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      ca[i++] = false;
      cb[j++] = false;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return [ca, cb];
}

// Changed tokens -> char ranges. Consecutive changed tokens merge, and so do
// two changed tokens separated by a single whitespace token. Returns null when
// the changed share exceeds MAX_CHANGED_RATIO.
function toRanges(text: string, tokens: WordToken[], changed: boolean[]): CharRange[] | null {
  const ranges: CharRange[] = [];
  let changedChars = 0;
  let last = -1;
  tokens.forEach((t, k) => {
    if (!changed[k]) return;
    if (!isSpace(t)) changedChars += t.text.length;
    const joins = ranges.length > 0 && (k === last + 1 || (k === last + 2 && isSpace(tokens[k - 1])));
    if (joins) ranges[ranges.length - 1][1] = t.end;
    else ranges.push([t.start, t.end]);
    last = k;
  });
  const total = text.replace(/\s/g, '').length;
  return changedChars > total * MAX_CHANGED_RATIO ? null : ranges;
}

export function wordDiff(oldText: string, newText: string): WordDiffRanges | null {
  if (oldText === newText || !oldText.trim() || !newText.trim()) return null;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  const [ca, cb] = changedFlags(a, b);
  const left = toRanges(oldText, a, ca);
  const right = toRanges(newText, b, cb);
  if (!left || !right) return null;
  return { left, right };
}
