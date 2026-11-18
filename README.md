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

The gallery's **Service** filter recognizes common streaming-service labels in titles and playlist categories/folders
(for example Netflix, Prime Video and Disney+). Its choices are collected across the movie or show folders, so a
combined folder such as “HBO Amazon Prime” contributes separate **HBO** and **Prime Video** options. Choosing one
filters the current category, or all categories when searching. It uses only labels present in the provider's data;
it does not verify a title's availability on a service.

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

The gallery also has **Picked for you** shelves for movies and series. They use your favorites and recent viewing
history as seeds, combine TMDB recommendations across those titles, and omit anything you have already favorited
or watched. Picks are limited to titles in your provider's catalog and use the same TMDB key.

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

#### Failure modes

The demo panel can also break on purpose, to test how the app copes with real providers. It answers `player_api.php`
as well as `get.php`. Under **Xtream Codes**, use this app's address as the server and the password `demo`; the
username sets how the whole panel behaves:

| Username  | Behaviour                                                            |
|-----------|----------------------------------------------------------------------|
| `demo`    | Healthy                                                              |
| `expired` | Account expired: lists still load, every stream is refused (403)     |
| `banned`  | Account banned: same, with status "Banned"                           |
| `maxed`   | At its connection limit (2 of 2): every stream is refused (403)      |
| `slow`    | Every response takes 6 s                                             |
| `down`    | Panel offline: 503 for everything                                    |
| `captcha` | A bot-check web page instead of the playlist or API JSON             |
| `noapi`   | No `player_api.php` (404), so the app falls back to `get.php`        |
| any other | Wrong login (`auth: 0` from the API, 401 from `get.php`)             |

Every account also has a **Demo | Faults** category whose channels each fail one way: 404, 403, 502, 503 half the
time, no answer for 60 s, an 8 s wait before playing, a web page instead of a stream, a redirect loop, an empty
playlist, a live stream that stops updating after 30 s, one whose segments go missing after 20 s, and one that's
cut off with a 403 after 60 s. The last three are live HLS made from Big Buck Bunny's segments, so they need the
server to reach `test-streams.mux.dev`.

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
proxy/xtream-demo.js  Built-in demo Xtream panel (demo / demo) with failure modes for testing
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

- **Picture:** always full screen. ▲ opens playback controls; on live TV, press ▲ again to open the guide. OK toggles
  playback, and Movies and Shows use ◀▶ to seek 10 seconds.
- **Home:** one screen over the playing video, with tabs **Live · Movies · Shows · Settings** (and the
  version tag, which reloads the app). Live opens the On Now guide by default; activate the selected Live tab again
  to toggle between On Now and the channel list. When shown, the channel list has groups beside it;
  OK plays, **hold OK** adds or removes a favorite. Movies and Shows open the poster gallery. Settings shows sync
  status, your playlists and Unlink. Back returns to the picture; Back on the picture leaves the app.
- **Moving between sections** (a fixed map, so it works from anywhere in a long list): on the tab bar ◀ ▶ walk across
  the tabs and ▼ drops into the list; from the list ◀ goes to the groups and ◀ again goes to the tab bar; ▲ from the
  first row or first group also goes to the tab bar; ▶ from the groups goes back to the list.
- **Live / On Now:** the Live tab opens this view when the provider has a guide (it falls back to the channel list when
  there is none, or the guide turns out to be empty; whichever Live view you choose is remembered). Browse like a cable guide, by what is airing
  right now instead of by the provider's folders: Sports, Movies, News, Kids, Documentary, Music, Shows, each with a
  live count. Rows lead with the programme, then the channel and when it ends; the bar at the bottom adds the
  description. Programmes are classified from the guide's own category when it has one, else from the title and
  description (league names, "vs", movie / news / kids words), else from the channel's name (`js/genre.js`). The
  guide for the whole lineup is read once from the provider's `xmltv.php` where there is one, otherwise channel by
  channel in the background (the column shows progress). The choice is remembered.
- **Background colour:** the plaster behind the glass is a creamy butter by default. Match it to your wall under
  **Settings → Playback → TV background** on the phone (presets or any colour), or choose a preset/custom colour in
  the TV's Settings tab, where the hue, saturation and lightness can be adjusted with the remote; it syncs with the
  profile. **Advanced settings** opens the full settings workspace on the TV. The selected wall colour also fills the
  video letterbox, while stronger panel and guide-window shadows make the glass sections stand out. The TV uses it
  for the startup splash too. Screens render colours cooler than they look to the eye, so pick warmer than the wall seems.
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

### Meta Quest app

`tuner-quest.apk` (source in `android-quest/`) is a native Quest app built on the Meta Spatial SDK. It opens as its own app (library → Unknown Sources), not in the browser.

- **Browse:** the hosted Tuner page in a panel in front of you. When it runs inside this app it hands playback to the headset instead of its own `<video>` (`playQuest` in `js/main.js`).
- **Play:** Media3 ExoPlayer decodes straight to a video surface in the compositor, direct from the provider (no CORS proxy). HLS, MPEG-TS, MP4 and MKV, hardware HEVC/AV1/H.264, and the FFmpeg decoder for AC-3/E-AC-3/DTS/TrueHD audio. Several URLs per channel are tried in order.
- **Space:** passthrough (mixed reality) on/off, a screen you can make larger/smaller and move closer/farther/up/down, and 2D / SBS / TAB stereo from the control bar under the screen.
- **Not yet:** XR3D (the 2D→3D shader runs in WebGL only, so it plays as 2D here; SBS/TAB channels do get real 3D), curved screen, custom environments, subtitles/audio-track picker, and resume points are not saved back to the page.
- **Install:** enable Developer Mode in the Meta Horizon phone app, then `adb install tuner-quest.apk` over USB (or SideQuest), or `https://iptv.jodeit.workers.dev/tuner-quest.apk`.
- **Build:** Android SDK 35, Java 17+, Gradle 8.7+: `cd android-quest && ANDROID_HOME=… gradle --no-daemon :app:assembleRelease [-PappUrl=https://…]`. Same signing key as the TV app. Written without a headset to test on, so expect rough edges.

To build locally instead: `cd android-tv && gradle :app:assembleRelease [-PappUrl=https://…]` with the Android SDK installed.

## Live: game details, logos and home market

- **Game details:** a guide entry like "College Football" is replaced by the actual game ("Michigan at Ohio State · 3rd 4:12 · 10–14"), matched from ESPN's public scoreboard by league and by the network the channel carries. It is best-effort: with no match or no network the guide's own title stays. Leagues covered: college and pro football, basketball (men's and women's college, NBA, WNBA), PGA and LPGA golf, MLB, NHL and the main soccer leagues.
- **Logos:** channel logos sit on a warm slate tile, so white logos stay visible on the cream glass.
- **Home market:** other cities' ABC / CBS / NBC / FOX / PBS / CW stations are hidden for the home market, which is **Austin** unless you type another in the content filter (turn "only local stations" off to see everything). Copies of one station (HD / FHD / duplicates in other folders) merge into one.
- **Scoreboard:** Live's On Now view has a "🏟 Scoreboard" entry listing the games and golf leaderboards (from ESPN) carried by your channels, grouped by sport. Within each sport, live games come first, followed by later games and finals. Game tiles show both teams' logos and scores; golf tiles show the tournament's top five, position and score. Press OK on a tile to watch it on that channel.
- **Drawer:** moving right into the channel or game list tucks the category column into a thin drawer (◀), giving the list the full width; moving left reopens it. The Scoreboard has no bottom info bar, since each tile already says everything.
- **Scoreboard grid:** games are tiles, three across (period or clock on top, both teams with logos and scores below, the network small in the corner). ◀ ▶ ▲ ▼ move between tiles; ◀ from the left column opens the categories.
- **Films on now:** the Movies category is a grid of poster tiles with the Rotten Tomatoes score (IMDb rating if there is no tomatometer), title, network and end time. Posters and scores come from OMDb using the key in your profile (Settings → Sync on the phone), so without a key the tiles show the title on a plain card. A long programme on a movie network (HBO, Showtime, Cinemax, Starz, TCM…) of 80 minutes or more counts as a film even when the guide gives no genre; hour-long series on the same channels stay under Shows.
- **Guide window:** pressing ◀ (or OK) while a channel plays opens the guide with the picture carrying on in a window on the right, with the channel and programme under it. Pick a channel to switch; move right from the guide list to focus the picture and press OK to return to full-screen playback. Back also returns to the full picture.
- **Scoreboard sections:** each sport has its own section, with live games first, then later games, finals and (when requested) tomorrow's games. Point spread and over/under are shown from ESPN's odds feed when available. ▼ at the bottom of a list stays on the last item.
- **Other countries' copies:** when you have a channel's US copy, copies tagged LAT / LATAM / MX / BR / UK / CA / AR (in the name or folder) are dropped, not even kept as fallback streams, so a game never lands on a Latin-American or UK feed. Channels with no US twin (a UK-only channel, say) are left alone.
- **Movies and Shows:** the same layout as the films in On now. The left panel holds the filters (sort, rating, year, age rating; press OK on one to cycle it) and one list of categories (genres, "Classics", "IMDB Top 500"; press the chosen one again to see everything). Anything you are part-way through is the first tile in the grid; the grid is poster tiles with the Tomatometer (or the provider's rating) and a progress bar for anything part-watched. OK opens the title's page (details, resume, seasons and episodes); Back returns to the same tile. Hold OK to favorite. The TV no longer shows the "N channels" notice when a playlist loads.
- **Tuner view (iPhone, iPad, any browser):** the TV interface, adapted for touch, is now the default on iPhone and iPad (open `?ui=tuner` or `?ui=classic` anywhere to switch; the choice is remembered). It has the same tabs (Live, Movies, Shows, Settings); activate Live again to toggle between On Now and Channels. It includes the scoreboard and poster tiles, category filters, title pages, episode chooser and controls bar. Tap a tile to play, press and hold to favorite, tap the picture for the controls (pause, seek, audio, captions, episodes, guide), **☰ Menu** over the picture opens the main menu, and **✕ Picture** / **‹ Back** go back. Categories sit in a scrolling strip above the tiles on a phone and in a column on an iPad. **Settings → All settings & playlists** opens the classic page (playlists, filters, API keys, sync); its top bar has a **Tuner view** button to come back. The linking QR screen is skipped here. First cut: needs a try on real iOS devices.
- **Settings tab:** (formerly Phone) shows the sync status and actions, then your profile's playlists as a plain vertical list (▲▼ to move, OK to load; the one showing is marked).
  Choosing a playlist keeps the menu open, shows "Loading…" on it, then lands on its channel list with a "Loaded “name” · N channels" notice (no more "Pick a channel" screen).
- **Back and ◀:** while watching, **◀** opens the guide (the list with the show in a window) and **Back** opens the main menu (full width, no window); Back from either returns to the picture. With nothing playing, Back from the menu leaves the app.
- **One flat list:** the TV's Movies and Shows tabs ignore the provider's folder tree. Every folder matching the **Folders to flatten** setting (Settings → Content filter on the phone; default `VOD | EN*, VOD | IMDB TOP 500, SRS | EN*`, where a trailing `*` matches anything after) is loaded and merged into one list, with titles that appear in several folders shown once. The rest of each folder's name becomes a filter in the left panel: "VOD | EN Action" gives the genre **Action**, and "VOD | IMDB TOP 500" gives the collection **IMDB Top 500**. If nothing matches the setting, the first 60 folders are used instead; leave the setting empty to use every folder.
- **A title's page:** OK on a movie or show opens a page built for the remote instead of the phone's gallery view: poster, year, runtime, genre, Tomatometer / IMDb / Metacritic, plot, director and cast. A film has **Play** (or **Resume 42:10** and **From the start**); a show has **Continue S02E03** (or Next / Play S01E01), a row of **Season** buttons and the episode list for the chosen season with each episode's title, plot, length or progress. ▲▼◀▶ move between them, OK plays, Back returns to the same tile in the grid.
- **Scoreboard days:** today's slate shows live games, then later today (with the spread), then finished games with their final scores (winner in bold). Tomorrow's games only load when you press **Show tomorrow's games** at the end of the list.
- **Right channel for a game:** ESPN+ channels (a name with `+`, or a folder with PLUS in it) are matched to ESPN+ games, not ESPN; a channel named "ESPN 1" counts as ESPN, and when two of your channels carry the same game the numbered feed is used. ESPN+ copies also lose out when same-named channels are merged. Playing a game tile plays the real channel.
- **Main menu vs guide:** the picture window appears in the Live view. Movies, Shows and Settings are the full-width menu, and Back from a title's page returns to it.
- **Search on TV:** the Search tab finds live channels, movies and shows together, ranked by title before group, genre and guide-programme matches. Movie and show results use the same primary-folder selection as their tabs. Search catalogs load on the first submitted query and are reused for the active playlist. Focus the search box and use the microphone on the Chromecast's on-screen keyboard for voice entry when the keyboard offers it; press Search or Enter to run the query.
- **While watching:** ▲ opens the playback controls without pausing; on live TV, press ▲ again to open the guide. ▼ opens the playing channel's folder in the guide, and ◀ still opens the guide directly. On Movies and Shows, OK toggles playback and ◀▶ seek 10 seconds. The remote's Channel Up/Down buttons still zap directly.
- **Loading Movies and Shows:** the grid appears as soon as the first folder has loaded (the small curated ones like IMDB Top 500 go first) and the rest keep loading in the background: the left panel shows "Loading more · 7 of 24 folders", the genres and counts grow, and new titles are added to the end of the grid without moving your cursor. A faint placeholder grid shows until the first titles arrive.
- **Playback controls:** the bar has **⏪ 10 s**, **Pause/Resume**, **⏩ 10 s**, **Audio**, **Captions** and, for live TV, **Guide**. Films and episodes show a progress bar; live shows how far behind live you are when the stream keeps a buffer to rewind into (otherwise ⏪ ⏩ are greyed out). **Audio** lists the alternate audio tracks of an HLS stream and **Captions** its subtitle tracks plus any embedded closed captions; a stream that carries a single track shows it greyed out. OK toggles playback or picks the focused item, Back goes up a menu level or closes the bar without changing playback.
- **Age rating filter:** Movies cycle *Up to G / PG / PG-13 / R* and Shows *Up to TV-Y / TV-G / TV-PG / TV-14 / TV-MA*. Ratings are the US ones from TMDB (needs the TMDB key in Settings → Sync on the phone; looked up in the background, 16 at a time, and cached on the device and in your profile). A rating that is found stays cached; titles with no US rating are retried after a week. Popularity used for sorting still refreshes every 30 days. Titles whose rating is not known yet are hidden while the filter is on, and the list fills in as ratings arrive ("Checking age ratings · 1,230 of 4,800" in the left panel). The favorites and hide-watched filters are gone from the TV.
- **No sound detection and Info:** if a stream has been playing a few seconds with the volume up and the browser has decoded no audio at all, a red notice says so, and **Info** in the controls bar (centre button) shows why: the playback engine, picture size, whether audio is being decoded, anything the player reported (for example an MKV whose DTS or TrueHD track can't be played), and what the stream actually contains (container, video and audio codecs, read from its first bytes). Chromium's decoded-audio counter is what makes this possible; on a browser without it the notice is skipped.
- **Audio the TV cannot decode (E-AC-3, AC-3, DTS, TrueHD) in Matroska files:** when the built-in player decodes no sound from an `.mkv` for a few seconds, the app replays it through its own MKV engine from the same position and converts the audio to AAC (stereo downmix) on the fly. The decoder is FFmpeg compiled to WebAssembly (`@ffmpeg/core`, about 32 MB), downloaded once from a CDN in a Web Worker when first needed and cached by the browser; each cluster of audio (a few seconds) is converted with two frames of lead-in so chunk boundaries are seamless. Seeking, pausing and subtitles work as for any MKV; if the MKV engine can't take the file (for example its video codec) the built-in player is restored, silent as before. Other containers (MP4, TS) are not covered.
- **Stream info:** OK, then Info shows a card: what is playing it (and whether audio was converted), picture size, whether sound is being decoded, the file's container and what it contains (video, audio, subtitles), and notes. Names in the controls bar and the banner drop the language tag ("EN - Stick - S02E03 - …" shows as **Stick** with *S02E03 · …*).
- **Buttons:** the controls bar, its menus and the title page use one slim pill style in the house colours: thin line icons instead of emoji, cream pills with an oak main action, and an espresso fill on whatever has focus.
- **Episode chooser:** while an episode is playing, the controls bar (centre button) has an **Episodes** button showing the current season and episode. It opens a card with the show's seasons as pills and its episodes below, the current one marked "Now playing", watched ones ticked and part-watched ones with progress. ▲▼ move, ◀▶ switch season, OK plays the episode (resuming where you left off) and closes the bar.
- **Age ratings are remembered:** each title's rating is looked up once and kept on the TV itself (a table in browser storage with no size limit, read once per session), as well as in your profile (which keeps only the newest 6,000 titles). A rating that was found stays cached; a title with no US rating is asked again after a week. Opening the Age filter fills in everything already known at once and only looks up the rest.
- **If the audio fix does not take:** the decoder download starts as soon as the silence is noticed (in parallel with the switch), the MKV engine is given up to 2.5 minutes to start instead of 15 seconds when it is asked to convert audio (the loading screen says "Loading the audio decoder"), and the decoder stays loaded for the next episode. If the MKV engine still cannot take the file, Info (OK, then Info) shows a **Last problem** row with its reason (for example that the video codec is not supported in this mode).
- **App diagnostics:** the server log includes playback problems and performance timings for profile syncs, playlist loads and category loads. These performance events include durations, counts and outcomes, but not playlist URLs or names, category names or media titles. The server keeps the latest 300 events for two weeks. Read them at **`/logs`** (plain text, newest first; e.g. `https://iptv.jodeit.workers.dev/logs`); at most 40 events are sent per session. To keep the page private set a `LOG_READ_KEY` variable on the Worker and open `/logs?key=…`.
- **Audio decoder:** `@ffmpeg/core` 0.12.10 now ships with the app in `decoder/` (the `.wasm` is in four 8 MB parts, because one file that size is over Cloudflare's per-file limit). The first time it is needed it is fetched from the app's own address, checked to really be WebAssembly, and kept in the browser's Cache Storage (the app also asks the browser to keep it permanently), so later sessions read it from the device. unpkg and jsDelivr remain as a fallback. The Info card and server log say whether it was "saved on this device" or downloaded. If conversion fails, the audio track is dropped and the video plays without sound instead of stalling.
- **Browsers that claim E-AC-3 support:** some TV browsers (a Chromecast with Google TV was seen) report that they can play E-AC-3 but decode no sound. When the built-in player has just proved the audio silent, the MKV engine is told to convert AC-3 / E-AC-3 / DTS / TrueHD anyway instead of trusting that claim. The problem log also records the MKV engine's setup line (video and audio codecs it chose) and the video element's state when an engine gives up.
- **Episode list names:** each row shows the episode's own title ("Chip Off the Old Butch") rather than the file name ("EN - Stick - S02E03 - …"); the show and the number are already on the page, and the player bar shows "Stick" with "S02E03 · title".
- **Gap in front of the picture:** after the MKV engine jumps to a position, the data can begin a second or two later than asked (the next keyframe, or one track starting later). The browser does not step over that hole by itself, so the player now does (up to 12 s), and the problem log records each skip and each track's buffered ranges when an engine gives up.
- **This TV remembers it needs the audio conversion:** once the audio fix has worked, any Matroska file whose audio is AC-3, E-AC-3, DTS or TrueHD goes straight to the MKV engine with the conversion forced (a quick look at the file's first bytes decides), instead of playing silent first. The conversion setting also survives a reconnect of the same stream, and the MKV engine falls back to the usual player if it cannot take a file.
- **Refused streams, explained from evidence:** "The provider refused this stream" no longer guesses a connection limit from a status code. When a stream is refused (HTTP 401/403/406/451/456/458, from the player or from what the provider answers when asked directly), the message gives the code, the provider's own words if it sent any, and then what can actually be told apart: for an Xtream account whether it is active, expired or at its connection limit; and whether other streams played earlier this session (so it is probably this stream, not your plan or login) or none did (login, IP lock or the proxy's network). A refusal that only shows up as "format not supported" in the player is now recognised from the provider's answer.
- **Audio decoder restarts:** FFmpeg-in-WebAssembly slowly uses up its memory with every chunk it converts, so on a TV a long episode could end in "memory access out of bounds" and continue without sound. The worker now replaces its decoder instance every 25 chunks and, if a chunk traps, restarts it and retries that chunk once; if that fails too the message includes the chunk size and what FFmpeg said.
- **One tile per title:** Movies and Shows list a film or series once even when the provider has it in several folders, in several qualities (HD, 4K) or under different ids. Copies are matched on the cleaned title and year; the tile keeps the first copy (curated folders such as IMDB Top 500 load first) and picks up any poster, rating or year it lacked, and it shows under every category the copies were filed in. A part-watched copy stays the one in front.
- **Age filter speed:** ratings found for a title are kept on the device (and in the profile) instead of expiring monthly, so later checks only need to look up new titles or titles without a US rating. Results are saved every few seconds as they arrive, and whenever the page is hidden. Lookups start with the titles the grid would show first (your current sort and filters), so the first screens fill in before the rest follow in the background.
- **Age check has no cap; clearer loading note:** the age filter used to stop after 4,000 titles (an arbitrary safety limit); it now works through the whole list, resuming from what is already saved. The left panel's "Loading more · 29 of 29 folders" is now "Still loading titles · N of M categories" and disappears as soon as the last category is in.
- **Building the Android TV APK without GitHub Actions:** the app only needs a new APK when `android-tv/` changes (web changes reach the TV through the Cloudflare deploy). To build one anywhere with Java 17+ and Gradle 8.7+: install the Android command-line tools, run `sdkmanager --licenses` and `sdkmanager "platforms;android-34" "build-tools;34.0.0"`, set `ANDROID_HOME` to that folder, then in `android-tv/` run `gradle --no-daemon :app:assembleRelease -PappUrl=https://iptv.jodeit.workers.dev`. The APK is `android-tv/app/build/outputs/apk/release/app-release.apk` (about 11 MB: it carries the audio decoder). It was built this way in a Claude Code cloud session (the environment must allow `dl.google.com`). Every build is signed with the fixed key in `android-tv/tuner.keystore` (its password is in `android-tv/app/build.gradle.kts`), so a rebuilt APK installs over the previous one on the TV with no uninstall, from any machine or CI. That key is for this sideloaded app only, and sits in a private repo: if the repo is ever made public, replace it (anyone holding it could sign an update the TV would accept). The one-time switch from the old throwaway debug keys needs a single uninstall of the old app.
- **Decoder inside the APK:** the Android TV APK carries the audio decoder (`decoder/` at the repo root, copied into the APK's assets at build time) and the app answers the page's requests for `/decoder/...` from it, so on the TV it is never downloaded at all. Browsers still get it from the Worker. Needs the rebuilt APK (v0.2.0 wrapper with this change); the older APK keeps downloading it once.
