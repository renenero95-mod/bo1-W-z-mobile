import { DEFAULT_PORT, type Shared } from './lan.ts';
import { receive, SOCKS, take } from './ring.ts';

// Engine-thread side: the glue imports this module as kbnet.js and wires these functions to the patched wasm's kb_net_* imports.
const NA_IP = 4;

let memory: WebAssembly.Memory;
let shared: Shared;

function cString(heap: Uint8Array, pointer: number) {
  return new TextDecoder().decode(heap.slice(pointer, heap.indexOf(0, pointer)));
}

export function attach(wasmMemory: WebAssembly.Memory, page: Shared) {
  memory = wasmMemory;
  shared = page;
}

// Datagram: 4 IPv4 bytes and a 2-byte big-endian port (read as is into netadr_t), sending sock, data.
export function send(sock: number, length: number, data: number, adr: number) {
  const heap = new Uint8Array(memory.buffer);
  const packet = new Uint8Array(7 + length);
  packet.set(heap.subarray(adr + 4, adr + 10));
  packet[6] = sock;
  packet.set(heap.subarray(data, data + length), 7);
  (postMessage as (message: unknown, transfer: Transferable[]) => void)({ kbnet: packet }, [packet.buffer]);
}

export function recv(sock: number, from: number, msg: number) {
  if (sock >= SOCKS) return 0;
  return Number(take(shared.rings, sock, (address, data) => {
    const view = new DataView(memory.buffer);
    const heap = new Uint8Array(memory.buffer);
    heap.fill(0, from, from + 16);
    view.setInt32(from, NA_IP, true);
    heap.set(address, from + 4);
    heap.set(data, view.getInt32(msg + 8, true));
    view.setInt32(msg + 20, data.length, true);
  }));
}

export function resolve(host: number, port: number, adr: number) {
  const heap = new Uint8Array(memory.buffer);
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(cString(heap, host))?.slice(1).map(Number);
  if (!ip || ip.some(part => part > 255)) return 0;
  const view = new DataView(memory.buffer);
  view.setInt32(adr, NA_IP, true);
  heap.set(ip, adr + 4);
  view.setUint16(adr + 8, port ? Number(cString(heap, port)) : DEFAULT_PORT);
  return 1;
}

export function nextCommand(buffer: number, size: number) {
  return Number(receive(shared.mailbox, text => {
    const heap = new Uint8Array(memory.buffer);
    const count = Math.min(text.length, size - 1);
    heap.set(text.subarray(0, count), buffer);
    heap[buffer + count] = 0;
  }));
}

export function multiplayer() {
  return Atomics.load(new Int32Array(shared.multi), 0);
}
