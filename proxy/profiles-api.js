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
// Linking a TV (the TV has no keyboard, so it asks and the phone answers):
//   POST   /api/tv                     { pub } → { code, expiresIn }   TV registers a one-time public key
//   GET    /api/tv                     → { tvs: [{ code }] }           TVs waiting on the caller's own network (same public IP)
//   GET    /api/tv/:code               → { pub, blob? } | 404          phone reads the key; TV polls for the blob
//   POST   /api/tv/:code               { blob } → 204                  phone leaves the profile token, RSA-encrypted to `pub`
//   DELETE /api/tv/:code               → 204                           TV cleans up
// The token only ever sits here encrypted to a key that never left the TV.
//
// `store` is { get(key) → string|null, put(key, value, ttlSeconds?), delete(key) }.

const ID_RE = /^[0-9a-f]{64}$/;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L lookalikes
const PAIR_TTL = 600;
const MAX_DATA = 2 * 1024 * 1024; // KV allows 25 MB; a heavy library (ratings, resume points) can pass 512 KB
const MAX_CLAIM_FAILURES = 20; // per IP per 10 minutes

export async function handleProfileApi({ method, path, body, ip }, store, opts = {}) {
  if (path === '/api/health') return json(200, { sync: true, store: opts.profileHandler ? 'durable' : 'kv' });

  const m = path.match(/^\/api\/profile\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return json(400, { error: 'bad profile id' });
    // On Cloudflare the whole operation runs inside that profile's Durable Object (see proxy/worker.js),
    // so the version check and the write cannot interleave with another device's. Elsewhere it runs
    // against `store`.
    if (opts.profileHandler) {
      // If the Durable Object can't be reached, serve from KV rather than fail: sync keeps working, just
      // without the one-at-a-time guarantee.
      try { return await opts.profileHandler(id, method, body); } catch (err) { console.error('profile Durable Object failed, using KV:', err?.message); }
    }
    return profileOp(method, body, cellFor(store, `profile:${id}`));
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

  if (path === '/api/tv' && method === 'POST') {
    if (typeof body?.pub !== 'string' || body.pub.length > 1000) return json(400, { error: 'bad key' });
    const code = randomCode(8);
    await store.put(`tv:${code}`, JSON.stringify({ pub: body.pub }), PAIR_TTL);
    // Remember which network it is on (a hash of the public IP, kept for the code's lifetime) so
    // a phone on the same Wi-Fi can find it without typing anything.
    const nk = await nearKey(ip);
    const now = Date.now();
    const near = JSON.parse((await store.get(nk)) || '[]').filter((e) => e.exp > now).slice(-4);
    near.push({ code, exp: now + PAIR_TTL * 1000 });
    await store.put(nk, JSON.stringify(near), PAIR_TTL);
    return json(200, { code, expiresIn: PAIR_TTL });
  }

  if (path === '/api/tv' && method === 'GET') {
    const now = Date.now();
    const near = JSON.parse((await store.get(await nearKey(ip))) || '[]').filter((e) => e.exp > now);
    const tvs = [];
    for (const e of near) {
      const raw = await store.get(`tv:${e.code}`);
      if (raw && !JSON.parse(raw).blob) tvs.push({ code: e.code });
    }
    return json(200, { tvs: tvs.reverse() }); // newest first
  }

  const tv = path.match(/^\/api\/tv\/([0-9A-Za-z]{8})$/);
  if (tv) {
    const code = tv[1].toUpperCase();
    const key = `tv:${code}`;
    if (method === 'DELETE') {
      await store.delete(key);
      return json(204, null);
    }
    const rlKey = `rl:${ip || 'unknown'}`;
    const failures = +(await store.get(rlKey)) || 0;
    if (failures >= MAX_CLAIM_FAILURES) return json(429, { error: 'too many attempts, try again in 10 minutes' });
    const raw = await store.get(key);
    if (!raw) {
      await store.put(rlKey, String(failures + 1), PAIR_TTL);
      return json(404, { error: 'code not found or expired' });
    }
    const entry = JSON.parse(raw);
    if (method === 'GET') return json(200, entry);
    if (method === 'POST') {
      if (entry.blob) return json(409, { error: 'this TV was already linked' });
      if (typeof body?.blob !== 'string' || body.blob.length > 2000) return json(400, { error: 'bad data' });
      await store.put(key, JSON.stringify({ pub: entry.pub, blob: body.blob }), 300);
      return json(204, null);
    }
    return json(405, { error: 'method not allowed' });
  }

  return json(404, { error: 'not found' });
}

// One profile's record: { get() → string|null, put(value), delete() }.
export const cellFor = (store, key) => ({
  get: () => store.get(key),
  put: (value) => store.put(key, value),
  delete: () => store.delete(key),
});

// GET / PUT / DELETE for one profile. PUT is an optimistic-concurrency write: the caller must have seen the
// latest version. This is only safe when nothing else can touch the record between the read and the write,
// which is why it runs inside a Durable Object on Cloudflare.
export async function profileOp(method, body, cell) {
  if (method === 'GET') {
    const raw = await cell.get();
    return raw ? json(200, JSON.parse(raw)) : json(404, { error: 'not found' });
  }
  if (method === 'PUT') {
    if (typeof body?.data !== 'string' || body.data.length > MAX_DATA) return json(400, { error: 'bad data' });
    const raw = await cell.get();
    const current = raw ? JSON.parse(raw) : { version: 0 };
    if ((body.version ?? 0) !== current.version) return json(409, current);
    const version = current.version + 1;
    await cell.put(JSON.stringify({ version, data: body.data }));
    return json(200, { version });
  }
  if (method === 'DELETE') {
    await cell.delete();
    return json(204, null);
  }
  return json(405, { error: 'method not allowed' });
}

async function nearKey(ip) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`near:${ip || 'unknown'}`));
  return `near:${[...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
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
