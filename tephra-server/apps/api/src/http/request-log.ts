import type { MiddlewareHandler } from 'hono';
import { statusFromError } from './errors.js';
import type { AppContext, Variables } from './types.js';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRequestId(incoming: string | undefined, generate: () => string): string {
  const candidate = incoming?.trim();
  if (candidate && candidate.length <= 128 && REQUEST_ID_PATTERN.test(candidate)) return candidate;
  return generate();
}

function emitRequestLog(c: AppContext, requestId: string, startTime: number, status: number): void {
  const durationMs = Math.round((performance.now() - startTime) * 1000) / 1000;
  // Only the allowlisted fields below (plus sync fields attached by handlers) are
  // logged. Bearer tokens, session cookies, note contents, and passwords are never logged.
  const context = c.get('logContext') ?? {};
  process.stdout.write(
    `${JSON.stringify({ request_id: requestId, method: c.req.method, path: c.req.path, status, duration_ms: durationMs, ...context })}\n`,
  );
}

/** Assigns the request id, then emits one structured log line per request. */
export function requestLogging(
  generateId: () => string,
): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'), generateId);
    c.set('requestId', requestId);
    c.set('logContext', {});
    c.header('X-Request-Id', requestId);
    const startTime = performance.now();
    try {
      await next();
    } catch (error) {
      emitRequestLog(c, requestId, startTime, statusFromError(error));
      throw error;
    }
    c.header('X-Request-Id', requestId);
    emitRequestLog(c, requestId, startTime, c.res.status);
  };
}
