import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, sportOf } from '../js/sports.js';

test('maps scoreboard leagues to their sport sections', () => {
  assert.equal(sportOf('basketball/wnba'), 'Basketball');
  assert.equal(sportOf('football/nfl'), 'Football');
  assert.equal(sportOf('soccer/uefa.champions'), 'Soccer');
  assert.equal(sportOf('baseball/mlb#20261116'), 'Baseball');
  assert.equal(sportOf('golf/pga'), 'Golf');
  assert.equal(sportOf('golf/lpga'), 'Golf');
});

test('normalizes golf tournaments as leaderboard entries', () => {
  const event = normalize({
    name: 'Austin Championship',
    date: '2026-11-15T12:00Z',
    status: { type: { state: 'in' } },
    competitions: [{
      status: { type: { shortDetail: 'Round 4' } },
      broadcasts: [{ names: ['ESPN+'] }],
      competitors: [
        { type: 'athlete', order: 1, score: '-14', athlete: { fullName: 'Player One' } },
        { type: 'athlete', order: 2, score: '-14', athlete: { fullName: 'Player Two' } },
      ],
    }],
  }, 'golf/pga');

  assert.equal(event.leaderboard, true);
  assert.equal(event.detail, 'Round 4');
  assert.deepEqual(event.standings.map(({ position, score }) => [position, score]), [['T1', '-14'], ['T1', '-14']]);
  assert.deepEqual([...event.nets], ['espnplus']);
});
