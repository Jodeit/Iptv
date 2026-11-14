// Profiles: named sets of playlists, favorites, content filter and last playlist, synced
// across devices through the app's server (Cloudflare KV or server.js).
//
// Each profile has a random secret token. From it the browser derives the profile ID (a hash)
// and an AES-GCM key, and only ciphertext is uploaded, so the server never sees playlists,
// favorites or Xtream passwords. Another device joins by claiming a short pairing code that
// carries the token for 10 minutes.
//
// The synced document (one per profile, plus a device-only one for "no profile"):
//   { v, playlists: [{ key, name, url, at }], playlistsRemoved: { key: ts },
//     favs: { id: ts }, favsRemoved: { id: ts }, contentFilter, omdbKey, tmdbKey, tmdbMeta, progress, last, updatedAt }
// Merging takes the union of playlists/favorites minus anything deleted later (tombstones),
// so edits made on two devices at once both survive.

const enc = new TextEncoder();
const dec = new TextDecoder();
const TOMBSTONE_DAYS = 90;
const PUSH_DELAY = 1200;
const PULL_EVERY = 5 * 60 * 1000;

const b64u = {
  enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

const read = (k, d) => { try { const v = localStorage.getItem(`o3xr.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(`o3xr.${k}`, JSON.stringify(v)); } catch { /* full or blocked */ } };
const remove = (k) => { try { localStorage.removeItem(`o3xr.${k}`); } catch { /* ignore */ } };

export const emptyDoc = () => ({
  v: 1, playlists: [], playlistsRemoved: {}, favs: {}, favsRemoved: {}, contentFilter: null, omdbKey: null, tmdbKey: null, tmdbMeta: {}, progress: {}, last: null, updatedAt: 0,
});

export function mergeDocs(a, b) {
  const maxMap = (x = {}, y = {}) => {
    const out = { ...x };
    for (const [k, t] of Object.entries(y)) out[k] = Math.max(out[k] || 0, t);
    return out;
  };
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
  const prune = (m) => Object.fromEntries(Object.entries(m).filter(([, t]) => t > cutoff));

  const playlistsRemoved = prune(maxMap(a.playlistsRemoved, b.playlistsRemoved));
  const byKey = new Map();
  for (const p of [...(a.playlists || []), ...(b.playlists || [])]) {
    const cur = byKey.get(p.key);
    if (!cur || (p.at || 0) > (cur.at || 0)) byKey.set(p.key, p);
  }
  const playlists = [...byKey.values()]
    .filter((p) => !(playlistsRemoved[p.key] >= (p.at || 0)))
    .sort((x, y) => (y.at || 0) - (x.at || 0));

  const favsRemoved = prune(maxMap(a.favsRemoved, b.favsRemoved));
  const favs = Object.fromEntries(Object.entries(maxMap(a.favs, b.favs)).filter(([id, t]) => !(favsRemoved[id] >= t)));

  const [newer, older] = (a.updatedAt || 0) >= (b.updatedAt || 0) ? [a, b] : [b, a];
  return {
    v: 1,
    playlists,
    playlistsRemoved,
    favs,
    favsRemoved,
    name: newer.name ?? older.name ?? null,
    contentFilter: newer.contentFilter ?? older.contentFilter ?? null,
    omdbKey: newer.omdbKey ?? older.omdbKey ?? null,
    tmdbKey: newer.tmdbKey ?? older.tmdbKey ?? null,
    tmdbMeta: capMeta({ ...older.tmdbMeta, ...newer.tmdbMeta }),
    progress: mergeProgress(a.progress, b.progress),
    last: newer.last ?? older.last ?? null,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };
}

// Resume points: { id: { t, d, at, … } }, newest entry per id wins; the latest 300 are kept.
export function mergeProgress(a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const [id, p] of Object.entries(b || {})) if (!out[id] || (p.at || 0) > (out[id].at || 0)) out[id] = p;
  const ids = Object.keys(out);
  if (ids.length <= 300) return out;
  return Object.fromEntries(ids.sort((x, y) => out[y].at - out[x].at).slice(0, 300).map((id) => [id, out[id]]));
}

// TMDB age ratings and popularity, shared so other devices skip the lookups:
// { 'm:<tmdb id or title|year>': [cert, popularity, lookedUpAt] }. The newest few thousand
// keep the profile small; it's all public data, but still encrypted with the rest.
export const META_CAP = 6000;
export function capMeta(meta = {}) {
  const entries = Object.entries(meta);
  if (entries.length <= META_CAP) return meta;
  return Object.fromEntries(entries.sort((x, y) => (y[1][2] || 0) - (x[1][2] || 0)).slice(0, META_CAP));
}

const sameDoc = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// Browsers only offer crypto.subtle on https pages and localhost. Elsewhere (the app opened
// from a computer on the home network, http://192.168.…) the same SHA-256, HKDF and AES-GCM
// come from the audited noble libraries, so profiles work there too, byte for byte the same.
const subtle = globalThis.crypto?.subtle;
let noble;
const loadNoble = () => (noble ??= Promise.all([
  import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.5.0/sha256/+esm'),
  import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.5.0/hkdf/+esm'),
  import('https://cdn.jsdelivr.net/npm/@noble/ciphers@1.0.0/aes/+esm'),
]).then(([h, k, a]) => ({ sha256: h.sha256, hkdf: k.hkdf, gcm: a.gcm })));

export function canSync() {
  return !!globalThis.crypto?.getRandomValues;
}

async function deriveKeys(token) {
  const raw = b64u.dec(token);
  const idInput = new Uint8Array([...enc.encode('o3xr-profile-id:'), ...raw]);
  const salt = enc.encode('o3xr-profile'), info = enc.encode('aes-gcm-256');
  if (!subtle) {
    const n = await loadNoble();
    const id = [...n.sha256(idInput)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { id, key: { raw: n.hkdf(n.sha256, raw, salt, info, 32) } };
  }
  const idBytes = await subtle.digest('SHA-256', idInput);
  const id = [...new Uint8Array(idBytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { id, key };
}

async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(JSON.stringify(obj));
  const ct = key.raw ? (await loadNoble()).gcm(key.raw, iv).encrypt(pt) : await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  return `${b64u.enc(iv)}.${b64u.enc(ct)}`;
}

async function decrypt(key, data) {
  const [iv, ct] = data.split('.');
  const pt = key.raw ? (await loadNoble()).gcm(key.raw, b64u.dec(iv)).decrypt(b64u.dec(ct)) : await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv) }, key, b64u.dec(ct));
  return { ...emptyDoc(), ...JSON.parse(dec.decode(pt)) };
}

export class Profiles {
  // apiBase(): absolute URL of the API root ("…/api/"). onDoc(doc, reason): the active document
  // was replaced, reason 'switch' (another profile) or 'merge' (changes from another device). onStatus(): sync status or profile list changed.
  constructor({ apiBase, onDoc, onStatus, migrate }) {
    this.apiBase = apiBase;
    this.onDoc = onDoc;
    this.onStatus = onStatus;
    this.keys = new Map();
    this.status = { state: 'local', message: '' };
    this.timer = 0;
    this.pushing = null;
    this.doc = read(this.docKey(), null) || migrate?.() || emptyDoc();
    this.saveLocal();

    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.pull();
      else if (this.dirty) this.push();
    });
    addEventListener('online', () => this.sync());
    setInterval(() => { if (document.visibilityState === 'visible') this.pull(); }, PULL_EVERY);
  }

  // ---------- Local state ----------
  list() { return read('profiles', []); }
  saveList(list) { write('profiles', list); }
  active() { const id = read('activeProfile', null); return this.list().find((p) => p.id === id) || null; }
  docKey(id = read('activeProfile', null)) { return `doc@${id ? id.slice(0, 16) : 'local'}`; }
  saveLocal() { write(this.docKey(), this.doc); }

  // Apply a local edit: mutate the document, save it here, upload shortly.
  update(fn) {
    fn(this.doc);
    this.doc.updatedAt = Date.now();
    this.saveLocal();
    if (this.active()) {
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.push(), PUSH_DELAY);
      this.setStatus('pending', 'Saving…');
    }
  }

  setStatus(state, message = '') {
    this.status = { state, message, at: Date.now() };
    this.onStatus?.();
  }

  // ---------- Server ----------
  async api(path, { method = 'GET', body } = {}) {
    const res = await fetch(new URL(path, this.apiBase()), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ok: res.ok, data };
  }

  async keysFor(p) {
    if (!this.keys.has(p.token)) this.keys.set(p.token, await deriveKeys(p.token));
    return this.keys.get(p.token);
  }

  async available() {
    if (!canSync()) return 'Profiles need a secure (https) connection.';
    try {
      const r = await this.api('health');
      if (r.ok && r.data?.sync) return '';
      return r.data?.error || 'This server doesn’t have profile sync set up.';
    } catch {
      return 'Can’t reach the sync server.';
    }
  }

  // ---------- Sync ----------
  sync() { return this.dirty ? this.push() : this.pull(); }

  async pull() {
    const p = this.active();
    if (!p || this.pushing) return;
    try {
      this.setStatus('syncing', 'Syncing…');
      const { id, key } = await this.keysFor(p);
      const r = await this.api(`profile/${id}`);
      if (r.status === 404) return this.setStatus('error', 'This profile was deleted on another device.');
      if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
      if (r.data.version !== p.version) {
        const remote = await decrypt(key, r.data.data);
        this.adopt(p, r.data.version, mergeDocs(this.doc, remote), remote);
      }
      if (this.dirty) return this.push();
      this.setStatus('synced', 'Synced');
    } catch (err) {
      this.setStatus('offline', navigator.onLine ? `Sync failed: ${err.message}` : 'Offline, changes are saved on this device');
    }
  }

  async push() {
    const p = this.active();
    if (!p) return;
    clearTimeout(this.timer);
    if (this.pushing) return this.pushing;
    this.pushing = (async () => {
      try {
        this.setStatus('syncing', 'Syncing…');
        const { id, key } = await this.keysFor(p);
        for (let attempt = 0; attempt < 3; attempt++) {
          this.dirty = false;
          const cur = this.active();
          const r = await this.api(`profile/${id}`, { method: 'PUT', body: { version: cur.version, data: await encrypt(key, this.doc) } });
          if (r.ok) {
            this.saveMeta({ ...cur, version: r.data.version });
            if (!this.dirty) this.setStatus('synced', 'Synced');
            return;
          }
          if (r.status !== 409) throw new Error(r.data?.error || `HTTP ${r.status}`);
          // Another device saved first: merge its changes into ours, then try again.
          const remote = await decrypt(key, r.data.data);
          this.adopt(cur, r.data.version, mergeDocs(this.doc, remote), remote);
        }
        throw new Error('kept conflicting with another device');
      } catch (err) {
        this.dirty = true;
        this.setStatus('offline', navigator.onLine ? `Sync failed: ${err.message}` : 'Offline, changes are saved on this device');
      } finally {
        this.pushing = null;
      }
    })();
    return this.pushing;
  }

  adopt(p, version, merged, remote) {
    this.saveMeta({ ...p, version, name: merged.name || p.name });
    const changed = !sameDoc(merged, this.doc);
    this.doc = merged;
    this.saveLocal();
    if (!sameDoc(merged, remote)) this.dirty = true; // we have something the server lacks
    if (changed) this.onDoc?.(this.doc, 'merge');
  }

  saveMeta(p) {
    this.saveList(this.list().map((x) => (x.id === p.id ? p : x)));
  }

  // ---------- Profile management ----------
  async create(name, { copyCurrent = true } = {}) {
    const token = b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
    const { id, key } = await deriveKeys(token);
    this.keys.set(token, { id, key });
    const doc = copyCurrent ? structuredClone(this.doc) : emptyDoc();
    doc.name = name.trim().slice(0, 40) || 'My profile';
    doc.updatedAt = Date.now();
    const r = await this.api(`profile/${id}`, { method: 'PUT', body: { version: 0, data: await encrypt(key, doc) } });
    if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
    const profile = { id, name: name.trim().slice(0, 40) || 'My profile', token, version: r.data.version };
    this.saveList([...this.list(), profile]);
    write(`doc@${id.slice(0, 16)}`, doc);
    this.switchTo(id);
    return profile;
  }

  async pairingCode() {
    const p = this.active();
    if (!p) throw new Error('No profile selected');
    const r = await this.api('pair', { method: 'POST', body: { token: p.token, name: p.name } });
    if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return r.data; // { code, expiresIn }
  }

  async claim(code) {
    const r = await this.api('pair/claim', { method: 'POST', body: { code } });
    if (r.status === 404) throw new Error('That code wasn’t found or has expired. Codes last 10 minutes and work once.');
    if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return this.join(r.data.token, r.data.name);
  }

  // Adopt a profile given its secret token (from a pairing code or a phone linking this TV).
  async join(token, name) {
    const { id, key } = await deriveKeys(token);
    this.keys.set(token, { id, key });
    const got = await this.api(`profile/${id}`);
    if (!got.ok) throw new Error('The profile no longer exists.');
    const doc = await decrypt(key, got.data.data);
    const others = this.list().filter((p) => p.id !== id);
    this.saveList([...others, { id, name: doc.name || name || 'Profile', token, version: got.data.version }]);
    write(`doc@${id.slice(0, 16)}`, doc);
    this.switchTo(id);
    return name;
  }

  // ---------- Linking a TV ----------
  // The TV (no keyboard) asks for a code and shows it as a QR; the phone, which already has a
  // profile, sends the profile's token back encrypted to a key that never leaves the TV.
  async tvRequest() {
    if (!subtle) throw new Error('Linking needs a secure (https) connection.');
    const pair = await subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false, ['decrypt'],
    );
    const pub = b64u.enc(await subtle.exportKey('spki', pair.publicKey));
    const r = await this.api('tv', { method: 'POST', body: { pub } });
    if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return { code: r.data.code, expiresIn: r.data.expiresIn, privateKey: pair.privateKey };
  }

  // Poll until a phone answers ({ token, name }; the caller decides whether to accept it with join()),
  // the code expires (null) or `signal` aborts.
  async tvWait({ code, expiresIn, privateKey }, signal) {
    const until = Date.now() + expiresIn * 1000;
    while (Date.now() < until && !signal?.aborted) {
      await new Promise((ok) => setTimeout(ok, 2000));
      if (signal?.aborted) return null;
      let r;
      try { r = await this.api(`tv/${code}`); } catch { continue; }
      if (r.status === 404) return null;
      if (!r.ok || !r.data?.blob) continue;
      this.api(`tv/${code}`, { method: 'DELETE' }).catch(() => {});
      const pt = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, b64u.dec(r.data.blob));
      return JSON.parse(dec.decode(pt));
    }
    return null;
  }

  // The TV stopped waiting (skipped, closed, or took a new code): take its code off the list.
  tvCancel(code) {
    try { fetch(new URL(`tv/${code}`, this.apiBase()), { method: 'DELETE', keepalive: true }).catch(() => {}); } catch { /* leaving anyway */ }
  }

  // Phone side: codes of TVs on the same network (same public IP) waiting to be linked.
  async tvNearby() {
    const r = await this.api('tv');
    return r.ok ? (r.data.tvs || []).map((t) => t.code) : [];
  }

  // Phone side: send the active profile to the TV showing `code`.
  async tvOffer(code) {
    const p = this.active();
    if (!p) throw new Error('No profile selected');
    if (!subtle) throw new Error('Linking needs a secure (https) connection.');
    const clean = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (clean.length !== 8) throw new Error('The TV’s code has 8 characters.');
    const got = await this.api(`tv/${clean}`);
    if (got.status === 404) throw new Error('That code wasn’t found or has expired. The TV shows a new one every 10 minutes.');
    if (!got.ok) throw new Error(got.data?.error || `HTTP ${got.status}`);
    const pub = await subtle.importKey('spki', b64u.dec(got.data.pub), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const blob = b64u.enc(await subtle.encrypt({ name: 'RSA-OAEP' }, pub, enc.encode(JSON.stringify({ token: p.token, name: p.name }))));
    const r = await this.api(`tv/${clean}`, { method: 'POST', body: { blob } });
    if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return p.name;
  }

  // id = null switches to "this device only".
  switchTo(id) {
    clearTimeout(this.timer);
    if (this.dirty) this.push();
    write('activeProfile', id);
    this.doc = read(this.docKey(id), null) || emptyDoc();
    this.dirty = false;
    this.setStatus(id ? 'syncing' : 'local', id ? 'Syncing…' : '');
    this.onDoc?.(this.doc, 'switch');
    if (id) this.pull();
  }

  rename(name) {
    const p = this.active();
    const clean = name.trim().slice(0, 40);
    if (!p || !clean) return;
    this.saveMeta({ ...p, name: clean });
    this.update((d) => { d.name = clean; });
  }

  // Forget the profile on this device only.
  signOut(id) {
    this.saveList(this.list().filter((p) => p.id !== id));
    remove(`doc@${id.slice(0, 16)}`);
    if (read('activeProfile', null) === id) this.switchTo(null);
    else this.onStatus?.();
  }

  // Delete the profile from the server; other devices will notice on their next sync.
  async destroy(id) {
    const p = this.list().find((x) => x.id === id);
    if (!p) return;
    const { id: pid } = await this.keysFor(p);
    const r = await this.api(`profile/${pid}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(r.data?.error || `HTTP ${r.status}`);
    this.signOut(id);
  }
}
