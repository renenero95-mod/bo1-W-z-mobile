import { diagnostics } from './diagnostics.ts';
import type { Engine } from './engine.ts';

// The server's GET probe decides whether this page may send (only pages opened on the server's own machine).
// Frame intervals are read from the engine's ring every 10 s, with no message per frame.
const PERIOD_MS = 10000, LOG_TAIL = 300, LINE_CHARS = 2000, BEACON_BYTES = 60000;
const BUCKETS = [8.4, 16.8, 20, 25, 33.4, 50, 100, 250, Infinity];

type Frames = { intervals: number[]; times: number[]; lost: number };
type Context = { screen: () => string; engine: () => Engine | null; errorKind: () => string | null };

const percentile = (sorted: ArrayLike<number>, p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] : null);
const round = (value: number | null) => (value === null || !Number.isFinite(value) ? value : Math.round(value * 100) / 100);

function rendererInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { webgl2: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { webgl2: true, vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER), version: gl.getParameter(gl.VERSION),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) };
  }
}

function measureRaf(ms = 2000) {
  return new Promise<object>(resolve => {
    const intervals: number[] = [];
    let last: number | null = null, done = false;
    const start = performance.now();
    function finish() {
      if (done) return;
      done = true;
      intervals.sort((a, b) => a - b);
      const median = percentile(intervals, 0.5);
      resolve({ samples: intervals.length, medianMs: round(median), hz: median ? round(1000 / median) : null,
        p95Ms: round(percentile(intervals, 0.95)), visibility: document.visibilityState });
    }
    function tick(now: number) {
      if (done) return;
      if (last !== null) intervals.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else finish();
    }
    // A hidden tab pauses requestAnimationFrame: report what was measured.
    setTimeout(finish, ms + 1000);
    requestAnimationFrame(tick);
  });
}

function frameStats(intervals: number[], times: number[]) {
  const sorted = Float64Array.from(intervals).sort();
  const worst: { ms: number | null; atMs: number }[] = [];
  for (let i = 0; i < intervals.length; ++i) {
    if (worst.length < 5 || intervals[i] > worst[worst.length - 1].ms!) {
      worst.push({ ms: round(intervals[i]), atMs: Math.round(times[i] - performance.timeOrigin) });
      worst.sort((a, b) => b.ms! - a.ms!);
      if (worst.length > 5) worst.pop();
    }
  }
  let over33 = 0, over50 = 0, total = 0;
  for (const value of intervals) {
    total += value;
    if (value > 33) over33++;
    if (value > 50) over50++;
  }
  return { count: intervals.length, meanMs: round(intervals.length ? total / intervals.length : null), medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)), p99Ms: round(percentile(sorted, 0.99)), maxMs: round(sorted.length ? sorted[sorted.length - 1] : null),
    over33, over50, worst };
}

export function startTelemetry(base: string, context: Context) {
  const url = `${base}telemetry`;
  let enabled: boolean | null = null, build: string | null = null, pending: [object, boolean][] | null = [];
  const session = crypto.randomUUID();
  const totals = { frames: 0, over33: 0, over50: 0, lost: 0, histogram: BUCKETS.map(() => 0), worst: [] as { ms: number | null; atMs: number }[], records: 0 };
  let crashSent = 0, errorsSent = 0, hiddenCount = 0, lastMemory: object | null = null, ended = false;
  let timer: ReturnType<typeof setInterval> | undefined, crashTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: (() => Frames | null) | null = null, flushCrash: (() => void) | null = null;

  function post(body: object, final: boolean) {
    const text = JSON.stringify(body);
    // A beacon survives page unload but caps near 64 KB; a crash record with its console tail goes as a regular request.
    if (final && text.length < BEACON_BYTES && navigator.sendBeacon(url, new Blob([text], { type: 'application/json' }))) return;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: text.length < BEACON_BYTES }).catch(() => {});
  }
  function send(type: string, data: object = {}, final = false) {
    if (enabled === false) return;
    const body = { type, session, seq: totals.records++, pageMs: Math.round(performance.now()), wall: new Date().toISOString(),
      screen: context.screen(), interactive: diagnostics.interactive, build, pack: diagnostics.manifestVersion, ...data };
    if (pending) pending.push([body, final]);
    else post(body, final);
  }
  const ready = fetch(url, { cache: 'no-store' }).then(response => (response.ok ? response.json() : null)).catch(() => null).then(info => {
    enabled = Boolean(info?.enabled);
    build = info?.build ?? null;
    const queued = pending!;
    pending = null;
    if (enabled) for (const [body, final] of queued) post({ ...body, build }, final);
  });

  function drainFrames() {
    const engine = context.engine();
    if (!engine) return null;
    reader ??= engine.presentReader();
    const frames = reader();
    if (!frames) return null;
    const { intervals, times, lost } = frames;
    totals.lost += lost;
    const stats = frameStats(intervals, times);
    totals.frames += stats.count;
    totals.over33 += stats.over33;
    totals.over50 += stats.over50;
    for (const value of intervals) totals.histogram[BUCKETS.findIndex(limit => value < limit)]++;
    totals.worst = [...totals.worst, ...stats.worst].sort((a, b) => b.ms! - a.ms!).slice(0, 5);
    return { ...stats, lost, windowMs: intervals.length ? Math.round(times[times.length - 1] - times[0]) : 0 };
  }
  function sample() {
    // After a crash, a dead thread may hold the mixer or allocator locks: no more calls into wasm.
    const engine = context.engine(), live = Boolean(engine && !crashSent && !engine.stopped);
    let memory: object | null = null, audio: object | null = null;
    try {
      memory = live ? engine!.telemetryMemory() : null;
      audio = live ? { ...engine!.audioSnapshot(), discardedFrames: diagnostics.audioDiscardedFrames } : null;
    } catch (error) {
      memory = { error: (error as Error).message };
    }
    if (memory) lastMemory = memory;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return { memory, audio,
      jsHeap: heap ? { usedJSHeap: heap.usedJSHeapSize, totalJSHeap: heap.totalJSHeapSize, limitJSHeap: heap.jsHeapSizeLimit } : null,
      renderer: { chosen: diagnostics.renderer, requested: diagnostics.rendererRequested, reason: diagnostics.rendererReason, detail: diagnostics.rendererDetail },
      warmGate: diagnostics.warmGate, visibility: document.visibilityState, focused: document.hasFocus(), hiddenCount,
      pointerLocked: Boolean(document.pointerLockElement), fullscreen: Boolean(document.fullscreenElement),
      counters: { consoleErrors: diagnostics.consoleErrors, scriptExceptions: diagnostics.scriptExceptions, glErrors: diagnostics.glErrors,
        inputEvents: diagnostics.inputEvents, inputDropped: diagnostics.inputDropped, consoleDiscarded: diagnostics.consoleDiscarded } };
  }
  const tail = () => diagnostics.console.slice(-LOG_TAIL).map(row => ({ ms: Math.round(row.ms), error: row.error || undefined,
    message: row.message.length > LINE_CHARS ? `${row.message.slice(0, LINE_CHARS)}…` : row.message }));

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenCount++; });
  addEventListener('pagehide', () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    flushCrash?.();
    let frames = null;
    try {
      frames = drainFrames();
    } catch {}
    send('end', { frames, totals: { ...totals, histogramLimitsMs: BUCKETS.map(String) }, sinceStartMs: Math.round(performance.now()),
      timings: diagnostics.timings, crashed: crashSent > 0, errorKind: context.errorKind(), lastMemory, ...sample() }, true);
  });
  ready.then(async () => {
    if (!enabled) return;
    const navigatorExtra = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform: string } };
    send('start', { userAgent: navigator.userAgent, platform: navigatorExtra.userAgentData?.platform ?? navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigatorExtra.deviceMemory ?? null,
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
      devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, raf: await measureRaf(), webgl: rendererInfo(), crossOriginIsolated,
      url: location.pathname + location.search });
    timer = setInterval(() => {
      if (diagnostics.timings.wasmReady && !context.engine()?.stopped) send('periodic', { frames: drainFrames(), ...sample() });
    }, PERIOD_MS);
  });

  return {
    crash(message: string, detail: { stack: string | null; source: string }) {
      if (crashSent >= 6) return;
      const record = () => ({ message, stack: detail.stack, source: detail.source, sinceStartMs: Math.round(performance.now()),
        timings: diagnostics.timings, errors: diagnostics.errors.slice(-20), lastMemory, exitCode: diagnostics.exitCode });
      if (crashSent++) return send('crash-secondary', record());
      // Threads post their stacks just after the fatal line: give them a moment.
      flushCrash = () => {
        if (!crashTimer) return;
        clearTimeout(crashTimer);
        crashTimer = undefined;
        let frames = null;
        try {
          frames = drainFrames();
        } catch {}
        send('crash', { ...record(), frames, log: tail(), consoleLines: diagnostics.console.length }, ended);
      };
      crashTimer = setTimeout(flushCrash, 750);
      if (ended) flushCrash();
    },
    error(source: string, message: string, stack: string | null = null) {
      if (errorsSent++ >= 30) return;
      send('error', { source, message: message.slice(0, 4000), stack, sinceStartMs: Math.round(performance.now()) });
    },
  };
}
