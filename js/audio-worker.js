// Web Worker for js/audio-transcode.js: FFmpeg (WebAssembly) converting a raw audio stream to AAC in ADTS.
//
// The decoder (@ffmpeg/core 0.12.10: ~112 KB of JavaScript and a ~32 MB .wasm) ships with the app, in /decoder/, so
// it comes from the same place as the rest of the TV app (the .wasm is in four parts because a single file that big
// is over Cloudflare's per-file limit). Each part is kept in the browser's Cache Storage, so after the first time
// nothing is downloaded at all. If the app's own copy cannot be had, unpkg and jsDelivr are tried as a fallback.
// Whatever comes back is checked to really be WebAssembly (an error page is not).
/* global createFFmpegCore */
const LOCAL = new URL('../decoder/', self.location.href).href;
const CDNS = ['https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/', 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/'];
const PARTS = 4;
let core = null;
const say = (text) => postMessage({ type: 'log', text });

async function fetchCached(url) {
  let cache = null;
  try { cache = await caches.open('tuner-decoder-v2'); } catch { /* no Cache Storage here */ }
  const hit = cache && await cache.match(url);
  if (hit) return { res: hit, cached: true };
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (cache) { try { await cache.put(url, res.clone()); } catch { /* quota: fine, it just will not be kept */ } }
  return { res, cached: false };
}

const join = (bufs) => { const out = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0)); let o = 0; for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; } return out; };

// → { js, wasm, cached }
async function fetchSet(base, chunked) {
  const jsR = await fetchCached(`${base}ffmpeg-core.js`);
  const js = await jsR.res.text();
  if (!chunked) { const w = await fetchCached(`${base}ffmpeg-core.wasm`); return { js, wasm: new Uint8Array(await w.res.arrayBuffer()), cached: w.cached }; }
  const parts = await Promise.all(Array.from({ length: PARTS }, async (_, i) => { const r = await fetchCached(`${base}ffmpeg-core.wasm.${i}.bin`); return { buf: await r.res.arrayBuffer(), cached: r.cached }; }));
  return { js, wasm: join(parts.map((p) => p.buf)), cached: parts.every((p) => p.cached) };
}

async function load() {
  try { await navigator.storage?.persist?.(); } catch { /* best effort: keeps the saved decoder from being evicted */ }
  const errors = [];
  for (const [base, chunked] of [[LOCAL, true], ...CDNS.map((c) => [c, false])]) {
    const host = new URL(base).host;
    try {
      say(`audio decoder: loading from ${host}`);
      const { js, wasm, cached } = await fetchSet(base, chunked);
      if (wasm.length < 1e6 || wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
        throw new Error(`not a WebAssembly file (${wasm.length} bytes, starts “${String.fromCharCode(...wasm.slice(0, 12)).replace(/[^\x20-\x7e]/g, '?')}”)`);
      }
      importScripts(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
      core = await createFFmpegCore({ wasmBinary: wasm, locateFile: (p) => p, print: () => {}, printErr: () => {} });
      say(`audio decoder: ready (${(wasm.length / 1048576).toFixed(0)} MB, ${cached ? 'saved on this device' : `downloaded from ${host}`})`);
      return;
    } catch (err) {
      errors.push(`${host}: ${err.message}`);
    }
  }
  throw new Error(`decoder download failed (${errors.join('; ')})`);
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await load();
      postMessage({ id: m.id, out: null });
      return;
    }
    if (m.type === 'convert') {
      core.FS.writeFile('in.bin', new Uint8Array(m.data));
      const filter = `aresample=${48000}${m.startSample > 0 ? `,atrim=start_sample=${m.startSample}` : ''}`;
      core.exec('-f', m.fmt, '-i', 'in.bin', '-vn', '-af', filter, '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', 'out.aac');
      core.reset();
      let out = null;
      try { out = core.FS.readFile('out.aac'); } catch { /* nothing produced */ }
      for (const f of ['in.bin', 'out.aac']) { try { core.FS.unlink(f); } catch { /* not there */ } }
      postMessage({ id: m.id, out: out ? out.buffer : null }, out ? [out.buffer] : []);
    }
  } catch (err) {
    postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};
