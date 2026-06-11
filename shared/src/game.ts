import { cardPoints, createDeck, rankLabel, shuffle, SUITS, type Card } from './cards';
import {
  canBeat,
  detectCombination,
  phoenixSingleValue,
  type Combination,
  type CombinationType,
} from './combinations';
import { nextSeat, partnerSeat, prevSeat, seatTeam, type Seat, type TeamId } from './room';

// Authoritative game state for a single hand of Tichu, plus the pure transitions
// that drive it through dealing → grand tichu → card exchange → trick play.
// Scoring (turning captured tricks into points) is layered on in step 4.
//
// NOTE: transitions mutate the passed-in state in place — the server owns a
// single GameState object per room and applies events to it sequentially.

export type GamePhase =
  | 'grand-tichu' // each player decides Grand Tichu after seeing their first 8 cards
  | 'exchange' // each player passes 3 cards (one to each other player)
  | 'playing' // trick play
  | 'scoring' // hand finished, tally points (step 4)
  | 'finished'; // match over

/** Which card each player passes, by relative position. */
export interface ExchangeSelection {
  toLeft: string; // card id given to the left-hand opponent (next seat)
  toPartner: string; // card id given to the partner (opposite seat)
  toRight: string; // card id given to the right-hand opponent (previous seat)
}

export interface PlayerHandState {
  seat: Seat;
  hand: Card[];
  grandTichu: boolean;
  tichu: boolean;
  decidedGrandTichu: boolean; // has answered the Grand Tichu prompt
  hasPlayed: boolean; // has played at least one card this hand (locks out small Tichu)
  exchange: ExchangeSelection | null;
}

export interface TrickPlay {
  seat: Seat;
  combo: Combination;
}

export interface Trick {
  plays: TrickPlay[];
  top: Combination | null; // current highest combination on the table
  owner: Seat | null; // last player to play (current trick winner)
}

export interface PendingDragon {
  winner: Seat;
  cards: Card[];
}

/** Points a single hand awarded to each team (card points + Tichu bonuses). */
export interface HandResult {
  teamScores: { A: number; B: number };
  doubleVictory: boolean;
  firstOut: Seat;
}

/** One settled hand's contribution to the running match score. */
export interface HandScore {
  hand: number; // 1-based hand number
  delta: { A: number; B: number }; // points gained/lost this hand
  total: { A: number; B: number }; // cumulative score after this hand
}

/** Cumulative match state, tracked by the server across hands. */
export interface MatchInfo {
  scores: { A: number; B: number };
  target: number; // points needed to win (1000)
  handNumber: number;
  winner: TeamId | null;
  history: HandScore[]; // settled hands so far, oldest first
  startedAt: number; // epoch ms when the match began (first hand dealt)
  endedAt: number | null; // epoch ms when the match finished, else null
}

/**
 * A one-shot notable event for clients to animate. Some plays warrant a transient
 * visual: the Dog (resolves instantly, leaves no card on the table) and a bomb
 * (a dramatic, often out-of-turn, interrupt). The server flags it on the move
 * that triggers it and clears it on the next move, so it rides exactly one emitted
 * snapshot — clients fire their effect whenever a non-null announce arrives.
 */
export type GameAnnounce =
  | { kind: 'dog'; from: Seat; to: Seat } // who played the Dog → who got the lead
  | { kind: 'bomb'; from: Seat; level: number } // who bombed + bombLevel (1=4종, 2=스트레이트)
  | { kind: 'tichu'; from: Seat; grand: boolean }; // who called Tichu (grand=라지 티츄)

export interface GameState {
  phase: GamePhase;
  players: PlayerHandState[]; // index === seat (0..3)
  undealt: Card[]; // the remaining 24 cards held back during the Grand Tichu phase
  turn: Seat | null; // whose move it is during play
  leader: Seat | null; // who led the first trick (holder of the Mahjong)
  trick: Trick;
  wish: number | null; // Mahjong wish (rank 2..14) awaiting fulfilment
  captured: Card[][]; // index seat -> cards won in tricks (for scoring)
  finished: Seat[]; // order in which players ran out of cards
  pendingDragon: PendingDragon | null; // a Dragon-won trick awaiting the winner's gift choice
  result: HandResult | null; // set once the hand reaches the scoring phase
  announce: GameAnnounce | null; // transient event for client animation (e.g. Dog handoff)
}

const SEATS: Seat[] = [0, 1, 2, 3];
const FIRST_DEAL = 8;
const HAND_SIZE = 14;

function emptyTrick(): Trick {
  return { plays: [], top: null, owner: null };
}

/** Options for {@link startHand} — currently only the tutorial's rigged deal. */
export interface DealOptions {
  /**
   * Tutorial aid: guarantee this seat receives all four special cards (참새·개·
   * 봉황·용) within its 14, so a first-time player can try each one. The rest of
   * the deck is still shuffled normally.
   */
  stackSpecialsForSeat?: Seat;
  /**
   * Tutorial aid: guarantee each listed seat receives a bomb, so the bomb lessons
   * reliably appear — the human learns they hold one, and a rigged opponent bot
   * plays one (see the bot's eager-bomb tutorial behaviour). Each seat gets its
   * own randomly-chosen bomb (a four-of-a-kind, or occasionally a straight flush).
   */
  stackBombForSeats?: readonly Seat[];
}

// How often a rigged tutorial bomb is a straight flush rather than a four-of-a-kind.
const STRAIGHT_FLUSH_CHANCE = 0.3;
const STRAIGHT_BOMB_LEN = 5; // shortest straight flush

/**
 * Pick a random bomb whose cards are all still free: usually a four-of-a-kind (a
 * random rank, all four suits), occasionally a same-suit run of 5 (a straight
 * flush). Returns the concrete deck cards via `byId`.
 */
function randomBomb(byId: Map<string, Card>, used: Set<string>, rng: () => number): Card[] {
  const fourOfAKind = (): string[] => {
    const rank = 2 + Math.floor(rng() * 13); // 2..14
    return SUITS.map((s) => `${s}-${rank}`);
  };
  const straightFlush = (): string[] => {
    const suit = SUITS[Math.floor(rng() * SUITS.length)];
    const start = 2 + Math.floor(rng() * (13 - STRAIGHT_BOMB_LEN + 1)); // 2..10 → top ≤ 14
    return Array.from({ length: STRAIGHT_BOMB_LEN }, (_, k) => `${suit}-${start + k}`);
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    const ids = rng() < STRAIGHT_FLUSH_CHANCE ? straightFlush() : fourOfAKind();
    if (ids.every((id) => !used.has(id))) return ids.map((id) => byId.get(id)!);
  }
  // Exceedingly unlikely with a fresh deck; fall back to any free four-of-a-kind.
  for (let rank = 2; rank <= 14; rank++) {
    const ids = SUITS.map((s) => `${s}-${rank}`);
    if (ids.every((id) => !used.has(id))) return ids.map((id) => byId.get(id)!);
  }
  throw new Error('no free bomb available'); // unreachable for 2 bombs in a 56-card deck
}

/**
 * Reorder a shuffled deck so the rigged tutorial cards land in the right hands.
 * A seat's full hand is its first-deal block `deck[seat*8 .. seat*8+8)` plus its
 * slice of the held-back 24 (`deck[32+seat*6 .. +6)`), so reserving any of those
 * 14 index slots guarantees a card reaches that seat. Specials take the front of
 * the first-deal block; each requested bomb fills that seat's next free slots
 * (a 5-card straight flush may spill into the held-back slots). The rest keep the
 * shuffled order.
 */
function rigDeal(deck: Card[], opts: DealOptions, rng: () => number): Card[] {
  const byId = new Map(deck.map((c) => [c.id, c] as const));
  const reserved = new Map<number, Card>(); // deck index -> card forced there
  const used = new Set<string>(); // ids already reserved, so leftovers don't reuse them

  const heldBase = SEATS.length * FIRST_DEAL; // 32
  const per = HAND_SIZE - FIRST_DEAL; // 6 held-back cards per seat
  const seatSlots = (seat: Seat): number[] => [
    ...Array.from({ length: FIRST_DEAL }, (_, i) => seat * FIRST_DEAL + i),
    ...Array.from({ length: per }, (_, i) => heldBase + seat * per + i),
  ];
  const reserveInto = (seat: Seat, cards: Card[]) => {
    const free = seatSlots(seat).filter((i) => !reserved.has(i));
    cards.forEach((c, k) => {
      reserved.set(free[k], c);
      used.add(c.id);
    });
  };

  if (opts.stackSpecialsForSeat !== undefined) {
    reserveInto(opts.stackSpecialsForSeat, deck.filter((c) => c.kind === 'special')); // the 4
  }
  for (const seat of opts.stackBombForSeats ?? []) {
    reserveInto(seat, randomBomb(byId, used, rng));
  }

  const leftovers = deck.filter((c) => !used.has(c.id));
  const out: Card[] = new Array(deck.length);
  let li = 0;
  for (let i = 0; i < deck.length; i++) {
    out[i] = reserved.get(i) ?? leftovers[li++];
  }
  return out;
}

/**
 * Shuffle and deal the first 8 cards to each player; hold back the rest.
 * `rng` is required — the server must inject a CSPRNG (`cryptoRandom`) so a deal
 * can't silently fall back to predictable `Math.random`. Tests pass a seeded rng.
 */
export function startHand(rng: () => number, opts?: DealOptions): GameState {
  let deck = shuffle(createDeck(), rng);
  if (opts && (opts.stackSpecialsForSeat !== undefined || opts.stackBombForSeats?.length)) {
    deck = rigDeal(deck, opts, rng);
  }
  const players: PlayerHandState[] = SEATS.map((seat) => ({
    seat,
    hand: deck.slice(seat * FIRST_DEAL, seat * FIRST_DEAL + FIRST_DEAL).sort(byDisplayOrder),
    grandTichu: false,
    tichu: false,
    decidedGrandTichu: false,
    hasPlayed: false,
    exchange: null,
  }));
  return {
    phase: 'grand-tichu',
    players,
    undealt: deck.slice(SEATS.length * FIRST_DEAL), // 56 - 32 = 24 cards
    turn: null,
    leader: null,
    trick: emptyTrick(),
    wish: null,
    captured: [[], [], [], []],
    finished: [],
    pendingDragon: null,
    result: null,
    announce: null,
  };
}

/** Record a player's Grand Tichu decision. Deals the rest once all four answer. */
export function declareGrandTichu(state: GameState, seat: Seat, declare: boolean): GameState {
  if (state.phase !== 'grand-tichu') throw new Error('지금은 라지 티츄 단계가 아닙니다.');
  const player = state.players[seat];
  if (player.decidedGrandTichu) throw new Error('이미 라지 티츄를 결정했습니다.');
  player.decidedGrandTichu = true;
  player.grandTichu = declare;
  // Consume any prior one-shot announce and flag this call only on an actual
  // declaration. Without the reset, a declined decision (e.g. every bot deciding)
  // would re-emit the previous caller's announce and re-fire the visual each time.
  state.announce = declare ? { kind: 'tichu', from: seat, grand: true } : null;
  if (state.players.every((p) => p.decidedGrandTichu)) {
    dealRemainder(state);
  }
  return state;
}

/** Submit a player's 3-card exchange. Resolves the swap once all four submit. */
export function submitExchange(state: GameState, seat: Seat, selection: ExchangeSelection): GameState {
  if (state.phase !== 'exchange') throw new Error('지금은 카드 교환 단계가 아닙니다.');
  const player = state.players[seat];
  if (player.exchange) throw new Error('이미 카드를 건넸습니다.');

  const ids = [selection.toLeft, selection.toPartner, selection.toRight];
  if (new Set(ids).size !== 3) throw new Error('서로 다른 3장을 선택해야 합니다.');
  for (const id of ids) {
    if (!player.hand.some((c) => c.id === id)) throw new Error('보유하지 않은 카드를 선택했습니다.');
  }

  player.exchange = selection;
  // Consume any prior one-shot announce (e.g. a Tichu call made during exchange)
  // so it isn't re-emitted — and re-fired on the client — by each later submit.
  state.announce = null;
  if (state.players.every((p) => p.exchange)) {
    resolveExchange(state);
  }
  return state;
}

/**
 * Declare a small Tichu (100 pts). Allowed once the full 14-card hand is dealt
 * (i.e. from the exchange phase onward) up until you play your first card.
 */
export function declareTichu(state: GameState, seat: Seat): GameState {
  if (state.phase !== 'exchange' && state.phase !== 'playing') {
    throw new Error('지금은 티츄를 선언할 수 없습니다.');
  }
  const player = state.players[seat];
  if (player.hasPlayed) throw new Error('이미 카드를 낸 뒤에는 티츄를 선언할 수 없습니다.');
  if (player.grandTichu) throw new Error('이미 라지 티츄를 선언했습니다.');
  if (player.tichu) throw new Error('이미 티츄를 선언했습니다.');
  player.tichu = true;
  state.announce = { kind: 'tichu', from: seat, grand: false }; // one-shot call visual
  return state;
}

export interface PlayOptions {
  wish?: number; // when playing the Mahjong, optionally wish for a rank (2..14)
  desiredTop?: number; // disambiguate a Phoenix-extended straight/stairs
  phoenixAsLowerTriple?: boolean; // disambiguate a {2,2}+Phoenix full house
}

/** Play a set of cards (or the Dog) on the current trick. */
export function playCards(
  state: GameState,
  seat: Seat,
  cardIds: string[],
  opts: PlayOptions = {},
): GameState {
  if (state.phase !== 'playing') throw new Error('지금은 플레이 단계가 아닙니다.');
  if (state.pendingDragon) throw new Error('용 카드 트릭을 넘겨줄 상대를 먼저 선택해야 합니다.');
  state.announce = null; // consume any prior one-shot event before this move resolves
  const player = state.players[seat];
  const cards = resolveCards(player, cardIds);

  // Mahjong wish: if a wish is outstanding and you (on your turn) could legally
  // play a combination containing the wished rank, you must — no other play allowed.
  if (state.turn === seat && state.wish !== null) {
    const playsWish = cards.some((c) => concreteRank(c) === state.wish);
    if (!playsWish && canFulfillWish(state, seat)) {
      throw new Error(`참새 소원(${rankLabel(state.wish)})을 이행해야 합니다. 해당 숫자를 포함해서 내세요.`);
    }
  }

  // The Dog: only a lead, on your own turn, and it hands the lead to the partner.
  if (cards.length === 1 && isSpecial(cards[0], 'dog')) {
    if (state.turn !== seat) throw new Error('당신의 차례가 아닙니다.');
    if (state.trick.top) throw new Error('개 카드는 리드할 때만 낼 수 있습니다.');
    removeCards(player, cards); // the Dog wins nothing and scores nothing
    player.hasPlayed = true;
    markFinished(state, seat);
    state.trick = emptyTrick();
    if (!maybeEndHand(state)) {
      const to = handOffTo(state, partnerSeat(seat));
      state.turn = to;
      // The Dog leaves no card in the trick, so flag the handoff for a transient
      // client visual ("X played the Dog, lead passes to partner Y").
      if (to !== null) state.announce = { kind: 'dog', from: seat, to };
    }
    return state;
  }

  const combo = detectCombination(cards, {
    desiredTop: opts.desiredTop,
    phoenixAsLowerTriple: opts.phoenixAsLowerTriple,
  });
  if (!combo) throw new Error('올바른 조합이 아닙니다.');

  // A Phoenix single takes its value from the card it is beating.
  if (combo.type === 'single' && isSpecial(combo.cards[0], 'phoenix')) {
    combo.rank = phoenixSingleValue(state.trick.top);
  }

  // A bomb may be dropped out of turn to interrupt a trick in progress;
  // anything else must wait for your turn.
  if (state.turn !== seat) {
    if (combo.bombLevel === 0) {
      throw new Error('자신의 차례가 아닐 때는 폭탄만 낼 수 있습니다.');
    }
    if (!state.trick.top) {
      throw new Error('리드 중인 트릭이 없어 끼어들 수 없습니다.');
    }
  }

  if (!canBeat(combo, state.trick.top)) {
    throw new Error('현재 낸 카드를 이길 수 없습니다.');
  }

  // The Mahjong lets its player wish for a rank.
  if (cards.some((c) => isSpecial(c, 'mahjong'))) {
    state.wish = validateWish(opts.wish);
  }

  removeCards(player, cards);
  player.hasPlayed = true;
  state.trick.plays.push({ seat, combo });
  state.trick.top = combo;
  state.trick.owner = seat;

  // A bomb is a dramatic (often out-of-turn) interrupt — flag it for a one-shot
  // client visual that names the bomber and the bomb level.
  if (combo.bombLevel > 0) {
    state.announce = { kind: 'bomb', from: seat, level: combo.bombLevel };
  }

  // A wish is fulfilled as soon as a card of the wished rank is played.
  if (state.wish !== null && cards.some((c) => concreteRank(c) === state.wish)) {
    state.wish = null;
  }

  markFinished(state, seat);
  advanceOrClose(state, seat);
  maybeEndHand(state);
  return state;
}

/** Pass on the current trick (not allowed when leading). */
export function pass(state: GameState, seat: Seat): GameState {
  requireYourTurn(state, seat);
  if (!state.trick.top) throw new Error('리드할 때는 패스할 수 없습니다.');
  if (state.wish !== null && canFulfillWish(state, seat)) {
    throw new Error(`참새 소원(${rankLabel(state.wish)})을 낼 수 있으므로 패스할 수 없습니다.`);
  }
  // Consume any prior one-shot event. This matters for a bomb, whose announce is
  // otherwise still set when the following players pass — without clearing it the
  // event would ride every pass snapshot and re-fire the client visual each time.
  state.announce = null;
  advanceOrClose(state, seat);
  maybeEndHand(state);
  return state;
}

/** The winner of a Dragon-won trick gives those cards to a chosen opponent. */
export function giveDragon(state: GameState, seat: Seat, toSeat: Seat): GameState {
  const pending = state.pendingDragon;
  if (!pending) throw new Error('넘겨줄 용 카드 트릭이 없습니다.');
  if (pending.winner !== seat) throw new Error('용 카드를 획득한 플레이어만 선택할 수 있습니다.');
  if (seatTeam(toSeat) === seatTeam(seat)) throw new Error('상대 팀에게 넘겨야 합니다.');

  state.announce = null; // consume any prior one-shot (e.g. a Tichu called mid-wait)
  state.captured[toSeat].push(...pending.cards);
  state.pendingDragon = null;
  state.trick = emptyTrick(); // the Dragon trick was kept on the table for display
  if (!maybeEndHand(state)) {
    state.turn = handOffTo(state, seat);
  }
  return state;
}

// --- player view -----------------------------------------------------------

export interface PublicSeatState {
  seat: Seat;
  handCount: number;
  grandTichu: boolean;
  tichu: boolean;
  decidedGrandTichu: boolean;
  hasExchanged: boolean;
  hasPlayed: boolean;
  finished: boolean;
  captured: Card[]; // cards won in tricks so far (public — all were played face-up)
  handReveal: Card[]; // leftover hand cards, revealed only in the scoring phase (else empty)
}

export interface ViewTrickPlay {
  seat: Seat;
  type: CombinationType;
  cards: Card[];
}

export interface PlayerView {
  phase: GamePhase;
  selfSeat: Seat;
  hand: Card[];
  seats: PublicSeatState[];
  turn: Seat | null;
  leader: Seat | null;
  trick: ViewTrickPlay[];
  trickOwner: Seat | null;
  wish: number | null;
  finished: Seat[];
  pendingDragon: Seat | null; // the seat that must choose a recipient, if any
  result: HandResult | null; // populated in the scoring phase
  announce: GameAnnounce | null; // transient event for a one-shot client visual
  match: MatchInfo;
}

export function toPlayerView(state: GameState, seat: Seat, match: MatchInfo): PlayerView {
  return {
    phase: state.phase,
    selfSeat: seat,
    hand: state.players[seat].hand,
    seats: state.players.map((p) => ({
      seat: p.seat,
      handCount: p.hand.length,
      grandTichu: p.grandTichu,
      tichu: p.tichu,
      decidedGrandTichu: p.decidedGrandTichu,
      hasExchanged: p.exchange !== null,
      hasPlayed: p.hasPlayed,
      finished: state.finished.includes(p.seat),
      captured: state.captured[p.seat],
      // At hand's end every player's remaining cards are public knowledge (the
      // loser's leftover hand goes to the opponents), so reveal them in scoring.
      handReveal: state.phase === 'scoring' ? p.hand : [],
    })),
    turn: state.turn,
    leader: state.leader,
    trick: state.trick.plays.map((p) => ({ seat: p.seat, type: p.combo.type, cards: p.combo.cards })),
    trickOwner: state.trick.owner,
    wish: state.wish,
    finished: state.finished,
    pendingDragon: state.pendingDragon ? state.pendingDragon.winner : null,
    result: state.result,
    announce: state.announce,
    match,
  };
}

// --- internal transitions --------------------------------------------------

function dealRemainder(state: GameState): void {
  const per = HAND_SIZE - FIRST_DEAL; // 6 more each
  state.players.forEach((player, i) => {
    player.hand.push(...state.undealt.slice(i * per, i * per + per));
    player.hand.sort(byDisplayOrder);
  });
  state.undealt = [];
  state.phase = 'exchange';
}

function resolveExchange(state: GameState): void {
  const incoming: Card[][] = [[], [], [], []];

  for (const player of state.players) {
    const sel = player.exchange!;
    const give = (cardId: string, target: Seat) => {
      const idx = player.hand.findIndex((c) => c.id === cardId);
      const [card] = player.hand.splice(idx, 1);
      incoming[target].push(card);
    };
    give(sel.toLeft, nextSeat(player.seat));
    give(sel.toPartner, partnerSeat(player.seat));
    give(sel.toRight, prevSeat(player.seat));
  }

  state.players.forEach((player, i) => {
    player.hand.push(...incoming[i]);
    player.hand.sort(byDisplayOrder);
  });

  state.leader = findMahjongHolder(state);
  state.turn = state.leader;
  state.phase = 'playing';
}

/** Advance to the next player, or close the trick if it has come back around. */
function advanceOrClose(state: GameState, from: Seat): void {
  // Walk clockwise from `from`. If we reach the trick owner's seat before any
  // other active player, the trick has come back around → close it. We must
  // check the owner's seat directly (not via nextActiveSeat) because an owner
  // who went out on their winning play has no cards and would be skipped,
  // leaving the trick open forever.
  for (let i = 1; i <= 4; i++) {
    const seat = ((from + i) % 4) as Seat;
    if (seat === state.trick.owner) {
      closeTrick(state);
      return;
    }
    if (state.players[seat].hand.length > 0) {
      state.turn = seat;
      return;
    }
  }
  closeTrick(state); // no active players remain (defensive)
}

function closeTrick(state: GameState): void {
  const owner = state.trick.owner;
  if (owner === null) return; // nothing was played
  const cards = state.trick.plays.flatMap((p) => p.combo.cards);
  const top = state.trick.top!;

  // A Dragon-won trick must be handed to an opponent of the winner's choosing.
  // Keep the trick on the table (for display) until they choose — giveDragon
  // clears it. Until then turn is null and plays/passes are blocked.
  if (top.type === 'single' && isSpecial(top.cards[0], 'dragon')) {
    state.pendingDragon = { winner: owner, cards };
    state.turn = null;
    return;
  }

  state.trick = emptyTrick();
  state.captured[owner].push(...cards);
  state.turn = handOffTo(state, owner);
}

/** Who leads next, starting from `preferred` if they still hold cards. */
function handOffTo(state: GameState, preferred: Seat): Seat | null {
  if (state.players[preferred].hand.length > 0) return preferred;
  return nextActiveSeat(state, preferred);
}

function markFinished(state: GameState, seat: Seat): void {
  if (state.players[seat].hand.length === 0 && !state.finished.includes(seat)) {
    state.finished.push(seat);
  }
}

/** End the hand on a double victory (both partners out) or once three are out. */
function maybeEndHand(state: GameState): boolean {
  if (state.phase !== 'playing') return false;
  if (state.pendingDragon) return false; // wait for the Dragon gift first

  const fin = state.finished;
  const doubleVictory = fin.length >= 2 && partnerSeat(fin[0]) === fin[1];
  if (!doubleVictory && fin.length < 3) return false;

  // Sweep any still-open trick to its owner before tallying.
  if (state.trick.owner !== null) {
    state.captured[state.trick.owner].push(...state.trick.plays.flatMap((p) => p.combo.cards));
    state.trick = emptyTrick();
  }
  state.turn = null;
  state.phase = 'scoring';
  state.result = scoreHand(state);
  return true;
}

/**
 * Score a finished hand: card points (5s, 10s, Ks, Dragon +25, Phoenix -25),
 * Tichu/Grand Tichu bonuses, and the special distribution rules.
 */
export function scoreHand(state: GameState): HandResult {
  const teams = { A: 0, B: 0 };
  const add = (team: TeamId, value: number) => {
    teams[team] += value;
  };
  const finished = state.finished;
  const firstOut = (finished[0] ?? 0) as Seat;

  // Tichu / Grand Tichu: the stake is won only by going out first, else lost.
  for (const p of state.players) {
    const stake = p.grandTichu ? 200 : p.tichu ? 100 : 0;
    if (stake > 0) add(seatTeam(p.seat), p.seat === firstOut ? stake : -stake);
  }

  // Double victory: both partners go out before either opponent → flat 200.
  const doubleVictory = finished.length === 2 && partnerSeat(finished[0]) === finished[1];
  if (doubleVictory) {
    add(seatTeam(firstOut), 200);
    return { teamScores: teams, doubleVictory: true, firstOut };
  }

  // Normal end: one player is left holding cards.
  const points = state.players.map((p) => sumPoints(state.captured[p.seat]));
  const loser = SEATS.find((s) => !finished.includes(s));
  if (loser !== undefined) {
    // The loser's won tricks go to whoever went out first…
    points[firstOut] += points[loser];
    points[loser] = 0;
    // …and the cards still in their hand go to the opposing team.
    add(otherTeam(seatTeam(loser)), sumPoints(state.players[loser].hand));
  }
  for (const s of SEATS) add(seatTeam(s), points[s]);

  return { teamScores: teams, doubleVictory: false, firstOut };
}

function sumPoints(cards: Card[]): number {
  return cards.reduce((total, card) => total + cardPoints(card), 0);
}

function otherTeam(team: TeamId): TeamId {
  return team === 'A' ? 'B' : 'A';
}

function findMahjongHolder(state: GameState): Seat {
  const holder = state.players.find((p) =>
    p.hand.some((c) => c.kind === 'special' && c.name === 'mahjong'),
  );
  return holder ? holder.seat : 0;
}

/** First seat after `from` (clockwise) that still holds cards, or null if none. */
function nextActiveSeat(state: GameState, from: Seat): Seat | null {
  for (let i = 1; i <= 4; i++) {
    const s = ((from + i) % 4) as Seat;
    if (state.players[s].hand.length > 0) return s;
  }
  return null;
}

function requireYourTurn(state: GameState, seat: Seat): void {
  if (state.phase !== 'playing') throw new Error('지금은 플레이 단계가 아닙니다.');
  if (state.pendingDragon) throw new Error('용 카드 트릭을 넘겨줄 상대를 먼저 선택해야 합니다.');
  if (state.turn !== seat) throw new Error('당신의 차례가 아닙니다.');
}

function resolveCards(player: PlayerHandState, cardIds: string[]): Card[] {
  if (cardIds.length === 0) throw new Error('낼 카드를 선택해주세요.');
  if (new Set(cardIds).size !== cardIds.length) throw new Error('같은 카드를 중복 선택했습니다.');
  return cardIds.map((id) => {
    const card = player.hand.find((c) => c.id === id);
    if (!card) throw new Error('보유하지 않은 카드를 선택했습니다.');
    return card;
  });
}

function removeCards(player: PlayerHandState, cards: Card[]): void {
  const ids = new Set(cards.map((c) => c.id));
  player.hand = player.hand.filter((c) => !ids.has(c.id));
}

function validateWish(wish: number | undefined): number | null {
  if (wish === undefined) return null;
  if (!Number.isInteger(wish) || wish < 2 || wish > 14) {
    throw new Error('소원은 2부터 14까지의 숫자만 가능합니다.');
  }
  return wish;
}

function isSpecial(card: Card, name: 'mahjong' | 'dog' | 'phoenix' | 'dragon'): boolean {
  return card.kind === 'special' && card.name === name;
}

/** Rank usable for wish fulfilment; Mahjong = 1; null for dog/phoenix/dragon. */
function concreteRank(c: Card): number | null {
  if (c.kind === 'suit') return c.rank;
  if (c.name === 'mahjong') return 1;
  return null;
}

/**
 * Mahjong-wish enforcement: can this player, on their turn, make a *legal* play
 * that includes a card of the currently wished rank?
 *  - Leading: the wished card can always be led as a single, so holding it suffices.
 *  - Following: search the hand for any subset that contains a wished card and
 *    beats the current top (bombs included). Hands are ≤14 cards, so the full
 *    subset scan is cheap and only runs while a wish is outstanding.
 * If this returns true the player must fulfil the wish (no passing, no play that
 * omits the rank).
 */
function canFulfillWish(state: GameState, seat: Seat): boolean {
  const wish = state.wish;
  if (wish === null) return false;
  const hand = state.players[seat].hand;

  let wishMask = 0;
  for (let i = 0; i < hand.length; i++) {
    if (concreteRank(hand[i]) === wish) wishMask |= 1 << i;
  }
  if (wishMask === 0) return false; // the player has no card of the wished rank

  const top = state.trick.top;
  if (!top) return true; // leading: play the wished card as a single

  const n = hand.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    if ((mask & wishMask) === 0) continue; // must include at least one wished card
    const subset: Card[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(hand[i]);
    const combo = detectCombination(subset);
    // A bomb never binds: you are not forced to play (or break up) a bomb just to
    // fulfil a wish, so bomb combinations don't count as a fulfilling move.
    if (combo && combo.bombLevel === 0 && canBeat(combo, top)) return true;
  }
  return false;
}

function byDisplayOrder(a: Card, b: Card): number {
  return orderValue(a) - orderValue(b);
}

function orderValue(c: Card): number {
  if (c.kind === 'suit') return c.rank;
  switch (c.name) {
    case 'dog':
      return 0;
    case 'mahjong':
      return 1.4;
    case 'phoenix':
      return 14.5;
    case 'dragon':
      return 15;
  }
}
