import { serve } from '@hono/node-server';
import { createApp, type ApiDependencies } from '../app.js';

export interface NodeServerOptions {
  port?: number;
  hostname?: string;
}

/**
 * Starts the Node transport around an explicitly composed set of adapters.
 * Adapter construction intentionally lives in the deployment composition root.
 */
export function startServer(
  dependencies: ApiDependencies,
  options: NodeServerOptions = {},
): ReturnType<typeof serve> {
  return serve({
    fetch: createApp(dependencies).fetch,
    port: options.port ?? 8080,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });
}
