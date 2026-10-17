import type { ManifestFile, Stream } from '../download/protocol.ts';
import type { Shared } from '../net/lan.ts';
import type { Mixer } from './audio-worklet.ts';
import workletUrl from './audio-worklet.ts?worker&url';
import { diagnostics } from './diagnostics.ts';
import { captureInput } from './input.ts';
import type { Intro } from './intro.ts';
import { installMod, MOD } from './mod.ts';

type KisakModule = {
  HEAPF32: Float32Array<SharedArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  callMain(args: string[]): void;
  refreshAudioViews(): void;
  _KB_Input(op: number, a: number, b: number): number;
  _KB_UIState(): number;
  _KB_AudioRing(): number;
  _KB_AudioRead(pointer: number, frames: number, times: number): number;
  _KB_AudioDropped(): number;
  _KB_PackExpect(path: number, size: number): void;
  _KB_PackReady(path: number): void;
  _KB_PackReleaseAll(): void;
  _KB_PresentRing(): number;
  _KB_SetProgramManifest(pointer: number, length: number): void;
  _KB_MemoryStats(which: number): number;
  _KB_EngineAllocStats(which: number): number;
  _KB_WebResourceStats(which: number): number;
  _KB_VirtualMemoryStats(which: number): number;
  _KB_AudioMemoryStats(which: number): number;
  kbVideo: { register(streams: Stream[]): void; setMaster(master: number): void; finishIntro(): void };
  PThread: { terminateAllThreads(): void };
};
export type CrashDetail = { stack: string | null; source: string };
type Choice = { renderer: 'webgl2' | 'webgpu'; reason: string; pipeline?: number };
type GpuNavigator = { gpu?: { requestAdapter(options: object): Promise<{ features: Set<string> } | null> } };

const INPUT = { key: 0, char: 1, mouse: 2, pointerLock: 3, cursor: 4, introRelease: 7 } as const;
  // PATCH: texture-compression-bc è standard desktop (BC), non supportato su Adreno/mobile.
  // Su Android si usano ETC2/ASTC. Rimosso dalla lista per permettere WebGPU su mobile.
  const WEBGPU_FEATURES = ['depth32float-stencil8', 'float32-filterable', 'float32-blendable'];
// Firefox renders black frames from the dedicated render thread; it keeps rendering on the engine's main thread.
// PATCH v0.20: consente di forzare main-pthread via ?route=main (per test canvas diretto su mobile)
export const rendererRoute = (() => {
  try {
    const p = new URLSearchParams(location.search).get('route');
    if (p === 'main') return 'main-pthread';
    if (p === 'backend') return 'backend-pthread';
  } catch {}
  return /Firefox\//.test(navigator.userAgent) ? 'main-pthread' : 'backend-pthread';
})();
// The GLSL pack is only downloaded when WebGL2 is chosen (manifest class "lazy").
export const glslPack = 'web/shaders/shaders.pack';
const RENDERER_OVERRIDE = 'kisak-renderer';

function storedRenderer(): 'webgl2' | 'webgpu' | null {
  try {
    const forced = new URLSearchParams(location.search).get('forceRenderer');
    if (forced === 'webgl2' || forced === 'webgpu') {
      sessionStorage.setItem('kisak-renderer', forced);
      return forced as 'webgl2' | 'webgpu';
    }
    if (/Android/i.test(navigator.userAgent)) return 'webgpu';
    const stored = sessionStorage.getItem('kisak-renderer');
    return (stored === 'webgl2' || stored === 'webgpu') ? stored as 'webgl2' | 'webgpu' : null;
  } catch { return null; }
}

async function chooseRenderer(param: string | null): Promise<Choice> {
  if (param === 'webgl2') return { renderer: 'webgl2', reason: 'override' };
  // The pipelined executor blocks its recording thread (Atomics.wait): dedicated render thread only.
  const pipeline = rendererRoute === 'backend-pthread' ? 1 : 0;
  if (param === 'webgpu') return { renderer: 'webgpu', reason: 'override', pipeline };
  try {
    const adapter = await (navigator as GpuNavigator).gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { renderer: 'webgl2', reason: 'no-webgpu-adapter' };
    const missing = WEBGPU_FEATURES.filter(feature => !adapter.features.has(feature));
    if (missing.length) return { renderer: 'webgl2', reason: `missing-${missing.join('+')}` };
    if (!pipeline) return { renderer: 'webgl2', reason: `route-${rendererRoute}` };
    return { renderer: 'webgpu', reason: 'default', pipeline };
  } catch (error) {
    return { renderer: 'webgl2', reason: `adapter-error ${(error as Error).message}` };
  }
}

let choice: Promise<Choice> | null = null;
// Chosen once, before the download, so that WebGPU skips the GLSL pack.
export const rendererChoice = () => choice ??= chooseRenderer(storedRenderer() ?? new URLSearchParams(location.search).get('renderer')).then(c => {
    console.log('[renderer] CHOSEN ->', c.renderer, 'reason:', c.reason, 'pipeline:', c.pipeline);
    return c;
});

// The engine's file opens wait for each of these files to be verified by the downloader (pack_gate.cpp):
// the engine starts as soon as the manifest is known, during the download.
export function createPackGate(files: ManifestFile[], want: string[]) {
  const paths = files.filter(file => file.priority === 'boot' || (file.priority === 'lazy' && want.includes(file.path))).map(file => file.path);
  // Final sizes (no fallback variant): the gate answers the stat of a pending zone without waiting for it.
  const sizes = new Map(files.filter(file => paths.includes(file.path) && /\.ff$/i.test(file.path) && !file.fallback).map(file => [file.path, file.size]));
  const ready = new Set<string>(), waiters = new Set<() => void>();
  let module: KisakModule | null = null, done = false;
  const wake = () => [...waiters].forEach(waiter => waiter());
  return {
    fileReady(path: string) {
      ready.add(path);
      if (module) withString(module, path, address => module!._KB_PackReady(address));
      wake();
    },
    release() {
      if (done) return;
      done = true;
      module?._KB_PackReleaseAll();
      module = null;
      wake();
    },
    // localization.txt is read with fopen (Win_InitLocalization), which the gate does not see: missing at callMain, the engine
    // read nothing and stopped on an assertion. The pack's root files are fetched first, so we wait for them.
    async open(engine: KisakModule) {
      const early = paths.filter(path => !path.includes('/'));
      await new Promise<void>(resolve => {
        const check = () => {
          if (!done && !early.every(path => ready.has(path))) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      });
      if (done) return;
      for (const path of paths) if (!ready.has(path)) withString(engine, path, address => engine._KB_PackExpect(address, sizes.get(path) ?? -1));
      module = engine;
    },
  };
}
export type PackGate = ReturnType<typeof createPackGate>;

function withString(module: KisakModule, text: string, use: (address: number) => void) {
  const bytes = new TextEncoder().encode(text), address = module._malloc(bytes.length + 1);
  if (!address) return;
  const heap = new Uint8Array(module.HEAPF32.buffer, address, bytes.length + 1);
  heap.set(bytes);
  heap[bytes.length] = 0;
  use(address);
  module._free(address);
}

type EngineOptions = {
  canvas: HTMLCanvasElement; size: { width: number; height: number }; base: string; zone: string; opfsRoot: string; packBase: string; programsUrl: string;
  master: number; arguments: string[]; name: string; join: Promise<string | null>; streams: Stream[]; gate: PackGate; intro: Intro | null; introCovering: () => boolean;
  net: { shared: Shared; forward: (packet: Uint8Array<ArrayBuffer>) => void };
  onReady: () => void; onQuit: () => void; onCrash: (message: string, detail: CrashDetail) => void; onRelock: () => void;
  report: (source: string, message: string) => void;
};

export function createEngine(options: EngineOptions) {
  const { canvas, zone } = options;
  const control = new SharedArrayBuffer(16), counters = new Int32Array(control);
  let module: KisakModule | null = null, context: AudioContext | null = null, node: AudioWorkletNode | null = null, mixer: Mixer | null = null;
  let pump: ReturnType<typeof setInterval> | undefined, pointer = 0, pausedDrainAt = performance.now(), running = false, configured = false, generation = 0;
  let starting: Promise<unknown> | null = null, stopped = false, quitting = false;
  let mouseX = 0, mouseY = 0, master = options.master, introWanted = false, introReleased = false, startupConsoleLines: number | null = null;
  let channel: BroadcastChannel | null = null;
  const zones = new Set<string>();

  function quit() {
    if (stopped || quitting) return;
    quitting = true;
    options.onQuit();
  }
  function crash(reason: unknown) {
    if (stopped || quitting) return;
    const message = String((reason as Error)?.message ?? reason);
    diagnostics.errors.push(message);
    options.onCrash(message, { stack: (reason as Error)?.stack ?? null, source: 'engine' });
  }

  // "Prêt" waits for the WebGPU pipeline warm-up (webgpu_pipe.js): started while they compiled, the game skipped their draws
  // and parts of the map were missing for the first seconds, worst with a cached pack. At most 45 s after the map loads;
  // without a start line on the pipeline route, we wait 10 s for one.
  const WARM_HOLD_MS = 45000, WARM_START_MS = 10000;
  const warm = diagnostics.warm;
  let warmTimer: ReturnType<typeof setInterval> | undefined, readyFired = false;
  function warmLog(message: string) {
    const start = /^WEB_GPU_WARM map=(\S+) seed=(\S+)(?: session=(\S+))? rows=(\d+)/.exec(message);
    if (start && !warm.started) {
      Object.assign(warm, { started: true, seed: start[2], rows: Number(start[4]) });
      diagnostics.timings.warmStart = performance.now();
    }
    const done = /^WEB_GPU_WARM ready queued=(\d+) done=(\d+) failed=(\d+)(?: of=(\d+))?(?: ms=(\d+))?/.exec(message);
    if (done) {
      Object.assign(warm, { queued: Number(done[1]), done: Number(done[2]), failed: Number(done[3]), finished: true, ms: done[5] === undefined ? null : Number(done[5]) });
      diagnostics.timings.warmReady ??= performance.now();
    }
    if (start || done) warmGate();
  }
  function warmProgress(progress: Record<string, number>) {
    for (const key of ['rows', 'queued', 'done', 'failed', 'pend'] as const) if (Number.isFinite(progress[key])) warm[key] = progress[key];
    warm.progress = true;
    warm.at = performance.now();
    // Pipelines of this warm-up: built, compiling and queued; without the queue length, every row.
    warm.total = Number.isFinite(progress.waiting) ? warm.done + warm.failed + (progress.inflight || 0) + progress.waiting : warm.rows;
    if (progress.end && !warm.finished) {
      warm.finished = true;
      diagnostics.timings.warmReady ??= performance.now();
    }
    warmGate();
  }
  function warmGate() {
    const mapLoaded = diagnostics.timings.mapLoaded;
    if (!mapLoaded || readyFired || stopped) return;
    const now = performance.now(), held = now - mapLoaded;
    const seeded = warm.started && Number(warm.seed) > 0 && warm.rows > 0;
    // With progress reports, the first frames' own compiles (missing from the seed) also settle before the prompt.
    const settled = !warm.progress || (warm.pend === 0 && warm.at! - mapLoaded >= 250);
    let reason: string | null = null;
    if (held >= WARM_HOLD_MS) reason = 'timeout';
    else if (warm.started) reason = !seeded ? 'nothing-to-warm' : warm.finished && settled ? 'warm-ready' : null;
    else reason = diagnostics.renderer !== 'webgpu-pipeline' ? 'no-warm' : held >= WARM_START_MS ? 'no-warm-start' : null;
    if (!reason) {
      diagnostics.warmHolding = true;
      diagnostics.warmHoldUntil = mapLoaded + WARM_HOLD_MS;
      warmTimer ??= setInterval(warmGate, 250);
      return;
    }
    clearInterval(warmTimer);
    diagnostics.warmHolding = false;
    readyFired = true;
    diagnostics.timings.readyShown = now;
    diagnostics.warmGate = { reason, holdMs: Math.round(held), seed: warm.seed, rows: warm.rows, done: warm.done, failed: warm.failed };
    channel?.postMessage({ warmDone: 1 });
    startupConsoleLines ??= diagnostics.console.length;
    options.onReady();
  }

  function log(message: string, error = false) {
    if (message.startsWith('KISAK_FLUSH_ROWS ')) return;
    if (/^WEB_GPU_(DEVICE_READY|FALLBACK)/.test(message)) {
      diagnostics.renderer = message.startsWith('WEB_GPU_DEVICE_READY') ? (/owner=pipeline/.test(message) ? 'webgpu-pipeline' : 'webgpu') : 'webgl2';
      diagnostics.rendererDetail = message;
      // The engine fell back to WebGL2 after a WebGPU choice: the GLSL pack was not downloaded, so reload once in WebGL2.
      if (message.startsWith('WEB_GPU_FALLBACK') && diagnostics.rendererRequested === 'webgpu' && !storedRenderer()) {
        sessionStorage.setItem(RENDERER_OVERRIDE, 'webgl2');
        location.reload();
      }
    }
    if (/KISAK_BROWSER webgpu-device-lost/.test(message)) {
      options.report('engine-worker', message);
      crash('The WebGPU graphics device was lost.');
    }
    diagnostics.console.push({ ms: performance.now(), error, message });
    // The whole startup is kept, then the last 2048 game lines: a long session must not keep every line.
    if (startupConsoleLines !== null && diagnostics.console.length > startupConsoleLines + 2048) {
      const excess = diagnostics.console.length - startupConsoleLines - 2048;
      diagnostics.console.splice(startupConsoleLines, excess);
      diagnostics.consoleDiscarded += excess;
    }
    if (error) diagnostics.consoleErrors++;
    // Quitting from the game's menu ends in a local disconnect or "quitting...", not in an error.
    if (/Com_ERROR:\s*PLATFORM_DISCONNECTED_FROM_SERVER/.test(message) || /^quitting\.\.\.\s*$/.test(message)) quit();
    else if (/Com_ERROR:|KISAK_HEADLESS Sys_Error:|KISAK_BROWSER worker-error|Aborted\(|RuntimeError:/.test(message)) {
      crash({ message, stack: message.includes('\n    at ') ? message : null });
    }
    if (/KISAK_BROWSER (worker-stack|webgl-context-(lost|restored))/.test(message)) options.report('engine-worker', message);
    if (/script runtime error|script exception/i.test(message)) diagnostics.scriptExceptions++;
    if (/GL_INVALID|WebGL.*error|GL error/i.test(message)) diagnostics.glErrors++;
    const timings = diagnostics.timings;
    if (/KISAK_BROWSER engine-initialized/.test(message)) timings.engineInitialized = performance.now();
    if (/KISAK_BROWSER intro-hold/.test(message)) timings.introHeld ??= performance.now();
    if (/KISAK_BROWSER first-present/.test(message)) timings.firstPresent = performance.now();
    const zoneLoaded = /Loaded fastfile '([^']+)'/.exec(message);
    if (zoneLoaded) {
      zones.add(zoneLoaded[1]);
      diagnostics.zoneTimes[zoneLoaded[1]] ??= Math.round(performance.now());
    }
    if (new RegExp(`KISAK_BROWSER map-loaded\\s+${zone}\\b`).test(message)) {
      startupConsoleLines ??= diagnostics.console.length;
      timings.mapLoaded = performance.now();
      // An engine built without KISAK_WEBGPU prints neither READY nor FALLBACK: by map load, the renderer is WebGL2.
      if (diagnostics.renderer === 'webgpu-pending') Object.assign(diagnostics, { renderer: 'webgl2', rendererDetail: 'no WEB_GPU_DEVICE_READY by map load' });
      warmGate();
    }
    if (message.startsWith('WEB_GPU_WARM ')) warmLog(message);
    (error ? console.error : console.log)(message);
  }

  const input = captureInput(canvas, event => {
    if (!module || !diagnostics.interactive) return;
    let accepted: number;
    if (event.kind === 'cursor') accepted = module._KB_Input(INPUT.cursor, event.x, event.y);
    else if (event.kind === 'key') accepted = module._KB_Input(INPUT.key, event.key, Number(event.down));
    else if (event.kind === 'char') accepted = module._KB_Input(INPUT.char, event.char, 0);
    else if (event.kind === 'pointer-lock') accepted = module._KB_Input(INPUT.pointerLock, Number(event.locked), 0);
    else {
      // The engine takes whole pixels: the fraction of a mouse move carries over to the next one.
      mouseX += event.dx;
      mouseY += event.dy;
      const dx = Math.trunc(mouseX), dy = Math.trunc(mouseY);
      mouseX -= dx;
      mouseY -= dy;
      accepted = module._KB_Input(INPUT.mouse, dx, dy);
    }
    diagnostics.inputEvents++;
    if (!accepted) diagnostics.inputDropped++;
  }, { menuOpen: () => Boolean(module && module._KB_UIState() & 1), size: () => options.size, relock: options.onRelock });

  function prepareAudio() {
    const audio = context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    if (audio.sampleRate !== 48000) throw new Error('Five requires a 48 kHz audio context');
    // Sound only starts with the click that enters the game; until then the context stays suspended.
    return Promise.all([audio.suspend(), audio.audioWorklet.addModule(workletUrl)]).then(() => {
      if (stopped) return;
      node = new AudioWorkletNode(audio, 'five-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { control } });
      node.port.onmessage = ({ data }) => { if (data.type === 'discarded') diagnostics.audioDiscardedFrames += data.frames; };
      // A trapped worklet goes silent while the engine keeps running: record it.
      node.onprocessorerror = () => {
        log('KISAK_BROWSER audio-worklet processorerror', true);
        options.report('audio-worklet', 'processorerror');
      };
      node.connect(audio.destination);
    });
  }

  function wakeMixer() {
    const demand = new Int32Array(mixer!.buffer, mixer!.demand, 1);
    Atomics.add(demand, 0, 1);
    Atomics.notify(demand, 0, 1);
  }

  function answerPageQueries() {
    // The engine threads cannot see the page's location: the glue asks for it on this channel, and also logs there.
    channel = new BroadcastChannel('kisak-page-query');
    channel.onmessage = ({ data }) => {
      if (typeof data?.log === 'string') return log(data.log);
      if (data?.warm) return warmProgress(data.warm);
      if (data?.ask) channel!.postMessage({ search: location.search, path: location.pathname, map: zone });
    };
  }

  async function start(settings: { sensitivity: number; volume: number }) {
    answerPageQueries();
    const { default: createKisakBrowser } = await import(/* @vite-ignore */ `${options.base}artifacts/KisakBlack-web.mjs`) as { default: (args: object) => Promise<KisakModule> };
    if (stopped) return;
    diagnostics.timings.engineStart = performance.now();
    const engine = module = await createKisakBrowser({
      canvas, noInitialRun: true,
      locateFile: (name: string) => `${options.base}artifacts/${name}`,
      print: (message: string) => log(String(message)),
      printErr: (message: string) => log(String(message), true),
      onAbort: crash,
      onExit: (code: number) => {
        diagnostics.exitCode = code;
        if (stopped) return;
        if (code === 0) quit();
        else crash(`The engine stopped (code ${code}).`);
      },
      kbIntro: options.intro, kbVideoBase: options.packBase, kbVideoMaster: master,
      kbnetShared: options.net.shared, kbnetForward: options.net.forward,
    });
    if (stopped) return engine.PThread.terminateAllThreads();
    diagnostics.timings.wasmReady = performance.now();
    // Cinematics are played by <video> with range requests, never stored in OPFS.
    if (options.streams.length) engine.kbVideo.register(options.streams);
    const programs = await fetch(options.programsUrl);
    if (programs.ok) {
      const bytes = new TextEncoder().encode(await programs.text()), address = engine._malloc(bytes.length);
      if (!address) throw new Error('Cannot allocate program manifest');
      new Uint8Array(engine.HEAPF32.buffer, address, bytes.length).set(bytes);
      engine._KB_SetProgramManifest(address, bytes.length);
      engine._free(address);
    } else if (programs.status !== 404) throw new Error('Cannot load program manifest');
    pointer = engine._malloc(4096 * 8);
    if (!pointer) throw new Error('Cannot allocate audio transfer buffer');
    engine.refreshAudioViews();
    const [capacity, samples, read, write, , mixTimes, demand] = new Uint32Array(engine.HEAPF32.buffer, engine._KB_AudioRing(), 7);
    mixer = { buffer: engine.HEAPF32.buffer, capacity, samples, read, write, mixTimes, demand };
    // Out of game, sound is drained muted at the 48 kHz rate: woken by every tick of this timer, the mixer
    // would advance paused voices as fast as it empties the ring (60 ms every 8 ms).
    pump = setInterval(() => {
      const frames = Math.floor((performance.now() - pausedDrainAt) * 48);
      pausedDrainAt += frames / 48;
      if (running) return;
      diagnostics.audioDiscardedFrames += engine._KB_AudioRead(pointer, Math.min(frames, 4096), 0);
      wakeMixer();
    }, 8);
    const { renderer, reason, pipeline } = await rendererChoice();
    Object.assign(diagnostics, { renderer: renderer === 'webgpu' ? 'webgpu-pending' : 'webgl2', rendererRequested: renderer, rendererReason: reason, rendererDetail: null });
    const join = await options.join;
    await installMod(options.opfsRoot);
    // Dvars precede +devmap so that startup receives the player's settings.
    console.log('[engine] building args. canvas:', canvas.width, 'x', canvas.height, 'renderer:', renderer, 'route:', rendererRoute);
    const args = [
      '+set', 'fs_b', options.opfsRoot, '+set', 'fs_h', '/opfs/user', '+set', 'fs_game', MOD,
      '+set', 'kisak_zombies', '1', '+set', 'zombiemode', '1',
      '+set', 'kisak_testclient', '0', '+set', 'kisak_scripterrors', '100',
      '+set', 'r_fullscreen', '0', '+set', 'r_aaSamples', '1',
      // r_clear defaults to 2: a blue and orange blink every 512 ms, a development aid.
      '+set', 'r_clear', '0', '+set', 'r_anisotropic', '0', '+set', 'r_picmip', '2', '+set', 'r_corpse', '0', '+set', 'r_fog_disable', '1', '+set', 'r_sunflare_max_size', '0', '+set', 'r_sunblind_max_darken', '0', '+set', 'r_bloomTweaks', '0',
      // PATCH v1.34: tenta di disattivare il DOF solo via cvar (senza toccare la dummy)
      '+set', 'r_dof_enable', '0',

      // The canvas thread paces frames with requestAnimationFrame; an integer cap would hold a 120 Hz display at 60.
      '+set', 'r_vsync', '0', '+set', 'com_maxfps', '60',
      '+set', 'snd_softwaremixer', '1', '+set', 'snd_softwarewav', '0', '+set', 'snd_softwaretable', `${options.opfsRoot}/web/sound`,
      ...(rendererRoute === 'main-pthread' ? ['+set', 'r_smp_backend', '0'] : []),
      ...(renderer === 'webgpu' ? ['+set', 'r_webgpu', '1', '+set', 'r_webgpu_pipeline', String(pipeline)] : []),
      '+set', 'sensitivity', String(settings.sensitivity), '+set', 'snd_menu_master', String(settings.volume),
      '+set', 'r_customMode', `${canvas.width}x${canvas.height}`,
      ...options.arguments,
      // monkeytoy 1, the game's default, closes the console, which the page's commands go through.
      '+set', 'monkeytoy', '0',
      // Before +connect, so that the connection request carries the player's name.
      ...(options.name ? ['+set', 'name', options.name] : []),
      // A guest loads no map of its own: the host's game state brings it.
      ...(join ? ['+connect', join] : ['+devmap', zone]),
    ];
    await options.gate.open(engine);
    diagnostics.timings.callMain = performance.now();
    engine.callMain(args);
    // PATCH v0.35.1: esponi il modulo per input touch esterni
    (window as any).__kbModule = module;
    // The canvas transfer loses a pointer-lock change that arrived before the module existed.
    // PATCH v0.30: su touch, forza pointerLock=1 cosi' il motore non si auto-pausa
    const touchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
    engine._KB_Input(INPUT.pointerLock, touchDevice ? 1 : Number(document.pointerLockElement === canvas), 0);
  }

  // The engine holds the game on its first loaded frame (main.cpp intro-hold) until the player is in and the page's
  // cinematic is gone: released earlier, the zombies intro played hidden under the video.
  function releaseIntro() {
    if (introReleased || !introWanted || !module || options.introCovering()) return;
    introReleased = true;
    diagnostics.timings.introRelease = performance.now();
    module._KB_Input(INPUT.introRelease, 1, 0);
  }

  // Frame intervals since the previous call, read from the engine's shared ring (web_present.cpp) without calling into wasm.
  // Each reader keeps its own cursor: telemetry and the F3 panel never steal each other's frames.
  function presentReader() {
    let ring: { capacity: number; written: number; intervals: number; times: number } | null = null, last: number | null = null;
    return () => {
      if (!module) return null;
      const buffer = module.HEAPF32.buffer;
      if (!ring) {
        const [capacity, written, intervals, times] = new Uint32Array(buffer, module._KB_PresentRing(), 4);
        ring = { capacity, written, intervals, times };
      }
      const written = Atomics.load(new Uint32Array(buffer, ring.written, 1), 0);
      if (last === null) last = written;
      let count = (written - last) >>> 0, lost = 0;
      // The last 256 slots may be overwritten while we copy.
      if (count > ring.capacity - 256) {
        lost = count - (ring.capacity - 256);
        count = ring.capacity - 256;
      }
      const intervalView = new Float32Array(buffer, ring.intervals, ring.capacity), timeView = new Float64Array(buffer, ring.times, ring.capacity);
      const intervals: number[] = [], times: number[] = [];
      for (let i = (written - count) >>> 0; i !== written; i = (i + 1) >>> 0) {
        const slot = i & (ring.capacity - 1);
        if (intervalView[slot] > 0) {
          intervals.push(intervalView[slot]);
          times.push(timeView[slot]);
        }
      }
      last = written;
      return { intervals, times, lost };
    };
  }

  return {
    presentReader,
    get stopped() {
      return stopped;
    },
    load(settings: { sensitivity: number; volume: number }) {
      return starting ??= Promise.all([prepareAudio(), start(settings)]);
    },
    async play() {
      canvas.focus();
      const audio = context!;
      ++generation;
      // The muted consumer kept the ring current: its 60 ms lead is kept at handoff, emptying it starved the worklet's first calls.
      running = true;
      wakeMixer();
      if (!configured) {
        Atomics.store(counters, 0, 0);
        Atomics.store(counters, 1, 0);
        node!.port.postMessage({ type: 'mixer', mixer });
        configured = true;
      }
      node!.port.postMessage({ type: 'resume', since: Date.now() });
      diagnostics.interactive = true;
      input.enable(true);
      const lock = input.lock(), resume = audio.resume();
      try {
        await Promise.all([lock, resume]);
        introWanted = true;
        releaseIntro();
      } catch (error) {
        diagnostics.interactive = false;
        throw error;
      }
    },
    // Mouse and sound go back to the browser; the engine's simulation keeps running.
    pause() {
      input.enable(false);
      mouseX = mouseY = 0;
      diagnostics.interactive = false;
      const current = ++generation;
      if (context?.state === 'running') {
        context.suspend().then(() => { if (current === generation) running = false; }).catch(crash);
      } else running = false;
      module?._KB_Input(INPUT.pointerLock, 0, 0);
    },
    async stop() {
      stopped = true;
      clearInterval(pump);
      input.dispose();
      channel?.close();
      if (context) await context.close();
      module?.PThread.terminateAllThreads();
    },
    // Bit 0: a game menu owns the cursor; bit 1: it draws its own.
    uiState: () => (module ? module._KB_UIState() : 0),
    lock: () => input.lock(),
    unlock: () => input.unlock(),
    introReady: releaseIntro,
    // The adopted stream only sees the video's own end: when the player skips it, the glue must hear it from the page.
    finishIntro: () => module?.kbVideo.finishIntro(),
    videoMaster(value: number) {
      master = value;
      module?.kbVideo.setMaster(value);
    },
    telemetryMemory() {
      if (!module) return null;
      const wasmBytes = module.HEAPF32.buffer.byteLength, wasmBreak = module._KB_MemoryStats(3);
      return { wasmBytes, wasmBreak, wasmUnclaimedBytes: wasmBytes - wasmBreak,
        engineZBytes: module._KB_EngineAllocStats(0), engineHunkUsed: module._KB_EngineAllocStats(1), enginePMemUsed: module._KB_EngineAllocStats(2),
        textureStagingBytes: module._KB_WebResourceStats(0), bufferStagingBytes: module._KB_WebResourceStats(1),
        liveTextures: module._KB_WebResourceStats(2), programCount: module._KB_WebResourceStats(6),
        virtualReservedBytes: module._KB_VirtualMemoryStats(0),
        audioCachedPCMBytes: module._KB_AudioMemoryStats(0), audioCachedClips: module._KB_AudioMemoryStats(1), audioPCMEvictions: module._KB_AudioMemoryStats(2) };
    },
    audioSnapshot() {
      const fill = mixer ? (Atomics.load(new Int32Array(mixer.buffer, mixer.write, 1), 0) - Atomics.load(new Int32Array(mixer.buffer, mixer.read, 1), 0)) >>> 0 : null;
      return { contextState: context?.state ?? null, frames: Atomics.load(counters, 0) >>> 0, underruns: Atomics.load(counters, 2), fill,
        mixerDropped: module ? module._KB_AudioDropped() : null };
    },
  };
}
export type Engine = ReturnType<typeof createEngine>;
