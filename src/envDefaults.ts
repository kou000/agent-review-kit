import * as fs from 'fs';
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
  };
}
