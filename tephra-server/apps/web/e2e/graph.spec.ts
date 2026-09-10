import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext } from '@playwright/test';

const execFileAsync = promisify(execFile);

// Keep in sync with playwright.config.ts defaults (overridable via env).
const BOOTSTRAP_TOKEN = process.env.E2E_BOOTSTRAP_TOKEN ?? 'e2e-bootstrap-token';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-12345';
const VAULT_NAME = 'e2e-graph-vault';

async function setupVault(request: APIRequestContext, base: string) {
  const bootstrap = await request.post('/api/v1/auth/bootstrap', {
    data: { token: BOOTSTRAP_TOKEN, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  // The e2e server is shared across spec files in one run; whoever
  // bootstraps first wins and the other reuses the same admin account.
  expect(
    [201, 409],
    'bootstrap creates the admin (or 409 when another spec got there first)',
  ).toContain(bootstrap.status());

  const apiLogin = await request.post('/api/v1/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(apiLogin.status(), 'api login succeeds').toBe(200);
  const { csrfToken } = (await apiLogin.json()) as { csrfToken: string };
  const sessionCookie = (await apiLogin.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value.split(';')[0])
    .join('; ');
  const authed = { cookie: sessionCookie, 'x-tephra-csrf': csrfToken };
  const created = await request.post('/api/v1/vaults', {
    headers: authed,
    data: { name: VAULT_NAME },
  });
  expect(created.status(), 'vault creation succeeds').toBe(201);
  const { vault } = (await created.json()) as { vault: { id: string } };

  const syncScript = fileURLToPath(new URL('../../../../e2e/sync-vault.mjs', import.meta.url));
  const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));
  let syncOutput = '';
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [syncScript], {
      timeout: 120_000,
      env: {
        ...process.env,
        TEPHRA_BASE: base,
        TEPHRA_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        TEPHRA_ADMIN_EMAIL: ADMIN_EMAIL,
        TEPHRA_ADMIN_PASSWORD: ADMIN_PASSWORD,
        VAULT_DIR: fixtureVault,
        VAULT_NAME,
        DEVICE_ID: 'playwright-e2e-graph',
      },
    });
    syncOutput = `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    syncOutput = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message ?? ''}`;
    expect(syncOutput, `sync-vault.mjs seeding failed:\n${syncOutput}`).toBe('');
  }
  expect(syncOutput).toContain('[sync] DONE');
  return vault.id as string;
}

/**
 * Plan 011 §10 graph pass: the open note shows its local neighbourhood,
 * the global graph reports the DEV/e2e debug hook counts matching the
 * accessible note buttons, and the settings search filters both live.
 *
 * Indexing runs asynchronously after the seed commit, so every
 * link-dependent assertion uses Playwright's retrying expects.
 */
test('graph pass: local neighbourhood, debug counts, search filter', async ({
  page,
  request,
  baseURL,
}) => {
  expect(baseURL, 'playwright baseURL must be configured').toBeTruthy();
  const base = baseURL as string;
  const vaultId = await setupVault(request, base);

  // Login through the UI, then open the vault.
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/vaults\/?$/);
  await page.getByRole('link', { name: new RegExp(VAULT_NAME) }).click();
  await expect(page).toHaveURL(new RegExp(`/v/${vaultId}/?`));

  // The open note carries its local neighbourhood: Home links to Target
  // Note and Deep Note (Target links back, so the count stays at two).
  const filesPane = page.getByRole('complementary', { name: 'Vault files' });
  await filesPane.getByRole('button', { name: /Home\.md/ }).click();
  const local = page.getByRole('region', { name: 'Local graph' });
  await expect(local.getByText('2 neighbours within depth 1')).toBeVisible({ timeout: 30_000 });

  // Global graph with the e2e debug hook enabled via query param.
  await page.goto(`/v/${vaultId}/graph?e2eGraph=1`);
  const graph = page.getByRole('region', { name: 'Vault graph' });
  await expect(graph.getByText(/3 notes · 4 connections/)).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => (window as unknown as { __tephraGraph?: { nodeCount: number } }).__tephraGraph?.nodeCount === 3, null, {
    timeout: 30_000,
  });
  const noteButtons = graph.getByRole('list', { name: 'Notes in graph' }).getByRole('button');
  await expect(noteButtons).toHaveCount(3);
  const hookCount = await page.evaluate(
    () => (window as unknown as { __tephraGraph: { nodeCount: number } }).__tephraGraph.nodeCount,
  );
  expect(hookCount, 'debug hook nodeCount matches the DOM note buttons').toBe(3);

  // The settings search filters the model, the hook, and the header counts
  // live (the accessible fallback list always keeps every note).
  await graph.getByRole('button', { name: 'Graph settings' }).click();
  await graph.getByLabel('Search').fill('Deep');
  await expect(graph.getByText(/1 notes · 0 connections/)).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => (window as unknown as { __tephraGraph?: { nodeCount: number } }).__tephraGraph?.nodeCount === 1, null, {
    timeout: 15_000,
  });
  await expect(noteButtons).toHaveCount(3);
  await graph.getByLabel('Search').fill('');
  await expect(graph.getByText(/3 notes · 4 connections/)).toBeVisible({ timeout: 15_000 });
});
