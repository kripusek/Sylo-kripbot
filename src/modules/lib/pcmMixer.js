// Mixes several live speakers into one 48 kHz stereo s16le PCM stream, and
// feeds it to a voice AudioPlayer one "burst" at a time.
//
// Voice receive gives one decoded stream per speaking member, but a voice
// connection can play only one stream. PcmMixer takes one frame from each
// speaker that has audio queued, adds the samples together (clipped to 16-bit)
// and hands back the result. Each speaker's queue is capped, so a stall drops
// old audio instead of letting the delay grow.
//
// MixerPlayback owns the player side. An AudioPlayer ends a resource — and
// destroys its whole stream pipeline — after 5 consecutive empty 20 ms reads,
// so a single long-lived stream cannot survive silence between sentences. It
// therefore opens a fresh stream when somebody starts talking, keeps it fed
// with silence through short pauses, and closes it after a longer one.
import { Readable } from 'node:stream';

export const FRAME_MS = 20;
export const FRAME_BYTES = 3840; // 960 samples x 2 channels x 2 bytes
const SILENCE = Buffer.alloc(FRAME_BYTES);

export class PcmMixer {
  /** @param {{ maxQueueFrames?: number, prebufferFrames?: number }} [opts] */
  constructor({ maxQueueFrames = 25, prebufferFrames = 2 } = {}) {
    this.maxQueueFrames = maxQueueFrames;
    this.prebufferFrames = prebufferFrames;
    this.sources = new Map(); // id -> { queue, partial, playing, finished }
    this.destroyed = false;
  }

  /** Queue PCM from one speaker. Chunks need not be frame-aligned. */
  write(id, chunk) {
    if (this.destroyed) return;
    let src = this.sources.get(id);
    if (!src) {
      src = { queue: [], partial: Buffer.alloc(0), playing: false, finished: false };
      this.sources.set(id, src);
    }
    src.finished = false; // the same member started a new burst
    let data = src.partial.length ? Buffer.concat([src.partial, chunk]) : chunk;
    while (data.length >= FRAME_BYTES) {
      src.queue.push(data.subarray(0, FRAME_BYTES));
      data = data.subarray(FRAME_BYTES);
    }
    src.partial = Buffer.from(data);
    if (src.queue.length > this.maxQueueFrames) src.queue.splice(0, src.queue.length - this.maxQueueFrames);
  }

  /** Mark a speaker's stream as ended; what is queued still plays out. */
  finish(id) {
    const src = this.sources.get(id);
    if (src) src.finished = true;
  }

  /** One mixed 20 ms frame, or null when nobody has audio ready. */
  mix() {
    if (this.destroyed) return null;
    let acc = null;
    for (const [id, src] of this.sources) {
      // A small head start per speaker absorbs network jitter at the start of a burst.
      if (!src.playing) {
        if (src.queue.length >= this.prebufferFrames || (src.finished && src.queue.length))
          src.playing = true;
        else {
          if (src.finished && !src.queue.length) this.sources.delete(id);
          continue;
        }
      }
      const frame = src.queue.shift();
      if (!frame) {
        src.playing = false;
        if (src.finished) this.sources.delete(id);
        continue;
      }
      acc ??= new Int32Array(FRAME_BYTES / 2);
      for (let i = 0; i < acc.length; i += 1) acc[i] += frame.readInt16LE(i * 2);
    }
    if (!acc) return null;
    const out = Buffer.allocUnsafe(FRAME_BYTES);
    for (let i = 0; i < acc.length; i += 1) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, acc[i])), i * 2);
    }
    return out;
  }

  destroy() {
    this.destroyed = true;
    this.sources.clear();
  }
}

export class MixerPlayback {
  /**
   * @param {{ mixer: PcmMixer, player: any, createResource: Function, rawType: any,
   *   hangoverFrames?: number, autostart?: boolean }} opts
   */
  constructor({ mixer, player, createResource, rawType, hangoverFrames = 15, autostart = true }) {
    this.mixer = mixer;
    this.player = player;
    this.createResource = createResource;
    this.rawType = rawType;
    this.hangoverFrames = hangoverFrames; // 300 ms of pause before the stream is closed
    this.stream = null;
    this.quiet = 0;
    this.opened = 0; // streams opened so far (for tests and diagnostics)
    this.destroyed = false;
    this.timer = autostart ? setInterval(() => this.tick(), FRAME_MS) : null;
    this.timer?.unref();
  }

  tick() {
    if (this.destroyed) return;
    const frame = this.mixer.mix();
    if (frame) {
      this.quiet = 0;
      this.push(frame);
      return;
    }
    if (!this.stream) return; // nobody talking, nothing playing: stay idle
    this.quiet += 1;
    if (this.quiet > this.hangoverFrames) this.close();
    else this.push(SILENCE); // keep the player fed through a short pause
  }

  push(buf) {
    if (!this.stream || this.stream.destroyed) this.open();
    this.stream.push(buf);
  }

  open() {
    const stream = new Readable({ read() {} });
    stream.on('error', () => {});
    this.stream = stream;
    this.opened += 1;
    this.player.play(this.createResource(stream, { inputType: this.rawType }));
  }

  /** End the current stream; the player drains it and goes idle. */
  close() {
    this.stream?.push(null);
    this.stream = null;
    this.quiet = 0;
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    this.stream?.destroy();
    this.stream = null;
    this.mixer.destroy();
  }
}
