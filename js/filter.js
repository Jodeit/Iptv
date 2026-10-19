// Content filter: keeps live channels from chosen regions and movies/series in chosen
// languages, matched against the playlist's group names ("US | News", "USA: Sports",
// "EN - Action", "SERIES | ENGLISH"…).

export const FILTER_DEFAULTS = {
  on: false,
  live: 'US, USA, United States',
  vod: 'EN, ENG, English, US, USA, UK',
  vodUntagged: true,
};

// Region/language tags that mark a movie or series group as not English. Untagged groups
// ("Netflix", "Action 4K") are kept when vodUntagged is on.
const FOREIGN = new Set(`
  AR ARA ARAB ARABIC FR FRA FRENCH DE GER GERMAN DEUTSCH IT ITA ITALIAN ITALIA ES ESP SPANISH LATINO LATIN MX
  PT POR PORTUGUESE BR BRAZIL NL DUTCH TR TUR TURK TURKISH PL POL POLISH RU RUS RUSSIAN UA UKRAINE IN IND INDIA
  HINDI PK PAK URDU PUNJABI TAMIL TELUGU MALAYALAM KANNADA BANGLA BENGALI KURD KURDISH PERSIAN FARSI IR IRAN
  AF AFGHAN AL ALB ALBANIAN YU BALKAN GR GREEK RO ROMANIA HU HUNGARY CZ SK SE SWE SWEDISH NO NOR NORWEGIAN
  DK DAN DANISH FI FIN FINNISH CN CHINESE JP JAPANESE KR KOREAN TH THAI VN VIET PH FILIPINO SOMALI AFRICA
  AFRICAN IL HEBREW ARM ARMENIAN
`.trim().split(/\s+/));

const tokens = (s) => s.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

// "US, USA, United States" → matches the token US or USA, or the phrase UNITED STATES.
function matcher(list) {
  const words = list.split(',').map((w) => w.trim().toUpperCase()).filter(Boolean);
  return (group) => {
    const upper = group.toUpperCase();
    const toks = new Set(tokens(group));
    return words.some((w) => (/[^A-Z0-9]/.test(w) ? upper.includes(w) : toks.has(w)));
  };
}

// Xtream puts movies and series under /movie/ and /series/ paths; everything else is live.
export function kindOf(ch) {
  if (/\/movie\//i.test(ch.url)) return 'movie';
  if (/\/series\//i.test(ch.url)) return 'series';
  return 'live';
}

export function makeFilter(cfg) {
  const live = matcher(cfg.live);
  const vod = matcher(cfg.vod);
  return (ch) => {
    if (kindOf(ch) === 'live') return live(ch.group);
    if (vod(ch.group)) return true;
    return cfg.vodUntagged && !tokens(ch.group).some((t) => FOREIGN.has(t));
  };
}
