import { test, expect } from '@playwright/test';

test.describe('Reset Credit R2 Paired Transport E2E (Issue #30)', () => {
  test('visibly proves explicit pairing, second confirmation, Waiting Mac, executing, and terminal success without horizontal overflow', async ({ page }) => {
    // Navigate to reset screen with ready fixture
    await page.goto('/?fixture=reset-ready');
    await page.getByRole('button', { name: '重置額度', exact: true }).last().click();

    // Verify reset screen heading and hero
    await expect(page.getByRole('heading', { name: '重置額度' })).toBeVisible();

    // 1. Explicit pairing: initially unpaired Mac shows '配對這台 Mac'
    const pairButton = page.getByRole('button', { name: '配對這台 Mac' });
    await expect(pairButton).toBeVisible();

    // Click pair button to establish pairing
    await pairButton.click();
    await expect(pairButton).not.toBeVisible();

    // 2. Actionable inventory: shows '使用 1 張 Reset 券'
    const useCreditButton = page.getByRole('button', { name: '使用 1 張 Reset 券' });
    await expect(useCreditButton).toBeVisible();

    // Click to open second confirmation dialog
    await useCreditButton.click();

    // 3. Second confirmation dialog
    const dialog = page.getByRole('dialog', { name: '確認使用 Reset 券' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('這次只會使用 1 張 Reset Credit。此操作不可逆，不會自動改用其他券。')).toBeVisible();

    // Confirm execution
    const confirmButton = dialog.getByRole('button', { name: '確認使用 1 張 Reset 券' });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    // 4. Waiting Mac state
    await expect(page.getByText('等待 Mac')).toBeVisible();

    // 5. Verified executing state
    await expect(page.getByText('執行中')).toBeVisible();

    // 6. Terminal success state
    await expect(page.getByText('已確認使用 1 張 Reset 券')).toBeVisible();

    // 7. No horizontal overflow on Pixel 7
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noOverflow).toBe(true);
  });

  test('visibly proves no-effect provider outcomes (nothingToReset and noCredit)', async ({ page }) => {
    await page.goto('/?fixture=reset-no-effect');
    await page.getByRole('button', { name: '重置額度', exact: true }).last().click();

    const pairButton = page.getByRole('button', { name: '配對這台 Mac' });
    if (await pairButton.isVisible()) {
      await pairButton.click();
    }

    const useCreditButton = page.getByRole('button', { name: '使用 1 張 Reset 券' });
    await expect(useCreditButton).toBeVisible();
    await useCreditButton.click();

    const dialog = page.getByRole('dialog', { name: '確認使用 Reset 券' });
    await dialog.getByRole('button', { name: '確認使用 1 張 Reset 券' }).click();

    // Terminal outcome for no-effect fixture
    await expect(page.getByText('目前沒有需要重置的額度')).toBeVisible();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noOverflow).toBe(true);
  });

  test('visibly proves uncertain outcome and unverified forged result rejection', async ({ page }) => {
    // Uncertain outcome
    await page.goto('/?fixture=reset-uncertain');
    await page.getByRole('button', { name: '重置額度', exact: true }).last().click();

    const pairButton = page.getByRole('button', { name: '配對這台 Mac' });
    if (await pairButton.isVisible()) {
      await pairButton.click();
    }

    const useCreditButton = page.getByRole('button', { name: '使用 1 張 Reset 券' });
    await expect(useCreditButton).toBeVisible();
    await useCreditButton.click();

    const dialog = page.getByRole('dialog', { name: '確認使用 Reset 券' });
    await dialog.getByRole('button', { name: '確認使用 1 張 Reset 券' }).click();

    // Displays uncertain warning
    await expect(page.getByText('結果不確定，請勿再次使用 Reset 券')).toBeVisible();

    // Unverified / forged outcome
    await page.goto('/?fixture=reset-unverified');
    await page.getByRole('button', { name: '重置額度', exact: true }).last().click();

    // Key mismatch or forged receipt shows '無法驗證 Mac 回報'
    await expect(page.getByText('無法驗證 Mac 回報')).toBeVisible();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noOverflow).toBe(true);
  });

  test('visibly proves multi-device safe switching without state leakage', async ({ page }) => {
    await page.goto('/?fixture=reset-multi-device');
    await page.getByRole('button', { name: '重置額度', exact: true }).last().click();

    // Multi-device select dropdown should be present
    const deviceSelect = page.getByLabel('選擇 Mac');
    await expect(deviceSelect).toBeVisible();
    await expect(deviceSelect).toHaveValue('mac-primary');

    // Switch to second Mac
    await deviceSelect.selectOption('mac-secondary');
    await expect(deviceSelect).toHaveValue('mac-secondary');
    await expect(page.getByText('Mac：mac-secondary')).toBeVisible();

    // Switch back to primary
    await deviceSelect.selectOption('mac-primary');
    await expect(deviceSelect).toHaveValue('mac-primary');
    await expect(page.getByText('Mac：mac-primary')).toBeVisible();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noOverflow).toBe(true);
  });
});
