import { expect, type Page, test } from '@playwright/test';
import { socketFrom } from '../test/relay.ts';

const sockets: WebSocket[] = [];
test.afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });
async function room(name: string, map: string, player: string, extra = '') {
  const socket = socketFrom(`ws://127.0.0.1:8630/signal?room=${name}&map=${map}&player=${player}${extra}`, 'http://127.0.0.1:8630');
  await new Promise(resolve => { socket.onmessage = resolve; });
  sockets.push(socket);
}
const blankMapPages = (page: Page) => page.route(/\/[a-z]+\?room=/, route => route.fulfill({ contentType: 'text/html', body: '' }));

test('Solo : les dix cartes, le Mode Enfer grise les quatre sans mode horde, la vue liste', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.mapc')).toHaveCount(10);
  await page.click('#hell');
  await expect(page.locator('.mapc.off')).toHaveCount(4);
  await page.click('#hell');
  await expect(page.locator('.mapc.off')).toHaveCount(0);
  await page.click('[data-view=list]');
  await expect(page.locator('.solo-list .row')).toHaveCount(10);
});

test('Multijoueur : les salons publics avec leurs joueurs, jamais les privés', async ({ page }) => {
  await room('KXQZ', 'moon', 'Thomas');
  await room('MZTR', 'cotd', 'Ines', '&private=1');
  await page.goto('/');
  await page.click('#tab-multi');
  await expect(page.locator('.rlist .line')).toHaveCount(1);
  await expect(page.locator('.rlist .line')).toContainText(['KXQZ']);
  await expect(page.locator('.rlist .line')).toContainText(['Thomas']);
  await expect(page.locator('#rooms')).not.toContainText('MZTR');
});

test('Rejoindre avec un code : un code inconnu le dit, celui d’un salon privé ouvre sa carte', async ({ page }) => {
  await room('MZTR', 'cotd', 'Ines', '&private=1');
  await blankMapPages(page);
  await page.goto('/');
  await page.click('#tab-multi');
  await page.click('#open-code');
  await page.keyboard.type('BRTM');
  await expect(page.locator('#code-note')).toHaveText('Aucun salon avec ce code');
  await expect(page.locator('#join-code')).toBeDisabled();
  for (let k = 0; k < 4; k++) await page.keyboard.press('Backspace');
  await page.keyboard.type('MZTR');
  await expect(page.locator('#join-code')).toBeEnabled();
  const request = page.waitForRequest(/\/cotd\?/);
  await page.click('#join-code');
  expect(new URL((await request).url()).search).toBe('?room=MZTR&private=1');
});

test('Créer un salon : la carte choisie ouvre un code de quatre consonnes, privé si l’interrupteur est mis', async ({ page }) => {
  await blankMapPages(page);
  await page.goto('/');
  await page.click('#tab-multi');
  await page.click('#create');
  await page.click('#private');
  const request = page.waitForRequest(/\/[a-z]+\?room=/);
  await page.locator('.mapc').first().click();
  expect(new URL((await request).url()).search).toMatch(/^\?room=[BCDFGHJKLMNPQRSTVWXZ]{4}&private=1$/);
});

test('Options : la sensibilité réglée est gardée pour les pages de carte', async ({ page }) => {
  await page.goto('/');
  await page.click('#open-options');
  await page.locator('#o-sens').fill('2.5');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('bo1z-settings')))!).sensitivity).toBe(2.5);
});

test.describe('un navigateur en allemand', () => {
  test.use({ locale: 'de-DE' });

  test('Langue : ni français ni anglais, le menu et les pages de carte sont en anglais', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#tab-multi')).toContainText('Multiplayer');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.context().route('**/web/shaders/**', route => route.abort());
    await page.goto('/nacht');
    await expect(page.locator('.kb-error-title')).toHaveText('Download interrupted', { timeout: 60_000 });
  });

  test('Langue : Français choisi dans les Options passe le menu en français tout de suite, et le reste', async ({ page }) => {
    await page.goto('/');
    await page.click('#open-options');
    await page.click('#o-lang [lang=fr]');
    await expect(page.locator('#tab-multi')).toContainText('Multijoueur');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.reload();
    await expect(page.locator('#tab-multi')).toContainText('Multijoueur');
  });
});
