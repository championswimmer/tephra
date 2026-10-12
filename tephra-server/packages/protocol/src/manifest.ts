import { z } from 'zod';
import {
  canonicalVaultPathSchema,
  identifierSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
} from './primitives.js';

export const syncManifestEntrySchema = z.strictObject({
  fileId: identifierSchema,
  path: canonicalVaultPathSchema,
  hash: sha256Schema,
  size: nonNegativeIntegerSchema,
  mtime: nonNegativeIntegerSchema,
  mimeType: z.string().min(1).optional(),
  kind: z.enum(['markdown', 'attachment']),
});
export type SyncManifestEntry = z.infer<typeof syncManifestEntrySchema>;

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

const unorderedManifestSchema = z.array(syncManifestEntrySchema).superRefine((files, context) => {
  const paths = new Set<string>();
  const fileIds = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (paths.has(file.path)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate manifest path.',
        path: [index, 'path'],
      });
    }
    if (fileIds.has(file.fileId)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate manifest file ID.',
        path: [index, 'fileId'],
      });
    }
    paths.add(file.path);
    fileIds.add(file.fileId);
  }
});

export const syncManifestSchema = unorderedManifestSchema.superRefine((files, context) => {
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareCodePoints(previous.path, current.path) > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Manifest paths must be sorted.',
        path: [index, 'path'],
      });
    }
  }
});

export function canonicalManifestJson(input: readonly SyncManifestEntry[]): string {
  const files = unorderedManifestSchema.parse(input);
  const sorted = [...files].sort((left, right) => compareCodePoints(left.path, right.path));
  return `[${sorted
    .map((file) => {
      const mimeType =
        file.mimeType === undefined ? '' : `,"mimeType":${JSON.stringify(file.mimeType)}`;
      return `{"fileId":${JSON.stringify(file.fileId)},"path":${JSON.stringify(file.path)},"hash":${JSON.stringify(file.hash)},"size":${String(file.size)},"mtime":${String(file.mtime)}${mimeType},"kind":${JSON.stringify(file.kind)}}`;
    })
    .join(',')}]`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so this remains compatible with stricter
  // Web Crypto BufferSource typings as well as browser and Node runtimes.
  const input = Uint8Array.from(bytes).buffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashManifest(input: readonly SyncManifestEntry[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalManifestJson(input)));
}
