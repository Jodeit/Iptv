// Parsed playlists kept in IndexedDB, so reloading the app doesn't re-download them.
// Xtream playlists can be tens of megabytes, which is too big for localStorage.
// Every call fails soft: no cache just means a normal download.

const DB = 'o3xr';
const STORE = 'playlists';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function cacheGet(key) {
  try { return (await run('readonly', (s) => s.get(key))) || null; } catch { return null; }
}

export async function cachePut(key, value) {
  try { await run('readwrite', (s) => s.put(value, key)); } catch { /* quota or private mode */ }
}

export async function cacheDelete(key) {
  try { await run('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}
