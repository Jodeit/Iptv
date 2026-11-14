// Web Worker for js/audio-transcode.js: FFmpeg (WebAssembly) converting a raw audio stream to AAC in ADTS.
/* global createFFmpegCore */
let core = null;

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      importScripts(m.core);
      const base = m.core.replace(/[^/]*$/, '');
      core = await createFFmpegCore({
        locateFile: (p) => (p.endsWith('.wasm') ? m.wasm : base + p),
        print: () => {}, printErr: () => {},
      });
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
    postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
