import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;

const VERIFIER = 'v'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1:53682/callback';

async function register(ctx: Ctx, redirectUris = [REDIRECT]) {
  const response = await ctx.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: redirectUris }),
  });
  return response;
}

async function approve(ctx: Ctx, clientId: string, extra: Record<string, unknown> = {}) {
  return ctx.app.request('/api/v1/oauth/authorize', {
    method: 'POST',
    headers: ctx.browserHeaders,
    body: JSON.stringify({
      clientId,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      state: 'xyz',
      decision: 'approve',
      vaultId: ctx.vault.id,
      access: 'write',
      ...extra,
    }),
  });
}

async function exchange(ctx: Ctx, clientId: string, code: string, extra: Record<string, string> = {}) {
  return ctx.app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: clientId,
      ...extra,
    }),
  });
}

async function codeFor(ctx: Ctx, clientId: string, extra: Record<string, unknown> = {}) {
  const response = await approve(ctx, clientId, extra);
  expect(response.status).toBe(200);
  const { redirectUrl } = (await response.json()) as { redirectUrl: string };
  const url = new URL(redirectUrl);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('xyz');
  return url.searchParams.get('code')!;
}

describe('MCP OAuth', () => {
  it('advertises discovery metadata and a challenge on 401', async () => {
    const ctx = await setup();
    const challenge = await ctx.app.request('http://tephra.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://tephra.test/.well-known/oauth-protected-resource"',
    );
    const resource = (await (await ctx.app.request('http://tephra.test/.well-known/oauth-protected-resource')).json()) as any;
    expect(resource).toMatchObject({ resource: 'http://tephra.test/mcp', authorization_servers: ['http://tephra.test'] });
    const server = (await (await ctx.app.request('http://tephra.test/.well-known/oauth-authorization-server')).json()) as any;
    expect(server).toMatchObject({
      authorization_endpoint: 'http://tephra.test/oauth/authorize',
      token_endpoint: 'http://tephra.test/oauth/token',
      registration_endpoint: 'http://tephra.test/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('registers clients only with loopback / IDE redirect URIs', async () => {
    const ctx = await setup();
    const ok = await register(ctx, ['http://localhost:3118/cb', 'cursor://anysphere.cursor-retrieval/oauth/callback']);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).client_id).toMatch(/^tmc_/);
    for (const bad of ['https://evil.example/cb', 'http://evil.example/cb', 'javascript:alert(1)', 'http://127.0.0.1/cb#frag']) {
      expect((await register(ctx, [bad])).status).toBe(400);
    }
  });

  it('redirects /oauth/authorize to the web consent page and rejects bad redirects', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const ok = await ctx.app.request(`/oauth/authorize?${query}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toMatch(/^\/connect\?.*state=xyz/);
    query.set('redirect_uri', 'http://127.0.0.1:1/other');
    expect((await ctx.app.request(`/oauth/authorize?${query}`)).status).toBe(400);
    query.set('redirect_uri', 'https://evil.example/cb');
    expect((await ctx.app.request(`/oauth/authorize?${query}`)).status).toBe(400);
    query.set('redirect_uri', REDIRECT);
    query.set('code_challenge_method', 'plain');
    expect((await ctx.app.request(`/oauth/authorize?${query}`)).status).toBe(400);
  });

  it('allows a different loopback port for a registered loopback client (RFC 8252)', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const response = await approve(ctx, clientId, { redirectUri: 'http://127.0.0.1:9999/callback' });
    expect(response.status).toBe(200);
  });

  it('issues a scoped token usable on /mcp after approval and PKCE exchange', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const code = await codeFor(ctx, clientId);
    const response = await exchange(ctx, clientId, code);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const token = (await response.json()) as any;
    expect(token).toMatchObject({ token_type: 'Bearer', scope: 'vault:read-metadata vault:write' });
    const list = await ctx.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_vaults', arguments: {} } }),
    });
    const body = (await list.json()) as any;
    expect(body.result.structuredContent.vaults).toEqual([
      expect.objectContaining({ id: ctx.vault.id }),
    ]);
    // Shows up in the vault's token list as a revocable MCP token.
    const tokens = (await (await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/tokens`, { headers: ctx.browserHeaders })).json()) as any;
    expect(tokens.tokens.map((t: any) => t.name)).toContain('MCP: Claude Code');
  });

  it('grants read-only access when requested', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const code = await codeFor(ctx, clientId, { access: 'read' });
    const token = (await (await exchange(ctx, clientId, code)).json()) as any;
    expect(token.scope).toBe('vault:read-metadata');
    const write = await ctx.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_note', arguments: { path: 'x.md', content: 'hi' } },
      }),
    });
    expect(((await write.json()) as any).result.isError).toBe(true);
  });

  it('codes are single use and bound to verifier, client and redirect', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;

    const code1 = await codeFor(ctx, clientId);
    expect((await exchange(ctx, clientId, code1)).status).toBe(200);
    expect((await exchange(ctx, clientId, code1)).status).toBe(400); // replay

    const code2 = await codeFor(ctx, clientId);
    const wrongVerifier = await exchange(ctx, clientId, code2, { code_verifier: 'w'.repeat(50) });
    expect(wrongVerifier.status).toBe(400);
    expect(((await wrongVerifier.json()) as any).error).toBe('invalid_grant');
    expect((await exchange(ctx, clientId, code2)).status).toBe(400); // burned by the failed attempt

    const code3 = await codeFor(ctx, clientId);
    expect((await exchange(ctx, clientId, code3, { redirect_uri: 'http://127.0.0.1:1/x' })).status).toBe(400);
    const code4 = await codeFor(ctx, clientId);
    expect((await exchange(ctx, 'tmc_other', code4)).status).toBe(400);
    expect((await exchange(ctx, clientId, 'tpc_unknown')).status).toBe(400);
    expect((await exchange(ctx, clientId, 'x', { grant_type: 'refresh_token' })).status).toBe(400);
  });

  it('expires codes after 60 seconds', async () => {
    let now = 1_700_000_000_000;
    const ctx = await setup({ now: () => now });
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const code = await codeFor(ctx, clientId);
    now += 61_000;
    expect((await exchange(ctx, clientId, code)).status).toBe(400);
  });

  it('requires a browser session to approve and only for own vaults', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const noAuth = await ctx.app.request('/api/v1/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noAuth.status).toBe(401);
    const viaToken = await ctx.app.request('/api/v1/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE, decision: 'approve', vaultId: ctx.vault.id }),
    });
    expect(viaToken.status).toBe(403);
    expect((await approve(ctx, clientId, { vaultId: 'nope' })).status).toBe(404);
    expect((await approve(ctx, clientId, { redirectUri: 'https://evil.example/cb' })).status).toBe(400);
    const noCsrf = await ctx.app.request('/api/v1/oauth/authorize', {
      method: 'POST',
      headers: { cookie: ctx.browserHeaders.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE, decision: 'approve', vaultId: ctx.vault.id }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it('returns access_denied to the client when the user declines', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const response = await approve(ctx, clientId, { decision: 'deny', vaultId: undefined });
    const { redirectUrl } = (await response.json()) as any;
    const url = new URL(redirectUrl);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('describes the client for the consent page', async () => {
    const ctx = await setup();
    const { client_id: clientId } = (await (await register(ctx)).json()) as any;
    const response = await ctx.app.request(
      `/api/v1/oauth/client?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      { headers: ctx.browserHeaders },
    );
    expect(await response.json()).toEqual({ name: 'Claude Code', redirectHost: '127.0.0.1:53682' });
  });
});
