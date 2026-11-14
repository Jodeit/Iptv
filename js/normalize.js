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
