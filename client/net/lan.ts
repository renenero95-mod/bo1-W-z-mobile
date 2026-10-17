// The engine only knows a player by an IPv4 address: in a room, each page gets 10.0.0.<n>, the host being 10.0.0.1,
// and the port is always connect's default.
export const HOST = '10.0.0.1';
export const DEFAULT_PORT = 3074;

// Shared between the page, which holds the connections, and the engine threads, which have no reliable event loop in game.
export type Shared = { rings: SharedArrayBuffer; mailbox: SharedArrayBuffer; multi: SharedArrayBuffer };
