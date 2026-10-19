// Stream diagnostics: fetches the first bytes of a stream URL and reports what came back.
// That covers who answered (proxy/provider), the HTTP status, and what the bytes are
// (MPEG-TS with codecs, an HLS playlist, an HTML error page…). It also says whether this
// browser can decode those codecs.

const TS_STREAM_TYPES = {
  0x01: 'MPEG-1 video', 0x02: 'MPEG-2 video', 0x03: 'MP3 audio', 0x04: 'MP3 audio', 0x0f: 'AAC audio',
  0x11: 'AAC-LATM audio', 0x1b: 'H.264 video', 0x24: 'HEVC/H.265 video', 0x81: 'AC-3 audio', 0x87: 'E-AC-3 audio',
  0x06: 'private data (AC-3/subtitles)', 0x15: 'ID3 metadata',
};

// Codec families browsers can't decode through MSE in most cases.
const UNPLAYABLE = {
  'MPEG-2 video': 'Browsers can’t decode MPEG-2 video.',
  'MPEG-1 video': 'Browsers can’t decode MPEG-1 video.',
  'AC-3 audio': canPlay('audio/mp4; codecs="ac-3"') ? null : 'This browser can’t decode AC-3 audio (video may play silently or not at all).',
  'E-AC-3 audio': canPlay('audio/mp4; codecs="ec-3"') ? null : 'This browser can’t decode E-AC-3 audio.',
  'HEVC/H.265 video': canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"') ? null : 'This browser can’t decode HEVC/H.265 video.',
};

function canPlay(type) {
  try { return !!window.MediaSource?.isTypeSupported(type); } catch { return false; }
}

export async function probe(src, { timeoutMs = 8000, maxBytes = 64 * 1024 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const out = { src };
  try {
    const res = await fetch(src, { signal: ac.signal, cache: 'no-store' });
    out.status = res.status;
    out.type = res.headers.get('content-type') || '';
    out.proxyKind = res.headers.get('x-proxy-kind');
    out.proxyError = res.headers.get('x-proxy-error');
    out.upstream = res.headers.get('x-proxy-upstream');
    out.finalUrl = res.headers.get('x-final-url') || res.url;

    // Read just the start: live TS never ends.
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader && size < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader?.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
    out.bytes = size;
    out.content = sniff(bytes);
  } catch (err) {
    out.error = ac.signal.aborted ? `no data within ${timeoutMs / 1000}s` : 'request blocked or failed (CORS, mixed content or network)';
  } finally {
    clearTimeout(timer);
  }
  return out;
}

function sniff(b) {
  if (!b.length) return { kind: 'empty' };
  const tsStart = findTsSync(b);
  if (tsStart >= 0) {
    const streams = tsStreams(b, tsStart);
    const problems = streams.map((s) => UNPLAYABLE[s]).filter(Boolean);
    return { kind: 'MPEG-TS', streams, problems };
  }
  const text = new TextDecoder().decode(b.subarray(0, 4096));
  if (text.trimStart().startsWith('#EXTM3U')) {
    const codecs = [...text.matchAll(/CODECS="([^"]+)"/g)].map((m) => m[1]);
    const problems = [];
    if (codecs.some((c) => /hvc1|hev1/.test(c)) && UNPLAYABLE['HEVC/H.265 video']) problems.push(UNPLAYABLE['HEVC/H.265 video']);
    if (codecs.some((c) => /ac-3|ec-3/.test(c)) && UNPLAYABLE['AC-3 audio']) problems.push(UNPLAYABLE['AC-3 audio']);
    return { kind: text.includes('#EXT-X-STREAM-INF') ? 'HLS master playlist' : 'HLS playlist', codecs, problems };
  }
  if (/^\s*</.test(text)) {
    const msg = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return { kind: 'HTML page (not video)', message: msg };
  }
  if (/^\s*[{[]/.test(text)) return { kind: 'JSON (not video)', message: text.slice(0, 160) };
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return { kind: 'MP4' };
  if (b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56) return { kind: 'FLV' };
  if (/^[\x09\x0a\x0d\x20-\x7e]{8,}/.test(text)) return { kind: 'text (not video)', message: text.slice(0, 160) };
  return { kind: 'unrecognised binary' };
}

function findTsSync(b) {
  for (let i = 0; i < Math.min(188, b.length - 376); i++) {
    if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return i;
  }
  return -1;
}

// Reads the PAT and PMT to list elementary stream types.
function tsStreams(b, start) {
  let pmtPid = -1;
  for (let p = start; p + 188 <= b.length; p += 188) {
    if (b[p] !== 0x47) break;
    const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
    const pusi = b[p + 1] & 0x40;
    const afc = (b[p + 3] >> 4) & 3;
    if (!pusi || !(afc & 1)) continue;
    let o = p + 4 + (afc & 2 ? 1 + b[p + 4] : 0);
    o += 1 + b[o]; // pointer field
    const sectionLength = ((b[o + 1] & 0x0f) << 8) | b[o + 2];
    const end = Math.min(o + 3 + sectionLength - 4, p + 188);
    if (pid === 0 && b[o] === 0x00) {
      for (let i = o + 8; i + 4 <= end; i += 4) {
        const program = (b[i] << 8) | b[i + 1];
        if (program !== 0) { pmtPid = ((b[i + 2] & 0x1f) << 8) | b[i + 3]; break; }
      }
    } else if (pid === pmtPid && b[o] === 0x02) {
      const programInfoLength = ((b[o + 10] & 0x0f) << 8) | b[o + 11];
      const streams = [];
      for (let i = o + 12 + programInfoLength; i + 5 <= end;) {
        const type = b[i];
        streams.push(TS_STREAM_TYPES[type] || `stream type 0x${type.toString(16)}`);
        i += 5 + (((b[i + 3] & 0x0f) << 8) | b[i + 4]);
      }
      return streams;
    }
  }
  return [];
}

// One readable line per probe.
export function describeProbe(p) {
  const via = p.proxyKind ? `via ${p.proxyKind} proxy` : 'direct';
  if (p.error) return `${via}: ${p.error}`;
  const parts = [`${via}: HTTP ${p.status}`];
  if (p.proxyError) parts.push(`proxy error “${p.proxyError}”`);
  if (p.upstream && p.upstream !== String(p.status)) parts.push(`provider answered ${p.upstream}`);
  if (p.type) parts.push(p.type);
  if (p.content) {
    let c = p.content.kind;
    if (p.content.streams?.length) c += ` [${p.content.streams.join(', ')}]`;
    if (p.content.codecs?.length) c += ` [${p.content.codecs.join(' | ')}]`;
    parts.push(c);
    if (p.content.message) parts.push(`“${p.content.message}”`);
    for (const problem of p.content.problems || []) parts.push(`⚠ ${problem}`);
  }
  if (p.finalUrl && p.finalUrl !== p.src) parts.push(`→ ${p.finalUrl}`);
  return parts.join(' · ');
}
