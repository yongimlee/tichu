// Tichu deck domain model.
//
// A full deck is 56 cards: 4 suits with ranks 2..14, plus 4 special cards
// (Mahjong, Dog, Phoenix, Dragon). This module is pure data + helpers with no
// runtime dependencies, so it can be reused by the server, the web client, and
// a future mobile client alike.

export type Suit = 'jade' | 'sword' | 'pagoda' | 'star';
export type SpecialName = 'mahjong' | 'dog' | 'phoenix' | 'dragon';

export const SUITS: readonly Suit[] = ['jade', 'sword', 'pagoda', 'star'];

/** Numeric ranks present in every suit. 11=J, 12=Q, 13=K, 14=A. */
export const MIN_RANK = 2;
export const MAX_RANK = 14;

export interface SuitCard {
  kind: 'suit';
  suit: Suit;
  rank: number; // MIN_RANK..MAX_RANK
  id: string; // stable id, e.g. "jade-14"
}

export interface SpecialCard {
  kind: 'special';
  name: SpecialName;
  id: string; // equals the name, e.g. "dragon"
}

export type Card = SuitCard | SpecialCard;

/** Build the full 56-card Tichu deck (unshuffled). */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
      deck.push({ kind: 'suit', suit, rank, id: `${suit}-${rank}` });
    }
  }
  const specials: SpecialName[] = ['mahjong', 'dog', 'phoenix', 'dragon'];
  for (const name of specials) {
    deck.push({ kind: 'special', name, id: name });
  }
  return deck;
}

/**
 * Scoring value of a card when counting captured tricks at the end of a hand.
 * 5 -> 5, 10 & K -> 10, Dragon -> 25, Phoenix -> -25, everything else 0.
 * A full deck sums to exactly 100 points.
 */
export function cardPoints(card: Card): number {
  if (card.kind === 'special') {
    if (card.name === 'dragon') return 25;
    if (card.name === 'phoenix') return -25;
    return 0;
  }
  if (card.rank === 5) return 5;
  if (card.rank === 10 || card.rank === 13) return 10;
  return 0;
}

/**
 * Base ordering value used when comparing single cards.
 * Special cards have fixed positions:
 *   Mahjong = 1 (lowest), Dragon = 15 (above Ace),
 *   Phoenix = wildcard (resolved at play time), Dog = not playable in a trick.
 */
export function baseRank(card: Card): number {
  if (card.kind === 'suit') return card.rank;
  switch (card.name) {
    case 'mahjong':
      return 1;
    case 'dragon':
      return 15;
    case 'phoenix':
      return 0; // resolved relative to the card it is played on
    case 'dog':
      return 0; // leads to partner; never wins a trick
  }
}

/** Display label for a numeric rank: 11→J, 12→Q, 13→K, 14→A, else the number. */
export function rankLabel(rank: number): string {
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] ?? String(rank);
}

/** Fisher–Yates shuffle returning a new array. `rng` is injectable for tests. */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
