// Web Worker for js/audio-transcode.js: FFmpeg (WebAssembly) converting a raw audio stream to AAC in ADTS.
//
// The decoder (@ffmpeg/core, ~112 KB of JavaScript and a ~32 MB .wasm) comes from a CDN. jsDelivr refuses files this
// large, so unpkg is tried first. Whatever comes back is checked to really be WebAssembly (an error page is not), and
// it is kept in the browser's Cache Storage so later sessions do not download it again.
/* global createFFmpegCore */
const BASES = ['https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/', 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/'];
let core = null;
const say = (text) => postMessage({ type: 'log', text });

async function fetchCached(url) {
  let cache = null;
  try { cache = await caches.open('tuner-decoder-v1'); } catch { /* no Cache Storage here */ }
  const hit = cache && await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (cache) { try { await cache.put(url, res.clone()); } catch { /* quota: fine, it just will not be kept */ } }
  return res;
}

async function load() {
  const errors = [];
  for (const base of BASES) {
    const host = new URL(base).host;
    try {
      say(`audio decoder: loading from ${host}`);
      const js = await (await fetchCached(`${base}ffmpeg-core.js`)).text();
      const wasm = new Uint8Array(await (await fetchCached(`${base}ffmpeg-core.wasm`)).arrayBuffer());
      if (wasm.length < 1e6 || wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
        throw new Error(`not a WebAssembly file (${wasm.length} bytes, starts “${String.fromCharCode(...wasm.slice(0, 12)).replace(/[^\x20-\x7e]/g, '?')}”)`);
      }
      importScripts(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
      core = await createFFmpegCore({ wasmBinary: wasm, locateFile: (p) => p, print: () => {}, printErr: () => {} });
      say(`audio decoder: ready (${(wasm.length / 1048576).toFixed(0)} MB from ${host})`);
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
