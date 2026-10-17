export type Transport = { size: number; sha256: string; br?: number[] };
// opus: size of the .kop container this file ships as; fallback: the original file, for browsers without AudioDecoder.
export type ManifestFile = Transport & { path: string; priority: string; group?: string; opus?: number; fallback?: Transport };
export type Stream = { kind: string; name?: string; path: string; mime: string };
export type Manifest = { schema: number; version: string; total_bytes: number; classes: string[]; files: ManifestFile[];
  transport?: { encoding?: string; chunk?: number }; streams?: Stream[] };
// opfs: the map's directory at the OPFS root, which the engine reads as /opfs/<opfs>/files.
export type Pack = { manifestUrl: string; packBase: string; opfs: string };
export type Groups = Record<string, [number, number]>;

export type Request = { type: 'inspect' | 'download'; pack: Pack; want: string[] };
// storage: the browser could not read or write its own files, which is not a network failure.
export type Reply =
  | { type: 'manifest'; manifest: Manifest }
  | { type: 'file-ready'; path: string }
  | { type: 'cache-status'; manifest: Manifest; ready: boolean; missingBytes: number }
  | { type: 'progress'; priority: string; completed: number; total: number; groups: Groups }
  | { type: 'boot-ready'; manifest: Manifest }
  | { type: 'complete' }
  | { type: 'error'; message: string; name: string; storage: boolean };

// One Opus clip of a KOP1 container, decoded by opus-worker.ts. hn/ab/tn/crc only in zip mode (an IWD whose MS-ADPCM sounds ship as Opus).
export type OpusJob = { id: number; ch: number; pre: number; sf: number; g: number; rate: number; frames: number; lens: Uint16Array; data: ArrayBuffer;
  hn?: number; ab?: number; tn?: number };
export type OpusReply = { id: number; error?: string; wav?: ArrayBuffer; sha?: ArrayBuffer; crc?: number };
