import type { Card, SpecialName, SuitCard } from './cards';

// Combination (족보) detection and comparison.
//
// Given a set of cards this module decides whether they form a legal Tichu
// combination and, if so, produces a `Combination` that can be compared against
// the combination currently leading a trick via `canBeat`.
//
// Special-card handling:
//   - Mahjong  : a real "1", usable as the low end of a straight or as a single.
//   - Dog      : never part of a combination — it is a solo lead handled by the
//                game engine, so `detectCombination` returns null for it.
//   - Phoenix  : wildcard. Fills one missing card in pairs/triples/full houses/
//                straights/stairs, and as a single sits 0.5 above whatever it is
//                played on. It can NOT be part of a bomb.
//   - Dragon   : the highest single; never part of a combination.

/** The legal combination shapes in Tichu. */
export type CombinationType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'fullhouse'
  | 'straight' // 5+ consecutive singles
  | 'stairs' // 2+ consecutive pairs
  | 'bomb' // four of a kind
  | 'straightbomb'; // 5+ consecutive cards of the same suit (straight flush)

export interface Combination {
  type: CombinationType;
  cards: Card[];
  /** Comparison key against same-typed combinations (e.g. top card of a straight). */
  rank: number;
  /** 0 = not a bomb, 1 = four-of-a-kind, 2 = straight bomb. Higher always beats lower. */
  bombLevel: number;
  /** Number of cards, cached for comparisons (straights/stairs must match length). */
  length: number;
}

/**
 * Disambiguation hints for the (rare) cases where the Phoenix could complete a
 * combination in more than one way. Defaults favour the strongest interpretation.
 */
export interface DetectOptions {
  /** Force the top rank of a straight/stairs (the Phoenix fills the rest). */
  desiredTop?: number;
  /** For a {2,2}+Phoenix full house, treat the LOWER pair as the triple. */
  phoenixAsLowerTriple?: boolean;
}

/**
 * Detect which (if any) legal combination a set of cards forms.
 * Returns null if the cards do not form a playable combination.
 */
export function detectCombination(cards: Card[], opts: DetectOptions = {}): Combination | null {
  if (cards.length === 0) return null;
  // The Dog is a solo lead, not a trick combination; the engine handles it.
  if (cards.some((c) => isSpecial(c, 'dog'))) return null;

  const n = cards.length;
  if (n === 1) return detectSingle(cards);
  if (n === 2) return detectSameRank(cards, 2);
  if (n === 3) return detectSameRank(cards, 3);
  if (n === 4) return detectFourBomb(cards) ?? detectStairs(cards);

  // n >= 5: bombs first, then full house, straight, stairs.
  return (
    detectStraightBomb(cards) ??
    detectFullHouse(cards, opts) ??
    detectStraight(cards, opts) ??
    detectStairs(cards)
  );
}

/**
 * Whether `candidate` may legally be played on top of `current` (the combination
 * currently leading the trick). A null `current` means the trick is open and any
 * valid combination may lead.
 */
export function canBeat(candidate: Combination | null, current: Combination | null): boolean {
  if (!candidate) return false;
  if (!current) return true; // leading: any valid combination is allowed

  // Bomb interactions (a bomb may be dropped on any non-bomb).
  if (candidate.bombLevel > 0 || current.bombLevel > 0) {
    if (candidate.bombLevel !== current.bombLevel) return candidate.bombLevel > current.bombLevel;
    // Same bomb level: straight bombs compare by length first, then top rank.
    if (candidate.bombLevel === 2 && candidate.length !== current.length) {
      return candidate.length > current.length;
    }
    return candidate.rank > current.rank;
  }

  // Non-bomb: must match shape and length.
  if (candidate.type !== current.type) return false;
  if (candidate.length !== current.length) return false;

  if (candidate.type === 'single') {
    if (isDragonSingle(current)) return false; // only a bomb beats the Dragon
    const value = isPhoenixSingle(candidate) ? current.rank + 0.5 : candidate.rank;
    return value > current.rank;
  }

  return candidate.rank > current.rank;
}

/**
 * Effective value of a Phoenix played as a single. When leading it is 1.5;
 * otherwise it sits half a rank above the single it is beating. The engine uses
 * this to store the Phoenix's resolved rank after a successful play.
 */
export function phoenixSingleValue(current: Combination | null): number {
  return current ? current.rank + 0.5 : 1.5;
}

export function isBomb(combo: Combination): boolean {
  return combo.bombLevel > 0;
}

// --- detectors -------------------------------------------------------------

function detectSingle(cards: Card[]): Combination | null {
  const c = cards[0];
  if (c.kind === 'special') {
    switch (c.name) {
      case 'dog':
        return null;
      case 'dragon':
        return single(cards, 15);
      case 'phoenix':
        return single(cards, 1.5); // leading value; engine resets it when played on a card
      case 'mahjong':
        return single(cards, 1);
    }
  }
  return single(cards, (c as SuitCard).rank);
}

/** Pair (size 2) or triple (size 3), Phoenix allowed to fill one card. */
function detectSameRank(cards: Card[], size: 2 | 3): Combination | null {
  if (cards.some(isMahjong)) return null; // Mahjong is single/straight only, never paired
  const phoenixCount = cards.filter(isPhoenix).length;
  if (phoenixCount > 1) return null;
  const others = cards.filter((c) => !isPhoenix(c));
  if (others.length < 1 || others.length + phoenixCount !== size) return null;

  const ranks = others.map(concreteRank);
  if (ranks.some((r) => r === null)) return null; // dragon/dog can't pair
  if (new Set(ranks).size !== 1) return null;

  return {
    type: size === 2 ? 'pair' : 'triple',
    cards,
    rank: ranks[0] as number,
    bombLevel: 0,
    length: size,
  };
}

/** Four of a kind. Beats any non-bomb. Phoenix is not allowed. */
function detectFourBomb(cards: Card[]): Combination | null {
  if (cards.length !== 4 || cards.some(isPhoenix)) return null;
  const ranks = cards.map(concreteRank);
  if (ranks.some((r) => r === null) || new Set(ranks).size !== 1) return null;
  return { type: 'bomb', cards, rank: ranks[0] as number, bombLevel: 1, length: 4 };
}

/** Straight flush of 5+ same-suit consecutive cards. Phoenix/Mahjong not allowed. */
function detectStraightBomb(cards: Card[]): Combination | null {
  if (cards.length < 5 || cards.some((c) => c.kind !== 'suit')) return null;
  const suited = cards as SuitCard[];
  const suit = suited[0].suit;
  if (!suited.every((c) => c.suit === suit)) return null;
  const ranks = suited.map((c) => c.rank).sort((a, b) => a - b);
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return null;
  }
  return { type: 'straightbomb', cards, rank: ranks[ranks.length - 1], bombLevel: 2, length: cards.length };
}

/** Full house: a triple plus a pair (5 cards). Compared by the triple's rank. */
function detectFullHouse(cards: Card[], opts: DetectOptions): Combination | null {
  if (cards.length !== 5) return null;
  if (cards.some(isMahjong)) return null; // Mahjong can't form the pair/triple of a full house
  const phoenixCount = cards.filter(isPhoenix).length;
  if (phoenixCount > 1) return null;

  const others = cards.filter((c) => !isPhoenix(c));
  const ranks = others.map(concreteRank);
  if (ranks.some((r) => r === null)) return null;
  const counts = countByRank(ranks as number[]);
  const entries = [...counts.entries()];
  const values = entries.map(([, c]) => c).sort((a, b) => a - b);

  if (phoenixCount === 0) {
    if (counts.size === 2 && values[0] === 2 && values[1] === 3) {
      const tripleRank = entries.find(([, c]) => c === 3)![0];
      return fullHouse(cards, tripleRank);
    }
    return null;
  }

  // One Phoenix completes either the pair ({3,1}) or the triple ({2,2}).
  if (counts.size !== 2) return null;
  if (values[0] === 1 && values[1] === 3) {
    const tripleRank = entries.find(([, c]) => c === 3)![0];
    return fullHouse(cards, tripleRank);
  }
  if (values[0] === 2 && values[1] === 2) {
    const pairRanks = entries.map(([r]) => r).sort((a, b) => a - b);
    const tripleRank = opts.phoenixAsLowerTriple ? pairRanks[0] : pairRanks[1];
    return fullHouse(cards, tripleRank);
  }
  return null;
}

/** Straight of 5+ consecutive ranks. Mahjong counts as 1; Phoenix fills one gap. */
function detectStraight(cards: Card[], opts: DetectOptions): Combination | null {
  if (cards.length < 5) return null;
  const phoenixCount = cards.filter(isPhoenix).length;
  if (phoenixCount > 1) return null;

  const others = cards.filter((c) => !isPhoenix(c));
  const ranks = others.map(concreteRank);
  if (ranks.some((r) => r === null)) return null; // dragon/dog can't appear
  const rnums = ranks as number[];
  if (new Set(rnums).size !== rnums.length) return null; // duplicates → not a straight

  const n = cards.length;
  const min = Math.min(...rnums);
  const max = Math.max(...rnums);
  if (max - min > n - 1) return null; // cannot fit inside a window of length n

  // Pick the top rank. Default: maximise it (most useful), capped at Ace (14)
  // and keeping the low end >= 1. `desiredTop` overrides when valid.
  let top = Math.min(MAX_RANK, min + n - 1);
  if (opts.desiredTop !== undefined) {
    top = opts.desiredTop;
  } else if (top - n + 1 < 1) {
    top = n; // pin the low end to 1 (Mahjong)
  }
  const low = top - n + 1;
  if (top < max || top > MAX_RANK || low < 1 || low > min) return null;

  return { type: 'straight', cards, rank: top, bombLevel: 0, length: n };
}

/** Stairs: 2+ consecutive pairs (even length 4+). Phoenix fills one card. */
function detectStairs(cards: Card[]): Combination | null {
  if (cards.length < 4 || cards.length % 2 !== 0) return null;
  if (cards.some(isMahjong)) return null; // Mahjong can't be one of the paired ranks in stairs
  const phoenixCount = cards.filter(isPhoenix).length;
  if (phoenixCount > 1) return null;

  const others = cards.filter((c) => !isPhoenix(c));
  const ranks = others.map(concreteRank);
  if (ranks.some((r) => r === null)) return null;
  const counts = countByRank(ranks as number[]);
  for (const c of counts.values()) if (c > 2) return null;

  const distinct = [...counts.keys()].sort((a, b) => a - b);
  const pairs = cards.length / 2;
  if (distinct.length !== pairs) return null;
  for (let i = 1; i < distinct.length; i++) {
    if (distinct[i] !== distinct[i - 1] + 1) return null;
  }

  let missing = 0;
  for (const c of counts.values()) missing += 2 - c;
  if (missing !== phoenixCount) return null;

  return { type: 'stairs', cards, rank: distinct[distinct.length - 1], bombLevel: 0, length: cards.length };
}

// --- helpers ---------------------------------------------------------------

const MAX_RANK = 14;

function single(cards: Card[], rank: number): Combination {
  return { type: 'single', cards, rank, bombLevel: 0, length: 1 };
}

function fullHouse(cards: Card[], tripleRank: number): Combination {
  return { type: 'fullhouse', cards, rank: tripleRank, bombLevel: 0, length: 5 };
}

function isSpecial(c: Card, name: SpecialName): boolean {
  return c.kind === 'special' && c.name === name;
}

function isPhoenix(c: Card): boolean {
  return isSpecial(c, 'phoenix');
}

function isMahjong(c: Card): boolean {
  return isSpecial(c, 'mahjong');
}

function isPhoenixSingle(combo: Combination): boolean {
  return combo.type === 'single' && isPhoenix(combo.cards[0]);
}

function isDragonSingle(combo: Combination): boolean {
  return combo.type === 'single' && isSpecial(combo.cards[0], 'dragon');
}

/** Rank usable inside a numeric combination; Mahjong = 1; null for dragon/dog/phoenix. */
function concreteRank(c: Card): number | null {
  if (c.kind === 'suit') return c.rank;
  if (c.name === 'mahjong') return 1;
  return null;
}

function countByRank(ranks: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of ranks) m.set(r, (m.get(r) ?? 0) + 1);
  return m;
}
