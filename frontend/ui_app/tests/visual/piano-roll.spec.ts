import { test, expect } from '@playwright/test';

test.describe('Piano Roll Visual Regression', () => {
  test('piano roll shell snapshot', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.waitForLoadState('networkidle');

    const clipEditorToggle = page.getByTitle('Clip Editor (Shift+Tab)');
    if (await clipEditorToggle.count()) {
      await clipEditorToggle.first().click();
    }

    const pianoRoll = page.getByTestId('piano-roll');
    const hasPianoRoll = (await pianoRoll.count()) > 0;
    test.skip(!hasPianoRoll, 'No active MIDI clip in default project to open Piano Roll.');

    await expect(pianoRoll).toBeVisible();
    await expect(pianoRoll).toHaveScreenshot('piano-roll-shell.png');
  });
});
