import { z } from 'zod';

export const apiErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'TOKEN_REVOKED',
  'VAULT_NOT_FOUND',
  'VAULT_ACCESS_DENIED',
  'VAULT_NAME_TAKEN',
  'VAULT_NAME_MISMATCH',
  'INVALID_PATH',
  'INVALID_MANIFEST',
  'DUPLICATE_PATH',
  'DUPLICATE_FILE_ID',
  'BLOB_TOO_LARGE',
  'BLOB_HASH_MISMATCH',
  'BLOB_MISSING',
  'EDIT_CONFLICT',
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
