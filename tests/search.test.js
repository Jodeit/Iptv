import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchText, searchCatalog } from '../js/search.js';

test('normalizes accents and punctuation for voice-friendly matching', () => {
  assert.equal(normalizeSearchText('  Amélie: À Paris! '), 'amelie a paris');
  assert.equal(normalizeSearchText('東京 2025'), '東京 2025');
});

test('ranks title matches before metadata matches and requires every query term', () => {
  const items = [
    { name: 'Paris', group: 'Drama' },
    { name: 'Paris, Texas', group: 'Drama' },
    { name: 'Amélie', group: 'Paris films' },
    { name: 'Paris Nights', group: 'Drama' },
  ];

  const found = searchCatalog(items, 'paris', { fieldsOf: (item) => [item.group] });
  assert.deepEqual(found.map(({ item }) => item.name), ['Paris', 'Paris, Texas', 'Paris Nights', 'Amélie']);
  assert.deepEqual(searchCatalog(items, 'paris science fiction', { fieldsOf: (item) => [item.group] }), []);
});

test('matches multiword searches across title and catalog metadata', () => {
  const items = [
    { name: 'The Expanse', genre: 'Science Fiction' },
    { name: 'Expanse', genre: 'Drama' },
  ];

  assert.deepEqual(
    searchCatalog(items, 'expanse science', { fieldsOf: (item) => [item.genre] }).map(({ item }) => item),
    [items[0]],
  );
});
