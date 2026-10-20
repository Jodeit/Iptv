// A tiny built-in Xtream Codes panel for testing, served by server.js and the Cloudflare
// Worker. It answers the same get.php and player_api.php requests as a real provider, but
// its channels are free public test streams:
//
//   <app>/get.php?username=demo&password=demo&type=m3u_plus
//
// Live streams follow Xtream's URL layout (/user/pass/id, /live/user/pass/id.m3u8) and
// redirect to the public HLS sources.
//
// It can also misbehave on purpose, to test how the app copes with real providers' failures.
// The password is always "demo"; the username picks how the whole panel behaves:
//
//   demo     healthy
//   expired  account expired: the panel still answers, every stream is refused (403)
//   banned   account banned: same, with status "Banned"
//   maxed    at its connection limit: lists load, every stream is refused (403)
//   slow     every response takes 6 s
//   down     panel offline: 503 for everything
//   captcha  a bot-check HTML page instead of a playlist or JSON
//   noapi    no player_api.php (404), so the app has to fall back to get.php
//
// Every account lists the "Demo | Faults" channels, each failing in one particular way
// (FAULTS below).

const PASS = 'demo';
const ACCOUNTS = ['demo', 'expired', 'banned', 'maxed', 'slow', 'down', 'captcha', 'noapi'];

const CHANNELS = [
  { id: 1, name: 'Big Buck Bunny', group: 'Demo | Movies', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { id: 2, name: 'Tears of Steel', group: 'Demo | Movies', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8' },
  { id: 3, name: 'Sintel', group: 'Demo | Movies', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { id: 4, name: 'Apple Bipbop (fMP4)', group: 'Demo | Test patterns', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
];

// Channels that fail in one particular way each.
const FAULTS = [
  { id: 101, fault: 'dead', name: 'Dead stream (404)' },
  { id: 102, fault: 'forbidden', name: 'Refused (403)' },
  { id: 103, fault: 'error', name: 'Server error (502)' },
  { id: 104, fault: 'flaky', name: 'Flaky: fails half the time (503)' },
  { id: 105, fault: 'hang', name: 'Never answers (504 after 60 s)' },
  { id: 106, fault: 'slowstart', name: 'Slow to start (8 s)' },
  { id: 107, fault: 'html', name: 'Web page instead of a stream' },
  { id: 108, fault: 'loop', name: 'Redirect loop' },
  { id: 109, fault: 'empty', name: 'Empty playlist' },
  { id: 110, fault: 'freeze', name: 'Stops updating after 30 s' },
  { id: 111, fault: 'segments', name: 'Segments missing after 20 s' },
  { id: 112, fault: 'kicked', name: 'Cut off after 60 s (403)' },
];

const LIVE_CATS = [
  { category_id: '1', category_name: 'Demo | Movies' },
  { category_id: '2', category_name: 'Demo | Test patterns' },
  { category_id: '3', category_name: 'Demo | Faults' },
];
const catId = (group) => LIVE_CATS.find((c) => c.category_name === group).category_id;
const ALL = [...CHANNELS, ...FAULTS.map((f) => ({ ...f, group: 'Demo | Faults' }))];

const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const TEXT = { ...HEADERS, 'content-type': 'text/plain' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (status, body) => ({ status, headers: TEXT, body });
const json = (body) => ({ status: 200, headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const m3u8 = (body) => ({ status: 200, headers: { ...HEADERS, 'content-type': 'application/vnd.apple.mpegurl' }, body });
const CAPTCHA = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser before accessing.</h1></body></html>';

// Returns { status, headers, body } for demo routes, or null for anything else.
export async function xtreamDemo(url) {
  const path = url.pathname;
  if (path.startsWith('/demo-hls/')) return liveHls(path);

  let user, pass, id;
  if (path === '/get.php' || path === '/player_api.php') {
    user = url.searchParams.get('username');
    pass = url.searchParams.get('password');
  } else {
    const m = path.match(/^\/(?:live\/)?([a-z]+)\/([a-z]+)\/(\d+)(?:\.(?:m3u8|ts))?$/);
    if (!m || !ACCOUNTS.includes(m[1])) return null;
    [, user, pass, id] = m;
  }
  const ok = ACCOUNTS.includes(user) && pass === PASS;

  if (user === 'down') return text(503, 'Service Unavailable');
  if (user === 'slow') await sleep(6000);

  if (path === '/get.php') {
    if (!ok) return text(401, 'Invalid demo login (use demo / demo)');
    if (user === 'captcha') return { status: 200, headers: { ...HEADERS, 'content-type': 'text/html' }, body: CAPTCHA };
    if (user === 'expired' || user === 'banned') return text(403, 'Account disabled');
    const lines = ['#EXTM3U'];
    for (const c of ALL) {
      lines.push(`#EXTINF:-1 tvg-id="demo.${c.id}" tvg-name="${c.name}" tvg-logo="" group-title="${c.group}",${c.name}`);
      lines.push(`${url.origin}/${user}/${PASS}/${c.id}`);
    }
    return { status: 200, headers: { ...HEADERS, 'content-type': 'audio/x-mpegurl' }, body: `${lines.join('\n')}\n` };
  }

  if (path === '/player_api.php') {
    if (user === 'noapi') return text(404, 'Not Found');
    if (user === 'captcha') return { status: 200, headers: { ...HEADERS, 'content-type': 'text/html' }, body: CAPTCHA };
    if (!ok) return json({ user_info: { auth: 0 } });
    return json(playerApi(url, user));
  }

  // A stream
  if (!ok) return text(401, 'Unauthorized');
  if (user === 'expired' || user === 'banned') return text(403, 'Account disabled');
  if (user === 'maxed') return text(403, 'Max connections reached');
  const ch = ALL.find((c) => c.id === +id);
  if (!ch) return text(404, 'No such channel');
  if (ch.url) return { status: 302, headers: { ...HEADERS, location: ch.url }, body: '' };
  return fault(ch.fault, url, path);
}

function playerApi(url, user) {
  const action = url.searchParams.get('action') || '';
  const now = Math.floor(Date.now() / 1000);
  if (!action) {
    const status = { expired: 'Expired', banned: 'Banned' }[user] || 'Active';
    return {
      user_info: {
        auth: 1, username: user, status,
        exp_date: String(user === 'expired' ? now - 86400 * 3 : now + 86400 * 30),
        active_cons: user === 'maxed' ? '2' : '0', max_connections: '2', is_trial: '0',
        created_at: String(now - 86400 * 365), allowed_output_formats: ['m3u8', 'ts'],
      },
      server_info: { url: url.hostname, port: url.port, https_port: url.port, server_protocol: url.protocol.replace(':', ''), timestamp_now: now },
    };
  }
  if (action === 'get_live_categories') return LIVE_CATS;
  if (action === 'get_live_streams') {
    const cat = url.searchParams.get('category_id');
    return ALL.filter((c) => !cat || catId(c.group) === cat).map((c, i) => ({
      num: i + 1, name: c.name, stream_type: 'live', stream_id: c.id, stream_icon: '',
      epg_channel_id: `demo.${c.id}`, category_id: catId(c.group),
    }));
  }
  return []; // no movies or series
}

async function fault(kind, url, path) {
  switch (kind) {
    case 'dead': return text(404, 'Not Found');
    case 'forbidden': return text(403, 'Forbidden');
    case 'error': return text(502, 'Bad Gateway');
    case 'flaky':
      if (Math.random() < 0.5) return text(503, 'Service Unavailable');
      return { status: 302, headers: { ...HEADERS, location: CHANNELS[0].url }, body: '' };
    case 'hang': await sleep(60000); return text(504, 'Gateway Timeout');
    case 'slowstart': await sleep(8000); return { status: 302, headers: { ...HEADERS, location: CHANNELS[0].url }, body: '' };
    case 'html': return { status: 200, headers: { ...HEADERS, 'content-type': 'text/html' }, body: '<!DOCTYPE html><html><body><h1>This channel is not available in your region</h1></body></html>' };
    case 'loop': return { status: 302, headers: { ...HEADERS, location: `${url.origin}${path}` }, body: '' };
    case 'empty': return m3u8('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n');
    default:
      // Live streams that go wrong partway through: the start time rides in the URL, so the
      // panel needs no state and works the same in a Worker.
      return { status: 302, headers: { ...HEADERS, location: `${url.origin}/demo-hls/${kind}/${Date.now()}.m3u8` }, body: '' };
  }
}

// ---------- A live HLS channel made from Big Buck Bunny's segments ----------

let source = null; // { target, segments: [{ duration, uri }] }

async function loadSource() {
  const master = CHANNELS[0].url;
  const res = await fetch(master);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).split('\n').map((l) => l.trim());
  // The lowest-bandwidth variant: quickest to load, and enough to show a picture.
  let best = null;
  lines.forEach((l, i) => {
    const bw = +(l.match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/) || [])[1];
    if (bw && (!best || bw < best.bw)) best = { bw, uri: new URL(lines[i + 1], master).href };
  });
  const media = best?.uri || master;
  const body = await (await fetch(media)).text();
  const segments = [];
  let duration = 0;
  for (const l of body.split('\n').map((x) => x.trim())) {
    if (l.startsWith('#EXTINF:')) duration = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) segments.push({ duration, uri: new URL(l, media).href });
  }
  if (!segments.length) throw new Error('no segments');
  const target = Math.ceil(Math.max(...segments.map((s) => s.duration)));
  return { target, segments };
}

async function liveHls(path) {
  const miss = path.match(/^\/demo-hls\/missing\/\d+\.ts$/);
  if (miss) return text(404, 'Not Found');
  const m = path.match(/^\/demo-hls\/(freeze|segments|kicked)\/(\d+)\.m3u8$/);
  if (!m) return null;
  const [, kind, start] = m;
  const elapsed = (Date.now() - +start) / 1000;
  if (kind === 'kicked' && elapsed > 60) return text(403, 'Connection closed by provider');

  try {
    source ||= await loadSource();
  } catch (e) {
    source = null;
    return text(502, `Demo stream source unavailable (${e.message})`);
  }
  const { target, segments } = source;
  const WINDOW = 4;
  // A live window sliding along the film in real time; freeze stops it sliding after 30 s.
  let first = Math.floor((kind === 'freeze' ? Math.min(elapsed, 30) : elapsed) / target);
  first = Math.max(0, Math.min(first, segments.length - WINDOW));
  const brokenFrom = Math.floor(20 / target);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
  for (let i = first; i < Math.min(first + WINDOW, segments.length); i++) {
    lines.push(`#EXTINF:${segments[i].duration.toFixed(3)},`);
    lines.push(kind === 'segments' && i >= brokenFrom ? `/demo-hls/missing/${i}.ts` : segments[i].uri);
  }
  return m3u8(`${lines.join('\n')}\n`);
}
