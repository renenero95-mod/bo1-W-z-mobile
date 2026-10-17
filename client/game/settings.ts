import { type Horde, hordeCount, hordeDefaults, hordeRound } from './horde.ts';

// volumeChosen: a saved volume only counts if the player moved the slider; otherwise the game starts at 50 %.
export type Settings = { sensitivity: number; volume: number; volumeChosen: boolean; fullscreen: boolean; horde: Horde };

const KEY = 'bo1z-settings';

export function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY)!) ?? {};
  } catch {}
  const volumeChosen = saved.volumeChosen === true && Number.isFinite(saved.volume);
  return {
    sensitivity: Number.isFinite(saved.sensitivity) ? saved.sensitivity! : 5,
    volume: volumeChosen ? saved.volume! : 0.5,
    volumeChosen,
    fullscreen: saved.fullscreen === true,
    horde: { n: hordeCount(saved.horde?.n ?? hordeDefaults.n), round: hordeRound(saved.horde?.round ?? hordeDefaults.round) },
  };
}

export function saveSettings(change: Partial<Settings>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadSettings(), ...change }));
  } catch {}
}
