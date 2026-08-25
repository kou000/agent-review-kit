import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseEnvFile, resolveDefaultSettings } from '../src/envDefaults';
import { loadSettings, mutateSettings } from '../src/store';
import { DEFAULT_SETTINGS } from '../src/types';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ark-env-'));
}

test('.env が無ければコード内デフォルトのまま', () => {
  const tmp = makeTmpDir();
  try {
    const settings = loadSettings(
      path.join(tmp, 'settings.json'),
      path.join(tmp, '.env')
    );
    assert.deepEqual(settings, DEFAULT_SETTINGS);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('.env の ARK_* がデフォルトを上書きする（settings.json 無し）', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(
      envFile,
      [
        '# per-user defaults',
        'ARK_SNAPSHOTS_ENABLED=false',
        'export ARK_READ_ONLY_MODE=true',
        'ARK_DELIVERY_NOTE_ENABLED=1 # trailing comment',
        'ARK_DELIVERY_NOTE_TEXT="line1\\nline2"',
        '',
      ].join('\n')
    );
    const settings = loadSettings(path.join(tmp, 'settings.json'), envFile);
    assert.equal(settings.snapshotsEnabled, false);
    assert.equal(settings.readOnlyMode, true);
    assert.equal(settings.viewedAutoReset, true); // 未指定キーはコード内デフォルト
    assert.equal(settings.deliveryNoteEnabled, true);
    assert.equal(settings.deliveryNoteText, 'line1\nline2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings.json の明示値が .env より優先される', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    const settingsFile = path.join(tmp, 'settings.json');
    fs.writeFileSync(envFile, 'ARK_SNAPSHOTS_ENABLED=false\n');
    fs.writeFileSync(settingsFile, JSON.stringify({ snapshotsEnabled: true }));
    assert.equal(loadSettings(settingsFile, envFile).snapshotsEnabled, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bool として不正な値は無視されコード内デフォルトに落ちる', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'ARK_SNAPSHOTS_ENABLED=ture\nARK_READ_ONLY_MODE=yes\n');
    const defaults = resolveDefaultSettings(envFile);
    assert.equal(defaults.snapshotsEnabled, DEFAULT_SETTINGS.snapshotsEnabled);
    assert.equal(defaults.readOnlyMode, DEFAULT_SETTINGS.readOnlyMode);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mutateSettings（PUT相当）でも未変更キーは .env デフォルトのまま保存される', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    const settingsFile = path.join(tmp, 'settings.json');
    fs.writeFileSync(envFile, 'ARK_SNAPSHOTS_ENABLED=false\n');
    const settings = mutateSettings(
      settingsFile,
      (s) => {
        s.readOnlyMode = true;
      },
      envFile
    );
    assert.equal(settings.snapshotsEnabled, false);
    assert.equal(settings.readOnlyMode, true);
    // 保存後もファイル明示値として env デフォルトが引き継がれている
    assert.equal(loadSettings(settingsFile).snapshotsEnabled, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('.env の ARK_EDITOR_URI_TEMPLATE が設定として読み込まれる', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    // 未設定なら組み込みデフォルト（vscode://file{path}）。
    assert.equal(
      resolveDefaultSettings(envFile).editorUriTemplate,
      DEFAULT_SETTINGS.editorUriTemplate
    );
    assert.equal(DEFAULT_SETTINGS.editorUriTemplate, 'vscode://file{path}');
    // WSL 上のリポジトリを Windows 側の VS Code で開く想定の値。
    fs.writeFileSync(
      envFile,
      'ARK_EDITOR_URI_TEMPLATE="vscode://vscode-remote/wsl+Ubuntu{path}"\n'
    );
    const settings = loadSettings(path.join(tmp, 'settings.json'), envFile);
    assert.equal(settings.editorUriTemplate, 'vscode://vscode-remote/wsl+Ubuntu{path}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseEnvFile はクォート・コメント・空行を扱える', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(
      envFile,
      ["A='single \\n stays'", 'B=  bare value  ', '# comment only', 'MALFORMED LINE', ''].join('\n')
    );
    const env = parseEnvFile(envFile);
    assert.equal(env.A, 'single \\n stays'); // シングルクォートはエスケープ展開しない
    assert.equal(env.B, 'bare value');
    assert.equal(Object.keys(env).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
