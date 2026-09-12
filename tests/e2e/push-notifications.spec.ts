import { expect, test } from '@playwright/test';

test('notification enrollment, platform onboarding and independent channels persist without claiming phone receipt', async ({ page }) => {
  await page.goto('/#settings');

  // Verify platform onboarding section
  const onboardingHeading = page.getByText('選擇你的手機版本');
  await expect(onboardingHeading).toBeVisible();

  const iphoneBtn = page.getByRole('button', { name: '我是 iPhone 使用者' });
  const androidBtn = page.getByRole('button', { name: '我是 Android 使用者' });
  await expect(iphoneBtn).toBeVisible();
  await expect(androidBtn).toBeVisible();

  // Verify 44px+ touch target size
  const iphoneBox = await iphoneBtn.boundingBox();
  expect(iphoneBox).not.toBeNull();
  expect(iphoneBox!.height).toBeGreaterThanOrEqual(44);
  expect(iphoneBox!.width).toBeGreaterThanOrEqual(44);

  const androidBox = await androidBtn.boundingBox();
  expect(androidBox).not.toBeNull();
  expect(androidBox!.height).toBeGreaterThanOrEqual(44);
  expect(androidBox!.width).toBeGreaterThanOrEqual(44);

  // Test iPhone flow selection
  await iphoneBtn.click();
  await expect(page.getByText(/Safari/)).toBeVisible();
  await expect(page.getByText(/加入主畫面/)).toBeVisible();
  await expect(page.getByText(/專注模式/)).toBeVisible();
  await expect(page.getByText(/電池最佳化/)).not.toBeVisible();

  // Test Android flow selection
  await androidBtn.click();
  await expect(page.getByText(/Chrome/).first()).toBeVisible();
  await expect(page.getByText(/電池最佳化/)).toBeVisible();
  await expect(page.getByText(/專注模式/)).not.toBeVisible();

  // Common troubleshooting is visible
  await expect(page.getByText(/常見問題與排查/)).toBeVisible();

  // Existing push controls still work
  const consumed = page.getByRole('switch', { name: 'Codex 每耗用10%通知' });
  const reset = page.getByRole('switch', { name: 'Codex 額度重置通知' });
  await expect(consumed).toHaveAttribute('aria-checked', 'false');
  await expect(reset).toHaveAttribute('aria-checked', 'false');
  await consumed.click();
  await expect(consumed).toHaveAttribute('aria-checked', 'true');
  await expect(reset).toHaveAttribute('aria-checked', 'false');
  await reset.click();
  await page.reload();
  await expect(consumed).toHaveAttribute('aria-checked', 'true');
  await expect(reset).toHaveAttribute('aria-checked', 'true');

  const enable = page.getByRole('button', { name: '啟用推播通知' });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(page.getByText('推播通知已啟用', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('推播通知已啟用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '發送測試推播' }).click();
  await expect(page.getByText(/測試請求已保存.*尚未確認手機收到/)).toBeVisible();
  await page.getByRole('button', { name: '停用推播通知' }).click();
  await expect(page.getByText('尚未啟用推播通知', { exact: true })).toBeVisible();
  await expect(consumed).toHaveAttribute('aria-checked', 'true');
  await expect(reset).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/約每 5 分鐘/).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
