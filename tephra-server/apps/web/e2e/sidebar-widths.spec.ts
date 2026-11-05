import { expect, test, type Locator, type Page } from '@playwright/test';

const longName =
  'A long filename with spaces that should stay on a single line and reveal more when widened.md';
const vault = { id: 'sidebar-vault', name: 'sidebar-vault', latestRevision: 1 };
const files = [
  { fileId: 'home', path: 'Home.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: 'long', path: longName, kind: 'markdown', size: 10, mtime: 1 },
  {
    fileId: 'nested',
    path: `Folder with a long name containing spaces/${longName}`,
    kind: 'markdown',
    size: 10,
    mtime: 1,
  },
];

async function mockWorkspace(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown;
    if (path.endsWith('/auth/me')) json = { user: { id: 'user', email: 'sidebar@example.com' } };
    else if (path.endsWith('/files')) json = { revision: 1, files };
    else if (path.endsWith('/resolve')) {
      const file = files.find((entry) => entry.path === url.searchParams.get('path')) ?? files[0]!;
      json = { match: 'exact', requestedPath: file.path, canonicalPath: file.path, file };
    } else if (path.endsWith('/rendered'))
      json = { html: '<h1>Home</h1><p>Sidebar resizing fixture.</p>' };
    else if (path.endsWith('/links') || path.endsWith('/backlinks')) json = { links: [] };
    else if (path.endsWith('/graph')) json = { nodes: [], edges: [], revision: 1 };
    else if (path.endsWith(`/vaults/${vault.name}`)) json = { vault };
    else {
      await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: path } } });
      return;
    }
    await route.fulfill({ json });
  });
  await page.goto(`/v/${vault.name}/#/Home.md`);
  await expect(page.getByRole('complementary', { name: 'Vault files' })).toBeVisible();
}

async function width(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

async function drag(page: Page, handle: Locator, delta: number) {
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + Math.min(bounds!.height / 2, 100);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockWorkspace(page);
});

test('both edges resize independently and retain widths across collapse and reload', async ({
  page,
}) => {
  const left = page.locator('.left-sidebar');
  const right = page.locator('.right-sidebar');
  const leftHandle = page.getByRole('separator', { name: 'Resize file browser' });
  const rightHandle = page.getByRole('separator', { name: 'Resize links panel' });
  await expect(rightHandle).toBeVisible();
  const leftBefore = await width(left);
  const rightBefore = await width(right);
  await drag(page, leftHandle, 100);
  await expect.poll(() => width(left)).toBeCloseTo(leftBefore + 100, 0);
  await expect.poll(() => width(right)).toBeCloseTo(rightBefore, 0);
  await drag(page, rightHandle, -80);
  await expect.poll(() => width(right)).toBeCloseTo(rightBefore + 80, 0);
  const leftAfter = await width(left);
  const rightAfter = await width(right);

  await page.getByRole('button', { name: 'Hide file browser' }).click();
  await expect(leftHandle).toBeHidden();
  await page.getByRole('button', { name: 'Show file browser' }).click();
  await expect.poll(() => width(left)).toBeCloseTo(leftAfter, 0);
  await page.getByRole('button', { name: 'Hide links panel' }).click();
  await expect(rightHandle).toBeHidden();
  await page.getByRole('button', { name: 'Show links panel' }).click();
  await expect.poll(() => width(right)).toBeCloseTo(rightAfter, 0);

  await page.reload();
  await expect.poll(() => width(left)).toBeCloseTo(leftAfter, 0);
  await expect.poll(() => width(right)).toBeCloseTo(rightAfter, 0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
});

test('tree names clip on one line and reveal more text as the sidebar widens', async ({ page }) => {
  const row = page.getByRole('button', { name: longName, exact: true });
  const label = row.locator('span');
  const handle = page.getByRole('separator', { name: 'Resize file browser' });
  const before = await label.evaluate((element) => ({
    width: element.clientWidth,
    height: element.getBoundingClientRect().height,
    scroll: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
    overflow: getComputedStyle(element).overflowX,
    textOverflow: getComputedStyle(element).textOverflow,
  }));
  expect(before.whiteSpace).toBe('nowrap');
  expect(before.overflow).toBe('hidden');
  expect(before.textOverflow).not.toBe('ellipsis');
  expect(before.scroll).toBeGreaterThan(before.width);
  await drag(page, handle, 170);
  const after = await label.evaluate((element) => ({
    width: element.clientWidth,
    height: element.getBoundingClientRect().height,
  }));
  expect(after.width).toBeGreaterThan(before.width + 150);
  expect(after.height).toBe(before.height);
  const tree = page.getByRole('complementary', { name: 'Vault files' });
  expect(await tree.evaluate((element) => element.scrollWidth)).toBe(
    await tree.evaluate((element) => element.clientWidth),
  );
  const content = page.locator('.content-pane');
  const treeBounds = await tree.boundingBox();
  const contentBounds = await content.boundingBox();
  expect(treeBounds!.x + treeBounds!.width).toBeLessThanOrEqual(contentBounds!.x + 1);

  await page
    .getByRole('button', { name: 'Folder with a long name containing spaces', exact: true })
    .click();
  const nested = tree.getByRole('button', { name: longName, exact: true }).last().locator('span');
  await expect(nested).toHaveCSS('white-space', 'nowrap');
  await expect(nested).toHaveCSS('overflow-x', 'hidden');
});

test('keyboard separators honor minimum and maximum bounds in both directions', async ({
  page,
}) => {
  const left = page.locator('.left-sidebar');
  const right = page.locator('.right-sidebar');
  const leftHandle = page.getByRole('separator', { name: 'Resize file browser' });
  const rightHandle = page.getByRole('separator', { name: 'Resize links panel' });
  await leftHandle.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => width(left)).toBeCloseTo(160, 0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => width(left)).toBeCloseTo(160, 0);
  await page.keyboard.press('ArrowRight');
  expect(await width(left)).toBeGreaterThan(160);
  await page.keyboard.press('End');
  await expect.poll(() => width(left)).toBeCloseTo(480, 0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => width(left)).toBeCloseTo(480, 0);

  await rightHandle.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => width(right)).toBeCloseTo(160, 0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => width(right)).toBeCloseTo(160, 0);
  await page.keyboard.press('ArrowLeft');
  expect(await width(right)).toBeGreaterThan(160);
  await page.keyboard.press('End');
  await expect.poll(() => width(right)).toBeCloseTo(480, 0);
  await expect(leftHandle).toHaveAttribute('aria-valuenow', '480');
  await expect(rightHandle).toHaveAttribute('aria-valuenow', '480');
  expect(await width(page.locator('.content-pane'))).toBeGreaterThan(250);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(() => width(left)).toBeCloseTo(400, 0);
  await expect.poll(() => width(right)).toBeCloseTo(400, 0);
  await expect(leftHandle).toHaveAttribute('aria-valuemax', '400');
  expect(await width(page.locator('.content-pane'))).toBeGreaterThanOrEqual(199);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => width(left)).toBeCloseTo(480, 0);
});

test('tablet retains left resizing and mobile retains its file drawer without handles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator('.right-sidebar')).toBeHidden();
  const leftHandle = page.getByRole('separator', { name: 'Resize file browser' });
  await expect(leftHandle).toBeVisible();
  await leftHandle.focus();
  await page.keyboard.press('End');
  await expect.poll(() => width(page.locator('.left-sidebar'))).toBeCloseTo(320, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(leftHandle).toBeHidden();
  const tree = page.getByRole('complementary', { name: 'Vault files' });
  await expect(tree).toBeHidden();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(tree).toBeVisible();
  await expect(leftHandle).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await tree.getByRole('button', { name: 'Home.md', exact: true }).click();
  await expect(tree).toBeHidden();
});

test('canceling a drag restores text selection and stops resizing', async ({ page }) => {
  const handle = page.getByRole('separator', { name: 'Resize file browser' });
  const left = page.locator('.left-sidebar');
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + 50;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y);
  expect(await page.evaluate(() => document.documentElement.style.userSelect)).toBe('none');
  await handle.dispatchEvent('pointercancel', { pointerId: 1 });
  expect(await page.evaluate(() => document.documentElement.style.userSelect)).toBe('');
  const canceledWidth = await width(left);
  await page.mouse.move(x + 90, y);
  await page.mouse.up();
  await expect.poll(() => width(left)).toBeCloseTo(canceledWidth, 0);
});
