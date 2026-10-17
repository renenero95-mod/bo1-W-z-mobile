import { diagnostics } from './diagnostics.ts';

// One progress from the click to "Prêt": P = wd × D + (1 − wd) × E. D: verified boot bytes; E: engine phases (wasm, main,
// zones weighted by size, engine initialized, map loaded). wd is set at the first download progress from the expected time at
// 90 Mbit/s against the engine time: a first visit is about 60 % download, a later visit 100 % load. Time left: bytes left at
// the measured rate, plus (1 − E) × engine time, smoothed.
const REF_RATE = 90e6 / 8;
const ENGINE_KEY = 'bo1z-engine';

type Progress = { pct: number; eta: number | null; engine: number };
type Run = { t0: number; shown: number; eta: number | null; last: number; timer?: ReturnType<typeof setInterval>; wd: number; rates: [number, number][];
  dl: { c0: number; completed: number; total: number; t: number } | null };

// This machine's engine time for the map, kept from its last load that had every file at callMain
// (the 27 s default took 7 s on the test machine).
function measuredSeconds(slug: string): number | undefined {
  try {
    return JSON.parse(localStorage.getItem(ENGINE_KEY)!)?.[slug];
  } catch {
    return undefined;
  }
}

export function rememberEngineTime(slug: string) {
  const { mapLoaded, engineStart, bootReady, callMain } = diagnostics.timings;
  if (!mapLoaded || !(bootReady <= callMain)) return;
  try {
    localStorage.setItem(ENGINE_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(ENGINE_KEY)!), [slug]: (mapLoaded - engineStart) / 1000 }));
  } catch {}
}

// zones: size of each manifest zone (.ff) by name; the engine announces each loaded zone in its console.
export function createLoadbar(slug: string, defaultSeconds: number, zones: Map<string, number>, state: { booted: () => boolean; cached: () => boolean },
  show: (progress: Progress) => void) {
  const measured = measuredSeconds(slug);
  const engineSeconds = Number.isFinite(measured) ? measured! : defaultSeconds;
  const zoneTotal = [...zones.values()].reduce((sum, size) => sum + size, 0);
  let run: Run | null = null, engineShown = 0;

  function engineFraction() {
    const t = diagnostics.timings;
    let e = t.engineStart ? 0.02 : 0;
    if (t.wasmReady) e = 0.08;
    if (t.callMain) e = 0.1;
    if (zoneTotal) {
      const done = Object.keys(diagnostics.zoneTimes).reduce((sum, zone) => sum + (zones.get(zone) ?? 0), 0);
      if (done) e = Math.max(e, 0.1 + 0.8 * Math.min(1, done / zoneTotal));
    }
    if (t.engineInitialized) e = Math.max(e, 0.92);
    // Map loaded, the prompt waits for the WebGPU pipeline warm-up: the last 8 % follow it.
    if (t.mapLoaded && diagnostics.warmHolding) return 0.92 + 0.08 * warmFraction();
    return t.mapLoaded ? 1 : e;
  }
  const warmPending = () => {
    const w = diagnostics.warm;
    return Boolean(w.started && Number(w.seed) > 0 && w.rows > 0 && !w.finished);
  };
  // Without warm-up progress reports, the bar creeps with the clock towards the hold limit.
  function warmFraction() {
    const w = diagnostics.warm, of = w.total || w.rows, mapLoaded = diagnostics.timings.mapLoaded;
    if (w.progress && of) return Math.min(1, (w.done + w.failed) / of);
    return diagnostics.warmHolding ? 0.9 * Math.min(1, (performance.now() - mapLoaded) / (diagnostics.warmHoldUntil - mapLoaded)) : 0;
  }
  function warmEta() {
    const w = diagnostics.warm, of = w.total || w.rows, settled = w.done + w.failed, since = diagnostics.timings.warmStart;
    if (!w.progress || !of || !settled || !since) return null;
    const left = (of - settled) / (settled / Math.max(0.1, (performance.now() - since) / 1000));
    return Math.max(0, diagnostics.warmHolding ? Math.min(left, (diagnostics.warmHoldUntil - performance.now()) / 1000) : left);
  }

  function tick() {
    if (!run) return;
    const now = performance.now(), dt = (now - run.last) / 1000, booted = state.booted(), e = engineFraction(), dl = run.dl;
    run.last = now;
    // The engine segment starts after callMain's 10 %: wasm starts in 0.7 s, then FS_Startup waits for every IWD.
    engineShown = Math.max(engineShown, (e - 0.1) / 0.9);
    const d = booted || !dl ? (dl || booted ? 1 : 0) : (dl.completed - dl.c0) / Math.max(1, dl.total - dl.c0);
    const model = run.wd * d + (1 - run.wd) * e;
    let rem: number | null = null;
    const span = run.rates.length > 1 ? run.rates.at(-1)![0] - run.rates[0][0] : 0;
    if (!booted && dl && span >= 2500) {
      // Rate over the last 8 s, at least 60 % of the average: a short stall raises the estimate gently.
      const rate = Math.max((run.rates.at(-1)![1] - run.rates[0][1]) / (span / 1000), 0.6 * (dl.completed - dl.c0) / Math.max(1, (now - dl.t) / 1000));
      rem = (dl.total - dl.completed) / Math.max(rate, 1e5) + (1 - e) * engineSeconds;
    } else if (booted || state.cached()) rem = (1 - e) * engineSeconds;
    const pending = warmPending(), warmLeft = pending ? warmEta() : null;
    if (warmLeft !== null) rem = Math.max(rem ?? 0, warmLeft);
    if (rem !== null && now - run.t0 >= 3000) {
      run.eta = run.eta === null ? rem : Math.max(0, run.eta - dt);
      // Good news fast, bad news slowly: at most +0.5 s per second, net of the clock.
      run.eta += rem < run.eta ? 0.1 * (rem - run.eta) : Math.min(0.05 * (rem - run.eta), 1.5 * dt);
    }
    // During a long phase with no event (a big zone), the bar follows the clock, never more than 12 points past the model.
    const elapsed = (now - run.t0) / 1000, timed = run.eta === null ? 0 : elapsed / (elapsed + run.eta);
    const holding = Boolean(diagnostics.timings.mapLoaded && diagnostics.warmHolding);
    if (holding && warmLeft === null) run.eta = null;
    const cap = pending ? 0.92 + 0.08 * warmFraction() : 0.99;
    run.shown = Math.max(run.shown, Math.min(cap, Math.max(model, Math.min(timed, model + (holding ? 0 : 0.12)))));
    show({ pct: Math.floor(run.shown * 100), eta: run.eta === null ? null : Math.round(run.eta), engine: engineShown });
  }

  return {
    start() {
      if (run) return;
      const now = performance.now();
      run = { t0: now, shown: 0, eta: null, last: now, wd: 0, rates: [], dl: null };
      tick();
      run.timer = setInterval(tick, 250);
    },
    download(completed: number, total: number) {
      if (!run) return;
      const now = performance.now();
      if (!run.dl) {
        run.dl = { c0: completed, completed, total, t: now };
        const seconds = (total - completed) / REF_RATE;
        run.wd = Math.max(0, Math.min(0.85, seconds / (seconds + engineSeconds)));
      }
      Object.assign(run.dl, { completed, total });
      run.rates.push([now, completed]);
      while (run.rates.length > 2 && now - run.rates[0][0] > 8000) run.rates.shift();
    },
    stop() {
      if (run) clearInterval(run.timer);
      run = null;
    },
    done() {
      this.stop();
      show({ pct: 100, eta: 0, engine: 1 });
    },
  };
}
