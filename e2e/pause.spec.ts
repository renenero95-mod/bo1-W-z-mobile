import { expect } from '@playwright/test';
import { BASE, enter, paused, running, test } from './fixtures.ts';

test('Échap met une partie solo en pause', async ({ player }) => {
  await enter(player, '/nacht');
  await running(player);
  await player.keyboard.press('Escape');
  await expect.poll(() => paused(player), { timeout: 5000 }).toBe('1');
});

test('dans un salon, Échap ouvre le menu sans arrêter la partie', async ({ player }) => {
  await enter(player, '/nacht?room=PZTK');
  await running(player);
  await player.keyboard.press('Escape');
  await player.waitForTimeout(1500);
  expect(await paused(player)).toBe('0');
});

test('dans un salon, l’écran « Prêt » ne met pas la partie en pause', async ({ player }) => {
  await player.goto(`${BASE}/nacht?room=PZTL`);
  await player.waitForFunction(() => bo1z.view.screen === 'ready', null, { timeout: 150_000 });
  expect(await paused(player)).toBe('0');
});
