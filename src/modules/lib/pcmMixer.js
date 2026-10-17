// Mixes several live speakers into one 48 kHz stereo s16le PCM stream.
//
// Voice receive gives one decoded stream per speaking member, but a voice
// connection can play only one stream. Every 20 ms the mixer takes one frame
// from each speaker that has audio queued, adds the samples together (clipped
// to 16-bit) and emits the result. Each speaker's queue is capped, so a stall
// drops old audio instead of letting the delay grow.
import { Readable } from 'node:stream';

export const FRAME_MS = 20;
export const FRAME_BYTES = 3840; // 960 samples x 2 channels x 2 bytes

export class PcmMixer extends Readable {
  /** @param {{ maxQueueFrames?: number, tickMs?: number, autostart?: boolean }} [opts] */
  constructor({ maxQueueFrames = 25, tickMs = FRAME_MS, autostart = true } = {}) {
    super({ highWaterMark: FRAME_BYTES * 8 });
    this.maxQueueFrames = maxQueueFrames;
    this.sources = new Map(); // id -> { queue: Buffer[], partial: Buffer }
    this.timer = null;
    if (autostart) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref();
    }
  }

  /** Queue PCM from one speaker. Chunks need not be frame-aligned. */
  write(id, chunk) {
    if (this.destroyed) return;
    let src = this.sources.get(id);
    if (!src) {
      src = { queue: [], partial: Buffer.alloc(0) };
      this.sources.set(id, src);
    }
    let data = src.partial.length ? Buffer.concat([src.partial, chunk]) : chunk;
    while (data.length >= FRAME_BYTES) {
      src.queue.push(data.subarray(0, FRAME_BYTES));
      data = data.subarray(FRAME_BYTES);
    }
    src.partial = Buffer.from(data);
    if (src.queue.length > this.maxQueueFrames) src.queue.splice(0, src.queue.length - this.maxQueueFrames);
  }

  /** Forget a speaker once their stream has ended; queued audio still plays out. */
  finish(id) {
    const src = this.sources.get(id);
    if (src) src.finished = true;
  }

  /** Emit one mixed frame if anybody has audio queued. Returns whether it did. */
  tick() {
    if (this.destroyed) return false;
    let acc = null;
    let sources = 0;
    for (const [id, src] of this.sources) {
      const frame = src.queue.shift();
      if (!frame) {
        if (src.finished) this.sources.delete(id);
        continue;
      }
      sources += 1;
      acc ??= new Int32Array(FRAME_BYTES / 2);
      for (let i = 0; i < acc.length; i += 1) acc[i] += frame.readInt16LE(i * 2);
    }
    if (!acc) return false;
    const out = Buffer.allocUnsafe(FRAME_BYTES);
    for (let i = 0; i < acc.length; i += 1) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, acc[i])), i * 2);
    }
    this.lastMixedSources = sources;
    this.push(out);
    return true;
  }

  _read() {}

  _destroy(err, cb) {
    clearInterval(this.timer);
    this.sources.clear();
    cb(err);
  }
}
