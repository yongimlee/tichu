import { randomBytes } from 'node:crypto';

// A cryptographically-sourced replacement for Math.random for dealing cards.
// Returns a uniform float in [0, 1) built from 53 random bits (full double
// mantissa), so it plugs straight into shared's Fisher–Yates `shuffle(rng)`
// without changing the game logic. Unlike Math.random it is not predictable
// from observed outputs, which matters once cards are dealt server-side.
export function cryptoRandom(): number {
  const bytes = randomBytes(7); // 56 bits; we use the top 53
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  // Drop the low 3 bits to land on exactly 53 bits, then scale to [0, 1).
  return Math.floor(value / 8) / 2 ** 53;
}
