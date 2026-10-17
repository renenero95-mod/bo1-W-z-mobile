import { createApp } from 'vue';
import { diagnostics } from '../game/diagnostics.ts';
import { horde, map } from '../game/pack.ts';
import { currentEngine, view } from '../game/session.ts';
import { i18n } from '../i18n/index.ts';
import * as net from '../net/link.ts';
import MapScreen from './MapScreen.vue';
import './map.css';

const { t } = i18n.global;
document.title = horde ? `${t(`maps.${map.slug}.name`)} · ${t('hellMode')}` : t(`maps.${map.slug}.name`);
createApp(MapScreen).use(i18n).mount('#app');
// Handle for tests and the browser console; no module reads it.
const handle = { view, diagnostics, net, engine: currentEngine };
export type Handle = typeof handle;
Object.assign(globalThis, { bo1z: handle });
