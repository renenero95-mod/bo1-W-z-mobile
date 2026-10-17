import { expect, test } from '@playwright/test';

test('un téléchargement coupé affiche « Téléchargement interrompu » et propose de reprendre', async ({ page }) => {
  await page.context().route('**/web/shaders/**', route => route.abort());
  await page.goto('/nacht');
  await expect(page.locator('.kb-error-title')).toHaveText('Téléchargement interrompu', { timeout: 60_000 });
  await expect(page.locator('.kb-primary')).toHaveText('Reprendre');
});
