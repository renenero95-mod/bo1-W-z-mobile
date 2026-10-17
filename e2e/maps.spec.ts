import { expect } from '@playwright/test';
import { enter, running, test } from './fixtures.ts';

declare global {
  var frames2s: () => { intervals: number[] } | null;
}

for (const slug of ['five', 'kino', 'riese', 'nacht', 'verruckt', 'shinonuma', 'ascension', 'cotd', 'shangrila', 'moon']) {
  test(`${slug} : un clic à « Prêt » entre en jeu, souris capturée, la partie démarre seule, sans son introuvable`, async ({ player }) => {
    await enter(player, `/${slug}`);
    await running(player);
    await player.evaluate(() => { globalThis.frames2s = bo1z.engine()!.presentReader(); frames2s(); });
    await player.waitForTimeout(2000);
    const state = await player.evaluate(() => ({
      gone: document.querySelector('.kb-loading')!.classList.contains('kb-gone'),
      frames: frames2s()!.intervals.length,
      missing: bo1z.diagnostics.console.map(line => line.message).filter(message => /Could not open streaming sound/.test(message)),
    }));
    expect(state.gone).toBe(true);
    expect(state.frames).toBeGreaterThan(30);
    expect(state.missing).toEqual([]);
  });
}

