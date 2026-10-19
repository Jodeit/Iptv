// What kind of device this is, and whether it should get the flat player or the 3D theater.

const ua = navigator.userAgent;

export const device = {
  // iPadOS reports itself as a Mac; touch support gives it away.
  ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  headset: /OculusBrowser|Quest|Pico|Wolvic/i.test(ua),
  get android() { return /Android/i.test(ua) && !this.headset; },
};

// setting: 'auto' | 'flat' | 'theater'. Auto gives phones and tablets without WebXR a plain
// video player: the 3D theater has nothing to offer them and costs memory and battery.
// (Vision Pro looks like an iPad but supports immersive VR, so it keeps the theater.)
export async function preferFlat(setting = 'auto') {
  if (setting === 'flat') return true;
  if (setting === 'theater') return false;
  if (!device.ios && !device.android) return false;
  try {
    if (await navigator.xr?.isSessionSupported('immersive-vr')) return false;
  } catch { /* no WebXR */ }
  return true;
}
