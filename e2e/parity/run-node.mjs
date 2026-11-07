#!/usr/bin/env node
// Starts a FRESH Node API server (temp sqlite/blob dirs, free port, Obsidian sync disabled),
// runs the parity scenario against it and writes the snapshot, then stops the server.
//   node e2e/parity/run-node.mjs --out e2e/parity/golden/node.json
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : resolve(here, 'golden/node.json');
const TOKEN = 'parity-bootstrap-token';

const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => res(p));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'tephra-parity-'));
const server = spawn(process.execPath, [join(root, 'tephra-server/apps/api/dist/main.js')], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    TEPHRA_SQLITE_PATH: join(dir, 'tephra.db'),
    TEPHRA_BLOB_PATH: join(dir, 'blobs'),
    TEPHRA_OBSIDIAN_SYNC_ENABLED: 'false',
    TEPHRA_BOOTSTRAP_TOKEN: TOKEN,
    TEPHRA_WEB_ROOT: join(root, 'tephra-server/apps/web/dist'),
    TEPHRA_PUBLIC_URL: '',
    NODE_ENV: '',
  },
});
let code = 1;
try {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  code = await new Promise((res) =>
    spawn(
      process.execPath,
      [
        join(here, 'run.mjs'),
        '--base',
        `http://127.0.0.1:${port}`,
        '--out',
        out,
        '--bootstrap-token',
        TOKEN,
      ],
      { stdio: 'inherit' },
    ).on('exit', res),
  );
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => {
    server.on('exit', r);
    setTimeout(r, 3000);
  });
  server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code ?? 1);
