import { test as base, chromium, expect, type Page } from '@playwright/test';
import type { Handle } from '../client/map/main.ts';

declare global {
  var bo1z: Handle;
}

export const BASE = 'http://127.0.0.1:8630';

// Headed: without a window, Chrome refuses the pointer lock and the click at "Prêt" does not enter the game.
// Profiles kept in .cache/e2e: each map only downloads on the first run.
async function browser(name: string, use: (page: Page) => Promise<void>) {
  const context = await chromium.launchPersistentContext(new URL(`../.cache/e2e/${name}`, import.meta.url).pathname,
    { channel: 'chrome', headless: false, viewport: { width: 1280, height: 720 }, locale: 'fr-FR' });
  await use(context.pages()[0] ?? await context.newPage());
  await context.close();
}

export const test = base.extend<{}, { player: Page; guest: Page }>({
  player: [async ({}, use) => browser('player', use), { scope: 'worker' }],
  guest: [async ({}, use) => browser('guest', use), { scope: 'worker' }],
});

export async function play(page: Page) {
  await page.waitForFunction(() => globalThis.bo1z?.view.screen === 'ready', null, { timeout: 150_000 });
  await page.bringToFront();
  await page.click('.kb-prompt');
  await page.waitForFunction(() => bo1z.view.screen === 'playing' && document.pointerLockElement, null, { timeout: 30_000 });
}

export async function enter(page: Page, path: string) {
  await page.goto(BASE + path);
  await play(page);
}

// The engine's view line, once a second: the player's origin, and pm_flags 0x800 for frozen controls.
export async function view(page: Page) {
  const line = await page.evaluate(() => bo1z.diagnostics.console.findLast(row => row.message.startsWith('KISAK_BROWSER view'))?.message ?? '');
  const [, origin, flags] = /origin=(\S+) .* flags=([0-9a-f]+)/.exec(line) ?? [];
  return { origin, frozen: (parseInt(flags, 16) & 0x800) !== 0 };
}

export const loadingGone = (page: Page) => page.waitForFunction(() => document.querySelector('.kb-loading')!.classList.contains('kb-gone'), null, { timeout: 60_000 });

export async function paused(page: Page) {
  const from = await page.evaluate(() => bo1z.diagnostics.console.length);
  await page.evaluate(() => bo1z.net.command('cl_paused'));
  const line = await page.waitForFunction(from => bo1z.diagnostics.console.slice(from).map(row => row.message).find(message => /"cl_paused"/.test(message)), from);
  return /"cl_paused" is: "(\d)/.exec(String(await line.jsonValue()))?.[1];
}

// The page's intro hold raises cl_paused at the start of the game: wait for it to clear.
export const running = (page: Page) => expect.poll(() => paused(page), { timeout: 30_000 }).toBe('0');
