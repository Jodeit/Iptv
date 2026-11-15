import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToHsl, hslToHex } from '../js/tv-wall.js';

test('converts primary colours between hex and HSL', () => {
  assert.deepEqual(hexToHsl('#00ff00'), { hue: 120, saturation: 100, lightness: 50 });
  assert.equal(hslToHex(240, 100, 50), '#0000ff');
  assert.equal(hslToHex(0, 0, 100), '#ffffff');
  assert.equal(hslToHex(0, 0, 0), '#000000');
});

test('rejects invalid hex colors', () => {
  assert.equal(hexToHsl('not-a-colour'), null);
});
