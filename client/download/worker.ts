import { createSHA256, type IHasher } from 'hash-wasm';
import type { Groups, Manifest, ManifestFile, OpusJob, OpusReply, Pack, Reply, Request } from './protocol.ts';

// Only this worker writes a map's files, under a cross-tab lock: the journal (cache.json) and the files never race.
const reply = postMessage as (message: Reply) => void;
const PARALLEL = 3;
// A request with no response, or a body with no bytes, for 30 s is aborted: the retries take over instead of waiting forever.
const FETCH_STALL_MS = 30000;
// A clip decodes in milliseconds, but Firefox 157 sometimes never answered one: its worker is replaced, 3 times at most.
const OPUS_STALL_MS = 15000, OPUS_RESTARTS = 3;
const LOCK = 'five-pack-download';
const encoder = new TextEncoder();

class StorageError extends Error {}

type Journal = { version?: string; files: Record<string, { sha256: string; size: number; verified: boolean }> };
// One KOP1 record: raw bytes (t: 'raw', n bytes) or an Opus clip of np packets; crc: where zip mode patches its CRC-32.
type KopRecord = Omit<OpusJob, 'id' | 'lens' | 'data'> & { t?: string; n: number; np: number; hn: number; ab: number; tn: number; crc: number[] };

let pack: Pack, cache: Journal, journal: FileSystemSyncAccessHandle, directories: Map<string, Promise<FileSystemDirectoryHandle>>;
let transportChunk = 0, lastProgress = 0, currentClass = '', classTotal = 0, classDone = 0, classFiles: ManifestFile[] = [];
let fileDone = new Map<ManifestFile, number>();
// The inspection that just ran in this worker already fetched and validated the manifest: reused within a minute.
let inspected: { manifest: Manifest; url: string; at: number } | null = null;

async function stallFetch(url: string, init: RequestInit) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error(`no response in ${FETCH_STALL_MS / 1000} s`)), FETCH_STALL_MS);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readSoon(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer = 0;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`download stalled: no bytes for ${FETCH_STALL_MS / 1000} s`));
    }, FETCH_STALL_MS);
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}

function packFetch(entry: ManifestFile, suffix: string, part: number | null, init: RequestInit = {}) {
  const path = entry.path.split('/').map(encodeURIComponent).join('/') + suffix;
  return stallFetch(pack.packBase + path + (part === null ? '' : `?part=${part}`), { cache: 'no-store', ...init });
}

// WasmFS looks names up in lowercase: files are stored lowercase, while URLs and manifest paths keep their spelling.
async function fileAt(base: FileSystemDirectoryHandle, path: string, create = false) {
  const parts = path.toLowerCase().split('/');
  let directory = base, prefix = '';
  for (const name of parts.slice(0, -1)) {
    prefix += `${name}/`;
    if (!directories.has(prefix)) directories.set(prefix, directory.getDirectoryHandle(name, { create }));
    directory = await directories.get(prefix)!;
  }
  return directory.getFileHandle(parts.at(-1)!, { create });
}

function useFallback(entry: ManifestFile) {
  const { size, sha256, br } = entry.fallback!;
  Object.assign(entry, { size, sha256, br });
  delete entry.opus;
}

function validate(manifest: Manifest) {
  for (const file of manifest.files ?? []) {
    if (!file) continue;
    const path = String(file.path).toLowerCase();
    file.group = path.startsWith('web/shaders/') ? 'shaders' : path.startsWith('web/sound/') ? 'sounds' : file.priority === 'background' ? 'music'
      : path.startsWith('zone/') ? 'map' : 'textures';
    // The engine's late IWD scan kept half-written files for good: Nacht's round-1 music landed after it was asked for.
    if (file.priority === 'background') file.priority = 'boot';
    if (file.opus && file.fallback && (typeof AudioDecoder !== 'function' || typeof Worker !== 'function')) useFallback(file);
  }
  if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Unsupported manifest');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || /[\\:]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || !manifest.classes.includes(file.priority) || seen.has(file.path.toLowerCase())) {
      throw new Error('Invalid manifest entry');
    }
    seen.add(file.path.toLowerCase());
  }
  if (manifest.files.reduce((sum, file) => sum + file.size, 0) !== manifest.total_bytes) throw new Error('Invalid manifest total');
}

async function fetchManifest(url: string) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
  const manifest = await response.json() as Manifest;
  validate(manifest);
  return manifest;
}

// The handle stays open for the whole download: reopening it for each entry stalled createSyncAccessHandle on Five's 1,858 files.
function saveJournal() {
  const snapshot = encoder.encode(JSON.stringify(cache));
  journal.truncate(0);
  for (let written = 0; written < snapshot.length;) {
    const n = journal.write(snapshot.subarray(written), { at: written });
    if (!n) throw new StorageError('OPFS journal write made no progress');
    written += n;
  }
  journal.flush();
}

function credit(entry: ManifestFile, bytes: number) {
  classDone += bytes;
  fileDone.set(entry, (fileDone.get(entry) ?? 0) + bytes);
}

// groups: network bytes done and expected per content, for the loading screen's segments.
function progress(force = false) {
  const now = performance.now();
  if (!force && now - lastProgress < 100) return;
  lastProgress = now;
  const groups: Groups = {};
  for (const file of classFiles) {
    const network = Array.isArray(file.br) ? file.br.reduce((sum, n) => sum + n, 0) : file.size, group = groups[file.group!] ??= [0, 0];
    group[0] += network * Math.min(1, (fileDone.get(file) ?? 0) / (file.size || 1));
    group[1] += network;
  }
  reply({ type: 'progress', priority: currentClass, completed: classDone, total: classTotal, groups });
}

// A sound pack as Opus (KOP1): <path>.kop?part=k are Brotli parts of the container, whose SHA-256 is checked before decoding;
// entry.size is the rebuilt file. Clips are decoded by a pool of 4 workers and written at precomputed offsets. On any decoding
// failure, the original parts (entry.fallback) are downloaded instead.
async function fetchOpus(entry: ManifestFile, handle: FileSystemFileHandle, base: FileSystemDirectoryHandle) {
  cache.files[entry.path] = { sha256: entry.sha256, size: entry.size, verified: false };
  saveJournal();
  const blob = new Uint8Array(entry.opus!);
  let at = 0, credited = 0;
  try {
    for (let k = 0; k < entry.br!.length; ++k) {
      const response = await packFetch(entry, '.kop', k);
      if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await readSoon(reader);
        if (done) break;
        if (at + value.length > entry.opus!) throw new Error('File exceeds manifest size');
        blob.set(value, at);
        at += value.length;
        const c = Math.floor(at * entry.size / entry.opus! / 2) - credited;
        credited += c;
        credit(entry, c);
        progress();
      }
      if (at !== Math.min(entry.opus!, (k + 1) * transportChunk)) throw new Error('Truncated part');
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', blob))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (digest !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.path}.kop`);
    const view = new DataView(blob.buffer), jsonLength = view.getUint32(4, true);
    if (String.fromCharCode(...blob.subarray(0, 4)) !== 'KOP1') throw new Error('Invalid KOP1');
    const meta = JSON.parse(new TextDecoder().decode(blob.subarray(8, 8 + jsonLength)));
    const head = Uint8Array.from(atob(meta.head), char => char.charCodeAt(0)), headView = new DataView(head.buffer);
    const records: KopRecord[] = meta.recs;
    const totalPackets = records.reduce((sum, record) => sum + (record.np ?? 0), 0), lengths = new Uint16Array(totalPackets);
    for (let i = 0; i < totalPackets; ++i) lengths[i] = view.getUint16(8 + jsonLength + i * 2, true);
    let source = 8 + jsonLength + totalPackets * 2, target = head.length, lengthsAt = 0;
    // Zip mode: a stored IWD whose MS-ADPCM streamed sounds ship as Opus. Records cover the whole file; an Opus record carries
    // its stream header (hn) and tail (tn) around the packets, is re-encoded into exactly ab bytes, and its zip CRC-32 is patched at crc.
    const zip = meta.mode === 'zip';
    const outLength = (record: KopRecord) => (zip ? record.hn + record.ab + record.tn : 44 + record.frames * record.ch * 2);
    const jobs: (Omit<OpusJob, 'data'> & { off: number; at: number; length: number })[] = [], raws: { id: number; off: number; bytes: Uint8Array<ArrayBuffer> }[] = [];
    records.forEach((record, id) => {
      if (record.t === 'raw') {
        raws.push({ id, off: target, bytes: blob.subarray(source, source + record.n) });
        source += record.n;
        target += record.n;
        return;
      }
      const lens = lengths.subarray(lengthsAt, lengthsAt + record.np), length = lens.reduce((sum, n) => sum + n, 0) + (zip ? record.hn + record.tn : 0);
      jobs.push({ ...record, id, off: target, lens, at: source, length });
      lengthsAt += record.np;
      source += length;
      target += outLength(record);
    });
    if (target !== entry.size) throw new Error('KOP1 layout size mismatch');
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(entry.size);
      const write = (bytes: Uint8Array, offset: number) => {
        for (let w = 0; w < bytes.length;) {
          const n = access.write(bytes.subarray(w), { at: offset + w });
          if (!n) throw new StorageError('OPFS write made no progress');
          w += n;
        }
      };
      // KSPK index record i: offset +0, length +4, format +8, name length +12, SHA-256 +16..47, then the name.
      const recordAt: number[] = [];
      for (let i = 0, o = 24; !zip && i < records.length; ++i) {
        recordAt.push(o);
        o += 48 + headView.getUint32(o + 12, true);
      }
      const setRecord = (id: number, offset: number, length: number, sha: ArrayBuffer) => {
        if (zip) return;
        const o = recordAt[id];
        headView.setUint32(o, offset, true);
        headView.setUint32(o + 4, length, true);
        head.set(new Uint8Array(sha), o + 16);
      };
      for (const raw of raws) {
        write(raw.bytes, raw.off);
        if (!zip) setRecord(raw.id, raw.off, raw.bytes.length, await crypto.subtle.digest('SHA-256', raw.bytes));
      }
      const byId = new Map(jobs.map(job => [job.id, job]));
      const slots = Array.from({ length: Math.min(4, navigator.hardwareConcurrency || 4) }, () => ({ worker: null as Worker | null, job: null as typeof jobs[number] | null, sent: 0 }));
      let next = 0, doneBytes = 0, restarts = 0, watchdog = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = (error: Error) => {
            clearInterval(watchdog);
            reject(error);
          };
          const send = (slot: typeof slots[number]) => {
            const { lens, at: from, length, ...job } = slot.job!, data = blob.slice(from, from + length).buffer;
            slot.sent = performance.now();
            slot.worker!.postMessage({ ...job, lens, data }, [data]);
          };
          const feed = (slot: typeof slots[number]) => {
            slot.job = next < jobs.length ? jobs[next++] : null;
            if (slot.job) return send(slot);
            if (slots.every(other => !other.job)) {
              clearInterval(watchdog);
              resolve();
            }
          };
          const spawn = (slot: typeof slots[number]) => {
            const worker = slot.worker = new Worker(new URL('./opus-worker.ts', import.meta.url), { type: 'module' });
            worker.onerror = event => { if (worker === slot.worker) fail(new Error(`opus-worker: ${event.message ?? 'error'}`)); };
            worker.onmessage = ({ data: answer }: MessageEvent<OpusReply>) => {
              // A replaced worker's late answer.
              if (worker !== slot.worker || answer.id !== slot.job?.id) return;
              try {
                if (answer.error) throw new Error(`opus decode: ${answer.error}`);
                const record = records[answer.id], offset = byId.get(answer.id)!.off, wav = new Uint8Array(answer.wav!);
                if (wav.length !== outLength(record)) throw new Error('opus clip size mismatch');
                write(wav, offset);
                setRecord(answer.id, offset, wav.length, answer.sha!);
                if (zip) {
                  const crc = new Uint8Array(4);
                  new DataView(crc.buffer).setUint32(0, answer.crc! >>> 0, true);
                  for (const position of record.crc) write(crc, position);
                }
                doneBytes += wav.length;
                const c = Math.floor(entry.size / 2 + doneBytes / 2) - credited;
                credited += c;
                credit(entry, c);
                progress();
                feed(slot);
              } catch (error) {
                fail(error as Error);
              }
            };
          };
          watchdog = setInterval(() => {
            for (const slot of slots) {
              if (!slot.job || performance.now() - slot.sent < OPUS_STALL_MS) continue;
              if (++restarts > OPUS_RESTARTS) return fail(new Error(`opus-worker stalled on clip ${slot.job.id}`));
              slot.worker!.terminate();
              spawn(slot);
              send(slot);
            }
          }, 1000);
          for (const slot of slots) {
            spawn(slot);
            feed(slot);
          }
        });
      } finally {
        clearInterval(watchdog);
        slots.forEach(slot => slot.worker?.terminate());
      }
      if (!zip) {
        headView.setUint32(16, entry.size, true);
        write(head, 0);
      }
      access.flush();
    } finally {
      access.close();
    }
  } catch (error) {
    credit(entry, -credited);
    if ((error as Error).name === 'QuotaExceededError') throw error;
    useFallback(entry);
    return fetchFile(entry, base);
  }
  credit(entry, entry.size - credited);
  cache.files[entry.path].verified = true;
  saveJournal();
}

async function fetchFile(entry: ManifestFile, base: FileSystemDirectoryHandle): Promise<void> {
  const handle = await fileAt(base, entry.path, true);
  const existing = cache.files[entry.path];
  const same = existing?.sha256 === entry.sha256 && existing?.size === entry.size;
  if (same && existing.verified && (await handle.getFile()).size === entry.size) {
    credit(entry, entry.size);
    return progress();
  }
  if (transportChunk && entry.opus && entry.fallback && Array.isArray(entry.br)) return fetchOpus(entry, handle, base);
  let access: FileSystemSyncAccessHandle | null = await handle.createSyncAccessHandle();
  let offset = same && access.getSize() <= entry.size ? access.getSize() : 0;
  // Brotli parts resume at a part boundary; the prefix on disk is hashed again below.
  const parts = Boolean(transportChunk) && Array.isArray(entry.br) && entry.br.length === Math.ceil(entry.size / transportChunk);
  if (parts && offset % transportChunk) {
    offset -= offset % transportChunk;
    access.truncate(offset);
  }
  cache.files[entry.path] = { sha256: entry.sha256, size: entry.size, verified: false };
  try {
    // The expected hash is saved before downloading; the file's length is the resume cursor.
    saveJournal();
    if (!offset) access.truncate(0);
    credit(entry, offset);
    let failures = 0, hashFailures = 0, resets = 0;
    const hasher: IHasher = await createSHA256();
    for (;;) {
      const file = access!;
      hasher.init();
      const batch = new Uint8Array(1024 * 1024);
      let unreadable = false;
      for (let read = 0; read < offset;) {
        let n = 0;
        try {
          n = file.read(batch.subarray(0, Math.min(batch.length, offset - read)), { at: read });
        } catch {}
        if (!n) {
          unreadable = true;
          break;
        }
        hasher.update(batch.subarray(0, n));
        read += n;
      }
      // A saved prefix that cannot be read back (browser closed mid-write, disk trouble) restarts this file once from 0:
      // players reported "OPFS verification read made no progress".
      if (unreadable) {
        if (resets++) throw new StorageError('OPFS verification read made no progress');
        file.truncate(0);
        credit(entry, -offset);
        offset = 0;
        progress();
        continue;
      }
      let pending = 0;
      const writeBatch = () => {
        if (!pending) return;
        hasher.update(batch.subarray(0, pending));
        for (let written = 0; written < pending;) {
          const n = file.write(batch.subarray(written, pending), { at: offset + written });
          if (!n) throw new StorageError('OPFS write made no progress');
          written += n;
        }
        offset += pending;
        credit(entry, pending);
        pending = 0;
        progress();
      };
      const pump = async (response: Response, end: number) => {
        const reader = response.body!.getReader();
        try {
          for (;;) {
            const { done, value } = await readSoon(reader);
            if (done) break;
            if (offset + pending + value.length > end) throw new Error('File exceeds manifest size');
            for (let position = 0; position < value.length;) {
              const n = Math.min(batch.length - pending, value.length - position);
              batch.set(value.subarray(position, position + n), pending);
              pending += n;
              position += n;
              if (pending === batch.length) writeBatch();
            }
          }
        } finally {
          reader.releaseLock();
          writeBatch();
          file.flush();
        }
      };
      try {
        if (parts) {
          // Each part decodes (Content-Encoding: br, undone by fetch) to exactly one chunk of the file.
          while (offset < entry.size) {
            const end = Math.min(entry.size, offset + transportChunk);
            const response = await packFetch(entry, '', offset / transportChunk);
            if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
            await pump(response, end);
            if (offset !== end) throw new Error('Truncated part');
          }
        } else if (offset < entry.size) {
          const response = await packFetch(entry, '', null, { headers: offset ? { Range: `bytes=${offset}-` } : {} });
          if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
          if (offset && response.status === 200) {
            credit(entry, -offset);
            offset = 0;
            file.truncate(0);
            hasher.init();
          }
          if (response.status === 206 && response.headers.get('Content-Range') !== `bytes ${offset}-${entry.size - 1}/${entry.size}`) throw new Error('Invalid resume response');
          if (Number(response.headers.get('Content-Length')) !== entry.size - offset) throw new Error('Invalid download length');
          await pump(response, entry.size);
          if (offset !== entry.size) throw new Error('Truncated download');
        }
      } catch (error) {
        if ((error as Error).name === 'QuotaExceededError' || ++failures >= 3) throw error;
        // A part that failed midway resumes from its start (?part=k serves whole parts only); the prefix is hashed again.
        if (parts && offset % transportChunk) {
          credit(entry, -(offset % transportChunk));
          offset -= offset % transportChunk;
          file.truncate(offset);
        }
        await new Promise(resolve => setTimeout(resolve, 500 * failures));
        continue;
      }
      file.flush();
      file.close();
      access = null;
      if (hasher.digest('hex') !== entry.sha256) {
        if (++hashFailures >= 2) throw new Error(`SHA-256 mismatch: ${entry.path}`);
        credit(entry, -offset);
        offset = 0;
        access = await handle.createSyncAccessHandle();
        access.truncate(0);
        continue;
      }
      break;
    }
  } finally {
    access?.close();
  }
  cache.files[entry.path].verified = true;
  saveJournal();
}

// The engine starts during the boot download and waits per file (pack_gate.cpp), so boot files come in the order it needs them.
// Shader packs first: sharing the link with the IWDs, they arrived late and the engine waited 6.5 to 9.5 s at renderer init.
// sounds.pack next (wire bytes plus decoding), then root and main/, music and voices last of the IWDs, small zones, web/, the map
// zone, and common_* last: the load screen opens the map zone about 2 s before common_zombie.ff is needed.
function bootRank(file: ManifestFile) {
  const path = file.path.toLowerCase();
  if (path.startsWith('web/shaders/')) return 0;
  if (path.startsWith('web/sound/')) return 0.5;
  if (file.group === 'music') return 1.5;
  if (!path.includes('/') || path.startsWith('main/')) return 1;
  if (path.startsWith('zone/') && file.size < 8e6) return 2;
  if (path.startsWith('web/')) return 3;
  return /^zone\/[^/]+\/common_/.test(path) ? 5 : 4;
}

async function download({ want }: Request) {
  directories = new Map();
  const reuse = inspected && inspected.url === pack.manifestUrl && performance.now() - inspected.at < 60000 ? inspected.manifest : null;
  inspected = null;
  const manifest = reuse ?? await fetchManifest(pack.manifestUrl);
  const chunk = manifest.transport?.chunk;
  transportChunk = manifest.transport?.encoding === 'br' && Number.isSafeInteger(chunk) && chunk! > 0 ? chunk! : 0;
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(pack.opfs, { create: true });
  const base = await root.getDirectoryHandle('files', { create: true });
  journal = await (await root.getFileHandle('cache.json', { create: true })).createSyncAccessHandle();
  try {
    try {
      const bytes = new Uint8Array(journal.getSize());
      for (let read = 0; read < bytes.length;) {
        const n = journal.read(bytes.subarray(read), { at: read });
        if (!n) throw new StorageError('OPFS journal read made no progress');
        read += n;
      }
      cache = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      cache = { files: {} };
    }
    if (!cache?.files || typeof cache.files !== 'object' || Array.isArray(cache.files)) cache = { files: {} };
    reply({ type: 'manifest', manifest });
    for (const priority of manifest.classes) {
      // Lazy files ride with boot only when asked for (the GLSL pack, for WebGL2).
      if (priority === 'lazy') continue;
      currentClass = priority;
      classDone = 0;
      fileDone = new Map();
      const files = classFiles = manifest.files.filter(file => file.priority === priority || (priority === 'boot' && file.priority === 'lazy' && want.includes(file.path)));
      if (priority === 'boot') files.sort((a, b) => bootRank(a) - bootRank(b));
      classTotal = files.reduce((sum, file) => sum + file.size, 0);
      let cursor = 0;
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (cursor < files.length) {
          const entry = files[cursor++];
          await fetchFile(entry, base);
          // Verified, written, flushed and closed: the engine's pack gate may open it now.
          if (priority === 'boot') reply({ type: 'file-ready', path: entry.path });
        }
      }));
      progress(true);
      if (priority === 'boot') reply({ type: 'boot-ready', manifest });
    }
    cache.version = manifest.version;
    saveJournal();
  } finally {
    journal.close();
  }
  reply({ type: 'complete' });
}

// A return visit's inspection opens no write handle and starts no transfer.
async function inspect({ want }: Request) {
  const manifest = await fetchManifest(pack.manifestUrl);
  let saved: Journal = { files: {} }, base: FileSystemDirectoryHandle | null = null;
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(pack.opfs);
    base = await root.getDirectoryHandle('files');
    saved = JSON.parse(await (await (await root.getFileHandle('cache.json')).getFile()).text());
  } catch (error) {
    if ((error as Error).name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error;
  }
  directories = new Map();
  let missingBootBytes = 0, missingBytes = 0;
  await Promise.all(manifest.files.map(async entry => {
    if (entry.priority === 'lazy' && !want.includes(entry.path)) return;
    const known = saved?.files?.[entry.path];
    let valid = Boolean(base && known?.verified && known.sha256 === entry.sha256 && known.size === entry.size);
    if (valid) {
      try {
        valid = (await (await fileAt(base!, entry.path)).getFile()).size === entry.size;
      } catch (error) {
        if ((error as Error).name !== 'NotFoundError') throw error;
        valid = false;
      }
    }
    if (valid) return;
    missingBytes += entry.size;
    if (entry.priority === 'boot' || entry.priority === 'lazy') missingBootBytes += entry.size;
  }));
  inspected = { manifest, url: pack.manifestUrl, at: performance.now() };
  reply({ type: 'cache-status', manifest, ready: missingBootBytes === 0, missingBytes });
}

onmessage = ({ data: request }: MessageEvent<Request>) => {
  pack = request.pack;
  navigator.locks.request(LOCK, () => (request.type === 'inspect' ? inspect(request) : download(request))).catch((error: Error) => {
    reply({ type: 'error', message: error.message, name: error.name, storage: error instanceof StorageError });
  });
};
