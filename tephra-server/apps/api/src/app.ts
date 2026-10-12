import { Hono } from 'hono';
import { handleApiError } from './http/errors.js';
import { requestLogging } from './http/request-log.js';
import { registerAuthMiddleware, registerVaultScopeMiddleware } from './http/auth.js';
import type { ApiApp, ApiDependencies } from './http/types.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPublicAuthRoutes, registerSessionAuthRoutes } from './routes/auth.js';
import { registerVaultListRoutes, registerVaultRoutes } from './routes/vaults.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerWebEditRoutes } from './routes/web-edit.js';
import { registerChangesRoutes } from './routes/changes.js';
import { registerFileRoutes } from './routes/files.js';
import { registerGraphRoutes } from './routes/graph.js';

export type { ApiDependencies, IndexService } from './http/types.js';

export function createApp(dependencies: ApiDependencies): ApiApp {
  const app: ApiApp = new Hono();
  const generateId = () => dependencies.ids.generate();

  app.use('*', requestLogging(generateId));
  app.onError((error, c) => handleApiError(error, c, generateId));

  registerHealthRoutes(app, dependencies);
  registerPublicAuthRoutes(app, dependencies);
  registerAuthMiddleware(app, dependencies);
  registerSessionAuthRoutes(app, dependencies);
  registerVaultListRoutes(app, dependencies);
  registerVaultScopeMiddleware(app, dependencies);
  registerVaultRoutes(app, dependencies);
  registerTokenRoutes(app, dependencies);
  registerSyncRoutes(app, dependencies);
  registerWebEditRoutes(app, dependencies);
  registerChangesRoutes(app, dependencies);
  registerFileRoutes(app, dependencies);
  registerGraphRoutes(app, dependencies);

  return app;
}
