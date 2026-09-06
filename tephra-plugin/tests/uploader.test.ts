import { describe, expect, it, vi } from 'vitest';
import { uploadMissingBlobs } from '../src/sync/uploader';

const manifest = [
  { fileId: 'a', path: 'A.md', hash: 'a'.repeat(64), size: 1, mtime: 1, kind: 'markdown' as const },
  { fileId: 'b', path: 'B.md', hash: 'b'.repeat(64), size: 1, mtime: 1, kind: 'markdown' as const },
];

describe('blob uploader', () => {
  it('reads and uploads only hashes reported missing', async () => {
    const uploadBlob = vi.fn(async () => undefined);
    const read = vi.fn(async () => new Uint8Array([1]));
    await uploadMissingBlobs({ uploadBlob } as never, { read }, manifest, ['b'.repeat(64)], {
      concurrency: 2,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('B.md', true);
    expect(uploadBlob).toHaveBeenCalledWith('b'.repeat(64), new Uint8Array([1]));
  });

  it('retries with exponential backoff', async () => {
    const uploadBlob = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async () => undefined);
    await uploadMissingBlobs(
      { uploadBlob } as never,
      { read: async () => new Uint8Array([1]) },
      manifest,
      ['a'.repeat(64)],
      { concurrency: 1, attempts: 3, baseDelayMs: 10, sleep },
    );
    expect(uploadBlob).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });
});
