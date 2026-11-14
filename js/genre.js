// What kind of programme is this? Used for the "On now" view, which groups channels by what is airing,
// like a cable guide, instead of by the provider's folder names.
//
// Order of evidence: the XMLTV <category> if the guide has one, then the programme's title and description,
// then (weakest) the channel's own name and group. Most IPTV guides carry no genre, so text does the work.

export const GENRES = ['Sports', 'Movies', 'News', 'Kids', 'Documentary', 'Music', 'Shows'];

// Checked in this order. A league name is a sure sign of sport; the words "movie" / "film" beat general sport
// words (a "Football Movie" is a movie); weak movie words (genre names) come last.
const RULES = [
  ['Sports', /\b(nfl|ncaa|nba|wnba|mlb|nhl|mls|ufc|wwe|aew|pga|lpga|nascar|indycar|f1|formula\s?1|motogp|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league|world cup|olympics?|wimbledon|sportscenter)\b|\bvs\.?\b/i],
  ['Movies', /\b(movies?|films?|feature presentation)\b/i],
  ['News', /\b(news|newsroom|headlines|breaking|weather|forecast|nightly|world report|politics|cnn|msnbc|bloomberg|cnbc|newshour|sunrise|good morning)\b/i],
  ['Kids', /\b(kids?|cartoons?|animated|toons?|paw patrol|sesame|bluey|peppa|disney junior|nick(elodeon| jr)?|pbs kids|spongebob|looney)\b/i],
  ['Sports', /\b(tennis|golf|boxing|wrestling|cricket|rugby|racing|football|basketball|baseball|hockey|soccer|volleyball|lacrosse|softball|sports?|game ?day|playoffs?|bowl game|pre-?game|post-?game|halftime|highlights)\b/i],
  ['Documentary', /\b(documentary|docuseries|docu|history|nature|wildlife|planet|true crime|investigat|biography|how it'?s made|mysteries|expedition)\b/i],
  ['Music', /\b(music|concert|live in|top \d+|hits|radio|mtv|vevo|karaoke|unplugged|billboard)\b/i],
  ['Movies', /\b(cinema|western|thriller|horror|sci-?fi|rom-?com|blockbuster)\b/i],
];

const CATEGORY = [
  [/sport/i, 'Sports'], [/news|weather|current affairs/i, 'News'], [/child|kid|cartoon|animat/i, 'Kids'],
  [/movie|film|cinema/i, 'Movies'], [/document|factual|nature|history|science/i, 'Documentary'], [/music|concert/i, 'Music'],
];

const MOVIE_NETWORK = /\b(hbo|showtime|cinemax|starz|encore|epix|mgm\+?|tcm|movies?|films?|cine|flix|paramount\+? with showtime)\b/i;
const EVENT = /\b(live|tonight|today|show|special|awards?|ceremony|festival|parade|marathon|coverage|news|report|hour|season|episodes?)\b/i;

function fromText(text) {
  for (const [g, re] of RULES) if (re.test(text)) return g;
  return null;
}

// { genre, via } for a programme p ({ title, desc, category? }) on channel ch ({ name, group }).
export function genreOf(p, ch) {
  if (p?.category) for (const [re, g] of CATEGORY) if (re.test(p.category)) return { genre: g, via: 'category' };
  const t = fromText(`${p?.title || ''} ${(p?.desc || '').slice(0, 240)}`);
  if (t) return { genre: t, via: 'text' };
  const c = fromText(`${ch?.name || ''} ${ch?.group || ''}`);
  if (c) return { genre: c, via: 'channel' };
  // Nothing in the text said what it is. A long programme is a film, mostly: on a movie network from 80 minutes
  // (HBO Signature also airs hour-long series), anywhere else from 95 and only when it doesn't sound like an event.
  const mins = p?.stop > p?.start ? (p.stop - p.start) / 60000 : 0;
  if (mins >= 80 && MOVIE_NETWORK.test(ch?.name || '')) return { genre: 'Movies', via: 'length' };
  if (mins >= 95 && !EVENT.test(p?.title || '')) return { genre: 'Movies', via: 'length' };
  return { genre: 'Shows', via: 'default' };
}
