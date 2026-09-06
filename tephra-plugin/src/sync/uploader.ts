import type { SyncManifestEntry } from '@tephra/protocol';
import type { TephraClientLike } from '../api/client';

export interface BlobSource {
  read(path: string, markdown: boolean): Promise<Uint8Array>;
}

export interface UploadOptions {
  concurrency: number;
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function uploadMissingBlobs(
  client: TephraClientLike,
  source: BlobSource,
  manifest: readonly SyncManifestEntry[],
  missingHashes: readonly string[],
  options: UploadOptions,
): Promise<void> {
  const byHash = new Map(manifest.map((entry) => [entry.hash, entry]));
  const queue = [...new Set(missingHashes)];
  const workerCount = Math.max(1, Math.min(Math.floor(options.concurrency), queue.length));
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.baseDelayMs ?? 500;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const hash = queue.shift();
      if (!hash) return;
      const entry = byHash.get(hash);
      if (!entry) throw new Error(`Server requested unknown blob ${hash}`);
      const bytes = await source.read(entry.path, entry.kind === 'markdown');
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.uploadBlob(hash, bytes);
          break;
        } catch (error) {
          if (attempt >= attempts) throw error;
          await sleep(baseDelay * 2 ** (attempt - 1));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
