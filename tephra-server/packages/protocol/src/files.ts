import { z } from 'zod';
import {
  canonicalVaultPathSchema,
  identifierSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
} from './primitives.js';

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

export const changeEntrySchema = z.strictObject({
  fileId: identifierSchema,
  changeType: z.enum(['create', 'modify', 'rename', 'delete']),
  path: canonicalVaultPathSchema,
  previousPath: canonicalVaultPathSchema.optional(),
  blobHash: sha256Schema.optional(),
  size: nonNegativeIntegerSchema.optional(),
  mtime: nonNegativeIntegerSchema.optional(),
  kind: z.enum(['markdown', 'attachment']),
  revision: z.number().int().positive().safe(),
});
export type ChangeEntry = z.infer<typeof changeEntrySchema>;

export const changesResponseSchema = z.union([
  z.strictObject({
    status: z.literal('ok'),
    fromRevision: nonNegativeIntegerSchema,
    toRevision: nonNegativeIntegerSchema,
    latestRevision: nonNegativeIntegerSchema,
    truncated: z.boolean(),
    changes: z.array(changeEntrySchema),
  }),
  z.strictObject({
    status: z.literal('full-resync-required'),
    latestRevision: nonNegativeIntegerSchema,
  }),
]);
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

export const saveContentResponseSchema = z.union([
  z.strictObject({
    status: z.literal('committed'),
    revision: nonNegativeIntegerSchema,
    blobHash: sha256Schema,
    size: nonNegativeIntegerSchema,
    mtime: nonNegativeIntegerSchema,
  }),
  z.strictObject({
    status: z.literal('up-to-date'),
    revision: nonNegativeIntegerSchema,
    blobHash: sha256Schema,
    size: nonNegativeIntegerSchema,
    mtime: nonNegativeIntegerSchema,
  }),
]);
export type SaveContentResponse = z.infer<typeof saveContentResponseSchema>;

export const editConflictResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.literal('EDIT_CONFLICT'), message: z.string().min(1) }),
  current: z.strictObject({
    blobHash: sha256Schema,
    size: nonNegativeIntegerSchema,
    mtime: nonNegativeIntegerSchema,
    revision: nonNegativeIntegerSchema,
  }),
});
export type EditConflictResponse = z.infer<typeof editConflictResponseSchema>;
