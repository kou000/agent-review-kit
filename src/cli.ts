#!/usr/bin/env node
import { addComment } from './commands/addComment';
import { generate } from './commands/generate';
import { publishHtml } from './commands/publishHtml';
import { resolveComment } from './commands/resolveComment';
import { serve } from './commands/serve';
import { snapshotBegin, snapshotCreate, snapshotList } from './commands/snapshot';
import { status } from './commands/status';
import { waitComments } from './commands/waitComments';

const USAGE = `agent-review-kit <command> [options]

Commands:
  generate                 現在の git diff からレビューHTMLを生成する
    --base <ref>           比較元の ref を指定。省略時は前回 generate の base を
                           引き継ぐ（初回は working tree vs HEAD）。
                           working tree vs HEAD に戻すには --base HEAD を指定する
  serve                    レビュー画面とAPIのローカルサーバーを起動する
    --port <n>             ポート番号（省略時: 5179 から空きポートを自動選択し .agent-review/server.json に記録）
  publish-html             任意の HTML をレビュー対象ドキュメントとして登録・更新する。
                           レンダリングされた状態が /doc/<id> で表示され、要素や
                           テキスト範囲にコメントできる。同じ --document-id で再実行
                           すると revision が上がり、ブラウザは自動リロードして既存
                           コメントを可能な範囲で元の位置に再表示する
    --input <path>         レビュー対象の HTML ファイル（必須）
    --document-id <id>     ドキュメントID。英数字で始まる 64 文字以内のスラッグ（必須）
    --title <text>         表示タイトル（省略時: 前回のタイトル → HTML の <title> → ID）
  wait-comments            新規（status: open）コメントが来るまで待つ
    --timeout <sec>        タイムアウト秒。0 で無期限待機（デフォルト: 0）
    --document-id <id>     指定した HTML ドキュメントへのコメントだけを待つ
                           （省略時: diff・全ドキュメントのコメントを配達）
    --diff-only            HTMLドキュメント宛を除き、diffレビューのコメントだけを待つ
                           （--document-id と同時指定はエラー）
  resolve-comment <id>     コメントの状態を更新する
    --status <status>      open|seen|fixed|answered|wontfix|resolved|dismissed（デフォルト: resolved）
    --message <text>       agentResponse として保存する返信メッセージ
    --commit <sha>         修正コミットの sha。返信に /commit/<sha> へのリンクを添える（--message 必須）
    --snapshot <id>        修正スナップショットの id。返信に /snapshot/<id> へのリンクを添える（--message 必須）
    --image <path>         返信にインライン表示する画像ファイル（png/jpg/jpeg/gif/webp）。
                           複数回指定可。data URI 化して保存する（1枚あたり最大3MB、--message 必須）
  add-comment              AIレビューの指摘をエージェント名義のコメントとして投稿する。
                           投稿した指摘は wait-comments には配達されない（エージェント自身は
                           処理しない）。ユーザーがその指摘に返信したものだけが wait-comments
                           に届くので、それを待って修正・回答する。未返信の指摘はレビュー終了時に
                           自動で dismissed になる（手順の詳細は my-interactive-review スキル）
    --body <text>          コメント本文（必須）
    --file <path>          対象ファイル。省略時はレビュー全体へのコメント
    --line <n>             対象行（単一行）
    --start-line <n>       対象範囲の開始行（--end-line とセット）
    --end-line <n>         対象範囲の終了行
    --side <old|new>       変更前/変更後どちらの行か（デフォルト: new）
  snapshot begin           修正の適用前に working tree の状態を記録する
  snapshot create          修正の patch を保存し、/snapshot/<id> で差分表示できるようにする
    --comment <id>         対象コメントの id（必須）
    --title <text>         スナップショットの表題
    --commit <sha>         begin との差分の代わりに、このコミットの差分を patch にする
    --patch-file <path>    begin との差分の代わりに、この patch ファイルを取り込む
  snapshot list            スナップショット一覧をJSONで出力する
  status                   コメント集計・設定・レビュー終了状態をJSONで出力する
`;

type FlagValue = string | boolean;

interface ParsedArgs {
  positional: string[];
  // A flag given once is a scalar; a flag repeated (e.g. --image a --image b)
  // is collapsed into an array so callers can accept multiple values.
  flags: Record<string, FlagValue | FlagValue[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, FlagValue | FlagValue[]> = {};
  const set = (key: string, value: FlagValue): void => {
    const prev = flags[key];
    if (prev === undefined) {
      flags[key] = value;
    } else if (Array.isArray(prev)) {
      prev.push(value);
    } else {
      flags[key] = [prev, value];
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

type Flags = Record<string, FlagValue | FlagValue[]>;

function flagStr(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    console.error(`error: --${key} は一度だけ指定してください`);
    process.exit(1);
  }
  // 値なし（--base だけ、または次の引数が --xxx）や空文字（--base "$VAR" で
  // VAR が空）を黙ってフォールバックさせず、その場でエラーにする。
  if (v === true || v === '') {
    console.error(`error: --${key} には値を指定してください`);
    process.exit(1);
  }
  return v as string;
}

// A flag that may be repeated (e.g. --image a --image b). Returns undefined
// when absent, otherwise a list of the given values. Each value must be a
// non-empty string; a bare flag (no value) or empty string is a hard error.
function flagList(flags: Flags, key: string): string[] | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  const values = Array.isArray(v) ? v : [v];
  return values.map((item) => {
    if (item === true || item === '') {
      console.error(`error: --${key} には値を指定してください`);
      process.exit(1);
    }
    return item as string;
  });
}

function flagNum(flags: Flags, key: string): number | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`error: --${key} には数値を指定してください: ${v}`);
    process.exit(1);
  }
  return n;
}

// A value-less boolean flag (e.g. --diff-only). Present without a value ->
// true; absent -> undefined; given a value (e.g. --diff-only foo) is a hard
// error since the flag has nothing to parse it into.
function flagBool(flags: Flags, key: string): boolean | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (v !== true) {
    console.error(`error: --${key} は値を取りません`);
    process.exit(1);
  }
  return true;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'generate':
      await generate({ base: flagStr(flags, 'base') });
      break;
    case 'serve':
      serve({ port: flagNum(flags, 'port') });
      break;
    case 'publish-html':
      publishHtml({
        input: flagStr(flags, 'input'),
        documentId: flagStr(flags, 'document-id'),
        title: flagStr(flags, 'title'),
      });
      break;
    case 'wait-comments': {
      const documentId = flagStr(flags, 'document-id');
      const diffOnly = flagBool(flags, 'diff-only');
      if (diffOnly && documentId !== undefined) {
        console.error('error: --diff-only と --document-id は同時に指定できません');
        process.exit(1);
      }
      await waitComments({
        timeout: flagNum(flags, 'timeout'),
        documentId,
        diffOnly,
      });
      break;
    }
    case 'resolve-comment': {
      const id = positional[0];
      if (!id) {
        console.error('error: comment id を指定してください。例: agent-review-kit resolve-comment comment_xxx --status fixed');
        process.exit(1);
      }
      resolveComment({
        id,
        status: flagStr(flags, 'status'),
        message: flagStr(flags, 'message'),
        commit: flagStr(flags, 'commit'),
        snapshot: flagStr(flags, 'snapshot'),
        images: flagList(flags, 'image'),
      });
      break;
    }
    case 'add-comment':
      addComment({
        body: flagStr(flags, 'body'),
        file: flagStr(flags, 'file'),
        line: flagNum(flags, 'line'),
        startLine: flagNum(flags, 'start-line'),
        endLine: flagNum(flags, 'end-line'),
        side: flagStr(flags, 'side'),
      });
      break;
    case 'snapshot': {
      const sub = positional[0];
      if (sub === 'begin') {
        snapshotBegin();
      } else if (sub === 'create') {
        snapshotCreate({
          comment: flagStr(flags, 'comment'),
          title: flagStr(flags, 'title'),
          commit: flagStr(flags, 'commit'),
          patchFile: flagStr(flags, 'patch-file'),
        });
      } else if (sub === 'list') {
        snapshotList();
      } else {
        console.error('error: snapshot のサブコマンドは begin / create / list です');
        process.exit(1);
      }
      break;
    }
    case 'status':
      status();
      break;
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      break;
    default:
      console.error(`error: unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
  }
}

void main().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
