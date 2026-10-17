<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { diagnostics } from '../game/diagnostics.ts';
import { hiddenRoom, room } from '../game/pack.ts';
import { currentEngine, view } from '../game/session.ts';
import { HOST } from '../net/lan.ts';
import { link, traffic } from '../net/link.ts';

// Loaded on the first F3. Engine frames: present intervals from its shared ring (own cursor, telemetry keeps all of its own);
// page: requestAnimationFrame cadence; the page's long tasks.
const props = defineProps<{ mode: 'compact' | 'detail' }>();
const { t, n } = useI18n();
const WINDOW_MS = 5000, UPDATE_MS = 500, GRAPH_MS = 4000;
const RENDERERS: Record<string, string> = { webgpu: 'WebGPU', 'webgpu-pipeline': 'WebGPU', webgl2: 'WebGL 2' };
type Sample = { t: number; ms: number };
// The present ring's clock: epoch milliseconds.
const now = () => performance.timeOrigin + performance.now();

function summarize(samples: Sample[], windowMs: number) {
  const n = samples.length;
  if (!n) return { frames: 0, fps: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, over33: 0, over100: 0 };
  const sorted = Float64Array.from(samples, sample => sample.ms).sort();
  const pick = (q: number) => +sorted[Math.min(n - 1, Math.floor(q * n))].toFixed(1);
  const over33 = samples.filter(sample => sample.ms > 33).length, over100 = samples.filter(sample => sample.ms > 100).length;
  return { frames: n, fps: +(n * 1000 / windowMs).toFixed(1), p50Ms: pick(0.5), p95Ms: pick(0.95), p99Ms: pick(0.99), maxMs: +sorted[n - 1].toFixed(1), over33, over100 };
}
function prune(list: Sample[], from: number) {
  const stale = list.findIndex(sample => sample.t >= from);
  list.splice(0, stale === -1 ? list.length : stale);
}

const presents: Sample[] = [], rafs: Sample[] = [], longTasks: Sample[] = [];
const started = now();
let reader: (() => { intervals: number[]; times: number[] } | null) | null = null, lastRaf = 0, lastPresent = 0, stopped = false;
let totalOver33 = 0, netPrevious: { t: number; sent: number; received: number } | null = null;
const graph = ref<HTMLCanvasElement>();
const s = reactive({
  present: summarize([], 1), sinceLastMs: null as number | null, raf: summarize([], 1), busyPct: null as number | null,
  renderer: '–', size: '–', memory: '–', under: null as number | null, sent: 0, received: 0,
});

function rafTick(t: number) {
  if (stopped) return;
  if (lastRaf && document.visibilityState === 'visible') rafs.push({ t: performance.timeOrigin + t, ms: t - lastRaf });
  lastRaf = t;
  requestAnimationFrame(rafTick);
}
requestAnimationFrame(rafTick);
let observer: PerformanceObserver | null = null;
try {
  observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ t: performance.timeOrigin + entry.startTime, ms: entry.duration }); });
  observer.observe({ type: 'longtask', buffered: false });
} catch {}
const longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;

function drain() {
  const engine = currentEngine();
  if (!engine) return;
  reader ??= engine.presentReader();
  let frames = null;
  try {
    frames = reader();
  } catch {}
  if (!frames) return;
  frames.intervals.forEach((ms, i) => {
    presents.push({ t: frames.times[i], ms });
    if (ms > 33) totalOver33++;
    lastPresent = frames.times[i];
  });
}

function draw() {
  const canvas = graph.value;
  if (!canvas) return;
  const dpr = devicePixelRatio || 1, g = canvas.getContext('2d')!, w = canvas.width / dpr, h = canvas.height / dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const y = (ms: number) => h - Math.min(1, ms / 40) * h;
  g.strokeStyle = 'rgba(255,240,220,.18)';
  g.lineWidth = 1;
  g.setLineDash([3, 3]);
  for (const ms of [16.7, 33.3]) {
    const line = Math.round(y(ms)) + 0.5;
    g.beginPath();
    g.moveTo(0, line);
    g.lineTo(w, line);
    g.stroke();
  }
  g.setLineDash([]);
  const from = now() - GRAPH_MS, recent = presents.filter(frame => frame.t >= from), x = (frame: Sample) => (frame.t - from) / GRAPH_MS * w;
  if (recent.length > 1) {
    g.beginPath();
    recent.forEach((frame, i) => (i ? g.lineTo(x(frame), y(frame.ms)) : g.moveTo(x(frame), y(frame.ms))));
    g.strokeStyle = '#7cc47f';
    g.lineWidth = 1.5;
    g.stroke();
    for (const frame of recent) {
      if (frame.ms <= 33) continue;
      g.fillStyle = frame.ms > 100 ? '#e8382b' : '#e6a83b';
      g.fillRect(x(frame) - 1.5, y(frame.ms), 3, h - y(frame.ms));
    }
  }
  g.fillStyle = 'rgba(255,240,220,.45)';
  g.font = '10px ui-monospace, Menlo, monospace';
  g.textBaseline = 'top';
  g.fillText('33', 2, y(33.3) + 2);
  g.fillText('16', 2, y(16.7) + 2);
}

function update() {
  drain();
  const t = now(), span = Math.min(WINDOW_MS, t - started);
  for (const list of [presents, rafs, longTasks]) prune(list, t - WINDOW_MS);
  s.present = summarize(presents, span);
  s.sinceLastMs = lastPresent ? Math.round(t - lastPresent) : null;
  s.raf = summarize(rafs, span);
  s.busyPct = longTaskSupported ? +(100 * longTasks.reduce((sum, task) => sum + task.ms, 0) / span).toFixed(1) : null;
  const engine = currentEngine();
  s.renderer = RENDERERS[diagnostics.renderer ?? ''] ?? diagnostics.renderer ?? '–';
  s.size = diagnostics.canvas ? `${diagnostics.canvas.width} × ${diagnostics.canvas.height}` : '–';
  let memory = null, audio = null;
  try {
    memory = engine?.telemetryMemory();
    audio = engine?.audioSnapshot();
  } catch {}
  s.memory = memory ? `${num((memory.wasmBreak ?? memory.wasmBytes) / 2 ** 30, 2)} / ${n(memory.wasmBytes / 2 ** 30, { style: 'unit', unit: 'gigabyte', minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '–';
  s.under = audio?.underruns ?? null;
  const rate = (key: 'sent' | 'received') => (netPrevious ? Math.round((traffic[key] - netPrevious[key]) * 1000 / (t - netPrevious.t)) : 0);
  s.sent = rate('sent');
  s.received = rate('received');
  netPrevious = { t, sent: traffic.sent, received: traffic.received };
  draw();
}

const num = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? '–' : n(value, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const tone = (fps: number) => (fps >= 55 ? 'good' : fps >= 30 ? 'warn' : 'bad');
const linkState = () => (link.label === HOST ? [t('perf.links.host'), 'good'] : link.relayed ? [t('perf.links.relay'), 'relay'] : link.linked ? [t('perf.links.direct'), 'good'] : [t('perf.links.wait'), 'warn']);

function resize() {
  netPrevious = null;
  const canvas = graph.value!, dpr = devicePixelRatio || 1, [w, h] = props.mode === 'detail' ? [294, 54] : [212, 34];
  Object.assign(canvas, { width: w * dpr, height: h * dpr });
  Object.assign(canvas.style, { width: `${w}px`, height: `${h}px` });
  update();
}
onMounted(resize);
watch(() => props.mode, resize, { flush: 'post' });
const timer = setInterval(update, UPDATE_MS);
onUnmounted(() => {
  stopped = true;
  observer?.disconnect();
  clearInterval(timer);
});
</script>

<template>
  <div id="perf-overlay" :class="mode" aria-hidden="true">
    <div class="fps"><b :class="s.present.frames ? tone(s.present.fps) : 'bad'">{{ s.present.frames ? Math.round(s.present.fps) : '–' }}</b><span>FPS</span><em>{{ num(s.present.p50Ms) }} ms</em></div>
    <canvas ref="graph"></canvas>
    <div class="row" v-if="mode === 'compact'"><span>p95 <b>{{ num(s.present.p95Ms) }} ms</b></span><span>{{ $t('perf.hitches') }} <b :class="s.present.over33 ? 'warn' : ''">{{ s.present.over33 }}</b></span></div>
    <div class="rows" v-else>
      <div class="row"><span>{{ $t('perf.median') }} <b>{{ num(s.present.p50Ms) }} ms</b></span><span>p95 <b>{{ num(s.present.p95Ms) }} ms</b></span></div>
      <div class="row"><span>{{ $t('perf.low') }} <b>{{ s.present.p99Ms ? `${Math.round(1000 / s.present.p99Ms)} FPS` : '–' }}</b></span><span>{{ $t('perf.worst') }} <b>{{ num(s.present.maxMs) }} ms</b></span></div>
      <div class="row"><span>{{ $t('perf.hitches33') }} <b :class="s.present.over33 ? 'warn' : ''">{{ s.present.over33 }}</b> · &gt;100 ms <b :class="s.present.over100 ? 'bad' : ''">{{ s.present.over100 }}</b></span></div>
      <div class="row"><span>{{ $t('perf.sinceStart') }} <b>{{ $t('perf.total', totalOver33) }}</b></span></div>
      <div class="group"><h4>{{ $t('perf.engine') }}</h4>
        <div class="row"><span>{{ $t('perf.render') }} <b>{{ s.renderer }}</b></span><span>{{ $t('perf.size') }} <b>{{ s.size }}</b></span></div>
        <div class="row"><span>{{ $t('perf.memory') }} <b>{{ s.memory }}</b></span></div>
        <div class="row"><span>{{ $t('perf.page') }} <b>{{ s.raf.frames ? Math.round(s.raf.fps) : '–' }}</b> FPS</span><span>{{ $t('perf.busy') }} <b>{{ s.busyPct === null ? '–' : $n(s.busyPct / 100, { style: 'percent' }) }}</b></span></div>
      </div>
      <div class="group"><h4>{{ $t('perf.sound') }}</h4>
        <div class="row"><span>{{ $t('perf.dropouts') }} <b :class="s.under ? 'warn' : ''">{{ s.under ?? '–' }}</b></span></div>
      </div>
      <div class="group" v-if="room"><h4>{{ $t(hiddenRoom ? 'privateRoom' : 'room', { code: room }) }}</h4>
        <div class="row"><span :class="`dot ${linkState()[1]}`">{{ linkState()[0] }}</span><span>{{ $t('perf.lost') }} <b :class="traffic.dropped ? 'warn' : ''">{{ traffic.dropped }}</b></span></div>
        <div class="row"><span>{{ $t('perf.sent') }} <b>{{ s.sent }}</b>/s</span><span>{{ $t('perf.received') }} <b>{{ s.received }}</b>/s</span></div>
      </div>
    </div>
    <div class="row bad" v-if="(s.sinceLastMs ?? 0) > 250">{{ $t('perf.stalled', { s: num((s.sinceLastMs ?? 0) / 1000) }) }}</div>
  </div>
</template>

<style>
#perf-overlay { position: fixed; top: 10px; left: 10px; z-index: 2147483647; pointer-events: none; user-select: none; display: grid; gap: 6px;
  padding: 10px 12px; background: rgba(10, 8, 7, .78); border: 1px solid rgba(255, 240, 220, .12); backdrop-filter: blur(6px);
  color: #f3ede2; font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
#perf-overlay.compact { width: 236px; } #perf-overlay.detail { width: 318px; gap: 4px; }
#perf-overlay .fps { display: flex; align-items: baseline; gap: 8px; }
#perf-overlay .fps b { font: 700 30px/1 ui-monospace, Menlo, Consolas, monospace; }
#perf-overlay .fps span { font: 600 13px 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: .14em; color: #b3a998; }
#perf-overlay .fps em { margin-left: auto; font-style: normal; font-weight: 600; font-size: 15px; }
#perf-overlay .rows { display: grid; gap: 4px; }
#perf-overlay .row { display: flex; justify-content: space-between; gap: 14px; color: #b3a998; }
#perf-overlay .row b { font-weight: 600; color: #f3ede2; }
#perf-overlay .group { display: grid; gap: 3px; padding-top: 6px; margin-top: 2px; border-top: 1px solid rgba(255, 240, 220, .12); }
#perf-overlay h4 { margin: 0 0 1px; font: 700 12px 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: .26em; text-transform: uppercase; color: #7d7468; }
#perf-overlay .good { color: #7cc47f; } #perf-overlay .warn { color: #e6a83b; } #perf-overlay .bad { color: #e8382b; } #perf-overlay .relay { color: #6aa9e8; }
#perf-overlay .dot::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }
</style>
