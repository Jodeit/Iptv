import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaylist } from '../js/m3u.js';

async function withResponse(response, check) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    await check();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('reports an empty playlist response distinctly', async () => {
  await withResponse(new Response(''), () => assert.rejects(
    fetchPlaylist('https://provider.example/list.m3u'),
    /empty response/,
  ));
});

test('identifies web pages returned instead of playlists', async () => {
  await withResponse(new Response('<!doctype html><title>Login</title>', {
    headers: { 'content-type': 'text/html' },
  }), () => assert.rejects(
    fetchPlaylist('https://provider.example/list.m3u'),
    /web page instead of an M3U playlist/,
  ));
});

test('identifies authentication errors in JSON responses', async () => {
  await withResponse(new Response('{"user_info":{"auth":0}}', {
    headers: { 'content-type': 'application/json' },
  }), () => assert.rejects(
    fetchPlaylist('https://provider.example/get.php'),
    /authentication error/,
  ));
});

test('identifies plain-text provider errors without treating them as channels', async () => {
  await withResponse(new Response('Invalid username or password'), () => assert.rejects(
    fetchPlaylist('https://provider.example/list.m3u'),
    /authentication error/,
  ));
});

test('still accepts a playlist made of bare stream URLs', async () => {
  await withResponse(new Response('https://streams.example/channel/1\n'), async () => {
    const channels = await fetchPlaylist('https://provider.example/list.m3u');
    assert.equal(channels.length, 1);
    assert.equal(channels[0].url, 'https://streams.example/channel/1');
  });
});

test('distinguishes an empty M3U header from an unknown response', async () => {
  await withResponse(new Response('#EXTM3U\n'), () => assert.rejects(
    fetchPlaylist('https://provider.example/list.m3u'),
    /no channel entries/,
  ));
});

test('explains common HTTP playlist failures', async () => {
  await withResponse(new Response('Not found', { status: 404 }), () => assert.rejects(
    fetchPlaylist('https://provider.example/list.m3u'),
    /not found \(HTTP 404\)/,
  ));
});
