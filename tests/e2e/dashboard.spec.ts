import { expect, test } from '@playwright/test';

test('mobile homepage is summary-first and read-only without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI 額度儀表板' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Codex 額度' })).toContainText('5 小時額度');
  await expect(page.getByRole('region', { name: 'Codex 額度' })).toContainText('每週額度');
  await expect(page.getByRole('region', { name: 'Antigravity 額度' })).toContainText('Gemini 5 小時');
  await expect(page.getByRole('region', { name: 'Claude Code 額度' })).toContainText('63%');
  await expect(page.getByText('3 張可用')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(使用|兌換|確認使用|立即重置)$/ })).toHaveCount(0);
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width);
});

test('stale fixture is visibly marked', async ({ page }) => {
  await page.goto('/?fixture=stale');
  await expect(page.getByText(/資料可能已過期/).first()).toBeVisible();
});

test('installed shell reloads offline and immediately labels cached data offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => { if ('serviceWorker' in navigator) await navigator.serviceWorker.ready; });
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI 額度儀表板' })).toBeVisible();
  await expect(page.getByText(/目前離線/).first()).toBeVisible();
  await context.setOffline(false);
});
