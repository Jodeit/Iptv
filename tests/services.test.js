import test from 'node:test';
import assert from 'node:assert/strict';
import { servicesFor } from '../js/services.js';

test('detects service labels in source metadata and title tags', () => {
  assert.deepEqual(servicesFor({ group: 'Netflix | Action' }), ['Netflix']);
  assert.deepEqual(servicesFor({ provider: 'Prime Video, HBO Max' }), ['Prime Video', 'HBO Max']);
  assert.deepEqual(servicesFor({ group: 'Hbo Amazon Prime' }), ['Prime Video', 'HBO']);
  assert.deepEqual(servicesFor({ group: 'HBO Max / Amazon Prime' }), ['Prime Video', 'HBO Max']);
  assert.deepEqual(servicesFor({ name: 'The Bear [Hulu] · S02' }), ['Hulu']);
  assert.deepEqual(servicesFor({ group: 'Disney' }), ['Disney+']);
});

test('does not mistake an ordinary title for a Max service tag', () => {
  assert.deepEqual(servicesFor({ name: 'Mad Max: Fury Road' }), []);
  assert.deepEqual(servicesFor({ group: 'Max | Movies' }), ['Max']);
});
