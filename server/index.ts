import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { BlockList, isIPv6 } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { MAPS } from '../client/catalog.ts';
import { udpBridge } from './bridge.ts';
import { cached, pick, upstream } from './cache.ts';
import { rooms } from './rooms.ts';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8484);
const NET_PORT = Number(process.env.NET_PORT ?? 3074);
const CACHE = process.env.CACHE !== '0';
const TRIMMED = (process.env.PREFIX ?? '').replace(/^\/+|\/+$/g, '');
const PREFIX = TRIMMED ? `/${TRIMMED}/` : '/';
const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS ?? '[{"urls":"stun:stun.l.google.com:19302"}]');
const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(DIST, 'assets') + path.sep;
const TELEMETRY = path.join(ROOT, 'telemetry');
// Without cross-origin isolation there is no SharedArrayBuffer: the engine's pthreads do not start.
const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const app = fastify();
// A WebSocket frame carries at most one UDP datagram (65,507 bytes) and its 6-byte header.
await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
await app.register(fastifyStatic, {
  root: DIST, prefix: PREFIX,
  // Vite puts a content hash in every name under assets/: a cached copy never needs checking again.
  setHeaders: (reply, file) => {
    reply.headers(ISOLATION);
    if (file.startsWith(ASSETS)) reply.header('cache-control', 'public, max-age=31536000, immutable');
  },
});
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
app.setErrorHandler((error: Error, request, reply) => {
  console.error(request.method, request.url, error.message);
  return reply.code(502).send();
});

// Pages send nothing until their GET probe gets { enabled: true }: only pages opened on this machine do, or every page with
// TELEMETRY=1 (a relay run at home for players on the local network; the Procfile does not set it). On Heroku the peer is
// always the router: every player was writing records to the server's disk.
const TELEMETRY_ALL = process.env.TELEMETRY === '1';
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
app.route({
  method: ['GET', 'POST'], url: `${PREFIX}telemetry`,
  handler: async (request, reply) => {
    const address = request.socket.remoteAddress ?? '';
    const local = TELEMETRY_ALL || LOOPBACK.check(address, isIPv6(address) ? 'ipv6' : 'ipv4');
    if (request.method === 'GET') return reply.send({ enabled: local, build: 'bo1z-lan' });
    if (!local) return reply.code(403).send();
    await mkdir(TELEMETRY, { recursive: true });
    await appendFile(path.join(TELEMETRY, `${PORT}.jsonl`), `${request.body ?? ''}\n`);
    return reply.code(204).send();
  },
});

rooms(app, ICE_SERVERS);
if (NET_PORT) udpBridge(app, PORT, NET_PORT);

// Temporary redirects: the prefix can change, and a 301 would stay in the browser. /bo1z/ URLs from before the configurable
// prefix (shared room links included) lead to the same page under PREFIX.
const under = (from: string) => async (request: FastifyRequest, reply: FastifyReply) => reply.redirect(`${PREFIX}${request.url.slice(from.length).replace(/^\//, '')}`, 302);
if (PREFIX !== '/') {
  app.get('/', under('/'));
  app.get(PREFIX.slice(0, -1), under(PREFIX.slice(0, -1)));
}
if (PREFIX !== '/bo1z/') {
  app.get('/bo1z', under('/bo1z'));
  app.get('/bo1z/*', under('/bo1z'));
}

// Load videos (<video>) and whole-file resumes by download-worker.js: served from the cache, offline included.
function byteRange(header: string | undefined, length: number) {
  const [, from, to] = /^bytes=(\d*)-(\d*)$/.exec(header ?? '') ?? [];
  if (!from && !to) return null;
  const start = from ? Number(from) : Math.max(0, length - Number(to));
  const end = from && to ? Math.min(Number(to), length - 1) : length - 1;
  return start <= end ? { start, end } : null;
}

function serve(request: FastifyRequest, reply: FastifyReply, status: number, headers: OutgoingHttpHeaders, body: Readable) {
  reply.code(status).headers({ ...headers, ...ISOLATION });
  if (request.method !== 'HEAD') return reply.send(body);
  body.destroy();
  return reply.send();
}

// What @fastify/static does not find: map pages, then game data (local cache, or straight from vel.gg).
app.setNotFoundHandler(async (request, reply) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send();
  if (!url.pathname.startsWith(PREFIX)) return reply.code(404).send();
  const site = url.pathname.slice(PREFIX.length - 1);
  const slug = /^\/(\w+)\/?$/.exec(site)?.[1];
  const page = MAPS.some(map => map.slug === slug);
  // Its URLs are relative to the site directory: under /<map>/, they would point at /<map>/assets/.
  if (page && site.endsWith('/')) return reply.redirect(`${PREFIX}${site.slice(1, -1)}${url.search}`, 302);
  if (page) return reply.sendFile('index.html');
  // On vel.gg, and so in cache/, everything lives under /bo1z/.
  const remote = new URL(`/bo1z${site}${url.search}`, 'http://127.0.0.1');
  const headers = Object.fromEntries(['user-agent', 'accept-encoding'].filter(name => request.headers[name]).map(name => [name, request.headers[name]]));
  if (!CACHE) {
    const response = await upstream(remote, request.headers.range ? { ...headers, range: request.headers.range } : headers);
    return serve(request, reply, response.statusCode!, pick(response.headers), response);
  }
  // The download worker checks Content-Length against the expected size of files fetched in one piece.
  const hit = await cached(remote, headers);
  if (!('file' in hit)) return serve(request, reply, hit.meta.status, hit.meta.headers, hit.body);
  const range = byteRange(request.headers.range, hit.length);
  if (!range) return serve(request, reply, hit.meta.status, { ...hit.meta.headers, 'content-length': hit.length }, hit.body);
  hit.body.destroy();
  return serve(request, reply, 206, { ...hit.meta.headers, 'content-range': `bytes ${range.start}-${range.end}/${hit.length}`, 'content-length': range.end - range.start + 1 },
    createReadStream(hit.file, { start: hit.start + range.start, end: hit.start + range.end }));
});

await app.listen({ port: PORT, host: HOST });
console.log(`http://${HOST}:${PORT}${PREFIX}`);
