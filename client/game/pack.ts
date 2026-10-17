import { MAPS } from '../catalog.ts';
import type { Pack } from '../download/protocol.ts';

// Map pages are served at <prefix><slug>: their directory is the site root, whatever the prefix.
export const BASE = new URL('.', location.href).pathname;
export const map = MAPS.find(entry => entry.slug === location.pathname.split('/').pop())!;
const query = new URLSearchParams(location.search);
export const horde = query.get('horde') === '1' && Boolean(map.horde);
export const room = query.get('room');
export const hiddenRoom = query.get('private') === '1';
export const connectTo = query.get('connect');

// Five keeps the root and the "pack" OPFS directory from before the other maps: its players re-download nothing.
const root = map.first ? BASE : `${BASE}${map.slug}/`;
const opfs = map.first ? 'pack' : `pack-${map.slug}`;
export const packBase = `${root}pack/`;
export const opfsRoot = `/opfs/${opfs}/files`;
// The horde manifest is the map's plus the mods' small boot files: a player who has the map only fetches those.
export const pack: Pack = { manifestUrl: horde ? `${packBase}web-manifest-horde.json` : `${root}manifest.json`, packBase, opfs };
export const programsUrl = `${BASE}artifacts/${map.slug}-programs.json`;
