import { checkRenderer, type Unsupported } from './capabilities.ts';

const reply = postMessage as (result: Unsupported | null) => void;

// A throwaway canvas: the game's belongs to the engine thread.
onmessage = ({ data: canvas }: MessageEvent<OffscreenCanvas>) => {
  if (!navigator.storage?.getDirectory || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) return reply({ kind: 'browser', reason: 'worker OPFS' });
  if (typeof requestAnimationFrame !== 'function') return reply({ kind: 'browser', reason: 'worker animation frames' });
  const gl = canvas.getContext('webgl2');
  const failure = checkRenderer(gl);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  reply(failure);
};
