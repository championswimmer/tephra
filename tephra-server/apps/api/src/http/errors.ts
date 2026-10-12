import { ZodError } from 'zod';
import type { Context } from 'hono';
import type { ApiErrorCode } from '@tephra/protocol';

export class ApiFailure extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function fail(status: ApiFailure['status'], code: ApiErrorCode, message: string): never {
  throw new ApiFailure(status, code, message);
}

export function statusFromError(error: unknown): number {
  if (error instanceof ApiFailure) return error.status;
  if (error instanceof ZodError) return 400;
  return 500;
}

/** Hono `onError` handler: maps ApiFailure/ZodError to the public error envelope. */
export function handleApiError(error: Error, c: Context, fallbackRequestId: () => string): Response {
  const requestId = c.get('requestId') ?? fallbackRequestId();
  c.header('X-Request-Id', requestId);
  if (error instanceof ApiFailure)
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof ZodError) {
    const messages = error.issues.map((issue) => issue.message);
    const code: ApiErrorCode = messages.includes('Duplicate manifest path.')
      ? 'DUPLICATE_PATH'
      : messages.includes('Duplicate manifest file ID.')
        ? 'DUPLICATE_FILE_ID'
        : messages.some((message) => message.includes('canonical vault-relative path'))
          ? 'INVALID_PATH'
          : 'INVALID_MANIFEST';
    return c.json({ error: { code, message: 'Request validation failed.' } }, 400);
  }
  console.error('Unhandled API error:', error);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } },
    500,
  );
}
