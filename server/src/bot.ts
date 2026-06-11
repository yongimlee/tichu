import type { Server } from 'socket.io';
import {
  canBeat,
  cardPoints,
  declareGrandTichu,
  DEFAULT_BOT_DIFFICULTY,
  detectCombination,
  giveDragon,
  nextSeat,
  partnerSeat,
  pass,
  playCards,
  prevSeat,
  submitExchange,
  toPlayerView,
  type BotDifficulty,
  type Card,
  type ClientToServerEvents,
  type Combination,
  type ExchangeSelection,
  type GameState,
  type InterServerEvents,
  type Room,
  type Seat,
  type ServerToClientEvents,
  type SocketData,
} from '@tichu/shared';
import type { RoomManager } from './roomManager';
import type { GameManager } from './gameManager';
import type { PimcPool } from './pimcPool';

// Server-controlled fill players. The driver watches each room and, whenever the
// pending actor is a bot, performs a simple but legal action after a short delay
// so a solo human can play a full game. Strategy is intentionally basic.

type TichuServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** The result of a bot's decision: play these card ids, or pass; optionally wish. */
export type BotMove = { play?: string[]; pass?: true; wish?: number };

const SEATS: Seat[] = [0, 1, 2, 3];
const BOT_DELAY_MS = 700;
// The expert bot's own PIMC computation (~0.5s) already provides "thinking time",
// so its pre-move pause is short — the search fills the rest before the move shows.
const EXPERT_PREDELAY_MS = 150;
// How long to wait before a bot covers a *disconnected human's* turn. Longer than a
// bot's own delay so a quick reconnect (mobile backgrounding, network blip) takes
// control back before the bot steps in, while a real drop doesn't stall the table.
const OFFLINE_TAKEOVER_MS = 8000;

function concreteRank(c: Card): number | null {
  if (c.kind === 'suit') return c.rank;
  if (c.name === 'mahjong') return 1;
  return null;
}

function isPhoenixSingle(combo: Combination): boolean {
  return (
    combo.type === 'single' &&
    combo.cards.length === 1 &&
    combo.cards[0].kind === 'special' &&
    combo.cards[0].name === 'phoenix'
  );
}

/** Legal plays from `hand` against `top` (null = leading), cheapest first. */
export function enumerateMoves(hand: Card[], top: Combination | null): Combination[] {
  const n = hand.length;
  const out: Combination[] = [];
  const seen = new Set<string>();
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: Card[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(hand[i]);
    const combo = detectCombination(subset);
    if (!combo || !canBeat(combo, top)) continue;
    if (isPhoenixSingle(combo)) continue; // never spend the Phoenix as a plain single
    const key = `${combo.type}:${combo.rank}:${combo.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(combo);
  }
  out.sort((a, b) => a.bombLevel - b.bombLevel || a.rank - b.rank || a.length - b.length);
  return out;
}

/**
 * Legal beating combos that *contain a card of the wished rank*, cheapest first.
 * Mirrors the engine's `canFulfillWish` enumeration so the bot's idea of "can I
 * fulfil the wish" never disagrees with the rule check — important because
 * `enumerateMoves` dedups by shape and could otherwise hide the fulfilling
 * variant behind a same-shaped non-fulfilling one.
 */
export function fulfillingMoves(hand: Card[], top: Combination | null, wish: number): Combination[] {
  const n = hand.length;
  const out: Combination[] = [];
  const seen = new Set<string>();
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: Card[] = [];
    let hasWish = false;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.push(hand[i]);
        if (concreteRank(hand[i]) === wish) hasWish = true;
      }
    }
    if (!hasWish) continue;
    const combo = detectCombination(subset);
    if (!combo || !canBeat(combo, top)) continue;
    if (combo.bombLevel > 0) continue; // bombs never bind a wish (mirrors canFulfillWish)
    if (isPhoenixSingle(combo)) continue;
    const key = `${combo.type}:${combo.rank}:${combo.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(combo);
  }
  out.sort((a, b) => a.bombLevel - b.bombLevel || a.rank - b.rank || a.length - b.length);
  return out;
}

type SuitCard = Extract<Card, { kind: 'suit' }>;

/** Card ids that belong to a bomb (four of a kind / straight flush) in `hand`. */
function bombCardIds(hand: Card[]): Set<string> {
  const ids = new Set<string>();
  const suited = hand.filter((c): c is SuitCard => c.kind === 'suit');

  const byRank = new Map<number, SuitCard[]>();
  const bySuit = new Map<string, SuitCard[]>();
  for (const c of suited) {
    const r = byRank.get(c.rank) ?? [];
    r.push(c);
    byRank.set(c.rank, r);
    const s = bySuit.get(c.suit) ?? [];
    s.push(c);
    bySuit.set(c.suit, s);
  }

  for (const group of byRank.values()) if (group.length >= 4) for (const c of group) ids.add(c.id);

  const flush = (cards: SuitCard[]) => {
    if (cards.length >= 5) for (const c of cards) ids.add(c.id);
  };
  for (const group of bySuit.values()) {
    const sorted = [...group].sort((a, b) => a.rank - b.rank);
    let run: SuitCard[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].rank === sorted[i - 1].rank + 1) run.push(sorted[i]);
      else {
        flush(run);
        run = [sorted[i]];
      }
    }
    flush(run);
  }
  return ids;
}

const DRAGON_RANK = 15;
const ACE_RANK = 14;

/** Total point value of the cards currently sitting in the trick. */
function trickPoints(state: GameState): number {
  return state.trick.plays.reduce(
    (total, p) => total + p.combo.cards.reduce((s, c) => s + cardPoints(c), 0),
    0,
  );
}

function isMahjong(c: Card): boolean {
  return c.kind === 'special' && c.name === 'mahjong';
}

/**
 * Choose a lead. Goal: shed many cards at once while keeping high cards and
 * bombs for control. So among bomb-preserving non-bomb leads we drop the
 * *longest* combo, breaking ties by the *lowest* rank, and we avoid leading a
 * bare control single (Dragon / Ace) while better options exist. Returns null
 * only when the hand has no ordinary lead (all bombs / Phoenix), letting the
 * caller fall back.
 */
function chooseLead(moves: Combination[], bombs: Set<string>): Combination | null {
  const nonBomb = moves.filter((m) => m.bombLevel === 0);
  if (!nonBomb.length) return null;

  const keepsBomb = (m: Combination) => m.cards.every((c) => !bombs.has(c.id));
  let pool = nonBomb.filter(keepsBomb);
  if (!pool.length) pool = nonBomb;

  // Hold back a lone Dragon/Ace early — they are better spent winning a trick.
  const isControlSingle = (m: Combination) => m.type === 'single' && m.rank >= ACE_RANK;
  const open = pool.filter((m) => !isControlSingle(m));
  const finalPool = open.length ? open : pool;

  finalPool.sort((a, b) => b.length - a.length || a.rank - b.rank);
  return finalPool[0];
}

/**
 * A Mahjong wish: pressure the table to spend a high card we don't hold, so we
 * never bind ourselves. Returns undefined when we hold every high rank.
 */
export function chooseWish(hand: Card[]): number | undefined {
  const have = new Set(hand.filter((c): c is SuitCard => c.kind === 'suit').map((c) => c.rank));
  for (let r = ACE_RANK; r >= 10; r--) if (!have.has(r)) return r;
  return undefined;
}

/**
 * Decide a bot's play. Priorities: go out if possible → cooperate with a partner's
 * Tichu (don't go out first; use the Dog to hand them the lead) → disrupt an
 * opponent's Tichu (beat the declarer, even spending the Dragon/a bomb) → don't beat
 * your own partner → don't break up a bomb → conserve the Dragon on cheap tricks →
 * otherwise the cheapest beating combo (or pass / bomb only when worth it).
 */
export function botMove(state: GameState, seat: Seat): BotMove {
  const hand = state.players[seat].hand;
  const top = state.trick.top;
  const leading = !top;
  const partner = partnerSeat(seat);

  // Cooperate with a partner's Tichu: their +100/+200 bonus survives only if they
  // go out *first*. While that's still possible (nobody has gone out yet) we must
  // not go out before them, and we play passively to give them room.
  const helpPartnerTichu =
    (state.players[partner].tichu || state.players[partner].grandTichu) &&
    state.finished.length === 0;

  // Disrupt an *opponent's* Tichu: their bonus also requires going out first, so as
  // long as it's still live (and we aren't busy protecting our own partner's) we
  // play to deny — keep going out as the top priority, and when the declarer is the
  // one winning the trick, beat them rather than conserving (see below). Going out
  // first or stripping their control is what cancels the bonus.
  const declaredLiveTichu = (s: Seat) => state.players[s].tichu || state.players[s].grandTichu;
  const leftOpp = nextSeat(seat);
  const rightOpp = prevSeat(seat); // both are opponents (partner sits opposite)
  const denyOppTichu =
    !helpPartnerTichu &&
    state.finished.length === 0 &&
    (declaredLiveTichu(leftOpp) || declaredLiveTichu(rightOpp));
  const ownerIsLiveOppDeclarer =
    state.trick.owner !== null &&
    (state.trick.owner === leftOpp || state.trick.owner === rightOpp) &&
    declaredLiveTichu(state.trick.owner);

  let moves = enumerateMoves(hand, top);
  let mustPlayForWish = false;
  if (state.wish !== null) {
    const fulfilling = fulfillingMoves(hand, top, state.wish);
    if (fulfilling.length > 0) {
      moves = fulfilling;
      mustPlayForWish = true;
    }
  }

  // Protecting a partner's Tichu: drop hand-emptying moves so we never go out first
  // (unless a wish forces our hand).
  if (helpPartnerTichu && !mustPlayForWish) {
    const nonOut = moves.filter((m) => m.cards.length < hand.length);
    if (nonOut.length) moves = nonOut;
  }

  // Going out (emptying the hand) is always worth it — except while protecting a
  // partner's Tichu, where going out first would cancel their bonus.
  const goOut = moves.filter((m) => m.cards.length === hand.length);
  if (goOut.length && !helpPartnerTichu) {
    const pick = goOut.find((m) => m.bombLevel === 0) ?? goOut[0];
    return withWish(pick, hand);
  }

  // Prefer moves that don't break a bomb apart.
  const bombs = bombCardIds(hand);
  const keepsBomb = (m: Combination) => m.bombLevel > 0 || m.cards.every((c) => !bombs.has(c.id));
  const pool = moves.filter(keepsBomb);
  const usable = pool.length ? pool : moves;
  const nonBomb = usable.filter((m) => m.bombLevel === 0);
  const dog = hand.find((c) => c.kind === 'special' && c.name === 'dog');

  // Don't beat your partner if they're currently winning the trick.
  if (!leading && state.trick.owner === partner && !mustPlayForWish) {
    return { pass: true };
  }

  // Protecting a partner's Tichu while following: normally stay passive (pass). But
  // if we hold the Dog, it can be worth spending a *cheap* card to seize the lead —
  // next turn we lead the Dog and hand the lead straight to the partner. That beats
  // sitting on the Dog (it can only be led, so it may otherwise die in our hand).
  // Guards keep the grab cheap (low, small, no bomb) and make sure we'll still hold
  // the Dog plus another card, so the later Dog lead won't make us go out first.
  if (helpPartnerTichu && !leading && !mustPlayForWish) {
    // An opponent who owns the trick and is nearly out threatens to go out *first*,
    // which would bust our partner's (Grand) Tichu. Don't just sit there — beat them
    // with the cheapest move that doesn't make us go out (a bomb only as a last
    // resort, when they're very low).
    const owner = state.trick.owner;
    const oppNearOut =
      owner !== null && owner !== partner && state.players[owner].hand.length <= 5;
    if (oppNearOut) {
      const cheapBeat = nonBomb.find((m) => m.cards.length < hand.length);
      if (cheapBeat) return { play: cheapBeat.cards.map((c) => c.id) };
      const bomb = usable.find((m) => m.bombLevel > 0 && m.cards.length < hand.length);
      if (bomb && state.players[owner].hand.length <= 2) {
        return { play: bomb.cards.map((c) => c.id) };
      }
    }

    // Otherwise spend a cheap card to seize the lead if we hold the Dog (next turn we
    // lead it to hand the partner control); failing that, stay passive and pass.
    const grab = nonBomb[0];
    const worthSeizingLead =
      dog &&
      grab &&
      grab.rank < ACE_RANK &&
      grab.cards.length <= 2 &&
      hand.length - grab.cards.length >= 2;
    if (worthSeizingLead) return { play: grab.cards.map((c) => c.id) };
    return { pass: true };
  }

  if (leading) {
    // Protecting a partner's Tichu and holding the Dog (with a card to spare): lead
    // it to hand the lead straight to the partner so they can go out first.
    if (helpPartnerTichu && dog && hand.length > 1) {
      return { play: [dog.id] };
    }
    const pick = chooseLead(usable, bombs) ?? nonBomb[0] ?? usable[0];
    if (pick) return withWish(pick, hand);
    return { play: [(dog ?? hand[0]).id] };
  }

  const cheapest = nonBomb[0];
  if (cheapest) {
    // Hold the Dragon rather than burn it on a near-worthless trick — but spend it
    // anyway to wrest the lead from an opponent who declared a (still live) Tichu.
    const spendsDragon = cheapest.type === 'single' && cheapest.rank >= DRAGON_RANK;
    const conserveDragon =
      spendsDragon &&
      !mustPlayForWish &&
      trickPoints(state) < 10 &&
      hand.length > 4 &&
      !(denyOppTichu && ownerIsLiveOppDeclarer);
    if (conserveDragon) {
      return { pass: true };
    }
    return { play: cheapest.cards.map((c) => c.id) };
  }

  // No ordinary beating move. Spend a held bomb only when the trick is worth it:
  // enough points are on the table, or the opponent winning it is about to go out.
  // Otherwise keep conserving it. (`usable` is sorted cheapest-first, so the first
  // bomb is the smallest one that still beats the top.)
  if (!mustPlayForWish) {
    const bomb = usable.find((m) => m.bombLevel > 0);
    if (bomb) {
      const owner = state.trick.owner;
      const ownerNearOut =
        owner !== null && owner !== seat && state.players[owner].hand.length <= 2;
      // Spending a bomb to deny an opponent's Tichu (worth ±100/200) is good value,
      // so bomb the declarer once they're getting low even on a cheap trick.
      const denyDeclarerBomb =
        denyOppTichu && ownerIsLiveOppDeclarer && state.players[owner as Seat].hand.length <= 5;
      if (trickPoints(state) >= 10 || ownerNearOut || denyDeclarerBomb) {
        return { play: bomb.cards.map((c) => c.id) };
      }
    }
  }

  if (mustPlayForWish && usable[0]) return { play: usable[0].cards.map((c) => c.id) };
  return { pass: true }; // not worth a bomb (or none) → hold
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * The 짹짹봇 (easy): legal but careless. Leads a random combo, and when following
 * either dawdles (passes) or plays a *random* beating move — so it wastes high
 * cards, breaks its own bombs, even beats its partner. It still honours a Mahjong
 * wish (that's a rule; skipping it would stall the table).
 */
function easyMove(state: GameState, seat: Seat): BotMove {
  const hand = state.players[seat].hand;
  const top = state.trick.top;
  const leading = !top;
  const dog = hand.find((c) => c.kind === 'special' && c.name === 'dog');

  if (state.wish !== null) {
    const fulfilling = fulfillingMoves(hand, top, state.wish);
    if (fulfilling.length) return withWish(pickRandom(fulfilling), hand);
  }

  const moves = enumerateMoves(hand, top);
  if (leading) {
    if (!moves.length) return { play: [(dog ?? hand[0]).id] };
    return withWish(pickRandom(moves), hand);
  }
  if (!moves.length) return { pass: true };
  if (Math.random() < 0.3) return { pass: true }; // sometimes sits on a playable hand
  return { play: pickRandom(moves).cards.map((c) => c.id) };
}

/**
 * The 댕댕봇 (normal): efficient but plain. Goes out when it can, won't beat its
 * partner, leads its longest combo (no finesse), and otherwise plays the cheapest
 * beating move — no Dragon/bomb conservation, no Tichu cooperation/disruption, and
 * it never spends a bomb. A clear step below the full heuristic (주작봇).
 */
function normalMove(state: GameState, seat: Seat): BotMove {
  const hand = state.players[seat].hand;
  const top = state.trick.top;
  const leading = !top;
  const partner = partnerSeat(seat);
  const dog = hand.find((c) => c.kind === 'special' && c.name === 'dog');

  let moves = enumerateMoves(hand, top);
  let mustPlayForWish = false;
  if (state.wish !== null) {
    const fulfilling = fulfillingMoves(hand, top, state.wish);
    if (fulfilling.length) {
      moves = fulfilling;
      mustPlayForWish = true;
    }
  }

  const goOut = moves.filter((m) => m.cards.length === hand.length);
  if (goOut.length) return withWish(goOut.find((m) => m.bombLevel === 0) ?? goOut[0], hand);

  const nonBomb = moves.filter((m) => m.bombLevel === 0);

  // Don't beat your partner if they're currently winning the trick.
  if (!leading && state.trick.owner === partner && !mustPlayForWish) return { pass: true };

  if (leading) {
    const lead = [...nonBomb].sort((a, b) => b.length - a.length || a.rank - b.rank)[0] ?? moves[0];
    if (lead) return withWish(lead, hand);
    return { play: [(dog ?? hand[0]).id] };
  }

  const cheapest = nonBomb[0]; // moves are cheapest-first
  if (cheapest) return { play: cheapest.cards.map((c) => c.id) };
  if (mustPlayForWish && moves[0]) return { play: moves[0].cards.map((c) => c.id) };
  return { pass: true }; // only bombs left → hold (댕댕봇 never spends a bomb)
}

/** The move policy for a heuristic tier. (Expert/PIMC is handled by the driver.) */
function moveFor(difficulty: BotDifficulty): (state: GameState, seat: Seat) => BotMove {
  if (difficulty === 'easy') return easyMove;
  if (difficulty === 'normal') return normalMove;
  return botMove; // 'hard' — and a safe fallback should 'expert' ever reach here
}

/** Attach a Mahjong wish to the play when the chosen combo leads the Mahjong. */
function withWish(pick: Combination, hand: Card[]): { play: string[]; wish?: number } {
  const play = pick.cards.map((c) => c.id);
  if (pick.cards.some(isMahjong)) {
    const wish = chooseWish(hand);
    if (wish !== undefined) return { play, wish };
  }
  return { play };
}

/** Give the Dragon-won trick to the opponent who is furthest from going out. */
export function chooseDragonTarget(state: GameState, seat: Seat): Seat {
  const left = nextSeat(seat);
  const right = prevSeat(seat); // both are opponents (partner sits opposite)
  return state.players[left].hand.length >= state.players[right].hand.length ? left : right;
}

// Note: bots do NOT declare a (small or grand) Tichu. Simulation showed that a
// solo fill-bot — which can't coordinate with its partner to push a declaration
// — goes out first well under 50% of the time even on its strongest hands, so
// the +/-100/200 stake is negative EV at any meaningful frequency. A smart bot
// simply doesn't make a losing bet; it focuses on play quality instead.

/**
 * Exchange: give the two lowest cards to the opponents and a high card to the
 * partner. Never give away bombs or the Dragon/Phoenix/Mahjong.
 */
function chooseExchange(hand: Card[]): ExchangeSelection {
  const value = (c: Card): number => {
    if (c.kind === 'suit') return c.rank;
    return c.name === 'dog' ? 0.5 : 100; // Dog is dead weight; keep the other specials
  };
  const keep = (c: Card) =>
    c.kind === 'special' && (c.name === 'dragon' || c.name === 'phoenix' || c.name === 'mahjong');
  const bombs = bombCardIds(hand);
  const giveable = hand.filter((c) => !keep(c) && !bombs.has(c.id));
  const pool = giveable.length >= 3 ? giveable : [...hand];

  const byLow = [...pool].sort((a, b) => value(a) - value(b));
  const low2 = byLow.slice(0, 2); // → opponents
  const rest = pool.filter((c) => c !== low2[0] && c !== low2[1]);
  const high = [...rest].sort((a, b) => value(b) - value(a))[0]; // best remaining → partner
  return { toLeft: low2[0].id, toPartner: high.id, toRight: low2[1].id };
}

type BotAction =
  | { type: 'grand'; seat: Seat }
  | { type: 'exchange'; seat: Seat }
  | { type: 'dragon'; seat: Seat }
  | { type: 'move'; seat: Seat };

export function pendingBotAction(room: Room, state: GameState): BotAction | null {
  // A seat is auto-played when a bot sits there, or when its human has dropped
  // offline — so a mid-hand disconnect doesn't stall the whole table; a bot covers
  // the turn until they reconnect and take control back.
  const isAuto = (seat: Seat) => {
    const p = room.players.find((pl) => pl.seat === seat);
    return p ? p.isBot || !p.connected : false;
  };
  if (state.phase === 'grand-tichu') {
    const seat = SEATS.find((s) => isAuto(s) && !state.players[s].decidedGrandTichu);
    return seat === undefined ? null : { type: 'grand', seat };
  }
  if (state.phase === 'exchange') {
    const seat = SEATS.find((s) => isAuto(s) && state.players[s].exchange === null);
    return seat === undefined ? null : { type: 'exchange', seat };
  }
  if (state.phase === 'playing') {
    if (state.pendingDragon && isAuto(state.pendingDragon.winner)) {
      return { type: 'dragon', seat: state.pendingDragon.winner };
    }
    if (state.turn !== null && isAuto(state.turn)) return { type: 'move', seat: state.turn };
  }
  return null;
}

/**
 * Tutorial nudge for the rigged bomb bot — teach the bomb *in context*, but not on
 * the opening trick:
 *   • During the FIRST trick it plays normally yet as if the bomb weren't in hand,
 *     so the four-of-a-kind is never broken up — the human sees a clean trick run
 *     its course and learns who wins it, bomb-free.
 *   • From the SECOND trick on (once any trick has been collected) it drops the
 *     bomb at its first legal chance, so the "상대가 폭탄을!" lesson fires.
 * Falls back to the seat's normal policy when there's no bomb to manage.
 */
function tutorialMove(state: GameState, seat: Seat, difficulty: BotDifficulty): BotMove {
  const hand = state.players[seat].hand;
  const bombs = bombCardIds(hand);
  if (bombs.size === 0) return moveFor(difficulty)(state, seat); // nothing to manage

  // A fulfillable wish must be obeyed even if it breaks the bomb (the rules force it).
  const top = state.trick.top;
  if (state.wish !== null && fulfillingMoves(hand, top, state.wish).length > 0) {
    return moveFor(difficulty)(state, seat);
  }

  // Second trick onward: a collected trick means captured cards exist somewhere.
  const aTrickHasResolved = state.captured.some((pile) => pile.length > 0);
  if (aTrickHasResolved) {
    const bomb = enumerateMoves(hand, top).find((m) => m.bombLevel > 0);
    if (bomb) return { play: bomb.cards.map((c) => c.id) };
  }

  // First trick (or no playable bomb yet): decide as if the bomb weren't in hand,
  // so it's preserved intact for a later trick instead of being frittered away.
  const withoutBomb: GameState = {
    ...state,
    players: state.players.map((p, i) =>
      i === seat ? { ...p, hand: p.hand.filter((c) => !bombs.has(c.id)) } : p,
    ),
  };
  return moveFor(difficulty)(withoutBomb, seat);
}

export function applyBotAction(
  action: BotAction,
  state: GameState,
  difficulty: BotDifficulty = 'hard',
  eagerBomb = false,
): void {
  switch (action.type) {
    case 'grand':
      declareGrandTichu(state, action.seat, false); // bots never gamble the stake
      break;
    case 'exchange':
      submitExchange(state, action.seat, chooseExchange(state.players[action.seat].hand));
      break;
    case 'dragon':
      giveDragon(state, action.seat, chooseDragonTarget(state, action.seat));
      break;
    case 'move': {
      const m = eagerBomb
        ? tutorialMove(state, action.seat, difficulty)
        : moveFor(difficulty)(state, action.seat);
      if (m.pass) pass(state, action.seat);
      else playCards(state, action.seat, m.play ?? [], m.wish !== undefined ? { wish: m.wish } : {});
      break;
    }
  }
}

export class BotDriver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Rooms with a step currently in flight. An expert move is async (it awaits a
  // worker thread), so this guards against a second step starting on the same
  // room — e.g. a human's out-of-turn bomb kicking the driver mid-think.
  private busy = new Set<string>();
  // Tutorial rooms whose bots are frozen because a coach message is on screen.
  // While paused, `kick` is a no-op so the game waits at the player's reading pace.
  private paused = new Set<string>();

  constructor(
    private readonly io: TichuServer,
    private readonly rooms: RoomManager,
    private readonly games: GameManager,
    private readonly pool?: PimcPool,
  ) {}

  /**
   * Ask the driver to act for a room if a bot — or a disconnected human's stand-in
   * bot — is up next (debounced per room).
   */
  kick(code: string): void {
    if (this.paused.has(code)) return; // tutorial: a coach message is being read
    if (this.timers.has(code) || this.busy.has(code)) return;
    const room = this.rooms.getRoom(code);
    const state = this.games.getState(code);
    if (!room || !state) return;
    const action = pendingBotAction(room, state);
    if (!action) return;
    // Don't churn a game nobody is watching: if every human has dropped, let the
    // room sit. It resumes on reconnect, or the room manager purges it.
    if (!room.players.some((p) => !p.isBot && p.connected)) return;
    // A real bot moves quickly; covering for an offline human waits longer so a
    // quick reconnect can take the turn back first. The expert bot pauses only
    // briefly since its search itself takes time.
    const acting = room.players.find((p) => p.seat === action.seat);
    const offline = !!acting && !acting.isBot;
    const expert =
      action.type === 'move' && !offline && this.difficultyOf(room, action.seat) === 'expert';
    const delay = offline ? OFFLINE_TAKEOVER_MS : expert ? EXPERT_PREDELAY_MS : BOT_DELAY_MS;
    const timer = setTimeout(() => {
      this.timers.delete(code);
      void this.step(code);
    }, delay);
    timer.unref?.();
    this.timers.set(code, timer);
  }

  /**
   * Tutorial: freeze or release a room's bots. Pausing cancels any move already
   * scheduled so the table stops where it is; releasing re-kicks so the next bot
   * action (if any) resumes immediately.
   */
  setPaused(code: string, paused: boolean): void {
    if (paused) {
      this.paused.add(code);
      const timer = this.timers.get(code);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(code);
      }
    } else if (this.paused.delete(code)) {
      this.kick(code);
    }
  }

  /** The tier a seat plays at; an offline human's stand-in uses the full heuristic. */
  private difficultyOf(room: Room, seat: Seat): BotDifficulty {
    const p = room.players.find((pl) => pl.seat === seat);
    if (!p || !p.isBot) return 'hard'; // cover a dropped human competently (and fast/sync)
    return p.difficulty ?? DEFAULT_BOT_DIFFICULTY;
  }

  private async step(code: string): Promise<void> {
    // Runs from a setTimeout: a throw here would be an *uncaught* exception that
    // crashes the single-instance server and wipes every room. Wrap the whole
    // body so a bad bot turn can, at worst, stall one room. `busy` serialises
    // steps per room across the async expert path.
    if (this.busy.has(code)) return;
    this.busy.add(code);
    try {
      const room = this.rooms.getRoom(code);
      const state = this.games.getState(code);
      if (!room || !state) return;
      const action = pendingBotAction(room, state);
      if (!action) return;

      if (action.type === 'move' && this.pool && this.difficultyOf(room, action.seat) === 'expert') {
        await this.expertMove(code, action.seat);
      } else {
        // Tutorial first hand only: nudge a bomb-holding bot to play it (the deal
        // rigs an opponent a bomb) so the bomb lesson reliably fires.
        const eagerBomb =
          room.tutorial === true && this.games.getMatchInfo(code)?.handNumber === 1;
        try {
          applyBotAction(action, state, this.difficultyOf(room, action.seat), eagerBomb);
        } catch {
          // Shouldn't happen, but never loop forever: fall back to a pass if we can.
          try {
            if (action.type === 'move' && state.trick.top) pass(state, action.seat);
            else return;
          } catch {
            return;
          }
        }
        this.games.settle(code);
        this.emitState(room);
      }
    } catch (err) {
      console.error(`[bot.step] error in room ${code}:`, err);
    } finally {
      this.busy.delete(code);
    }
    this.kick(code); // chain to the next bot action, if any (now that we're free)
  }

  /**
   * Expert (PIMC) move: hand a state snapshot to a worker thread and await the
   * chosen move, keeping the event loop free. The world may change while we
   * think (a human can bomb out of turn), so we re-validate against the live
   * state and fall back to a fresh heuristic move (then a pass) if the PIMC
   * choice is stale or illegal.
   */
  private async expertMove(code: string, seat: Seat): Promise<void> {
    const snapshot = this.games.getState(code);
    if (!snapshot || !this.pool) return;
    let move: BotMove | undefined;
    try {
      move = await this.pool.choose(snapshot, seat); // postMessage clones the snapshot
    } catch (err) {
      console.error(`[bot.expert] worker error in room ${code}:`, err);
    }

    const room = this.rooms.getRoom(code);
    const state = this.games.getState(code);
    if (!room || !state) return;
    const live = pendingBotAction(room, state);
    if (!live || live.type !== 'move' || live.seat !== seat) return; // no longer our move

    const apply = (m: BotMove) => {
      if (m.pass) pass(state, seat);
      else playCards(state, seat, m.play ?? [], m.wish !== undefined ? { wish: m.wish } : {});
    };
    try {
      apply(move ?? botMove(state, seat));
    } catch {
      try {
        apply(botMove(state, seat)); // PIMC move was stale vs the changed state
      } catch {
        try {
          if (state.trick.top) pass(state, seat);
        } catch {
          /* give up this tick; the chained kick will try again */
        }
      }
    }
    this.games.settle(code);
    this.emitState(room);
  }

  private emitState(room: Room): void {
    const state = this.games.getState(room.code);
    const match = this.games.getMatchInfo(room.code);
    if (!state || !match) return;
    for (const p of room.players) {
      if (!p.isBot && p.seat !== null) {
        this.io.to(p.id).emit('game:state', toPlayerView(state, p.seat, match));
      }
    }
  }
}
