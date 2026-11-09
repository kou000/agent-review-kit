import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SETTINGS, ReviewSettings } from './types';

// Same cap as MAX_TARGET_FIELD on the PUT /api/settings path, so a huge env
// value can't balloon the note delivered with every wait-comments batch.
const MAX_TEXT = 2000;

// Minimal dotenv-style parser: KEY=VALUE lines, `#` comment lines, optional
// `export ` prefix, optional matching single/double quotes around the value.
// Inside double quotes `\n` becomes a newline (multi-line deliveryNoteText);
// unquoted values have a trailing ` # comment` stripped. No interpolation.
export function parseEnvFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

// A typo'd value ("ture") returns undefined so it falls through to the code
// default instead of silently meaning false.
function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/**
 * Per-user default settings: DEFAULT_SETTINGS overridden by any valid ARK_*
 * entries in ~/.agent-review/.env. These act as the fallback layer under
 * settings.json, so an explicit value written from the browser always wins;
 * they only take effect for keys the user has not (yet) touched in the UI.
 */
export function resolveDefaultSettings(envFile: string): ReviewSettings {
  const env = parseEnvFile(envFile);
  return {
    snapshotsEnabled: envBool(env.ARK_SNAPSHOTS_ENABLED) ?? DEFAULT_SETTINGS.snapshotsEnabled,
    readOnlyMode: envBool(env.ARK_READ_ONLY_MODE) ?? DEFAULT_SETTINGS.readOnlyMode,
    viewedAutoReset: envBool(env.ARK_VIEWED_AUTO_RESET) ?? DEFAULT_SETTINGS.viewedAutoReset,
    deliveryNoteEnabled:
      envBool(env.ARK_DELIVERY_NOTE_ENABLED) ?? DEFAULT_SETTINGS.deliveryNoteEnabled,
    deliveryNoteText:
      typeof env.ARK_DELIVERY_NOTE_TEXT === 'string'
        ? env.ARK_DELIVERY_NOTE_TEXT.slice(0, MAX_TEXT)
        : DEFAULT_SETTINGS.deliveryNoteText,
    editorUriTemplate:
      typeof env.ARK_EDITOR_URI_TEMPLATE === 'string'
        ? env.ARK_EDITOR_URI_TEMPLATE.slice(0, MAX_TEXT)
        : DEFAULT_SETTINGS.editorUriTemplate,
    prPendingCommentEnabled:
      envBool(env.ARK_PR_PENDING_COMMENT) ?? DEFAULT_SETTINGS.prPendingCommentEnabled,
  };
}

// The only value form parseEnvFile can read back losslessly for arbitrary
// text: double quotes, newlines as `\n`. A literal backslash-n in the text
// has no escape and would come back as a newline, so callers check
// envValueRoundTrips first.
export function encodeEnvValue(value: string): string {
  return '"' + value.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n') + '"';
}

export function envValueRoundTrips(value: string): boolean {
  const normalized = value.replace(/\r\n?/g, '\n');
  return encodeEnvValue(normalized).slice(1, -1).replace(/\\n/g, '\n') === normalized;
}

/**
 * Rewrites only the given ARK_* keys in the env file, leaving every other
 * line (comments, other keys, a concatenated .env.local section) as it was.
 * parseEnvFile is last-wins, so the last occurrence of a key is the one
 * replaced; a missing key is appended. Values are written as-is, so the
 * caller passes already-encoded values (see encodeEnvValue).
 */
export function writeEnvEntries(file: string, entries: Record<string, string>): void {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw === '' ? [] : raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(entries)) {
    const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`);
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i])) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const prefix = re.exec(lines[idx])![1];
      lines[idx] = `${prefix}${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  // A symlinked .env (older setups) is written through to its target rather
  // than replaced by a regular file.
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, lines.join(eol) + eol, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, target);
}
