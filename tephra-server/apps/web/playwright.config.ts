import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright end-to-end config for @tephra/web (Stage 1 gap F).
 *
 * Stack under test: the Go server (`tephra-server/go/cmd/tephra-server`) serves
 * both `/api/v1/*` and the built web bundle, so a single origin exercises the
 * production-like path with no dev-proxy involved.
 *
 * Prerequisites (run once before `npm run test:e2e`):
 *   1. Go toolchain on PATH (the server is started with `go run`).
 *   2. `npm run build --workspace=@tephra/web`  (produces ./dist, served below
 *      as TEPHRA_WEB_ROOT)
 *   3. `npm run build --workspace=@tephra/protocol` (needed by the
 *      repo-root `e2e/sync-vault.mjs` seeding script, which the spec spawns)
 *   Or simply `npm run build` from the repo root (builds all workspaces).
 *   Playwright browsers: `npx playwright install chromium`
 *   (browsers are NOT required for `npx playwright test --list`).
 *
 * Environment overrides:
 *   E2E_PORT            API+web port (default 8123)
 *   E2E_BOOTSTRAP_TOKEN bootstrap token for the fresh server (default
 *                       "e2e-bootstrap-token"; the spec reads the same var)
 *   E2E_BASE_URL        full base URL (default http://127.0.0.1:<E2E_PORT>);
 *                       set this instead when pointing at an externally
 *                       managed server (webServer is skipped when
 *                       PLAYWRIGHT_TEST_BASE_URL is set by Playwright itself,
 *                       but the temp data dir below is still harmless).
 *
 * Isolation: every Playwright run mints a fresh temp data directory, so
 * bootstrap/login/vault state never leaks between runs.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const GO_DIR = resolve(__dirname, '../../go');
const PORT = Number(process.env.E2E_PORT ?? 8123);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const BOOTSTRAP_TOKEN = process.env.E2E_BOOTSTRAP_TOKEN ?? 'e2e-bootstrap-token';

// Fresh SQLite + blob storage per run. Created at config load so the
// webServer below (and any external-server setup) can reference it.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'tephra-e2e-'));

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `go run -C ${GO_DIR} ./cmd/tephra-server`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
      TEPHRA_OBSIDIAN_SYNC_ENABLED: 'false',
      TEPHRA_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      TEPHRA_SQLITE_PATH: join(DATA_DIR, 'tephra.db'),
      TEPHRA_BLOB_PATH: join(DATA_DIR, 'blobs'),
      TEPHRA_WEB_ROOT: resolve(__dirname, 'dist'),
    },
  },
});
