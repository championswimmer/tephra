#!/usr/bin/env node
// Black-box API parity harness (plan 023, Phase 0-J).
//
// Runs one deterministic scripted scenario against a FRESH Tephra server
// (Node or Go) and writes a normalised snapshot of every request/response.
// Two snapshots are compared with compare.mjs.
//
//   node e2e/parity/run.mjs --base http://127.0.0.1:8080 --out out.json \
//        [--bootstrap-token TOKEN]      (or TEPHRA_BOOTSTRAP_TOKEN)
//
// Dependency-free: Node >= 22 built-ins and global fetch only.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (opt('base') ?? '').replace(/\/+$/, '');
const OUT = opt('out');
const BOOTSTRAP_TOKEN = opt('bootstrap-token') ?? process.env.TEPHRA_BOOTSTRAP_TOKEN;
if (!BASE || !OUT || !BOOTSTRAP_TOKEN) {
  console.error('usage: run.mjs --base URL --out file.json --bootstrap-token TOKEN');
  process.exit(2);
}

// ------------------------------------------------------------ normalisation
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SECRET = /\btp[a-z]_[A-Za-z0-9_-]{16,}/g;
const ids = new Map();
const idOf = (raw) => {
  const key = raw.toLowerCase();
  if (!ids.has(key)) ids.set(key, ids.size + 1);
  return `<id:${ids.get(key)}>`;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BASE_RE = new RegExp(escapeRe(BASE), 'g');
const HOSTPORT_RE = new RegExp(escapeRe(new URL(BASE).host), 'g');
const TS_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'lastSeenAt',
  'lastUsedAt',
  'revokedAt',
  'lastSyncedAt',
  'mtime',
]);

function str(value) {
  return value
    .replace(BASE_RE, '<base>')
    .replace(HOSTPORT_RE, '<host>')
    .replace(SECRET, '<secret>')
    .replace(UUID, idOf);
}

function norm(value, key) {
  if (typeof value === 'string') {
    // JSON embedded in a string (MCP tool results): normalise structurally.
    if (/^[[{]/.test(value)) {
      try {
        return { '<json-string>': norm(JSON.parse(value)) };
      } catch {
        /* plain string */
      }
    }
    return str(value);
  }
  if (typeof value === 'number') {
    if (key === 'client_id_issued_at') return '<ts>';
    if (TS_KEYS.has(key) && value >= 1e11) return '<ts>';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => norm(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[str(k)] = norm(v, k);
    return out;
  }
  return value;
}

// Set-Cookie: keep name, attribute text, flags; replace the value.
function cookieShape(line) {
  const [pair, ...attrs] = line.split(/;\s*/);
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  return [`${name}=${value === '' ? '' : '<secret>'}`, ...attrs.map(str)].join('; ');
}

// Node orders several lists by random UUIDv7 tie-breakers (same-millisecond rows:
// api_tokens/vaults by created_at,id; links and file_versions by id; graph edges follow
// link order). That order is not reproducible between runs, so it cannot be part of
// parity: such lists are put in a canonical order BEFORE ids are numbered. Everything
// else keeps the order the API produced.
const cmpJson = (x, y) =>
  JSON.stringify(x) < JSON.stringify(y) ? -1 : JSON.stringify(x) > JSON.stringify(y) ? 1 : 0;
const withoutId = (link) =>
  Object.fromEntries(Object.entries(link).filter(([key]) => key !== 'id'));
function canonicalize(method, path, json) {
  if (method !== 'GET' || json === null || typeof json !== 'object') return json;
  const route = path.split('?')[0];
  if (/^\/api\/v1\/vaults$/.test(route) && Array.isArray(json.vaults))
    return { ...json, vaults: [...json.vaults].sort((a, b) => cmpJson(a.name, b.name)) };
  if (/\/tokens$/.test(route) && Array.isArray(json.tokens))
    return {
      ...json,
      tokens: [...json.tokens].sort((a, b) =>
        cmpJson([a.name, a.scopes, a.expiresAt], [b.name, b.scopes, b.expiresAt]),
      ),
    };
  if (/\/(?:links|backlinks)$/.test(route) && Array.isArray(json.links))
    return { ...json, links: [...json.links].sort((a, b) => cmpJson(withoutId(a), withoutId(b))) };
  if (/\/graph$/.test(route) && Array.isArray(json.edges))
    return { ...json, edges: [...json.edges].sort((a, b) => a.s - b.s || a.t - b.t) };
  if (/\/changes$/.test(route) && Array.isArray(json.changes)) {
    // A truncated page cuts a same-revision group at a random point: only its size is stable.
    if (json.truncated)
      return {
        ...json,
        changes: {
          '<count>': json.changes.length,
          '<revisions>': [...new Set(json.changes.map((c) => c.revision))],
        },
      };
    return {
      ...json,
      changes: [...json.changes].sort((a, b) => a.revision - b.revision || cmpJson(a.path, b.path)),
    };
  }
  return json;
}

const HEADERS = [
  'content-type',
  'etag',
  'cache-control',
  'allow',
  'www-authenticate',
  'location',
  'content-disposition',
  'content-security-policy',
  'x-content-type-options',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'vary',
  'pragma',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ------------------------------------------------------------------ driver
const steps = [];

/**
 * Executes and records one request.
 * opts: as ('session' | 'bearer' | undefined), token, csrf (false | string),
 *       csrfHeader, headers, json, body, form, soft, expectHeaderRequestId
 */
async function step(name, method, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.as === 'session') {
    headers.cookie = state.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && opts.csrf !== false)
      headers[opts.csrfHeader ?? 'x-tephra-csrf'] =
        typeof opts.csrf === 'string' ? opts.csrf : state.csrf;
  } else if (opts.as === 'cookie-only') {
    headers.cookie = state.cookie; // deliberately no csrf header
  } else if (opts.as === 'bearer') {
    headers.authorization = `Bearer ${opts.token}`;
  }
  let body;
  if (opts.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    body = opts.body;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: 'manual' });
  const bytes = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') ?? '';
  let raw = null;
  let recorded = null;
  if (bytes.length > 0) {
    if (/json/.test(ct)) {
      try {
        raw = JSON.parse(bytes.toString('utf8'));
        recorded = { json: norm(canonicalize(method, path, raw)) };
      } catch {
        recorded = { text: str(bytes.toString('utf8')) };
      }
    } else if (/^text\/(plain|markdown)/.test(ct) && bytes.length <= 4096) {
      recorded = { text: str(bytes.toString('utf8')) };
    } else {
      recorded = { bytes: bytes.length, sha256: sha256(bytes) };
    }
  }
  const outHeaders = {};
  for (const h of HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) outHeaders[h] = str(v);
  }
  const rid = res.headers.get('x-request-id');
  if (rid !== null) {
    outHeaders['x-request-id'] =
      opts.headers?.['x-request-id'] && rid === opts.headers['x-request-id']
        ? '<echo>'
        : /^[0-9a-f-]{36}$/i.test(rid)
          ? '<uuid>'
          : rid;
  }
  const cookies = res.headers.getSetCookie();
  if (cookies.length) outHeaders['set-cookie'] = cookies.map(cookieShape);
  const entry = {
    n: steps.length + 1,
    name,
    method,
    path: str(path),
    status: res.status,
    headers: outHeaders,
    body: recorded,
  };
  if (opts.soft) entry.soft = true;
  steps.push(entry);
  return {
    status: res.status,
    json: raw,
    headers: res.headers,
    cookies,
    bytes,
    text: bytes.toString('utf8'),
  };
}

const state = { cookie: '', csrf: '' };

// Polls (unrecorded) until the asynchronous indexer has caught up.
async function waitIndexed(vault) {
  for (let i = 0; i < 200; i += 1) {
    const res = await fetch(`${BASE}/api/v1/vaults/${vault}/graph`, {
      headers: { cookie: state.cookie },
    });
    await res.arrayBuffer();
    const m = /^W\/"(\d+)-(\d+)-graph/.exec(res.headers.get('etag') ?? '');
    if (m && m[1] === m[2]) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`indexing did not finish for ${vault}`);
}

// ------------------------------------------------------------ manifest bits
const cp = (s) => Array.from(s).map((c) => c.codePointAt(0));
function cmpPath(a, b) {
  const x = cp(a),
    y = cp(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
function manifestHash(files) {
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

let mtimeCounter = 1_700_000_000;
function file(fileId, path, content, mimeType, kind) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const entry = {
    fileId,
    path,
    hash: sha256(bytes),
    size: bytes.length,
    mtime: (mtimeCounter += 10),
    ...(mimeType === undefined ? {} : { mimeType }),
    kind: kind ?? (path.endsWith('.md') ? 'markdown' : 'attachment'),
  };
  Object.defineProperty(entry, 'bytes', { value: bytes, enumerable: false });
  return entry;
}
const syncBody = (deviceId, files) => ({
  deviceId,
  manifestHash: manifestHash(files),
  files: [...files].sort((l, r) => cmpPath(l.path, r.path)),
});

// ------------------------------------------------------------------ content
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const HOME_V1 = `---
title: Home Page
tags: [index, demo]
aliases: [Start]
---
# Home

Welcome to [[Projects/Plan]] and [[Plan|the plan alias]]. See [[Second Note#Details]] and [[Missing Note]].

![[diagram.png]]

![[Second Note]]

> [!note] A callout
> Body of the callout with [[Home]] link.

> [!warning]- Collapsed warning
> be careful

| Name | Value |
| ---- | ----: |
| a    | 1     |
| b    | 2     |

- [ ] todo
- [x] done

#tag-one and #nested/tag

==highlight== and ~~strike~~ and %%hidden comment%%

[External](https://example.com) and <https://example.org> and [rel](Projects/Plan.md).

\`\`\`js
console.log("hi");
\`\`\`

Footnote[^1].

[^1]: The note.

A paragraph with a block id ^blk1
`;
const SECOND = `# Second Note

Back to [[Home]] and [[Home#Home|home heading]]. Also [[Café/Ünï]].

## Details

Some #detail-tag text. Embed ![[Home#^blk1]].
`;
const PLAN_V1 = '# Plan\n\nThe plan links to [[Home]] and [[Notes/Second Note]].\n';
const PLAN_V2 = '# Plan\n\nThe plan v2 links to [[Home]].\n';
const UNICODE = '# Ünï\n\nUnicode note linking [[Home]].\n';
const DUP_A = '# Dup upper\n';
const DUP_B = '# Dup lower\n';
const THIRD = '---\ntags: [third]\n---\n# Third\n\nLinks [[Home]] and [[Notes/Renamed Note]].\n';
const PDF = Buffer.from('%PDF-1.4\n% parity fixture\n', 'utf8');
const HTML = '<html><body><script>alert(1)</script></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
const BIN = Buffer.from([0, 1, 2, 3, 254, 255]);

const MD = 'text/markdown';
const F = {
  home: file('note-home', 'Home.md', HOME_V1, MD),
  second: file('note-second', 'Notes/Second Note.md', SECOND, MD),
  plan: file('note-plan', 'Projects/Plan.md', PLAN_V1, MD),
  unicode: file('note-unicode', 'Café/Ünï.md', UNICODE, MD),
  dupA: file('note-dup-a', 'Case/Dup.md', DUP_A, MD),
  dupB: file('note-dup-b', 'Case/dup.md', DUP_B, MD),
  png: file('att-png', 'diagram.png', PNG, 'image/png'),
  pdf: file('att-pdf', 'Files/report.pdf', PDF, 'application/pdf'),
  html: file('att-html', 'Files/page.html', HTML, 'text/html'),
  svg: file('att-svg', 'Files/vector.svg', SVG, 'image/svg+xml'),
  bin: file('att-bin', 'Files/blob.bin', BIN, undefined),
};
const REV1 = Object.values(F);
const putBlob = (vault, f, as, token, extra = {}) =>
  step(`blob upload ${f.path}`, 'PUT', `/api/v1/vaults/${vault}/blobs/${f.hash}`, {
    as,
    token,
    headers: {
      'content-type': f.mimeType ?? 'application/octet-stream',
      'x-tephra-blob-size': String(f.size),
      ...(extra.headers ?? {}),
    },
    body: extra.body ?? f.bytes,
  });

// =================================================================== SCENARIO
const EMAIL = 'admin@example.com';
const PASSWORD = 'parity-password-123';

// ---- A. health, discovery, static, misc ---------------------------------
await step('healthz', 'GET', '/healthz');
await step('healthz HEAD', 'HEAD', '/healthz');
await step('healthz echoes valid request id', 'GET', '/healthz', {
  headers: { 'x-request-id': '11111111-2222-4333-8444-555555555555' },
});
await step('healthz replaces invalid request id', 'GET', '/healthz', {
  headers: { 'x-request-id': 'not-a-uuid' },
});
await step('readyz', 'GET', '/readyz');
await step('bootstrap status (fresh)', 'GET', '/api/v1/auth/bootstrap/status');
await step('mcp GET not allowed', 'GET', '/mcp');
await step('mcp DELETE not allowed', 'DELETE', '/mcp');
await step('mcp POST without auth', 'POST', '/mcp', {
  json: { jsonrpc: '2.0', id: 1, method: 'ping' },
});
await step('well-known protected resource', 'GET', '/.well-known/oauth-protected-resource', {
  headers: { origin: 'https://client.example' },
});
await step(
  'well-known protected resource /mcp',
  'GET',
  '/.well-known/oauth-protected-resource/mcp',
);
await step('well-known authorization server', 'GET', '/.well-known/oauth-authorization-server');
await step('well-known forwarded host/proto', 'GET', '/.well-known/oauth-authorization-server', {
  headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'tephra.example.test' },
});
await step('oauth token CORS preflight', 'OPTIONS', '/oauth/token', {
  headers: {
    origin: 'https://client.example',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
});
await step('oauth register CORS preflight', 'OPTIONS', '/oauth/register', {
  headers: { origin: 'https://client.example', 'access-control-request-method': 'POST' },
});
await step('api v1 unknown path unauthenticated', 'GET', '/api/v1/does-not-exist');
await step('api v1 vaults unauthenticated', 'GET', '/api/v1/vaults');
await step('api v1 vaults bad bearer', 'GET', '/api/v1/vaults', {
  as: 'bearer',
  token: 'tpt_not-a-real-token-value-0000',
});
await step('api v1 vaults bad cookie', 'GET', '/api/v1/vaults', {
  headers: { cookie: 'tephra_session=tps_bogus-session-cookie-value' },
});

// ---- B. bootstrap & auth --------------------------------------------------
await step('bootstrap invalid json', 'POST', '/api/v1/auth/bootstrap', {
  body: '{not json',
  headers: { 'content-type': 'application/json' },
});
await step('bootstrap missing token', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: PASSWORD },
});
await step('bootstrap short password', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: 'short', token: BOOTSTRAP_TOKEN },
});
await step('bootstrap invalid email', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: 'nope', password: PASSWORD, token: BOOTSTRAP_TOKEN },
});
await step('bootstrap unknown field', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: PASSWORD, token: BOOTSTRAP_TOKEN, extra: 1 },
});
await step('bootstrap wrong token', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: PASSWORD, token: 'wrong-token' },
});
await step('bootstrap wrong token (alias field)', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: PASSWORD, bootstrapToken: 'wrong-token' },
});
await step('login before any user', 'POST', '/api/v1/auth/login', {
  json: { email: EMAIL, password: PASSWORD },
});
await step('bootstrap success (email lower-cased)', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: 'Admin@Example.com', password: PASSWORD, token: ` ${BOOTSTRAP_TOKEN} ` },
});
await step('bootstrap again', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: PASSWORD, token: BOOTSTRAP_TOKEN },
});
await step('bootstrap again wrong token', 'POST', '/api/v1/auth/bootstrap', {
  json: { email: EMAIL, password: PASSWORD, token: 'x' },
});
await step('bootstrap status (after)', 'GET', '/api/v1/auth/bootstrap/status');
await step('login wrong password', 'POST', '/api/v1/auth/login', {
  json: { email: EMAIL, password: 'wrong-password-123' },
});
await step('login unknown user', 'POST', '/api/v1/auth/login', {
  json: { email: 'ghost@example.com', password: PASSWORD },
});
await step('login invalid body', 'POST', '/api/v1/auth/login', { json: { email: EMAIL } });
await step('login short password', 'POST', '/api/v1/auth/login', {
  json: { email: EMAIL, password: 'short' },
});
await step('login body too large', 'POST', '/api/v1/auth/login', {
  json: { email: EMAIL, password: 'p'.repeat(2_200_000) },
});
const login = await step('login success (mixed-case email)', 'POST', '/api/v1/auth/login', {
  json: { email: 'ADMIN@example.com', password: PASSWORD },
});
state.csrf = login.json.csrfToken;
state.sessionToken = login.json.sessionToken;
state.cookie = login.cookies.map((c) => c.split(';')[0]).join('; ');

await step('me with cookie', 'GET', '/api/v1/auth/me', { as: 'session' });
await step('me with bearer session token', 'GET', '/api/v1/auth/me', {
  as: 'bearer',
  token: state.sessionToken,
});
await step('logout without csrf', 'POST', '/api/v1/auth/logout', { as: 'cookie-only' });
await step('logout wrong csrf', 'POST', '/api/v1/auth/logout', { as: 'session', csrf: 'wrong' });
await step('obsidian-sync capability (disabled)', 'GET', '/api/v1/obsidian-sync', {
  as: 'session',
});
await step('obsidian-sync capability without auth', 'GET', '/api/v1/obsidian-sync');
await step('obsidian-sync account (unavailable)', 'GET', '/api/v1/obsidian-sync/account', {
  as: 'session',
});
await step(
  'obsidian-sync account login (unavailable)',
  'POST',
  '/api/v1/obsidian-sync/account/login',
  { as: 'session', json: { email: EMAIL, password: PASSWORD } },
);
await step(
  'obsidian-sync account login bad body (unavailable)',
  'POST',
  '/api/v1/obsidian-sync/account/login',
  { as: 'session', json: { nope: 1 } },
);

// ---- C. vaults -------------------------------------------------------------
await step('vaults list empty', 'GET', '/api/v1/vaults', { as: 'session' });
await step('vault create without csrf', 'POST', '/api/v1/vaults', {
  as: 'cookie-only',
  json: { name: 'alpha' },
});
for (const [label, name] of [
  ['empty name', ''],
  ['slash', 'a/b'],
  ['backslash', 'a\\b'],
  ['dot', '.'],
  ['dotdot', '..'],
  ['control char', 'a\u0007b'],
  ['too long', 'n'.repeat(201)],
])
  await step(`vault create invalid name (${label})`, 'POST', '/api/v1/vaults', {
    as: 'session',
    json: { name },
  });
await step('vault create unknown field', 'POST', '/api/v1/vaults', {
  as: 'session',
  json: { name: 'x', foo: 1 },
});
await step('vault create bad syncMode', 'POST', '/api/v1/vaults', {
  as: 'session',
  json: { name: 'x', syncMode: 'dropbox' },
});
await step('vault create obsidian mode (service disabled)', 'POST', '/api/v1/vaults', {
  as: 'session',
  json: { name: 'obs', syncMode: 'obsidian' },
});
const alpha = (
  await step('vault create alpha', 'POST', '/api/v1/vaults', {
    as: 'session',
    json: { name: 'alpha' },
  })
).json.vault;
await step('vault create duplicate', 'POST', '/api/v1/vaults', {
  as: 'session',
  json: { name: 'alpha' },
});
await (
  await step('vault create beta (csrf via x-csrf-token)', 'POST', '/api/v1/vaults', {
    as: 'session',
    csrfHeader: 'x-csrf-token',
    json: { name: 'beta', syncMode: 'tephra' },
  })
).json.vault;
const gamma = (
  await step('vault create gamma (name trimmed)', 'POST', '/api/v1/vaults', {
    as: 'session',
    json: { name: '  gamma  ' },
  })
).json.vault;
await step('vaults list', 'GET', '/api/v1/vaults', { as: 'session' });
await step('vaults list via bearer session', 'GET', '/api/v1/vaults', {
  as: 'bearer',
  token: state.sessionToken,
});
await step('vault get by id', 'GET', `/api/v1/vaults/${alpha.id}`, { as: 'session' });
await step('vault get by name', 'GET', '/api/v1/vaults/alpha', { as: 'session' });
await step('vault get unknown', 'GET', '/api/v1/vaults/nope', { as: 'session' });
await step('vault obsidian-sync on tephra vault', 'GET', '/api/v1/vaults/alpha/obsidian-sync', {
  as: 'session',
});
await step(
  'vault obsidian-sync setup on tephra vault',
  'POST',
  '/api/v1/vaults/alpha/obsidian-sync/setup',
  { as: 'session', json: { remoteVaultId: 'r1' } },
);
await step(
  'vault obsidian-sync login on tephra vault',
  'POST',
  '/api/v1/vaults/alpha/obsidian-sync/login',
  { as: 'session', json: { email: EMAIL, password: PASSWORD } },
);
await step(
  'vault obsidian-sync remotes on tephra vault',
  'GET',
  '/api/v1/vaults/alpha/obsidian-sync/remotes',
  { as: 'session' },
);
await step(
  'vault obsidian-sync enable on tephra vault',
  'PUT',
  '/api/v1/vaults/alpha/obsidian-sync',
  { as: 'session', json: { enabled: true } },
);
await step('vault obsidian-sync unknown vault', 'GET', '/api/v1/vaults/nope/obsidian-sync', {
  as: 'session',
});
await step('vault delete wrong confirmation', 'DELETE', `/api/v1/vaults/${gamma.id}`, {
  as: 'session',
  json: { confirmation: 'wrong' },
});
await step('vault delete missing body', 'DELETE', `/api/v1/vaults/${gamma.id}`, { as: 'session' });
await step('vault delete gamma', 'DELETE', `/api/v1/vaults/${gamma.id}`, {
  as: 'session',
  json: { confirmation: 'gamma' },
});
await step('vault get deleted gamma', 'GET', `/api/v1/vaults/${gamma.id}`, { as: 'session' });

// ---- D. tokens ---------------------------------------------------------------
await step('tokens list empty', 'GET', '/api/v1/vaults/alpha/tokens', { as: 'session' });
await step('token create empty scopes', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: { name: 't', scopes: [] },
});
await step('token create bad scope', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: { name: 't', scopes: ['vault:root'] },
});
await step('token create unknown field', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: { name: 't', admin: true },
});
await step('token create bad expiresAt', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: { name: 't', expiresAt: -5 },
});
await step('token create blank name', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: { name: '   ' },
});
await step('token create unknown vault', 'POST', '/api/v1/vaults/nope/tokens', {
  as: 'session',
  json: { name: 't' },
});
const tokSync = (
  await step('token create plugin (device)', 'POST', '/api/v1/vaults/alpha/tokens', {
    as: 'session',
    json: { name: 'Plugin', deviceId: 'device-plugin-1', deviceName: 'Laptop', platform: 'macos' },
  })
).json.value;
await step('token create plugin (same device updates)', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: {
    name: 'Plugin 2',
    deviceId: 'device-plugin-1',
    deviceName: 'Laptop Renamed',
    platform: 'linux',
  },
});
const tokWrite = (
  await step('token create write', 'POST', '/api/v1/vaults/alpha/tokens', {
    as: 'session',
    json: { name: 'Writer', scopes: ['vault:read-metadata', 'vault:write'], deviceName: 'Agent' },
  })
).json.value;
const tokRead = (
  await step('token create read-only', 'POST', '/api/v1/vaults/alpha/tokens', {
    as: 'session',
    json: { name: 'Reader', scopes: ['vault:read-metadata'] },
  })
).json.value;
const tokUploadOnly = (
  await step('token create upload-only', 'POST', '/api/v1/vaults/alpha/tokens', {
    as: 'session',
    json: { name: 'UploadOnly', scopes: ['vault:upload'] },
  })
).json.value;
const tokWriteOnly = (
  await step('token create write-only', 'POST', '/api/v1/vaults/alpha/tokens', {
    as: 'session',
    json: { name: 'WriteOnly', scopes: ['vault:write'] },
  })
).json.value;
const tokExpired = (
  await step('token create already expired', 'POST', '/api/v1/vaults/alpha/tokens', {
    as: 'session',
    json: { name: 'Expired', expiresAt: 1 },
  })
).json.value;
const tokFuture = await step(
  'token create with future expiry',
  'POST',
  '/api/v1/vaults/alpha/tokens',
  { as: 'session', json: { name: 'Future', expiresAt: 4102444800000 } },
);
const tokToRevoke = await step('token create to revoke', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
  json: { name: 'Revoked' },
});
const tokBeta = (
  await step('token create beta', 'POST', '/api/v1/vaults/beta/tokens', {
    as: 'session',
    json: { name: 'Beta' },
  })
).json.value;
const tokBetaId = (
  await step('tokens list beta', 'GET', '/api/v1/vaults/beta/tokens', { as: 'session' })
).json.tokens[0].id;
await step('tokens list alpha', 'GET', '/api/v1/vaults/alpha/tokens', { as: 'session' });
await step('tokens list with a token (session required)', 'GET', '/api/v1/vaults/alpha/tokens', {
  as: 'bearer',
  token: tokSync,
});
await step('token create with a token (session required)', 'POST', '/api/v1/vaults/alpha/tokens', {
  as: 'bearer',
  token: tokSync,
  json: { name: 'nested' },
});
await step(
  'token revoke with a token (session required)',
  'DELETE',
  `/api/v1/vaults/alpha/tokens/${tokToRevoke.json.token.id}`,
  { as: 'bearer', token: tokSync },
);
await step('token revoke unknown', 'DELETE', '/api/v1/vaults/alpha/tokens/nope', { as: 'session' });
await step('token revoke other vault token', 'DELETE', `/api/v1/vaults/alpha/tokens/${tokBetaId}`, {
  as: 'session',
});
await step('token revoke', 'DELETE', `/api/v1/vaults/alpha/tokens/${tokToRevoke.json.token.id}`, {
  as: 'session',
});
await step('revoked token rejected', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: tokToRevoke.json.value,
});
await step('expired token rejected', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: tokExpired,
});
await step('future-expiry token accepted', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: tokFuture.json.value,
});
await step('tokens list after revoke', 'GET', '/api/v1/vaults/alpha/tokens', { as: 'session' });
await step('wrong-vault token on alpha', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: tokBeta,
});
await step('wrong-vault token on alpha by id', 'GET', `/api/v1/vaults/${alpha.id}/files`, {
  as: 'bearer',
  token: tokBeta,
});
await step('alpha token on beta', 'GET', '/api/v1/vaults/beta/files', {
  as: 'bearer',
  token: tokSync,
});
await step('alpha token on unknown vault', 'GET', '/api/v1/vaults/nope/files', {
  as: 'bearer',
  token: tokSync,
});
await step('upload-only token cannot read', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: tokUploadOnly,
});
await step('vault get with token', 'GET', '/api/v1/vaults/alpha', { as: 'bearer', token: tokRead });
await step('vault delete with token (session required)', 'DELETE', '/api/v1/vaults/alpha', {
  as: 'bearer',
  token: tokSync,
  json: { confirmation: 'alpha' },
});

// ---- E. sync protocol --------------------------------------------------------
const body1 = syncBody('device-plugin-1', REV1);
await step('sync plan without auth', 'POST', '/api/v1/vaults/alpha/sync/plan', { json: body1 });
await step('sync plan read-only token', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokRead,
  json: body1,
});
await step('sync plan write-only token', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokWriteOnly,
  json: body1,
});
await step('sync plan wrong-vault token', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokBeta,
  json: body1,
});
await step('sync plan invalid json', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  body: 'nope',
  headers: { 'content-type': 'application/json' },
});
await step('sync plan unknown field', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: { ...body1, extra: 1 },
});
await step('sync plan manifest hash mismatch', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: { ...body1, manifestHash: '0'.repeat(64) },
});
await step('sync plan malformed manifest hash', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: { ...body1, manifestHash: 'ABC' },
});
await step('sync plan duplicate path', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: {
    deviceId: 'd',
    manifestHash: '0'.repeat(64),
    files: [F.home, { ...F.home, fileId: 'other' }],
  },
});
await step('sync plan duplicate fileId', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: {
    deviceId: 'd',
    manifestHash: '0'.repeat(64),
    files: [F.home, { ...F.second }, { ...F.plan, fileId: F.home.fileId }],
  },
});
for (const [label, path] of [
  ['parent traversal', '../x.md'],
  ['absolute', '/x.md'],
  ['backslash', 'a\\b.md'],
  ['empty segment', 'a//b.md'],
  ['NFD', 'Café.md'],
]) {
  const bad = { ...F.home, path };
  await step(`sync plan invalid path (${label})`, 'POST', '/api/v1/vaults/alpha/sync/plan', {
    as: 'bearer',
    token: tokSync,
    json: { deviceId: 'd', manifestHash: '0'.repeat(64), files: [bad] },
  });
}
await step('sync plan unsorted manifest', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: {
    deviceId: 'd',
    manifestHash: manifestHash([F.second, F.home]),
    files: [F.second, F.home],
  },
});
await step('sync plan with session (allowed)', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'session',
  json: body1,
});
await step('sync plan by id', 'POST', `/api/v1/vaults/${alpha.id}/sync/plan`, {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step('sync plan empty manifest', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: syncBody('device-plugin-1', []),
});

// blob upload errors
await step('blob upload without auth', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  body: F.home.bytes,
  headers: { 'x-tephra-blob-size': String(F.home.size) },
});
await step('blob upload read-only token', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  as: 'bearer',
  token: tokRead,
  body: F.home.bytes,
});
await step('blob upload invalid hash param', 'PUT', '/api/v1/vaults/alpha/blobs/not-a-hash', {
  as: 'bearer',
  token: tokSync,
  body: 'x',
  headers: { 'x-tephra-blob-size': '1' },
});
await step('blob upload hash mismatch', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  as: 'bearer',
  token: tokSync,
  body: Buffer.from('tampered'),
  headers: { 'x-tephra-blob-size': '8', 'content-type': MD },
});
await step('blob upload size mismatch', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  as: 'bearer',
  token: tokSync,
  body: F.home.bytes,
  headers: { 'x-tephra-blob-size': String(F.home.size + 1), 'content-type': MD },
});
await step('blob upload bad declared size', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  as: 'bearer',
  token: tokSync,
  body: F.home.bytes,
  headers: { 'x-tephra-blob-size': 'abc', 'content-type': MD },
});
await step(
  'blob upload negative declared size',
  'PUT',
  `/api/v1/vaults/alpha/blobs/${F.home.hash}`,
  {
    as: 'bearer',
    token: tokSync,
    body: F.home.bytes,
    headers: { 'x-tephra-blob-size': '-1', 'content-type': MD },
  },
);
await step('blob upload too large declared', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  as: 'bearer',
  token: tokSync,
  body: F.home.bytes,
  headers: { 'x-tephra-blob-size': '999999999999', 'content-type': MD },
});
await step('blob upload wrong vault token', 'PUT', `/api/v1/vaults/alpha/blobs/${F.home.hash}`, {
  as: 'bearer',
  token: tokBeta,
  body: F.home.bytes,
  headers: { 'x-tephra-blob-size': String(F.home.size) },
});
await step('blob upload with session cookie', 'PUT', `/api/v1/vaults/alpha/blobs/${F.png.hash}`, {
  as: 'session',
  body: F.png.bytes,
  headers: { 'x-tephra-blob-size': String(F.png.size), 'content-type': 'image/png' },
});

// commit before blobs exist
await step('commit missing blobs', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step('plan after partial upload', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
// upload the rest (include duplicate-content upload for stored:false)
for (const f of REV1) if (f !== F.png) await putBlob('alpha', f, 'bearer', tokSync);
await putBlob('alpha', F.home, 'bearer', tokSync); // repeat => stored:false
await step('plan all uploaded', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});

await step('commit without auth', 'POST', '/api/v1/vaults/alpha/sync/commit', { json: body1 });
await step('commit with session (token required)', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'session',
  json: body1,
});
await step('commit read-only token', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'bearer',
  token: tokRead,
  json: body1,
});
await step('commit manifest hash mismatch', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'bearer',
  token: tokSync,
  json: { ...body1, manifestHash: '1'.repeat(64) },
});
await step('commit unknown vault', 'POST', '/api/v1/vaults/nope/sync/commit', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step('commit wrong vault token', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'bearer',
  token: tokBeta,
  json: body1,
});
await step('commit revision 1', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step('commit same manifest again (idempotent)', 'POST', '/api/v1/vaults/alpha/sync/commit', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step('plan after commit (up-to-date)', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step(
  'commit to vault with other token still blocked',
  'POST',
  '/api/v1/vaults/beta/sync/commit',
  { as: 'bearer', token: tokSync, json: body1 },
);
await waitIndexed('alpha');
await step('vault get after commit', 'GET', '/api/v1/vaults/alpha', { as: 'session' });
await step('tokens list after use (lastUsedAt)', 'GET', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
});

// ---- F. reads at revision 1 --------------------------------------------------
await step('files list', 'GET', '/api/v1/vaults/alpha/files', { as: 'session' });
await step('tree list', 'GET', '/api/v1/vaults/alpha/tree', { as: 'bearer', token: tokRead });
await step('files list by id with token', 'GET', `/api/v1/vaults/${alpha.id}/files`, {
  as: 'bearer',
  token: tokSync,
});
await step('file get', 'GET', '/api/v1/vaults/alpha/files/note-home', { as: 'session' });
await step('file get unknown', 'GET', '/api/v1/vaults/alpha/files/nope', { as: 'session' });
await step('file get without auth', 'GET', '/api/v1/vaults/alpha/files/note-home');
await step('file content markdown', 'GET', '/api/v1/vaults/alpha/files/note-home/content', {
  as: 'session',
});
await step('file raw markdown', 'GET', '/api/v1/vaults/alpha/files/note-home/raw', {
  as: 'bearer',
  token: tokRead,
});
await step('attachment png', 'GET', '/api/v1/vaults/alpha/attachments/att-png', { as: 'session' });
await step('attachment pdf', 'GET', '/api/v1/vaults/alpha/attachments/att-pdf', { as: 'session' });
await step(
  'attachment html (forced download)',
  'GET',
  '/api/v1/vaults/alpha/attachments/att-html',
  { as: 'session' },
);
await step('attachment svg (forced download)', 'GET', '/api/v1/vaults/alpha/attachments/att-svg', {
  as: 'session',
});
await step('attachment octet-stream (no mime)', 'GET', '/api/v1/vaults/alpha/files/att-bin/raw', {
  as: 'session',
});
await step('attachment unknown', 'GET', '/api/v1/vaults/alpha/attachments/nope', { as: 'session' });
await step('content unknown', 'GET', '/api/v1/vaults/alpha/files/nope/content', { as: 'session' });
await step(
  'rendered note (wikilinks, callouts, tables, embeds)',
  'GET',
  '/api/v1/vaults/alpha/files/note-home/rendered',
  { as: 'session' },
);
await step('rendered second note', 'GET', '/api/v1/vaults/alpha/files/note-second/rendered', {
  as: 'session',
});
await step('rendered unicode note', 'GET', '/api/v1/vaults/alpha/files/note-unicode/rendered', {
  as: 'session',
});
await step('rendered attachment rejected', 'GET', '/api/v1/vaults/alpha/files/att-png/rendered', {
  as: 'session',
});
await step('rendered unknown', 'GET', '/api/v1/vaults/alpha/files/nope/rendered', {
  as: 'session',
});
await step('links for note', 'GET', '/api/v1/vaults/alpha/files/note-home/links', {
  as: 'session',
});
await step('backlinks for note', 'GET', '/api/v1/vaults/alpha/files/note-home/backlinks', {
  as: 'session',
});
await step('links unknown file', 'GET', '/api/v1/vaults/alpha/files/nope/links', { as: 'session' });
await step('backlinks unknown file', 'GET', '/api/v1/vaults/alpha/files/nope/backlinks', {
  as: 'session',
});
await step('all links', 'GET', '/api/v1/vaults/alpha/links', { as: 'session' });
await step('search by path', 'GET', '/api/v1/vaults/alpha/search?q=second', { as: 'session' });
await step(
  'search by title (case-insensitive)',
  'GET',
  '/api/v1/vaults/alpha/search?q=HOME%20PAGE',
  { as: 'session' },
);
await step('search unicode', 'GET', `/api/v1/vaults/alpha/search?q=${encodeURIComponent('ünï')}`, {
  as: 'session',
});
await step('search with limit', 'GET', '/api/v1/vaults/alpha/search?q=.md&limit=2', {
  as: 'session',
});
await step('search limit clamp and junk', 'GET', '/api/v1/vaults/alpha/search?q=.md&limit=abc', {
  as: 'session',
});
await step('search limit zero', 'GET', '/api/v1/vaults/alpha/search?q=.md&limit=0', {
  as: 'session',
});
await step('search limit huge', 'GET', '/api/v1/vaults/alpha/search?q=a&limit=100000', {
  as: 'session',
});
await step('search no match', 'GET', '/api/v1/vaults/alpha/search?q=zzzzzz', { as: 'session' });
await step('search missing q', 'GET', '/api/v1/vaults/alpha/search', { as: 'session' });
await step('search blank q', 'GET', '/api/v1/vaults/alpha/search?q=%20%20', { as: 'session' });
await step('search q too long', 'GET', `/api/v1/vaults/alpha/search?q=${'a'.repeat(201)}`, {
  as: 'session',
});

// resolve
const q = (p) => `/api/v1/vaults/alpha/resolve?path=${encodeURIComponent(p)}`;
await step('resolve exact', 'GET', q('Home.md'), { as: 'session' });
await step('resolve nested exact', 'GET', q('Projects/Plan.md'), { as: 'bearer', token: tokRead });
await step('resolve NFD request normalised', 'GET', q('Café/Ünï.md'), { as: 'session' });
await step('resolve case-only miss', 'GET', q('home.md'), { as: 'session' });
await step('resolve ambiguous case', 'GET', q('CASE/DUP.md'), { as: 'session' });
await step('resolve exact among case variants', 'GET', q('Case/dup.md'), { as: 'session' });
await step('resolve unknown', 'GET', q('Nope.md'), { as: 'session' });
await step('resolve invalid path (traversal)', 'GET', q('../x.md'), { as: 'session' });
await step('resolve invalid path (leading slash)', 'GET', q('/x.md'), { as: 'session' });
await step('resolve missing path', 'GET', '/api/v1/vaults/alpha/resolve', { as: 'session' });
await step('resolve empty path', 'GET', '/api/v1/vaults/alpha/resolve?path=', { as: 'session' });
await step('resolve without auth', 'GET', q('Home.md'));

// changes at rev 1
await step('changes since 0', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=0', {
  as: 'session',
});
await step(
  'changes since 0 limit 3',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=0&limit=3',
  { as: 'bearer', token: tokSync },
);
await step('changes at latest', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=1', {
  as: 'session',
});
await step('changes ahead of server', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=99', {
  as: 'session',
});
await step('changes missing since', 'GET', '/api/v1/vaults/alpha/changes', { as: 'session' });
await step('changes empty since', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=', {
  as: 'session',
});
await step('changes negative since', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=-1', {
  as: 'session',
});
await step('changes fractional since', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=1.5', {
  as: 'session',
});
await step('changes junk since', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=abc', {
  as: 'session',
});
await step('changes limit zero', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=0&limit=0', {
  as: 'session',
});
await step('changes limit junk', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=0&limit=x', {
  as: 'session',
});
await step(
  'changes limit clamp 500',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=0&limit=100000',
  { as: 'session' },
);
await step('changes upload-only token', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=0', {
  as: 'bearer',
  token: tokUploadOnly,
});
await step('changes without auth', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=0');

// graph + ETag
const g1 = await step('graph', 'GET', '/api/v1/vaults/alpha/graph', { as: 'session' });
const etag1 = g1.headers.get('etag');
await step('graph If-None-Match hit (304)', 'GET', '/api/v1/vaults/alpha/graph', {
  as: 'session',
  headers: { 'if-none-match': etag1 },
});
await step('graph If-None-Match stale', 'GET', '/api/v1/vaults/alpha/graph', {
  as: 'session',
  headers: { 'if-none-match': 'W/"0-0-graph-v3"' },
});
await step('graph with token', 'GET', '/api/v1/vaults/alpha/graph', {
  as: 'bearer',
  token: tokRead,
});
await step('graph upload-only token', 'GET', '/api/v1/vaults/alpha/graph', {
  as: 'bearer',
  token: tokUploadOnly,
});
await step('graph without auth', 'GET', '/api/v1/vaults/alpha/graph');
await step('graph of empty vault', 'GET', '/api/v1/vaults/beta/graph', { as: 'session' });
await step('files of empty vault', 'GET', '/api/v1/vaults/beta/files', { as: 'session' });
await step('changes of empty vault', 'GET', '/api/v1/vaults/beta/changes?sinceRevision=0', {
  as: 'session',
});

// ---- G. web edit ---------------------------------------------------------------
const put = (name, fileId, content, o = {}) =>
  step(name, 'PUT', `/api/v1/vaults/alpha/files/${fileId}/content`, {
    as: o.as === 'none' ? undefined : (o.as ?? 'session'),
    token: o.token,
    csrf: o.csrf,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      ...(o.ifMatch === undefined ? {} : { 'if-match': o.ifMatch }),
      ...(o.headers ?? {}),
    },
    body: content,
  });
const EDIT1 = `${HOME_V1}\nEdited on the web.\n`;
await put('web edit without if-match', 'note-home', EDIT1);
await put('web edit malformed if-match', 'note-home', EDIT1, { ifMatch: 'not-a-hash' });
await put('web edit unknown file', 'nope', EDIT1, { ifMatch: F.home.hash });
await put('web edit non-markdown file', 'att-png', 'x', { ifMatch: F.png.hash });
await put('web edit size mismatch', 'note-home', EDIT1, {
  ifMatch: F.home.hash,
  headers: { 'x-tephra-content-size': '3' },
});
await put('web edit bad declared size', 'note-home', EDIT1, {
  ifMatch: F.home.hash,
  headers: { 'x-tephra-content-size': 'abc' },
});
await put('web edit too large', 'note-home', EDIT1, {
  ifMatch: F.home.hash,
  headers: { 'x-tephra-content-size': '999999999999' },
});
await put('web edit without csrf', 'note-home', EDIT1, { ifMatch: F.home.hash, csrf: false });
await put('web edit without auth', 'note-home', EDIT1, { as: 'none', ifMatch: F.home.hash });
await put('web edit upload-only token', 'note-home', EDIT1, {
  as: 'bearer',
  token: tokUploadOnly,
  ifMatch: F.home.hash,
});
await put('web edit read-only token', 'note-home', EDIT1, {
  as: 'bearer',
  token: tokRead,
  ifMatch: F.home.hash,
});
await put('web edit wrong-vault token', 'note-home', EDIT1, {
  as: 'bearer',
  token: tokBeta,
  ifMatch: F.home.hash,
});
await put('web edit stale if-match (conflict)', 'note-home', EDIT1, { ifMatch: 'a'.repeat(64) });
await put('web edit identical content (up-to-date)', 'note-home', HOME_V1, {
  ifMatch: F.home.hash,
});
await put('web edit success', 'note-home', EDIT1, { ifMatch: F.home.hash });
const EDIT1_HASH = sha256(Buffer.from(EDIT1));
await put(
  'web edit again with old if-match (conflict with current)',
  'note-home',
  `${EDIT1}more\n`,
  { ifMatch: F.home.hash },
);
const EDIT2 = `${EDIT1}Second web edit via angle brackets.\n`;
await put('web edit if-match angle brackets', 'note-home', EDIT2, { ifMatch: `<${EDIT1_HASH}>` });
const EDIT2_HASH = sha256(Buffer.from(EDIT2));
const EDIT3 = `${EDIT2}Third via quoted if-match and write token.\n`;
await put('web edit quoted if-match with write token', 'note-home', EDIT3, {
  as: 'bearer',
  token: tokWrite,
  ifMatch: `"${EDIT2_HASH}"`,
});
const EDIT3_HASH = sha256(Buffer.from(EDIT3));
await put('web edit write-only token', 'note-second', `${SECOND}x\n`, {
  as: 'bearer',
  token: tokWriteOnly,
  ifMatch: F.second.hash,
});
await put('web edit via bearer session (no csrf)', 'note-dup-a', '# Dup upper edited\n', {
  as: 'bearer',
  token: state.sessionToken,
  ifMatch: F.dupA.hash,
});
await waitIndexed('alpha');
await step('rendered after web edit', 'GET', '/api/v1/vaults/alpha/files/note-home/rendered', {
  as: 'session',
});
await step('content after web edit', 'GET', '/api/v1/vaults/alpha/files/note-home/content', {
  as: 'session',
});
await step('changes after web edits', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=1', {
  as: 'session',
});
await step(
  'changes paged after web edits (limit 2)',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=1&limit=2',
  { as: 'session' },
);
await step('changes paged page 2', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=3&limit=2', {
  as: 'session',
});
const g2 = await step('graph after web edit (new etag)', 'GET', '/api/v1/vaults/alpha/graph', {
  as: 'session',
  headers: { 'if-none-match': etag1 },
});
await step('graph old etag no longer matches', 'GET', '/api/v1/vaults/alpha/graph', {
  as: 'session',
  headers: { 'if-none-match': g2.headers.get('etag') },
});
await step('vault revision after web edits', 'GET', '/api/v1/vaults/alpha', { as: 'session' });

// ---- H. further syncs: rename+modify (alone), then modify/rename/add/delete ------
// (Node emits one change entry for a rename+modify only if both rows of that file are adjacent
//  in its random-id order, so that case runs in a revision of its own to stay reproducible.)
const HOME_NOW = file('note-home', 'Home.md', EDIT3, MD);
const DUPA_NOW = file('note-dup-a', 'Case/Dup.md', '# Dup upper edited\n', MD);
const PLAN_V2F = file('note-plan', 'Projects/Plan v2.md', PLAN_V2, MD);
const syncStep = async (label, files) => {
  const body = syncBody('device-plugin-1', files);
  const plan = await step(`plan ${label}`, 'POST', '/api/v1/vaults/alpha/sync/plan', {
    as: 'bearer',
    token: tokSync,
    json: body,
  });
  for (const m of plan.json.missingBlobs)
    await putBlob(
      'alpha',
      files.find((x) => x.hash === m.hash),
      'bearer',
      tokSync,
    );
  await step(`commit ${label}`, 'POST', '/api/v1/vaults/alpha/sync/commit', {
    as: 'bearer',
    token: tokSync,
    json: body,
  });
  await waitIndexed('alpha');
  return body;
};
const SECOND_NOW = file('note-second', 'Notes/Second Note.md', `${SECOND}x\n`, MD);
const REV_A = [
  HOME_NOW,
  SECOND_NOW,
  PLAN_V2F,
  F.unicode,
  DUPA_NOW,
  F.dupB,
  F.png,
  F.pdf,
  F.html,
  F.svg,
  F.bin,
];
await syncStep('rename+modify', REV_A);
const F2 = {
  home: file('note-home', 'Home.md', `${EDIT3}\nAppended by the plugin with [[Third]].\n`, MD),
  second: { ...SECOND_NOW, path: 'Notes/Renamed Note.md' },
  third: file('note-third', 'Notes/Third.md', THIRD, MD),
};
const REV_B = [
  F2.home,
  F2.second,
  F2.third,
  PLAN_V2F,
  F.unicode,
  DUPA_NOW,
  F.dupB,
  F.png,
  F.pdf,
  F.html,
  F.svg,
]; // blob.bin deleted
await syncStep('modify+rename+create+delete', REV_B);
await step(
  'recommit revision-1 manifest (stale/old manifest is up-to-date)',
  'POST',
  '/api/v1/vaults/alpha/sync/commit',
  { as: 'bearer', token: tokSync, json: body1 },
);
await step('plan old manifest (up-to-date)', 'POST', '/api/v1/vaults/alpha/sync/plan', {
  as: 'bearer',
  token: tokSync,
  json: body1,
});
await step(
  'web edit stale after sync (conflict)',
  'PUT',
  `/api/v1/vaults/alpha/files/note-home/content`,
  {
    as: 'session',
    headers: { 'content-type': MD, 'if-match': EDIT3_HASH },
    body: `${EDIT3}stale\n`,
  },
);
await step('files list after second sync', 'GET', '/api/v1/vaults/alpha/files', { as: 'session' });
await step(
  'changes since 0 after second sync',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=0&limit=500',
  { as: 'session' },
);
await step(
  'changes rename+modify revision',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=6&limit=1',
  { as: 'session' },
);
await step(
  'changes since last page (rename/delete/create)',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=7',
  { as: 'session' },
);
await step(
  'changes paged limit 1 from 7',
  'GET',
  '/api/v1/vaults/alpha/changes?sinceRevision=7&limit=1',
  { as: 'session' },
);
await step('resolve historic (renamed)', 'GET', q('Notes/Second Note.md'), { as: 'session' });
await step('resolve historic rename+modify', 'GET', q('Projects/Plan.md'), { as: 'session' });
await step('resolve deleted', 'GET', q('Files/blob.bin'), { as: 'session' });
await step('resolve new path exact', 'GET', q('Projects/Plan v2.md'), { as: 'session' });
await step('file get deleted', 'GET', '/api/v1/vaults/alpha/files/att-bin', { as: 'session' });
await step('rendered after rename', 'GET', '/api/v1/vaults/alpha/files/note-home/rendered', {
  as: 'session',
});
await step('rendered third', 'GET', '/api/v1/vaults/alpha/files/note-third/rendered', {
  as: 'session',
});
await step('links all after second sync', 'GET', '/api/v1/vaults/alpha/links', { as: 'session' });
await step('backlinks after second sync', 'GET', '/api/v1/vaults/alpha/files/note-home/backlinks', {
  as: 'session',
});
await step('search tag title after second sync', 'GET', '/api/v1/vaults/alpha/search?q=third', {
  as: 'session',
});
await step('graph after second sync', 'GET', '/api/v1/vaults/alpha/graph', { as: 'session' });

// ---- I. MCP --------------------------------------------------------------------
let rpcId = 100;
const rpc = (method, params, id = (rpcId += 1)) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const mcp = (name, token, message, o = {}) =>
  step(name, 'POST', '/mcp', { as: 'bearer', token, json: message, ...o });
const call = (name, tool, args, token = tokWrite, o = {}) =>
  mcp(name, token, rpc('tools/call', { name: tool, arguments: args }), o);

await step('mcp without auth', 'POST', '/mcp', { json: rpc('ping') });
await step('mcp cookie session refused', 'POST', '/mcp', { as: 'session', json: rpc('ping') });
await step('mcp bad bearer', 'POST', '/mcp', {
  as: 'bearer',
  token: 'tpt_definitely-not-valid-0000000',
  json: rpc('ping'),
});
await step('mcp revoked token', 'POST', '/mcp', {
  as: 'bearer',
  token: tokToRevoke.json.value,
  json: rpc('ping'),
});
await step('mcp expired token', 'POST', '/mcp', {
  as: 'bearer',
  token: tokExpired,
  json: rpc('ping'),
});
await step('mcp parse error', 'POST', '/mcp', {
  as: 'bearer',
  token: tokWrite,
  body: '{oops',
  headers: { 'content-type': 'application/json' },
});
await mcp('mcp empty batch', tokWrite, []);
await mcp(
  'mcp initialize (supported version)',
  tokWrite,
  rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'parity', version: '1' },
  }),
);
await mcp(
  'mcp initialize (unsupported version)',
  tokWrite,
  rpc('initialize', { protocolVersion: '1999-01-01' }),
);
await mcp('mcp initialize (no params)', tokWrite, rpc('initialize'));
await mcp('mcp ping', tokWrite, rpc('ping'));
await mcp('mcp notification initialized', tokWrite, {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
});
await mcp('mcp unknown notification', tokWrite, { jsonrpc: '2.0', method: 'something/else' });
await mcp('mcp unknown method', tokWrite, rpc('resources/list'));
await mcp('mcp invalid request (no method)', tokWrite, { jsonrpc: '2.0', id: 7 });
await mcp('mcp invalid request (wrong version)', tokWrite, {
  jsonrpc: '1.0',
  id: 8,
  method: 'ping',
});
await mcp('mcp tools/list', tokWrite, rpc('tools/list'));
await mcp('mcp batch (ping + list + notification)', tokWrite, [
  rpc('ping', undefined, 1),
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  rpc('tools/list', undefined, 3),
]);
await mcp('mcp batch of only notifications', tokWrite, [
  { jsonrpc: '2.0', method: 'notifications/initialized' },
]);
await call('mcp unknown tool', 'frobnicate', {});
await call('mcp list_vaults (token bound)', 'list_vaults', {});
await call('mcp list_vaults (session as bearer)', 'list_vaults', {}, state.sessionToken);
await call('mcp search_notes', 'search_notes', { query: 'home' });
await call('mcp search_notes with limit and vault name', 'search_notes', {
  vault: 'alpha',
  query: '.md',
  limit: 3,
});
await call('mcp search_notes invalid args', 'search_notes', { query: '' }, tokWrite, {
  soft: true,
});
await call(
  'mcp search_notes limit out of range',
  'search_notes',
  { query: 'a', limit: 1000 },
  tokWrite,
  { soft: true },
);
await call('mcp read_note', 'read_note', { path: 'Home.md' });
await call('mcp read_note case-insensitive', 'read_note', { path: 'home.md' });
await call('mcp read_note ambiguous case', 'read_note', { path: 'CASE/DUP.md' });
await call('mcp read_note missing', 'read_note', { path: 'Missing.md' });
await call('mcp read_note attachment', 'read_note', { path: 'diagram.png' });
await call('mcp read_note wrong vault arg', 'read_note', { vault: 'beta', path: 'Home.md' });
await call('mcp read_note unknown vault', 'read_note', { vault: 'nope', path: 'Home.md' });
await call(
  'mcp read_note session needs vault arg',
  'read_note',
  { path: 'Home.md' },
  state.sessionToken,
);
await call(
  'mcp read_note session with vault arg',
  'read_note',
  { vault: 'alpha', path: 'Home.md' },
  state.sessionToken,
);
await call(
  'mcp read_note beta token cannot read alpha',
  'read_note',
  { vault: 'alpha', path: 'Home.md' },
  tokBeta,
);
await call('mcp read_note missing path arg', 'read_note', {}, tokWrite, { soft: true });
await call(
  'mcp create_note read-only token',
  'create_note',
  { path: 'Agent/New.md', content: 'x' },
  tokRead,
);
await call(
  'mcp create_note upload-only token',
  'create_note',
  { path: 'Agent/New.md', content: 'x' },
  tokUploadOnly,
);
await call('mcp create_note invalid path', 'create_note', { path: '../x.md', content: 'x' });
await call('mcp create_note not .md', 'create_note', { path: 'Agent/new.txt', content: 'x' });
await call('mcp create_note', 'create_note', {
  path: 'Agent/New.md',
  content: '# Agent note\n\nLinks to [[Home]].\n',
});
await call('mcp create_note existing (case clash)', 'create_note', {
  path: 'agent/new.md',
  content: 'x',
});
await waitIndexed('alpha');
const readNew = await call('mcp read_note created', 'read_note', { path: 'Agent/New.md' });
const newHash = readNew.json.result.structuredContent.blobHash;
await call('mcp update_note neither patch nor content', 'update_note', { path: 'Agent/New.md' });
await call('mcp update_note both patch and content', 'update_note', {
  path: 'Agent/New.md',
  patch: '@@ -1 +1 @@\n-a\n+b\n',
  content: 'x',
  baseHash: newHash,
});
await call('mcp update_note content without baseHash', 'update_note', {
  path: 'Agent/New.md',
  content: 'x',
});
await call('mcp update_note stale baseHash', 'update_note', {
  path: 'Agent/New.md',
  content: 'x',
  baseHash: 'f'.repeat(64),
});
await call('mcp update_note patch mismatch', 'update_note', {
  path: 'Agent/New.md',
  patch: '@@ -1,1 +1,1 @@\n-nothing like this\n+whatever\n',
});
await call('mcp update_note patch', 'update_note', {
  path: 'Agent/New.md',
  patch:
    '@@ -1,3 +1,3 @@\n # Agent note\n \n-Links to [[Home]].\n+Links to [[Home]] and [[Second Note]].\n',
  baseHash: newHash,
});
const readNew2 = await call('mcp read_note after patch', 'read_note', { path: 'Agent/New.md' });
const newHash2 = readNew2.json.result.structuredContent.blobHash;
await call('mcp update_note identical content (up-to-date)', 'update_note', {
  path: 'Agent/New.md',
  content: readNew2.json.result.structuredContent.content,
  baseHash: newHash2,
});
await call('mcp update_note full content', 'update_note', {
  path: 'Agent/New.md',
  content: '# Agent note v3\n',
  baseHash: newHash2,
});
await call('mcp update_note missing note', 'update_note', {
  path: 'Agent/Gone.md',
  content: 'x',
  baseHash: newHash2,
});
await call(
  'mcp update_note read-only token',
  'update_note',
  { path: 'Agent/New.md', content: 'x', baseHash: newHash2 },
  tokRead,
);
await waitIndexed('alpha');
await call('mcp search_notes finds created', 'search_notes', { query: 'agent' });
await step('changes include mcp writes', 'GET', '/api/v1/vaults/alpha/changes?sinceRevision=8', {
  as: 'session',
});

// ---- J. OAuth (PKCE) ---------------------------------------------------------------
const VERIFIER = 'parity-verifier-'.padEnd(64, 'v');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1:53682/callback';
await step('oauth register not json', 'POST', '/oauth/register', {
  body: 'nope',
  headers: { 'content-type': 'text/plain' },
});
await step('oauth register missing redirect_uris', 'POST', '/oauth/register', {
  json: { client_name: 'x' },
});
await step('oauth register empty redirect_uris', 'POST', '/oauth/register', {
  json: { redirect_uris: [] },
});
await step('oauth register https redirect refused', 'POST', '/oauth/register', {
  json: { client_name: 'x', redirect_uris: ['https://evil.example/cb'] },
});
await step('oauth register redirect with fragment refused', 'POST', '/oauth/register', {
  json: { redirect_uris: ['http://127.0.0.1/cb#frag'] },
});
await step('oauth register credentials in redirect refused', 'POST', '/oauth/register', {
  json: { redirect_uris: ['http://user:pw@127.0.0.1/cb'] },
});
await step('oauth register too many redirects', 'POST', '/oauth/register', {
  json: { redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${3000 + i}/cb`) },
});
const reg = await step('oauth register', 'POST', '/oauth/register', {
  headers: { origin: 'https://client.example' },
  json: { client_name: 'Claude Code', redirect_uris: [REDIRECT] },
});
const clientId = reg.json.client_id;
await step('oauth register native scheme + default name', 'POST', '/oauth/register', {
  json: {
    redirect_uris: [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'http://localhost:9999/cb',
      'http://[::1]:9999/cb',
    ],
  },
});
const authQ = (o = {}) =>
  new URLSearchParams(
    Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz',
      ...o,
    }).filter(([, v]) => v !== undefined),
  ).toString();
await step('oauth authorize ok (redirect to consent)', 'GET', `/oauth/authorize?${authQ()}`);
await step(
  'oauth authorize without state',
  'GET',
  `/oauth/authorize?${authQ({ state: undefined })}`,
);
await step(
  'oauth authorize other loopback port',
  'GET',
  `/oauth/authorize?${authQ({ redirect_uri: 'http://127.0.0.1:60000/callback' })}`,
);
await step(
  'oauth authorize different path refused',
  'GET',
  `/oauth/authorize?${authQ({ redirect_uri: 'http://127.0.0.1:53682/other' })}`,
);
await step(
  'oauth authorize evil redirect refused',
  'GET',
  `/oauth/authorize?${authQ({ redirect_uri: 'https://evil.example/cb' })}`,
);
await step(
  'oauth authorize bad response_type',
  'GET',
  `/oauth/authorize?${authQ({ response_type: 'token' })}`,
);
await step(
  'oauth authorize bad challenge method',
  'GET',
  `/oauth/authorize?${authQ({ code_challenge_method: 'plain' })}`,
);
await step(
  'oauth authorize short challenge',
  'GET',
  `/oauth/authorize?${authQ({ code_challenge: 'short' })}`,
);
await step('oauth authorize missing params', 'GET', '/oauth/authorize');
await step(
  'oauth authorize opaque client id',
  'GET',
  `/oauth/authorize?${authQ({ client_id: 'some-public-client' })}`,
);

const cq = (o = {}) =>
  `/api/v1/oauth/client?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, ...o })}`;
await step('oauth client info without auth', 'GET', cq());
await step('oauth client info', 'GET', cq(), { as: 'session' });
await step(
  'oauth client info bad redirect',
  'GET',
  cq({ redirect_uri: 'https://evil.example/cb' }),
  { as: 'session' },
);
await step('oauth client info missing params', 'GET', '/api/v1/oauth/client', { as: 'session' });
await step('oauth client info with token (session required)', 'GET', cq(), {
  as: 'bearer',
  token: tokWrite,
});

const decide = (name, body, o = {}) =>
  step(name, 'POST', '/api/v1/oauth/authorize', {
    as: 'session',
    json: { clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE, state: 'xyz', ...body },
    ...o,
  });
const codeFrom = (res) => new URL(res.json.redirectUrl).searchParams.get('code');
await step('oauth approve without csrf', 'POST', '/api/v1/oauth/authorize', {
  as: 'cookie-only',
  json: {
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    decision: 'approve',
    vaultId: alpha.id,
  },
});
await step('oauth approve with token (session required)', 'POST', '/api/v1/oauth/authorize', {
  as: 'bearer',
  token: tokWrite,
  json: {
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    decision: 'approve',
    vaultId: alpha.id,
  },
});
await decide('oauth approve invalid decision', { decision: 'maybe' });
await decide('oauth approve bad redirect', {
  decision: 'approve',
  vaultId: alpha.id,
  redirectUri: 'https://evil.example/cb',
});
await decide('oauth approve bad challenge', {
  decision: 'approve',
  vaultId: alpha.id,
  codeChallenge: 'short',
});
await decide('oauth deny', { decision: 'deny' });
await decide('oauth deny without state', { decision: 'deny', state: undefined });
await decide('oauth approve without vault', { decision: 'approve' });
await decide('oauth approve unknown vault', { decision: 'approve', vaultId: 'nope' });
await decide('oauth approve vault by name refused', { decision: 'approve', vaultId: 'alpha' });
await decide('oauth approve bad access', {
  decision: 'approve',
  vaultId: alpha.id,
  access: 'admin',
});

const tokenReq = (name, form, o = {}) =>
  step(name, 'POST', '/oauth/token', { form, headers: o.headers, json: o.json, soft: o.soft });
const exch = (code, extra = {}) => ({
  grant_type: 'authorization_code',
  code,
  code_verifier: VERIFIER,
  redirect_uri: REDIRECT,
  client_id: clientId,
  ...extra,
});

await tokenReq('oauth token wrong grant type', { grant_type: 'password' });
await tokenReq('oauth token missing params', { grant_type: 'authorization_code' });
await tokenReq('oauth token bad verifier format', exch('tpc_x', { code_verifier: 'short' }));
await tokenReq('oauth token unknown code', exch('tpc_unknown-code-value-0000000000'));
const approveA = await decide('oauth approve (write)', {
  decision: 'approve',
  vaultId: alpha.id,
  access: 'write',
});
const codeA = codeFrom(approveA);
await tokenReq(
  'oauth token wrong verifier (consumes code)',
  exch(codeA, { code_verifier: 'x'.repeat(64) }),
);
await tokenReq('oauth token code already consumed', exch(codeA));
const codeB = codeFrom(
  await decide('oauth approve (for wrong client)', { decision: 'approve', vaultId: alpha.id }),
);
await tokenReq('oauth token wrong client id', exch(codeB, { client_id: 'other' }));
const codeC = codeFrom(
  await decide('oauth approve (for wrong redirect)', { decision: 'approve', vaultId: alpha.id }),
);
await tokenReq(
  'oauth token wrong redirect uri',
  exch(codeC, { redirect_uri: 'http://127.0.0.1:1/callback' }),
);
const codeD = codeFrom(
  await decide('oauth approve (read)', {
    decision: 'approve',
    vaultId: alpha.id,
    access: 'read',
    state: undefined,
  }),
);
const readTok = await tokenReq('oauth token exchange (form, read-only)', exch(codeD));
const codeE = codeFrom(
  await decide('oauth approve (write, json exchange)', { decision: 'approve', vaultId: alpha.id }),
);
const writeTok = await step('oauth token exchange (json body, write)', 'POST', '/oauth/token', {
  json: exch(codeE),
});
await tokenReq('oauth token replay after success', exch(codeE));
const oRead = readTok.json.access_token;
const oWrite = writeTok.json.access_token;
await mcp('oauth token: tools/list (read-only)', oRead, rpc('tools/list'));
await call('oauth token: list_vaults', 'list_vaults', {}, oRead);
await call('oauth token: read_note', 'read_note', { path: 'Home.md' }, oRead);
await call(
  'oauth token: create_note denied (read-only)',
  'create_note',
  { path: 'Agent/OAuth.md', content: 'x' },
  oRead,
);
await call(
  'oauth token: create_note (write)',
  'create_note',
  { path: 'Agent/OAuth.md', content: '# OAuth note\n' },
  oWrite,
);
await call(
  'oauth token: other vault denied',
  'read_note',
  { vault: 'beta', path: 'Home.md' },
  oWrite,
);
await step('oauth token as REST api token', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: oRead,
});
await step(
  'oauth token cannot list tokens (session required)',
  'GET',
  '/api/v1/vaults/alpha/tokens',
  { as: 'bearer', token: oWrite },
);
await step('tokens list shows oauth tokens', 'GET', '/api/v1/vaults/alpha/tokens', {
  as: 'session',
});
await waitIndexed('alpha');

// ---- K. static assets / SPA fallback -------------------------------------------------
const index = await step('static index', 'GET', '/');
await step('static index.html explicit', 'GET', '/index.html');
const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(index.text)?.[1];
if (asset) await step('static asset from index', 'GET', asset);
await step('static missing asset', 'GET', '/assets/does-not-exist.js');
await step('static logo', 'GET', '/logo-main.svg');
await step('favicon.ico', 'GET', '/favicon.ico');
await step('spa fallback route', 'GET', '/vaults/alpha/notes/Home.md');
await step('spa fallback connect', 'GET', '/connect?client_id=x');
await step('spa fallback unknown api prefix', 'GET', '/api/unknown');
await step('POST unknown route', 'POST', '/does-not-exist', { json: {} });
await step('unknown api v1 route authenticated', 'GET', '/api/v1/does-not-exist', {
  as: 'session',
});
await step('POST unknown api v1 route authenticated', 'POST', '/api/v1/does-not-exist', {
  as: 'session',
  json: {},
});
await step('HEAD static index', 'HEAD', '/');
await step('healthz POST not allowed', 'POST', '/healthz');

// ---- L. logout, delete vault, cascade -----------------------------------------------
const login2 = await step('login again', 'POST', '/api/v1/auth/login', {
  json: { email: EMAIL, password: PASSWORD },
});
const saved = { ...state };
state.csrf = login2.json.csrfToken;
state.cookie = login2.cookies.map((c) => c.split(';')[0]).join('; ');
await step('logout', 'POST', '/api/v1/auth/logout', { as: 'session' });
await step('me with logged-out cookie', 'GET', '/api/v1/auth/me', { as: 'session' });
await step('me with logged-out bearer', 'GET', '/api/v1/auth/me', {
  as: 'bearer',
  token: login2.json.sessionToken,
});
Object.assign(state, saved);
await step('delete beta wrong confirmation', 'DELETE', '/api/v1/vaults/beta', {
  as: 'session',
  json: { confirmation: 'alpha' },
});
await step('delete beta', 'DELETE', '/api/v1/vaults/beta', {
  as: 'session',
  json: { confirmation: 'beta' },
});
await step('beta token after vault delete', 'GET', '/api/v1/vaults/beta/files', {
  as: 'bearer',
  token: tokBeta,
});
await step('delete alpha', 'DELETE', '/api/v1/vaults/alpha', {
  as: 'session',
  json: { confirmation: 'alpha' },
});
await step('alpha files after delete', 'GET', '/api/v1/vaults/alpha/files', { as: 'session' });
await step('alpha token after vault delete', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: tokSync,
});
await step('oauth token after vault delete', 'GET', '/api/v1/vaults/alpha/files', {
  as: 'bearer',
  token: oWrite,
});
await step('mcp oauth token after vault delete', 'POST', '/mcp', {
  as: 'bearer',
  token: oWrite,
  json: rpc('tools/call', { name: 'list_vaults', arguments: {} }),
});
await step('vaults list at end', 'GET', '/api/v1/vaults', { as: 'session' });

// ---------------------------------------------------------------------- output
writeFileSync(OUT, `${JSON.stringify({ version: 1, steps }, null, 2)}\n`);
console.log(`parity: recorded ${steps.length} steps -> ${OUT}`);
