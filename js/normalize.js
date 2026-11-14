// Channel tidying, done once when a playlist comes in (and saved with it), so nothing has to be worked out
// again while browsing:
//   clean   the name without provider decoration ("US: ABC KVUE AUSTIN TX HD ####" → "ABC KVUE AUSTIN TX")
//   net     ABC / CBS / NBC / FOX / PBS / CW / … for a local-station channel, else ''
//   market  what is left once the network is removed ("KVUE AUSTIN TX"), '' if there is none
//
// A provider typically has one "ABC" folder holding the ABC station of every city (hundreds of channels);
// with a home market set, isLocal() keeps yours and hides the rest.

import { kindOf } from './filter.js';

// The broadcast networks (and the common over-the-air sub-networks) that every city has its own station of.
const NETWORKS = ['ABC', 'CBS', 'NBC', 'FOX', 'PBS', 'CW', 'ION', 'MYNETWORKTV', 'MYNETWORK', 'MNTV', 'TELEMUNDO', 'UNIVISION', 'UNIMAS',
  'ESTRELLA', 'AZTECA', 'METV', 'ANTENNA', 'COZI', 'GRIT', 'LAFF', 'BOUNCE', 'ESCAPE', 'GETTV', 'COMET', 'CHARGE', 'HEROES', 'ION'];
// "FOX NEWS", "CBS SPORTS", "NBC UNIVERSO" are national channels, not city stations.
const NATIONAL = new Set(['NEWS', 'SPORTS', 'SPORT', 'BUSINESS', 'NOW', 'WEATHER', 'KIDS', 'FAMILY', 'MOVIES', 'MOVIE', 'DRAMA', 'SOAP', 'SOAPS',
  'COMEDY', 'ENTERTAINMENT', 'LIFE', 'DEPORTES', 'UNIVERSO', 'NATION', 'CLASSICS', 'CLASSIC', 'PLUS', 'GOLF', 'NETWORK', 'RADIO', 'MUSIC', 'DOCS', 'CRIME', 'LAW', 'REALITY']);
const QUALITY = /\b(FHD|UHD|HD|SD|4K|8K|RAW|60\s?FPS|50\s?FPS|HEVC|H\.?26[45]|LQ|HQ|BACKUP|VIP|MULTI|SUB)\b/gi;

// Some well-known home markets, so "Austin" also finds stations listed only by call sign.
// Edit freely: anything typed in the setting is matched as written.
export const MARKET_ALIASES = {
  AUSTIN: ['KVUE', 'KXAN', 'KEYE', 'KTBC', 'KLRU', 'KNVA', 'KAKW'],
};

// Used when no home market has been typed in. Switch it off with "only local stations" in the content filter.
export const DEFAULT_MARKET = 'Austin';

const tokens = (s) => String(s).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

export function cleanName(raw, group = '') {
  let n = String(raw || '').replace(/[#*=_~]{2,}/g, ' ');
  // Leading "US:", "AM |", "USA -" style region prefixes (possibly stacked)
  for (let i = 0; i < 3; i++) n = n.replace(/^\s*[A-Z]{2,4}\s*[:|\-–]\s+/, '');
  n = n.replace(QUALITY, ' ').replace(/[()[\]{}|]/g, ' ').replace(/\s[-–:]\s/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return n || String(raw || '').trim();
}

// The last part of a group name: "AM | USA | ABC" → "ABC"
const groupTail = (g) => tokens(String(g).split(/[|\-:]/).pop())[0] || '';

export function annotate(channels) {
  for (const ch of channels) {
    if (ch._n || kindOf(ch) !== 'live') continue;
    ch._n = 1;
    ch.clean = cleanName(ch.name, ch.group);
    const toks = tokens(ch.clean);
    // A folder named just "ABC" holds affiliates by definition; otherwise look for the network in the name
    let net = NETWORKS.includes(groupTail(ch.group)) && toks.length ? groupTail(ch.group) : '';
    if (!net) {
      for (let i = 0; i < toks.length; i++) {
        if (!NETWORKS.includes(toks[i])) continue;
        if (NATIONAL.has(toks[i + 1]) || NATIONAL.has(toks[i - 1])) continue;
        net = toks[i];
        break;
      }
    }
    ch.net = net;
    ch.market = net ? toks.filter((t) => t !== net && !NETWORKS.includes(t) && t !== 'TV' && t !== 'LOCAL' && t !== 'USA' && t !== 'US').join(' ') : '';
  }
  return channels;
}

// Does this channel belong to the home market? `home` is what the user typed: "Austin", "KVUE, KXAN"…
// Stations that name no city or call sign at all are kept (could be the national feed).
export function isLocal(ch, home) {
  if (!ch.net || !ch.market) return true;
  const want = new Set();
  for (const w of String(home).split(',')) for (const t of tokens(w)) {
    want.add(t);
    for (const a of MARKET_ALIASES[t] || []) want.add(a);
  }
  if (!want.size) return true;
  return tokens(ch.market).some((t) => want.has(t));
}

// Keeps national channels and your city's stations. A station that names no city (a bare "ABC HD") is kept
// only for networks where no station of your city was found, so the folder ends up with just your own.
export function localFilter(channels, home) {
  const found = new Set();
  for (const c of channels) if (c.net && c.market && isLocal(c, home)) found.add(c.net);
  return channels.filter((c) => !c.net || (c.market ? isLocal(c, home) : !found.has(c.net)));
}

// ---------- Duplicates ----------
// Providers list the same station several times: in more than one folder, and as separate HD / FHD / SD / RAW /
// 60fps copies. dupeKey says which channels are the same station; qualityOf picks the copy to keep (the others
// stay as fallbacks, so if the best copy will not play the next one is tried).

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const VARIANT = new Set(['BACKUP', 'ALT', 'ALTERNATE', 'MIRROR', 'SERVER', 'S1', 'S2', 'S3', 'LOCAL', 'LIVE']);
const CALLSIGN = /^[KW][A-Z]{2,3}$/;
const CALL_TO_CITY = Object.fromEntries(Object.entries(MARKET_ALIASES).flatMap(([city, calls]) => calls.map((c) => [c, city])));

// "LAT - ESPN", "MX: FOX SPORTS" and "UK | BT SPORT" are the same channel name from another country's feed. When copies
// merge, the US one should be the one that plays; the others stay as fallbacks.
const FOREIGN = new Set(['LAT', 'LATAM', 'LATINO', 'LATINA', 'MX', 'MEX', 'MEXICO', 'BR', 'BRA', 'BRASIL', 'UK', 'CA', 'CAN', 'AR', 'ARG']);
export const isForeign = (ch) => {
  const t = tokens(`${ch.name} ${ch.group || ''}`);
  return !t.includes('US') && !t.includes('USA') && t.some((x) => FOREIGN.has(x));
};
export function regionScore(ch) {
  const t = tokens(`${ch.name} ${ch.group || ''}`);
  // ESPN+ and other "PLUS" feeds are not the channel of the same name
  return (t.includes('US') || t.includes('USA') ? 30 : 0) - (t.some((x) => FOREIGN.has(x)) ? 30 : 0) - (t.includes('PLUS') || /\+/.test(ch.name) ? 20 : 0);
}

// Higher is better. 4K/UHD and RAW streams are the heaviest on a TV's decoder and network, so a plain HD or FHD copy wins.
export function qualityOf(rawName) {
  const t = new Set(tokens(rawName));
  if (t.has('BACKUP')) return -1;
  if (t.has('LQ')) return 0;
  if (t.has('SD')) return 1;
  if (t.has('FHD')) return 5;
  if (t.has('HD')) return 4;
  if (t.has('4K') || t.has('UHD') || t.has('RAW')) return 3;
  return 2;
}

function stationKey(ch) {
  const m = tokens(ch.market).filter((t) => !US_STATES.has(t) && !VARIANT.has(t));
  const call = m.find((t) => CALLSIGN.test(t));
  const city = m.filter((t) => !CALLSIGN.test(t));
  // KVUE and "AUSTIN" are the same station when the home-market table knows the call sign
  if (call && CALL_TO_CITY[call]) return CALL_TO_CITY[call];
  const known = city.find((t) => MARKET_ALIASES[t]);
  if (known) return known;
  return call || city.join(' ');
}

export function dupeKey(ch) {
  if (ch.net && ch.market) return `${ch.net}|${stationKey(ch)}`;
  if (ch.net) return `${ch.net}|`;
  return tokens(ch.clean || ch.name).filter((t) => !VARIANT.has(t) && !FOREIGN.has(t)).join(''); // "ESPN 2", "ESPN2" and "ESPN LAT" are one channel
}

// One entry per station, in the order the first copy appeared. `isFav(id)` makes a favourited copy win, so a star
// never disappears. The copies that lose are kept on the survivor as `dupes` (best first).
export function dedupe(channels, isFav = () => false) {
  const groups = new Map();
  const out = [];
  for (const ch of channels) {
    if (kindOf(ch) !== 'live') { out.push(ch); continue; }
    const key = ch._k ??= dupeKey(ch);
    if (!key) { out.push(ch); continue; }
    const g = groups.get(key);
    if (g) g.push(ch); else { const list = [ch]; groups.set(key, list); out.push(list); }
  }
  return out.map((x) => {
    if (!Array.isArray(x)) return x;
    // Another country's copy of a channel you have is dropped, not even kept as a fallback stream
    const home = x.filter((c) => !isForeign(c));
    if (home.length && home.length < x.length) x.splice(0, x.length, ...home);
    if (x.length === 1) { delete x[0].dupes; return x[0]; }
    const ranked = x.map((c, i) => ({ c, i, s: (isFav(c.id) ? 100 : 0) + (c._q ??= qualityOf(c.name)) + (c.tvgId ? 0.5 : 0) + regionScore(c) }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    const best = ranked[0].c;
    // Not enumerable: it is recomputed on every load and must not be written into the cached playlist
    Object.defineProperty(best, 'dupes', { value: ranked.slice(1).map((r) => r.c), writable: true, configurable: true, enumerable: false });
    if (!best.tvgId) best.tvgId = best.dupes.find((d) => d.tvgId)?.tvgId || '';
    return best;
  });
}
