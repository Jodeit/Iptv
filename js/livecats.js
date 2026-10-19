// Sorts live channels into a region and a topic, whatever the provider calls its groups
// ("US | NEWS HD", "USA: Sports", "UK - Kids"…), so the guide can be browsed by both.

const REGIONS = {
  US: 'United States', USA: 'United States', UK: 'United Kingdom', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
  NZ: 'New Zealand', IE: 'Ireland', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', PT: 'Portugal', NL: 'Netherlands',
  BE: 'Belgium', MX: 'Mexico', LATINO: 'Latin America', LAT: 'Latin America', BR: 'Brazil', AR: 'Arabic', ARA: 'Arabic',
  IN: 'India', PK: 'Pakistan', TR: 'Turkey', PL: 'Poland', RU: 'Russia', GR: 'Greece', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  AF: 'Africa', EN: 'English', ENG: 'English',
};

// First match wins, so list the specific topics before the broad ones.
const TOPICS = [
  ['News', /\b(news|cnn|msnbc|fox ?news|bbc ?news|cnbc|bloomberg|weather|al ?jazeera|nbc ?news|abc ?news|cbs ?news|newsmax|c-?span)\b/i],
  ['Sports', /\b(sports?|espn|nfl|nba|mlb|nhl|ufc|wwe|football|soccer|golf|tennis|racing|f1|olympic|bein|dazn|sky ?sports?|fs1|fs2|tnt ?sports|bally|nesn|nbcsn|big ?ten|acc ?network|sec ?network|motorsport|boxing|fight)\b/i],
  ['Kids', /\b(kids?|cartoon|disney|nick(elodeon)?|nickjr|boomerang|pbs ?kids|baby ?tv|junior|toon|children|family)\b/i],
  ['Movies', /\b(movies?|cinema|films?|hbo|showtime|starz|cinemax|epix|tcm|amc|hallmark ?movies?|ppv|pay ?per ?view|mgm)\b/i],
  ['Documentary', /\b(docu\w*|history|discovery|nat(ional)? ?geo\w*|animal ?planet|science|smithsonian|travel|tlc|investigation|crime|id ?discovery|nature)\b/i],
  ['Music', /\b(music|mtv|vh1|cmt|radio|vevo|stingray|hits|country ?music|concert)\b/i],
  ['Entertainment', /\b(entertainment|comedy|reality|drama|lifestyle|food|hgtv|bravo|e!|usa ?network|tbs|tnt|fx|syfy|lifetime|oxygen|paramount|a&e|comedy ?central|cooking|home)\b/i],
  ['Local / Network', /\b(abc|cbs|nbc|fox|pbs|cw|local|network|univision|telemundo)\b/i],
  ['24/7', /(24\/7|24-7|24 ?7|\bloop\b)/i],
];

const cache = new WeakMap();

// → { region, topic }
export function classify(ch) {
  let hit = cache.get(ch);
  if (hit) return hit;
  const group = ch.group || '';
  const tag = group.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).find((t) => REGIONS[t]);
  const region = tag ? REGIONS[tag] : 'Other';
  // A specific channel name ("History", "ESPN") beats a broad group like "ENTERTAINMENT";
  // otherwise the provider's group decides, then the broad topics on the name.
  const name = ch.name || '';
  const specific = TOPICS.slice(0, 6);
  const topic = (specific.find(([, re]) => re.test(name)) || TOPICS.find(([, re]) => re.test(group)) || TOPICS.find(([, re]) => re.test(name)) || ['Other'])[0];
  hit = { region, topic };
  cache.set(ch, hit);
  return hit;
}

export const TOPIC_NAMES = [...TOPICS.map(([n]) => n), 'Other'];
