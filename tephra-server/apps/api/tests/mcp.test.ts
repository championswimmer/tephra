import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { applyUnifiedDiff, PatchError } from '../src/mcp/patch.js';

type Ctx = Awaited<ReturnType<typeof setup>>;

async function rpc(ctx: Ctx, token: string | null, method: string, params?: unknown, id: number | null = 1) {
  return ctx.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
  });
}

async function call(ctx: Ctx, token: string, name: string, args: Record<string, unknown>) {
  const response = await rpc(ctx, token, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[]; structuredContent?: any };
  };
  return body.result;
}

async function scopedToken(ctx: Ctx, scopes: string[]): Promise<string> {
  const response = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/tokens`, {
    method: 'POST',
    headers: ctx.browserHeaders,
    body: JSON.stringify({ name: 'mcp', scopes }),
  });
  return ((await response.json()) as { value: string }).value;
}

describe('MCP /mcp', () => {
  it('requires a bearer token and refuses cookie sessions', async () => {
    const ctx = await setup();
    expect((await rpc(ctx, null, 'ping')).status).toBe(401);
    const cookie = await ctx.app.request('/mcp', {
      method: 'POST',
      headers: { cookie: ctx.browserHeaders.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(cookie.status).toBe(401);
    expect((await rpc(ctx, 'bogus', 'ping')).status).toBe(401);
    expect((await ctx.app.request('/mcp')).status).toBe(405);
  });

  it('handles initialize, ping, notifications and tools/list', async () => {
    const ctx = await setup();
    const init = (await (await rpc(ctx, ctx.token, 'initialize', { protocolVersion: '2025-03-26' })).json()) as any;
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.capabilities.tools).toBeDefined();
    expect((await rpc(ctx, ctx.token, 'notifications/initialized', undefined, null)).status).toBe(202);
    const list = (await (await rpc(ctx, ctx.token, 'tools/list')).json()) as any;
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(
      ['create_note', 'list_vaults', 'read_note', 'search_notes', 'update_note'],
    );
    const unknown = (await (await rpc(ctx, ctx.token, 'nope')).json()) as any;
    expect(unknown.error.code).toBe(-32601);
  });

  it('creates, searches, reads and edits notes with one revision per write', async () => {
    const ctx = await setup();
    const writer = await scopedToken(ctx, ['vault:read-metadata', 'vault:write']);
    const created = await call(ctx, writer, 'create_note', {
      path: 'Projects/Plan.md',
      content: '# Plan\n\none\ntwo\nthree\n',
    });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ status: 'committed', revision: 1, path: 'Projects/Plan.md' });

    const dup = await call(ctx, writer, 'create_note', { path: 'projects/plan.md', content: 'x' });
    expect(dup.isError).toBe(true);
    expect((await call(ctx, writer, 'create_note', { path: '../x.md', content: 'x' })).isError).toBe(true);
    expect((await call(ctx, writer, 'create_note', { path: 'x.txt', content: 'x' })).isError).toBe(true);

    const found = await call(ctx, writer, 'search_notes', { query: 'plan' });
    expect(found.structuredContent.results).toHaveLength(1);

    const read = await call(ctx, writer, 'read_note', { path: 'Projects/Plan.md' });
    expect(read.structuredContent.content).toBe('# Plan\n\none\ntwo\nthree\n');
    const hash = read.structuredContent.blobHash as string;

    const patched = await call(ctx, writer, 'update_note', {
      path: 'Projects/Plan.md',
      baseHash: hash,
      patch: '--- a/Plan.md\n+++ b/Plan.md\n@@ -3,3 +3,3 @@\n one\n-two\n+TWO\n three\n',
    });
    expect(patched.structuredContent).toMatchObject({ status: 'committed', revision: 2 });
    const after = await call(ctx, writer, 'read_note', { path: 'Projects/Plan.md' });
    expect(after.structuredContent.content).toBe('# Plan\n\none\nTWO\nthree\n');

    // Stale baseHash is a conflict; nothing is written.
    const stale = await call(ctx, writer, 'update_note', { path: 'Projects/Plan.md', baseHash: hash, content: 'clobber' });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain('conflict');
    // Full replacement requires baseHash.
    expect((await call(ctx, writer, 'update_note', { path: 'Projects/Plan.md', content: 'x' })).isError).toBe(true);
    const full = await call(ctx, writer, 'update_note', {
      path: 'Projects/Plan.md',
      baseHash: after.structuredContent.blobHash,
      content: 'brand new',
    });
    expect(full.structuredContent).toMatchObject({ status: 'committed', revision: 3 });

    // A patch that does not match is rejected without a revision.
    const bad = await call(ctx, writer, 'update_note', {
      path: 'Projects/Plan.md',
      patch: '@@ -1,1 +1,1 @@\n-not there\n+x\n',
    });
    expect(bad.isError).toBe(true);
    expect((await ctx.database.vaults.findById(ctx.vault.id))?.latestRevision).toBe(3);
    const rows = await ctx.database.fileVersions.listByRevision(ctx.vault.id, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeType: 'modify' });
  });

  it('enforces token scopes', async () => {
    const ctx = await setup();
    const readOnly = await scopedToken(ctx, ['vault:read-metadata']);
    const denied = await call(ctx, readOnly, 'create_note', { path: 'A.md', content: 'x' });
    expect(denied.isError).toBe(true);
    expect(await ctx.database.vaultFiles.listByVault(ctx.vault.id)).toHaveLength(0);
    const uploadOnly = await scopedToken(ctx, ['vault:upload']);
    expect((await call(ctx, uploadOnly, 'search_notes', { query: 'a' })).isError).toBe(true);
  });

  it('applies unified diffs strictly', () => {
    const source = 'a\nb\nc\nd\ne\n';
    expect(applyUnifiedDiff(source, '@@ -2,2 +2,3 @@\n b\n+b2\n c\n')).toBe('a\nb\nb2\nc\nd\ne\n');
    // Off-by-some line numbers still apply when context matches exactly.
    expect(applyUnifiedDiff(source, '@@ -9,1 +9,1 @@\n-d\n+D\n')).toBe('a\nb\nc\nD\ne\n');
    expect(() => applyUnifiedDiff(source, '@@ -1,1 +1,1 @@\n-zzz\n+y\n')).toThrow(PatchError);
    expect(() => applyUnifiedDiff(source, 'no hunks')).toThrow(PatchError);
  });
});
