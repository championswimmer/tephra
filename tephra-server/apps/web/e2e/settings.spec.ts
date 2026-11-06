import { expect, test } from '@playwright/test';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`settings tabs, history and session on ${viewport.name}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const email = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.com';
    const password = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-12345';
    const bootstrap = await request.post('/api/v1/auth/bootstrap', {
      data: {
        token: process.env.E2E_BOOTSTRAP_TOKEN ?? 'e2e-bootstrap-token',
        email,
        password,
      },
    });
    expect([201, 409]).toContain(bootstrap.status());
    // Exercise the account form without starting the external Obsidian client.
    await page.route('**/api/v1/obsidian-sync', (route) =>
      route.fulfill({
        json: { available: true },
      }),
    );
    await page.route('**/api/v1/obsidian-sync/account', (route) =>
      route.fulfill({
        json: { account: { authenticated: true, email: 'sync@example.com', lastErrorCode: null } },
      }),
    );
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/vaults\/?$/);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();

    const tabs = page.getByRole('tablist', { name: 'Settings' });
    const panel = page.getByRole('tabpanel');
    await expect(tabs.getByRole('tab')).toHaveText(['Appearance', 'Account', 'Sync', 'MCP']);
    await expect(tabs.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await page.getByRole('radio', { name: /Dark/ }).check();
    await expect(page.locator('html')).toHaveClass('theme-dark');
    await page.screenshot({ path: testInfo.outputPath('appearance-dark.png') });
    await page.reload();
    await expect(page.getByRole('radio', { name: /Dark/ })).toBeChecked();
    await page.getByRole('radio', { name: /Light/ }).check();

    await tabs.getByRole('tab', { name: 'Account', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?tab=account$/);
    await expect(panel).toHaveText(new RegExp(`Signed in as ${email.replaceAll('.', '\\.')}`));
    await expect(panel.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('account.png') });
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Sync', exact: true })).toBeFocused();
    await expect(panel.getByText('Signed in as sync@example.com.')).toBeVisible();
    await page.getByLabel('Obsidian password').fill('unsent-draft-password');
    await page.screenshot({ path: testInfo.outputPath('sync.png') });

    await tabs.getByRole('tab', { name: 'MCP', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?tab=mcp$/);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(panel.getByRole('heading', { name: 'Authorized agents' })).toBeVisible();
    await panel.getByRole('tab', { name: 'Codex', exact: true }).click();
    await expect(panel.locator('code').filter({ hasText: 'codex mcp login tephra' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mcp.png'), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.reload();
    await expect(tabs.getByRole('tab', { name: 'MCP', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.goBack();
    await expect(tabs.getByRole('tab', { name: 'Sync', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByLabel('Obsidian password')).toHaveValue('');
    await page.goForward();
    await expect(tabs.getByRole('tab', { name: 'MCP', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await tabs.getByRole('tab', { name: 'Account', exact: true }).click();
    await panel.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
}
