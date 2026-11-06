import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeSyncService } from './obsidian/service.js';
import { HeadlessClient, RuntimeInstaller } from './obsidian/cli.js';
import type { ApiDependencies } from './http/types.js';
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
const publicUrl = process.env.TEPHRA_PUBLIC_URL;

const clock = new SystemClock();
const ids = new UuidV7Generator(clock);
const database = openSqliteDatabase(process.env.TEPHRA_SQLITE_PATH ?? './data/tephra.db');
const blobStore = createFilesystemBlobStore(process.env.TEPHRA_BLOB_PATH ?? './data/blobs');
const indexService = createRuntimeIndexService({ database, blobStore, clock, ids });
const dependencies: ApiDependencies = {
  database,
  blobStore,
  clock,
  ids,
  passwordHasher: new ScryptPasswordHasher(),
  ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
  indexService,
  ...(publicUrl === undefined || publicUrl === '' ? {} : { publicUrl }),
  secureCookies: process.env.NODE_ENV === 'production',
  maxBlobBytes: integerEnvironment('TEPHRA_MAX_BLOB_BYTES', 100 * 1024 * 1024),
};
const nativeSync = process.env.TEPHRA_OBSIDIAN_SYNC_ENABLED === 'false' ? undefined : new NativeSyncService(dependencies, {
  root: process.env.TEPHRA_OBSIDIAN_SYNC_PATH ?? join(dirname(process.env.TEPHRA_SQLITE_PATH ?? './data/tephra.db'), 'obsidian-sync'),
  client: new HeadlessClient(new RuntimeInstaller(process.env.TEPHRA_OBSIDIAN_CACHE_PATH ?? join(tmpdir(), 'tephra-obsidian-client'))),
  maxVaults: integerEnvironment('TEPHRA_OBSIDIAN_MAX_VAULTS', 5),
  scanIntervalMs: integerEnvironment('TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS', 2) * 1_000,
});
if (nativeSync) dependencies.obsidianSync = nativeSync;
const app = createApp(dependencies);

const webRoot = process.env.TEPHRA_WEB_ROOT ?? './tephra-server/apps/web/dist';
// Browsers auto-request /favicon.ico; serve the reused landing-page mark
// (logo-main.svg) so the request does not fall through to index.html.
app.get('/favicon.ico', serveStatic({ path: `${webRoot}/logo-main.svg` }));
app.use('*', serveStatic({ root: webRoot, index: 'index.html' }));
app.get('*', serveStatic({ path: `${webRoot}/index.html` }));

const server = serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? '127.0.0.1',
  port: integerEnvironment('PORT', 8080),
});

// Startup is asynchronous: installation/network failures must not prevent normal vault access.
void nativeSync?.boot().catch(() => console.error('Obsidian Sync startup failed. Retry from Settings.'));

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise<void>(resolve => { server.close(() => resolve()); });
  void (async () => {
    await Promise.all([nativeSync?.close(), closed]);
    database.close();
    process.exitCode = 0;
  })();
  setTimeout(() => {
    database.close();
    process.exit(1);
  }, 10_000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
