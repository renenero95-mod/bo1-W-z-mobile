// The game canvas is never touched here: Emscripten transfers it untouched to its thread.
export type Unsupported = { kind: 'mobile' | 'secure' | 'browser' | 'gpu'; reason: string };

const LIMITS: [string, number][] = [['MAX_TEXTURE_SIZE', 2048],
  ['MAX_3D_TEXTURE_SIZE', 256],
  ['MAX_TEXTURE_IMAGE_UNITS', 16],
  ['MAX_VERTEX_TEXTURE_IMAGE_UNITS', 4],
  ['MAX_COMBINED_TEXTURE_IMAGE_UNITS', 20],
  ['MAX_VERTEX_UNIFORM_VECTORS', 264],
  ['MAX_FRAGMENT_UNIFORM_VECTORS', 264],
  ['MAX_VERTEX_ATTRIBS', 16]];

export function checkRenderer(gl: WebGL2RenderingContext | null): Unsupported | null {
  if (!gl) return { kind: 'gpu', reason: 'no WebGL2' };
  const missing = ['WEBGL_compressed_texture_s3tc', 'EXT_color_buffer_float'].filter(name => !gl.getExtension(name));
  if (!gl.getExtension('EXT_texture_norm16')) missing.push(...['OES_texture_float_linear', 'EXT_float_blend'].filter(name => !gl.getExtension(name)));
  for (const [name, minimum] of LIMITS) if (gl.getParameter(gl[name as keyof WebGL2RenderingContext] as number) < minimum) missing.push(name + ' >= ' + minimum);
  return missing.length ? { kind: 'gpu', reason: missing.join(', ') } : null;
}

const THREADS = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 3, 1, 1]);
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, ...Array(16).fill(0), 11]);

function wasmSupport() {
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 24576, shared: true });
    return memory.buffer instanceof SharedArrayBuffer && WebAssembly.validate(THREADS) && WebAssembly.validate(SIMD);
  } catch { return false; }
}

function urlFlag(name: string): boolean {
  try { return new URLSearchParams(location.search).has(name); } catch { return false; }
}

function collectFailures(): string[] {
  const fails: string[] = [];
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
    fails.push('mobile UA: ' + navigator.userAgent);
  if (!isSecureContext) fails.push('insecure context');
  if (!crossOriginIsolated) fails.push('no cross-origin isolation');
  const features: [boolean, string][] = [
    [typeof navigator.storage?.getDirectory === 'function' && 'locks' in navigator, 'OPFS and Web Locks'],
    [typeof AudioContext === 'function' && 'audioWorklet' in AudioContext.prototype, 'AudioWorklet'],
    ['transferControlToOffscreen' in HTMLCanvasElement.prototype, 'OffscreenCanvas'],
    ['requestPointerLock' in Element.prototype, 'pointer lock'],
    [!!(WebAssembly as { Tag?: unknown }).Tag, 'WebAssembly exceptions'],
    [wasmSupport(), 'WebAssembly threads and SIMD'],
    [typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function', 'WebAssembly JSPI'],
  ];
  for (const [ok, name] of features) if (!ok) fails.push('missing: ' + name);
  return fails;
}

export async function checkCapabilities(): Promise<Unsupported | null> {
  const debugMode = urlFlag('debug');
  const probeMode = urlFlag('probe');
  const mobileForced = urlFlag('mobile');

  if (probeMode || debugMode) {
    const fails = collectFailures();
    console.log('[capabilities probe] failures:', fails);
    if (probeMode) {}
    if (debugMode) return null;
  }
  if (/Android/i.test(navigator.userAgent)) return null;

  if (!mobileForced && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))) {
    return { kind: 'mobile', reason: navigator.userAgent };
  }
  if (!isSecureContext) return { kind: 'secure', reason: 'insecure context' };
  if (!crossOriginIsolated) return { kind: 'browser', reason: 'no cross-origin isolation' };
  const features: [unknown, string][] = [
    [typeof navigator.storage?.getDirectory === 'function' && 'locks' in navigator, 'OPFS and Web Locks'],
    [typeof AudioContext === 'function' && 'audioWorklet' in AudioContext.prototype, 'AudioWorklet'],
    ['transferControlToOffscreen' in HTMLCanvasElement.prototype, 'OffscreenCanvas'],
    ['requestPointerLock' in Element.prototype, 'pointer lock'],
    [(WebAssembly as { Tag?: unknown }).Tag, 'WebAssembly exceptions'],
    [wasmSupport(), 'WebAssembly threads and SIMD'],
    [typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function', 'WebAssembly JSPI'],
  ];
  const missing = features.find(([supported]) => !supported);
  if (missing) return { kind: 'browser', reason: missing[1] as string };
  const gl = document.createElement('canvas').getContext('webgl2');
  const failure = checkRenderer(gl);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  if (failure) return failure;
  return new Promise(resolve => {
    let worker: Worker | undefined;
    const finish = (result: Unsupported | null) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(result);
    };
    const unavailable: Unsupported = { kind: 'browser', reason: 'worker graphics or OPFS did not start' };
    const timer = setTimeout(() => finish(unavailable), 8000);
    try {
      worker = new Worker(new URL('./capability-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = event => { event.preventDefault(); finish(unavailable); };
      const canvas = document.createElement('canvas').transferControlToOffscreen();
      worker.postMessage(canvas, [canvas]);
    } catch { finish(unavailable); }
  });
}
