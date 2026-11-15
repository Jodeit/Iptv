import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer } from '../js/stream.js';

function playerForRecovery(live) {
  const player = Object.create(StreamPlayer.prototype);
  player.video = { duration: 3600, currentTime: 1200 };
  player.live = live;
  player.resumeAt = 0;
  player.token = 1;
  player.reconnects = 0;
  player.sources = [];
  player.report = [];
  player.onStatus = () => {};
  player.log = () => {};
  player.load = (_sources, options) => { player.reconnectOptions = options; };
  return player;
}

test('live recovery rejoins the live edge instead of restoring an old position', () => {
  const player = playerForRecovery(true);
  player.recover(1, 'stream stalled');
  assert.equal(player.resumeAt, 0);
  assert.deepEqual(player.reconnectOptions, { reconnect: true });
});

test('VOD recovery preserves its playback position', () => {
  const player = playerForRecovery(false);
  player.recover(1, 'stream stalled');
  assert.equal(player.resumeAt, 1200);
});
