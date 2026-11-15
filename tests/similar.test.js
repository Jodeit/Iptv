import test from 'node:test';
import assert from 'node:assert/strict';
import { combineRecommendations, indexCatalog } from '../js/similar.js';

test('combines recommendations from multiple seeds and excludes watched titles', () => {
  const catalog = indexCatalog([
    { id: 'one', name: 'North Star (2020)', kind: 'movie' },
    { id: 'two', name: 'Quiet River (2021)', kind: 'movie' },
    { id: 'three', name: 'Blue Valley (2019)', kind: 'movie' },
    { id: 'watched', name: 'Old Harbor (2018)', kind: 'movie' },
  ]);
  const picks = combineRecommendations([
    { weight: 1, recs: [{ id: '1', title: 'North Star', year: 2020 }, { id: '2', title: 'Quiet River', year: 2021 }, { id: '4', title: 'Old Harbor', year: 2018 }] },
    { weight: 1, recs: [{ id: '2', title: 'Quiet River', year: 2021 }, { id: '3', title: 'Blue Valley', year: 2019 }] },
  ], catalog, new Set(['one', 'watched']));

  assert.deepEqual(picks.map((item) => item.id), ['two', 'three']);
});
