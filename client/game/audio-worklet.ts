// AudioWorklet global scope, missing from TypeScript's libraries.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions: { control: SharedArrayBuffer } }) => AudioWorkletProcessor): void;

// Mixer ring layout (_KB_AudioRing): offsets into wasm memory, frame counters that never wrap to 0.
export type Mixer = { buffer: SharedArrayBuffer; capacity: number; samples: number; read: number; write: number; mixTimes: number; demand: number };

// control: frames played, fill, underruns; read by the page for telemetry and the F3 panel.
class FiveAudio extends AudioWorkletProcessor {
  control: Int32Array;
  ring: { capacity: number; samples: Float32Array; read: Int32Array; write: Int32Array; mixTimes: Float64Array; demand: Int32Array } | null = null;
  discardBefore = 0;

  constructor(options: { processorOptions: { control: SharedArrayBuffer } }) {
    super();
    this.control = new Int32Array(options.processorOptions.control);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'mixer') {
        const mixer = data.mixer as Mixer;
        this.ring = {
          capacity: mixer.capacity,
          samples: new Float32Array(mixer.buffer, mixer.samples, mixer.capacity * 2),
          read: new Int32Array(mixer.buffer, mixer.read, 1),
          write: new Int32Array(mixer.buffer, mixer.write, 1),
          mixTimes: new Float64Array(mixer.buffer, mixer.mixTimes, mixer.capacity),
          demand: new Int32Array(mixer.buffer, mixer.demand, 1),
        };
      }
      // Back in game, sound mixed during the pause is dropped rather than played late.
      if (data.type === 'resume') this.discardBefore = data.since;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right] = outputs[0];
    const ring = this.ring;
    if (!ring) return true;
    let read = Atomics.load(ring.read, 0) >>> 0;
    const write = Atomics.load(ring.write, 0) >>> 0;
    let discarded = 0;
    while (this.discardBefore && read !== write) {
      if (ring.mixTimes[read % ring.capacity] >= this.discardBefore) {
        this.discardBefore = 0;
        break;
      }
      read = (read + 1) >>> 0;
      discarded++;
    }
    if (discarded) this.port.postMessage({ type: 'discarded', frames: discarded });
    const fill = (write - read) >>> 0;
    let count = 0;
    for (let i = 0; i < left.length; i++) {
      if (read === write) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      const index = (read % ring.capacity) * 2;
      left[i] = ring.samples[index];
      right[i] = ring.samples[index + 1];
      read = (read + 1) >>> 0;
      count++;
    }
    Atomics.store(ring.read, 0, read);
    // The engine's mixer sleeps until asked: wake it before the ring falls under 2048 frames.
    if (fill - count < 2048) {
      Atomics.add(ring.demand, 0, 1);
      Atomics.notify(ring.demand, 0, 1);
    }
    Atomics.add(this.control, 0, count);
    Atomics.store(this.control, 1, fill - count);
    if (count !== left.length) Atomics.add(this.control, 2, 1);
    return true;
  }
}

registerProcessor('five-audio', FiveAudio);
