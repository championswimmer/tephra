import { z } from 'zod';
import { syncManifestSchema } from './manifest.js';
import { identifierSchema, nonNegativeIntegerSchema, sha256Schema } from './primitives.js';

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
