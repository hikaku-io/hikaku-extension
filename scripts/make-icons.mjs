// Draws the Hikaku mark and writes the extension icons plus an SVG master.
//
// The mark is a circle split down the middle: the left half is solid, the right
// half is just an outline. One side is "the real thing", the other is "what it
// claims to be", which is the whole idea behind the name (hikaku means
// "comparison"). It's drawn from geometry rather than traced from an image so it
// stays crisp at 16 px.
//
// Run once after changing the design. Output is committed in icons/.
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const INK_BLUE = [82, 119, 156]; // visible on light and dark browser toolbars

// Proportions, relative to the icon size. Small sizes get minimums so the gap
// and the ring don't disappear at 16 px.
function geometry(size) {
  return {
    c: size / 2,
    r: size * 0.44,
    ring: Math.max(size * 0.12, 1.7),
    gap: Math.max(size * 0.075, 1.2),
  };
}

function inMark(x, y, g) {
  const d = Math.hypot(x - g.c, y - g.c);
  if (d > g.r) return false;
  if (x < g.c - g.gap / 2) return true; // solid left half
  if (x > g.c + g.gap / 2) return d >= g.r - g.ring; // outlined right half
  return false;
}

for (const size of [16, 32, 48, 128]) {
  const png = new PNG({ width: size, height: size });
  const g = geometry(size);
  const SS = 6; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inMark(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, g)) hits++;
        }
      }
      const i = (y * size + x) * 4;
      png.data[i] = INK_BLUE[0];
      png.data[i + 1] = INK_BLUE[1];
      png.data[i + 2] = INK_BLUE[2];
      png.data[i + 3] = Math.round((255 * hits) / (SS * SS));
    }
  }
  writeFileSync(join(OUT, `icon${size}.png`), PNG.sync.write(png));
}

// SVG master for the website, README and anywhere else that needs to scale.
const g = geometry(128);
const left = g.c - g.gap / 2, right = g.c + g.gap / 2;
const yAt = (x) => Math.sqrt(g.r * g.r - (x - g.c) ** 2); // half-chord height at x
const rIn = g.r - g.ring;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Hikaku">
  <path fill="#52779c" d="M${left} ${(g.c - yAt(left)).toFixed(2)} A${g.r} ${g.r} 0 0 0 ${left} ${(g.c + yAt(left)).toFixed(2)} Z"/>
  <path fill="#52779c" fill-rule="evenodd" d="M${right} ${(g.c - yAt(right)).toFixed(2)} A${g.r} ${g.r} 0 0 1 ${right} ${(g.c + yAt(right)).toFixed(2)} L${right} ${(g.c + Math.sqrt(rIn * rIn - (right - g.c) ** 2)).toFixed(2)} A${rIn} ${rIn} 0 0 0 ${right} ${(g.c - Math.sqrt(rIn * rIn - (right - g.c) ** 2)).toFixed(2)} Z"/>
</svg>
`;
writeFileSync(join(OUT, 'logo.svg'), svg);
console.log(`Icons written to ${OUT}`);
