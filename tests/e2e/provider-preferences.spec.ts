import { expect, test } from '@playwright/test';

test('source switches persist and remove disabled family from home and statistics', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).last().click();
  const codex = page.getByRole('switch', { name: 'Codex 資料來源' });
  await expect(codex).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => sessionStorage.setItem('e2e-provider-preferences', JSON.stringify([
    {schemaVersion: 1, userId: 'e2e-user', family: 'codex', enabled: true, updatedAt: '2026-09-05T10:00:05.000Z', notifications: {lowQuota: true, reset: true}},
  ])));
  await codex.click();
  const preserved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e-provider-preferences') ?? '[]'));
  expect(preserved.find((item: {family: string}) => item.family === 'codex').notifications).toEqual({lowQuota: true, reset: true});
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Codex 資料來源' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '首頁', exact: true }).last().click();
  await expect(page.getByRole('region', { name: 'Codex 額度' })).toHaveCount(0);
  await page.getByRole('button', { name: '使用統計', exact: true }).last().click();
  await expect(page.getByRole('region', { name: 'Token 使用量' })).toContainText('98.00M');
  await page.getByRole('button', { name: '設定', exact: true }).last().click();
  await expect(page.getByRole('switch')).toHaveCount(11);
  for (const toggle of await page.getByRole('switch').all()) {
    const box = await toggle.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});
