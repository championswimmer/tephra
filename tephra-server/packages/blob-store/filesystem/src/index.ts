import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { BlobReadResult, BlobStore } from '@tephra/blob-store-core';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function validateHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new TypeError('Blob hash must be a lowercase hexadecimal SHA-256 digest');
  }
}

export interface FilesystemBlobStoreOptions {
  rootDirectory: string;
}

export class FilesystemBlobStore implements BlobStore {
  readonly rootDirectory: string;

  constructor(options: FilesystemBlobStoreOptions | string) {
    this.rootDirectory = typeof options === 'string' ? options : options.rootDirectory;
    if (this.rootDirectory.length === 0) throw new TypeError('rootDirectory must not be empty');
  }

  private path(hash: string): string {
    validateHash(hash);
    return join(this.rootDirectory, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async has(hash: string): Promise<boolean> {
    const path = this.path(hash);
    try {
      const info = await lstat(path);
      return info.isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async put(input: {
    hash: string;
    bytes: ReadableStream<Uint8Array> | Uint8Array;
    size: number;
    mimeType?: string;
  }): Promise<void> {
    validateHash(input.hash);
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new TypeError('Blob size must be a non-negative safe integer');
    }

    const destination = this.path(input.hash);
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.size !== input.size) {
        throw new Error('Existing blob does not match the declared size');
      }
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const directory = join(this.rootDirectory, input.hash.slice(0, 2), input.hash.slice(2, 4));
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${input.hash}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let closed = false;
    try {
      const digest = createHash('sha256');
      let size = 0;
      const write = async (chunk: Uint8Array): Promise<void> => {
        size += chunk.byteLength;
        if (size > input.size) throw new Error('Blob size does not match declared size');
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += result.bytesWritten;
        }
      };

      if (input.bytes instanceof Uint8Array) {
        await write(input.bytes);
      } else {
        const reader = input.bytes.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            await write(result.value);
          }
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
      }

      if (size !== input.size) throw new Error('Blob size does not match declared size');
      if (digest.digest('hex') !== input.hash) throw new Error('Blob SHA-256 does not match requested hash');
      await handle.sync();
      await handle.close();
      closed = true;

      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existing = await lstat(destination);
        if (!existing.isFile() || existing.size !== input.size) throw error;
      }
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(hash: string): Promise<BlobReadResult | null> {
    const path = this.path(hash);
    try {
      const info = await lstat(path);
      if (!info.isFile()) return null;
      return {
        bytes: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        size: info.size,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(hash: string): Promise<void> {
    const path = this.path(hash);
    try {
      await unlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'EPERM');
}

export function createFilesystemBlobStore(options: FilesystemBlobStoreOptions | string): FilesystemBlobStore {
  return new FilesystemBlobStore(options);
}
