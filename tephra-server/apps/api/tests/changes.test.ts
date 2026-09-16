import { describe, expect, it } from 'vitest';
import {
  changesResponseSchema,
  hashManifest,
  sha256Hex,
  type SyncManifestEntry,
} from '@tephra/protocol';
import { setup } from './helpers.js';

interface SeedEntry {
  fileId: string;
  path: string;
  content: string;
  kind: 'markdown' | 'attachment';
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function commitFiles(
  ctx: Ctx,
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
      // The server requires manifest paths sorted by code point.
      manifestHash: await hashManifest(files),
      files: [...files].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    }),
  });
  expect(commit.status).toBe(200);
  return files;
}

async function getChanges(
  ctx: Ctx,
  query: string,
  auth: Record<string, string> | null = null,
): Promise<Response> {
  return ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/changes${query}`, {
    headers: auth ?? { authorization: `Bearer ${ctx.token}` },
  });
}

async function putContent(
  ctx: Ctx,
  fileId: string,
  text: string,
  ifMatch: string,
): Promise<Response> {
  const bytes = new TextEncoder().encode(text);
  return ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/files/${fileId}/content`, {
    method: 'PUT',
    headers: {
      ...ctx.browserHeaders,
      'if-match': ifMatch,
      'x-tephra-content-size': String(bytes.byteLength),
      'content-type': 'text/markdown; charset=utf-8',
    },
    body: bytes,
  });
}

describe('GET /vaults/:vaultId/changes (pull feed)', () => {
  it('emits create entries with markdown vs attachment kinds', async () => {
    const ctx = await setup();
    await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
      { fileId: 'img-1', path: 'assets/img.png', content: 'png-bytes', kind: 'attachment' },
      { fileId: 'plain-1', path: 'LICENSE', content: 'terms', kind: 'attachment' },
    ]);

    const response = await getChanges(ctx, '?sinceRevision=0');
    expect(response.status).toBe(200);
    const body = changesResponseSchema.parse(await response.json());
    expect(body.status).toBe('ok');
    if (body.status !== 'ok') return;
    expect(body).toMatchObject({
      fromRevision: 0,
      toRevision: 1,
      latestRevision: 1,
      truncated: false,
    });
    expect(body.changes).toHaveLength(3);
    // One entry per file (row order follows the sorted manifest).
    const byId = new Map(body.changes.map((entry) => [entry.fileId, entry]));
    expect(byId.get('note-1')).toMatchObject({
      fileId: 'note-1',
      changeType: 'create',
      path: 'Note.md',
      kind: 'markdown',
      revision: 1,
    });
    expect(byId.get('note-1')?.blobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(byId.get('img-1')).toMatchObject({
      fileId: 'img-1',
      changeType: 'create',
      path: 'assets/img.png',
      kind: 'attachment',
      revision: 1,
    });
    expect(byId.get('plain-1')).toMatchObject({
      fileId: 'plain-1',
      changeType: 'create',
      path: 'LICENSE',
      kind: 'attachment',
      revision: 1,
    });
  });

  it('emits modify entries for web edits', async () => {
    const ctx = await setup();
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'v1', kind: 'markdown' },
    ]);
    const edited = await putContent(ctx, 'note-1', 'v2', seeded!.hash);
    expect(edited.status).toBe(200);
    const editedHash = ((await edited.json()) as { blobHash: string }).blobHash;

    const response = await getChanges(ctx, '?sinceRevision=1');
    expect(response.status).toBe(200);
    const body = changesResponseSchema.parse(await response.json());
    if (body.status !== 'ok') throw new Error('Expected ok.');
    expect(body).toMatchObject({ fromRevision: 1, toRevision: 2, latestRevision: 2 });
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      fileId: 'note-1',
      changeType: 'modify',
      path: 'Note.md',
      blobHash: editedHash,
      kind: 'markdown',
      revision: 2,
    });
  });

  it('collapses rename+modify at one revision into a single rename entry with previousPath', async () => {
    const ctx = await setup();
    await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Old.md', content: 'v1', kind: 'markdown' },
    ]);
    // Same fileId, new path, new bytes: diffRevision emits rename + modify
    // rows at revision 2 — the feed must carry one entry per file per revision.
    await commitFiles(
      ctx,
      [{ fileId: 'note-1', path: 'New.md', content: 'v2', kind: 'markdown' }],
      { deviceId: 'device-1' },
    );

    const response = await getChanges(ctx, '?sinceRevision=1');
    const body = changesResponseSchema.parse(await response.json());
    if (body.status !== 'ok') throw new Error('Expected ok.');
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      fileId: 'note-1',
      changeType: 'rename',
      path: 'New.md',
      previousPath: 'Old.md',
      kind: 'markdown',
      revision: 2,
    });
    expect(body.changes[0]?.blobHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('emits tombstone delete entries without blob fields', async () => {
    const ctx = await setup();
    const seeded = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
      { fileId: 'note-2', path: 'Other.md', content: 'world', kind: 'markdown' },
    ]);
    // Second commit drops note-1: a soft-delete row that must still appear.
    const remaining = seeded.filter((file) => file.fileId === 'note-2');
    const commit = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-1',
        manifestHash: await hashManifest(remaining),
        files: remaining,
      }),
    });
    expect(commit.status).toBe(200);

    const response = await getChanges(ctx, '?sinceRevision=1');
    const body = changesResponseSchema.parse(await response.json());
    if (body.status !== 'ok') throw new Error('Expected ok.');
    expect(body).toMatchObject({ toRevision: 2, latestRevision: 2 });
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      fileId: 'note-1',
      changeType: 'delete',
      path: 'Note.md',
      kind: 'markdown',
      revision: 2,
    });
    expect(body.changes[0]).not.toHaveProperty('blobHash');
    expect(body.changes[0]).not.toHaveProperty('size');
    expect(body.changes[0]).not.toHaveProperty('mtime');
  });

  it('pages with limit/truncated and resumes from the last-seen revision', async () => {
    const ctx = await setup();
    // Commits carry the COMPLETE manifest: accumulate files across revisions.
    const accumulated: SeedEntry[] = [];
    for (let index = 1; index <= 4; index += 1) {
      accumulated.push({
        fileId: `note-${String(index)}`,
        path: `Note${String(index)}.md`,
        content: `v${String(index)}`,
        kind: 'markdown',
      });
      await commitFiles(ctx, [...accumulated], { deviceId: 'device-1' });
    }

    const first = changesResponseSchema.parse(await (await getChanges(ctx, '?sinceRevision=0&limit=2')).json());
    if (first.status !== 'ok') throw new Error('Expected ok.');
    expect(first.changes.map((entry) => entry.fileId)).toEqual(['note-1', 'note-2']);
    expect(first).toMatchObject({ fromRevision: 0, toRevision: 2, latestRevision: 4, truncated: true });

    const second = changesResponseSchema.parse(
      await (await getChanges(ctx, `?sinceRevision=${String(first.toRevision)}&limit=2`)).json(),
    );
    if (second.status !== 'ok') throw new Error('Expected ok.');
    expect(second.changes.map((entry) => entry.fileId)).toEqual(['note-3', 'note-4']);
    expect(second).toMatchObject({ fromRevision: 2, toRevision: 4, latestRevision: 4, truncated: false });

    // Full walk stays revision-ASC across pages.
    const revisions = [...first.changes, ...second.changes].map((entry) => entry.revision);
    expect(revisions).toEqual([1, 2, 3, 4]);
  });

  it('returns an empty ok page when already at the latest revision', async () => {
    const ctx = await setup();
    await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    const body = changesResponseSchema.parse(await (await getChanges(ctx, '?sinceRevision=1')).json());
    if (body.status !== 'ok') throw new Error('Expected ok.');
    expect(body).toMatchObject({
      fromRevision: 1,
      toRevision: 1,
      latestRevision: 1,
      truncated: false,
      changes: [],
    });
  });

  it('returns full-resync-required when sinceRevision is ahead of latest', async () => {
    const ctx = await setup();
    await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    const body = changesResponseSchema.parse(await (await getChanges(ctx, '?sinceRevision=99')).json());
    expect(body).toEqual({ status: 'full-resync-required', latestRevision: 1 });
  });

  it('rejects missing or invalid params with 400 INVALID_MANIFEST', async () => {
    const ctx = await setup();
    for (const query of ['', '?limit=10', '?sinceRevision=abc', '?sinceRevision=-1', '?sinceRevision=0&limit=0']) {
      const response = await getChanges(ctx, query);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'INVALID_MANIFEST', message: expect.any(String) },
      });
    }
  });

  it('is readable with the default plugin token and the session', async () => {
    const ctx = await setup();
    await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'hello', kind: 'markdown' },
    ]);
    // Plugin token (vault:read-metadata + vault:upload): the pull path.
    const viaToken = await getChanges(ctx, '?sinceRevision=0');
    expect(viaToken.status).toBe(200);
    // Owner session: vault:write is absent here by intent.
    const viaBrowser = await ctx.app.request(`/api/v1/vaults/${ctx.vault.id}/changes?sinceRevision=0`, {
      headers: { cookie: ctx.browserHeaders.cookie },
    });
    expect(viaBrowser.status).toBe(200);
  });

  it('never logs note content, only ids and revision counts', async () => {
    const ctx = await setup();
    const secret = 'web-edit-secret-text';
    const [seeded] = await commitFiles(ctx, [
      { fileId: 'note-1', path: 'Note.md', content: 'base', kind: 'markdown' },
    ]);
    await putContent(ctx, 'note-1', secret, seeded!.hash);
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = ((
      chunk: unknown,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const response = await getChanges(ctx, '?sinceRevision=0');
      expect(response.status).toBe(200);
    } finally {
      process.stdout.write = original;
    }
    const text = chunks.join('');
    expect(text).not.toContain(secret);
    expect(text).toContain('from_revision');
  });
});
