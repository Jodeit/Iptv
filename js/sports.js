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
const net = (s) => String(s || '').toLowerCase().replace(/\b(hd|us|usa|fhd|4k)\b/g, '').replace(/[^a-z0-9]/g, '');

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
  const score = live || st.state === 'post' ? `${away.score ?? 0}–${home.score ?? 0}` : '';
  return {
    title: `${team(away)} at ${team(home)}`,
    state: st.state, // pre | in | post
    start: Date.parse(ev.date) || 0,
    nets,
    detail: live ? `${st.shortDetail || ''}`.replace(/\s*-\s*/, ' ') : st.state === 'post' ? 'Final' : '',
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
    .finally(() => { pending.delete(league); for (const f of listeners) f(); });
  pending.set(league, job);
}
export const onChange = (f) => { listeners.add(f); };

// The game(s) this channel is showing for this programme: live ones first, else the one starting nearest the
// programme's start. Returns null when there is no confident match.
export function match(ch, p) {
  const league = leagueOf(p);
  const b = league && boards.get(league);
  if (!b?.ok) return null;
  const me = ch.net ? net(ch.net) : net(ch.clean || ch.name);
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
