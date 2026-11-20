// What kind of device this is, and whether it should get the flat player or the 3D theater.

const ua = navigator.userAgent;

export const device = {
  // iPadOS reports itself as a Mac; touch support gives it away.
  ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  headset: /OculusBrowser|Quest|Pico|Wolvic/i.test(ua),
  get android() { return /Android/i.test(ua) && !this.headset; },
  // Quest Browser (not the native Quest app) showing the Tuner view: see index.html.
  get headsetBrowser() { return typeof window !== 'undefined' && window.__tunerHeadset === 'headset-browser' && !!window.__tunerWeb; },
};

// setting: 'auto' | 'flat' | 'theater'. Auto gives the plain video player to everything
// except VR headsets (and anything else that can enter immersive VR, like Vision Pro): the
// 3D theater only pays off there, and elsewhere costs memory and battery.
export async function preferFlat(setting = 'auto') {
  if (setting === 'flat') return true;
  if (setting === 'theater') return false;
  // Quest Browser's Tuner view is a flat window you point at: the video fills it, with nothing to drag or tilt.
  // The 3D theater (and VR) stays one setting away (Display → 3D theater).
  if (device.headsetBrowser) return true;
  if (device.headset) return false;
  try {
    if (await navigator.xr?.isSessionSupported('immersive-vr')) return false;
  } catch { /* no WebXR */ }
  return true;
}
