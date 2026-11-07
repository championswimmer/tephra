// Shared helpers for cross-open.mjs and bench-memory.mjs: start/stop the Node or Go
// server on a given data dir, a tiny API client, and the manifest hash.
// Dependency-free (Node >= 22 built-ins + global fetch).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '../..');
export const WEB_ROOT = join(root, 'tephra-server/apps/web/dist');
export const NODE_MAIN = join(root, 'tephra-server/apps/api/dist/main.js');
export const GO_BIN = join(root, 'tephra-server/go/bin/tephra-server');
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export function checkBinaries() {
  for (const f of [NODE_MAIN, GO_BIN, join(WEB_ROOT, 'index.html')])
    if (!existsSync(f)) throw new Error(`missing ${f} (run npm run build and npm run go:build)`);
}

/** Starts the Node ('node') or Go ('go') server on `dir` (db at dir/tephra.db, blobs at dir/blobs). */
export async function startServer(kind, dir, token = 'cross-open-token') {
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    TEPHRA_SQLITE_PATH: join(dir, 'tephra.db'),
    TEPHRA_BLOB_PATH: join(dir, 'blobs'),
    TEPHRA_OBSIDIAN_SYNC_ENABLED: 'false',
    TEPHRA_BOOTSTRAP_TOKEN: token,
    TEPHRA_WEB_ROOT: WEB_ROOT,
    TEPHRA_PUBLIC_URL: '',
    NODE_ENV: '',
  };
  const child =
    kind === 'node'
      ? spawn(process.execPath, [NODE_MAIN], {
          cwd: root,
          env,
          stdio: ['ignore', 'ignore', 'inherit'],
        })
      : spawn(GO_BIN, [], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok)
        return { kind, child, base, pid: child.pid, exited, token };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`${kind} server did not start`);
}

/** SIGTERM and wait; resolves to {code, sig}. */
export async function stopServer(srv) {
  srv.child.kill('SIGTERM');
  const t = setTimeout(() => srv.child.kill('SIGKILL'), 15000);
  const r = await srv.exited;
  clearTimeout(t);
  return r;
}

/** VmRSS / VmHWM in MiB from /proc/<pid>/status. */
export function memory(pid) {
  const s = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(s)?.[1] ?? NaN);
  return { rss: kb('VmRSS') / 1024, hwm: kb('VmHWM') / 1024 };
}

// ------------------------------------------------------------- manifest
const cp = (s) => Array.from(s).map((c) => c.codePointAt(0));
export function cmpPath(a, b) {
  const x = cp(a);
  const y = cp(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
export function manifestHash(files) {
  const sorted = [...files].sort((l, r) => cmpPath(l.path, r.path));
  const json = `[${sorted
    .map(
      (f) =>
        `{"fileId":${JSON.stringify(f.fileId)},"path":${JSON.stringify(f.path)},"hash":${JSON.stringify(f.hash)},"size":${f.size},"mtime":${f.mtime}${
          f.mimeType === undefined ? '' : `,"mimeType":${JSON.stringify(f.mimeType)}`
        },"kind":${JSON.stringify(f.kind)}}`,
    )
    .join(',')}]`;
  return sha256(Buffer.from(json, 'utf8'));
}

let mtime = 1_700_000_000;
export function makeFile(fileId, path, content, mimeType) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const entry = {
    fileId,
    path,
    hash: sha256(bytes),
    size: bytes.length,
    mtime: (mtime += 10),
    ...(mimeType === undefined ? {} : { mimeType }),
    kind: path.endsWith('.md') ? 'markdown' : 'attachment',
  };
  Object.defineProperty(entry, 'bytes', { value: bytes, enumerable: false });
  return entry;
}

// ------------------------------------------------------------- API client
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = '';
  }
  async req(method, path, { json, body, headers = {}, session = false, token } = {}) {
    const h = { ...headers };
    if (session) {
      h.cookie = this.cookie;
      if (!['GET', 'HEAD'].includes(method)) h['x-tephra-csrf'] = this.csrf;
    }
    if (token) h.authorization = `Bearer ${token}`;
    let b = body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      b = JSON.stringify(json);
    }
    const res = await fetch(`${this.base}${path}`, { method, headers: h, body: b });
    const bytes = Buffer.from(await res.arrayBuffer());
    let parsed = null;
    if (/json/.test(res.headers.get('content-type') ?? '')) {
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        /* keep null */
      }
    }
    return {
      status: res.status,
      json: parsed,
      bytes,
      text: bytes.toString('utf8'),
      headers: res.headers,
    };
  }
  async ok(method, path, opts) {
    const r = await this.req(method, path, opts);
    if (r.status >= 300)
      throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
    return r;
  }
  async bootstrap(email, password, token) {
    await this.ok('POST', '/api/v1/auth/bootstrap', { json: { email, password, token } });
  }
  async login(email, password) {
    const r = await this.req('POST', '/api/v1/auth/login', { json: { email, password } });
    if (r.status !== 200) return r;
    this.cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    this.csrf = r.json.csrfToken;
    return r;
  }
  async waitIndexed(vault) {
    for (let i = 0; i < 600; i += 1) {
      const r = await this.req('GET', `/api/v1/vaults/${vault}/graph`, { session: true });
      const m = /^W\/"(\d+)-(\d+)-graph/.exec(r.headers.get('etag') ?? '');
      if (m && m[1] === m[2]) return;
      await sleep(50);
    }
    throw new Error(`indexing did not finish for ${vault}`);
  }
  /** plan + upload missing blobs (concurrency-limited) + commit. Returns commit response. */
  async syncCommit(vault, token, deviceId, files, concurrency = 8) {
    const body = {
      deviceId,
      manifestHash: manifestHash(files),
      files: [...files].sort((l, r) => cmpPath(l.path, r.path)),
    };
    const plan = await this.ok('POST', `/api/v1/vaults/${vault}/sync/plan`, { token, json: body });
    const missing = plan.json.missingBlobs ?? [];
    const byHash = new Map(files.map((f) => [f.hash, f]));
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const f = byHash.get(missing[next++].hash);
        await this.ok('PUT', `/api/v1/vaults/${vault}/blobs/${f.hash}`, {
          token,
          headers: {
            'content-type': f.mimeType ?? 'application/octet-stream',
            'x-tephra-blob-size': String(f.size),
          },
          body: f.bytes,
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return this.ok('POST', `/api/v1/vaults/${vault}/sync/commit`, { token, json: body });
  }
}
