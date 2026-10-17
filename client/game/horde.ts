// The wasm heap is a fixed 2 GiB: 1024 zombies with a 192 MB cache exhausted it, 128 MB held round 100's 924 alive on Five.
// Capped at 300 in the browser (the native launcher ran 600).
const HORDE_MIN = 24;
const HORDE_MAX = 300;
const SKIN_CACHE_MAX_MB = 128;

export type Horde = { n: number; round: number };
export const hordeDefaults: Horde = { n: 300, round: 100 };
// zinfo: the zombie counter on Tab; noperks: no perk machines.
const MODS = ['zinfo', 'noperks'];

export function hordeCount(value: unknown) {
  const n = parseInt(String(value), 10);
  return Math.max(HORDE_MIN, Math.min(HORDE_MAX, Number.isNaN(n) ? hordeDefaults.n : n));
}

export function hordeRound(value: unknown) {
  const round = parseInt(String(value), 10);
  return Math.max(1, Math.min(255, Number.isNaN(round) ? hordeDefaults.round : round));
}

// They must precede +devmap, as fs_mods does.
export function hordeArguments(horde: Horde) {
  const n = hordeCount(horde.n), round = hordeRound(horde.round);
  const set: [string, string | number][] = [['fs_mods', ['horde', ...MODS].join(' ')], ['horde_max_zombies', n],
    ['kisak_mod_maxactors', Math.min(1024, Math.max(32, n + 40))]];
  if (n > 100) set.push(['r_mod_skinCacheMB', Math.min(SKIN_CACHE_MAX_MB, Math.max(32, 16 * Math.ceil((n * 70 * 1.5 / 600 + 0.15625) / 16)))]);
  if (n > 150) set.push(['r_mod_gfxEnts', Math.min(2048, 256 * Math.ceil((n + 128) / 256))]);
  set.push(['kisak_mod_scriptperf', 1]);
  if (round > 1) set.push(['horde_start_round', round]);
  set.push(['zinfo', 1], ['noperks', 1]);
  return set.flatMap(([name, value]) => ['+set', name, String(value)]);
}
