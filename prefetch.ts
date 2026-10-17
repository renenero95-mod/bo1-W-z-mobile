import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { brotliDecompressSync } from 'node:zlib';
import { CHUNK, cachePath, cached, cachedBytes, upstream } from './server/cache.ts';
import { MAPS } from './client/catalog.ts';

const HEADERS = { 'user-agent': 'Mozilla/5.0 (bo1z-lan build)', 'accept-encoding': 'br, gzip, zstd' };
const PARALLEL = 4;

type FileSpec = { url: string; size: number; sha256: string; parts: number };
type Transport = { size: number; sha256: string; br?: number[] };
type ManifestFile = Transport & { path: string; dxs?: number; opus?: number; fallback?: Transport };

const absent: string[] = [];

// As client/download/worker.ts: ?part=k when br counts one part per slice, else in one piece; an Opus sound comes as .kop
// (its SHA-256 is the .kop's), plus the original file for browsers without AudioDecoder.
function packFiles(root: string, chunk: number, file: ManifestFile): FileSpec[] {
  if (file.dxs) throw new Error(`${file.path} : transport DXS non géré`);
  const pack = `${root}pack/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const real = (url: string, { size, sha256, br }: Transport) => ({ url, size, sha256, parts: Array.isArray(br) && br.length === Math.ceil(size / chunk) ? br.length : 0 });
  if (file.opus && file.fallback && Array.isArray(file.br)) return [{ url: `${pack}.kop`, size: file.opus, sha256: file.sha256, parts: file.br.length }, real(pack, file.fallback)];
  return [real(pack, file)];
}

async function download({ url, parts }: FileSpec, file: string) {
  if (!parts) {
    const { meta, body } = await cached(new URL(url, 'http://127.0.0.1'), HEADERS);
    body.destroy();
    if (meta.status !== 200) throw new Error(`${url} : HTTP ${meta.status}`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.hrtime.bigint()}.part`;
  const handle = await open(partial, 'w');
  try {
    for (let k = 0; k < parts; k++) {
      const response = await upstream(new URL(`${url}?part=${k}`, 'http://127.0.0.1'), HEADERS);
      if (response.statusCode !== 200) throw new Error(`${url}?part=${k} : HTTP ${response.statusCode}`);
      const raw = await buffer(response);
      await handle.write(response.headers['content-encoding'] === 'br' ? brotliDecompressSync(raw) : raw);
    }
  } finally {
    await handle.close();
  }
  await rename(partial, file);
}

async function store(spec: FileSpec) {
  const file = cachePath(new URL(spec.url, 'http://127.0.0.1'));
  if (!(await stat(file).then(info => info.size === spec.size, () => false))) await download(spec, file);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  if (digest.digest('hex') !== spec.sha256) throw new Error(`${spec.url} : SHA-256 différent du manifeste`);
}

async function mapUrls({ zone, slug, horde, first }: { zone: string; slug: string; horde?: boolean; first?: boolean }) {
  const root = first ? '/bo1z/' : `/bo1z/${slug}/`;
  const urls = [
    `/bo1z/art/mapselect-panel-${slug}.webp`, `/bo1z/art/loadscreen_${zone}.webp`,
  ];
  const optional = [`/bo1z/artifacts/${slug}-programs.json`, `/bo1z/artifacts/${zone}-pipelines.json`];
  const files: FileSpec[] = [];
  const manifests = [`${root}manifest.json`];
  if (horde) manifests.push(`${root}pack/web-manifest-horde.json`);
  for (const manifestUrl of manifests) {
    const manifest = JSON.parse((await cachedBytes(manifestUrl)).toString());
    const chunk = manifest.transport?.encoding === 'br' ? manifest.transport.chunk : 0;
    if (chunk && chunk !== CHUNK) throw new Error(`${manifestUrl} : morceaux de ${chunk} octets, le relais découpe par ${CHUNK}`);
    urls.push(manifestUrl);
    files.push(...manifest.files.flatMap((file: ManifestFile) => packFiles(root, chunk, file)));
    files.push(...(manifest.streams ?? []).map(({ path: streamPath, size, sha256 }: Transport & { path: string }) => ({ url: `${root}pack/${streamPath}`, size, sha256, parts: 0 })));
  }
  return { urls, optional, files };
}

async function fetchUrl(url: string, required: boolean) {
  const { meta, body } = await cached(new URL(url, 'http://127.0.0.1'), HEADERS);
  body.destroy();
  if (meta.status === 200) return;
  if (required) throw new Error(`${url} : HTTP ${meta.status}`);
  absent.push(url);
}

async function runAll(tasks: (() => Promise<void>)[]) {
  let done = 0;
  const queue = [...tasks];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let task; (task = queue.shift());) {
      await task();
      if (++done % 50 === 0 || done === tasks.length) console.log(`${done}/${tasks.length} fichiers`);
    }
  }));
}

console.log(`${MAPS.length} cartes : ${MAPS.map(map => map.slug).join(', ')}`);
const urls: string[] = [], optional: string[] = [], files = new Map<string, FileSpec>();
for (const map of MAPS) {
  const found = await mapUrls(map);
  urls.push(...found.urls);
  optional.push(...found.optional);
  for (const spec of found.files) files.set(spec.url, spec);
}
await runAll([
  ...urls.map(url => () => fetchUrl(url, true)),
  ...optional.map(url => () => fetchUrl(url, false)),
  ...[...files.values()].map(spec => () => store(spec)),
]);
const total = [...files.values()].reduce((sum, { size }) => sum + size, 0);
console.log(`${files.size} fichiers de jeu vérifiés (SHA-256 des manifestes), ${(total / 1e9).toFixed(2)} Go`);
console.log(`absents chez vel.gg : ${absent.join(', ') || 'aucun'}`);
