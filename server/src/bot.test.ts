import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCombination,
  type Card,
  type Combination,
  type GameState,
  type Seat,
} from '@tichu/shared';
import { botMove } from './bot';

// Regression coverage for the bot's cooperative/strategic decisions. We build a
// minimal GameState and call botMove directly (seat 1 is always the bot): partner
// sits at seat 3, opponents at seats 0 and 2. Only the fields botMove reads are
// populated, so these are deterministic unit checks, not full-engine simulations.

const suit = (s: 'jade' | 'sword' | 'pagoda' | 'star', rank: number): Card => ({
  kind: 'suit',
  suit: s,
  rank,
  id: `${s}-${rank}`,
});
const DOG: Card = { kind: 'special', name: 'dog', id: 'dog' };
const DRAGON: Card = { kind: 'special', name: 'dragon', id: 'dragon' };

type Decl = 'tichu' | 'grand';

function mkState(opts: {
  hands: [Card[], Card[], Card[], Card[]];
  declared?: Partial<Record<Seat, Decl>>;
  finished?: Seat[];
  top?: Combination | null;
  owner?: Seat | null;
  trickCards?: Card[]; // cards "on the table" for trickPoints; defaults to the top
}): GameState {
  const player = (seat: Seat) => {
    const d = opts.declared?.[seat];
    return {
      seat,
      hand: opts.hands[seat],
      grandTichu: d === 'grand',
      tichu: d === 'tichu',
      decidedGrandTichu: true,
      hasPlayed: true,
      exchange: null,
    };
  };
  const top = opts.top ?? null;
  const owner = opts.owner ?? null;
  const plays =
    top && owner !== null
      ? [{ seat: owner, combo: detectCombination(opts.trickCards ?? top.cards)! }]
      : [];
  return {
    phase: 'playing',
    turn: 1,
    leader: 1,
    undealt: [],
    wish: null,
    captured: [[], [], [], []],
    finished: opts.finished ?? [],
    pendingDragon: null,
    result: null,
    players: [player(0), player(1), player(2), player(3)],
    trick: { top, owner, plays },
  } as unknown as GameState;
}

const move = (s: GameState) => botMove(s, 1);
const single = (c: Card) => detectCombination([c])!;

test('goes out when it can (no Tichu in play)', () => {
  const s = mkState({ hands: [[suit('sword', 4)], [suit('jade', 5)], [suit('pagoda', 8)], [suit('star', 7)]] });
  assert.deepEqual(move(s).play, ['jade-5']); // leads its last card → out
});

test("does not go out first while protecting a partner's Tichu", () => {
  // Bot could go out by leading the pair of 5s; with partner (seat 3) on Tichu it
  // must keep a card instead, so it leads a single.
  const s = mkState({
    hands: [[suit('sword', 4)], [suit('jade', 5), suit('star', 5)], [suit('pagoda', 8)], [suit('star', 7)]],
    declared: { 3: 'tichu' },
  });
  const r = move(s);
  assert.equal(r.play?.length, 1);
});

test("stays passive (passes) while protecting a partner's Tichu", () => {
  const s = mkState({
    hands: [[], [suit('jade', 9), suit('jade', 11)], [], [suit('star', 7)]],
    declared: { 3: 'grand' },
    top: single(suit('sword', 6)),
    owner: 0,
  });
  assert.equal(move(s).pass, true);
});

test('seizes the lead with a cheap card when holding the Dog (partner Tichu)', () => {
  const s = mkState({
    hands: [[], [DOG, suit('jade', 8), suit('jade', 11)], [], [suit('star', 7)]],
    declared: { 3: 'tichu' },
    top: single(suit('sword', 6)),
    owner: 0,
  });
  assert.deepEqual(move(s).play, ['jade-8']); // grabs lead, keeps the Dog
});

test('leads the Dog to hand the lead to the partner (partner Tichu)', () => {
  const s = mkState({
    hands: [[], [DOG, suit('jade', 8), suit('jade', 11)], [], [suit('star', 7)]],
    declared: { 3: 'tichu' },
  });
  assert.deepEqual(move(s).play, ['dog']);
});

test('bombs a valuable trick it cannot otherwise beat', () => {
  const flush = [2, 3, 4, 5, 6].map((r) => suit('jade', r)); // straight-flush bomb
  // The spare star-9 keeps the bomb from being a hand-emptying "go out" play, so we
  // genuinely exercise the bomb-decision branch.
  const s = mkState({
    hands: [[suit('pagoda', 2), suit('pagoda', 3), suit('pagoda', 4)], [...flush, suit('star', 9)], [], []],
    top: single(suit('sword', 13)), // King = 10 points on the table
    owner: 0,
  });
  assert.equal(move(s).play?.length, 5);
});

test('conserves the bomb on a worthless trick', () => {
  const flush = [2, 3, 4, 5, 6].map((r) => suit('jade', r));
  const s = mkState({
    hands: [[suit('pagoda', 2), suit('pagoda', 3), suit('pagoda', 4)], [...flush, suit('star', 8)], [], []],
    top: single(suit('sword', 9)), // 0 points, opponent not near out
    owner: 0,
  });
  assert.equal(move(s).pass, true);
});

test("conserves the Dragon when no opponent has a live Tichu", () => {
  const hand = [DRAGON, suit('jade', 2), suit('jade', 3), suit('jade', 4), suit('jade', 5)];
  const s = mkState({
    hands: [[suit('pagoda', 2), suit('pagoda', 3), suit('pagoda', 4), suit('pagoda', 5)], hand, [], []],
    top: single(suit('sword', 12)), // Queen, only the Dragon beats it
    owner: 0,
  });
  assert.equal(move(s).pass, true);
});

test("spends the Dragon to deny an opponent's live Tichu", () => {
  const hand = [DRAGON, suit('jade', 2), suit('jade', 3), suit('jade', 4), suit('jade', 5)];
  const s = mkState({
    hands: [[suit('pagoda', 2), suit('pagoda', 3), suit('pagoda', 4), suit('pagoda', 5)], hand, [], []],
    declared: { 0: 'tichu' }, // the trick owner (seat 0) declared Tichu
    top: single(suit('sword', 12)),
    owner: 0,
  });
  assert.deepEqual(move(s).play, ['dragon']);
});

test("bombs to deny a low opponent's live Tichu even on a cheap trick", () => {
  const flush = [2, 3, 4, 5, 6].map((r) => suit('jade', r));
  const s = mkState({
    // Seat 0 declared Tichu and is down to 4 cards (≤5) -> deny with the bomb.
    hands: [
      [suit('pagoda', 2), suit('pagoda', 3), suit('pagoda', 4), suit('pagoda', 5)],
      [...flush, suit('star', 9)],
      [],
      [],
    ],
    declared: { 0: 'tichu' },
    top: single(suit('sword', 14)), // Ace, 0 points; only the bomb beats it
    owner: 0,
  });
  assert.equal(move(s).play?.length, 5);
});
