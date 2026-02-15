import { test, expect } from '@playwright/test';

test.describe('Mixer And Timeline Regression', () => {
  test('timeline track count equals project track count', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.waitForLoadState('networkidle');

    const timeline = page.getByTestId('timeline-view');
    await expect(timeline).toBeVisible();

    const trackCountRaw = await timeline.getAttribute('data-track-count');
    const trackIdsCountRaw = await timeline.getAttribute('data-track-ids-count');
    const trackCount = Number(trackCountRaw ?? '0');
    const trackIdsCount = Number(trackIdsCountRaw ?? '0');

    if (trackIdsCount > 0) {
      expect(trackCount).toBe(trackIdsCount);
    } else {
      expect(trackCount).toBe(1);
    }
  });

  test('track inspector shows large rectangular volume and pan faders', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.waitForLoadState('networkidle');

    const inspector = page.getByTestId('track-inspector');
    await expect(inspector).toBeVisible();

    const volume = inspector.getByTestId('track-volume-fader').first();
    const pan = inspector.getByTestId('track-pan-fader').first();

    await expect(volume).toBeVisible();
    await expect(pan).toBeVisible();

    const volumeBox = await volume.boundingBox();
    const panBox = await pan.boundingBox();
    expect(volumeBox).not.toBeNull();
    expect(panBox).not.toBeNull();
    expect(volumeBox!.width).toBeGreaterThan(80);
    expect(volumeBox!.height).toBeGreaterThan(14);
    expect(panBox!.width).toBeGreaterThan(65);
    expect(panBox!.height).toBeGreaterThan(14);

    const beforeDb = ((await volume.textContent()) ?? '').trim();
    await volume.hover();
    await page.mouse.down();
    await page.mouse.move(volumeBox!.x + volumeBox!.width - 4, volumeBox!.y + volumeBox!.height / 2);
    await page.mouse.up();
    const afterDb = ((await volume.textContent()) ?? '').trim();
    expect(afterDb).toContain('dB');
    expect(afterDb).not.toBe(beforeDb);

    await pan.dblclick();
    await expect(pan).toContainText('C');
  });
});
