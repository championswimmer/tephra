import { fail } from './errors.js';
import type { ApiDependencies } from './types.js';

export const DEFAULT_BLOB_LIMIT = 100 * 1024 * 1024;

/**
 * Shared blob-store-and-record path (invariant I3): the server hashes the
 * received bytes itself and never trusts a client-supplied digest. Used by
 * both `PUT /blobs/:hash` and the web content write endpoint so the two
 * writers cannot drift apart.
 */
export async function storeBlobIfAbsent(
  dependencies: ApiDependencies,
  input: { hash: string; bytes: Uint8Array; mimeType?: string },
): Promise<{ stored: boolean }> {
  const existing = await dependencies.database.blobs.findByHash(input.hash);
  if (
    existing &&
    (existing.size !== input.bytes.byteLength ||
      !(await dependencies.blobStore.has(input.hash)))
  )
    fail(409, 'COMMIT_FAILED', 'Stored blob metadata is inconsistent.');
  if (!existing) {
    await dependencies.blobStore.put({
      hash: input.hash,
      bytes: input.bytes,
      size: input.bytes.byteLength,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    });
    await dependencies.database.blobs.insert({
      hash: input.hash,
      size: input.bytes.byteLength,
      mimeType: input.mimeType ?? null,
      createdAt: dependencies.clock.now(),
    });
  }
  return { stored: existing === null };
}
