// Generate PWA icons from the source illustration.
// Run from the web/ workspace:  node scripts/gen-icons.mjs
//
// Outputs into web/public/:
//   icon-192.png            192x192, purpose "any"  — full-bleed illustration
//   icon-512.png            512x512, purpose "any"  — full-bleed illustration
//   icon-512-maskable.png   512x512, purpose "maskable" — logo shrunk into the
//                           80% safe zone, edges padded with the artwork's
//                           background colour so Android's mask never clips it
//   apple-touch-icon.png    180x180 — iOS home-screen icon (full-bleed)
//   favicon-32.png          32x32   — browser tab icon
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'icon', 'icon_512x512.png');
const OUT = join(here, '..', 'public');

async function main() {
  // Full-bleed "any" icons + platform extras.
  await sharp(SRC).resize(192, 192).png().toFile(join(OUT, 'icon-192.png'));
  await sharp(SRC).resize(512, 512).png().toFile(join(OUT, 'icon-512.png'));
  await sharp(SRC).resize(180, 180).png().toFile(join(OUT, 'apple-touch-icon.png'));
  await sharp(SRC).resize(32, 32).png().toFile(join(OUT, 'favicon-32.png'));

  // Maskable: shrink the artwork into the 80% safe zone (≈410px) so Android's
  // mask never clips the title/creatures, and pad with a blurred, brightened
  // copy of the same artwork so the border blends seamlessly into the edges
  // instead of showing a hard colour box.
  const SAFE = Math.round(512 * 0.8); // 410
  const backdrop = await sharp(SRC)
    .resize(512, 512)
    .blur(24)
    .modulate({ lightness: 12 })
    .png()
    .toBuffer();
  const logo = await sharp(SRC).resize(SAFE, SAFE).png().toBuffer();
  await sharp(backdrop)
    .composite([{ input: logo, gravity: 'centre' }])
    .png()
    .toFile(join(OUT, 'icon-512-maskable.png'));

  console.log('icons written to web/public/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
