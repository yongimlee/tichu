import type { Server } from 'socket.io';
import {
  canBeat,
  declareGrandTichu,
  declareTichu,
  detectCombination,
  giveDragon,
  nextSeat,
  partnerSeat,
  pass,
  playCards,
  prevSeat,
  submitExchange,
  toPlayerView,
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

// Server-controlled fill players. The driver watches each room and, whenever the
// pending actor is a bot, performs a simple but legal action after a short delay
// so a solo human can play a full game. Strategy is intentionally basic.

type TichuServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

const SEATS: Seat[] = [0, 1, 2, 3];
const BOT_DELAY_MS = 700;

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
function enumerateMoves(hand: Card[], top: Combination | null): Combination[] {
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

/**
 * Decide a bot's play. Priorities: go out if possible → don't beat your own
 * partner → don't break up a bomb → otherwise the cheapest beating combo (or
 * pass / bomb only when the wish forces it).
 */
function botMove(state: GameState, seat: Seat): { play?: string[]; pass?: true } {
  const hand = state.players[seat].hand;
  const top = state.trick.top;
  const leading = !top;

  let moves = enumerateMoves(hand, top);
  let mustPlayForWish = false;
  if (state.wish !== null) {
    const fulfilling = moves.filter((m) => m.cards.some((c) => concreteRank(c) === state.wish));
    if (fulfilling.length > 0) {
      moves = fulfilling;
      mustPlayForWish = true;
    }
  }

  // Going out (emptying the hand) is always worth it.
  const goOut = moves.filter((m) => m.cards.length === hand.length);
  if (goOut.length) {
    const pick = goOut.find((m) => m.bombLevel === 0) ?? goOut[0];
    return { play: pick.cards.map((c) => c.id) };
  }

  // Don't beat your partner if they're currently winning the trick.
  if (!leading && state.trick.owner === partnerSeat(seat) && !mustPlayForWish) {
    return { pass: true };
  }

  // Prefer moves that don't break a bomb apart.
  const bombs = bombCardIds(hand);
  const keepsBomb = (m: Combination) =>
    m.bombLevel > 0 || m.cards.every((c) => !bombs.has(c.id));
  const pool = moves.filter(keepsBomb);
  const usable = pool.length ? pool : moves;
  const nonBomb = usable.filter((m) => m.bombLevel === 0);

  if (leading) {
    const pick = nonBomb[0] ?? usable[0];
    if (pick) return { play: pick.cards.map((c) => c.id) };
    const dog = hand.find((c) => c.kind === 'special' && c.name === 'dog');
    return { play: [(dog ?? hand[0]).id] };
  }

  if (nonBomb[0]) return { play: nonBomb[0].cards.map((c) => c.id) };
  if (mustPlayForWish && usable[0]) return { play: usable[0].cards.map((c) => c.id) };
  return { pass: true }; // can't beat cheaply (or only have a bomb) → hold
}

/** Give the Dragon-won trick to the opponent who is furthest from going out. */
function chooseDragonTarget(state: GameState, seat: Seat): Seat {
  const left = nextSeat(seat);
  const right = prevSeat(seat); // both are opponents (partner sits opposite)
  return state.players[left].hand.length >= state.players[right].hand.length ? left : right;
}

/** A bot declares a (conservative) small Tichu only with a very strong hand. */
function wantsTichu(hand: Card[]): boolean {
  const hasBomb = bombCardIds(hand).size > 0;
  const hasDragon = hand.some((c) => c.kind === 'special' && c.name === 'dragon');
  return hasBomb && hasDragon;
}

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
  const isBot = (seat: Seat) => room.players.find((p) => p.seat === seat)?.isBot ?? false;
  if (state.phase === 'grand-tichu') {
    const seat = SEATS.find((s) => isBot(s) && !state.players[s].decidedGrandTichu);
    return seat === undefined ? null : { type: 'grand', seat };
  }
  if (state.phase === 'exchange') {
    const seat = SEATS.find((s) => isBot(s) && state.players[s].exchange === null);
    return seat === undefined ? null : { type: 'exchange', seat };
  }
  if (state.phase === 'playing') {
    if (state.pendingDragon && isBot(state.pendingDragon.winner)) {
      return { type: 'dragon', seat: state.pendingDragon.winner };
    }
    if (state.turn !== null && isBot(state.turn)) return { type: 'move', seat: state.turn };
  }
  return null;
}

export function applyBotAction(action: BotAction, state: GameState): void {
  switch (action.type) {
    case 'grand':
      declareGrandTichu(state, action.seat, false);
      break;
    case 'exchange': {
      const hand = state.players[action.seat].hand;
      if (wantsTichu(hand)) {
        try {
          declareTichu(state, action.seat); // declare before passing cards
        } catch {
          /* not eligible — ignore */
        }
      }
      submitExchange(state, action.seat, chooseExchange(hand));
      break;
    }
    case 'dragon':
      giveDragon(state, action.seat, chooseDragonTarget(state, action.seat));
      break;
    case 'move': {
      const m = botMove(state, action.seat);
      if (m.pass) pass(state, action.seat);
      else playCards(state, action.seat, m.play ?? []);
      break;
    }
  }
}

export class BotDriver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly io: TichuServer,
    private readonly rooms: RoomManager,
    private readonly games: GameManager,
  ) {}

  /** Ask the driver to act for a room if a bot is up next (debounced per room). */
  kick(code: string): void {
    if (this.timers.has(code)) return;
    const room = this.rooms.getRoom(code);
    const state = this.games.getState(code);
    if (!room || !state || !pendingBotAction(room, state)) return;
    const timer = setTimeout(() => {
      this.timers.delete(code);
      this.step(code);
    }, BOT_DELAY_MS);
    timer.unref?.();
    this.timers.set(code, timer);
  }

  private step(code: string): void {
    const room = this.rooms.getRoom(code);
    const state = this.games.getState(code);
    if (!room || !state) return;
    const action = pendingBotAction(room, state);
    if (!action) return;
    try {
      applyBotAction(action, state);
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
    this.kick(code); // chain to the next bot action, if any
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
