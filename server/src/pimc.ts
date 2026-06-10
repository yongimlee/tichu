import {
  createDeck,
  giveDragon,
  pass,
  playCards,
  seatTeam,
  shuffle,
  type Card,
  type Combination,
  type GameState,
  type Seat,
  type TeamId,
} from '@tichu/shared';
import {
  botMove,
  chooseDragonTarget,
  chooseWish,
  enumerateMoves,
  fulfillingMoves,
  type BotMove,
} from './bot';

// Determinized Monte-Carlo (PIMC) search — the "expert" bot.
//
// On its turn the bot enumerates a few candidate moves. For each, it runs many
// *determinizations*: the UNSEEN cards (everything not in our hand and not yet
// played) are dealt at random to the other seats by their known hand counts —
// we never look at their real cards — and the hand is then rolled out to the end
// with the heuristic `botMove` for everyone. The move with the best average
// team-point margin is chosen. A wall-clock budget bounds the work per move, so
// expensive early 14-card leads get few samples and cheap late ones get many.
//
// This module is PURE (no worker/socket deps) so it can run on the main thread
// or inside a worker thread interchangeably.

export interface PimcOptions {
  budgetMs: number; // wall-clock budget per decision
  k: number; // how many cheapest non-go-out moves to consider as candidates
  maxTotal: number; // hard cap on rollouts (so trivial late positions don't spin)
}

export const DEFAULT_PIMC_OPTIONS: PimcOptions = { budgetMs: 500, k: 3, maxTotal: 250 };

/** Worker request/response contracts (kept here so both worker and pool agree). */
export interface PimcRequest {
  id: number;
  state: GameState;
  seat: Seat;
  opts: PimcOptions;
}
export type PimcResponse =
  | { id: number; ok: true; move: BotMove }
  | { id: number; ok: false; error: string };

const SEATS: Seat[] = [0, 1, 2, 3];
const FULL_DECK = createDeck();

function isMahjong(c: Card): boolean {
  return c.kind === 'special' && c.name === 'mahjong';
}

function comboToAction(m: Combination, hand: Card[]): BotMove {
  const play = m.cards.map((c) => c.id);
  if (m.cards.some(isMahjong)) {
    const wish = chooseWish(hand);
    if (wish !== undefined) return { play, wish };
  }
  return { play };
}

/** A small, sensible candidate set: cheapest few + all go-outs + heuristic pick + pass. */
function rootCandidates(state: GameState, seat: Seat, k: number): BotMove[] {
  const hand = state.players[seat].hand;
  const top = state.trick.top;

  if (state.wish !== null) {
    const fulfilling = fulfillingMoves(hand, top, state.wish);
    if (fulfilling.length) return fulfilling.map((m) => comboToAction(m, hand)); // forced; no pass
  }

  const moves = enumerateMoves(hand, top);
  const chosen: Combination[] = [];
  const add = (m: Combination) => {
    if (!chosen.includes(m)) chosen.push(m);
  };
  for (const m of moves) if (m.cards.length === hand.length) add(m); // all go-outs
  for (const m of moves.filter((m) => m.cards.length !== hand.length).slice(0, k)) add(m);

  const actions = chosen.map((m) => comboToAction(m, hand));
  // Always include the heuristic's own choice so PIMC is never worse than it.
  const h = botMove(state, seat);
  if (h.play) {
    const key = [...h.play].sort().join(',');
    if (!actions.some((a) => a.play && [...a.play].sort().join(',') === key)) {
      actions.push({ play: h.play, wish: h.wish });
    }
  }
  if (top) actions.push({ pass: true }); // following → pass is legal here
  return actions.length ? actions : [{ pass: true }];
}

/** Deal the unseen cards to the non-root seats by their counts (no peeking). */
function determinize(state: GameState, rootSeat: Seat, rng: () => number): GameState {
  const clone = structuredClone(state);
  const played = new Set<string>();
  for (const cap of clone.captured) for (const c of cap) played.add(c.id);
  for (const p of clone.trick.plays) for (const c of p.combo.cards) played.add(c.id);
  for (const c of clone.players[rootSeat].hand) played.add(c.id);
  const unseen = shuffle(
    FULL_DECK.filter((c) => !played.has(c.id)),
    rng,
  );
  let idx = 0;
  for (const s of SEATS) {
    if (s === rootSeat) continue;
    const cnt = state.players[s].hand.length;
    clone.players[s].hand = unseen.slice(idx, idx + cnt).map((c) => ({ ...c }));
    idx += cnt;
  }
  return clone;
}

function applyAction(state: GameState, seat: Seat, a: BotMove): void {
  if (a.pass) pass(state, seat);
  else playCards(state, seat, a.play ?? [], a.wish !== undefined ? { wish: a.wish } : {});
}

/** Play the rest of the hand out with the heuristic bot for all seats. */
function rolloutToEnd(state: GameState): void {
  let guard = 0;
  while (state.phase === 'playing' && guard++ < 600) {
    if (state.pendingDragon) {
      const w = state.pendingDragon.winner;
      giveDragon(state, w, chooseDragonTarget(state, w));
      continue;
    }
    const seat = state.turn;
    if (seat === null) break;
    const mv = botMove(state, seat);
    if (mv.pass) pass(state, seat);
    else playCards(state, seat, mv.play ?? [], mv.wish !== undefined ? { wish: mv.wish } : {});
  }
}

function teamMargin(state: GameState, seat: Seat): number {
  const t: TeamId = seatTeam(seat);
  const sc = state.result?.teamScores ?? { A: 0, B: 0 };
  return t === 'A' ? sc.A - sc.B : sc.B - sc.A;
}

/**
 * Choose a move for `seat` by time-budgeted determinized Monte-Carlo search.
 * Does not mutate `state` (every rollout runs on a fresh determinized clone).
 */
export function pimcChooseMove(
  state: GameState,
  seat: Seat,
  opts: PimcOptions = DEFAULT_PIMC_OPTIONS,
  rng: () => number = Math.random,
): BotMove {
  const actions = rootCandidates(state, seat, opts.k);
  if (actions.length === 1) return actions[0];

  const sums = new Array(actions.length).fill(0);
  const counts = new Array(actions.length).fill(0);
  const start = performance.now();
  let n = 0;
  // Round-robin over candidates, one determinization+rollout at a time; the
  // budget is checked before each rollout so a move overruns by at most one
  // rollout. Candidate sample counts differ by at most 1.
  while (n < opts.maxTotal && performance.now() - start < opts.budgetMs) {
    const i = n % actions.length;
    const det = determinize(state, seat, rng);
    applyAction(det, seat, actions[i]);
    rolloutToEnd(det);
    sums[i] += teamMargin(det, seat);
    counts[i]++;
    n++;
  }

  let best = 0;
  let bestAvg = -Infinity;
  for (let i = 0; i < actions.length; i++) {
    const avg = counts[i] ? sums[i] / counts[i] : -Infinity;
    if (avg > bestAvg) {
      bestAvg = avg;
      best = i;
    }
  }
  return actions[best];
}
