import { expect, test } from '@playwright/test';

test('mobile analytics switches 1d 7d 30d truthfully', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '使用統計', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: '使用統計' })).toBeVisible();
  await expect(page.getByRole('button', { name: '近 7 天' })).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('region', { name: 'Token 使用量' })).toContainText('294.0M');
  await expect(page.getByRole('region', { name: '估算 API 等值費用' })).toContainText('費用資料累積中');
  await page.getByRole('button', { name: '今日' }).click();
  await expect(page.getByRole('region', { name: 'Token 使用量' })).toContainText('46.50M');
  await expect(page.getByRole('region', { name: '估算 API 等值費用' })).toContainText('US$43.00');
  await page.getByRole('button', { name: '近 30 天' }).click();
  await expect(page.getByRole('region', { name: '估算 API 等值費用' })).toContainText('US$687.00');
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width);
});

test('desktop analytics keeps desktop navigation and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '使用統計', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '使用統計' })).toBeVisible();
  await expect(page.locator('.desktop-nav')).toBeVisible();
  await expect(page.locator('.bottom-nav')).toBeHidden();
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width);
});
