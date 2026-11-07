#!/usr/bin/env node
// Cross-open verification (plan 023, Phase 5): the Node and Go servers must be
// interchangeable on one data dir (never run concurrently).
//
//   node e2e/parity/cross-open.mjs            # both directions
//   node e2e/parity/cross-open.mjs --keep     # keep temp dirs for inspection
//
// For each direction  A -> B  (node->go, go->node):
//   1. A on a fresh dir: bootstrap, login, vault, API token, sync commit with notes + PNG + binary
//      attachment, web edit, rename/delete commit; snapshot everything readable.
//   2. Stop A with SIGTERM (clean shutdown), record leftover -wal/-shm files, PRAGMA integrity_check.
//   3. Start B on the SAME dir: login with A's password hash, A's API token still works,
//      snapshot must equal A's; then a new sync commit (old token) + web edit succeed.
//   4. Stop B, start A again: it must read B's writes (round trip).
// Needs `npm run build` and `npm run go:build`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBinaries, Client, makeFile, sha256, startServer, stopServer } from './lib.mjs';

const KEEP = process.argv.includes('--keep');
const EMAIL = 'admin@example.com';
const PASSWORD = 'cross-open-password-123';
const TOKEN = 'cross-open-token';
const MD = 'text/markdown';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const BIN = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 255));

const failures = [];
const log = [];
function check(name, ok, detail = '') {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  console.log(log.at(-1));
  if (!ok) failures.push(name);
}

const sorted = (a, f) => [...a].sort((x, y) => (f(x) < f(y) ? -1 : f(x) > f(y) ? 1 : 0));
const j = (x) => JSON.stringify(x);
// Lists whose tie-break order is random in Node (UUIDv7 ids): canonicalise.
function canon(v, key) {
  if (Array.isArray(v)) {
    const a = v.map((x) => canon(x));
    if (key === 'links' || key === 'edges' || key === 'changes' || key === 'tokens')
      return sorted(a, (x) => j(x));
    return a;
  }
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x, k)]));
  return v;
}

async function snapshot(c, vault, token) {
  const s = {};
  const get = async (name, path, opts = { session: true }) => {
    const r = await c.req('GET', path, opts);
    s[name] = r.json
      ? { status: r.status, json: canon(r.json) }
      : { status: r.status, sha: sha256(r.bytes) };
  };
  await get('vault', `/api/v1/vaults/${vault}`);
  await get('files', `/api/v1/vaults/${vault}/files`);
  await get('tree', `/api/v1/vaults/${vault}/tree`);
  await get('changes', `/api/v1/vaults/${vault}/changes?sinceRevision=0`);
  await get('graph', `/api/v1/vaults/${vault}/graph`);
  await get('links', `/api/v1/vaults/${vault}/links`);
  await get('search', `/api/v1/vaults/${vault}/search?q=Welcome`);
  const files = (await c.req('GET', `/api/v1/vaults/${vault}/files`, { session: true })).json.files;
  for (const f of files) {
    await get(
      `content:${f.fileId}`,
      `/api/v1/vaults/${vault}/files/${f.fileId}/${f.kind === 'markdown' ? 'content' : 'raw'}`,
    );
    if (f.kind === 'markdown')
      await get(`rendered:${f.fileId}`, `/api/v1/vaults/${vault}/files/${f.fileId}/rendered`);
  }
  await get('token-list-bearer', `/api/v1/vaults/${vault}/files`, { token });
  return s;
}

function diffSnap(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (j(a[k]) !== j(b[k])) out.push(k);
  return out;
}

function sqliteCheck(dir) {
  const db = join(dir, 'tephra.db');
  try {
    const ic = execFileSync('sqlite3', [db, 'PRAGMA integrity_check;'], {
      encoding: 'utf8',
    }).trim();
    const uv = execFileSync('sqlite3', [db, 'PRAGMA user_version;'], { encoding: 'utf8' }).trim();
    return { ic, uv };
  } catch (e) {
    return { ic: `sqlite3 unavailable: ${e.message}`, uv: '?' };
  }
}
const sidecars = (dir) => readdirSync(dir).filter((f) => /-(wal|shm)$/.test(f));

async function direction(A, B) {
  const tag = `${A}->${B}`;
  const dir = mkdtempSync(join(tmpdir(), `tephra-cross-${A}-${B}-`));
  console.log(`\n== ${tag}  (data dir ${dir})`);
  try {
    // ---- 1. seed on A
    let srv = await startServer(A, dir, TOKEN);
    let c = new Client(srv.base);
    await c.bootstrap(EMAIL, PASSWORD, TOKEN);
    check(`${tag}: ${A} login`, (await c.login(EMAIL, PASSWORD)).status === 200);
    await c.ok('POST', '/api/v1/vaults', { session: true, json: { name: 'alpha' } });
    const tok = (
      await c.ok('POST', '/api/v1/vaults/alpha/tokens', {
        session: true,
        json: { name: 'Plugin', deviceId: 'dev-1', deviceName: 'Laptop', platform: 'macos' },
      })
    ).json.value;
    const home = makeFile(
      'note-home',
      'Home.md',
      '---\ntitle: Home\ntags: [x]\n---\n# Home\nWelcome to [[Projects/Plan]] and [[Ünïcode Note]].\n\n![[pic.png]]\n',
      MD,
    );
    const plan = makeFile(
      'note-plan',
      'Projects/Plan.md',
      '# Plan\nBack to [[Home]]. Welcome!\n',
      MD,
    );
    const uni = makeFile('note-uni', 'Ünïcode Note.md', '# Ünïcode\ncafé ☕ [[Home]]\n', MD);
    const png = makeFile('att-png', 'pic.png', PNG, 'image/png');
    const bin = makeFile('att-bin', 'Files/blob.bin', BIN);
    await c.syncCommit('alpha', tok, 'dev-1', [home, plan, uni, png, bin]);
    const edited = '# Plan\nBack to [[Home]]. Welcome! Edited on the web.\n';
    await c.ok('PUT', '/api/v1/vaults/alpha/files/note-plan/content', {
      session: true,
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': plan.hash },
      body: edited,
    });
    const plan2 = makeFile('note-plan', 'Projects/Plan.md', edited, MD);
    const home2 = makeFile('note-home', 'Home 2.md', home.bytes, MD); // rename
    await c.syncCommit('alpha', tok, 'dev-1', [home2, plan2, uni, png]); // + delete bin
    await c.waitIndexed('alpha');
    const rev = (await c.ok('GET', '/api/v1/vaults/alpha', { session: true })).json.vault
      .latestRevision;
    check(`${tag}: seeded on ${A}`, rev >= 3, `revision ${rev}`);
    const snapA = await snapshot(c, 'alpha', tok);

    // ---- 2. clean stop
    const exitA = await stopServer(srv);
    check(`${tag}: ${A} clean SIGTERM exit`, exitA.code === 0, j(exitA));
    const side = sidecars(dir);
    console.log(`   after ${A} stop: sidecar files = ${j(side)}`);
    const q1 = sqliteCheck(dir);
    check(
      `${tag}: sqlite integrity_check after ${A} stop`,
      q1.ic === 'ok',
      `${q1.ic}; user_version ${q1.uv}`,
    );

    // ---- 3. open with B
    srv = await startServer(B, dir, TOKEN);
    c = new Client(srv.base);
    check(
      `${tag}: ${B} login with ${A}-hashed password`,
      (await c.login(EMAIL, PASSWORD)).status === 200,
    );
    check(
      `${tag}: ${B} rejects wrong password`,
      (await c.login(EMAIL, 'wrong-password-123')).status === 401,
    );
    await c.login(EMAIL, PASSWORD);
    check(
      `${tag}: ${B} accepts ${A}-issued API token`,
      (await c.req('GET', '/api/v1/vaults/alpha/files', { token: tok })).status === 200,
    );
    await c.waitIndexed('alpha');
    const snapB = await snapshot(c, 'alpha', tok);
    const d = diffSnap(snapA, snapB);
    check(
      `${tag}: ${B} reads identical vault/files/blobs/changes/graph/rendered (${Object.keys(snapA).length} responses)`,
      d.length === 0,
      d.slice(0, 5).join(', '),
    );
    const raw = await c.req('GET', '/api/v1/vaults/alpha/files/att-png/raw', { session: true });
    check(`${tag}: ${B} blob bytes verify`, sha256(raw.bytes) === png.hash);
    // new commit with the old token
    const extra = makeFile('note-extra', 'Extra.md', `# Extra by ${B}\n[[Home 2]]\n`, MD);
    const big = makeFile('att-big', 'Files/big.bin', Buffer.alloc(3 * 1024 * 1024, 7));
    await c.syncCommit('alpha', tok, 'dev-1', [home2, plan2, uni, png, extra, big]);
    const edited2 = `${extra.bytes.toString()}web edit by ${B}\n`;
    const we = await c.req('PUT', '/api/v1/vaults/alpha/files/note-extra/content', {
      session: true,
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-match': extra.hash },
      body: edited2,
    });
    check(`${tag}: ${B} new sync commit + web edit`, we.status === 200, `edit status ${we.status}`);
    await c.waitIndexed('alpha');
    const rev2 = (await c.ok('GET', '/api/v1/vaults/alpha', { session: true })).json.vault
      .latestRevision;
    check(`${tag}: revision advanced`, rev2 === rev + 2, `${rev} -> ${rev2}`);
    const snapB2 = await snapshot(c, 'alpha', tok);
    const exitB = await stopServer(srv);
    check(`${tag}: ${B} clean SIGTERM exit`, exitB.code === 0, j(exitB));
    console.log(`   after ${B} stop: sidecar files = ${j(sidecars(dir))}`);
    const q2 = sqliteCheck(dir);
    check(
      `${tag}: sqlite integrity_check after ${B} stop`,
      q2.ic === 'ok',
      `${q2.ic}; user_version ${q2.uv}`,
    );

    // ---- 4. back to A
    srv = await startServer(A, dir, TOKEN);
    c = new Client(srv.base);
    check(`${tag}: ${A} login again`, (await c.login(EMAIL, PASSWORD)).status === 200);
    await c.waitIndexed('alpha');
    const snapA2 = await snapshot(c, 'alpha', tok);
    const d2 = diffSnap(snapB2, snapA2);
    check(
      `${tag}: ${A} reads ${B}'s writes identically (round trip)`,
      d2.length === 0,
      d2.slice(0, 5).join(', '),
    );
    const back = await c.req('GET', '/api/v1/vaults/alpha/files/note-extra/content', {
      session: true,
    });
    check(`${tag}: ${A} sees ${B}'s web edit`, back.text === edited2);
    await stopServer(srv);
  } finally {
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
    else console.log(`   kept ${dir}`);
  }
}

// Go uses WAL: after SIGKILL (no clean close) the -wal file may hold committed data. Node must recover it.
async function crashRecovery() {
  const tag = 'go(SIGKILL)->node';
  const dir = mkdtempSync(join(tmpdir(), 'tephra-cross-crash-'));
  console.log(`\n== ${tag}  (data dir ${dir})`);
  try {
    let srv = await startServer('go', dir, TOKEN);
    let c = new Client(srv.base);
    await c.bootstrap(EMAIL, PASSWORD, TOKEN);
    await c.login(EMAIL, PASSWORD);
    await c.ok('POST', '/api/v1/vaults', { session: true, json: { name: 'alpha' } });
    const tok = (
      await c.ok('POST', '/api/v1/vaults/alpha/tokens', { session: true, json: { name: 'P' } })
    ).json.value;
    await c.syncCommit('alpha', tok, 'd', [
      makeFile('n1', 'A.md', '# a\n', MD),
      makeFile('n2', 'B.md', '# b [[A]]\n', MD),
    ]);
    srv.child.kill('SIGKILL');
    await srv.exited;
    console.log(`   after SIGKILL: sidecar files = ${j(sidecars(dir))}`);
    srv = await startServer('node', dir, TOKEN);
    c = new Client(srv.base);
    check(`${tag}: node login after crash`, (await c.login(EMAIL, PASSWORD)).status === 200);
    const v = (await c.ok('GET', '/api/v1/vaults/alpha', { session: true })).json.vault;
    const f = (await c.ok('GET', '/api/v1/vaults/alpha/files', { session: true })).json.files;
    check(
      `${tag}: node sees committed revision + files`,
      v.latestRevision === 1 && f.length === 2,
      `rev ${v.latestRevision}, ${f.length} files`,
    );
    await stopServer(srv);
    const q = sqliteCheck(dir);
    check(`${tag}: integrity_check`, q.ic === 'ok', q.ic);
  } finally {
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

checkBinaries();
for (const [a, b] of [
  ['node', 'go'],
  ['go', 'node'],
]) {
  try {
    await direction(a, b);
  } catch (e) {
    check(`${a}->${b}: scenario error`, false, e.stack ?? String(e));
  }
}
try {
  await crashRecovery();
} catch (e) {
  check('crash recovery: scenario error', false, e.stack ?? String(e));
}
console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
