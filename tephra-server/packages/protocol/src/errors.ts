import { z } from 'zod';

export const apiErrorCodeSchema = z.enum([
  'VAULT_SYNC_MODE_MISMATCH',
  'OBSIDIAN_UNAVAILABLE',
  'OBSIDIAN_LOGIN_FAILED',
  'OBSIDIAN_MFA_REQUIRED',
  'OBSIDIAN_AUTH_EXPIRED',
  'OBSIDIAN_SETUP_FAILED',
  'OBSIDIAN_CHECKOUT_MISSING',
  'OBSIDIAN_SYNC_FAILED',
  'OBSIDIAN_SYNC_LIMIT',
  'OBSIDIAN_READ_ONLY',
  'OBSIDIAN_RATE_LIMIT',
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
