const REDDIT_URL = 'https://www.reddit.com/r/IPTV_ZONENEW/new.json?limit=25&raw_json=1';

function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return ''; }
}

function pasteUrlFromPost(post) {
  const text = `${post.title || ''}\n${post.selftext || ''}\n${post.url || ''}`;
  const candidates = text.split(/[^A-Za-z0-9+/_=-]+/).filter((part) => part.length >= 16);
  for (const candidate of candidates) {
    const decoded = decodeBase64(candidate);
    try {
      const url = new URL(decoded);
      if (url.protocol === 'https:' && (url.hostname === 'paste.sh' || url.hostname.endsWith('.paste.sh'))) return url.href;
    } catch { /* not an encoded URL */ }
  }
  return '';
}

function parseSources(text) {
  const sources = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/https?:\/\/[^\s<>"'`]+/i);
    if (!match) continue;
    const value = match[0].replace(/[),\].!?;]+$/, '');
    let url;
    try { url = new URL(value); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    const label = line.slice(0, match.index).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/[\[\](`*_]/g, '').trim();
    sources.push({ url: url.href, name: label || url.hostname });
  }
  return sources;
}

export async function findLatestSources(fetcher) {
  const listingResponse = await fetcher(REDDIT_URL);
  if (!listingResponse.ok) throw new Error(`Reddit returned HTTP ${listingResponse.status}`);
  const listing = await listingResponse.json();
  const posts = listing?.data?.children?.map((child) => child.data).filter(Boolean) || [];

  for (const post of posts) {
    const pasteUrl = pasteUrlFromPost(post);
    if (!pasteUrl) continue;
    const pasteResponse = await fetcher(pasteUrl);
    if (!pasteResponse.ok) throw new Error(`paste.sh returned HTTP ${pasteResponse.status}`);
    const sources = parseSources(await pasteResponse.text());
    if (sources.length) return { title: post.title || 'Reddit source list', pasteUrl, sources };
  }
  throw new Error('No recent Reddit post contained a valid paste.sh source list.');
}