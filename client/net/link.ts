import { shallowReactive } from 'vue';
import { DEFAULT_PORT, HOST, type Shared } from './lan.ts';
import { MAILBOX_BYTES, post, push, RING_BYTES, SLOT_DATA, SOCKS } from './ring.ts';

// A direct link opens in about a second: after 5 s, the guest goes through the server's relay.
const RELAY_AFTER = 5000;
// After 30 s without a link, the guest's engine would wait for the host's game forever.
const LINK_TIMEOUT = 30000;

type Transport = (packet: Uint8Array<ArrayBuffer>) => boolean;
type Message =
  | { type: 'welcome'; you: string; iceServers: RTCIceServer[] }
  | { type: 'signal'; from: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; relay?: 'hello' | 'ack' } }
  | { type: 'leave'; label: string }
  | { type: 'members'; members: Member[] };
export type Member = { label: string; pseudo: string };
export type RoomFailure = 'signal' | 'host-left' | 'unreachable';

export const link = shallowReactive({ label: '', linked: false, relayed: false, failure: null as RoomFailure | null, members: [] as Member[] });
export const traffic = { sent: 0, received: 0, dropped: 0 };
export let shared: Shared;

let transport: Transport;
let joinTarget: (address: string | null) => void;
const commands: string[] = [];

export const role = () => (link.label ? (link.label === HOST ? 'host' : 'guest') : null);

export function command(text: string) {
  commands.push(text);
}

export function forward(packet: Uint8Array<ArrayBuffer>) {
  if (transport(packet)) traffic.sent++;
  else traffic.dropped++;
}

// Room host, guest, or a local game another player just joined over the UDP bridge: the game's pause no longer freezes the host.
function markMultiplayer() {
  Atomics.store(new Int32Array(shared.multi), 0, 1);
}

// The server receives on NS_SERVER what a client sends from NS_CLIENT1, and the other way round.
function deliver(datagram: Uint8Array) {
  markMultiplayer();
  const sock = datagram[6] ^ 1;
  const queued = sock < SOCKS && datagram.length - 7 <= SLOT_DATA && push(shared.rings, sock, datagram.subarray(0, 6), datagram.subarray(7));
  traffic[queued ? 'received' : 'dropped']++;
}

const socketUrl = (pathname: string, query: Record<string, string> = {}) => {
  const url = new URL(pathname, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
};

export function pseudo() {
  try {
    return (localStorage.getItem('bo1z-name') ?? '').replace(/[^\w-]/g, '').slice(0, 15);
  } catch {
    return '';
  }
}

function relay(): Transport {
  const socket = new WebSocket(socketUrl('/kbnet'));
  socket.binaryType = 'arraybuffer';
  socket.onmessage = ({ data }) => deliver(new Uint8Array(data));
  return packet => socket.readyState === WebSocket.OPEN && (socket.send(packet), true);
}

function room(name: string, hidden: boolean, map: string): Transport {
  const signal = new WebSocket(socketUrl('/signal', { room: name, map, player: pseudo(), ...(hidden && { private: '1' }) }));
  const peers = new Map<string, { connection: RTCPeerConnection; channel: RTCDataChannel | null; candidates: RTCIceCandidateInit[]; relay: boolean }>();
  let iceServers: RTCIceServer[] = [];
  let queue = Promise.resolve();
  let relayAsked = false;
  const tell = (to: string, data: unknown) => signal.send(JSON.stringify({ to, data }));
  signal.binaryType = 'arraybuffer';

  function receive(label: string, payload: Uint8Array) {
    const datagram = new Uint8Array(6 + payload.byteLength);
    datagram.set(label.split('.').map(Number));
    new DataView(datagram.buffer).setUint16(4, DEFAULT_PORT);
    datagram.set(payload, 6);
    deliver(datagram);
  }

  function askRelay() {
    if (relayAsked || peers.get(HOST)?.channel?.readyState === 'open') return;
    relayAsked = true;
    tell(HOST, { relay: 'hello' });
  }

  function attach(label: string, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => Object.assign(link, { linked: true, relayed: false });
    channel.onmessage = ({ data }) => receive(label, new Uint8Array(data));
    peers.get(label)!.channel = channel;
  }

  function peer(label: string) {
    if (!peers.has(label)) {
      const connection = new RTCPeerConnection({ iceServers });
      connection.onicecandidate = ({ candidate }) => candidate && tell(label, { candidate });
      connection.ondatachannel = ({ channel }) => attach(label, channel);
      connection.onconnectionstatechange = () => { if (label === HOST && connection.connectionState === 'failed') askRelay(); };
      peers.set(label, { connection, channel: null, candidates: [], relay: false });
    }
    return peers.get(label)!;
  }

  async function handle(message: Message) {
    if (message.type === 'welcome') {
      iceServers = message.iceServers;
      link.label = message.you;
      joinTarget(message.you === HOST ? null : HOST);
      if (message.you === HOST) return;
      const { connection } = peer(HOST);
      attach(HOST, connection.createDataChannel('kbnet', { ordered: false, maxRetransmits: 0 }));
      await connection.setLocalDescription();
      tell(HOST, { description: connection.localDescription });
      setTimeout(askRelay, RELAY_AFTER);
      setTimeout(() => { if (!link.linked && !link.failure) link.failure = 'unreachable'; }, LINK_TIMEOUT);
    } else if (message.type === 'signal') {
      const entry = peer(message.from);
      const { description, candidate, relay } = message.data;
      if (relay === 'hello') {
        entry.relay = true;
        return tell(message.from, { relay: 'ack' });
      }
      if (relay === 'ack') {
        entry.relay = true;
        if (entry.channel?.readyState !== 'open') Object.assign(link, { linked: true, relayed: true });
        return;
      }
      if (candidate && !entry.connection.remoteDescription) return void entry.candidates.push(candidate);
      if (candidate) return entry.connection.addIceCandidate(candidate);
      await entry.connection.setRemoteDescription(description!);
      for (const pending of entry.candidates.splice(0)) await entry.connection.addIceCandidate(pending);
      if (description!.type !== 'offer') return;
      await entry.connection.setLocalDescription();
      tell(message.from, { description: entry.connection.localDescription });
    } else if (message.type === 'members') link.members = message.members;
    else if (message.type === 'leave') {
      if (message.label === HOST) link.failure = 'host-left';
      peers.get(message.label)?.connection.close();
      peers.delete(message.label);
    }
  }
  signal.onmessage = ({ data }) => {
    if (typeof data !== 'string') return receive(new Uint8Array(data, 0, 4).join('.'), new Uint8Array(data, 4));
    queue = queue.then(() => handle(JSON.parse(data))).catch(error => console.error('kbnet', error));
  };
  signal.onclose = () => { if (!link.label) link.failure = 'signal'; };
  // Chrome keeps a left page in its back-forward cache with the WebSocket open: the room stayed listed and the host's leave unannounced.
  addEventListener('pagehide', () => signal.close());

  return packet => {
    const entry = peers.get(packet.subarray(0, 4).join('.'));
    if (entry?.channel?.readyState === 'open') return entry.channel.send(packet.subarray(6)), true;
    if (!entry?.relay || signal.readyState !== WebSocket.OPEN) return false;
    const frame = new Uint8Array(packet.length - 2);
    frame.set(packet.subarray(0, 4));
    frame.set(packet.subarray(6), 4);
    signal.send(frame);
    return true;
  };
}

// Resolves to the address the engine connects to at startup, or null for a local game: a room's guest learns it is one on arrival.
export function start(options: { room: string | null; hidden: boolean; map: string; connect: string | null }) {
  shared = { rings: new SharedArrayBuffer(RING_BYTES), mailbox: new SharedArrayBuffer(MAILBOX_BYTES), multi: new SharedArrayBuffer(4) };
  setInterval(() => {
    if (commands.length && post(shared.mailbox, new TextEncoder().encode(`${commands[0]}\n`))) commands.shift();
  }, 50);
  if (options.room || options.connect) markMultiplayer();
  const target = new Promise<string | null>(resolve => { joinTarget = resolve; });
  if (options.room) transport = room(options.room, options.hidden, options.map);
  else {
    transport = relay();
    joinTarget(options.connect);
  }
  return target;
}
