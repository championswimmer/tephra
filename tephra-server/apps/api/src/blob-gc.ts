import type { BlobStore } from '@tephra/blob-store-core';
import type { Database } from '@tephra/database-core';

/** Grace period before an unreferenced blob becomes eligible for collection. */
export const DEFAULT_BLOB_GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_BLOB_GC_LIMIT = 1000;

export interface CollectUnreferencedBlobsOptions {
  database: Pick<Database, 'blobs'>;
  blobStore: BlobStore;
  /** Defaults to `Date.now()`. */
  now?: number;
  /** Minimum age of a candidate blob. Defaults to 7 days. */
  olderThanMs?: number;
  /** Maximum number of blobs to delete per run. Defaults to 1000. */
  limit?: number;
}

/**
 * Deletes blobs that are no longer referenced by any current vault file or
 * retained file version and are older than the grace period. Blobs from
 * in-flight uploads are always newer than the cutoff, so they are never
 * collected. Returns the hashes that were deleted.
 */
export async function collectUnreferencedBlobs(
  options: CollectUnreferencedBlobsOptions,
): Promise<{ deleted: string[] }> {
  const now = options.now ?? Date.now();
  const olderThanMs = options.olderThanMs ?? DEFAULT_BLOB_GC_AGE_MS;
  const limit = options.limit ?? DEFAULT_BLOB_GC_LIMIT;
  const candidates = await options.database.blobs.findUnreferencedOlderThan(
    now - olderThanMs,
    limit,
  );
  const deleted: string[] = [];
  for (const candidate of candidates) {
    await options.blobStore.delete(candidate.hash);
    await options.database.blobs.delete(candidate.hash);
    deleted.push(candidate.hash);
  }
  return { deleted };
}
