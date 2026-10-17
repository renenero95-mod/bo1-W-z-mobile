import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { relay, socketFrom } from './relay.ts';

type Message = { type?: string; you?: string; [key: string]: unknown };

function join(httpPort: number, room: string, origin = `http://127.0.0.1:${httpPort}`, map = 'nacht', player = '') {
  const socket = socketFrom(`ws://127.0.0.1:${httpPort}/signal?room=${room}&map=${map}&player=${player}`, origin);
  const messages: Message[] = [], waiters: ((message: Message) => void)[] = [], frames: Uint8Array[] = [];
  socket.binaryType = 'arraybuffer';
  socket.onmessage = ({ data }) => {
    if (typeof data !== 'string') return void frames.push(new Uint8Array(data));
    const message = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  };
  const next = () => (messages.length ? Promise.resolve(messages.shift()!) : new Promise<Message>(resolve => waiters.push(resolve)));
  return Object.assign(socket, { frames, next });
}

test('le salon numérote les pages, annonce ses joueurs, achemine leurs messages et annonce les départs', async t => {
  const child = await relay(8611, 0);
  t.after(() => child.kill());
  const members = (...players: [string, string][]) => ({ type: 'members', members: players.map(([label, pseudo]) => ({ label, pseudo })) });
  const host = join(8611, 'soiree', undefined, 'nacht', 'Hote');
  assert.deepEqual((await host.next()).you, '10.0.0.1');
  assert.deepEqual(await host.next(), members(['10.0.0.1', 'Hote']));
  const guest = join(8611, 'soiree', undefined, 'nacht', 'Invite');
  assert.deepEqual((await guest.next()).you, '10.0.0.2');
  assert.deepEqual(await guest.next(), members(['10.0.0.1', 'Hote'], ['10.0.0.2', 'Invite']));
  assert.deepEqual(await host.next(), members(['10.0.0.1', 'Hote'], ['10.0.0.2', 'Invite']));
  assert.deepEqual((await join(8611, 'ailleurs').next()).you, '10.0.0.1');

  guest.send(JSON.stringify({ to: '10.0.0.1', data: { description: 'offre' } }));
  assert.deepEqual(await host.next(), { type: 'signal', from: '10.0.0.2', data: { description: 'offre' } });

  guest.close();
  assert.deepEqual(await host.next(), { type: 'leave', label: '10.0.0.2' });
  assert.deepEqual(await host.next(), members(['10.0.0.1', 'Hote']));
  host.close();
});

test('le serveur attribue les codes de salon : quatre consonnes, tous différents, et seulement à ses propres pages', async t => {
  const child = await relay(8622, 0);
  t.after(() => child.kill());
  const create = (origin: string) => fetch('http://127.0.0.1:8622/rooms', { method: 'POST', headers: { origin } });
  const codes: string[] = [];
  for (let k = 0; k < 200; k++) codes.push((await (await create('http://127.0.0.1:8622')).json()).code);
  assert.ok(codes.every(code => /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(code)));
  assert.equal(new Set(codes).size, codes.length);
  assert.equal((await create('https://example.com')).status, 403);
});

test('une page d’une autre origine ne peut pas entrer dans un salon', async t => {
  const child = await relay(8612, 0);
  t.after(() => child.kill());
  const socket = join(8612, 'soiree', 'https://example.com');
  const [event] = await Promise.race([once(socket, 'error'), once(socket, 'open')]) as [Event];
  assert.equal(event.type, 'error');
});

test('les anciennes adresses en /bo1z mènent à la même page sans le préfixe, et /rooms liste les salons avec leur carte et les pseudos de leurs joueurs', async t => {
  const child = await relay(8614, 0);
  t.after(() => child.kill());
  for (const [old, now] of [['/bo1z?room=soiree', '/?room=soiree'], ['/bo1z/', '/'], ['/bo1z/nacht?room=soiree', '/nacht?room=soiree']]) {
    const response = await fetch(`http://127.0.0.1:8614${old}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), now);
  }
  const host = join(8614, 'soiree', undefined, 'kino', 'Hote');
  await host.next();
  const guest = join(8614, 'soiree', undefined, 'nacht', 'Invite');
  await guest.next();
  assert.deepEqual(await (await fetch('http://127.0.0.1:8614/rooms')).json(), [{ name: 'soiree', map: 'kino', players: 2, members: [{ label: '10.0.0.1', pseudo: 'Hote' }, { label: '10.0.0.2', pseudo: 'Invite' }] }]);
  host.close();
  guest.close();
});

test('un salon privé manque à /rooms mais /rooms?code= le trouve, comme un salon public', async t => {
  const child = await relay(8613, 0);
  t.after(() => child.kill());
  const secret = socketFrom('ws://127.0.0.1:8613/signal?room=MZTR&map=cotd&player=Ines&private=1', 'http://127.0.0.1:8613');
  await once(secret, 'message');
  const open = join(8613, 'KXQZ', undefined, 'moon', 'Thomas');
  await open.next();
  const rooms = async (query: string) => (await fetch(`http://127.0.0.1:8613/rooms${query}`)).json();
  assert.deepEqual((await rooms('')).map((room: { name: string }) => room.name), ['KXQZ']);
  assert.deepEqual(await rooms('?code=MZTR'), [{ name: 'MZTR', map: 'cotd', private: true, players: 1, members: [{ label: '10.0.0.1', pseudo: 'Ines' }] }]);
  assert.deepEqual((await rooms('?code=KXQZ')).map((room: { name: string }) => room.name), ['KXQZ']);
  assert.deepEqual(await rooms('?code=BRTM'), []);
  secret.close();
  open.close();
});

const packet = (from: number, seq: number) => {
  const body = new Uint8Array(3 + (seq * 37) % 1200);
  body[0] = from; body[1] = seq >> 8; body[2] = seq & 0xff;
  for (let i = 3; i < body.length; i++) body[i] = (from * 131 + seq * 7 + i) & 0xff;
  return body;
};
const until = async (check: () => boolean, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (check()) return;
  assert.fail('relais : paquets manquants');
};

test('le salon relaie les paquets binaires d’une page à l’autre, intacts, dans l’ordre et sans fuite', async t => {
  const child = await relay(8618, 0);
  t.after(() => child.kill());
  const host = join(8618, 'relais');
  await host.next();
  const guests = [join(8618, 'relais'), join(8618, 'relais')];
  for (const guest of guests) await guest.next();
  const COUNT = 2000;
  const send = (socket: WebSocket, to: string, from: number, seq: number) => socket.send(new Uint8Array([...to.split('.').map(Number), ...packet(from, seq)]));
  for (let seq = 0; seq < COUNT; seq++) {
    guests.forEach((guest, k) => send(guest, '10.0.0.1', 2 + k, seq));
    guests.forEach((_, k) => send(host, `10.0.0.${2 + k}`, 1, seq));
  }
  await until(() => host.frames.length >= 2 * COUNT && guests.every(guest => guest.frames.length >= COUNT));

  const check = (frames: Uint8Array[], sources: string[]) => {
    const next: Record<string, number> = Object.fromEntries(sources.map(source => [source, 0]));
    for (const frame of frames) {
      const source = [...frame.subarray(0, 4)].join('.');
      assert.ok(source in next, `paquet venu de ${source}`);
      const body = frame.subarray(4);
      assert.deepEqual(body, packet(body[0], next[source]++));
    }
    for (const source of sources) assert.equal(next[source], COUNT);
  };
  check(host.frames, ['10.0.0.2', '10.0.0.3']);
  guests.forEach(guest => check(guest.frames, ['10.0.0.1']));
  for (const socket of [host, ...guests]) socket.close();
});
