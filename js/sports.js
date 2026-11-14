// Turns a generic guide entry ("College Football") into the actual game ("Alabama at Georgia · 3rd 4:12 · 14–10").
// Programme guides rarely say who is playing, but ESPN's public scoreboard lists today's games per league with the
// network each one airs on, so a game is matched by league (from the programme text) and network (the channel).
// Everything here is best-effort: if the feed is unreachable the guide just keeps its own title.

const LEAGUES = [
  [/women'?s college basketball|wncaa/i, 'basketball/womens-college-basketball'],
  [/college basketball|ncaa.*basketball|ncaab|march madness/i, 'basketball/mens-college-basketball'],
  [/college football|ncaa football|ncaaf/i, 'football/college-football'],
  [/\bnfl\b|monday night football|sunday night football|thursday night football|pro football/i, 'football/nfl'],
  [/\bwnba\b/i, 'basketball/wnba'],
  [/\bnba\b|pro basketball/i, 'basketball/nba'],
  [/\bmlb\b|major league baseball|baseball/i, 'baseball/mlb'],
  [/\bnhl\b|hockey/i, 'hockey/nhl'],
  [/premier league/i, 'soccer/eng.1'],
  [/\bmls\b|major league soccer/i, 'soccer/usa.1'],
  [/la ?liga/i, 'soccer/esp.1'],
  [/bundesliga/i, 'soccer/ger.1'],
  [/serie a\b/i, 'soccer/ita.1'],
  [/champions league/i, 'soccer/uefa.champions'],
  [/europa league/i, 'soccer/uefa.europa'],
  [/nations league/i, 'soccer/uefa.nations'],
];
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const FRESH = 60_000, RETRY = 5 * 60_000;
const boards = new Map(); // league -> { at, ok, events }
const pending = new Map();
const listeners = new Set();

export const leagueOf = (p) => {
  const text = `${p?.title || ''} ${p?.category || ''} ${p?.desc || ''}`;
  for (const [re, path] of LEAGUES) if (re.test(text)) return path;
  return '';
};
// Channel names and ESPN's network names for the same channel, brought to one spelling
const ALIAS = { espn1: 'espn', foxsports1: 'fs1', foxsports2: 'fs2', bigtennetwork: 'btn', accnetwork: 'accn', cbssportsnetwork: 'cbssn', espnnews: 'espnews', secnetworkplus: 'secnetwork' };
const net = (s) => { const k = String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/\b(hd|us|usa|fhd|4k)\b/g, '').replace(/[^a-z0-9]/g, ''); return ALIAS[k] || k; };

const ord = (n) => ['', '1st', '2nd', '3rd', '4th'][n] || `${n}th`;
function normalize(ev) {
  const c = ev.competitions?.[0];
  if (!c) return null;
  const team = (t) => t?.team?.shortDisplayName || t?.team?.displayName || t?.team?.name || '';
  const away = c.competitors?.find((t) => t.homeAway === 'away'), home = c.competitors?.find((t) => t.homeAway === 'home');
  if (!away || !home) return null;
  const st = ev.status?.type || {};
  const nets = new Set();
  for (const b of c.broadcasts || []) for (const n of b.names || []) nets.add(net(n));
  for (const g of c.geoBroadcasts || []) if (g.media?.shortName) nets.add(net(g.media.shortName));
  const live = st.state === 'in';
  // "13:52 - 3rd" -> "3rd 13:52"; "Halftime", "Top 5th", "67'" stay as they are
  const period = (() => {
    const d = String(st.shortDetail || '');
    if (/half/i.test(d)) return 'Halftime';
    const m = d.match(/^(\S+)\s+-\s+(.+)$/);
    return m && /[:'’]|^\d/.test(m[1]) ? `${m[2]} ${m[1]}` : d;
  })();
  const side = (t) => ({
    name: team(t), abbr: t?.team?.abbreviation || '', score: t?.score ?? '',
    logo: t?.team?.logo || t?.team?.logos?.[0]?.href || '',
    rank: t?.curatedRank?.current > 0 && t.curatedRank.current <= 25 ? t.curatedRank.current : 0,
    won: !!t?.winner,
  });
  const score = live || st.state === 'post' ? `${away.score ?? 0}–${home.score ?? 0}` : '';
  return {
    title: `${team(away)} at ${team(home)}`,
    state: st.state, // pre | in | post
    start: Date.parse(ev.date) || 0,
    nets,
    detail: live ? period : st.state === 'post' ? (String(st.shortDetail || '').replace(/^Final\/?/i, 'Final ').trim() || 'Final') : '',
    away: side(away), home: side(home),
    odds: (() => { const o = c.odds?.[0]; return o && (o.details || o.overUnder) ? { line: o.details || '', total: o.overUnder || '' } : null; })(),
    score,
  };
}

async function get(url) {
  try { const r = await fetch(url); if (r.ok) return r.json(); } catch { /* fall through to the home proxy */ }
  const r = await fetch(`${location.origin}/proxy?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`scoreboard ${r.status}`);
  return r.json();
}

// Ask for a league's board (cached); listeners are told when new data lands so the screen can repaint.
export function want(league) {
  if (!league) return;
  const b = boards.get(league);
  if (b && Date.now() - b.at < (b.ok ? FRESH : RETRY)) return;
  if (pending.has(league)) return;
  const job = get(`${BASE}${league}/scoreboard`)
    .then((d) => boards.set(league, { at: Date.now(), ok: true, events: (d.events || []).map(normalize).filter(Boolean) }))
    .catch(() => boards.set(league, { at: Date.now(), ok: false, events: [] }))
    .finally(() => { pending.delete(league); index = null; for (const f of listeners) f(); });
  pending.set(league, job);
}
// Every league at once, for the scoreboard
export const wantAll = () => { for (const l of new Set(LEAGUES.map((x) => x[1]))) want(l); };
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
let index = null; // network -> games: live now, later today, final, and (once asked for) tomorrow
// "Today" runs until 3 am, so a late game is still tonight's
const cutoff = () => { const d = new Date(); d.setHours(27, 0, 0, 0); return d.getTime(); };
function games() {
  if (index) return index;
  index = new Map();
  const cut = cutoff(), seen = new Set();
  for (const b of boards.values()) for (const e of b.events || []) {
    const key = `${e.title}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const when = e.state === 'in' ? 'live' : e.state === 'post' ? 'final' : e.start < cut ? 'later' : e.start < cut + 864e5 ? 'tomorrow' : '';
    if (!when) continue;
    const g = { ...e, when };
    for (const n of e.nets) { if (!index.has(n)) index.set(n, []); index.get(n).push(g); }
  }
  const order = { live: 0, later: 1, final: 2, tomorrow: 3 };
  for (const list of index.values()) list.sort((a, b) => order[a.when] - order[b.when] || (a.when === 'final' ? b.start - a.start : a.start - b.start));
  return index;
}
// Tomorrow's slate is only fetched when asked for
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
export function wantTomorrow() {
  const day = ymd(Date.now() + 864e5);
  for (const l of new Set(LEAGUES.map((x) => x[1]))) {
    const key = `${l}#${day}`, b = boards.get(key);
    if ((b && Date.now() - b.at < (b.ok ? FRESH * 5 : RETRY)) || pending.has(key)) continue;
    const job = get(`${BASE}${l}/scoreboard?dates=${day}`)
      .then((d) => boards.set(key, { at: Date.now(), ok: true, events: (d.events || []).map(normalize).filter(Boolean) }))
      .catch(() => boards.set(key, { at: Date.now(), ok: false, events: [] }))
      .finally(() => { pending.delete(key); index = null; for (const f of listeners) f(); });
    pending.set(key, job);
  }
}
const sameDay = (t) => new Date(t).toDateString() === new Date().toDateString();
const dayClock = (t) => (sameDay(t) ? clock(t) : `${new Date(t).toLocaleDateString([], { weekday: 'short' })} ${clock(t)}`);
// The scoreboard's name for a channel. Channels in an "ESPN PLUS" folder are ESPN+ feeds, not ESPN.
const chKey = (ch) => {
  let k = ch.net ? net(ch.net) : net(ch.clean || ch.name);
  if (/\bPLUS\b|\+/i.test(String(ch.group || '')) && !k.endsWith('plus')) k += 'plus';
  return k;
};
// Every game this channel is carrying: live, later today, finished, and tomorrow's. [] if none.
export function gamesFor(ch) {
  const list = games().get(chKey(ch)) || [];
  return list.map((e) => ({
    key: `${e.title}|${e.start}`,
    title: e.title, when: e.when,
    live: e.when === 'live', start: e.start, away: e.away, home: e.home, odds: e.odds,
    period: e.when === 'live' ? e.detail : e.when === 'final' ? e.detail || 'Final' : `Starts ${dayClock(e.start)}`,
    status: e.when === 'live' ? [e.detail, e.score].filter(Boolean).join(' · ') : e.when === 'final' ? [e.detail || 'Final', e.score].filter(Boolean).join(' · ') : `starts ${dayClock(e.start)}`,
  }));
}
export const onChange = (f) => { listeners.add(f); };

// The game(s) this channel is showing for this programme: live ones first, else the one starting nearest the
// programme's start. Returns null when there is no confident match.
export function match(ch, p) {
  const league = leagueOf(p);
  const b = league && boards.get(league);
  if (!b?.ok) return null;
  const me = chKey(ch);
  if (!me) return null;
  const here = b.events.filter((e) => e.nets.has(me) && e.state !== 'post' && e.start < p.stop + 30 * 60_000);
  if (!here.length) return null;
  const live = here.filter((e) => e.state === 'in');
  const pick = live.length ? live : [here.reduce((a, e) => (Math.abs(e.start - p.start) < Math.abs(a.start - p.start) ? e : a))];
  const first = pick[0];
  return {
    title: pick.slice(0, 2).map((e) => e.title).join(' · ') + (pick.length > 2 ? ` +${pick.length - 2}` : ''),
    status: pick.length === 1 ? [first.detail, first.score].filter(Boolean).join(' · ') : `${pick.length} games`,
  };
}
