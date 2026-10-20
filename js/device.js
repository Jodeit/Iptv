// What kind of device this is, and whether it should get the flat player or the 3D theater.

const ua = navigator.userAgent;

export const device = {
  // iPadOS reports itself as a Mac; touch support gives it away.
  ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  headset: /OculusBrowser|Quest|Pico|Wolvic/i.test(ua),
  get android() { return /Android/i.test(ua) && !this.headset; },
};

// setting: 'auto' | 'flat' | 'theater'. Auto gives the plain video player to everything
// except VR headsets (and anything else that can enter immersive VR, like Vision Pro): the
// 3D theater only pays off there, and elsewhere costs memory and battery.
export async function preferFlat(setting = 'auto') {
  if (setting === 'flat') return true;
  if (setting === 'theater') return false;
  if (device.headset) return false;
  try {
    if (await navigator.xr?.isSessionSupported('immersive-vr')) return false;
  } catch { /* no WebXR */ }
  return true;
}
