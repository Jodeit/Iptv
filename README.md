# o3XR IPTV

A WebXR IPTV player with **XR3D**, which converts flat 2D channels into stereoscopic 3D in real time.
It runs in Quest Browser, Pico, Vision Pro (Safari WebXR), and any desktop or mobile browser.
There's no build step: it's static files with three.js, hls.js and mpegts.js loaded from a CDN.

## Run it

```bash
cd o3xr-iptv
node server.js            # needs Node 18+, no npm install
```

Open http://localhost:8080. `server.js` serves the app and adds a **CORS proxy** at `/proxy`.
IPTV servers, including nearly every Xtream Codes panel, don't let web pages read their playlists or streams.
The app detects the proxy and routes those requests through it automatically.
Any static server (`python3 -m http.server`) also works, but then only CORS-enabled streams will play.

Browsers only allow WebXR on **HTTPS or localhost**, so for a headset:

- **Quest over USB:** `adb reverse tcp:8080 tcp:8080`, then open `http://localhost:8080` in Quest Browser.
- **Over Wi-Fi:** run with a certificate: `CERT=cert.pem KEY=key.pem node server.js`, then open `https://<your-pc-ip>:8080`.
  A self-signed one from `mkcert` works once the headset trusts it.

The proxy forwards to any URL it's given, so keep the server on your own network.

## Hosting

### Cloudflare (recommended: app + proxy on one HTTPS address)

The repo includes `wrangler.toml`, so Cloudflare deploys it as a single app. Cloudflare serves the player files,
and `proxy/worker.js` handles `/proxy`. The app finds that proxy by itself, so Xtream and `http://` providers
work with no Proxy URL setting.

1. dash.cloudflare.com → **Workers & Pages** → **Create application** → **Import a repository**, then pick `Jodeit/Iptv`.
2. Keep the defaults: no build command, and deploy command `npx wrangler deploy`. Then deploy.
3. Open `https://o3xr-iptv.<account>.workers.dev` on your headset.

Each push to `main` redeploys automatically. Server-only files (`server.js`, `proxy/`, configs) are never served
(see `.assetsignore`). To stop other sites using your proxy, add the variable
`ALLOWED_ORIGINS=https://o3xr-iptv.<account>.workers.dev` under the Worker's Settings → Variables.

### GitHub Pages (app only)

Enable Settings → Pages → Deploy from a branch → `main` / root. The app is then at **https://jodeit.github.io/Iptv/**.
Pages can't run a proxy, so for IPTV servers that block browsers, set **Sources → Proxy URL** to:

- your Cloudflare deployment above (set `ALLOWED_ORIGINS=https://jodeit.github.io`), or
- your own `server.js` running over HTTPS (`CERT=… KEY=… node server.js`).

Some IPTV providers block datacenter IPs. If channels fail through Cloudflare but work through `server.js` at home, that's why.

## Xtream Codes links

Paste a panel link straight into **Sources → M3U / Xtream playlist link**, for example:

```
http://provider.example:8080/get.php?username=USER&password=PASS&type=m3u_plus
```

You can leave off `http://`. The app recognises the link and fills in the Xtream form. It names the playlist
`Xtream · user@host` and never shows the password in the UI. For live channels, it tries the raw MPEG-TS stream
first, then the panel's HLS (`/live/user/pass/id.m3u8`) and TS variants. HLS is the most widely supported format,
including in Quest Browser and Safari.

### Test link

`server.js` and the Cloudflare deployment include a demo Xtream panel (`proxy/xtream-demo.js`) backed by free public
test streams. Use the **Xtream demo** button in Sources, or paste:

```
https://<your-app>/get.php?username=demo&password=demo&type=m3u_plus
```

If the demo plays but your provider's link doesn't, the app works and the provider is refusing the connection.

Proxy modes (Sources tab):

- **Auto** (default): goes direct when the server allows it and switches to the proxy once a host blocks the browser.
- **Always:** routes everything through the proxy.
- **Off:** never uses the proxy.

## Features

| Area | What you get |
|---|---|
| Sources | Xtream `get.php` links, M3U/M3U_PLUS URLs, local `.m3u` files, Xtream Codes login, single stream URLs, iptv-org presets |
| Streams | HLS (hls.js / native Safari), MPEG-TS & FLV (mpegts.js), MP4/WebM, with automatic fallback between engines |
| Library | Group filter, search, favorites, saved playlists, last playlist restored on reload |
| 3D modes | **2D**, **XR3D** (simulated 3D), **SBS** and **TAB** for native 3D channels. Channels with "3D SBS"/"TAB" in the name switch automatically |
| Theater | Screen size, distance, height and curvature (up to 120°); Cinema / Void / Stars environments; ambient light that follows the picture |
| VR | Per-eye stereo rendering, a controller- and hand-ray channel panel, thumbstick paging, grip to hide or show the panel, passthrough (AR) mode where supported |
| Desktop 3D | Red/cyan anaglyph (Dubois) and side-by-side output for 3D TVs and phone viewers |

## How XR3D works

`js/xr3d.js` turns each frame into stereo 3D in three steps, all on the GPU:

1. **Depth estimation.** A 192×108 vertex grid samples the frame and builds a depth value from monocular cues:
   brightness, saturation, a "lower in frame is nearer" ground-plane prior and a centre bias. A 25-tap Gaussian
   kernel smooths it.
2. **Relief.** Vertices are pushed toward you by that depth, so the screen becomes real 3D geometry.
   You get true motion parallax when you move your head.
3. **Stereo pop.** Each eye renders its own copy of the screen (WebXR layer 1 for the left eye, layer 2 for the right).
   The fragment shader shifts the image horizontally in proportion to depth minus the convergence plane, which adds
   binocular disparity on top of the relief.

Tuning (XR3D tab):

- **Depth relief:** how far the geometry bulges.
- **Stereo pop:** strength of the per-eye disparity.
- **Convergence:** which depth sits exactly at screen distance.
- **Depth contrast / smoothing:** sharper or softer depth layers.
- **Invert depth:** for content where dark areas are actually nearer, such as night scenes.
- **Show depth map (D key):** shows what the estimator sees.

## Controls

| Desktop | Action |
|---|---|
| Space | Play / pause |
| ↑ ↓ / PgUp PgDn | Previous / next channel |
| 3 | Cycle 3D mode |
| D | Toggle depth-map view |
| M | Mute |
| H | Hide / show panel |
| F | Fullscreen |
| V | Enter VR |
| Drag / scroll | Orbit / zoom around the screen |

| In VR | Action |
|---|---|
| Trigger / pinch on the panel | Select |
| Thumbstick up/down | Page through channels |
| Grip | Hide / show the panel |

## Notes

- **CORS:** without `server.js`, browsers can only play streams that send `Access-Control-Allow-Origin`.
- **VOD:** Xtream movies and series are often `.mkv` files, which browsers usually can't play. Live channels are the reliable part.
- **Codecs:** H.264/AAC works almost everywhere. HEVC streams depend on the device (Quest and Safari handle it; many desktop Chromium builds don't).
- **Mixed content:** `http://` streams won't load on an `https://` page. Running `server.js` over HTTPS fixes this, because the proxy is same-origin.

## Layout

```
server.js         Static server + CORS/HLS-rewriting proxy (zero dependencies)
proxy/worker.js   Same proxy as a Cloudflare Worker (used by wrangler.toml)
wrangler.toml     Cloudflare deploy config: static app + /proxy Worker
proxy/xtream-demo.js  Built-in demo Xtream panel (demo / demo) for testing
index.html        UI shell + CDN import map
css/style.css     Panel / bar styling (phone layout included)
js/main.js        App state, playlists, settings, UI + keyboard wiring
js/m3u.js         M3U parser, Xtream link detection + stream alternates
js/stream.js      HLS / MPEG-TS / native playback with fallback
js/theater.js     three.js scene, environments, ambient light, desktop stereo, WebXR sessions
js/xr3d.js        XR3D depth + stereo shader and per-eye screen meshes
js/vr-panel.js    In-headset channel browser and controller rays
```
