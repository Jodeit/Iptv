// Fragmented MP4 writer for Media Source Extensions: one init segment per track and a
// moof+mdat fragment per batch of samples. Also maps Matroska codecs to MP4 sample entries
// and MSE codec strings.

const te = new TextEncoder();

const u8 = (...a) => new Uint8Array(a);
const u16 = (n) => u8((n >> 8) & 255, n & 255);
const u32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const s32 = (n) => u32(n >>> 0);
const u64 = (n) => { const hi = Math.floor(n / 2 ** 32); return cat([u32(hi), u32(n - hi * 2 ** 32)]); };
const zeros = (n) => new Uint8Array(n);
const ascii = (s) => te.encode(s);

function cat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...parts) {
  const body = cat(parts);
  return cat([u32(body.length + 8), ascii(type), body]);
}

const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

const MATRIX = cat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

// ---------- Codec mapping ----------

// Returns { kind, codec (MSE codec string), timescale, entry (sample entry box),
// frameDuration (ticks, fallback) } or { unsupported: reason }.
export function trackConfig(track, firstFrame) {
  const cfg = mapCodec(track, firstFrame);
  if (cfg.kind === 'video') Object.assign(cfg, { width: track.width || 0, height: track.height || 0 });
  return cfg;
}

function mapCodec(track, firstFrame) {
  const id = track.codec;
  if (track.type === 'video') {
    const w = track.width || 1920;
    const h = track.height || 1080;
    const visual = (type, ...kids) => box(type, zeros(6), u16(1), zeros(16), u16(w), u16(h),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), ...kids, pasp(track));
    const timescale = 90000;
    const frameDuration = track.defaultDuration ? Math.round((track.defaultDuration * timescale) / 1e9) : 3750;
    if (id === 'V_MPEG4/ISO/AVC') {
      const c = track.priv;
      if (!c || c.length < 4) return { unsupported: 'H.264 track without its configuration' };
      return { kind: 'video', codec: `avc1.${hex(c[1])}${hex(c[2])}${hex(c[3])}`, timescale, frameDuration, entry: visual('avc1', box('avcC', c)) };
    }
    if (id === 'V_MPEGH/ISO/HEVC') {
      const c = track.priv;
      if (!c || c.length < 23) return { unsupported: 'HEVC track without its configuration' };
      return { kind: 'video', codec: hevcCodec(c), timescale, frameDuration, entry: visual('hvc1', box('hvcC', c)) };
    }
    if (id === 'V_VP9') {
      const profile = firstFrame ? (((firstFrame[0] >> 5) & 1) | (((firstFrame[0] >> 4) & 1) << 1)) : 0;
      const vpcC = full('vpcC', 1, 0, u8(profile, 40, (8 << 4) | (1 << 1), 1, 1, 1), u16(0));
      return { kind: 'video', codec: `vp09.0${profile}.40.08`, timescale, frameDuration, entry: visual('vp09', vpcC) };
    }
    return { unsupported: `${videoName(id)} video` };
  }

  if (track.type === 'audio') {
    const rate = track.outputSampleRate || track.sampleRate || 48000;
    const ch = track.channels || 2;
    const audio = (type, sr, ...kids) => box(type, zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0),
      u32(sr < 65536 ? sr * 65536 : 0), ...kids);
    if (id.startsWith('A_AAC')) {
      const asc = track.priv && track.priv.length >= 2 ? track.priv : aacConfig(id, track.sampleRate || rate, ch);
      const aot = asc[0] >> 3;
      return { kind: 'audio', codec: `mp4a.40.${aot}`, timescale: rate, frameDuration: aot === 5 || aot === 29 ? 2048 : 1024, entry: audio('mp4a', rate, esds(0x40, asc)) };
    }
    if (id === 'A_MPEG/L3') {
      return { kind: 'audio', codec: 'mp4a.6B', timescale: rate, frameDuration: 1152, entry: audio('mp4a', rate, esds(0x6b, null)) };
    }
    if (id === 'A_AC3') {
      const d = firstFrame && ac3Info(firstFrame);
      if (!d) return { unsupported: 'AC-3 audio (unreadable header)' };
      return { kind: 'audio', codec: 'ac-3', timescale: d.rate, frameDuration: 1536, entry: audio('ac-3', d.rate, box('dac3', d.dac3)) };
    }
    if (id === 'A_EAC3') {
      const d = firstFrame && eac3Info(firstFrame);
      if (!d) return { unsupported: 'E-AC-3 audio (unreadable header)' };
      return { kind: 'audio', codec: 'ec-3', timescale: d.rate, frameDuration: d.samples, entry: audio('ec-3', d.rate, box('dec3', d.dec3)) };
    }
    if (id === 'A_OPUS') {
      const p = track.priv;
      if (!p || p.length < 19) return { unsupported: 'Opus without its header' };
      // OpusHead (little-endian) → dOps (big-endian)
      const le16 = (o) => p[o] | (p[o + 1] << 8);
      const le32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
      const family = p[18];
      const dOps = box('dOps', u8(0, p[9]), u16(le16(10)), u32(le32(12)), u16(le16(16)), u8(family), family ? p.subarray(19, 21 + p[9]) : zeros(0));
      return { kind: 'audio', codec: 'opus', timescale: 48000, frameDuration: 960, entry: audio('Opus', 48000, dOps) };
    }
    return { unsupported: `${audioName(id)} audio` };
  }
  return { unsupported: 'not audio or video' };
}

export const videoName = (id) => ({ 'V_MPEG2': 'MPEG-2', 'V_MS/VFW/FOURCC': 'VfW (DivX/Xvid)', 'V_MPEG4/ISO/ASP': 'MPEG-4 ASP (DivX/Xvid)', V_AV1: 'AV1', V_VP8: 'VP8' }[id] || id);
export const audioName = (id) => ({ A_DTS: 'DTS', A_TRUEHD: 'TrueHD', A_FLAC: 'FLAC', A_VORBIS: 'Vorbis', 'A_PCM/INT/LIT': 'PCM', A_MPEG_L2: 'MP2', 'A_MPEG/L2': 'MP2' }[id] || id);

const hex = (n) => n.toString(16).padStart(2, '0');

function pasp(track) {
  if (!track.displayWidth || !track.displayHeight || !track.width || !track.height) return zeros(0);
  const h = track.displayWidth * track.height;
  const v = track.displayHeight * track.width;
  if (h === v) return zeros(0);
  const g = gcd(h, v);
  return box('pasp', u32(h / g), u32(v / g));
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// HEVC codec string from hvcC (ISO/IEC 14496-15 Annex E).
function hevcCodec(c) {
  const space = ['', 'A', 'B', 'C'][c[1] >> 6];
  const tier = (c[1] >> 5) & 1 ? 'H' : 'L';
  const profile = c[1] & 31;
  let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const constraints = [...c.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return `hvc1.${space}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier}${c[12]}${constraints.map((b) => `.${b.toString(16).toUpperCase()}`).join('')}`;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function aacConfig(id, rate, ch) {
  const aot = /SBR/.test(id) ? 5 : /MAIN/.test(id) ? 1 : 2;
  let idx = AAC_RATES.indexOf(rate);
  if (idx < 0) idx = 3;
  return u8((aot << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3));
}

function descriptor(tag, body) {
  const n = body.length;
  return cat([u8(tag, 0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127), body]);
}

function esds(objectType, dsi) {
  const dcd = descriptor(4, cat([u8(objectType, 0x15), u8(0, 0, 0), u32(0), u32(0), dsi ? descriptor(5, dsi) : zeros(0)]));
  const es = descriptor(3, cat([u16(1), u8(0), dcd, descriptor(6, u8(2))]));
  return full('esds', 0, 0, es);
}

// Bit reader for codec headers.
function bits(b, start = 0) {
  let pos = start * 8;
  return (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((b[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
}

function ac3Info(f) {
  if (f[0] !== 0x0b || f[1] !== 0x77) return null;
  const r = bits(f, 4);
  const fscod = r(2);
  const frmsizecod = r(6);
  const bsid = r(5);
  const bsmod = r(3);
  const acmod = r(3);
  if ((acmod & 1) && acmod !== 1) r(2);
  if (acmod & 4) r(2);
  if (acmod === 2) r(2);
  const lfeon = r(1);
  const rate = [48000, 44100, 32000][fscod];
  if (!rate) return null;
  const v = (fscod << 22) | (bsid << 17) | (bsmod << 14) | (acmod << 11) | (lfeon << 10) | ((frmsizecod >> 1) << 5);
  return { rate, dac3: u8((v >> 16) & 255, (v >> 8) & 255, v & 255) };
}

function eac3Info(f) {
  if (f[0] !== 0x0b || f[1] !== 0x77) return null;
  const r = bits(f, 2);
  r(2); r(3); // strmtyp, substreamid
  const frmsiz = r(11);
  const fscod = r(2);
  let rate;
  let blocks = 6;
  if (fscod === 3) { rate = [24000, 22050, 16000][r(2)]; } else { rate = [48000, 44100, 32000][fscod]; blocks = [1, 2, 3, 6][r(2)]; }
  const acmod = r(3);
  const lfeon = r(1);
  const bsid = r(5);
  if (!rate) return null;
  const samples = blocks * 256;
  const dataRate = Math.round(((frmsiz + 1) * 2 * 8 * rate) / samples / 1000);
  // dec3: data_rate(13) num_ind_sub(3)=0, then fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3) lfeon(1) reserved(3) num_dep_sub(4) reserved(1)
  const fs = fscod === 3 ? 3 : fscod;
  const a = (dataRate << 3) | 0;
  const b = (fs << 6) | (bsid << 1);
  const c = (0 << 7) | (0 << 4) | (acmod << 1) | lfeon;
  return { rate, samples, dec3: u8((a >> 8) & 255, a & 255, b, c, 0) };
}

// ---------- Segments ----------

export function initSegment(cfg, durationSec = 0) {
  const isVideo = cfg.kind === 'video';
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso6'), ascii('mp41'));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(durationSec * 1000)), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0), MATRIX,
    u32(isVideo ? (cfg.width || 0) * 65536 : 0), u32(isVideo ? (cfg.height || 0) * 65536 : 0));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(cfg.timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'), zeros(12), ascii(isVideo ? 'VideoHandler' : 'SoundHandler'), u8(0));
  const xmhd = isVideo ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const stbl = box('stbl', full('stsd', 0, 0, u32(1), cfg.entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
    full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, stbl)));
  const mvex = box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return cat([ftyp, box('moov', mvhd, trak, mvex)]);
}

// samples: [{ dts, cto, duration, data, key }] in decode order, times in track ticks.
export function fragment(seq, samples) {
  const n = samples.length;
  const trunSize = 12 + 8 + 16 * n;
  const moofSize = 8 + 16 + 8 + 16 + 20 + trunSize;
  const entries = [];
  let total = 0;
  for (const s of samples) {
    entries.push(u32(s.duration), u32(s.data.length), u32(s.key ? 0x02000000 : 0x01010000), s32(s.cto));
    total += s.data.length;
  }
  const trun = full('trun', 1, 0x000f01, u32(n), u32(moofSize + 8), ...entries);
  const traf = box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u64(samples[0].dts)), trun);
  const moof = box('moof', full('mfhd', 0, 0, u32(seq)), traf);
  const mdat = new Uint8Array(8 + total);
  new DataView(mdat.buffer).setUint32(0, 8 + total);
  mdat.set(ascii('mdat'), 4);
  let o = 8;
  for (const s of samples) { mdat.set(s.data, o); o += s.data.length; }
  return cat([moof, mdat]);
}
