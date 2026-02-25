import { test, expect } from '@playwright/test';

test.describe('Core Layout Visual Regression', () => {
  test('transport / browser / timeline / inspector', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.waitForLoadState('networkidle');

    const transport = page.getByTestId('transport-bar');
    await expect(transport).toBeVisible();

    const browser = page.getByTestId('asset-browser');
    await expect(browser).toBeVisible();
    await expect(browser).toHaveScreenshot('asset-browser.png');

    const timeline = page.getByTestId('timeline-view');
    await expect(timeline).toBeVisible();
    await expect(timeline).toHaveScreenshot('timeline-view.png');

    const inspector = page.getByTestId('track-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveScreenshot('track-inspector.png');
  });
});
