import type { Stream } from '../download/protocol.ts';
import { diagnostics } from './diagnostics.ts';

// The "<map>_load" cinematic starts muted, restarts with sound at launch and plays on during the download; the engine glue
// then adopts it (Module.kbIntro) and continues from its position. The glue writes adopted and ended into this object.
export type Intro = { name: string; video: HTMLVideoElement; started: boolean; finished: string | null; adopted?: boolean; ended?: boolean };

let intro: Intro | null = null;
let onFinish: (skipped: boolean) => void = () => {};

export const currentIntro = () => intro;
export const introCovering = () => Boolean(intro?.started && !intro.finished && intro.video.isConnected);

export function setupIntro(streams: Stream[], packBase: string, canvas: HTMLCanvasElement, finished: (skipped: boolean) => void) {
  const variants = streams.filter(stream => stream.kind === 'video' && /_load$/.test(stream.name ?? ''));
  if (intro || !variants.length) return;
  onFinish = finished;
  const name = variants[0].name!;
  const video = document.createElement('video');
  video.id = 'intro';
  Object.assign(video, { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
  for (const variant of variants.filter(entry => entry.name === name)) {
    video.append(Object.assign(document.createElement('source'), { src: packBase + variant.path, type: variant.mime }));
  }
  intro = { name, video, started: false, finished: null };
  diagnostics.timings.introSetup = performance.now();
  canvas.after(video);
  video.addEventListener('ended', () => { if (intro?.started) finishIntro('ended'); });
  // Once finished, it stays silent and still, whatever asks it to play again (an engine loop or rewind).
  video.addEventListener('playing', () => {
    if (!intro?.finished) return;
    video.muted = true;
    video.pause();
  });
  video.play().catch(() => {});
}

export function startIntro(volume: number) {
  if (!intro || intro.started || intro.adopted) return;
  const video = intro.video;
  intro.started = true;
  diagnostics.timings.introStart = performance.now();
  video.currentTime = 0;
  video.volume = volume;
  video.muted = false;
  // Without a gesture on this page, Chrome refuses sound: it plays on muted.
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
  });
}

// Not adopted by the time of the ready screen, the game or an error: it has nothing left to show.
export function retireIntro() {
  if (!intro || intro.adopted || !intro.video.isConnected) return;
  intro.video.muted = true;
  intro.video.pause();
  intro.video.remove();
}

// End or skip: picture and sound stop at once, no fade, and whatever is below shows (the engine's frame or its load screen).
export function finishIntro(reason: 'ended' | 'skip' | 'closed') {
  if (!intro || intro.finished) return;
  intro.finished = reason;
  diagnostics.timings.introFinished = performance.now();
  intro.video.muted = true;
  intro.video.pause();
  intro.video.hidden = true;
  onFinish(reason === 'skip');
}

// The engine closed the adopted stream (its post-load end or its own skip key): it removed the element.
export function checkIntroClosed() {
  if (intro?.started && !intro.finished && intro.adopted && !intro.video.isConnected) finishIntro('closed');
}

// In game, a click skips the cinematic, a key only once adopted; while loading, nothing skips it.
export function skipIntroOnInput(inGame: () => boolean) {
  const playing = () => Boolean(intro?.started && !intro.finished && inGame());
  document.addEventListener('keydown', event => {
    if (playing() && intro!.adopted && !event.repeat && !/^(Control|Alt|Meta|Shift|Tab|F\d+)$/.test(event.key)) finishIntro('skip');
  }, true);
  document.addEventListener('mousedown', () => { if (playing()) finishIntro('skip'); }, true);
}
