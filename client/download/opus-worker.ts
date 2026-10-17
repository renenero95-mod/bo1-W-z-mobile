import { crc32 } from 'hash-wasm';
import type { OpusJob, OpusReply } from './protocol.ts';

// Decodes one Opus clip with WebCodecs, resamples 48 kHz to the clip's original rate (Catmull-Rom) at exactly its original
// frame count, and returns a PCM16 RIFF WAV with its SHA-256 (or, in zip mode, the MS-ADPCM entry and its zip CRC-32).
const reply = postMessage as (message: OpusReply, transfer: Transferable[]) => void;

onmessage = async ({ data: job }: MessageEvent<OpusJob>) => {
  try {
    const head = new Uint8Array(19), view = new DataView(head.buffer);
    head.set([79, 112, 117, 115, 72, 101, 97, 100, 1, job.ch]);
    view.setUint16(10, job.pre, true);
    view.setUint32(12, 48000, true);
    const planes = Array.from({ length: job.ch }, () => new Float32Array(job.sf));
    let got = 0, failure: unknown = null;
    const decoder = new AudioDecoder({
      output: audio => {
        const n = Math.min(audio.numberOfFrames, job.sf - got);
        for (let c = 0; c < job.ch && n > 0; ++c) audio.copyTo(planes[c].subarray(got, got + n), { planeIndex: c, format: 'f32-planar', frameCount: n });
        got += Math.max(n, 0);
        audio.close();
      },
      error: error => { failure = error; },
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: job.ch, description: head });
    const bytes = new Uint8Array(job.data);
    let at = job.hn ?? 0, timestamp = 0;
    for (const length of job.lens) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: bytes.subarray(at, at + length) }));
      at += length;
      timestamp += 20000;
    }
    await decoder.flush();
    decoder.close();
    if (failure) throw failure;
    // Decoders that honour the OpusHead pre-skip return sf - pre frames; the others return sf, so skip pre here.
    const skip = got >= job.sf ? job.pre : 0, valid = Math.max(0, Math.min(got - skip, job.g - job.pre));
    const step = 48000 / job.rate, frames = job.frames, out = new Int16Array(frames * job.ch);
    for (let c = 0; c < job.ch; ++c) {
      const x = planes[c], last = skip + valid - 1, sample = (k: number) => x[Math.min(Math.max(k, skip), last)] ?? 0;
      for (let i = 0; i < frames; ++i) {
        const t = skip + i * step, k = Math.floor(t), f = t - k;
        let y: number;
        if (f === 0) y = sample(k);
        else {
          const p0 = sample(k - 1), p1 = sample(k), p2 = sample(k + 1), p3 = sample(k + 2);
          y = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
        }
        if (k > last) y = 0;
        out[i * job.ch + c] = Math.round(Math.max(-1, Math.min(1, y)) * 32767);
      }
    }
    if (job.ab != null) {
      const entry = new Uint8Array(job.hn! + job.ab + job.tn!);
      entry.set(bytes.subarray(0, job.hn));
      entry.set(bytes.subarray(at, at + job.tn!), job.hn! + job.ab);
      adpcmEncode(out, job.ch, job.ab / (262 * job.ch), entry, job.hn!);
      return reply({ id: job.id, wav: entry.buffer, crc: parseInt(await crc32(entry), 16) }, [entry.buffer]);
    }
    const wav = new Uint8Array(44 + out.byteLength), w = new DataView(wav.buffer);
    const tag = (offset: number, text: string) => [...text].forEach((char, j) => { wav[offset + j] = char.charCodeAt(0); });
    tag(0, 'RIFF');
    w.setUint32(4, wav.length - 8, true);
    tag(8, 'WAVEfmt ');
    w.setUint32(16, 16, true);
    w.setUint16(20, 1, true);
    w.setUint16(22, job.ch, true);
    w.setUint32(24, job.rate, true);
    w.setUint32(28, job.rate * job.ch * 2, true);
    w.setUint16(32, job.ch * 2, true);
    w.setUint16(34, 16, true);
    tag(36, 'data');
    w.setUint32(40, out.byteLength, true);
    wav.set(new Uint8Array(out.buffer), 44);
    const sha = await crypto.subtle.digest('SHA-256', wav);
    reply({ id: job.id, wav: wav.buffer, sha }, [wav.buffer, sha]);
  } catch (error) {
    reply({ id: job.id, error: String((error as Error)?.message ?? error) }, []);
  }
};

// MS-ADPCM as the engine decodes it (software_mixer.cpp DecodeAdpcm): 512 frames per 262 × ch-byte block, the 7 standard
// coefficient pairs. Per block and channel: the predictor with the least residual, its delta from the mean residual.
const COEF = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];
const ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

function adpcmEncode(pcm: Int16Array, ch: number, blocks: number, dst: Uint8Array, base: number) {
  const frames = pcm.length / ch, sample = (i: number, c: number) => (i < frames ? pcm[i * ch + c] : 0), view = new DataView(dst.buffer);
  // Encodes the 510 frames of channel c after the two header samples; returns the squared error, writing nibbles when o >= 0.
  const trial = (f0: number, c: number, j: number, d0: number, o: number) => {
    let s2 = sample(f0, c), s1 = sample(f0 + 1, c), delta = d0, error = 0;
    const [c0, c1] = COEF[j];
    for (let t = 0; t < 510; ++t) {
      const x = sample(f0 + 2 + t, c), predicted = Math.trunc((s1 * c0 + s2 * c1) / 256), residual = x - predicted;
      let n = residual >= 0 ? Math.floor(residual / delta + 0.5) : -Math.floor(-residual / delta + 0.5);
      n = n < -8 ? -8 : n > 7 ? 7 : n;
      let y = predicted + n * delta;
      y = y < -32768 ? -32768 : y > 32767 ? 32767 : y;
      error += (x - y) * (x - y);
      s2 = s1;
      s1 = y;
      const nibble = n & 15;
      delta = Math.max(16, Math.floor(delta * ADAPT[nibble] / 256));
      if (o >= 0) {
        const i = t * ch + c, at = o + ch * 7 + (i >> 1);
        dst[at] = i & 1 ? dst[at] | nibble : nibble << 4;
      }
    }
    return error;
  };
  for (let k = 0; k < blocks; ++k) {
    const f0 = k * 512, o = base + k * 262 * ch;
    for (let c = 0; c < ch; ++c) {
      // Predictors ranked by open-loop residual; the best 3 are trial-encoded with 2 start deltas each, the least error kept.
      const rank = COEF.map(([a, b], j) => {
        let e = 0;
        for (let i = 2; i < 512; i += 2) e += Math.abs(sample(f0 + i, c) - (sample(f0 + i - 1, c) * a + sample(f0 + i - 2, c) * b) / 256);
        return [e, j];
      }).sort((x, y) => x[0] - y[0]);
      let best: [number, number, number] | null = null;
      for (const [e, j] of rank.slice(0, 3)) {
        for (const divisor of [2, 4]) {
          const d0 = Math.min(65535, Math.max(16, Math.round(e / 255 / divisor))), error = trial(f0, c, j, d0, -1);
          if (!best || error < best[0]) best = [error, j, d0];
        }
      }
      const [, j, d0] = best!;
      dst[o + c] = j;
      view.setUint16(o + ch + c * 2, d0, true);
      view.setInt16(o + ch * 3 + c * 2, sample(f0 + 1, c), true);
      view.setInt16(o + ch * 5 + c * 2, sample(f0, c), true);
      trial(f0, c, j, d0, o);
    }
  }
}
