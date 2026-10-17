import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import test from 'node:test';
import { createI18n } from 'vue-i18n';
import { MAPS } from '../client/catalog.ts';
import en from '../client/i18n/en.ts';
import fr from '../client/i18n/fr.ts';

const walk = (messages: object, prefix = ''): [string, boolean][] => Object.entries(messages).flatMap(([key, value]) =>
  (typeof value === 'string' ? [[`${prefix}${key}`, true]] : [[`${prefix}${key}`, false], ...walk(value, `${prefix}${key}.`)]));
const known = new Set(walk(en).map(([path]) => path));
const leaves = walk(en).filter(([, leaf]) => leaf).map(([path]) => path);

// vue-i18n's typed t() still accepts any string: a mistyped key would show up on screen as its path.
test('chaque clé citée par le menu et les pages de carte existe dans les traductions', async () => {
  const key = new RegExp(`'((?:${Object.keys(en).join('|')})(?:\\.\\w+)*)'`, 'g');
  for await (const file of glob('client/{map,menu}/*.{ts,vue}')) {
    const source = await readFile(file, 'utf8');
    for (const [, path] of source.matchAll(key)) assert.ok(known.has(path), `${file} : ${path}`);
    for (const [, call] of source.matchAll(/\btexts\(([^,)]*)/g)) for (const [, name] of call.matchAll(/'(\w+)'/g)) assert.ok(known.has(`errors.${name}`), `${file} : errors.${name}`);
  }
});

test('chaque carte du catalogue a son nom, son lieu et sa description', () => {
  assert.deepEqual(Object.keys(en.maps).sort(), MAPS.map(map => map.slug).sort());
});

test('chaque message se formate en anglais et en français', t => {
  const warn = t.mock.method(console, 'warn');
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, fr } });
  const params = { n: 2, map: 'Moon', host: 'Thomas', room: 'KXQZ', code: 'KXQZ', pct: '62 %', size: '340 Mo', era: 'Black Ops', s: '1,2' };
  for (const locale of ['en', 'fr'] as const) {
    for (const path of leaves) {
      const text = i18n.global.t(path, params, { locale });
      assert.ok(text && text !== path && !/[{}|]/.test(text), `${locale} ${path} : ${text}`);
    }
  }
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), []);
});
