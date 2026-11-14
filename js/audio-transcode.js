// Turns audio this browser cannot decode (E-AC-3, AC-3, DTS, TrueHD) into AAC it can, for the MKV remuxer.
//
// The decoding is FFmpeg compiled to WebAssembly (@ffmpeg/core, about 32 MB), loaded from a CDN in a Web Worker
// the first time it is needed and cached by the browser after that. Each call converts a few seconds of audio:
// the frames go into the worker as a raw elementary stream, come back as ADTS-framed AAC, and are cut into
// access units for the MP4 muxer. Two frames of the previous chunk go in first ("preroll") and are trimmed off
// afterwards, so the codec's overlap/priming does not leave a click at every chunk boundary.

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
const RATE = 48000;
const FORMAT = { A_AC3: 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', A_TRUEHD: 'truehd', A_MLP: 'truehd' };
export const CAN_TRANSCODE = new Set(Object.keys(FORMAT));
export const CODEC_LABEL = { A_AC3: 'AC-3', A_EAC3: 'E-AC-3', A_DTS: 'DTS', A_TRUEHD: 'TrueHD', A_MLP: 'TrueHD' };

// The real engine: FFmpeg in a worker. Tests can put their own at window.__tunerAudioEngine.
class WorkerEngine {
  constructor(onLog) {
    this.onLog = onLog;
    this.pending = new Map();
    this.next = 1;
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this.worker = new Worker(new URL('./audio-worker.js', import.meta.url));
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'log') { this.onLog?.(m.text); return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.out ? new Uint8Array(m.out) : null);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'audio decoder worker failed'));
      this.call({ type: 'init', core: `${CORE}ffmpeg-core.js`, wasm: `${CORE}ffmpeg-core.wasm` }).then(resolve, reject);
    });
    return this.ready;
  }

  call(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async convert({ fmt, data, startSample }) {
    await this.start();
    return this.call({ type: 'convert', fmt, data: data.buffer, startSample }, [data.buffer]);
  }

  destroy() { this.worker?.terminate(); this.ready = null; }
}

// ADTS stream → raw AAC access units
export function splitAdts(bytes) {
  const out = [];
  for (let i = 0; i + 7 <= bytes.length;) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
    const len = ((bytes[i + 3] & 3) << 11) | (bytes[i + 4] << 3) | (bytes[i + 5] >> 5);
    const header = bytes[i + 1] & 1 ? 7 : 9; // protection_absent = 1 → no CRC
    if (len < header || i + len > bytes.length) break;
    out.push(bytes.slice(i + header, i + len));
    i += len;
  }
  return out;
}

export class AudioTranscoder {
  constructor({ onLog = () => {}, engine } = {}) {
    this.engine = engine || (typeof window !== 'undefined' && window.__tunerAudioEngine) || new WorkerEngine(onLog);
    this.onLog = onLog;
    this.tail = null; // the last two blocks of the previous chunk
    this.chunks = 0;
    this.ms = 0;
  }

  // After a seek the next chunk does not follow the last one.
  reset() { this.tail = null; }

  // blocks: Matroska blocks of one audio track { pts, frames: Uint8Array[] }, in order.
  // → { aus: Uint8Array[] (AAC access units, 1024 samples each at 48 kHz), start: seconds } or null
  async convert(codecId, blocks) {
    const fmt = FORMAT[codecId];
    if (!fmt || !blocks.length) return null;
    const t0 = blocks[0].pts;
    const pre = this.tail && this.tail.pts < t0 && t0 - this.tail.pts < 1 ? this.tail : null;
    const frames = [...(pre ? pre.frames : []), ...blocks.flatMap((b) => b.frames)];
    let size = 0;
    for (const f of frames) size += f.length;
    const data = new Uint8Array(size);
    let o = 0;
    for (const f of frames) { data.set(f, o); o += f.length; }
    const startSample = pre ? Math.round((t0 - pre.pts) * RATE) : 0;
    const began = performance.now();
    const adts = await this.engine.convert({ fmt, data, startSample });
    this.chunks++;
    this.ms += performance.now() - began;
    const last = blocks.slice(-2);
    this.tail = { pts: last[0].pts, frames: last.flatMap((b) => b.frames) };
    if (!adts) return null;
    const aus = splitAdts(adts);
    aus.shift(); // the encoder's priming frame
    return aus.length ? { aus, start: t0 } : null;
  }

  logStats() {
    if (this.chunks && this.chunks % 20 === 0) this.onLog(`audio conversion: ${this.chunks} chunks, ${(this.ms / this.chunks).toFixed(0)} ms each`);
  }

  destroy() { this.engine.destroy?.(); }
}
