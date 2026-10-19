// A tiny built-in Xtream Codes panel for testing, served by server.js and the Cloudflare
// Worker. It answers the same get.php link format as a real provider, but its channels
// are free public test streams:
//
//   <app>/get.php?username=demo&password=demo&type=m3u_plus
//
// Live streams follow Xtream's URL layout (/user/pass/id, /live/user/pass/id.m3u8) and
// redirect to the public HLS sources.

const USER = 'demo';
const PASS = 'demo';

const CHANNELS = [
  { id: 1, name: 'Big Buck Bunny', group: 'Demo | Movies', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { id: 2, name: 'Tears of Steel', group: 'Demo | Movies', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8' },
  { id: 3, name: 'Sintel', group: 'Demo | Movies', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { id: 4, name: 'Apple Bipbop (fMP4)', group: 'Demo | Test patterns', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
];

const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

// Returns { status, headers, body } for demo routes, or null for anything else.
export function xtreamDemo(url) {
  const path = url.pathname;

  if (path === '/get.php') {
    const q = url.searchParams;
    if (q.get('username') !== USER || q.get('password') !== PASS) {
      return { status: 401, headers: { ...HEADERS, 'content-type': 'text/plain' }, body: 'Invalid demo login (use demo / demo)' };
    }
    const lines = ['#EXTM3U'];
    for (const c of CHANNELS) {
      lines.push(`#EXTINF:-1 tvg-id="demo.${c.id}" tvg-name="${c.name}" tvg-logo="" group-title="${c.group}",${c.name}`);
      lines.push(`${url.origin}/${USER}/${PASS}/${c.id}`);
    }
    return { status: 200, headers: { ...HEADERS, 'content-type': 'audio/x-mpegurl' }, body: `${lines.join('\n')}\n` };
  }

  const m = path.match(new RegExp(`^/(?:live/)?${USER}/${PASS}/(\\d+)(?:\\.(?:m3u8|ts))?$`));
  if (m) {
    const ch = CHANNELS.find((c) => c.id === +m[1]);
    if (!ch) return { status: 404, headers: HEADERS, body: 'No such channel' };
    return { status: 302, headers: { ...HEADERS, location: ch.url }, body: '' };
  }
  return null;
}
