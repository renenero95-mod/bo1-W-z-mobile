import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import test from 'node:test';
import { relay } from './relay.ts';

test('une page de carte est la page du site, isolée comme elle ; avec un / final, elle y renvoie', async t => {
  const child = await relay(8616, 0);
  t.after(() => child.kill());
  const moon = await fetch('http://127.0.0.1:8616/moon?room=soiree');
  assert.match(moon.headers.get('content-type')!, /^text\/html\b/);
  assert.equal(moon.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(await moon.text(), await readFile(new URL('../dist/index.html', import.meta.url), 'utf8'));
  const slash = await fetch('http://127.0.0.1:8616/verruckt/?room=soiree', { redirect: 'manual' });
  assert.equal(slash.headers.get('location'), '/verruckt?room=soiree');
});

test('le menu et le site sont servis depuis dist/ à la racine, la colle du moteur avec ses crochets et le wasm patché, les fichiers hachés en cache pour de bon', async t => {
  const child = await relay(8617, 0);
  t.after(() => child.kill());
  const menu = await fetch('http://127.0.0.1:8617/?room=soiree');
  assert.match(menu.headers.get('content-type')!, /^text\/html\b/);
  assert.match(await menu.text(), /<div id="app"><\/div>/);
  const glue = await fetch('http://127.0.0.1:8617/artifacts/KisakBlack-web.mjs');
  assert.match(glue.headers.get('content-type')!, /^(text|application)\/javascript\b/);
  assert.equal(await glue.text(), await readFile(new URL('../engine/KisakBlack-web.mjs', import.meta.url), 'utf8'));
  const wasm = await (await fetch('http://127.0.0.1:8617/artifacts/KisakBlack-web.wasm')).arrayBuffer();
  assert.ok(WebAssembly.Module.imports(new WebAssembly.Module(wasm)).some(({ name }) => name === 'kb_net_send'));
  const kbnet = await fetch('http://127.0.0.1:8617/kbnet.js');
  assert.match(await kbnet.text(), /export\s*\{/);
  assert.equal(kbnet.headers.get('cache-control'), 'public, max-age=0');
  const asset = /assets\/index-\w+\.js/.exec(await (await fetch('http://127.0.0.1:8617/')).text())![0];
  assert.equal((await fetch(`http://127.0.0.1:8617/${asset}`)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('avec PREFIX=/bo1z, le site est servi sous /bo1z/ et la racine y mène', async t => {
  const child = await relay(8621, 0, { PREFIX: '/bo1z' });
  t.after(() => child.kill());
  const at = (path: string) => fetch(`http://127.0.0.1:8621${path}`, { redirect: 'manual' });
  for (const [from, to] of [['/?room=soiree', '/bo1z/?room=soiree'], ['/bo1z', '/bo1z/']]) assert.equal((await at(from)).headers.get('location'), to);
  assert.match(await (await at('/bo1z/?room=soiree')).text(), /<div id="app"><\/div>/);
  assert.match(await (await at('/bo1z/verruckt')).text(), /<div id="app"><\/div>/);
  assert.equal((await (await at('/bo1z/telemetry')).json()).enabled, true);
  assert.equal((await at('/verruckt')).status, 404);
});

test('la télémétrie ne s’ouvre qu’aux pages de ce poste, pas à celles venues du réseau comme sur Heroku', async t => {
  const lan = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  if (!lan) return t.skip('aucune adresse réseau hors de la boucle locale');
  const child = await relay(8619, 0, { HOST: '0.0.0.0' });
  t.after(() => child.kill());
  assert.equal((await (await fetch('http://127.0.0.1:8619/telemetry')).json()).enabled, true);
  assert.equal((await (await fetch(`http://${lan}:8619/telemetry`)).json()).enabled, false);
  assert.equal((await fetch(`http://${lan}:8619/telemetry`, { method: 'POST', body: '{}' })).status, 403);
});

test('avec TELEMETRY=1, la télémétrie s’ouvre aussi aux pages des autres machines du réseau', async t => {
  const lan = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  if (!lan) return t.skip('aucune adresse réseau hors de la boucle locale');
  const child = await relay(8620, 0, { HOST: '0.0.0.0', TELEMETRY: '1' });
  t.after(() => child.kill());
  assert.equal((await (await fetch(`http://${lan}:8620/telemetry`)).json()).enabled, true);
});
