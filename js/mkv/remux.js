// Turns Matroska clusters into fragmented-MP4 segments (one stream per SourceBuffer) and
// subtitle cues. No DOM here, so it can be tested outside the browser.

import { trackConfig, initSegment, fragment, videoName, audioName } from './mp4.js';

const TEXT_SUBS = /^S_TEXT\/(UTF8|ASS|SSA|WEBVTT)$/;

export class Remuxer {
  // canPlay(kind, codec) → bool (MediaSource.isTypeSupported in the browser).
  constructor(demux, { canPlay = () => true } = {}) {
    this.demux = demux;
    this.canPlay = canPlay;
    this.seq = 1;
    this.reset();
  }

  // After a seek: timestamps continue from wherever the new position is.
  reset() {
    this.last = { video: -Infinity, audio: -Infinity };
  }

  // Picks the tracks to play, using the first clusters to read codec details that MKV
  // doesn't store in the header (AC-3/E-AC-3 parameters, VP9 profile).
  setup(firstClusters) {
    const firstFrame = new Map();
    for (const c of firstClusters) for (const b of c.blocks) if (!firstFrame.has(b.track)) firstFrame.set(b.track, b.frames[0]);
    const warnings = [];
    const tracks = this.demux.tracks.filter((t) => t.enabled);

    const playable = (t) => {
      if (t.unsupportedCompression) return { unsupported: 'compressed track' };
      const cfg = trackConfig(t, firstFrame.get(t));
      if (cfg.unsupported) return cfg;
      if (!this.canPlay(cfg.kind, cfg.codec)) return { unsupported: `${cfg.codec} (not supported by this browser)` };
      return cfg;
    };

    const videos = tracks.filter((t) => t.type === 'video');
    let video = null;
    for (const t of videos) {
      const cfg = playable(t);
      if (!cfg.unsupported) { video = { track: t, cfg }; break; }
      if (!video) this.videoProblem = cfg.unsupported;
    }
    if (!video && videos.length) throw new Error(`MKV video is ${this.videoProblem || videoName(videos[0].codec)}, which this browser can’t play`);

    // Audio: the default track if it plays, else English, else the first that plays.
    const audios = tracks.filter((t) => t.type === 'audio');
    const scored = audios.map((t, i) => ({ t, cfg: playable(t), score: (t.isDefault ? 4 : 0) + (/^en/i.test(t.language) ? 2 : 0) - i / 100 }));
    const ok = scored.filter((x) => !x.cfg.unsupported).sort((a, b) => b.score - a.score);
    let audio = ok.length ? { track: ok[0].t, cfg: ok[0].cfg } : null;
    if (!audio && audios.length) {
      warnings.push(`The audio (${audioName(audios[0].codec)}) can’t play in a browser, so this plays without sound. Use VLC or Infuse for sound.`);
    } else if (audio && scored.some((x) => x.cfg.unsupported && x.t.isDefault && x.t !== audio.track)) {
      warnings.push(`Playing the ${audio.track.language || 'other'} audio track; the default one (${audioName(scored.find((x) => x.t.isDefault).t.codec)}) can’t play in a browser.`);
    }
    if (!video && !audio) throw new Error('No playable video or audio in this MKV file');

    const subs = tracks.filter((t) => t.type === 'subtitle' && TEXT_SUBS.test(t.codec));
    this.sel = { video, audio, subs };

    // B-frames: MKV only stores presentation times, so decode times come from sorting them.
    // A frame can then decode later than it displays; to keep every composition offset
    // positive, the whole timeline (video, audio, subtitles) starts later by the reordering
    // depth, usually a frame or two.
    this.shift = 0;
    if (video) {
      for (const c of firstClusters) {
        const p = c.blocks.filter((b) => b.track === video.track).map((b) => Math.round(b.pts * video.cfg.timescale));
        const sorted = [...p].sort((x, y) => x - y);
        for (let i = 0; i < p.length; i++) this.shift = Math.max(this.shift, sorted[i] - p[i]);
      }
    }
    this.shiftSec = video ? this.shift / video.cfg.timescale : 0;
    this.subSet = new Set(subs);
    return {
      video, audio, subs, warnings,
      init: {
        video: video && initSegment(video.cfg, this.demux.duration),
        audio: audio && initSegment(audio.cfg, this.demux.duration),
      },
    };
  }

  // → { video: Uint8Array|null, audio: Uint8Array|null, cues: [{ track, start, end, text }] }
  process(cluster) {
    const { video, audio } = this.sel;
    const v = [];
    const a = [];
    const cues = [];
    for (const b of cluster.blocks) {
      if (video && b.track === video.track) v.push(b);
      else if (audio && b.track === audio.track) a.push(b);
      else if (this.subSet.has(b.track)) {
        const text = subtitleText(b.track.codec, new TextDecoder().decode(b.frames[0]));
        if (text) cues.push({ track: b.track, start: b.pts + this.shiftSec, end: b.pts + this.shiftSec + (b.duration || 4), text });
      }
    }
    return {
      video: video && v.length ? this.videoFragment(v, video.cfg) : null,
      audio: audio && a.length ? this.audioFragment(a, audio.cfg, audio.track) : null,
      cues,
    };
  }

  // Blocks arrive in decode order with presentation times. Decode times are the sorted
  // presentation times; the difference becomes a (signed) composition offset.
  videoFragment(blocks, cfg) {
    const ts = cfg.timescale;
    const pts = blocks.map((b) => Math.round(b.pts * ts) + this.shift);
    const dts = pts.map((p) => p - this.shift).sort((x, y) => x - y);
    if (dts[0] <= this.last.video) { const shift = this.last.video + 1 - dts[0]; for (let i = 0; i < dts.length; i++) dts[i] += shift; }
    const samples = blocks.map((b, i) => ({
      dts: dts[i],
      cto: Math.max(0, pts[i] - dts[i]), // only negative if reordering deepens later in the file
      duration: i + 1 < dts.length ? dts[i + 1] - dts[i] : cfg.frameDuration,
      data: b.frames.length === 1 ? b.frames[0] : joinFrames(b.frames),
      key: b.key,
    }));
    this.last.video = dts[dts.length - 1];
    return fragment(this.seq++, samples);
  }

  audioFragment(blocks, cfg, track) {
    const ts = cfg.timescale;
    const frameTicks = track.defaultDuration ? Math.round((track.defaultDuration * ts) / 1e9) : cfg.frameDuration;
    const samples = [];
    for (const b of blocks) {
      const start = Math.round((b.pts + this.shiftSec) * ts);
      b.frames.forEach((f, k) => samples.push({ dts: start + k * frameTicks, cto: 0, duration: 0, data: f, key: true }));
    }
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].dts <= this.last.audio) samples[i].dts = this.last.audio + 1;
      this.last.audio = samples[i].dts;
    }
    for (let i = 0; i < samples.length; i++) {
      samples[i].duration = i + 1 < samples.length ? Math.max(1, samples[i + 1].dts - samples[i].dts) : frameTicks;
    }
    return fragment(this.seq++, samples);
  }
}

function joinFrames(frames) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

// SRT-style text as-is; ASS/SSA blocks carry "ReadOrder,Layer,Style,Name,MarginL,MarginR,
// MarginV,Effect,Text": keep the text, drop override tags like {\i1}.
export function subtitleText(codec, raw) {
  let t = raw;
  if (/ASS|SSA/.test(codec)) {
    const parts = raw.split(',');
    t = parts.length > 8 ? parts.slice(8).join(',') : raw;
    t = t.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
  } else {
    t = t.replace(/<\/?(font|b|i|u)[^>]*>/gi, (m) => (/^<\/?[biu]>$/i.test(m) ? m : ''));
  }
  return t.trim();
}
