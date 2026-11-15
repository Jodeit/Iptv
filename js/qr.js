// A QR code drawn as our own SVG: rounded dots, oak finder squares and a small oak fish in the middle, instead of
// the stock black-and-white grid. The matrix comes from qrcode-generator (js/vendor, MIT); error correction Q
// (25% of the code can be unreadable) leaves room for the fish and for some TV glare.

import qrcode from './vendor/qrcode.js';

const FISH = 'M5 16C9 9 19 8 24 14L29 9 27.5 16 29 23 24 18C19 24 9 23 5 16ZM13 10.6 16 6 18.4 10ZM14 21.4 16 25.5 18.4 22Z';

export function styledQr(text, { ink = '#3a2817', oak = '#9a6431', plate = '#fffaf0', logo = true, dot = 0.88, round = 0.3, eyes = true } = {}) {
  const q = qrcode(0, 'Q');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const quiet = 2, size = n + quiet * 2;
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const half = logo ? Math.max(3, Math.round(n * 0.12)) : 0; // the logo covers about 24% of the width
  const mid = (n - 1) / 2;
  const inLogo = (r, c) => logo && Math.abs(r - mid) <= half && Math.abs(c - mid) <= half;

  const dots = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!q.isDark(r, c) || finder(r, c) || inLogo(r, c)) continue;
    const o = (1 - dot) / 2;
    dots.push(`<rect x="${c + quiet + o}" y="${r + quiet + o}" width="${dot}" height="${dot}" rx="${round}"/>`);
  }
  // Finder squares: ring, gap, centre
  const eye = (r, c) => {
    const x = c + quiet, y = r + quiet;
    return `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="1.7" fill="none" stroke="${ink}" stroke-width="1"/>`
      + `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.9" fill="${oak}"/>`;
  };
  const side = (half * 2 + 1) + 0.6, lx = quiet + mid + 0.5 - side / 2, ly = quiet + mid + 0.5 - side / 2;
  const fishSize = side * 0.78, fs = fishSize / 32;
  const mark = logo
    ? `<rect x="${lx}" y="${ly}" width="${side}" height="${side}" rx="${side * 0.22}" fill="${plate}"/>`
      + `<g transform="translate(${lx + (side - fishSize) / 2} ${ly + (side - fishSize) / 2 + side * 0.02}) scale(${fs})"><path fill="${oak}" d="${FISH}"/></g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="geometricPrecision">`
    + `<rect width="${size}" height="${size}" rx="2.2" fill="${plate}"/>`
    + `<g fill="${ink}">${dots.join('')}</g>${eyes ? eye(0, 0) + eye(0, n - 7) + eye(n - 7, 0) : ''}${mark}</svg>`;
}
