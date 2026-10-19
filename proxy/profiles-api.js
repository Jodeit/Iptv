// Profile sync API, shared by the Cloudflare Worker (KV storage) and server.js (JSON file).
//
// Profiles are end-to-end encrypted: the browser derives an ID and an AES key from a secret
// profile token and only uploads ciphertext, so this server never sees playlists, favorites
// or Xtream passwords. The token itself passes through here only while a device is being
// linked with a short-lived pairing code.
//
//   GET    /api/health                 → { sync: true }
//   GET    /api/profile/:id            → { version, data } | 404
//   PUT    /api/profile/:id            { version, data } → { version } | 409 { version, data }
//   DELETE /api/profile/:id            → 204
//   POST   /api/pair                   { token, name } → { code, expiresIn }
//   POST   /api/pair/claim             { code } → { token, name } | 404
//
// `store` is { get(key) → string|null, put(key, value, ttlSeconds?), delete(key) }.

const ID_RE = /^[0-9a-f]{64}$/;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L lookalikes
const PAIR_TTL = 600;
const MAX_DATA = 512 * 1024;
const MAX_CLAIM_FAILURES = 20; // per IP per 10 minutes

export async function handleProfileApi({ method, path, body, ip }, store) {
  if (path === '/api/health') return json(200, { sync: true });

  const m = path.match(/^\/api\/profile\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return json(400, { error: 'bad profile id' });
    const key = `profile:${id}`;
    if (method === 'GET') {
      const raw = await store.get(key);
      return raw ? json(200, JSON.parse(raw)) : json(404, { error: 'not found' });
    }
    if (method === 'PUT') {
      if (typeof body?.data !== 'string' || body.data.length > MAX_DATA) return json(400, { error: 'bad data' });
      const raw = await store.get(key);
      const current = raw ? JSON.parse(raw) : { version: 0 };
      // Optimistic concurrency: the writer must have seen the latest version.
      if ((body.version ?? 0) !== current.version) return json(409, current);
      const version = current.version + 1;
      await store.put(key, JSON.stringify({ version, data: body.data }));
      return json(200, { version });
    }
    if (method === 'DELETE') {
      await store.delete(key);
      return json(204, null);
    }
    return json(405, { error: 'method not allowed' });
  }

  if (path === '/api/pair' && method === 'POST') {
    if (typeof body?.token !== 'string' || body.token.length > 200) return json(400, { error: 'bad token' });
    const code = randomCode(8);
    await store.put(`pair:${code}`, JSON.stringify({ token: body.token, name: String(body.name || '').slice(0, 60) }), PAIR_TTL);
    return json(200, { code, expiresIn: PAIR_TTL });
  }

  if (path === '/api/pair/claim' && method === 'POST') {
    const rlKey = `rl:${ip || 'unknown'}`;
    const failures = +(await store.get(rlKey)) || 0;
    if (failures >= MAX_CLAIM_FAILURES) return json(429, { error: 'too many attempts, try again in 10 minutes' });
    const code = String(body?.code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    const raw = code.length === 8 ? await store.get(`pair:${code}`) : null;
    if (!raw) {
      await store.put(rlKey, String(failures + 1), PAIR_TTL);
      return json(404, { error: 'code not found or expired' });
    }
    await store.delete(`pair:${code}`); // single use
    return json(200, JSON.parse(raw));
  }

  return json(404, { error: 'not found' });
}

// Unbiased: bytes at or above the largest multiple of the alphabet size are re-drawn.
function randomCode(n) {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < limit && out.length < n) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

function json(status, body) {
  return { status, body };
}

// Cloudflare KV adapter (expirationTtl must be at least 60 s).
export function kvStore(kv) {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttl) => kv.put(key, value, ttl ? { expirationTtl: Math.max(60, ttl) } : undefined),
    delete: (key) => kv.delete(key),
  };
}
