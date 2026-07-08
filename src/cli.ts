#!/usr/bin/env node
import { generate } from './commands/generate';
import { resolveComment } from './commands/resolveComment';
import { serve } from './commands/serve';
import { status } from './commands/status';
import { waitComments } from './commands/waitComments';

const USAGE = `agent-review-kit <command> [options]

Commands:
  generate                 現在の git diff からレビューHTMLを生成する
    --base <ref>           比較元の ref を指定（省略時は working tree vs HEAD）
  serve                    レビュー画面とAPIのローカルサーバーを起動する
    --port <n>             ポート番号（デフォルト: 5179）
  wait-comments            新規（status: open）コメントが来るまで待つ
    --timeout <sec>        タイムアウト秒。0 で無期限待機（デフォルト: 0）
  resolve-comment <id>     コメントの状態を更新する
    --status <status>      open|seen|fixed|answered|wontfix|resolved（デフォルト: resolved）
    --message <text>       agentResponse として保存する返信メッセージ
  status                   コメント集計をJSONで出力する
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function flagNum(
  flags: Record<string, string | boolean>,
  key: string
): number | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`error: --${key} には数値を指定してください: ${v}`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'generate':
      generate({ base: flagStr(flags, 'base') });
      break;
    case 'serve':
      serve({ port: flagNum(flags, 'port') });
      break;
    case 'wait-comments':
      await waitComments({ timeout: flagNum(flags, 'timeout') });
      break;
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
      });
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
