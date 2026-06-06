import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Card, Suit } from './cards';
import { scoreHand, type GameState } from './game';
import type { Seat } from './room';

function c(rank: number, suit: Suit = 'jade'): Card {
  return { kind: 'suit', suit, rank, id: `${suit}-${rank}` };
}

interface Opts {
  finished: Seat[];
  captured?: Card[][];
  hands?: Card[][];
  grand?: Seat[];
  tichu?: Seat[];
}

function scoringState({ finished, captured, hands, grand = [], tichu = [] }: Opts): GameState {
  return {
    phase: 'scoring',
    players: [0, 1, 2, 3].map((seat) => ({
      seat: seat as Seat,
      hand: hands?.[seat] ?? [],
      grandTichu: grand.includes(seat as Seat),
      tichu: tichu.includes(seat as Seat),
      decidedGrandTichu: true,
      hasPlayed: true,
      exchange: null,
    })),
    undealt: [],
    turn: null,
    leader: 0,
    trick: { plays: [], top: null, owner: null },
    wish: null,
    captured: captured ?? [[], [], [], []],
    finished,
    pendingDragon: null,
    result: null,
  };
}

test('normal end: loser tricks go to first-out, loser hand to opponents', () => {
  const r = scoreHand(
    scoringState({
      finished: [0, 1, 2], // seat 3 is the loser
      captured: [
        [c(10), c(13)], // seat 0 (team A): 20
        [],
        [],
        [c(5), c(5, 'star')], // seat 3 (loser) won 10 -> moves to seat 0
      ],
      hands: [[], [], [], [c(10, 'star')]], // loser still holds a 10 -> 10 to team A
    }),
  );
  assert.deepEqual(r.teamScores, { A: 40, B: 0 });
});

test('Tichu bonus: success adds, failure subtracts', () => {
  const ok = scoreHand(scoringState({ finished: [0, 1, 2], tichu: [0] }));
  assert.equal(ok.teamScores.A, 100); // seat 0 went out first

  const failed = scoreHand(scoringState({ finished: [0, 1, 2], tichu: [1] }));
  assert.equal(failed.teamScores.B, -100); // seat 1 declared but did not go out first
});

test('double victory scores a flat 200 plus any Grand Tichu', () => {
  const r = scoreHand(scoringState({ finished: [0, 2], grand: [0] }));
  assert.equal(r.doubleVictory, true);
  assert.equal(r.teamScores.A, 400); // 200 (double) + 200 (grand tichu)
  assert.equal(r.teamScores.B, 0);
});
