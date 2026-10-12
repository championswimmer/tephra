import { z } from 'zod';
import {
  canAccessVault,
  constantTimeSecretEqual,
  hashOpaqueToken,
  parseCookies,
  tokenIsActive,
  type AuthPrincipal,
} from '@tephra/auth';
import type { ApiTokenScope, Vault } from '@tephra/vault-model';
import type { TransactionRepositories } from '@tephra/database-core';
import { fail } from './errors.js';
import type { ApiApp, ApiDependencies, AppContext } from './types.js';

export function bearer(c: AppContext): string | null {
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

export async function ownedVault(
  c: AppContext,
  dependencies: ApiDependencies,
  scope: ApiTokenScope,
): Promise<Vault> {
  const principal = c.get('principal');
  const vaultIdOrName = z.string().min(1).parse(c.req.param('vaultId'));
  const vault = await findVaultByIdOrName(dependencies.database.vaults, vaultIdOrName);
  if (vault === null) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
  if (!canAccessVault(principal, vault, scope))
    fail(403, 'VAULT_ACCESS_DENIED', 'Access to this vault is denied.');
  return vault;
}

export async function findVaultByIdOrName(
  vaults: Pick<TransactionRepositories['vaults'], 'findById' | 'findByName'>,
  vaultIdOrName: string,
): Promise<Vault | null> {
  // Vault names are globally unique, so the `:vaultId` URL/API segment can be
  // either the internal id (existing plugin bindings) or the name (web URLs).
  // Names win no special priority: an id always resolves first so stored sync
  // tokens keep working even if a name ever collides with an id string.
  return (
    (await vaults.findById(vaultIdOrName)) ?? (await vaults.findByName(vaultIdOrName))
  );
}

export function requireSession(c: AppContext): Extract<AuthPrincipal, { kind: 'session' }> {
  const principal = c.get('principal');
  if (principal.kind !== 'session')
    fail(403, 'VAULT_ACCESS_DENIED', 'A browser session is required.');
  return principal;
}

const PUBLIC_PATHS = new Set([
  '/api/v1/auth/bootstrap',
  '/api/v1/auth/login',
  '/api/v1/auth/bootstrap/status',
]);

/** Authenticates every `/api/v1/*` request except the public auth endpoints; enforces CSRF for cookie sessions. */
export function registerAuthMiddleware(app: ApiApp, dependencies: ApiDependencies): void {
  app.use('/api/v1/*', async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
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
}

/** Per-vault access check; the scope depends on which endpoint family is addressed. */
export function registerVaultScopeMiddleware(app: ApiApp, dependencies: ApiDependencies): void {
  app.use('/api/v1/vaults/:vaultId/*', async (c, next) => {
    // The web content write endpoint needs `vault:write`, which neither
    // implies nor requires the neighbouring read/upload scopes; session
    // principals (the vault owner) satisfy every scope via canAccessVault.
    const scope =
      c.req.path.includes('/sync/') || c.req.path.includes('/blobs/')
        ? 'vault:upload'
        : c.req.method === 'PUT' &&
            c.req.path.includes('/files/') &&
            c.req.path.endsWith('/content')
          ? 'vault:write'
          : 'vault:read-metadata';
    await ownedVault(c, dependencies, scope);
    return next();
  });
}
