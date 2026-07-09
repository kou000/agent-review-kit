import * as fs from 'fs';
import { ensureDir, reviewPaths } from '../paths';
import { createServer, DEFAULT_PORT } from '../server';
import { nowIso } from '../store';

export interface ServeOptions {
  port?: number;
  cwd?: string;
}

// --port 未指定時に DEFAULT_PORT から順に試す範囲。
const PORT_SCAN_RANGE = 20;

// ローカル専用ツール: LAN に diff・任意コミットの差分・コメントAPIを晒さない。
const LISTEN_HOST = '127.0.0.1';

export function serve(opts: ServeOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const paths = reviewPaths(cwd);
  const explicitPort = opts.port !== undefined;
  let port = opts.port ?? DEFAULT_PORT;

  if (!fs.existsSync(paths.html)) {
    console.error(
      `warning: ${paths.html} がありません。先に \`agent-review-kit generate\` を実行してください。`
    );
  }

  const server = createServer(paths);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // 明示指定されたポートは黙って変えない。自動選択時のみ次を試す。
      if (!explicitPort && port < DEFAULT_PORT + PORT_SCAN_RANGE) {
        port += 1;
        server.listen(port, LISTEN_HOST);
        return;
      }
      console.error(
        explicitPort
          ? `error: ポート ${port} は使用中です（既に serve が起動している可能性があります）。`
          : `error: ポート ${DEFAULT_PORT}〜${port} がすべて使用中です。--port で指定してください。`
      );
      process.exit(1);
    }
    throw err;
  });
  server.on('listening', () => {
    ensureDir(paths.dir);
    fs.writeFileSync(
      paths.serverJson,
      JSON.stringify(
        { port, pid: process.pid, projectDir: cwd, startedAt: nowIso() },
        null,
        2
      ) + '\n'
    );
    console.log(`agent-review-kit serve: http://localhost:${port}`);
  });
  server.listen(port, LISTEN_HOST);
}
