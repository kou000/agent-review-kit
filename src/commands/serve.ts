import * as fs from 'fs';
import { reviewPaths } from '../paths';
import { createServer, DEFAULT_PORT } from '../server';

export interface ServeOptions {
  port?: number;
  cwd?: string;
}

export function serve(opts: ServeOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const port = opts.port ?? DEFAULT_PORT;
  const paths = reviewPaths(cwd);

  if (!fs.existsSync(paths.html)) {
    console.error(
      `warning: ${paths.html} がありません。先に \`agent-review-kit generate\` を実行してください。`
    );
  }

  const server = createServer(paths);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `error: ポート ${port} は使用中です（既に serve が起動している可能性があります）。`
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, () => {
    console.log(`agent-review-kit serve: http://localhost:${port}`);
  });
}
