import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  encodeEnvValue,
  envValueRoundTrips,
  parseEnvFile,
  resolveDefaultSettings,
  writeEnvEntries,
} from '../src/envDefaults';
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

test('prPendingCommentEnabled は既定 false で、.env の ARK_PR_PENDING_COMMENT で ON にできる', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    assert.equal(DEFAULT_SETTINGS.prPendingCommentEnabled, false);
    assert.equal(resolveDefaultSettings(envFile).prPendingCommentEnabled, false);

    fs.writeFileSync(envFile, 'ARK_PR_PENDING_COMMENT=true\n');
    assert.equal(
      loadSettings(path.join(tmp, 'settings.json'), envFile).prPendingCommentEnabled,
      true
    );

    // bool として不正な値はコード内デフォルト（false）に落ちる。
    fs.writeFileSync(envFile, 'ARK_PR_PENDING_COMMENT=yes\n');
    assert.equal(resolveDefaultSettings(envFile).prPendingCommentEnabled, false);

    // settings.json の明示値が .env より優先される。
    fs.writeFileSync(envFile, 'ARK_PR_PENDING_COMMENT=1\n');
    const settingsFile = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ prPendingCommentEnabled: false }));
    assert.equal(loadSettings(settingsFile, envFile).prPendingCommentEnabled, false);
    // 型が違う値は無視してデフォルト（ここでは .env の true）に落ちる。
    fs.writeFileSync(settingsFile, JSON.stringify({ prPendingCommentEnabled: 'true' }));
    assert.equal(loadSettings(settingsFile, envFile).prPendingCommentEnabled, true);
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

test('writeEnvEntries は指定キーの行だけ書き換え、他の行・コメントは残す', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    const original = [
      '# 共有の既定値',
      'ARK_SNAPSHOTS_ENABLED=false',
      'ARK_DELIVERY_NOTE_ENABLED=false # 旧値',
      'ARK_DELIVERY_NOTE_TEXT="旧テキスト"',
      '',
      '# --- .env.local ---',
      'export ARK_DELIVERY_NOTE_TEXT="ローカルの旧テキスト"',
      'ARK_EDITOR_URI_TEMPLATE="cursor://file{path}"',
      '',
    ].join('\n');
    fs.writeFileSync(envFile, original);
    writeEnvEntries(envFile, {
      ARK_DELIVERY_NOTE_ENABLED: 'true',
      ARK_DELIVERY_NOTE_TEXT: encodeEnvValue('新しい指示\n2行目'),
    });
    const after = fs.readFileSync(envFile, 'utf8');
    assert.equal(
      after,
      [
        '# 共有の既定値',
        'ARK_SNAPSHOTS_ENABLED=false',
        'ARK_DELIVERY_NOTE_ENABLED=true',
        // 後勝ちなので、有効な最後の出現だけを書き換える
        'ARK_DELIVERY_NOTE_TEXT="旧テキスト"',
        '',
        '# --- .env.local ---',
        'export ARK_DELIVERY_NOTE_TEXT="新しい指示\\n2行目"',
        'ARK_EDITOR_URI_TEMPLATE="cursor://file{path}"',
        '',
      ].join('\n')
    );
    const defaults = resolveDefaultSettings(envFile);
    assert.equal(defaults.deliveryNoteEnabled, true);
    assert.equal(defaults.deliveryNoteText, '新しい指示\n2行目');
    assert.equal(defaults.snapshotsEnabled, false);
    assert.equal(defaults.editorUriTemplate, 'cursor://file{path}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeEnvEntries は無いキーを末尾に足し、ファイルもディレクトリも無ければ作る', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, 'nested', '.env');
    writeEnvEntries(envFile, { ARK_DELIVERY_NOTE_TEXT: encodeEnvValue('') });
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'ARK_DELIVERY_NOTE_TEXT=""\n');
    // 空文字も「空の note」として読み戻せる（組み込みデフォルトに落ちない）
    assert.equal(resolveDefaultSettings(envFile).deliveryNoteText, '');

    fs.writeFileSync(envFile, 'ARK_READ_ONLY_MODE=true'); // 末尾改行なし
    writeEnvEntries(envFile, { ARK_DELIVERY_NOTE_ENABLED: 'false' });
    assert.equal(
      fs.readFileSync(envFile, 'utf8'),
      'ARK_READ_ONLY_MODE=true\nARK_DELIVERY_NOTE_ENABLED=false\n'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeEnvEntries は CRLF の改行を保ち、symlink はリンク先を書き換える', () => {
  const tmp = makeTmpDir();
  try {
    const realFile = path.join(tmp, 'shared.env');
    const link = path.join(tmp, '.env');
    fs.writeFileSync(realFile, '# c\r\nARK_DELIVERY_NOTE_ENABLED=false\r\n');
    fs.symlinkSync(realFile, link);
    writeEnvEntries(link, { ARK_DELIVERY_NOTE_ENABLED: 'true' });
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(realFile, 'utf8'), '# c\r\nARK_DELIVERY_NOTE_ENABLED=true\r\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('encodeEnvValue はクォートや # を含む文字列も parseEnvFile で同じ値に戻る', () => {
  const tmp = makeTmpDir();
  try {
    const envFile = path.join(tmp, '.env');
    const text = '"引用" と # 記号\r\n行2 \'single\' ';
    assert.equal(envValueRoundTrips(text), true);
    writeEnvEntries(envFile, { ARK_DELIVERY_NOTE_TEXT: encodeEnvValue(text) });
    assert.equal(parseEnvFile(envFile).ARK_DELIVERY_NOTE_TEXT, '"引用" と # 記号\n行2 \'single\' ');
    // 文字列としての「\n」は .env では改行と区別できない
    assert.equal(envValueRoundTrips('C:\\new'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
