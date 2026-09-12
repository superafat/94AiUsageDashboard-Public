import { expect, test } from '@playwright/test';

test('reset credits remain explicit read-only product navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '重置額度', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: '重置額度' })).toBeVisible();
  await expect(page.getByText('目前僅供查看')).toBeVisible();
  await expect(page.getByText('#003')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(使用|兌換|確認使用|立即重置)$/ })).toHaveCount(0);
});

test('settings exposes Mac setup and privacy help inside the product', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
  await expect(page.getByText('Provider 憑證不離開 Mac')).toBeVisible();
  await page.getByRole('button', { name: /使用說明與隱私/ }).click();
  await expect(page.getByRole('heading', { name: '使用說明' })).toBeVisible();
});

test('main mobile navigation meets 44px touch targets and keyboard focus works', async ({ page }) => {
  await page.goto('/');
  const buttons = page.locator('.bottom-nav__item');
  await expect(buttons).toHaveCount(4);
  for (let i = 0; i < 4; i += 1) {
    const box = await buttons.nth(i).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});

test('settings opens version updates and the mobile update view does not overflow', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).last().click();
  await page.getByRole('button', { name: /更新與公告/ }).click();
  await expect(page.getByRole('heading', { name: '更新與公告' })).toBeVisible();
  await expect(page.getByText('v0.1.4')).toBeVisible();
  await expect(page.getByText('目前版本', { exact: true })).toBeVisible();
  await expect(page.getByText(/推播通知現在會標示可確認的 AI 來源與額度種類/)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
