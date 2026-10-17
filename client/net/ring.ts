// One queue per sock, a single producer (the page) and a single consumer (the pthread calling NET_GetLoopPacket for that
// sock): head and tail suffice, as long as they are published after the slot is written or read.
export const SOCKS = 2;
export const SLOT_DATA = 4096;
const SLOTS = 64;
const SLOT_BYTES = 16 + SLOT_DATA;
const HEADER_BYTES = 16;
export const RING_BYTES = HEADER_BYTES + SOCKS * SLOTS * SLOT_BYTES;

const slotOffset = (sock: number, counter: number) => HEADER_BYTES + (sock * SLOTS + (counter % SLOTS)) * SLOT_BYTES;

export function push(rings: SharedArrayBuffer, sock: number, address: Uint8Array, data: Uint8Array) {
  const header = new Int32Array(rings, 0, SOCKS * 2);
  const head = header[sock * 2];
  if (head - Atomics.load(header, sock * 2 + 1) >= SLOTS) return false;
  const offset = slotOffset(sock, head);
  new DataView(rings).setUint32(offset, data.length, true);
  new Uint8Array(rings, offset + 4, 6).set(address);
  new Uint8Array(rings, offset + 16, data.length).set(data);
  Atomics.store(header, sock * 2, head + 1);
  return true;
}

export function take(rings: SharedArrayBuffer, sock: number, copy: (address: Uint8Array, data: Uint8Array) => void) {
  const header = new Int32Array(rings, 0, SOCKS * 2);
  const tail = header[sock * 2 + 1];
  if (Atomics.load(header, sock * 2) === tail) return false;
  const offset = slotOffset(sock, tail);
  const length = new DataView(rings).getUint32(offset, true);
  copy(new Uint8Array(rings, offset + 4, 6), new Uint8Array(rings, offset + 16, length));
  Atomics.store(header, sock * 2 + 1, tail + 1);
  return true;
}

// Single-message mailbox: length first, published after the text, reset to 0 by the reader once copied.
export const MAILBOX_BYTES = 4 + 1024;

export function post(mailbox: SharedArrayBuffer, bytes: Uint8Array) {
  const length = new Int32Array(mailbox, 0, 1);
  if (Atomics.load(length, 0)) return false;
  new Uint8Array(mailbox, 4, bytes.length).set(bytes);
  Atomics.store(length, 0, bytes.length);
  return true;
}

export function receive(mailbox: SharedArrayBuffer, copy: (text: Uint8Array) => void) {
  const length = new Int32Array(mailbox, 0, 1);
  const count = Atomics.load(length, 0);
  if (!count) return false;
  copy(new Uint8Array(mailbox, 4, count));
  Atomics.store(length, 0, 0);
  return true;
}
