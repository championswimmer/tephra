import { describe, expect, it, vi } from 'vitest';
import {
  editConflictResponseSchema,
  hashManifest,
  saveContentResponseSchema,
  sha256Hex,
  type SyncManifestEntry,
} from '@tephra/protocol';
import { fixture, setup } from './helpers.js';

interface SeedEntry {
  fileId: string;
  path: string;
  content: string;
  kind: 'markdown' | 'attachment';
}

async function commitFiles(
  ctx: Awaited<ReturnType<typeof setup>>,
  entries: SeedEntry[],
  options: { deviceId?: string; mtime?: number } = {},
): Promise<SyncManifestEntry[]> {
  const files: SyncManifestEntry[] = [];
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(entry.content);
    const hash = await sha256Hex(bytes);
    const upload = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
      },
      body: bytes,
    });
    expect(upload.status).toBe(200);
    files.push({
      fileId: entry.fileId,
      path: entry.path,
      hash,
      size: bytes.byteLength,
      mtime: options.mtime ?? 100,
      kind: entry.kind,
    });
  }
  const commit = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/sync/commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: options.deviceId ?? 'device-1',
      manifestHash: await hashManifest(files),
      files,
    }),
  });
  expect(commit.status).toBe(200);
  return files;
}

async function putContent(
  ctx: Awaited<ReturnType<typeof setup>>,
  auth: Record<string, string>,
  fileId: string,
  text: string,
  ifMatch: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const bytes = new TextEncoder().encode(text);
  return ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/files/${fileId}/content`, {
    method: 'PUT',
    headers: {
      ...auth,
      ...(ifMatch === null ? {} : { 'if-match': ifMatch }),
      'x-tephra-content-size': String(bytes.byteLength),
      'content-type': 'text/markdown; charset=utf-8',
      ...extraHeaders,
    },
    body: bytes,
  });
}

async function writeToken(
  ctx: Awaited<ReturnType<typeof setup>>,
  scopes: string[],
): Promise<string> {
  const response = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/tokens`, {
    method: 'POST',
    headers: ctx.browserHeaders,
    body: JSON.stringify({ name: `scoped-${scopes.join('+')}`, scopes }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { value: string }).value;
}

describe('PUT /vaults/:vaultId/files/:fileId/content (web editing)', () => {
  it('commits exactly one revision and one file_versions modify row', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    const updated = 'hello edited';
    const updatedHash = await sha256Hex(new TextEncoder().encode(updated));

    const response = await putContent(ctx, ctx.browserHeaders, 'note-1', updated, seeded!.hash);
    expect(response.status).toBe(200);
    const body = saveContentResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ status: 'committed', revision: 2, blobHash: updatedHash });
    expect(body.mtime).toBeGreaterThan(100);
    expect(body.size).toBe(new TextEncoder().encode(updated).byteLength);

    expect((await ctx.database.vaults.findById(ctx.vault.id))?.latestRevision).toBe(2);
    expect(await ctx.database.vaultRevisions.list(ctx.vault.id)).toHaveLength(2);
    const rows = await ctx.database.fileVersions.listByRevision(ctx.vault.id, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileId: 'note-1',
      path: 'Note.md',
      blobHash: updatedHash,
      changeType: 'modify',
    });
    expect(await ctx.database.vaultFiles.findById(ctx.vault.id, 'note-1')).toMatchObject({
      blobHash: updatedHash,
      mtime: body.mtime,
      updatedRevision: 2,
    });
    // Synthetic web device, owned by the session user.
    const userId = (await ctx.database.users.findByEmail('owner@example.com'))!.id;
    expect(await ctx.database.devices.findById(`web:${userId}`)).toMatchObject({
      userId,
      name: 'Tephra Web',
      platform: 'web',
    });
  });

  it('reuses the synthetic web device across writes and never logs content', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    const secret = 'second revision with hunter2-classified text';
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = ((
      chunk: unknown,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const first = await putContent(ctx, ctx.browserHeaders, 'note-1', 'first edit', seeded!.hash);
      expect(first.status).toBe(200);
      const firstHash = (await first.json()) as { blobHash: string };
      const second = await putContent(
        ctx,
        ctx.browserHeaders,
        'note-1',
        secret,
        firstHash.blobHash,
      );
      expect(second.status).toBe(200);
    } finally {
      process.stdout.write = original;
    }
    const userId = (await ctx.database.users.findByEmail('owner@example.com'))!.id;
    const devices = (await ctx.database.devices.listByUser(userId)).filter(
      (device) => device.id === `web:${userId}`,
    );
    expect(devices).toHaveLength(1);
    const text = chunks.join('');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('first edit');
    expect(text).toContain('file_id');
  });

  it('returns up-to-date and creates nothing for byte-identical content', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    const response = await putContent(ctx, ctx.browserHeaders, 'note-1', 'hello', seeded!.hash);
    expect(response.status).toBe(200);
    const body = saveContentResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      status: 'up-to-date',
      revision: 1,
      blobHash: seeded!.hash,
      mtime: 100,
    });
    expect(await ctx.database.vaultRevisions.list(ctx.vault.id)).toHaveLength(1);
    expect(await ctx.database.fileVersions.listByRevision(ctx.vault.id, 2)).toEqual([]);
    expect(await ctx.database.devices.listByUser('nobody')).toEqual([]);
  });

  it('rejects a stale If-Match with 409 EDIT_CONFLICT and the current state', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'v1', kind: 'markdown' },
    ]);
    const second = await putContent(ctx, ctx.browserHeaders, 'note-1', 'v2', seeded!.hash);
    expect(second.status).toBe(200);
    const committed = (await second.json()) as { blobHash: string; mtime: number };

    const stale = await putContent(ctx, ctx.browserHeaders, 'note-1', 'v3-stale', seeded!.hash);
    expect(stale.status).toBe(409);
    const body = editConflictResponseSchema.parse(await stale.json());
    expect(body.error.code).toBe('EDIT_CONFLICT');
    expect(body.current).toMatchObject({
      blobHash: committed.blobHash,
      mtime: committed.mtime,
      revision: 2,
    });
    // The losing write changed nothing.
    expect((await ctx.database.vaults.findById(ctx.vault.id))?.latestRevision).toBe(2);
  });

  it('accepts an angle-bracketed If-Match and requires the header', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'v1', kind: 'markdown' },
    ]);
    const bracketed = await putContent(
      ctx,
      ctx.browserHeaders,
      'note-1',
      'v2',
      `<${seeded!.hash}>`,
    );
    expect(bracketed.status).toBe(200);

    const missing = await putContent(ctx, ctx.browserHeaders, 'note-1', 'v3', null);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: { code: 'INVALID_MANIFEST', message: expect.any(String) },
    });

    const malformed = await putContent(ctx, ctx.browserHeaders, 'note-1', 'v3', 'not-a-hash');
    expect(malformed.status).toBe(400);
  });

  it('rejects non-markdown files and size mismatches with 400', async () => {
    const ctx = await setup();
    const [image] = await commitFiles(ctx, [
      { fileId: 'img-1', path: 'img.png', content: 'png-bytes', kind: 'attachment' },
    ]);
    const attachment = await putContent(ctx, ctx.browserHeaders, 'img-1', 'nope', image!.hash);
    expect(attachment.status).toBe(400);
    expect(await attachment.json()).toEqual({
      error: { code: 'INVALID_MANIFEST', message: expect.any(String) },
    });

    const [note] = await commitFiles(
      ctx,
      [{ fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' }],
      { deviceId: 'device-2' },
    );
    const mismatch = await putContent(ctx, ctx.browserHeaders, 'note-1', 'hello!', note!.hash, {
      'x-tephra-content-size': '9999',
    });
    expect(mismatch.status).toBe(400);

    const missingFile = await putContent(ctx, ctx.browserHeaders, 'nope', 'x', note!.hash);
    expect(missingFile.status).toBe(404);
  });

  it('rejects oversized content with 413', async () => {
    const ctx = await setup({ maxBlobBytes: 16 });
    await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'tiny', kind: 'markdown' },
    ]);
    const [seeded] = await commitFiles(
      ctx,
      [{ fileId: 'note-2', path: 'Other.md', content: 'tiny', kind: 'markdown' }],
      { deviceId: 'device-2' },
    );
    const response = await putContent(
      ctx,
      ctx.browserHeaders,
      'note-2',
      'this text is definitely longer than sixteen bytes',
      seeded!.hash,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'BLOB_TOO_LARGE', message: expect.any(String) },
    });
  });

  it('forbids vault:upload-only tokens and allows vault:write tokens', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    // The default plugin token carries vault:read-metadata + vault:upload only.
    const denied = await putContent(
      ctx,
      { authorization: `Bearer ${ctx.token}` },
      'note-1',
      'edit',
      seeded!.hash,
    );
    expect(denied.status).toBe(403);

    const writer = await writeToken(ctx, ['vault:read-metadata', 'vault:write']);
    const allowed = await putContent(
      ctx,
      { authorization: `Bearer ${writer}` },
      'note-1',
      'edit',
      seeded!.hash,
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()) as { status: string }).toMatchObject({ status: 'committed' });
  });

  it('keeps mtime strictly greater than the previous file mtime', async () => {
    const ctx = await setup();
    const future = 1_700_000_000_000 + 500;
    const [seeded] = await commitFiles(
      ctx,
      [{ fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' }],
      { mtime: future },
    );
    // The server clock lags the file clock: mtime must still advance by one.
    const response = await putContent(ctx, ctx.browserHeaders, 'note-1', 'hello!', seeded!.hash);
    expect(response.status).toBe(200);
    expect((await response.json()) as { mtime: number }).toMatchObject({ mtime: future + 1 });
  });

  it('records an edit-then-revert as a new revision (relaxed constraint case)', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'original', kind: 'markdown' },
    ]);
    const edited = await putContent(ctx, ctx.browserHeaders, 'note-1', 'edited', seeded!.hash);
    expect(edited.status).toBe(200);
    const editedHash = ((await edited.json()) as { blobHash: string }).blobHash;

    // Reverting restores the earlier bytes (mtime still advances, so this is
    // a genuine new revision, not an up-to-date no-op). The repository-level
    // duplicate-hash behaviour is covered in the sqlite migration tests.
    const reverted = await putContent(ctx, ctx.browserHeaders, 'note-1', 'original', editedHash);
    expect(reverted.status).toBe(200);
    const body = saveContentResponseSchema.parse(await reverted.json());
    expect(body).toMatchObject({ status: 'committed', revision: 3, blobHash: seeded!.hash });

    const revisions = await ctx.database.vaultRevisions.list(ctx.vault.id);
    expect(revisions.map((item) => item.revision)).toEqual([1, 2, 3]);
    // Newest-wins lookup resolves to the latest revision for its hash.
    expect(
      await ctx.database.vaultRevisions.findByManifestHash(ctx.vault.id, revisions[2]!.manifestHash),
    ).toMatchObject({ revision: 3 });
    expect(
      (await ctx.database.fileVersions.listByRevision(ctx.vault.id, 3)).map(
        (row) => row.changeType,
      ),
    ).toEqual(['modify']);
  });

  it('serializes concurrent saves under lockVault: one commits, one conflicts', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'base', kind: 'markdown' },
    ]);
    const [first, second] = await Promise.all([
      putContent(ctx, ctx.browserHeaders, 'note-1', 'writer one', seeded!.hash),
      putContent(ctx, ctx.browserHeaders, 'note-1', 'writer two', seeded!.hash),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await ctx.database.vaults.findById(ctx.vault.id))?.latestRevision).toBe(2);
    expect(await ctx.database.fileVersions.listByRevision(ctx.vault.id, 2)).toHaveLength(1);
  });

  it('triggers indexVault and drops the graph cache row on commit', async () => {
    const indexVault = vi.fn(async () => undefined);
    const ctx = await setup({ indexService: { indexVault } });
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    await ctx.database.graphCache.upsert({
      vaultId: ctx.vault.id,
      revision: 1,
      indexedRevision: 1,
      etag: 'W/"1-1-graph-v2"',
      payloadJson: '{}',
      updatedAt: 1,
    });
    const response = await putContent(ctx, ctx.browserHeaders, 'note-1', 'edited', seeded!.hash);
    expect(response.status).toBe(200);
    expect(indexVault).toHaveBeenCalledWith(ctx.vault.id, 2);
    expect(await ctx.database.graphCache.find(ctx.vault.id)).toBeNull();
  });

  it('leaves the graph cache row alone when the save is a no-op', async () => {
    const indexVault = vi.fn(async () => undefined);
    const ctx = await setup({ indexService: { indexVault } });
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    await ctx.database.graphCache.upsert({
      vaultId: ctx.vault.id,
      revision: 1,
      indexedRevision: 1,
      etag: 'W/"1-1-graph-v2"',
      payloadJson: '{}',
      updatedAt: 1,
    });
    // The seed commit above already triggered one index pass; only the web
    // save under test must not trigger another.
    expect(indexVault).toHaveBeenCalledTimes(1);
    indexVault.mockClear();
    const response = await putContent(ctx, ctx.browserHeaders, 'note-1', 'hello', seeded!.hash);
    expect(response.status).toBe(200);
    expect(indexVault).not.toHaveBeenCalled();
    expect(await ctx.database.graphCache.find(ctx.vault.id)).not.toBeNull();
  });

  it('accepts vault:write in the token scopes schema without changing defaults', async () => {
    const ctx = await setup();
    // Narrow write-only token proves the new scope round-trips validation.
    const writer = await writeToken(ctx, ['vault:write']);
    expect(typeof writer).toBe('string');
    // A three-scope token fits the widened max(3).
    await writeToken(ctx, ['vault:read-metadata', 'vault:upload', 'vault:write']);
    // Defaults are unchanged: omitting scopes still yields the two plugin scopes.
    const response = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/tokens`, {
      method: 'POST',
      headers: ctx.browserHeaders,
      body: JSON.stringify({ name: 'Defaulted' }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { token: { scopes: string[] } };
    expect(created.token.scopes).toEqual(['vault:read-metadata', 'vault:upload']);
  });

  it('requires authentication like the other vault routes', async () => {
    const ctx = await fixture();
    const response = await ctx.app.request('/api/v1/vaults/vault-x/files/file-y/content', {
      method: 'PUT',
      headers: { 'if-match': 'a'.repeat(64) },
      body: 'x',
    });
    expect(response.status).toBe(401);
  });
});
