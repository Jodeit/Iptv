const SERVICE_TAGS = [
  ['Netflix', /\bnetflix\b/i],
  ['Prime Video', /\b(?:amazon\s+prime(?:\s+video)?|prime\s+video)\b/i],
  ['Disney+', /\bdisney\s*(?:\+|plus)\b/i],
  ['Hulu', /\bhulu\b/i],
  ['HBO Max', /\bhbo\s*max\b/i],
  ['HBO', /\bhbo\b(?!\s*max\b)/i],
  ['Apple TV+', /\bapple\s+tv(?:\s*(?:\+|plus))?\b/i],
  ['Paramount+', /\bparamount\s*(?:\+|plus)\b/i],
  ['Peacock', /\bpeacock\b/i],
  ['Discovery+', /\bdiscovery\s*(?:\+|plus)\b/i],
  ['Crunchyroll', /\bcrunchyroll\b/i],
  ['Starz', /\bstarz\b/i],
  ['Showtime', /\bshowtime\b/i],
  ['MUBI', /\bmubi\b/i],
  ['BritBox', /\bbritbox\b/i],
  ['AMC+', /\bamc\s*(?:\+|plus)\b/i],
  ['MGM+', /\bmgm\s*(?:\+|plus)\b/i],
  ['Tubi', /\btubi\b/i],
  ['Pluto TV', /\bpluto\s*tv\b/i],
  ['Viki', /\bviki\b/i],
  ['Plex', /\bplex\b/i],
];

export function servicesFor(item) {
  const metadata = [item.service, item.provider, item.source, item.group, item.category].filter(Boolean).join(' ');
  const text = `${metadata} ${item.name || ''}`;
  const services = SERVICE_TAGS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (!/\bhbo\s*max\b/i.test(text) && (/\bmax\b/i.test(metadata) || /[\[(]\s*max\s*[\])]/i.test(item.name || ''))) {
    services.push('Max');
  }
  if (/\bdisney\b/i.test(metadata) && !services.includes('Disney+')) services.push('Disney+');
  return services;
}
