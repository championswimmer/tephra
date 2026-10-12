import type { BlobStore } from '@tephra/blob-store-core';
import type { TransactionRepositories } from '@tephra/database-core';
import { hashManifest, MINIMUM_PLUGIN_VERSION, PROTOCOL_VERSION, type SyncManifestEntry } from '@tephra/protocol';
import { fail } from '../http/errors.js';

export function syncProtocolFields(): { protocolVersion: string; minimumPluginVersion: string } {
  return { protocolVersion: PROTOCOL_VERSION, minimumPluginVersion: MINIMUM_PLUGIN_VERSION };
}

export async function verifyManifest(
  files: readonly SyncManifestEntry[],
  manifestHash: string,
): Promise<void> {
  if ((await hashManifest(files)) !== manifestHash) {
    fail(400, 'INVALID_MANIFEST', 'Manifest hash does not match its canonical contents.');
  }
}

export async function requireBlobs(
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
