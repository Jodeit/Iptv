// Matroska demuxer: reads the header (tracks, info, seek index) and then one cluster at a
// time from a ByteReader, turning blocks into frames with absolute timestamps.

import { UNKNOWN, children, decodeVint, uint, float, str, concat } from './ebml.js';

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383, Language: 0x22b59c, LanguageBCP47: 0x22b59d, Name: 0x536e, FlagDefault: 0x88, FlagForced: 0x55aa,
  FlagEnabled: 0xb9,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, DisplayWidth: 0x54b0, DisplayHeight: 0x54ba,
  Audio: 0xe1, SamplingFrequency: 0xb5, OutputSamplingFrequency: 0x78b5, Channels: 0x9f,
  ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469,
};
export { ID };

// Top-level children of Segment: in a cluster of unknown size, any of these ends it.
const TOP_LEVEL = new Set([ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments, ID.SeekHead, ID.Info, ID.Tracks]);
const TYPE = { 1: 'video', 2: 'audio', 0x11: 'subtitle' };

export class MatroskaDemuxer {
  constructor() {
    this.timecodeScale = 1e6; // ns per timestamp unit
    this.duration = 0; // seconds
    this.tracks = [];
    this.cues = []; // [{ time (s), pos (offset from segment data start) }]
    this.seek = {}; // element ID → position (offset from segment data start)
    this.segmentStart = 0;
    this.pending = null; // a cluster header already consumed
  }

  // Reads everything before the first cluster. The reader must start at file offset 0.
  async readHeader(r) {
    const ebml = await r.header();
    if (!ebml || ebml.id !== ID.EBML) throw new Error('not a Matroska file');
    await r.skip(ebml.size);
    const seg = await r.header();
    if (!seg || seg.id !== ID.Segment) throw new Error('no Matroska segment');
    this.segmentStart = r.pos;
    for (;;) {
      const h = await r.header();
      if (!h) throw new Error('no clusters in file');
      if (h.id === ID.Cluster) { this.pending = h; break; }
      if (h.size === UNKNOWN) throw new Error('unsupported element of unknown size');
      if (h.id === ID.SeekHead) this.parseSeekHead(await r.read(h.size));
      else if (h.id === ID.Info) this.parseInfo(await r.read(h.size));
      else if (h.id === ID.Tracks) this.parseTracks(await r.read(h.size));
      else if (h.id === ID.Cues) this.parseCues(await r.read(h.size));
      else await r.skip(h.size); // attachments (fonts), tags, chapters, void…
    }
    if (!this.tracks.length) throw new Error('no tracks found');
    this.firstClusterPos = this.pending.start - this.segmentStart;
  }

  parseSeekHead(b) {
    for (const s of children(b)) {
      if (s.id !== ID.Seek) continue;
      let id = 0;
      let pos = 0;
      for (const c of children(s.data)) {
        if (c.id === ID.SeekID) id = uint(c.data);
        else if (c.id === ID.SeekPosition) pos = uint(c.data);
      }
      if (id) this.seek[id] = pos;
    }
  }

  parseInfo(b) {
    let dur = 0;
    for (const c of children(b)) {
      if (c.id === ID.TimecodeScale) this.timecodeScale = uint(c.data);
      else if (c.id === ID.Duration) dur = float(c.data);
    }
    this.duration = (dur * this.timecodeScale) / 1e9;
  }

  parseTracks(b) {
    for (const e of children(b)) {
      if (e.id !== ID.TrackEntry) continue;
      const t = { number: 0, type: '', codec: '', priv: null, defaultDuration: 0, language: 'eng', name: '', isDefault: true, forced: false, enabled: true, strip: null };
      for (const c of children(e.data)) {
        switch (c.id) {
          case ID.TrackNumber: t.number = uint(c.data); break;
          case ID.TrackType: t.type = TYPE[uint(c.data)] || 'other'; break;
          case ID.CodecID: t.codec = str(c.data); break;
          case ID.CodecPrivate: t.priv = c.data.slice(); break;
          case ID.DefaultDuration: t.defaultDuration = uint(c.data); break; // ns
          case ID.Language: t.language = str(c.data); break;
          case ID.LanguageBCP47: t.language = str(c.data); break;
          case ID.Name: t.name = str(c.data); break;
          case ID.FlagDefault: t.isDefault = uint(c.data) === 1; break;
          case ID.FlagForced: t.forced = uint(c.data) === 1; break;
          case ID.FlagEnabled: t.enabled = uint(c.data) === 1; break;
          case ID.Video:
            for (const v of children(c.data)) {
              if (v.id === ID.PixelWidth) t.width = uint(v.data);
              else if (v.id === ID.PixelHeight) t.height = uint(v.data);
              else if (v.id === ID.DisplayWidth) t.displayWidth = uint(v.data);
              else if (v.id === ID.DisplayHeight) t.displayHeight = uint(v.data);
            }
            break;
          case ID.Audio:
            for (const a of children(c.data)) {
              if (a.id === ID.SamplingFrequency) t.sampleRate = Math.round(float(a.data));
              else if (a.id === ID.OutputSamplingFrequency) t.outputSampleRate = Math.round(float(a.data));
              else if (a.id === ID.Channels) t.channels = uint(a.data);
            }
            break;
          case ID.ContentEncodings:
            // Header stripping: bytes removed from every frame, to be put back.
            for (const enc of children(c.data)) {
              for (const comp of enc.id === ID.ContentEncoding ? children(enc.data) : []) {
                if (comp.id !== ID.ContentCompression) continue;
                let algo = 0;
                let settings = null;
                for (const x of children(comp.data)) {
                  if (x.id === ID.ContentCompAlgo) algo = uint(x.data);
                  else if (x.id === ID.ContentCompSettings) settings = x.data.slice();
                }
                if (algo === 3 && settings) t.strip = settings;
                else t.unsupportedCompression = true;
              }
            }
            break;
          default:
        }
      }
      if (t.number) this.tracks.push(t);
    }
  }

  parseCues(b) {
    const cues = [];
    for (const p of children(b)) {
      if (p.id !== ID.CuePoint) continue;
      let time = 0;
      let pos = -1;
      for (const c of children(p.data)) {
        if (c.id === ID.CueTime) time = uint(c.data);
        else if (c.id === ID.CueTrackPositions && pos < 0) {
          for (const x of children(c.data)) if (x.id === ID.CueClusterPosition) pos = uint(x.data);
        }
      }
      if (pos >= 0) cues.push({ time: (time * this.timecodeScale) / 1e9, pos });
    }
    cues.sort((a, b2) => a.time - b2.time);
    this.cues = cues;
  }

  // Cluster position (from segment start) to start reading from for time t (seconds).
  cueFor(t) {
    let best = null;
    for (const c of this.cues) { if (c.time <= t) best = c; else break; }
    return best;
  }

  // Next cluster as { time (s), blocks: [{ track, pts (s), key, duration (s|null), frames }] },
  // or null at the end of the file. Non-cluster elements in between are skipped.
  async readCluster(r) {
    let h = this.pending;
    this.pending = null;
    while (!h || h.id !== ID.Cluster) {
      if (h) {
        if (h.size === UNKNOWN) return null;
        await r.skip(h.size);
      }
      h = await r.header();
      if (!h) return null;
    }
    const end = h.size === UNKNOWN ? Infinity : r.pos + h.size;
    let clusterTime = 0;
    const blocks = [];
    while (r.pos < end) {
      if (h.size === UNKNOWN) {
        const next = await r.peekId();
        if (next === null || TOP_LEVEL.has(next)) break;
      } else if (!await r.fill(1)) break;
      const c = await r.header();
      if (!c) break;
      if (c.id === ID.Timecode) clusterTime = uint(await r.read(c.size));
      else if (c.id === ID.SimpleBlock) {
        const b = this.parseBlock(await r.read(c.size), clusterTime, true);
        if (b) blocks.push(b);
      } else if (c.id === ID.BlockGroup) {
        const g = await r.read(c.size);
        let block = null;
        let duration = null;
        let hasRef = false;
        for (const x of children(g)) {
          if (x.id === ID.Block) block = x.data;
          else if (x.id === ID.BlockDuration) duration = uint(x.data);
          else if (x.id === ID.ReferenceBlock) hasRef = true;
        }
        if (block) {
          const b = this.parseBlock(block, clusterTime, false);
          if (b) {
            b.key = !hasRef;
            if (duration !== null) b.duration = (duration * this.timecodeScale) / 1e9;
            blocks.push(b);
          }
        }
      } else if (c.size === UNKNOWN) {
        break;
      } else {
        await r.skip(c.size);
      }
    }
    return { time: (clusterTime * this.timecodeScale) / 1e9, blocks };
  }

  parseBlock(b, clusterTime, simple) {
    const tn = decodeVint(b, 0);
    let o = tn.length;
    const track = this.tracks.find((t) => t.number === tn.value);
    if (!track) return null;
    const rel = (b[o] << 24 >> 16) | b[o + 1]; // signed 16-bit
    const flags = b[o + 2];
    o += 3;
    const frames = lace(b, o, (flags >> 1) & 3).map((f) => (track.strip ? concat([track.strip, f]) : f));
    return {
      track,
      pts: ((clusterTime + rel) * this.timecodeScale) / 1e9,
      key: simple ? !!(flags & 0x80) : true,
      duration: null,
      frames,
    };
  }
}

// Splits a block's payload into frames according to its lacing mode
// (0 none, 1 Xiph, 2 fixed-size, 3 EBML).
function lace(b, o, mode) {
  if (mode === 0) return [b.subarray(o)];
  const count = b[o++] + 1;
  const sizes = [];
  if (mode === 1) {
    for (let i = 0; i < count - 1; i++) {
      let s = 0;
      let x;
      do { x = b[o++]; s += x; } while (x === 255);
      sizes.push(s);
    }
  } else if (mode === 3) {
    let v = decodeVint(b, o);
    o += v.length;
    sizes.push(v.value);
    for (let i = 1; i < count - 1; i++) {
      v = decodeVint(b, o);
      o += v.length;
      const bias = 2 ** (7 * v.length - 1) - 1; // signed difference from the previous size
      sizes.push(sizes[i - 1] + (v.value - bias));
    }
  } else {
    const each = (b.length - o) / count;
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((n, s) => n + s, 0);
  sizes.push(b.length - o - used);
  const frames = [];
  for (const s of sizes) { frames.push(b.subarray(o, o + s)); o += s; }
  return frames;
}
