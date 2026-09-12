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

  // Switch to 90 days: truthful coverage for 31 available days, no fake zero bars, no overflow
  await page.getByRole('button', { name: '近 90 天' }).click();
  await expect(page.getByRole('button', { name: '近 90 天' })).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('status', { name: /資料涵蓋範圍|歷史資料涵蓋範圍/ })).toContainText('31');
  const size90 = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size90.scrollWidth).toBeLessThanOrEqual(size90.width);

  // Switch to 180 days: truthful coverage for 31 available days, no overflow
  await page.getByRole('button', { name: '近 180 天' }).click();
  await expect(page.getByRole('button', { name: '近 180 天' })).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('status', { name: /資料涵蓋範圍|歷史資料涵蓋範圍/ })).toContainText('31');
  const size180 = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size180.scrollWidth).toBeLessThanOrEqual(size180.width);

  // Verify chart bars count equals the actual available days (31), not 180 fake bars
  const barsCount = await page.locator('.usage-trend__bars span').count();
  expect(barsCount).toBe(31);
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

test('mobile analytics renders dense 180-day history with 180 bars and no horizontal overflow', async ({ page }) => {
  await page.goto('/?fixture=dense180');
  await page.getByRole('button', { name: '使用統計', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: '使用統計' })).toBeVisible();
  await page.getByRole('button', { name: '近 180 天' }).click();
  await expect(page.getByRole('button', { name: '近 180 天' })).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('region', { name: 'Token 使用量' })).toContainText('24.4B');
  await expect(page.locator('.history-provider-card').filter({ hasText: 'Codex' })).toContainText('16.3B');
  await expect(page.locator('.history-provider-card').filter({ hasText: 'Antigravity' })).toContainText('8.14B');
  await expect(page.locator('.usage-trend')).toHaveAttribute('aria-label', /24B tokens/);
  const barsCount = await page.locator('.usage-trend__bars span').count();
  expect(barsCount).toBe(180);
  await expect(page.locator('.usage-trend figcaption')).toContainText('03/10');
  await expect(page.locator('.usage-trend figcaption')).toContainText('09/05');
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width);
});

test('desktop analytics renders dense 180-day history with 180 bars and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?fixture=dense180');
  await page.getByRole('button', { name: '使用統計', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '使用統計' })).toBeVisible();
  await expect(page.locator('.desktop-nav')).toBeVisible();
  await expect(page.locator('.bottom-nav')).toBeHidden();
  await page.getByRole('button', { name: '近 180 天' }).click();
  await expect(page.getByRole('button', { name: '近 180 天' })).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('region', { name: 'Token 使用量' })).toContainText('24.4B');
  await expect(page.locator('.history-provider-card').filter({ hasText: 'Codex' })).toContainText('16.3B');
  await expect(page.locator('.history-provider-card').filter({ hasText: 'Antigravity' })).toContainText('8.14B');
  await expect(page.locator('.usage-trend')).toHaveAttribute('aria-label', /24B tokens/);
  const barsCount = await page.locator('.usage-trend__bars span').count();
  expect(barsCount).toBe(180);
  await expect(page.locator('.usage-trend figcaption')).toContainText('03/10');
  await expect(page.locator('.usage-trend figcaption')).toContainText('09/05');
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width);
});
