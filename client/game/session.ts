import { shallowReactive, watch } from 'vue';
import type { Groups, Manifest, Reply } from '../download/protocol.ts';
import * as net from '../net/link.ts';
import { checkCapabilities, type Unsupported } from './capabilities.ts';
import { sizeGameCanvas } from './canvas.ts';
import { diagnostics } from './diagnostics.ts';
import { type CrashDetail, createEngine, createPackGate, type Engine, glslPack, type PackGate, rendererChoice, rendererRoute } from './engine.ts';
import { hordeArguments } from './horde.ts';
import { checkIntroClosed, currentIntro, finishIntro, introCovering, retireIntro, setupIntro, skipIntroOnInput, startIntro } from './intro.ts';
import { createLoadbar, rememberEngineTime } from './loadbar.ts';
import { BASE, connectTo, hiddenRoom, horde, map, opfsRoot, pack, packBase, programsUrl, room } from './pack.ts';
import { loadSettings } from './settings.ts';
import { startTelemetry } from './telemetry.ts';

export type Screen = 'checking' | 'download' | 'loading' | 'ready' | 'playing' | 'error';
// files: the browser storage could not read or write the files; not the connection.
export type Failure = { kind: Unsupported['kind'] } | { kind: 'quota'; missingBytes: number | null } | { kind: 'storage' }
  | { kind: 'download'; files: boolean } | { kind: 'engine'; memory: boolean };

// declined: mouse or sound refused on the last click; resume: in game without the mouse or a game menu.
export const view = shallowReactive({
  screen: 'checking' as Screen, groups: {} as Groups, engine: 0, pct: 0, eta: null as number | null,
  failure: null as Failure | null, declined: false, resume: false, report: '',
});


// The load cinematic plays at 10 % volume (-20 dB) unless the player set one; in game, the chosen volume.
const LOAD_VOLUME = 0.1;
const MEMORY = /out of memory|\bOOM\b|allocat.*memory|memory.*allocat/i;
const settings = loadSettings();
const telemetry = startTelemetry(BASE, { screen: () => view.screen, engine: () => engine, errorKind: () => view.failure?.kind ?? null });

let canvas: HTMLCanvasElement;
let downloader: Worker | null = null, idle: Worker | null = null, engine: Engine | null = null, gate: PackGate | null = null;
let manifest: Manifest | null = null, cache: Extract<Reply, { type: 'cache-status' }> | null = null, want: string[] = [];
let downloading = false, booted = false, entering = false, quitting = false;
let loadbar: ReturnType<typeof createLoadbar> | null = null;
let joinTarget: Promise<string | null>;
let master = LOAD_VOLUME;

export const currentEngine = () => engine;

const loadVolume = () => (settings.volumeChosen ? Math.min(1, settings.volume) : LOAD_VOLUME);
function videoMaster(value: number) {
  master = value;
  engine?.videoMaster(value);
}

function show(screen: Screen) {
  view.screen = screen;
  if (screen === 'ready' || screen === 'playing' || screen === 'error') retireIntro();
}

function leaveGame() {
  document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  engine?.stop().catch(() => {});
}

function fail(failure: Failure) {
  if (failure.kind === 'engine') leaveGame();
  loadbar?.stop();
  view.failure = failure;
  show('error');
}

function post(type: 'inspect' | 'download') {
  const worker = downloader!;
  rendererChoice().then(choice => {
    want = choice.renderer === 'webgl2' ? [glslPack] : [];
    worker.postMessage({ type, pack, want });
  });
}

function newDownloader() {
  idle = null;
  downloader?.terminate();
  const worker = downloader = new Worker(new URL('../download/worker.ts', import.meta.url), { type: 'module' });
  worker.onerror = event => {
    event.preventDefault();
    downloadError(event.message || 'The download worker could not start.', '', false);
  };
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    if (data.type === 'manifest' && downloading && !booted) {
      manifest = data.manifest;
      diagnostics.timings.manifest = performance.now();
      gate ??= createPackGate(manifest.files, want);
      if (!engine) loadEngine();
    } else if (data.type === 'file-ready') gate?.fileReady(data.path);
    else if (data.type === 'cache-status') {
      cache = data;
      manifest = data.manifest;
      diagnostics.manifestVersion = manifest.version;
      idle = worker;
      setupIntro(manifest.streams ?? [], packBase, canvas, introFinished);
      diagnostics.timings.playAvailable = performance.now();
      begin();
    } else if (data.type === 'progress') {
      if (data.priority !== 'boot' || booted) return;
      view.groups = data.groups;
      loadbar?.download(data.completed, data.total);
    } else if (data.type === 'boot-ready') {
      booted = true;
      diagnostics.timings.bootReady = performance.now();
      manifest = data.manifest;
      gate?.release();
      if (view.screen === 'download') show('loading');
      if (!engine) loadEngine();
    } else if (data.type === 'complete') {
      downloading = false;
      worker.terminate();
    } else if (data.type === 'error') downloadError(data.message, data.name, data.storage);
  };
}

function downloadError(message: string, name: string, storage: boolean) {
  telemetry.error('download', `${name} ${message}`);
  downloading = false;
  idle = null;
  downloader?.terminate();
  diagnostics.errors.push(message);
  // The whole pack downloads before startup: an error afterwards deprives the game of nothing.
  if (booted) return;
  if (name === 'QuotaExceededError') fail({ kind: 'quota', missingBytes: null });
  else if (/SecurityError|NotAllowedError/.test(name)) fail({ kind: 'storage' });
  else fail({ kind: 'download', files: storage });
}

function inspect() {
  newDownloader();
  post('inspect');
}

async function begin() {
  if (downloading || !cache || !manifest) return;
  startIntro(loadVolume());
  videoMaster(loadVolume());
  try {
    if (cache.missingBytes) {
      const estimate = await navigator.storage.estimate();
      if ((estimate.quota ?? Infinity) - (estimate.usage ?? 0) < cache.missingBytes) return fail({ kind: 'quota', missingBytes: cache.missingBytes });
      // Persistence asked silently: if refused, the game goes on without it.
      await navigator.storage.persist().catch(() => false);
    }
    downloading = true;
    view.failure = null;
    show(cache.ready ? 'loading' : 'download');
    const zones = new Map(manifest.files.filter(file => /\.ff$/i.test(file.path)).map(file => [file.path.split('/').pop()!.replace(/\.ff$/i, ''), file.size]));
    loadbar = createLoadbar(map.slug, map.engineS ?? 27, zones, { booted: () => booted, cached: () => Boolean(cache?.ready) }, progress => Object.assign(view, progress));
    loadbar.start();
    // The worker that just inspected the cache holds the manifest: reuse it rather than start another.
    if (!idle || idle !== downloader) newDownloader();
    idle = null;
    post('download');
  } catch (error) {
    downloadError((error as Error).message, (error as Error).name, false);
  }
}

async function loadEngine() {
  diagnostics.timings.loadEngine = performance.now();
  if (view.screen !== 'download' || booted) show('loading');
  const size = diagnostics.canvas = sizeGameCanvas(canvas);
  if (!gate) {
    gate = createPackGate(manifest!.files, want);
    if (booted) gate.release();
  }
  engine = createEngine({
    canvas, size, base: BASE, zone: map.zone, opfsRoot, packBase, programsUrl, master,
    arguments: horde ? hordeArguments(settings.horde) : [], name: net.pseudo(), join: joinTarget, streams: manifest!.streams ?? [], gate, intro: currentIntro(), introCovering,
    net: { shared: net.shared, forward: net.forward },
    onReady: ready, onQuit: quit, onCrash: crash, onRelock: () => { if (view.screen === 'playing') engine!.lock().catch(() => {}); },
    report: (source, message) => telemetry.error(source, message),
  });
  try {
    await engine.load(settings);
  } catch (error) {
    crash((error as Error).message, { stack: (error as Error).stack ?? null, source: 'engine-load' });
  }
}

function ready() {
  if (view.failure?.kind === 'engine') return;
  rememberEngineTime(map.slug);
  loadbar?.done();
  show('ready');
}

function introFinished(skipped: boolean) {
  engine?.introReady();
  if (skipped) engine?.finishIntro();
}

// In fullscreen, Keyboard Lock hands Escape to the game, which opens its menu as on desktop (holding Escape leaves fullscreen).
function lockEscape() {
  return (navigator as Navigator & { keyboard?: { lock(keys: string[]): Promise<void> } }).keyboard?.lock(['Escape']).catch(() => {});
}

// Fullscreen, mouse and sound must come from the same gesture: everything is requested before the first await.
export function enter() {
  if (view.screen !== 'ready' || entering || !engine || net.link.failure) return;
  entering = true;
  view.declined = false;

  // PATCH v0.28: forza landscape su touch dopo il fullscreen
  const touchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
  const full = (settings.fullscreen || touchDevice) && !document.fullscreenElement
    ? document.documentElement.requestFullscreen().then(() => {
        lockEscape();
        // Dopo il fullscreen, tenta il lock orientamento landscape
        const so = (screen as Screen & { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
        if (so && typeof so.lock === 'function') {
          return so.lock('landscape').catch(() => {});
        }
      }, () => {})
    : Promise.resolve();

  const game = engine;
  Promise.all([full, game.play()]).then(() => {
    const touchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
    if (!touchDevice && document.pointerLockElement !== canvas) throw new Error('The mouse was not captured.');
    show('playing');
    diagnostics.timings.playing = performance.now();
    if (currentIntro()?.started) finishIntro('skip');
    videoMaster(Math.min(1, settings.volume));
  }).catch((err) => {
    console.error('[enter] caught:', err && err.message ? err.message : String(err));
    document.exitPointerLock();
    const touchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
    if (touchDevice) {
      // Su touch: prosegui comunque, l'errore non e' bloccante
      try { show('playing'); } catch(e) { console.error('[enter] show playing failed:', e); }
    } else {
      game.pause();
      view.declined = true;
    }
  }).finally(() => { entering = false; });
}

export function retry() {
  const failure = view.failure;
  if (failure?.kind !== 'download' && failure?.kind !== 'quota') return location.reload();
  if (cache) begin();
  else inspect();
}

function quit() {
  quitting = true;
  leaveGame();
  location.assign(BASE);
}

function crashReport(message: string, detail: CrashDetail, before: Screen) {
  const lines = diagnostics.console.slice(-40).map(row => (row.error ? '! ' : '  ') + row.message.slice(0, 400));
  const fatal = diagnostics.console.findLast(row => /KISAK_FATAL|^ERROR:|Com_Error/.test(row.message));
  return [
    fatal ? `Cause : ${fatal.message.replace(/^KISAK_FATAL\s*/, '')}` : null,
    `Erreur : ${message}`,
    `Source : ${detail.source}`,
    `Page : ${location.pathname}${location.search}`,
    `Navigateur : ${navigator.userAgent}`,
    `Rendu : ${diagnostics.renderer ?? '?'} (route ${rendererRoute}${diagnostics.rendererDetail ? `, ${diagnostics.rendererDetail}` : ''})`,
    `Écran avant l’erreur : ${before} ; ${Math.round(performance.now() / 1000)} s`,
    detail.stack && detail.stack !== message ? `Pile : ${detail.stack.slice(0, 1500)}` : null,
    `Console du moteur (${lines.length} dernières lignes) :`, ...lines,
  ].filter(line => line !== null).join('\n');
}

function crash(message: string, detail: CrashDetail) {
  if (quitting) return;
  telemetry.crash(message, detail);
  if (view.failure?.kind === 'engine') return;
  const before = view.screen;
  fail({ kind: 'engine', memory: MEMORY.test(message) });
  view.report = crashReport(message, detail, before);
  // Console lines posted by the failing thread just before its error may still be in flight.
  setTimeout(() => { view.report = crashReport(message, detail, before); }, 750);
}

function followGame() {
  checkIntroClosed();
  if (view.screen === 'playing' && engine) {
    const menu = engine.uiState(), locked = document.pointerLockElement === canvas;
    // A game menu draws its own cursor: the mouse is freed for absolute coordinates, without the system arrow.
    if (menu & 1 && locked) engine.unlock();
    canvas.classList.toggle('menu-cursor', Boolean(menu & 2));
    view.resume = !locked && !(menu & 1);
  }
  requestAnimationFrame(followGame);
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && (view.screen !== 'playing' || net.link.failure)) return location.assign(BASE);
  if (view.screen !== 'ready' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || /^(Escape|Tab|Shift|Control|Alt|Meta|F\d+)$/.test(event.key)) return;
  // Consumed here: the engine, which gets keys from the moment the player is in, would take it as a cinematic skip.
  event.preventDefault();
  event.stopImmediatePropagation();
  enter();
}

export async function startSession(game: HTMLCanvasElement) {
  canvas = game;
  document.addEventListener('keydown', onKey, true);
  skipIntroOnInput(() => view.screen === 'playing');
  addEventListener('error', event => crash(event.error?.message ?? event.message, { stack: event.error?.stack ?? null, source: `window-error ${event.filename}:${event.lineno}:${event.colno}` }));
  addEventListener('unhandledrejection', event => crash(event.reason?.message ?? String(event.reason), { stack: event.reason?.stack ?? null, source: 'unhandledrejection' }));
  addEventListener('pagehide', () => {
    downloader?.terminate();
    engine?.stop().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) (navigator as Navigator & { keyboard?: { unlock(): void } }).keyboard?.unlock();
  });
  // A room error during the game shows over it: the mouse must be free to click it.
  watch(() => net.link.failure, failure => { if (failure) document.exitPointerLock(); });
  requestAnimationFrame(followGame);
  try {
    console.log('[session] startSession called with canvas', game.width, 'x', game.height);
    const unsupported = await checkCapabilities();
    console.log('[session] capabilities result:', unsupported);
    if (unsupported) {
      diagnostics.errors.push(unsupported.reason);
      return fail({ kind: unsupported.kind });
    }
  } catch (error) {
    diagnostics.errors.push((error as Error).message);
    return fail({ kind: 'browser' });
  }
  joinTarget = net.start({ room, hidden: hiddenRoom, map: map.slug, connect: connectTo });
  inspect();
}
