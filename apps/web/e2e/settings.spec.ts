import { expect, test, type Page } from '@playwright/test';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Password').fill('agent-console-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function addProject(page: Page, segments: string[]): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByRole('heading', { name: 'Add project' })).toBeVisible();
  for (const segment of segments) {
    await page.getByRole('button', { name: segment }).click();
  }
  await page.getByRole('button', { name: 'Add this project' }).click();
}

async function addAlphaProject(page: Page): Promise<void> {
  await page.goto('/settings');
  const pageText = await page.locator('body').textContent();
  if (pageText?.includes('alpha--service')) {
    return;
  }

  await addProject(page, ['alpha', 'service']);
  await expect(page.locator('body')).toContainText('alpha--service');
  await expect(page.locator('body')).toContainText('alpha/service');
}

test.describe('settings project management', () => {
  test('does not keep legacy top-level saved projects from the old auto-discovery model', async ({ page }) => {
    await login(page);

    await page.goto('/settings');
    await expect(page.locator('body')).toContainText('No saved projects yet');
    await expect(page.locator('body')).not.toContainText('UberCoder');
  });

  test('adds a nested explicit project from Settings and surfaces its history in the console tree', async ({ page }) => {
    await login(page);
    await addProject(page, ['UberCoder', 'agent-console-mvp', 'agent-console']);
    await expect(page.locator('body')).toContainText('UberCoder--agent-console-mvp--agent-console');
    await expect(page.locator('body')).toContainText('agent-console-mvp/agent-console');
    await page.getByRole('link', { name: 'Back to Console' }).click();
    await expect(page.locator('body')).toContainText('Legacy migrated Codex conversation');
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
