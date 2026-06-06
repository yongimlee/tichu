import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  declareGrandTichu,
  declareTichu,
  startHand,
  submitExchange,
  type GameState,
} from './game';
import type { Seat } from './room';

// Deterministic RNG so deals are reproducible.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SEATS: Seat[] = [0, 1, 2, 3];

function allIds(state: GameState): string[] {
  return state.players.flatMap((p) => p.hand.map((c) => c.id));
}

test('startHand deals 8 cards each and holds back 24', () => {
  const state = startHand(seededRng(1));
  assert.equal(state.phase, 'grand-tichu');
  for (const p of state.players) assert.equal(p.hand.length, 8);
  assert.equal(state.undealt.length, 24);
});

test('grand tichu decisions deal the rest and move to exchange', () => {
  const state = startHand(seededRng(2));
  for (const seat of SEATS) declareGrandTichu(state, seat, seat === 0);
  assert.equal(state.phase, 'exchange');
  for (const p of state.players) assert.equal(p.hand.length, 14);
  assert.equal(state.players[0].grandTichu, true);
  assert.equal(state.players[1].grandTichu, false);
});

test('exchange conserves all 56 cards and sets the Mahjong holder as leader', () => {
  const state = startHand(seededRng(3));
  for (const seat of SEATS) declareGrandTichu(state, seat, false);

  // Each player passes their first three cards (one to each opponent/partner).
  for (const seat of SEATS) {
    const [a, b, c] = state.players[seat].hand;
    submitExchange(state, seat, { toLeft: a.id, toPartner: b.id, toRight: c.id });
  }

  assert.equal(state.phase, 'playing');
  for (const p of state.players) assert.equal(p.hand.length, 14);

  const ids = allIds(state);
  assert.equal(ids.length, 56);
  assert.equal(new Set(ids).size, 56, 'no duplicate or lost cards');

  const leaderHand = state.players[state.leader as Seat].hand;
  assert.ok(
    leaderHand.some((c) => c.kind === 'special' && c.name === 'mahjong'),
    'leader holds the Mahjong',
  );
});

test('a small Tichu can be declared during the exchange phase', () => {
  const state = startHand(seededRng(5));
  for (const seat of SEATS) declareGrandTichu(state, seat, false);
  assert.equal(state.phase, 'exchange');
  declareTichu(state, 1);
  assert.equal(state.players[1].tichu, true);
});

test('a small Tichu cannot be declared during the grand-tichu (8-card) phase', () => {
  const state = startHand(seededRng(6));
  assert.equal(state.phase, 'grand-tichu');
  assert.throws(() => declareTichu(state, 0), /선언할 수 없습니다/);
});

test('a player who called Large Tichu cannot also call small Tichu', () => {
  const state = startHand(seededRng(7));
  for (const seat of SEATS) declareGrandTichu(state, seat, seat === 0);
  assert.throws(() => declareTichu(state, 0), /라지 티츄/);
});

test('exchange rejects duplicate or non-owned cards', () => {
  const state = startHand(seededRng(4));
  for (const seat of SEATS) declareGrandTichu(state, seat, false);
  const hand = state.players[0].hand;
  assert.throws(() =>
    submitExchange(state, 0, { toLeft: hand[0].id, toPartner: hand[0].id, toRight: hand[1].id }),
  );
  assert.throws(() =>
    submitExchange(state, 0, { toLeft: 'no-such-card', toPartner: hand[1].id, toRight: hand[2].id }),
  );
});
