import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { keepalive } from '../server/ws.ts';

test('une WebSocket muette reçoit un ping avant les 55 s du routeur Heroku, et plus rien une fois fermée', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let pings = 0;
  const socket = Object.assign(new EventEmitter(), { ping: () => { pings++; } });
  keepalive(socket as unknown as Parameters<typeof keepalive>[0]);
  t.mock.timers.tick(54_000);
  assert.ok(pings > 0);
  socket.emit('close');
  pings = 0;
  t.mock.timers.tick(120_000);
  assert.equal(pings, 0);
});
