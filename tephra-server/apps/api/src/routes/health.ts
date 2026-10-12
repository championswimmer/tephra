import type { ApiApp, ApiDependencies } from '../http/types.js';

export function registerHealthRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    try {
      await dependencies.database.users.count();
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Service is not ready.' } }, 503);
    }
  });
}
