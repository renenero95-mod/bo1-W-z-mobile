import { expect } from '@playwright/test';
import { BASE, enter, loadingGone, play, test, view } from './fixtures.ts';

test('deux joueurs : l’invité entre dans la partie de l’hôte en liaison directe, sans serveur local, y joue, puis apprend son départ', async ({ player, guest }) => {
  await enter(player, '/nacht?room=QZRT');
  await enter(guest, '/nacht?room=QZRT');
  await loadingGone(guest);
  expect(await player.evaluate(() => bo1z.net.link.label)).toBe('10.0.0.1');
  expect(await guest.evaluate(() => ({ label: bo1z.net.link.label, linked: bo1z.net.link.linked, relayed: bo1z.net.link.relayed }))).toEqual({ label: '10.0.0.2', linked: true, relayed: false });
  expect(await guest.evaluate(() => bo1z.diagnostics.console.some(row => row.message.includes('Server Initialization')))).toBe(false);
  await expect.poll(async () => (await view(guest)).frozen, { timeout: 15_000 }).toBe(false);
  const { origin } = await view(guest);
  await guest.keyboard.down('s');
  await guest.waitForTimeout(1_500);
  await guest.keyboard.up('s');
  await expect.poll(async () => (await view(guest)).origin, { timeout: 5_000 }).not.toBe(origin);
  await player.goto('about:blank');
  await expect(guest.locator('.kb-error-title')).toHaveText('L’hôte a quitté la partie', { timeout: 20_000 });
});

test('salon privé : absent de la liste, rejoint par son code depuis le menu, ses joueurs en badges au chargement', async ({ player, guest }) => {
  await enter(player, '/kino?room=MZTR&private=1');
  await guest.goto(`${BASE}/`);
  await guest.click('#tab-multi');
  await expect(guest.locator('#rooms')).not.toContainText('MZTR');
  await guest.click('#open-code');
  await guest.keyboard.type('MZTR');
  await guest.click('#join-code');
  await guest.waitForURL(/\/kino\?room=MZTR&private=1$/);
  await play(guest);
  await loadingGone(guest);
  expect(await guest.evaluate(() => ({ label: bo1z.net.link.label, linked: bo1z.net.link.linked }))).toEqual({ label: '10.0.0.2', linked: true });
  await expect(guest.locator('.kb-party span')).toHaveCount(2);
});
