import { createHash } from 'node:crypto';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { constantTimeSecretEqual, createOpaqueToken, hashOpaqueToken } from '@tephra/auth';
import type { ApiTokenScope } from '@tephra/vault-model';
import { jsonBody } from '../http/body.js';
import { fail } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import type { ApiApp, ApiDependencies, AppContext } from '../http/types.js';

/**
 * OAuth 2.1 authorization-code + PKCE flow for MCP clients (plan 022).
 *
 * Browser-less agents (Claude Code, Codex, Cursor, ...) discover this through
 * RFC 9728 / RFC 8414 metadata, register dynamically (RFC 7591, stateless),
 * send the user to the web app to approve, receive the code on a loopback
 * redirect and exchange it for an ordinary scoped, revocable Tephra API token.
 */

export const MCP_CONNECT_PATH = '/connect';
const CODE_TTL_MS = 60_000;
const READ_SCOPES: ApiTokenScope[] = ['vault:read-metadata'];
const WRITE_SCOPES: ApiTokenScope[] = ['vault:read-metadata', 'vault:write'];
const CLIENT_ID_PREFIX = 'tmc_';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Private-use schemes (RFC 8252 section 7.1) of IDE-embedded clients.
const NATIVE_SCHEMES = new Set(['cursor:', 'vscode:', 'vscode-insiders:']);

export function publicOrigin(c: AppContext, dependencies: ApiDependencies): string {
  if (dependencies.publicUrl) return new URL(dependencies.publicUrl).origin;
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  return `${proto === 'http' || proto === 'https' ? proto : url.protocol.slice(0, -1)}://${host || url.host}`;
}

/** Value for the `WWW-Authenticate` header on 401s from `/mcp`. */
export function mcpChallenge(c: AppContext, dependencies: ApiDependencies): string {
  return `Bearer realm="tephra", resource_metadata="${publicOrigin(c, dependencies)}/.well-known/oauth-protected-resource"`;
}

interface ClientInfo {
  name: string;
  /** Registered redirect URIs; null when the client id was not issued by /oauth/register. */
  redirectUris: string[] | null;
}

function encodeClientId(name: string, redirectUris: string[]): string {
  return CLIENT_ID_PREFIX + Buffer.from(JSON.stringify({ n: name, r: redirectUris })).toString('base64url');
}

function decodeClientId(clientId: string): ClientInfo {
  if (clientId.startsWith(CLIENT_ID_PREFIX)) {
    try {
      const parsed = z
        .object({ n: z.string().max(200), r: z.array(z.string().max(2048)).max(10) })
        .parse(JSON.parse(Buffer.from(clientId.slice(CLIENT_ID_PREFIX.length), 'base64url').toString('utf8')));
      return { name: parsed.n, redirectUris: parsed.r };
    } catch {
      // fall through: treated as an opaque public client id
    }
  }
  return { name: clientId.slice(0, 80), redirectUris: null };
}

function parseRedirect(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
  return NATIVE_SCHEMES.has(url.protocol) ? url : null;
}

/** Redirects must be loopback (any port, RFC 8252 7.3) or a known IDE scheme, and match the registration if any. */
export function redirectAllowed(redirectUri: string, client: ClientInfo): boolean {
  const url = parseRedirect(redirectUri);
  if (url === null) return false;
  if (client.redirectUris === null) return true;
  return client.redirectUris.some((registered) => {
    if (registered === redirectUri) return true;
    const reg = parseRedirect(registered);
    return (
      reg !== null &&
      url.protocol === 'http:' &&
      reg.protocol === 'http:' &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

function oauthError(c: AppContext, error: string, description: string, status: 400 | 401 = 400) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

const authorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(4096),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2048).optional(),
});

const decisionSchema = z.strictObject({
  clientId: z.string().min(1).max(4096),
  redirectUri: z.string().min(1).max(2048),
  codeChallenge: authorizeQuery.shape.code_challenge,
  state: z.string().max(2048).optional(),
  decision: z.enum(['approve', 'deny']),
  vaultId: z.string().min(1).max(200).optional(),
  access: z.enum(['read', 'write']).default('write'),
});

function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

export function registerOAuthRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  const openCors = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'] });
  app.use('/.well-known/*', openCors);
  app.use('/oauth/register', openCors);
  app.use('/oauth/token', openCors);

  const resourceMetadata = (c: AppContext) => {
    const origin = publicOrigin(c, dependencies);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['vault:read-metadata', 'vault:write'],
      resource_name: 'Tephra MCP',
    });
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = publicOrigin(c, dependencies);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['vault:read-metadata', 'vault:write'],
    });
  });

  // RFC 7591 dynamic registration. Stateless: the client id embeds the registration.
  app.post('/oauth/register', async (c) => {
    let body: { client_name?: unknown; redirect_uris?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return oauthError(c, 'invalid_client_metadata', 'Body must be JSON.');
    }
    const parsed = z
      .object({ client_name: z.string().trim().min(1).max(100).optional(), redirect_uris: z.array(z.string().max(2048)).min(1).max(10) })
      .safeParse(body);
    if (!parsed.success) return oauthError(c, 'invalid_redirect_uri', 'redirect_uris is required.');
    const { redirect_uris: redirectUris } = parsed.data;
    if (!redirectUris.every((uri) => parseRedirect(uri) !== null))
      return oauthError(c, 'invalid_redirect_uri', 'Only loopback (http://127.0.0.1, http://localhost, http://[::1]) redirect URIs are accepted.');
    const name = parsed.data.client_name ?? 'MCP client';
    return c.json(
      {
        client_id: encodeClientId(name, redirectUris),
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(dependencies.clock.now() / 1000),
      },
      201,
    );
  });

  // Entry point opened in the user's browser by the coding agent. Validates, then hands over to the web app.
  app.get('/oauth/authorize', (c) => {
    const query = authorizeQuery.safeParse(c.req.query());
    if (!query.success) return c.text('Invalid authorization request.', 400);
    const client = decodeClientId(query.data.client_id);
    // Never redirect to an unvalidated URI.
    if (!redirectAllowed(query.data.redirect_uri, client)) return c.text('Redirect URI is not allowed.', 400);
    const params = new URLSearchParams({
      client_id: query.data.client_id,
      redirect_uri: query.data.redirect_uri,
      code_challenge: query.data.code_challenge,
      ...(query.data.state === undefined ? {} : { state: query.data.state }),
    });
    c.header('Cache-Control', 'no-store');
    return c.redirect(`${MCP_CONNECT_PATH}?${params.toString()}`, 302);
  });

  // Used by the consent page (cookie session + CSRF via the /api/v1 middleware).
  app.get('/api/v1/oauth/client', (c) => {
    requireSession(c);
    const clientId = z.string().min(1).max(4096).parse(c.req.query('client_id'));
    const redirectUri = z.string().min(1).max(2048).parse(c.req.query('redirect_uri'));
    const client = decodeClientId(clientId);
    if (!redirectAllowed(redirectUri, client)) fail(400, 'INVALID_MANIFEST', 'Redirect URI is not allowed.');
    const url = new URL(redirectUri);
    return c.json({ name: client.name, redirectHost: url.host || url.protocol });
  });

  app.post('/api/v1/oauth/authorize', async (c) => {
    const principal = requireSession(c);
    const body = await jsonBody(c, decisionSchema);
    const client = decodeClientId(body.clientId);
    if (!redirectAllowed(body.redirectUri, client)) fail(400, 'INVALID_MANIFEST', 'Redirect URI is not allowed.');
    if (body.decision === 'deny')
      return c.json({ redirectUrl: withParams(body.redirectUri, { error: 'access_denied', state: body.state }) });
    if (body.vaultId === undefined) fail(400, 'INVALID_MANIFEST', 'Choose a vault.');
    const vault = await dependencies.database.vaults.findById(body.vaultId);
    if (vault === null || vault.ownerUserId !== principal.user.id)
      fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
    const now = dependencies.clock.now();
    await dependencies.database.oauthCodes.deleteExpired(now);
    const code = createOpaqueToken('tpc');
    await dependencies.database.oauthCodes.insert({
      codeHash: await hashOpaqueToken(code),
      userId: principal.user.id,
      vaultId: vault.id,
      clientId: body.clientId,
      clientName: client.name,
      redirectUri: body.redirectUri,
      codeChallenge: body.codeChallenge,
      scopes: body.access === 'read' ? READ_SCOPES : WRITE_SCOPES,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
    });
    return c.json({ redirectUrl: withParams(body.redirectUri, { code, state: body.state }) });
  });

  app.post('/oauth/token', async (c) => {
    let form: Record<string, string | undefined> = {};
    try {
      if (c.req.header('content-type')?.includes('application/json')) {
        const json = (await c.req.json()) as Record<string, unknown>;
        for (const [key, value] of Object.entries(json)) if (typeof value === 'string') form[key] = value;
      } else {
        const parsed = await c.req.parseBody();
        form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as typeof form;
      }
    } catch {
      return oauthError(c, 'invalid_request', 'Malformed request body.');
    }
    if (form.grant_type !== 'authorization_code')
      return oauthError(c, 'unsupported_grant_type', 'Only authorization_code is supported.');
    const { code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId } = form;
    if (!code || !verifier || !redirectUri || !clientId || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      return oauthError(c, 'invalid_request', 'code, code_verifier, redirect_uri and client_id are required.');
    // Consuming first makes every code single-use, even when validation below fails.
    const stored = await dependencies.database.oauthCodes.consume(await hashOpaqueToken(code));
    const now = dependencies.clock.now();
    if (
      stored === null ||
      stored.expiresAt <= now ||
      stored.clientId !== clientId ||
      stored.redirectUri !== redirectUri ||
      !constantTimeSecretEqual(pkceChallenge(verifier), stored.codeChallenge)
    )
      return oauthError(c, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
    const vault = await dependencies.database.vaults.findById(stored.vaultId);
    if (vault === null || vault.ownerUserId !== stored.userId)
      return oauthError(c, 'invalid_grant', 'The vault is no longer available.');
    const raw = createOpaqueToken('tpt');
    await dependencies.database.apiTokens.insert({
      id: dependencies.ids.generate(),
      userId: stored.userId,
      vaultId: vault.id,
      deviceId: null,
      tokenHash: await hashOpaqueToken(raw),
      name: `MCP: ${stored.clientName}`.slice(0, 200),
      scopes: stored.scopes,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ access_token: raw, token_type: 'Bearer', scope: stored.scopes.join(' ') });
  });
}
