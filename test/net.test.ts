import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { relay, socketFrom } from './relay.ts';

function page(httpPort: number, origin = `http://127.0.0.1:${httpPort}`) {
  const socket = socketFrom(`ws://127.0.0.1:${httpPort}/kbnet`, origin);
  socket.binaryType = 'arraybuffer';
  return socket;
}

function datagram(port: number, text: string) {
  const bytes = Buffer.alloc(6 + text.length);
  bytes.set([127, 0, 0, 1]);
  bytes.writeUInt16BE(port, 4);
  bytes.write(text, 6);
  return bytes;
}

async function received(socket: WebSocket) {
  const [{ data }] = await once(socket, 'message') as [MessageEvent<ArrayBuffer>];
  const bytes = Buffer.from(data);
  return { from: `${[...bytes.subarray(0, 4)].join('.')}:${bytes.readUInt16BE(4)}`, text: bytes.subarray(6).toString() };
}

test('un datagramme traverse les deux relais et arrive avec le port UDP de l’émetteur', async t => {
  const relays = await Promise.all([relay(8601, 29601), relay(8602, 29602)]);
  t.after(() => relays.forEach(child => child.kill()));
  const [host, client] = [page(8601), page(8602)];
  await Promise.all([once(host, 'open'), once(client, 'open')]);

  client.send(datagram(29601, 'getchallenge'));
  assert.deepEqual(await received(host), { from: '127.0.0.1:29602', text: 'getchallenge' });

  host.send(datagram(29602, 'challengeResponse'));
  assert.deepEqual(await received(client), { from: '127.0.0.1:29601', text: 'challengeResponse' });

  host.close();
  client.close();
});

test('une page d’une autre origine ne peut pas ouvrir le pont', async t => {
  const child = await relay(8603, 29603);
  t.after(() => child.kill());
  const socket = page(8603, 'https://example.com');
  const [event] = await Promise.race([once(socket, 'error'), once(socket, 'open')]) as [Event];
  assert.equal(event.type, 'error');
});
