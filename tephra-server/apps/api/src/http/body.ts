import type { ZodType } from 'zod';
import { fail } from './errors.js';
import type { AppContext } from './types.js';

const JSON_LIMIT = 2 * 1024 * 1024;

export async function jsonBody<T>(c: AppContext, schema: ZodType<T>): Promise<T> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > JSON_LIMIT) fail(413, 'INVALID_MANIFEST', 'Request body is too large.');
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > JSON_LIMIT) {
    fail(413, 'INVALID_MANIFEST', 'Request body is too large.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(400, 'INVALID_MANIFEST', 'Request body must be valid JSON.');
  }
  return schema.parse(value);
}
