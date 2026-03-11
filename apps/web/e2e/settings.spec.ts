import { expect, test, type Page } from '@playwright/test';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Password').fill('agent-console-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function addAlphaProject(page: Page): Promise<void> {
  await page.goto('/settings');
  const pageText = await page.locator('body').textContent();
  if (pageText?.includes('alpha--service')) {
    return;
  }

  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByRole('heading', { name: 'Add project' })).toBeVisible();
  await page.getByRole('button', { name: 'alpha' }).click();
  await page.getByRole('button', { name: 'service' }).click();
  await page.getByRole('button', { name: 'Add this project' }).click();
  await expect(page.locator('body')).toContainText('alpha--service');
  await expect(page.locator('body')).toContainText('alpha/service');
}

test.describe('settings project management', () => {
  test('preserves legacy history when startup migrates a saved top-level project to a nested path', async ({ page }) => {
    await login(page);

    await expect(page.locator('body')).toContainText('UberCoder');
    await expect(page.locator('body')).toContainText('Legacy migrated Codex conversation');

    await page.goto('/settings');
    await expect(page.locator('body')).toContainText('Config key: UberCoder');
    await expect(page.locator('body')).toContainText('agent-console-mvp/agent-console');
  });

  test('adds a nested explicit project from Settings and surfaces its history in the console tree', async ({ page }) => {
    await login(page);
    await addAlphaProject(page);
    await page.getByRole('link', { name: 'Back to Console' }).click();
    await expect(page.locator('body')).toContainText('Alpha nested Claude conversation');
  });

  test('removes a saved project and keeps it out of the console after reload', async ({ page }) => {
    await login(page);
    await addAlphaProject(page);

    await page.goto('/settings');
    const alphaProjectCard = page.locator('section').filter({ hasText: 'alpha--service' });
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await alphaProjectCard.getByRole('button', { name: 'Remove project' }).click();
    await expect(page.locator('body')).not.toContainText('alpha--service');

    await page.getByRole('link', { name: 'Back to Console' }).click();
    await expect(page.locator('body')).not.toContainText('Alpha nested Claude conversation');
    await page.reload();
    await expect(page.locator('body')).not.toContainText('Alpha nested Claude conversation');
  });
});
