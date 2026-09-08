import { z } from 'zod';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isCanonicalVaultPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.normalize('NFC') !== path ||
    !hasOnlyUnicodeScalarValues(path)
  ) {
    return false;
  }

  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export const canonicalVaultPathSchema = z
  .string()
  .refine(isCanonicalVaultPath, 'Path must be a canonical vault-relative path.');
export const sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, 'Expected a lowercase SHA-256 hex digest.');
const identifierSchema = z.string().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();

export const PROTOCOL_VERSION = '1';
export const MINIMUM_PLUGIN_VERSION = '0.1.0';
export const PROTOCOL_VERSION_HEADER = 'X-Tephra-Protocol-Version';
export const PLUGIN_VERSION_HEADER = 'X-Tephra-Plugin-Version';

function parseVersionTuple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedPluginVersion(version: string | null | undefined): boolean {
  if (version === null || version === undefined || version.trim() === '') return true;
  const actual = parseVersionTuple(version);
  const minimum = parseVersionTuple(MINIMUM_PLUGIN_VERSION);
  if (actual === null || minimum === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

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

const syncBodyShape = {
  deviceId: identifierSchema,
  manifestHash: sha256Schema,
  files: syncManifestSchema,
};
export const syncPlanBodySchema = z.strictObject(syncBodyShape);
export const syncCommitBodySchema = z.strictObject(syncBodyShape);
export type SyncPlanBody = z.infer<typeof syncPlanBodySchema>;
export type SyncCommitBody = z.infer<typeof syncCommitBodySchema>;

export const missingBlobSchema = z.strictObject({
  hash: sha256Schema,
  size: nonNegativeIntegerSchema,
});
export const syncPlanResponseSchema = z.strictObject({
  status: z.enum(['upload-required', 'up-to-date']),
  latestRevision: nonNegativeIntegerSchema,
  missingBlobs: z.array(missingBlobSchema),
  protocolVersion: z.string().min(1).optional(),
  minimumPluginVersion: z.string().min(1).optional(),
});
export type SyncPlanResponse = z.infer<typeof syncPlanResponseSchema>;

export const syncCommitResponseSchema = z.strictObject({
  status: z.enum(['committed', 'up-to-date']),
  revision: nonNegativeIntegerSchema,
  protocolVersion: z.string().min(1).optional(),
  minimumPluginVersion: z.string().min(1).optional(),
});
export type SyncCommitResponse = z.infer<typeof syncCommitResponseSchema>;

export const blobUploadResponseSchema = z.strictObject({ hash: sha256Schema, stored: z.boolean() });
export type BlobUploadResponse = z.infer<typeof blobUploadResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'TOKEN_REVOKED',
  'VAULT_NOT_FOUND',
  'VAULT_ACCESS_DENIED',
  'INVALID_PATH',
  'INVALID_MANIFEST',
  'DUPLICATE_PATH',
  'DUPLICATE_FILE_ID',
  'BLOB_TOO_LARGE',
  'BLOB_HASH_MISMATCH',
  'BLOB_MISSING',
  'COMMIT_FAILED',
  'INDEX_PENDING',
  'FILE_DELETED',
  'AMBIGUOUS_PATH',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({ code: apiErrorCodeSchema, message: z.string().min(1) }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const vaultFileSchema = z.strictObject({
  fileId: identifierSchema,
  path: canonicalVaultPathSchema,
  blobHash: sha256Schema,
  size: nonNegativeIntegerSchema,
  mtime: nonNegativeIntegerSchema,
  mimeType: z.string().min(1).optional(),
  kind: z.enum(['markdown', 'attachment']),
});
export const filesResponseSchema = z.strictObject({
  revision: nonNegativeIntegerSchema,
  files: z.array(vaultFileSchema),
});
export type VaultFileDto = z.infer<typeof vaultFileSchema>;
export type FilesResponse = z.infer<typeof filesResponseSchema>;

export const resolveResponseSchema = z.strictObject({
  match: z.enum(['exact', 'case', 'normalized', 'historic']),
  requestedPath: z.string().min(1),
  canonicalPath: canonicalVaultPathSchema,
  file: vaultFileSchema,
  movedFromPath: canonicalVaultPathSchema.optional(),
  movedAtRevision: z.number().int().positive().safe().optional(),
});
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

export const graphResponseSchema = z.strictObject({
  revision: nonNegativeIntegerSchema,
  nodes: z.array(
    z.strictObject({
      id: identifierSchema,
      path: canonicalVaultPathSchema,
      title: z.string().nullable(),
    }),
  ),
  edges: z.array(
    z.strictObject({
      source: identifierSchema,
      target: identifierSchema,
      count: z.number().int().positive().safe(),
    }),
  ),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;

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
