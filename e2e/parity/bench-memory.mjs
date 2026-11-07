#!/usr/bin/env node
// Memory benchmark (plan 023): RSS / peak RSS (VmRSS / VmHWM from /proc/<pid>/status) of the Node
// and Go servers at three points on a fresh data dir:
//   1. idle, 3 s after the health check passes
//   2. after the 437-request parity scenario (run.mjs)
//   3. after syncing a synthetic vault (default 1000 notes + 3 x 20 MiB attachments), indexing complete
//
//   node e2e/parity/bench-memory.mjs [--notes 1000] [--attachments 3] [--attachment-mib 20] [--only node|go]
// Needs `npm run build` and `npm run go:build`. Linux only (/proc). Prints a table.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBinaries,
  Client,
  here,
  makeFile,
  memory,
  sleep,
  startServer,
  stopServer,
} from './lib.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const NOTES = Number(arg('notes', 1000));
const ATT = Number(arg('attachments', 3));
const ATT_MIB = Number(arg('attachment-mib', 20));
const only = arg('only');
const TOKEN = 'parity-bootstrap-token';
const MD = 'text/markdown';

function synthetic() {
  const files = [];
  for (let i = 0; i < NOTES; i += 1) {
    const folder = `Folder ${i % 25}`;
    const links = [1, 7, 31].map((k) => `[[Note ${(i + k) % NOTES}]]`).join(', ');
    const body = [
      `---\ntitle: Note ${i}\ntags: [bench, t${i % 10}]\n---`,
      `# Note ${i}`,
      `Links: ${links}`,
      ...Array.from({ length: 12 }, (_, p) =>
        `Paragraph ${p} of note ${i} with **bold**, \`code\` and some filler text. `.repeat(3),
      ),
      '| a | b |\n| - | - |\n| 1 | 2 |',
      '> [!note] Callout\n> body',
    ].join('\n\n');
    files.push(makeFile(`bench-${i}`, `${folder}/Note ${i}.md`, body, MD));
  }
  for (let a = 0; a < ATT; a += 1)
    files.push(
      makeFile(`bench-att-${a}`, `Attachments/big-${a}.bin`, randomBytes(ATT_MIB * 1024 * 1024)),
    );
  return files;
}

function runParity(base) {
  return new Promise((res) => {
    const out = join(tmpdir(), `tephra-bench-parity-${process.pid}.json`);
    spawn(
      process.execPath,
      [join(here, 'run.mjs'), '--base', base, '--out', out, '--bootstrap-token', TOKEN],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    ).on('exit', (code) => {
      rmSync(out, { force: true });
      res(code);
    });
  });
}

const files = synthetic();
console.log(
  `synthetic vault: ${NOTES} notes, ${ATT} x ${ATT_MIB} MiB attachments (${files.length} files)`,
);
const results = {};
for (const kind of ['node', 'go']) {
  if (only && only !== kind) continue;
  checkBinaries();
  const dir = mkdtempSync(join(tmpdir(), `tephra-bench-${kind}-`));
  const srv = await startServer(kind, dir, TOKEN);
  const r = {};
  try {
    await sleep(3000);
    r.idle = memory(srv.pid);
    const code = await runParity(srv.base);
    if (code !== 0) throw new Error(`parity scenario exited ${code}`);
    await sleep(1000);
    r.parity = memory(srv.pid);
    const c = new Client(srv.base);
    const lr = await c.login('admin@example.com', 'parity-password-123');
    if (lr.status !== 200) throw new Error(`login after parity failed: ${lr.status}`);
    await c.ok('POST', '/api/v1/vaults', { session: true, json: { name: 'bench' } });
    const tok = (
      await c.ok('POST', '/api/v1/vaults/bench/tokens', {
        session: true,
        json: { name: 'bench', deviceId: 'bench-dev' },
      })
    ).json.value;
    const t0 = Date.now();
    await c.syncCommit('bench', tok, 'bench-dev', files, 4);
    r.syncSecs = (Date.now() - t0) / 1000;
    const t1 = Date.now();
    await c.waitIndexed('bench');
    r.indexSecs = (Date.now() - t1) / 1000;
    // read a little of everything so lazy paths are exercised
    await c.ok('GET', '/api/v1/vaults/bench/graph', { session: true });
    await c.ok('GET', '/api/v1/vaults/bench/files/bench-5/rendered', { session: true });
    await c.ok('GET', '/api/v1/vaults/bench/search?q=Paragraph', { session: true });
    await c.ok('GET', '/api/v1/vaults/bench/files/bench-att-0/raw', { session: true });
    r.sync = memory(srv.pid);
    await sleep(3000);
    r.settled = memory(srv.pid);
  } finally {
    await stopServer(srv);
    rmSync(dir, { recursive: true, force: true });
  }
  results[kind] = r;
}

const f = (m) => (m ? `${m.rss.toFixed(1)} / ${m.hwm.toFixed(1)}` : '-');
console.log('\nRSS / peak RSS (VmRSS / VmHWM), MiB');
console.log('phase'.padEnd(46), ...Object.keys(results).map((k) => k.padStart(16)));
for (const [label, key] of [
  ['idle after start (3 s)', 'idle'],
  ['after parity scenario (437 requests)', 'parity'],
  [`after sync of ${NOTES} notes + ${ATT}x${ATT_MIB} MiB, indexed`, 'sync'],
  ['3 s after that (settled)', 'settled'],
])
  console.log(label.padEnd(46), ...Object.values(results).map((r) => f(r[key]).padStart(16)));
console.log(
  'sync / index seconds'.padEnd(46),
  ...Object.values(results).map((r) =>
    `${r.syncSecs?.toFixed(1)} / ${r.indexSecs?.toFixed(1)}`.padStart(16),
  ),
);
