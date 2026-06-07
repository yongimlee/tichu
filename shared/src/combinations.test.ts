import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Card, Suit } from './cards';
import { canBeat, detectCombination, type Combination } from './combinations';

// --- card construction helpers -------------------------------------------

function c(rank: number, suit: Suit = 'jade'): Card {
  return { kind: 'suit', suit, rank, id: `${suit}-${rank}` };
}
const MAHJONG: Card = { kind: 'special', name: 'mahjong', id: 'mahjong' };
const DOG: Card = { kind: 'special', name: 'dog', id: 'dog' };
const PHOENIX: Card = { kind: 'special', name: 'phoenix', id: 'phoenix' };
const DRAGON: Card = { kind: 'special', name: 'dragon', id: 'dragon' };

function detect(cards: Card[]): Combination {
  const combo = detectCombination(cards);
  assert.ok(combo, `expected a valid combination for ${cards.map((x) => x.id).join(',')}`);
  return combo;
}

// --- detection -------------------------------------------------------------

test('singles', () => {
  assert.equal(detect([c(7)]).type, 'single');
  assert.equal(detect([DRAGON]).rank, 15);
  assert.equal(detect([MAHJONG]).rank, 1);
  assert.equal(detect([PHOENIX]).type, 'single');
  assert.equal(detectCombination([DOG]), null); // Dog is not a trick combination
});

test('pairs and triples (incl. Phoenix)', () => {
  assert.equal(detect([c(9), c(9, 'star')]).type, 'pair');
  assert.equal(detect([c(9), PHOENIX]).type, 'pair');
  assert.equal(detect([c(9), c(9, 'star'), c(9, 'sword')]).type, 'triple');
  assert.equal(detect([c(9), c(9, 'star'), PHOENIX]).type, 'triple');
  assert.equal(detectCombination([c(9), c(8)]), null);
  // Mahjong is single/straight only — it can never be paired (incl. with Phoenix).
  assert.equal(detectCombination([MAHJONG, PHOENIX]), null);
  assert.equal(detectCombination([MAHJONG, c(2)]), null);
});

test('full house', () => {
  const fh = detect([c(5), c(5, 'star'), c(5, 'sword'), c(8), c(8, 'star')]);
  assert.equal(fh.type, 'fullhouse');
  assert.equal(fh.rank, 5); // compared by the triple
  // {2,2} + Phoenix -> Phoenix completes the higher pair into the triple.
  const fhP = detect([c(8), c(8, 'star'), c(10), c(10, 'star'), PHOENIX]);
  assert.equal(fhP.type, 'fullhouse');
  assert.equal(fhP.rank, 10);
});

test('straights (incl. Mahjong low end and Phoenix gap)', () => {
  // Mixed suits so a run is a plain straight, not a straight flush.
  const s = detect([c(4, 'jade'), c(5, 'star'), c(6, 'jade'), c(7, 'star'), c(8, 'jade')]);
  assert.equal(s.type, 'straight');
  assert.equal(s.rank, 8);
  assert.equal(detect([MAHJONG, c(2), c(3, 'star'), c(4), c(5, 'star')]).rank, 5);
  const gap = detect([c(4), c(5, 'star'), PHOENIX, c(7), c(8, 'star')]); // Phoenix fills the 6
  assert.equal(gap.type, 'straight');
  assert.equal(gap.rank, 8);
  // Mahjong + Phoenix together IS legal inside a straight (1·2·3·4·Phoenix).
  const mp = detect([MAHJONG, c(2), c(3, 'star'), c(4), PHOENIX]);
  assert.equal(mp.type, 'straight');
  assert.equal(mp.rank, 5);
  assert.equal(detectCombination([c(4), c(5), c(6), c(7)]), null); // too short
});

test('stairs', () => {
  assert.equal(detect([c(5), c(5, 'star'), c(6), c(6, 'star')]).type, 'stairs');
  assert.equal(detect([c(5), c(5, 'star'), c(6), PHOENIX]).type, 'stairs');
  assert.equal(detectCombination([c(5), c(5, 'star'), c(8), c(8, 'star')]), null); // not consecutive
  // Mahjong can't supply a paired rank in stairs or a full house.
  assert.equal(detectCombination([MAHJONG, PHOENIX, c(2), c(2, 'star')]), null);
  assert.equal(detectCombination([MAHJONG, PHOENIX, c(8), c(8, 'star'), c(8, 'sword')]), null);
});

test('bombs', () => {
  const four = detect([c(7), c(7, 'star'), c(7, 'sword'), c(7, 'pagoda')]);
  assert.equal(four.bombLevel, 1);
  const sf = detect([c(4, 'jade'), c(5, 'jade'), c(6, 'jade'), c(7, 'jade'), c(8, 'jade')]);
  assert.equal(sf.type, 'straightbomb');
  assert.equal(sf.bombLevel, 2);
});

// --- comparison ------------------------------------------------------------

test('canBeat: leading and same-type ranks', () => {
  assert.equal(canBeat(detect([c(9)]), null), true); // leading
  assert.equal(canBeat(detect([c(10)]), detect([c(9)])), true);
  assert.equal(canBeat(detect([c(8)]), detect([c(9)])), false);
  assert.equal(canBeat(detect([c(9)]), detect([c(9, 'star')])), false); // ties don't beat
});

test('canBeat: Dragon and Phoenix singles', () => {
  assert.equal(canBeat(detect([DRAGON]), detect([c(14)])), true); // Dragon tops the Ace
  assert.equal(canBeat(detect([PHOENIX]), detect([c(13)])), true); // Phoenix = 13.5
  assert.equal(canBeat(detect([PHOENIX]), detect([DRAGON])), false); // Phoenix cannot beat Dragon
});

test('canBeat: bombs beat non-bombs and each other', () => {
  const four7 = detect([c(7), c(7, 'star'), c(7, 'sword'), c(7, 'pagoda')]);
  const straight = detect([c(4, 'jade'), c(5, 'star'), c(6, 'jade'), c(7, 'star'), c(8, 'jade')]);
  const sf = detect([c(4, 'star'), c(5, 'star'), c(6, 'star'), c(7, 'star'), c(8, 'star')]);
  assert.equal(canBeat(four7, straight), true); // bomb beats a straight
  assert.equal(canBeat(straight, four7), false); // and not the other way
  assert.equal(canBeat(sf, four7), true); // straight flush beats four of a kind
});

test('canBeat: length must match for straights', () => {
  const s5 = detect([c(4, 'jade'), c(5, 'star'), c(6, 'jade'), c(7, 'star'), c(8, 'jade')]);
  const s6 = detect([c(4, 'jade'), c(5, 'star'), c(6, 'jade'), c(7, 'star'), c(8, 'jade'), c(9, 'star')]);
  assert.equal(canBeat(s6, s5), false); // different lengths are incomparable
});
