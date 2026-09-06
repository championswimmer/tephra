import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ScryptPasswordHasher } from '@tephra/auth';
import { createFilesystemBlobStore } from '@tephra/blob-store-filesystem';
import { SystemClock, UuidV7Generator } from '@tephra/core';
import { openSqliteDatabase } from '@tephra/database-sqlite';

import { createApp } from './app';
import { createRuntimeIndexService } from './runtime-index';

function integerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

if ((process.env.TEPHRA_DATABASE_DRIVER ?? 'sqlite') !== 'sqlite') {
  throw new Error('Tephra is disk-only: TEPHRA_DATABASE_DRIVER must be sqlite');
}
if ((process.env.TEPHRA_BLOB_DRIVER ?? 'filesystem') !== 'filesystem') {
  throw new Error('Tephra is disk-only: TEPHRA_BLOB_DRIVER must be filesystem');
}

const bootstrapToken = process.env.TEPHRA_BOOTSTRAP_TOKEN;

const clock = new SystemClock();
const ids = new UuidV7Generator(clock);
const database = openSqliteDatabase(process.env.TEPHRA_SQLITE_PATH ?? './data/tephra.db');
const blobStore = createFilesystemBlobStore(process.env.TEPHRA_BLOB_PATH ?? './data/blobs');
const indexService = createRuntimeIndexService({ database, blobStore, clock, ids });
const app = createApp({
  database,
  blobStore,
  clock,
  ids,
  passwordHasher: new ScryptPasswordHasher(),
  ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
  indexService,
  secureCookies: process.env.NODE_ENV === 'production',
  maxBlobBytes: integerEnvironment('TEPHRA_MAX_BLOB_BYTES', 100 * 1024 * 1024),
});

const webRoot = process.env.TEPHRA_WEB_ROOT ?? './tephra-server/apps/web/dist';
app.use('*', serveStatic({ root: webRoot, index: 'index.html' }));
app.get('*', serveStatic({ path: `${webRoot}/index.html` }));

const server = serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? '127.0.0.1',
  port: integerEnvironment('PORT', 8080),
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    database.close();
    process.exitCode = 0;
  });
  setTimeout(() => {
    database.close();
    process.exit(1);
  }, 10_000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
