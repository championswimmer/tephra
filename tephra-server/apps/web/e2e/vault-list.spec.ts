import { expect, test } from '@playwright/test';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`create a vault from the dialog on ${viewport.name}`, async ({
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
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/vaults\/?$/);
    await expect(page.getByLabel('Sync method')).toHaveCount(0);
    await expect(page.getByText(/cannot be changed after creation/)).toHaveCount(0);

    const trigger = page.getByRole('button', { name: 'New vault' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Create vault' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Vault name')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('create-vault.png') });
    await expect(dialog.getByRole('button', { name: 'Create vault', exact: true })).toBeDisabled();
    await dialog.getByLabel('Vault name').fill(`Browser vault ${viewport.name}`);
    // Keyboard navigation works within the dialog; the page behind it is inert.
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close create vault dialog' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.locator('.new-vault-button').focus();
    await expect(dialog.getByLabel('Vault name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog.getByLabel('Vault name')).toHaveValue('');
    await dialog.getByLabel('Vault name').fill(`Browser vault ${viewport.name}`);
    await expect(dialog.getByLabel('Sync method')).toHaveValue('tephra');
    await dialog.getByRole('button', { name: 'Create vault', exact: true }).click();
    await expect(dialog).toBeHidden();
    const vault = page
      .getByRole('list', { name: 'Vaults' })
      .getByRole('listitem')
      .filter({
        has: page.getByRole('link', { name: new RegExp(`^Browser vault ${viewport.name}`) }),
      });
    await expect(vault).toBeVisible();
    await expect(
      vault.getByRole('link', { name: `Settings for Browser vault ${viewport.name}` }),
    ).toBeVisible();
    await expect(vault.getByRole('button', { name: 'Delete vault' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('vault-list.png') });
  });
}
