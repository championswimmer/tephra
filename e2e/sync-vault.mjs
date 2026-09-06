// Syncs a local Obsidian-style vault directory to a running Tephra server using
// the same plan/upload/commit protocol as the Obsidian plugin. Used for demos
// and end-to-end testing (e.g. `sample-vault/`).
//
// Env: TEPHRA_BASE (default http://127.0.0.1:8080), TEPHRA_BOOTSTRAP_TOKEN,
//   TEPHRA_ADMIN_EMAIL / TEPHRA_ADMIN_PASSWORD (defaults admin@example.com /
//   change-me-immediately), VAULT_DIR (default sample-vault),
//   VAULT_NAME (default: directory basename), DEVICE_ID (default e2e-harness).
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { hashManifest } from '../tephra-server/packages/protocol/dist/index.js';

const BASE = process.env.TEPHRA_BASE ?? 'http://127.0.0.1:8080';
const BOOTSTRAP_TOKEN = process.env.TEPHRA_BOOTSTRAP_TOKEN;
const ADMIN_EMAIL = process.env.TEPHRA_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEPHRA_ADMIN_PASSWORD ?? 'change-me-immediately';
const VAULT_DIR = process.env.VAULT_DIR ?? 'sample-vault';
const VAULT_NAME = process.env.VAULT_NAME ?? VAULT_DIR.split('/').at(-1) ?? 'sample-vault';
const DEVICE_ID = process.env.DEVICE_ID ?? 'e2e-harness';

const MIME = new Map([
  ['md', 'text/markdown'], ['png', 'image/png'], ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
]);

const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const step = (name, value) => console.log(`[sync] ${name}: ${value}`);

async function walk(dir, root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.obsidian') continue;
      out.push(...(await walk(full, root)));
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

function frontmatterId(text) {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const id = fence ? /^id:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fence[1]) : null;
  return id?.[1];
}

const paths = await walk(VAULT_DIR, VAULT_DIR);
if (paths.length === 0) throw new Error(`No files found in ${VAULT_DIR}`);
const entries = [];
for (const path of paths) {
  const bytes = await readFile(join(VAULT_DIR, path));
  const st = await stat(join(VAULT_DIR, path));
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  const kind = ext === 'md' ? 'markdown' : 'attachment';
  const text = kind === 'markdown' ? new TextDecoder().decode(bytes) : null;
  entries.push({
    fileId: (text && frontmatterId(text)) || `f-${sha256hex(path).slice(0, 16)}`,
    path,
    hash: sha256hex(bytes),
    size: bytes.byteLength,
    mtime: Math.floor(st.mtimeMs / 1000),
    mimeType: MIME.get(ext) ?? 'application/octet-stream',
    kind,
    bytes,
  });
}
const manifestEntry = ({ fileId, path, hash, size, mtime, mimeType, kind }) => ({
  fileId, path, hash, size, mtime, mimeType, kind,
});
const manifestHash = await hashManifest(entries.map(manifestEntry));
step('files', `${entries.length} (${entries.filter((e) => e.kind === 'markdown').length} markdown)`);
step('manifest', manifestHash);

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res;
};

if (!BOOTSTRAP_TOKEN) throw new Error('Set TEPHRA_BOOTSTRAP_TOKEN');
const bootstrap = await fetch(`${BASE}/api/v1/auth/bootstrap`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: BOOTSTRAP_TOKEN, email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
if (bootstrap.status !== 201 && bootstrap.status !== 409) {
  throw new Error(`bootstrap -> ${bootstrap.status} ${await bootstrap.text()}`);
}
step('bootstrap', bootstrap.status === 201 ? 'admin created' : 'already bootstrapped');

const loginRes = await api('/api/v1/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const { csrfToken } = await loginRes.json();
const cookies = loginRes.headers.getSetCookie().join('; ');
const browser = (path, init = {}) =>
  api(path, { ...init, headers: { ...(init.headers ?? {}), cookie: cookies, 'x-tephra-csrf': csrfToken } });

const vaults = await (await browser('/api/v1/vaults')).json();
let vault = vaults.vaults.find((v) => v.name === VAULT_NAME) ?? null;
if (!vault) {
  const created = await browser('/api/v1/vaults', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: VAULT_NAME }),
  });
  vault = (await created.json()).vault;
  step('vault', `created ${vault.id}`);
} else {
  step('vault', `reusing ${vault.id}`);
}

const tokenRes = await browser(`/api/v1/vaults/${vault.id}/tokens`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: DEVICE_ID, scopes: ['vault:upload'], deviceName: DEVICE_ID }),
});
const pluginToken = (await tokenRes.json()).value;
const plugin = (path, init = {}) =>
  api(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${pluginToken}` } });

const syncBody = {
  deviceId: DEVICE_ID,
  manifestHash,
  files: entries.map(manifestEntry),
};
const plan = await (
  await plugin(`/api/v1/vaults/${vault.id}/sync/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(syncBody),
  })
).json();
step('plan', `${plan.missingBlobs.length} missing blob(s)`);

const missing = new Map(entries.map((e) => [e.hash, e]));
for (const item of plan.missingBlobs) {
  const hash = typeof item === 'string' ? item : item.hash;
  const entry = missing.get(hash);
  if (!entry) throw new Error(`Plan references unknown blob ${hash}`);
  await plugin(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
    method: 'PUT',
    headers: { 'content-type': entry.mimeType, 'x-tephra-blob-size': String(entry.size) },
    body: entry.bytes,
  });
}
const commit = await (
  await plugin(`/api/v1/vaults/${vault.id}/sync/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(syncBody),
  })
).json();
step('commit', `${commit.status} @rev ${commit.revision}`);

// Verify every markdown note renders and the graph resolves.
const files = await (await browser(`/api/v1/vaults/${vault.id}/files`)).json();
let rendered = 0;
for (const file of files.files.filter((f) => f.kind === 'markdown')) {
  const note = await (await browser(`/api/v1/vaults/${vault.id}/files/${file.fileId}/rendered`)).json();
  if (typeof note.html !== 'string' || note.html.length === 0) throw new Error(`Empty render: ${file.path}`);
  rendered += 1;
}
const graph = await (await browser(`/api/v1/vaults/${vault.id}/graph`)).json();
step('rendered', `${rendered}/${files.files.filter((f) => f.kind === 'markdown').length} notes`);
step('graph', `${graph.nodes.length} nodes / ${graph.edges.length} edges`);
console.log('[sync] DONE');
