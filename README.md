# Tuner

A WebXR IPTV player with **XR3D**, which converts flat 2D channels into stereoscopic 3D in real time.
It runs in Quest Browser, Pico, Vision Pro (Safari WebXR), and any desktop or mobile browser.
There's no build step: it's static files with three.js, hls.js and mpegts.js loaded from a CDN.

## Run it

```bash
cd o3xr-iptv
npm start                 # needs Node 22.15+, no npm install
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

## Phones and tablets

On iPhone, iPad and Android phones and tablets without WebXR, the app uses a **flat player**: the video itself with
the system's own controls (full screen, picture-in-picture, AirPlay) instead of the 3D theater. The VR, XR3D and
Theater controls are hidden, and three.js isn't downloaded at all. **Playback → Display** overrides this per device
(Auto / Flat player / 3D theater). Vision Pro keeps the theater, since it supports immersive VR.

## Large Xtream accounts

Xtream accounts load through the panel's API (`player_api.php`), like dedicated IPTV apps do, instead of one giant
`get.php` playlist with every channel, movie and episode in it:

- **Categories load first.** Live channels come next: only the categories the content filter keeps, or all of them in
  one request when it's off.
- **Movies and Series** are browsed by category. A category loads when you open it; a series' episodes load when
  you open the series.
- **Panels without the API** fall back to `get.php`.

On a mock account with 20k live channels, 40k movies and 8k series (a 33 MB playlist), peak memory during load fell
from about 113 MB to 10 MB (3 MB with the US filter on). That matters on iPad, where Safari reloads a tab that uses
too much. If a load is ever interrupted by such a reload, the app doesn't retry on its own at the next start (no
reload loop); it explains what happened and waits for ↻. Other M3U playlists are parsed while they download.

## MKV movies in the browser

Safari (and some other browsers) can't open MKV files, and many Xtream movies are MKV. The app remuxes them on the
fly (`js/mkv/`): it streams the file, unpacks the Matroska clusters, and repackages the same video and audio as
fragmented MP4 for Media Source Extensions. Nothing is re-encoded, and only about 45 s is buffered ahead, so memory
stays small even for a full-length film.

- **Video:** H.264, HEVC, VP9. **Audio:** AAC, AC-3, E-AC-3, MP3, Opus. With several audio tracks it picks the
  default (or English) one the browser can play.
- **Subtitles:** text subtitles (SRT, ASS) appear in the player's captions menu.
- **Seeking:** uses the file's Cues index, fetched with a range request on the first jump.
- **DTS / TrueHD audio:** no browser can decode it, so the film plays without sound and the app says so.
  **Open in VLC / Infuse** stays available for anything the browser can't handle.

## Playback log

**Playback → Playback log** records each playback: which engine and source played, every buffering stall with its
length, and every 30 s the buffer level, resolution, download speed against the stream's bitrate, dropped frames and
engine warnings. Failed attempts and stream probes are there too. Xtream passwords are masked, and **Copy log** copies
it for sharing. **Display → HLS player** switches between hls.js (default) and the browser's own HLS player, to
compare on a given device.

## Movies and series gallery

Choosing **Movies** or **Series** (or **Browse**, key B) opens a poster gallery. Pick a category, search it, and sort
by recently added, Rotten Tomatoes, provider rating, year or title. Tapping a poster opens its preview page. That page
has the backdrop, plot, director and cast, and the ratings: Rotten Tomatoes Tomatometer, IMDb and Metacritic. It also
has a trailer and **Play**. For a series it lists each season's episodes instead.

Films and episodes remember where you stopped, on this device. Posters show a progress bar, the preview page offers
**Resume** or **From the start**, and playing from the list resumes too.

Ratings come from [OMDb](https://www.omdbapi.com/apikey.aspx), which includes Rotten Tomatoes scores. You need a free
key (1,000 lookups a day) under **Playback → Ratings**. It is checked before saving and syncs with your profile. Only
posters that stay on screen are looked up, and results are cached for 30 days. Without a key, the provider's own star
rating is shown.

**More like this.** Preview pages show a row of recommendations that your provider actually carries. TMDB
(themoviedb.org) picks them from what its users watched together and from similar titles. The app keeps only the ones
it finds in your catalog, matched by TMDB ID or by name and year. It needs a free TMDB API key (v3 key or read
access token) under **Playback → Ratings**, which syncs with your profile. To know what your provider has, the app
indexes the movie or series categories your content filter keeps, once a day. Recommendations are cached for a week.

## TV guide

Live channels show what's on now, with a progress bar, in the channel list and the now-playing bar. **Guide**
(or the G key) opens a grid with a six-hour timeline for the current list and group. Tap a programme for details,
or a channel name to watch it.

- **Xtream accounts:** guide data comes from the panel's `get_short_epg` API. It's requested only for channels on
  screen, a few at a time, and cached for 30 minutes.
- **Other playlists:** if the playlist header names an XMLTV guide (`url-tvg` or `x-tvg-url`), the app streams it,
  gunzips it if needed, and keeps only this playlist's channels for the next 24 hours.

## Local stations (one city, every network)

Providers list the local ABC, CBS, NBC, FOX, PBS, CW (and Telemundo, Univision, ION, MyNetworkTV and a few
over-the-air sub-networks) station of every city, often hundreds under one "ABC" folder. Set **Settings → Playlists
→ Local stations** to your city ("Austin") or call signs ("KVUE, KXAN") and only your city's stations are kept, in
every network folder, on the phone and the TV. National channels (FOX News, CBS Sports, ESPN) are untouched, and a
station that names no city is kept only for networks where none of your city's stations was found. The setting syncs
with your profile.

The names are tidied and each channel's network and city worked out **once**, as the playlist comes in
(`js/normalize.js`), and saved with the cached playlist, so browsing does no extra work. "Austin" also finds stations
listed only by call sign; add more cities to `MARKET_ALIASES` in `js/normalize.js`.

## Duplicate channels

A provider often lists the same station more than once: in several folders, and as separate HD, FHD, SD, RAW,
60fps or 4K copies ("ESPN HD" in three folders, "ABC KVUE" five times). **Settings → Playlists → Content filter →
Show each channel once** (on by default) merges them as the playlist loads (`js/normalize.js`): channels with the
same tidied name, or the same network and city for local stations, count as one. The copy that is kept is the best
by quality (FHD, then HD, then 4K / UHD / RAW, then unmarked, then SD; "backup" copies last), a starred copy always
wins, and the others stay attached as fallbacks, so if the kept copy will not play the next one is tried. The
count of merged duplicates shows in the list note.

## Profiles and syncing across devices

**Profile** (top of the panel) keeps playlists, favorites, the content filter and the last playlist in step
across your devices: TV, phone, laptop, headset. To set it up:

1. On one device, create a profile (e.g. "Living room"). It starts with what's already on that device.
2. Tap **Link a device**. That shows an 8-character code, valid for 10 minutes and usable once.
3. On the other device, open **Sync → Link this device** and enter the code.

**Linking a TV:** the TV app has no setup forms. A TV with no playlist shows a setup screen; on your phone open the app,
go to **Sync → Link a TV** and tap the TV (it appears there, or as a banner, when the phone and TV share a Wi-Fi network;
otherwise scan the styled QR on the TV with the phone's camera, which opens the app and offers to link that TV; the
8-character code under the QR is the last resort). The TV asks "Allow?" and then gets your profile, so playlists you add on the phone appear
on the TV. The profile's secret travels RSA-encrypted to a key that never leaves the TV; the server only matches the two by
a hash of the shared public IP, kept for 10 minutes.

Changes upload a moment after you make them and download when the app opens or comes back into focus. Edits made on
two devices at once are merged, not overwritten. 3D, screen, volume and proxy settings stay per device.

Profiles are end-to-end encrypted. Each has a random secret; the browser derives the profile's ID and an AES-GCM
key from it and only uploads ciphertext. The server (Cloudflare KV, or `data/profiles.json` with `server.js`) never
sees playlists, favorites or Xtream passwords. The secret only passes through the server inside a pairing code, for
up to 10 minutes. Profiles need HTTPS (or localhost). On Cloudflare, the KV namespace is created automatically on
deploy (`wrangler.toml`).

## Home proxy (when Cloudflare can't reach your provider)

The Cloudflare proxy handles stream servers on bare IP addresses and unusual ports itself. `fetch()` refuses those,
so it opens a direct TCP connection instead (`proxy/http-socket.js`). It still can't help when a provider blocks
cloud servers outright, and the playback log says when that's the case. The fix then is to run the proxy at home,
so your provider sees your home connection, like any IPTV app would.

1. On a computer at home (Windows, Mac or Linux with [Node 22.15+](https://nodejs.org)):
   ```bash
   git clone https://github.com/Jodeit/Iptv && cd Iptv
   node server.js
   ```
2. Give it an HTTPS address so the Quest can use VR. Install
   [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   (`winget install Cloudflare.cloudflared` or `brew install cloudflared`), then in a second terminal run:
   ```bash
   npm run tunnel        # = cloudflared tunnel --url http://localhost:8080
   ```
   It prints an address like `https://random-words.trycloudflare.com`. You don't need a Cloudflare account.
3. Open that address in the Quest browser. The app and proxy both run on your computer; the tunnel only carries the
   traffic, so your provider sees your home connection.

Without the tunnel, `http://<computer-ip>:8080` (printed by `server.js`) works on the Quest in the flat browser,
but VR mode needs HTTPS. You can also keep using your Cloudflare app and set **Sources → Proxy URL** to the
tunnel address.

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
| Sources | Xtream `get.php` links, M3U/M3U_PLUS URLs, local `.m3u` files, Xtream Codes login, single stream URLs, iptv-org presets, Reddit/paste.sh source finder |
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
| B | Movies & series gallery |
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
proxy/http-socket.js  HTTP over TCP sockets for hosts the Worker's fetch() refuses (bare IPs, odd ports)
wrangler.toml     Cloudflare deploy config: static app + /proxy Worker
proxy/xtream-demo.js  Built-in demo Xtream panel (demo / demo) for testing
index.html        UI shell + CDN import map
css/style.css     Panel / bar styling (phone layout included)
js/main.js        App state, playlists, settings, UI + keyboard wiring
js/m3u.js         Streaming M3U parser, Xtream link detection + stream alternates
js/xtream.js      Xtream API library: categories, live, movies, series, episodes
js/device.js      Device detection: flat player vs 3D theater
js/mkv/           MKV → fragmented MP4 remuxer (EBML reader, demuxer, MP4 writer, MSE player)
js/flat-stage.js  Flat player for phones and tablets
js/filter.js      Content filter (live regions, movie/series languages)
js/epg.js         Guide data: Xtream short EPG and XMLTV
js/guide-view.js  Guide grid
js/gallery.js     Movies & series poster gallery and preview pages
js/ratings.js     Rotten Tomatoes / IMDb / Metacritic via OMDb, title cleanup, cache
js/similar.js     “More like this”: TMDB recommendations matched against the provider's catalog
js/cache.js       Saved playlist copies (IndexedDB)
js/profiles.js    Profiles: encryption, merge, sync, device linking
proxy/profiles-api.js  Profile storage + pairing API (Worker KV / server.js file)
js/diagnose.js    Stream probe for the playback log
js/stream.js      HLS / MPEG-TS / native playback with fallback
js/theater.js     three.js scene, environments, ambient light, desktop stereo, WebXR sessions
js/xr3d.js        XR3D depth + stereo shader and per-eye screen meshes
js/vr-panel.js    In-headset channel browser and controller rays
```

## Google TV / Android TV app

`android-tv/` is a thin full-screen WebView around the hosted app (default `https://iptv.jodeit.workers.dev`).
Everything on the TV is drawn by `js/tv.js` (switched on by the `TunerTV` user agent token the app adds), so
web changes reach the TV the next time the app opens, with no reinstall. The phone's menus, drawer, guide and
pop-out player are hidden there; setup and settings happen on the phone and sync in.

- **Picture:** always full screen. ▲▼ change channel; OK or ◀ opens Home; ▶ shows what's on. Movies and shows: OK
  pauses, ◀▶ skip, ▲▼ show the progress bar.
- **Home:** one screen over the playing video, with tabs **Channels · On now · Movies · Shows · Phone** (and the
  version tag, which reloads the app). Channels is a group column beside the channel list with what's on now;
  OK plays, **hold OK** adds or removes a favorite. Movies and Shows open the poster gallery. Phone shows sync status,
  your playlists and Unlink. Back returns to the picture; Back on the picture leaves the app.
- **Moving between sections** (a fixed map, so it works from anywhere in a long list): on the tab bar ◀ ▶ walk across
  the tabs and ▼ drops into the list; from the list ◀ goes to the groups and ◀ again goes to the tab bar; ▲ from the
  first row or first group also goes to the tab bar; ▶ from the groups goes back to the list.
- **On now:** the first tab, and the one the TV opens on when the provider has a guide (it falls back to Channels when
  there is none, or the guide turns out to be empty; whichever you choose is remembered). Browse like a cable guide, by what is airing
  right now instead of by the provider's folders: Sports, Movies, News, Kids, Documentary, Music, Shows, each with a
  live count. Rows lead with the programme, then the channel and when it ends; the bar at the bottom adds the
  description. Programmes are classified from the guide's own category when it has one, else from the title and
  description (league names, "vs", movie / news / kids words), else from the channel's name (`js/genre.js`). The
  guide for the whole lineup is read once from the provider's `xmltv.php` where there is one, otherwise channel by
  channel in the background (the column shows progress). The choice is remembered.
- **Background colour:** the plaster behind the glass is a creamy butter by default. Match it to your wall under
  **Settings → Playback → TV background** on the phone (presets or any colour); it syncs with the profile and the TV
  also uses it for the startup splash. Screens render colours cooler than they look to the eye, so pick warmer than
  the wall seems.
- **Load screen:** the Tuner fish cut from oak (grain, soft shadow) on the same plaster, in `img/tuna.svg`, inlined
  in the stylesheet so it is there on the first frame; the Android app shows the same fish on cream (no black
  flash) the moment it starts, which needs the newer APK.
- **Setup:** a TV with no playlist shows a setup screen; link it from your phone (see Profiles above).
- The remote's media keys (play/pause, next/previous, fast-forward/rewind) work everywhere.

1. GitHub → **Actions → Android TV APK → Run workflow** (it also runs on pushes that touch `android-tv/`).
   Optionally set `app_url` to point it at a different deployment.
2. The build also commits the APK to the repo root, so once deployed it is at `https://iptv.jodeit.workers.dev/tuner-tv.apk` (type that into the **Downloader** app on the TV). It is also on the `tv-latest` release and as the **tuner-tv-apk** artifact.
3. On the TV enable *Settings → System → About → Android TV OS build* (tap 7 times), then *Developer options → USB/Network debugging*, and either:
   - `adb connect <tv-ip>:5555 && adb install app-release.apk`, or
   - put the APK on a USB stick / host it and install with the **Downloader** app (allow "Install unknown apps" for it).

To build locally instead: `cd android-tv && gradle :app:assembleRelease [-PappUrl=https://…]` with the Android SDK installed.

## On now: game details, logos and home market

- **Game details:** a guide entry like "College Football" is replaced by the actual game ("Michigan at Ohio State · 3rd 4:12 · 10–14"), matched from ESPN's public scoreboard by league and by the network the channel carries. It is best-effort: with no match or no network the guide's own title stays. Leagues covered: college and pro football, basketball (men's and women's college, NBA, WNBA), MLB, NHL and the main soccer leagues.
- **Logos:** channel logos sit on a warm slate tile, so white logos stay visible on the cream glass.
- **Home market:** other cities' ABC / CBS / NBC / FOX / PBS / CW stations are hidden for the home market, which is **Austin** unless you type another in the content filter (turn "only local stations" off to see everything). Copies of one station (HD / FHD / duplicates in other folders) merge into one.
- **Scoreboard:** On now has a "🏟 Scoreboard" entry listing the live and upcoming games (from the ESPN scoreboard) that one of your channels carries, live games first with the score. Each game is a tile with both teams' logos and scores and the period or clock ("3rd 4:12", "Halftime", "Starts 7:30 PM"); the channel is a small footnote. Press OK on a game to watch it on that channel.
