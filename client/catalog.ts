// size: GB downloaded from vel.gg on first launch (Brotli parts of the 2026-10-09 manifests).
// first: Five keeps the site's root URLs (/manifest.json, /pack/, that is /bo1z/… on vel.gg).
// engineS: engine load seconds before any measurement on this machine (27 by default).
// Names, places and descriptions are in client/i18n/: « Five » is quoted differently in each language.
export type GameMap = { era: string; slug: string; zone: string; size: number; horde?: boolean; first?: boolean; engineS?: number };

export const MAPS: GameMap[] = [
  { era: 'World at War', slug: 'nacht', zone: 'zombie_cod5_prototype', size: 0.28, horde: true },
  { era: 'World at War', slug: 'verruckt', zone: 'zombie_cod5_asylum', size: 0.31, horde: true },
  { era: 'World at War', slug: 'shinonuma', zone: 'zombie_cod5_sumpf', size: 0.30, horde: true },
  { era: 'World at War', slug: 'riese', zone: 'zombie_cod5_factory', size: 0.34, horde: true },
  { era: 'Black Ops', slug: 'kino', zone: 'zombie_theater', size: 0.33, horde: true, engineS: 20 },
  { era: 'Black Ops', slug: 'five', zone: 'zombie_pentagon', size: 0.32, horde: true, first: true },
  { era: 'Black Ops', slug: 'ascension', zone: 'zombie_cosmodrome', size: 0.33 },
  { era: 'Black Ops', slug: 'cotd', zone: 'zombie_coast', size: 0.33 },
  { era: 'Black Ops', slug: 'shangrila', zone: 'zombie_temple', size: 0.34 },
  { era: 'Black Ops', slug: 'moon', zone: 'zombie_moon', size: 0.40 },
];
