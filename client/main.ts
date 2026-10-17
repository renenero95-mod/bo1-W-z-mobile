import { MAPS } from './catalog.ts';

// No router: the engine only gives its memory back with the page, so leaving a map reloads the page anyway.
const slug = location.pathname.split('/').pop();
if (MAPS.some(map => map.slug === slug)) import('./map/main.ts');
else import('./menu/main.ts');
