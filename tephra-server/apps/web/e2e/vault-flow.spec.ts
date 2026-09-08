import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execFileAsync = promisify(execFile);

// Keep in sync with playwright.config.ts defaults (overridable via env).
const BOOTSTRAP_TOKEN = process.env.E2E_BOOTSTRAP_TOKEN ?? 'e2e-bootstrap-token';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.com';
// API credentials schema requires passwords of at least 10 characters.
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-12345';
const VAULT_NAME = 'e2e-vault';

/**
 * Stage 1 plan section 34 flow: bootstrap account, login, create vault, seed
 * via the sync API, open the vault, expand folders, open a note, follow a
 * [[wikilink]] to its destination, open the graph, and navigate via a node.
 *
 * Server-mutating setup (bootstrap, vault creation, seeding) goes through the
 * HTTP API — mirroring the repo-root `e2e/sync-vault.mjs` harness, which is
 * spawned verbatim for seeding — while every user-visible step runs in the
 * browser. Two known app gaps shape the spec (no app code is changed here):
 * - The SetupPage posts `{ bootstrapToken }` but the API's strict bootstrap
 *   schema requires `{ token }`, so bootstrap happens via the API and the
 *   browser flow starts at /login.
 * - The web client sends `X-CSRF-Token` while the API enforces
 *   `x-tephra-csrf`, so vault creation happens via the API and the browser
 *   flow opens the vault from the list.
 * - Graph node clicks use the graph's accessible node list (the same onOpen
 *   handler as canvas clicks, without canvas-coordinate flakiness).
 */
test('vault reading flow: login, files, wikilink, graph', async ({ page, request, baseURL }) => {
  expect(baseURL, 'playwright baseURL must be configured').toBeTruthy();
  const base = baseURL as string;

  // 1. Bootstrap the first admin account (fresh temp data dir per run).
  const bootstrap = await request.post('/api/v1/auth/bootstrap', {
    data: { token: BOOTSTRAP_TOKEN, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(bootstrap.status(), 'bootstrap creates the admin (or 409 on reuse)').toBe(201);

  // 2. Create the vault via the API (returns the vault record for later use).
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

  // 3. Seed via the sync API using the shared repo-root harness (plan →
  //    upload → commit), pointed at the fixture vault and this server. The
  //    harness reuses the vault created above by name.
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
        DEVICE_ID: 'playwright-e2e',
      },
    });
    syncOutput = `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    syncOutput = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message ?? ''}`;
    expect(syncOutput, `sync-vault.mjs seeding failed:\n${syncOutput}`).toBe('');
  }
  expect(syncOutput).toContain('[sync] DONE');

  // 4. Login through the UI.
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/vaults\/?$/);

  // 5. Open the vault from the list.
  await page.getByRole('link', { name: new RegExp(VAULT_NAME) }).click();
  await expect(page).toHaveURL(new RegExp(`/v/${vault.id}/?`));
  await expect(page.getByText(`Welcome to ${VAULT_NAME}`)).toBeVisible();

  // 6. Expand/collapse folders, then open the Home note from the tree.
  const filesPane = page.getByRole('complementary', { name: 'Vault files' });
  const notesFolder = filesPane.getByRole('button', { name: 'Notes', exact: true });
  await expect(notesFolder).toHaveAttribute('aria-expanded', 'true');
  await notesFolder.click();
  await expect(notesFolder).toHaveAttribute('aria-expanded', 'false');
  await expect(filesPane.getByRole('button', { name: /Target Note/ })).toBeHidden();
  await notesFolder.click();
  await expect(notesFolder).toHaveAttribute('aria-expanded', 'true');
  await filesPane.getByRole('button', { name: /Home\.md/ }).click();
  await expect(page).toHaveURL(/#\/Home\.md/);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  // 7. The [[wikilink]] renders in the note; click the in-note anchor and
  //    verify it navigates to the destination note.
  const renderedLink = page.locator('.rendered-note a.tephra-link', { hasText: 'Target Note' });
  await expect(renderedLink).toBeVisible();
  await renderedLink.click();
  await expect(page.getByRole('heading', { name: 'Target Note' })).toBeVisible();
  await expect(page).toHaveURL(/#\/Notes\/Target%20Note\.md/);

  // 8. Open the graph, then navigate via a node entry and verify the note.
  await page.getByRole('link', { name: 'Graph' }).click();
  await expect(page).toHaveURL(/\/graph/);
  const graph = page.getByRole('region', { name: 'Vault graph' });
  await expect(graph.getByText(/notes · .*connections/)).toBeVisible();
  await page
    .getByRole('list', { name: 'Notes in graph' })
    .getByRole('button', { name: 'Home' })
    .click();
  await expect(page).toHaveURL(/#\/Home\.md/);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

/**
 * Phase 4 (path-addressed URLs): notes open by `#/<path>` hash URL, and
 * after a rename the old hash URL resolves via the `historic` match,
 * rewrites to the canonical hash, and shows a "moved from" hint.
 *
 * The fixture vault is copied to a temp dir with stable `id:` frontmatter
 * so the re-sync after the rename records a server-side rename (same
 * fileId, new path) instead of a delete+create pair.
 */
test('path urls: open by path, rename redirects with moved hint', async ({
  page,
  request,
  baseURL,
}) => {
  expect(baseURL, 'playwright baseURL must be configured').toBeTruthy();
  const base = baseURL as string;
  const { mkdtempSync, cpSync, renameSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const PATH_VAULT_NAME = 'e2e-vault-paths';
  const OLD_PATH = 'Notes/Target Note.md';
  const NEW_PATH = 'Notes/Renamed Note.md';

  // 1. Bootstrap (409 when the sibling test already bootstrapped) + login.
  const bootstrap = await request.post('/api/v1/auth/bootstrap', {
    data: { token: BOOTSTRAP_TOKEN, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(bootstrap.status(), 'bootstrap creates the admin (or 409 on reuse)').toBeTruthy();
  expect([201, 409]).toContain(bootstrap.status());
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
    data: { name: PATH_VAULT_NAME },
  });
  expect(created.status(), 'vault creation succeeds').toBe(201);
  const { vault } = (await created.json()) as { vault: { id: string } };

  // 2. Copy the fixture vault to a temp dir with stable frontmatter ids.
  const staging = mkdtempSync(join(tmpdir(), 'tephra-e2e-paths-'));
  cpSync(fileURLToPath(new URL('./fixtures/vault', import.meta.url)), staging, {
    recursive: true,
  });
  const stableIds: Array<[string, string]> = [
    ['Home.md', 'e2e-home'],
    [OLD_PATH, 'e2e-target'],
    ['Engineering/Deep Note.md', 'e2e-deep'],
  ];
  for (const [relative, id] of stableIds) {
    const full = join(staging, relative);
    const text = readFileSync(full, 'utf8');
    writeFileSync(full, `---\nid: ${id}\n---\n${text}`);
  }
  const syncScript = fileURLToPath(new URL('../../../../e2e/sync-vault.mjs', import.meta.url));
  const syncEnv = {
    ...process.env,
    TEPHRA_BASE: base,
    TEPHRA_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    TEPHRA_ADMIN_EMAIL: ADMIN_EMAIL,
    TEPHRA_ADMIN_PASSWORD: ADMIN_PASSWORD,
    VAULT_DIR: staging,
    VAULT_NAME: PATH_VAULT_NAME,
    DEVICE_ID: 'playwright-e2e-paths',
  };
  const runSync = async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [syncScript], {
      timeout: 120_000,
      env: syncEnv,
    });
    expect(`${stdout}\n${stderr}`).toContain('[sync] DONE');
  };
  await runSync();

  // 3. Login through the UI and open the note directly by path URL.
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/vaults\/?$/);
  await page.goto(`/v/${vault.id}/#/Notes/Target%20Note.md`);
  await expect(page.getByRole('heading', { name: 'Target Note' })).toBeVisible();
  await expect(page).toHaveURL(/#\/Notes\/Target%20Note\.md/);

  // 4. Rename the note on disk (identity preserved via frontmatter id) and
  //    re-sync, then revisit the old path URL.
  renameSync(join(staging, OLD_PATH), join(staging, NEW_PATH));
  await runSync();
  // Reload (not goto: the URL is unchanged, so goto would be a no-op and
  // the app would never re-resolve the now-historic path).
  await page.reload();

  // 5. The old link redirects to the canonical hash with a moved hint.
  await expect(page).toHaveURL(/#\/Notes\/Renamed%20Note\.md/);
  await expect(page.getByRole('heading', { name: 'Target Note' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(`Moved from ${OLD_PATH}`);
});
