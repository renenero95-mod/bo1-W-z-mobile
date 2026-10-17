import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { keepalive } from './ws.ts';

type Room = { map: string | null; private: boolean; peers: Map<string, WebSocket>; players: Map<string, string> };
type Query = { room?: string; map?: string; player?: string; private?: string };

// Consonants only: no word can form, and no O or I to mistake for 0 and 1.
const CODE = 'BCDFGHJKLMNPQRSTVWXZ';
// A code handed out stays reserved until its host's page connects, which takes a few seconds.
const RESERVED_MS = 60000;

// WebRTC signaling: the server only carries offers, answers and candidates, never game packets.
// The engine only knows a player by an IPv4 address: each page in a room gets 10.0.0.<n>, n = 1 being the host.
export function rooms(app: FastifyInstance, iceServers: unknown) {
  const all = new Map<string, Room>(), reserved = new Map<string, number>();
  const foreign = (request: FastifyRequest) => request.headers.origin !== `${request.headers['x-forwarded-proto'] ?? 'http'}://${request.headers.host}`;
  const refuse = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(request.query as Query).room || foreign(request)) return reply.code(403).send();
  };
  const members = (room: Room) => [...room.players].map(([label, pseudo]) => ({ label, pseudo }));
  const announce = (room: Room) => {
    const text = JSON.stringify({ type: 'members', members: members(room) });
    for (const peer of room.peers.values()) peer.send(text);
  };
  app.get('/signal', { websocket: true, preValidation: refuse }, (socket, request) => {
    const query = request.query as Query;
    const name = query.room!;
    reserved.delete(name);
    const room = all.get(name) ?? all.set(name, { map: query.map ?? null, private: query.private === '1', peers: new Map(), players: new Map() }).get(name)!;
    let n = 1;
    while (room.peers.has(`10.0.0.${n}`)) n++;
    const label = `10.0.0.${n}`;
    const source = Buffer.from(label.split('.').map(Number));
    keepalive(socket);
    socket.on('message', (data: Buffer, binary: boolean) => {
      // Relay when the direct link fails: [destination label][packet] comes in, [source label][packet] goes out.
      if (binary) {
        if (data.length > 4) room.peers.get([...data.subarray(0, 4)].join('.'))?.send(Buffer.concat([source, data.subarray(4)]));
        return;
      }
      try {
        const { to, data: signal } = JSON.parse(data.toString());
        room.peers.get(to)?.send(JSON.stringify({ type: 'signal', from: label, data: signal }));
      } catch (error) {
        console.error('signal', (error as Error).message);
        socket.terminate();
      }
    });
    room.peers.set(label, socket);
    room.players.set(label, query.player ?? '');
    socket.send(JSON.stringify({ type: 'welcome', you: label, iceServers }));
    announce(room);
    socket.on('close', () => {
      room.peers.delete(label);
      room.players.delete(label);
      if (!room.peers.size) all.delete(name);
      for (const other of room.peers.values()) other.send(JSON.stringify({ type: 'leave', label }));
      announce(room);
    });
  });

  const describe = ([name, room]: [string, Room]) => ({ name, map: room.map, ...(room.private && { private: true }), players: room.peers.size, members: members(room) });
  app.get('/rooms', async (request, reply) => {
    const { code } = request.query as { code?: string };
    const found = code === undefined ? [...all].filter(([, room]) => !room.private) : all.has(code) ? [[code, all.get(code)!] as [string, Room]] : [];
    return reply.header('cache-control', 'no-store').send(found.map(describe));
  });

  // The server hands out codes: two players drawing the same one would otherwise join each other's game, on the host's map.
  app.post('/rooms', async (request, reply) => {
    if (foreign(request)) return reply.code(403).send();
    const now = Date.now();
    for (const [code, until] of reserved) if (until < now) reserved.delete(code);
    let code;
    do code = Array.from({ length: 4 }, () => CODE[Math.floor(Math.random() * CODE.length)]).join('');
    while (all.has(code) || reserved.has(code));
    reserved.set(code, now + RESERVED_MS);
    return reply.header('cache-control', 'no-store').send({ code });
  });
}
