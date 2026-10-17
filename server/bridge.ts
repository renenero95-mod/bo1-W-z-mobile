import type { WebSocket } from '@fastify/websocket';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { keepalive } from './ws.ts';

const lanAddresses = () => Object.values(networkInterfaces()).flat()
  .filter(address => address?.family === 'IPv4' && !address.internal).map(address => address!.address);

// UDP payload: sending sock, then the engine packet; a leading 0xFFFFFFFF marks an out-of-band text command.
const describe = (payload: Buffer) => (payload.length >= 5 && payload.readInt32LE(1) === -1
  ? JSON.stringify(payload.subarray(5, 85).toString('latin1'))
  : `netchan ${payload.length - 1} octets`);
const trace = process.env.KBNET_TRACE === '1'
  ? (arrow: string, peer: string, payload: Buffer) => console.log(`${arrow} ${peer} sock ${payload[0]} ${describe(payload)}`)
  : () => {};

// Datagrams between page and relay: 4 IPv4 bytes, a 2-byte big-endian port, then the engine payload.
export function udpBridge(app: FastifyInstance, httpPort: number, udpPort: number) {
  // WebSockets escape CORS: without this filter, any open site could send UDP through the relay.
  const origins = [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`];
  const udp = dgram.createSocket('udp4');
  let page: WebSocket | null = null;
  const peers = new Set<string>();

  udp.on('message', (payload, from) => {
    const peer = `${from.address}:${from.port}`;
    if (!peers.has(peer)) console.log(`UDP : premier paquet de ${peer}`);
    peers.add(peer);
    trace('←', peer, payload);
    if (!page) return;
    const header = Buffer.alloc(6);
    from.address.split('.').forEach((byte, i) => { header[i] = Number(byte); });
    header.writeUInt16BE(from.port, 4);
    page.send(Buffer.concat([header, payload]));
  });
  udp.bind(udpPort, () => console.log(`UDP ${udpPort} : ${['127.0.0.1', ...lanAddresses()].map(address => `${address}:${udpPort}`).join(', ')}`));

  app.get('/kbnet', {
    websocket: true,
    preValidation: async (request, reply) => { if (!origins.includes(request.headers.origin ?? '')) return reply.code(403).send(); },
  }, socket => {
    page?.terminate();
    page = socket;
    keepalive(socket);
    socket.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) return;
      const [address, port] = [[...data.subarray(0, 4)].join('.'), data.readUInt16BE(4)];
      trace('→', `${address}:${port}`, data.subarray(6));
      udp.send(data.subarray(6), port, address, error => error && console.error('udp', error.message));
    });
    console.log('page connectée au pont');
    socket.on('close', () => { if (page === socket) page = null; });
  });
}
