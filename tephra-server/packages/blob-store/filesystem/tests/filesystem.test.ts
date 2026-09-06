import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemBlobStore } from '../src/index.js';

const roots: string[] = [];
async function store(): Promise<{ root: string; blobs: FilesystemBlobStore }> {
  const root = await mkdtemp(join(tmpdir(), 'tephra-blobs-'));
  roots.push(root);
  return { root, blobs: new FilesystemBlobStore(root) };
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function read(result: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = result.getReader();
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
    size += item.value.byteLength;
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
async function filesBelow(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('filesystem blob store', () => {
  it('writes streamed bytes to a hash-sharded path and reads them back', async () => {
    const { root, blobs } = await store();
    const one = new TextEncoder().encode('streamed ');
    const two = new TextEncoder().encode('content');
    const bytes = new Uint8Array([...one, ...two]);
    const digest = hash(bytes);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(one);
        controller.enqueue(two);
        controller.close();
      },
    });

    await blobs.put({ hash: digest, bytes: stream, size: bytes.byteLength });
    expect(await blobs.has(digest)).toBe(true);
    const result = await blobs.get(digest);
    expect(result?.size).toBe(bytes.byteLength);
    expect(result && await read(result.bytes)).toEqual(bytes);
    expect(await filesBelow(join(root, digest.slice(0, 2), digest.slice(2, 4)))).toEqual([digest]);
  });

  it('is idempotent when an existing blob has the declared size', async () => {
    const { blobs } = await store();
    const bytes = new TextEncoder().encode('same');
    const digest = hash(bytes);
    await blobs.put({ hash: digest, bytes, size: bytes.byteLength });
    await blobs.put({ hash: digest, bytes: new Uint8Array([0, 0, 0, 0]), size: bytes.byteLength });
    const result = await blobs.get(digest);
    expect(result && await read(result.bytes)).toEqual(bytes);
  });

  it('rejects hash and size mismatches without leaving final or temporary files', async () => {
    const { root, blobs } = await store();
    const bytes = new TextEncoder().encode('content');
    const wrongHash = '0'.repeat(64);
    await expect(blobs.put({ hash: wrongHash, bytes, size: bytes.byteLength })).rejects.toThrow('SHA-256');
    expect(await blobs.has(wrongHash)).toBe(false);
    expect(await filesBelow(root)).toEqual([]);

    const digest = hash(bytes);
    await expect(blobs.put({ hash: digest, bytes, size: bytes.byteLength + 1 })).rejects.toThrow('size');
    expect(await blobs.has(digest)).toBe(false);
    expect(await filesBelow(root)).toEqual([]);
  });

  it('cleans up an interrupted input stream', async () => {
    const { root, blobs } = await store();
    const digest = hash(new TextEncoder().encode('partial-complete-value'));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('input failed'));
      },
    });
    await expect(blobs.put({ hash: digest, bytes: stream, size: 22 })).rejects.toThrow('input failed');
    expect(await blobs.has(digest)).toBe(false);
    expect(await filesBelow(root)).toEqual([]);
  });

  it('validates hashes before all filesystem operations and safely deletes missing blobs', async () => {
    const { blobs } = await store();
    for (const invalid of ['../secret', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}/file`]) {
      await expect(blobs.has(invalid)).rejects.toThrow('SHA-256');
      await expect(blobs.get(invalid)).rejects.toThrow('SHA-256');
      await expect(blobs.delete(invalid)).rejects.toThrow('SHA-256');
    }
    const digest = 'f'.repeat(64);
    await expect(blobs.delete(digest)).resolves.toBeUndefined();
    expect(await blobs.get(digest)).toBeNull();
  });
});
