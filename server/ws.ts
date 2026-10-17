import type { WebSocket } from 'ws';

// Heroku's router cuts a WebSocket idle for 55 s (H15): the room then lost its players.
const KEEPALIVE_MS = 30_000;

export function keepalive(socket: Pick<WebSocket, 'ping' | 'on'>) {
  const timer = setInterval(() => socket.ping(), KEEPALIVE_MS);
  socket.on('close', () => clearInterval(timer));
}
