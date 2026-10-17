// Game records for telemetry, the F3 panel and tests; the interface reads session.ts state, never this.
type ConsoleLine = { ms: number; error: boolean; message: string };
type Warm = { started: boolean; seed: string | null; rows: number; queued: number; done: number; failed: number; finished: boolean;
  pend?: number; total?: number; progress?: boolean; at?: number; ms?: number | null };

export const diagnostics = {
  timings: { pageLoad: performance.now() } as Record<string, number>,
  console: [] as ConsoleLine[],
  consoleErrors: 0,
  consoleDiscarded: 0,
  scriptExceptions: 0,
  glErrors: 0,
  inputEvents: 0,
  inputDropped: 0,
  audioDiscardedFrames: 0,
  errors: [] as string[],
  zoneTimes: {} as Record<string, number>,
  renderer: null as string | null,
  rendererRequested: null as string | null,
  rendererReason: null as string | null,
  rendererDetail: null as string | null,
  warm: { started: false, seed: null, rows: 0, queued: 0, done: 0, failed: 0, finished: false } as Warm,
  warmHolding: false,
  warmHoldUntil: 0,
  warmGate: null as object | null,
  manifestVersion: null as string | null,
  canvas: null as { width: number; height: number } | null,
  interactive: false,
  exitCode: null as number | null,
};
