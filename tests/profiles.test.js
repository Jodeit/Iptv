import test from 'node:test';
import assert from 'node:assert/strict';
import { Profiles } from '../js/profiles.js';

function fingerprint(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function profileForSync(api) {
  const blob = 'encrypted-profile';
  const profile = { version: 3, rev: fingerprint(blob) };
  const instance = Object.create(Profiles.prototype);
  Object.assign(instance, {
    status: { state: 'local', message: '' },
    _dirty: false,
    pushing: null,
    pulling: null,
    lastPullAt: 0,
    doc: {},
    onStatus: () => {},
    onLog: () => {},
    active: () => profile,
    keysFor: async () => ({ id: 'profile-id', key: {} }),
    api: async () => api({ version: profile.version, data: blob }),
  });
  return instance;
}

test('coalesces overlapping profile pulls and throttles redundant checks', async () => {
  let requests = 0, release;
  const response = new Promise((resolve) => { release = resolve; });
  const instance = profileForSync(async (data) => {
    requests++;
    await response;
    return { status: 200, ok: true, data };
  });

  const first = instance.pull();
  const overlapping = instance.pull();
  assert.strictEqual(overlapping, first);
  await Promise.resolve();
  assert.equal(requests, 1);
  release();
  await first;

  assert.equal(instance.pull(), undefined);
  await instance.pull({ force: true });
  assert.equal(requests, 2);
});
