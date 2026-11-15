import test from 'node:test';
import assert from 'node:assert/strict';
import { Guide } from '../js/epg.js';

test('skips and reports Xtream guide entries without a channel URL', () => {
  const problems = [];
  const guide = new Guide({ fetcher: async () => {}, onProblem: (message) => problems.push(message) });
  guide.setSource({ xtream: { server: 'https://provider.example', username: 'user', password: 'pass' } });

  assert.doesNotThrow(() => guide.request({ id: 'missing-url', kind: 'live' }));
  guide.crawl([{ id: 'missing-url', kind: 'live' }]);

  assert.equal(guide.queue.length, 0);
  assert.equal(guide.bgQueue.length, 0);
  assert.equal(problems.length, 2);
});
