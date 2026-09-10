import { Hono, type Context } from 'hono';
import { z, ZodError, type ZodType } from 'zod';
import type { Database, TransactionRepositories } from '@tephra/database-core';
import type { BlobStore } from '@tephra/blob-store-core';
import type { Clock, IdGenerator, PasswordHasher } from '@tephra/core';
import {
  canAccessVault,
  clearSessionCookie,
  constantTimeSecretEqual,
  createOpaqueToken,
  hashOpaqueToken,
  parseCookies,
  sessionCookie,
  tokenIsActive,
  type AuthPrincipal,
} from '@tephra/auth';
import {
  hashManifest,
  isCanonicalVaultPath,
  MINIMUM_PLUGIN_VERSION,
  PROTOCOL_VERSION,
  sha256Hex,
  sha256Schema,
  syncCommitBodySchema,
  syncPlanBodySchema,
  type ApiErrorCode,
  type SyncManifestEntry,
} from '@tephra/protocol';
import {
  diffRevision,
  type ApiTokenScope,
  type CurrentVaultFile,
  type Vault,
} from '@tephra/vault-model';

const JSON_LIMIT = 2 * 1024 * 1024;
const DEFAULT_BLOB_LIMIT = 100 * 1024 * 1024;
const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface IndexService {
  indexVault?(vaultId: string, revision: number): Promise<void>;
  renderMarkdown?(input: { vaultId: string; fileId: string; markdown: string }): Promise<unknown>;
  search?(input: { vaultId: string; query: string; limit: number }): Promise<unknown[]>;
}

export interface ApiDependencies {
  database: Database;
  blobStore: BlobStore;
  clock: Clock;
  ids: IdGenerator;
  passwordHasher: PasswordHasher;
  bootstrapToken?: string;
  indexService?: IndexService;
  secureCookies?: boolean;
  sessionCookieName?: string;
  maxBlobBytes?: number;
}

type Variables = {
  principal: AuthPrincipal;
  requestId: string;
  logContext: Record<string, unknown>;
};
type AppContext = Context<{ Variables: Variables }>;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRequestId(incoming: string | undefined, generate: () => string): string {
  const candidate = incoming?.trim();
  if (candidate && candidate.length <= 128 && REQUEST_ID_PATTERN.test(candidate)) return candidate;
  return generate();
}

function statusFromError(error: unknown): number {
  if (error instanceof ApiFailure) return error.status;
  if (error instanceof ZodError) return 400;
  return 500;
}

function emitRequestLog(c: AppContext, requestId: string, startTime: number, status: number): void {
  const durationMs = Math.round((performance.now() - startTime) * 1000) / 1000;
  // Only the allowlisted fields below (plus sync fields attached by handlers) are
  // logged. Bearer tokens, session cookies, note contents, and passwords are never logged.
  const context = c.get('logContext') ?? {};
  process.stdout.write(
    `${JSON.stringify({ request_id: requestId, method: c.req.method, path: c.req.path, status, duration_ms: durationMs, ...context })}\n`,
  );
}

class ApiFailure extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const credentialsSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(10).max(1024),
});
const bootstrapSchema = credentialsSchema
  .extend({
    token: z.string().min(1).max(1024).optional(),
    bootstrapToken: z.string().min(1).max(1024).optional(),
  })
  .transform((data) => ({
    email: data.email,
    password: data.password,
    token: (data.token ?? data.bootstrapToken ?? "").trim(),
  }))
  .refine((data) => data.token.length > 0, {
    message: "Bootstrap token is required.",
    path: ["token"],
  });
const vaultSchema = z.strictObject({ name: z.string().trim().min(1).max(200) });
const deleteVaultSchema = z.strictObject({ confirmation: z.string().max(200) });
const scopesSchema = z
  .array(z.enum(['vault:read-metadata', 'vault:upload']))
  .min(1)
  .max(2);
const tokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  deviceId: z.string().min(1).max(200).optional(),
  deviceName: z.string().trim().min(1).max(200).optional(),
  platform: z.string().max(100).optional(),
  scopes: scopesSchema.default(['vault:read-metadata', 'vault:upload']),
  expiresAt: z.number().int().positive().safe().nullable().default(null),
});

function fail(status: ApiFailure['status'], code: ApiErrorCode, message: string): never {
  throw new ApiFailure(status, code, message);
}

async function jsonBody<T>(c: AppContext, schema: ZodType<T>): Promise<T> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > JSON_LIMIT) fail(413, 'INVALID_MANIFEST', 'Request body is too large.');
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > JSON_LIMIT) {
    fail(413, 'INVALID_MANIFEST', 'Request body is too large.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(400, 'INVALID_MANIFEST', 'Request body must be valid JSON.');
  }
  return schema.parse(value);
}

function bearer(c: AppContext): string | null {
  const value = c.req.header('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

async function authenticate(c: AppContext, dependencies: ApiDependencies): Promise<AuthPrincipal> {
  const rawBearer = bearer(c);
  if (rawBearer !== null) {
    const tokenHash = await hashOpaqueToken(rawBearer);
    const token = await dependencies.database.apiTokens.findByTokenHash(tokenHash);
    if (token !== null) {
      if (!tokenIsActive(token, dependencies.clock.now()))
        fail(401, 'TOKEN_REVOKED', 'Token is revoked or expired.');
      const user = await dependencies.database.users.findById(token.userId);
      if (user === null) fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
      return { kind: 'token', token, user };
    }

    const session = await dependencies.database.sessions.findById(tokenHash);
    if (session !== null) {
      if (session.expiresAt <= dependencies.clock.now())
        fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
      const user = await dependencies.database.users.findById(session.userId);
      if (user === null) fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
      return { kind: 'session', session, user };
    }

    fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
  }

  const cookieName = dependencies.sessionCookieName ?? 'tephra_session';
  const rawSession = parseCookies(c.req.header('cookie'))[cookieName];
  if (!rawSession) fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
  const session = await dependencies.database.sessions.findById(await hashOpaqueToken(rawSession));
  if (session === null || session.expiresAt <= dependencies.clock.now()) {
    fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
  }
  const user = await dependencies.database.users.findById(session.userId);
  if (user === null) fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
  return { kind: 'session', session, user };
}

async function ownedVault(
  c: AppContext,
  dependencies: ApiDependencies,
  scope: ApiTokenScope,
): Promise<Vault> {
  const principal = c.get('principal');
  const vaultId = z.string().min(1).parse(c.req.param('vaultId'));
  const vault = await dependencies.database.vaults.findById(vaultId);
  if (vault === null) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
  if (!canAccessVault(principal, vault, scope))
    fail(403, 'VAULT_ACCESS_DENIED', 'Access to this vault is denied.');
  return vault;
}

function requireSession(c: AppContext): Extract<AuthPrincipal, { kind: 'session' }> {
  const principal = c.get('principal');
  if (principal.kind !== 'session')
    fail(403, 'VAULT_ACCESS_DENIED', 'A browser session is required.');
  return principal;
}

function fileDto(file: CurrentVaultFile): Record<string, unknown> {
  return {
    fileId: file.fileId,
    path: file.path,
    blobHash: file.blobHash,
    size: file.size,
    mtime: file.mtime,
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    kind: file.kind,
  };
}

function syncProtocolFields(): { protocolVersion: string; minimumPluginVersion: string } {
  return { protocolVersion: PROTOCOL_VERSION, minimumPluginVersion: MINIMUM_PLUGIN_VERSION };
}

/**
 * Reads the optional sync client version headers. They are informational and
 * never rejected so older plugin releases keep working against newer servers
 * (and vice versa); the server always advertises its own versions instead.
 */
function syncClientVersions(c: AppContext): {
  pluginVersion: string | null;
  protocolVersion: string | null;
} {
  return {
    pluginVersion: c.req.header('x-tephra-plugin-version') ?? null,
    protocolVersion: c.req.header('x-tephra-protocol-version') ?? null,
  };
}

async function verifyManifest(
  files: readonly SyncManifestEntry[],
  manifestHash: string,
): Promise<void> {
  if ((await hashManifest(files)) !== manifestHash) {
    fail(400, 'INVALID_MANIFEST', 'Manifest hash does not match its canonical contents.');
  }
}

async function requireBlobs(
  repositories: Pick<TransactionRepositories, 'blobs'>,
  blobStore: BlobStore,
  files: readonly SyncManifestEntry[],
): Promise<void> {
  const unique = [...new Map(files.map((file) => [file.hash, file])).values()];
  const metadata = new Map(
    (await repositories.blobs.findByHashes(unique.map((file) => file.hash))).map((blob) => [
      blob.hash,
      blob,
    ]),
  );
  for (const file of unique) {
    const blob = metadata.get(file.hash);
    if (blob === undefined || blob.size !== file.size || !(await blobStore.has(file.hash))) {
      fail(409, 'BLOB_MISSING', `Required blob ${file.hash} is missing or has the wrong size.`);
    }
  }
}

export function createApp(dependencies: ApiDependencies): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'), () =>
      dependencies.ids.generate(),
    );
    c.set('requestId', requestId);
    c.set('logContext', {});
    c.header('X-Request-Id', requestId);
    const startTime = performance.now();
    try {
      await next();
    } catch (error) {
      emitRequestLog(c, requestId, startTime, statusFromError(error));
      throw error;
    }
    c.header('X-Request-Id', requestId);
    emitRequestLog(c, requestId, startTime, c.res.status);
  });

  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? dependencies.ids.generate();
    c.header('X-Request-Id', requestId);
    if (error instanceof ApiFailure)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof ZodError) {
      const messages = error.issues.map((issue) => issue.message);
      const code: ApiErrorCode = messages.includes('Duplicate manifest path.')
        ? 'DUPLICATE_PATH'
        : messages.includes('Duplicate manifest file ID.')
          ? 'DUPLICATE_FILE_ID'
          : messages.some((message) => message.includes('canonical vault-relative path'))
            ? 'INVALID_PATH'
            : 'INVALID_MANIFEST';
      return c.json({ error: { code, message: 'Request validation failed.' } }, 400);
    }
    console.error('Unhandled API error:', error);
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } },
      500,
    );
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    try {
      await dependencies.database.users.count();
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Service is not ready.' } }, 503);
    }
  });

  app.get('/api/v1/auth/bootstrap/status', async (c) =>
    c.json({ required: (await dependencies.database.users.count()) === 0 }),
  );
  app.post('/api/v1/auth/bootstrap', async (c) => {
    const body = await jsonBody(c, bootstrapSchema);
    if ((await dependencies.database.users.count()) !== 0)
      fail(409, 'COMMIT_FAILED', 'Bootstrap has already completed.');
    if (
      !dependencies.bootstrapToken ||
      !constantTimeSecretEqual(body.token, dependencies.bootstrapToken)
    ) {
      fail(401, 'AUTH_REQUIRED', 'Invalid bootstrap token.');
    }
    const user = await dependencies.database.transaction(async (repositories) => {
      if ((await repositories.users.count()) !== 0)
        fail(409, 'COMMIT_FAILED', 'Bootstrap has already completed.');
      const now = dependencies.clock.now();
      const created = {
        id: dependencies.ids.generate(),
        email: body.email.toLowerCase(),
        passwordHash: await dependencies.passwordHasher.hash(body.password),
        createdAt: now,
        updatedAt: now,
      };
      await repositories.users.insert(created);
      return created;
    });
    return c.json({ user: { id: user.id, email: user.email } }, 201);
  });

  app.post('/api/v1/auth/login', async (c) => {
    const body = await jsonBody(c, credentialsSchema);
    const user = await dependencies.database.users.findByEmail(body.email.toLowerCase());
    const comparisonHash =
      user?.passwordHash ?? (await dependencies.passwordHasher.hash('invalid-login-placeholder'));
    const valid = await dependencies.passwordHasher.verify(body.password, comparisonHash);
    if (!user || !user.passwordHash || !valid)
      fail(401, 'AUTH_REQUIRED', 'Invalid email or password.');
    const raw = createOpaqueToken('tps');
    const csrfToken = createOpaqueToken('tpc');
    const now = dependencies.clock.now();
    await dependencies.database.sessions.insert({
      id: await hashOpaqueToken(raw),
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_AGE_MS,
    });
    c.header(
      'Set-Cookie',
      sessionCookie(raw, {
        ...(dependencies.secureCookies === undefined ? {} : { secure: dependencies.secureCookies }),
        ...(dependencies.sessionCookieName === undefined
          ? {}
          : { name: dependencies.sessionCookieName }),
        maxAgeSeconds: SESSION_AGE_MS / 1000,
      }),
    );
    c.header(
      'Set-Cookie',
      `tephra_csrf=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Lax${dependencies.secureCookies === false ? '' : '; Secure'}; Max-Age=${SESSION_AGE_MS / 1000}`,
      { append: true },
    );
    return c.json({ user: { id: user.id, email: user.email }, sessionToken: raw, csrfToken });
  });

  app.use('/api/v1/*', async (c, next) => {
    if (
      c.req.path === '/api/v1/auth/bootstrap' ||
      c.req.path === '/api/v1/auth/login' ||
      c.req.path === '/api/v1/auth/bootstrap/status'
    )
      return next();
    const principal = await authenticate(c, dependencies);
    c.set('principal', principal);
    const isCookieSession = principal.kind === 'session' && bearer(c) === null;
    if (isCookieSession && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const csrfCookie = parseCookies(c.req.header('cookie')).tephra_csrf;
      const csrfHeader = c.req.header('x-tephra-csrf') ?? c.req.header('x-csrf-token');
      if (!csrfCookie || !csrfHeader || !constantTimeSecretEqual(csrfCookie, csrfHeader)) {
        fail(403, 'VAULT_ACCESS_DENIED', 'CSRF validation failed.');
      }
    }
    return next();
  });

  app.post('/api/v1/auth/logout', async (c) => {
    const principal = requireSession(c);
    await dependencies.database.sessions.delete(principal.session.id);
    c.header(
      'Set-Cookie',
      clearSessionCookie({
        ...(dependencies.secureCookies === undefined ? {} : { secure: dependencies.secureCookies }),
        ...(dependencies.sessionCookieName === undefined
          ? {}
          : { name: dependencies.sessionCookieName }),
      }),
    );
    return c.json({ ok: true });
  });
  app.get('/api/v1/auth/me', (c) => {
    const principal = c.get('principal');
    return c.json({ user: { id: principal.user.id, email: principal.user.email } });
  });

  app.get('/api/v1/vaults', async (c) => {
    const principal = requireSession(c);
    return c.json({ vaults: await dependencies.database.vaults.listByOwner(principal.user.id) });
  });
  app.post('/api/v1/vaults', async (c) => {
    const principal = requireSession(c);
    const body = await jsonBody(c, vaultSchema);
    const now = dependencies.clock.now();
    const vault = {
      id: dependencies.ids.generate(),
      ownerUserId: principal.user.id,
      name: body.name,
      latestRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    await dependencies.database.vaults.insert(vault);
    return c.json({ vault }, 201);
  });

  app.use('/api/v1/vaults/:vaultId/*', async (c, next) => {
    const scope =
      c.req.path.includes('/sync/') || c.req.path.includes('/blobs/')
        ? 'vault:upload'
        : 'vault:read-metadata';
    await ownedVault(c, dependencies, scope);
    return next();
  });
  app.get('/api/v1/vaults/:vaultId', async (c) =>
    c.json({ vault: await ownedVault(c, dependencies, 'vault:read-metadata') }),
  );
  app.delete('/api/v1/vaults/:vaultId', async (c) => {
    requireSession(c);
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const body = await jsonBody(c, deleteVaultSchema);
    if (body.confirmation !== vault.name)
      fail(409, 'COMMIT_FAILED', 'Vault name confirmation does not match.');
    await dependencies.database.vaults.delete(vault.id);
    return c.body(null, 204);
  });

  app.get('/api/v1/vaults/:vaultId/tokens', async (c) => {
    requireSession(c);
    const tokens = await dependencies.database.apiTokens.listByVault(c.req.param('vaultId'));
    return c.json({
      tokens: tokens.map((token) => {
        const { tokenHash, ...publicToken } = token;
        void tokenHash;
        return publicToken;
      }),
    });
  });
  app.post('/api/v1/vaults/:vaultId/tokens', async (c) => {
    const principal = requireSession(c);
    const body = await jsonBody(c, tokenSchema);
    const now = dependencies.clock.now();
    let deviceId = body.deviceId ?? null;
    if (deviceId) {
      const existingDevice = await dependencies.database.devices.findById(deviceId);
      if (existingDevice) {
        if (existingDevice.userId !== principal.user.id) {
          fail(403, 'VAULT_ACCESS_DENIED', 'Device belongs to another user.');
        }
        await dependencies.database.devices.update({
          ...existingDevice,
          ...(body.deviceName ? { name: body.deviceName } : {}),
          ...(body.platform === undefined ? {} : { platform: body.platform }),
          lastSeenAt: now,
        });
      } else {
        await dependencies.database.devices.insert({
          id: deviceId,
          userId: principal.user.id,
          name: body.deviceName ?? deviceId,
          ...(body.platform === undefined ? {} : { platform: body.platform }),
          createdAt: now,
          lastSeenAt: now,
        });
      }
    } else if (body.deviceName) {
      deviceId = dependencies.ids.generate();
      await dependencies.database.devices.insert({
        id: deviceId,
        userId: principal.user.id,
        name: body.deviceName,
        ...(body.platform === undefined ? {} : { platform: body.platform }),
        createdAt: now,
        lastSeenAt: now,
      });
    }
    const raw = createOpaqueToken('tpt');
    const token = {
      id: dependencies.ids.generate(),
      userId: principal.user.id,
      vaultId: c.req.param('vaultId'),
      deviceId,
      tokenHash: await hashOpaqueToken(raw),
      name: body.name,
      scopes: body.scopes,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: body.expiresAt,
      revokedAt: null,
    };
    await dependencies.database.apiTokens.insert(token);
    return c.json(
      {
        token: { id: token.id, name: token.name, scopes: token.scopes, expiresAt: token.expiresAt },
        value: raw,
      },
      201,
    );
  });
  app.delete('/api/v1/vaults/:vaultId/tokens/:tokenId', async (c) => {
    requireSession(c);
    const token = await dependencies.database.apiTokens.findById(c.req.param('tokenId'));
    if (!token || token.vaultId !== c.req.param('vaultId'))
      fail(404, 'VAULT_NOT_FOUND', 'Token was not found.');
    await dependencies.database.apiTokens.update({ ...token, revokedAt: dependencies.clock.now() });
    return c.body(null, 204);
  });

  app.post('/api/v1/vaults/:vaultId/sync/plan', async (c) => {
    const body = await jsonBody(c, syncPlanBodySchema);
    Object.assign(c.get('logContext'), {
      device_id: body.deviceId,
      manifest_hash: body.manifestHash,
      changed_file_count: body.files.length,
    });
    await verifyManifest(body.files, body.manifestHash);
    void syncClientVersions(c);
    const vault = await ownedVault(c, dependencies, 'vault:upload');
    Object.assign(c.get('logContext'), { vault_id: vault.id });
    const existing = await dependencies.database.vaultRevisions.findByManifestHash(
      vault.id,
      body.manifestHash,
    );
    if (existing) {
      Object.assign(c.get('logContext'), { revision: existing.revision });
      return c.json({
        status: 'up-to-date',
        latestRevision: existing.revision,
        missingBlobs: [],
        ...syncProtocolFields(),
      });
    }
    const metadata = new Map(
      (await dependencies.database.blobs.findByHashes(body.files.map((file) => file.hash))).map(
        (blob) => [blob.hash, blob],
      ),
    );
    const missingBlobs = [];
    for (const file of new Map(body.files.map((entry) => [entry.hash, entry])).values()) {
      const blob = metadata.get(file.hash);
      if (!blob || blob.size !== file.size || !(await dependencies.blobStore.has(file.hash)))
        missingBlobs.push({ hash: file.hash, size: file.size });
    }
    Object.assign(c.get('logContext'), { revision: vault.latestRevision });
    return c.json({
      status: 'upload-required',
      latestRevision: vault.latestRevision,
      missingBlobs,
      ...syncProtocolFields(),
    });
  });

  app.put('/api/v1/vaults/:vaultId/blobs/:hash', async (c) => {
    Object.assign(c.get('logContext'), { vault_id: c.req.param('vaultId') });
    const hash = sha256Schema.parse(c.req.param('hash'));
    const max = dependencies.maxBlobBytes ?? DEFAULT_BLOB_LIMIT;
    const declaredText = c.req.header('x-tephra-blob-size');
    const declared =
      declaredText === undefined ? Number(c.req.header('content-length')) : Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0)
      fail(400, 'INVALID_MANIFEST', 'A valid blob size is required.');
    if (declared > max) fail(413, 'BLOB_TOO_LARGE', 'Blob exceeds the configured size limit.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength !== declared)
      fail(400, 'BLOB_HASH_MISMATCH', 'Uploaded size does not match the declared size.');
    if (bytes.byteLength > max)
      fail(413, 'BLOB_TOO_LARGE', 'Blob exceeds the configured size limit.');
    if ((await sha256Hex(bytes)) !== hash)
      fail(400, 'BLOB_HASH_MISMATCH', 'Uploaded content does not match the declared SHA-256 hash.');
    const existing = await dependencies.database.blobs.findByHash(hash);
    if (
      existing &&
      (existing.size !== bytes.byteLength || !(await dependencies.blobStore.has(hash)))
    )
      fail(409, 'COMMIT_FAILED', 'Stored blob metadata is inconsistent.');
    if (!existing) {
      const mimeType = c.req.header('content-type');
      await dependencies.blobStore.put({
        hash,
        bytes,
        size: bytes.byteLength,
        ...(mimeType === undefined ? {} : { mimeType }),
      });
      await dependencies.database.blobs.insert({
        hash,
        size: bytes.byteLength,
        mimeType: mimeType ?? null,
        createdAt: dependencies.clock.now(),
      });
    }
    Object.assign(c.get('logContext'), { uploaded_blob_count: existing ? 0 : 1 });
    return c.json({ hash, stored: existing === null });
  });

  app.post('/api/v1/vaults/:vaultId/sync/commit', async (c) => {
    const body = await jsonBody(c, syncCommitBodySchema);
    Object.assign(c.get('logContext'), {
      vault_id: c.req.param('vaultId'),
      device_id: body.deviceId,
      manifest_hash: body.manifestHash,
      changed_file_count: body.files.length,
    });
    await verifyManifest(body.files, body.manifestHash);
    void syncClientVersions(c);
    const vaultId = c.req.param('vaultId');
    const result = await dependencies.database.transaction(async (repositories) => {
      await repositories.lockVault(vaultId);
      const vault = await repositories.vaults.findById(vaultId);
      if (!vault) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
      const principal = c.get('principal');
      if (principal.kind !== 'token')
        fail(403, 'VAULT_ACCESS_DENIED', 'An upload token is required.');
      const transactionToken = await repositories.apiTokens.findById(principal.token.id);
      if (
        !transactionToken ||
        !tokenIsActive(transactionToken, dependencies.clock.now()) ||
        transactionToken.vaultId !== vaultId ||
        !transactionToken.scopes.includes('vault:upload')
      ) {
        fail(403, 'VAULT_ACCESS_DENIED', 'Upload token cannot access this vault.');
      }
      const existing = await repositories.vaultRevisions.findByManifestHash(
        vaultId,
        body.manifestHash,
      );
      if (existing) {
        await repositories.apiTokens.update({
          ...transactionToken,
          lastUsedAt: dependencies.clock.now(),
        });
        return { status: 'up-to-date' as const, revision: existing.revision };
      }
      await requireBlobs(repositories, dependencies.blobStore, body.files);
      const now = dependencies.clock.now();
      const knownDevice = await repositories.devices.findById(body.deviceId);
      if (!knownDevice) {
        await repositories.devices.insert({
          id: body.deviceId,
          userId: transactionToken.userId,
          name: body.deviceId,
          createdAt: now,
          lastSeenAt: now,
        });
      } else {
        if (knownDevice.userId !== transactionToken.userId) {
          fail(403, 'VAULT_ACCESS_DENIED', 'Device belongs to another user.');
        }
        await repositories.devices.update({ ...knownDevice, lastSeenAt: now });
      }
      const current = await repositories.vaultFiles.listByVault(vaultId);
      const revision = vault.latestRevision + 1;
      const incoming = body.files.map(({ mimeType, ...file }) => ({
        ...file,
        blobHash: file.hash,
        ...(mimeType === undefined ? {} : { mimeType }),
      }));
      const diff = diffRevision({
        vaultId,
        revision,
        createdAt: now,
        current,
        incoming,
        ids: dependencies.ids,
      });
      await repositories.vaultRevisions.insert({
        vaultId,
        revision,
        manifestHash: body.manifestHash,
        deviceId: body.deviceId,
        createdAt: now,
      });
      if (diff.versions.length) await repositories.fileVersions.insertMany(diff.versions);
      for (const file of current)
        if (!body.files.some((incomingFile) => incomingFile.fileId === file.fileId))
          await repositories.vaultFiles.delete(vaultId, file.fileId);
      for (const file of body.files)
        await repositories.vaultFiles.upsert({
          fileId: file.fileId,
          vaultId,
          path: file.path,
          blobHash: file.hash,
          size: file.size,
          mtime: file.mtime,
          ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
          kind: file.kind,
          updatedRevision: revision,
        });
      await repositories.vaults.update({ ...vault, latestRevision: revision, updatedAt: now });
      await repositories.apiTokens.update({ ...transactionToken, lastUsedAt: now });
      return { status: 'committed' as const, revision };
    });
    if (result.status === 'committed' && dependencies.indexService?.indexVault) {
      void dependencies.indexService.indexVault(vaultId, result.revision).catch(() => undefined);
    }
    Object.assign(c.get('logContext'), { revision: result.revision });
    return c.json({ ...result, ...syncProtocolFields() });
  });

  app.get('/api/v1/vaults/:vaultId/files', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const files = await dependencies.database.vaultFiles.listByVault(vault.id);
    return c.json({ revision: vault.latestRevision, files: files.map(fileDto) });
  });
  app.get('/api/v1/vaults/:vaultId/tree', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const files = await dependencies.database.vaultFiles.listByVault(vault.id);
    return c.json({ revision: vault.latestRevision, files: files.map(fileDto) });
  });
  app.get('/api/v1/vaults/:vaultId/search', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const query = z.string().trim().min(1).max(200).parse(c.req.query('q'));
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
    const results = dependencies.indexService?.search
      ? await dependencies.indexService.search({ vaultId: vault.id, query, limit })
      : (await dependencies.database.vaultFiles.listByVault(vault.id))
          .filter((file) => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .slice(0, limit)
          .map(fileDto);
    return c.json({ revision: vault.latestRevision, results });
  });

  const findFile = async (c: AppContext): Promise<CurrentVaultFile> => {
    const vaultId = z.string().min(1).parse(c.req.param('vaultId'));
    const fileId = z.string().min(1).parse(c.req.param('fileId'));
    const file = await dependencies.database.vaultFiles.findById(vaultId, fileId);
    if (!file) fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
    return file;
  };
  app.get('/api/v1/vaults/:vaultId/resolve', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const raw = c.req.query('path');
    if (raw === undefined || raw.length === 0) fail(400, 'INVALID_PATH', 'A path query parameter is required.');
    const requestedPath = raw;
    const normalized = requestedPath.normalize('NFC');
    if (!isCanonicalVaultPath(normalized)) fail(400, 'INVALID_PATH', 'Path must be a canonical vault-relative path.');
    const respond = (match: string, file: CurrentVaultFile, extra: Record<string, unknown> = {}) => {
      Object.assign(c.get('logContext'), { path_resolved: true, resolve_match: match });
      return c.json({ match, requestedPath, canonicalPath: file.path, file: fileDto(file), ...extra });
    };
    if (requestedPath !== normalized) {
      const exact = await dependencies.database.vaultFiles.findByPath(vault.id, requestedPath);
      if (exact) return respond('exact', exact);
    }
    const current = await dependencies.database.vaultFiles.findByPath(vault.id, normalized);
    if (current) return respond(requestedPath === normalized ? 'exact' : 'normalized', current);
    const folded = await dependencies.database.vaultFiles.findByPathFold(vault.id, normalized.toLowerCase());
    if (folded.length === 1) return respond('case', folded[0]!);
    if (folded.length > 1) {
      Object.assign(c.get('logContext'), { path_resolved: true, resolve_match: 'ambiguous' });
      return c.json(
        { error: { code: 'AMBIGUOUS_PATH', message: 'Multiple files match this path.' }, candidates: folded.map(fileDto) },
        409,
      );
    }
    const historic = await dependencies.database.fileVersions.findLatestByPath(vault.id, normalized);
    if (historic) {
      const file = await dependencies.database.vaultFiles.findById(vault.id, historic.fileId);
      if (file) {
        if (file.path === normalized) return respond('exact', file);
        return respond('historic', file, { movedFromPath: historic.path, movedAtRevision: historic.revision });
      }
      Object.assign(c.get('logContext'), { path_resolved: true, resolve_match: 'deleted' });
      return c.json({ error: { code: 'FILE_DELETED', message: 'File was deleted.' } }, 410);
    }
    fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
  });
  app.get('/api/v1/vaults/:vaultId/files/:fileId', async (c) =>
    c.json({ file: fileDto(await findFile(c)) }),
  );
  const rawContent = async (c: AppContext): Promise<Response> => {
    const file = await findFile(c);
    const blob = await dependencies.blobStore.get(file.blobHash);
    if (!blob) fail(404, 'BLOB_MISSING', 'File content is missing.');
    const contentType =
      file.mimeType ??
      (file.kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
    const forceDownload = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)(?:;|$)/i.test(
      contentType,
    );
    return new Response(blob.bytes, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        ...(forceDownload
          ? {
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.path.split('/').at(-1) ?? 'attachment')}"`,
            }
          : {}),
      },
    });
  };
  app.get('/api/v1/vaults/:vaultId/files/:fileId/content', rawContent);
  app.get('/api/v1/vaults/:vaultId/files/:fileId/raw', rawContent);
  app.get('/api/v1/vaults/:vaultId/attachments/:fileId', rawContent);
  app.get('/api/v1/vaults/:vaultId/files/:fileId/rendered', async (c) => {
    const file = await findFile(c);
    if (file.kind !== 'markdown')
      fail(400, 'INVALID_MANIFEST', 'Only Markdown files can be rendered.');
    if (!dependencies.indexService?.renderMarkdown)
      fail(503, 'INDEX_PENDING', 'Markdown rendering is not available.');
    const blob = await dependencies.blobStore.get(file.blobHash);
    if (!blob) fail(404, 'BLOB_MISSING', 'File content is missing.');
    const markdown = await new Response(blob.bytes).text();
    return c.json(
      await dependencies.indexService.renderMarkdown({
        vaultId: file.vaultId,
        fileId: file.fileId,
        markdown,
      }),
    );
  });
  app.get('/api/v1/vaults/:vaultId/files/:fileId/links', async (c) =>
    c.json({
      links: await dependencies.database.noteIndex.listLinksBySource(
        c.req.param('vaultId'),
        (await findFile(c)).fileId,
      ),
    }),
  );
  app.get('/api/v1/vaults/:vaultId/files/:fileId/backlinks', async (c) =>
    c.json({
      links: await dependencies.database.noteIndex.listLinksByTarget(
        c.req.param('vaultId'),
        (await findFile(c)).fileId,
      ),
    }),
  );
  app.get('/api/v1/vaults/:vaultId/links', async (c) =>
    c.json({ links: await dependencies.database.noteIndex.listLinks(c.req.param('vaultId')) }),
  );
  // Graph payload v2 (plan 011): markdown notes plus synthesized attachment,
  // tag, and unresolved-link nodes; edges reference nodes by array index to
  // keep the payload small at ~30k edges. Pure derived state, so the response
  // carries an ETag keyed by vault + index revision.
  const GRAPH_NODE_LIMIT = 10_000;
  app.get('/api/v1/vaults/:vaultId/graph', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const indexState = await dependencies.database.noteIndex.getState(vault.id);
    const indexedRevision = indexState?.indexedRevision ?? 0;
    const etag = `W/"${vault.latestRevision}-${indexedRevision}-graph-v2"`;
    c.header('ETag', etag);
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

    const [files, metadataRows, links] = await Promise.all([
      dependencies.database.vaultFiles.listByVault(vault.id),
      dependencies.database.noteIndex.listMetadata(vault.id),
      dependencies.database.noteIndex.listLinks(vault.id),
    ]);
    const metadata = new Map(metadataRows.map((item) => [item.fileId, item]));

    type NodeSeed = {
      id: string;
      path: string;
      title: string | null;
      kind: 'note' | 'attachment' | 'tag' | 'unresolved';
      tags: string[];
      createdAt: number;
    };
    // Ordering doubles as the trim preference: markdown notes first, then
    // attachments, then synthesized tag/unresolved nodes.
    const notes: NodeSeed[] = [];
    const attachments: NodeSeed[] = [];
    for (const file of files) {
      const meta = metadata.get(file.fileId);
      const seed: NodeSeed = {
        id: file.fileId,
        path: file.path,
        title: meta?.title ?? null,
        kind: file.kind === 'markdown' ? 'note' : 'attachment',
        tags: file.kind === 'markdown' ? (meta?.tags ?? []) : [],
        createdAt: file.mtime,
      };
      (file.kind === 'markdown' ? notes : attachments).push(seed);
    }
    notes.sort((left, right) => left.path.localeCompare(right.path));
    attachments.sort((left, right) => left.path.localeCompare(right.path));

    // Tag nodes are synthesized from indexed note metadata; their createdAt
    // inherits the oldest tagged note so time-lapse reveals them with it.
    const tagCreatedAt = new Map<string, number>();
    for (const note of notes)
      for (const tag of note.tags) {
        const current = tagCreatedAt.get(tag);
        if (current === undefined || note.createdAt < current)
          tagCreatedAt.set(tag, note.createdAt);
      }
    const tags: NodeSeed[] = [...tagCreatedAt.keys()].sort().map((name) => ({
      id: `tag:${name}`,
      path: name,
      title: `#${name}`,
      kind: 'tag',
      tags: [],
      createdAt: tagCreatedAt.get(name) ?? 0,
    }));

    // Unresolved nodes come from links with a null target, deduped by the
    // normalized raw link path.
    const mtimeByFileId = new Map(files.map((file) => [file.fileId, file.mtime]));
    const unresolved = new Map<string, NodeSeed>();
    for (const link of links) {
      if (link.targetFileId !== null) continue;
      const key = link.linkPath.normalize('NFC').trim();
      if (key.length === 0) continue;
      const sourceCreatedAt = mtimeByFileId.get(link.sourceFileId) ?? 0;
      const existing = unresolved.get(key);
      if (existing) {
        if (sourceCreatedAt > 0 && (existing.createdAt === 0 || sourceCreatedAt < existing.createdAt))
          existing.createdAt = sourceCreatedAt;
      } else {
        unresolved.set(key, {
          id: `unresolved:${key}`,
          path: key,
          title: key.split('/').at(-1) ?? key,
          kind: 'unresolved',
          tags: [],
          createdAt: sourceCreatedAt,
        });
      }
    }
    const unresolvedNodes = [...unresolved.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );

    const all = [...notes, ...attachments, ...tags, ...unresolvedNodes];
    const truncated = all.length > GRAPH_NODE_LIMIT;
    const nodes = all.slice(0, GRAPH_NODE_LIMIT);
    const indexById = new Map(nodes.map((node, index) => [node.id, index]));

    const edgeMap = new Map<string, { s: number; t: number; count: number; embeds: number }>();
    const addEdge = (s: number, t: number, embed: boolean) => {
      const key = `${s}\0${t}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
        if (embed) existing.embeds += 1;
      } else {
        edgeMap.set(key, { s, t, count: 1, embeds: embed ? 1 : 0 });
      }
    };
    for (const link of links) {
      const s = indexById.get(link.sourceFileId);
      if (s === undefined) continue;
      const targetId =
        link.targetFileId ?? `unresolved:${link.linkPath.normalize('NFC').trim()}`;
      const t = indexById.get(targetId);
      if (t !== undefined) addEdge(s, t, link.isEmbed);
    }
    for (const note of notes) {
      const s = indexById.get(note.id);
      if (s === undefined) continue;
      for (const tag of note.tags) {
        const t = indexById.get(`tag:${tag}`);
        if (t !== undefined) addEdge(s, t, false);
      }
    }

    return c.json({
      revision: vault.latestRevision,
      truncated,
      ...(indexedRevision < vault.latestRevision ? { indexPending: true } : {}),
      nodes,
      edges: [...edgeMap.values()],
    });
  });

  return app;
}
