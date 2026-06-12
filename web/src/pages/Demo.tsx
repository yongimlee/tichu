import { useMemo, useState } from 'react';
import type {
  Card,
  GamePhase,
  MatchInfo,
  PlayerView,
  PublicSeatState,
  Room,
  Seat,
  Suit,
} from '@tichu/shared';
import { GameView } from './GameView';
import { Home } from './Home';
import { RoomView } from './RoomView';

// ---------------------------------------------------------------------------
// A server-free showcase of the in-game UI. Reachable at "#demo".
// It fabricates a PlayerView for each phase and renders the real <GameView>,
// so card colours / special-card art / sizing can be reviewed without four
// players and a live socket. Buttons emit to the socket but that is harmless.
// ---------------------------------------------------------------------------

const suit = (s: Suit, rank: number): Card => ({ kind: 'suit', suit: s, rank, id: `${s}-${rank}` });
const MAHJONG: Card = { kind: 'special', name: 'mahjong', id: 'mahjong' };
const DOG: Card = { kind: 'special', name: 'dog', id: 'dog' };
const PHOENIX: Card = { kind: 'special', name: 'phoenix', id: 'phoenix' };
const DRAGON: Card = { kind: 'special', name: 'dragon', id: 'dragon' };

// A 14-card hand that shows every suit colour and all four special cards.
const FULL_HAND: Card[] = [
  MAHJONG,
  suit('jade', 2),
  suit('pagoda', 3),
  suit('sword', 4),
  suit('star', 5),
  suit('pagoda', 6),
  suit('jade', 7),
  suit('star', 9),
  suit('sword', 10),
  suit('pagoda', 12),
  suit('jade', 13),
  suit('sword', 14),
  PHOENIX,
  DRAGON,
];

// seat 0 uses an 8-character nickname (the input maxLength) to verify the
// seatstrip clips long names with an ellipsis instead of overflowing the layout.
const NAMES = ['초롱초롱빛나는해', '민준', '지우', '하린'];

const room: Room = {
  code: 'DEMO01',
  hostId: 'p0',
  status: 'in-game',
  teamSelectionMode: 'manual',
  targetScore: 500,
  createdAt: Date.now(),
  players: NAMES.map((nickname, i) => ({
    id: `p${i}`,
    nickname,
    seat: i as Seat,
    isHost: i === 0,
    connected: true,
  })),
};

// Lobby (manual): host seated at 0, one partner seated, two still choosing seats.
const lobbyManual: Room = {
  code: 'TICHU1',
  hostId: 'p0',
  status: 'lobby',
  teamSelectionMode: 'manual',
  targetScore: 500,
  createdAt: Date.now(),
  players: [
    { id: 'p0', nickname: '세호', seat: 0, isHost: true, connected: true },
    { id: 'p1', nickname: '민준', seat: 1, isHost: false, connected: true },
    { id: 'bot-1', nickname: '봇 1', seat: 2, isHost: false, connected: true, isBot: true },
    { id: 'p3', nickname: '하린', seat: null, isHost: false, connected: true },
  ],
};

// Lobby (random): everyone joined; the host randomises teams, then starts.
const lobbyRandom: Room = {
  code: 'TICHU2',
  hostId: 'p0',
  status: 'lobby',
  teamSelectionMode: 'random',
  targetScore: 1000,
  createdAt: Date.now(),
  players: NAMES.map((nickname, i) => ({
    id: `p${i}`,
    nickname,
    seat: i as Seat,
    isHost: i === 0,
    connected: true,
  })),
};

const NO_CAPTURE: Card[][] = [[], [], [], []];

function seats(
  handCounts: number[],
  captured: Card[][] = NO_CAPTURE,
  handReveal: Card[][] = NO_CAPTURE,
): PublicSeatState[] {
  return ([0, 1, 2, 3] as Seat[]).map((seat) => ({
    seat,
    handCount: handCounts[seat],
    grandTichu: seat === 1,
    tichu: seat === 3,
    decidedGrandTichu: true,
    hasExchanged: false,
    hasPlayed: false,
    finished: false,
    captured: captured[seat],
    handReveal: handReveal[seat],
  }));
}

// Sample captured piles to demo the "won cards" display + scoring highlight.
const CAPTURED: Card[][] = [
  [suit('jade', 5), suit('star', 10), suit('sword', 13), suit('jade', 8), suit('pagoda', 9)], // 25
  [suit('pagoda', 5), DRAGON, suit('sword', 2), suit('jade', 3)], // 30
  [suit('star', 10), suit('jade', 4), suit('pagoda', 6)], // 10
  [suit('sword', 13), PHOENIX, suit('star', 7)], // -15
];

const CAPTURED_MID: Card[][] = [
  [],
  [],
  [suit('pagoda', 5), suit('jade', 4)], // small pile → one row
  // a bigger pile → wraps to two rows of face-down backs
  [
    suit('star', 10),
    suit('sword', 6),
    suit('jade', 2),
    suit('jade', 3),
    suit('jade', 4),
    suit('pagoda', 7),
    suit('pagoda', 8),
    suit('star', 9),
  ],
];

const match: MatchInfo = {
  scores: { A: 120, B: 85 },
  target: 500,
  handNumber: 3,
  winner: null,
  startedAt: Date.now() - 1000 * 60 * 23, // 23 minutes in, for the demo timer
  endedAt: null,
  history: [
    { hand: 1, delta: { A: 70, B: 30 }, total: { A: 70, B: 30 } },
    { hand: 2, delta: { A: 50, B: 55 }, total: { A: 120, B: 85 } },
  ],
};

// In-game scenarios: the real phases plus a "Mahjong lead" view (pick a wish)
// and a "Dragon trick" view (choose who receives the won trick).
type GameScenario = GamePhase | 'mahjong' | 'dragon' | 'dog' | 'bomb' | 'tichu';
// All demo scenarios, including the pre-game lobby flow.
type Scenario = GameScenario | 'home' | 'lobby-manual' | 'lobby-random';

function buildView(scenario: GameScenario): PlayerView {
  const phase: GamePhase =
    scenario === 'mahjong' ||
    scenario === 'dragon' ||
    scenario === 'dog' ||
    scenario === 'bomb' ||
    scenario === 'tichu'
      ? 'playing'
      : scenario;
  const base: PlayerView = {
    phase,
    selfSeat: 0,
    hand: FULL_HAND,
    seats: seats([14, 14, 14, 14]),
    turn: 0,
    leader: 0,
    trick: [],
    trickOwner: null,
    wish: null,
    finished: [],
    pendingDragon: null,
    result: null,
    announce: null,
    match: { ...match },
  };

  switch (scenario) {
    case 'grand-tichu':
      return { ...base, hand: FULL_HAND.slice(0, 8), seats: seats([8, 8, 8, 8]) };
    case 'exchange':
      return base;
    case 'mahjong':
      // Leading an empty trick on your turn — select the Mahjong to reveal the wish input.
      return base;
    case 'dragon':
      // You won a trick with the Dragon — the trick stays on the table until you
      // choose an opponent to receive it (turn is null meanwhile).
      return {
        ...base,
        turn: null,
        pendingDragon: 0,
        seats: seats([13, 12, 11, 12]),
        trick: [
          { seat: 3, type: 'single', cards: [suit('jade', 5)] },
          { seat: 0, type: 'single', cards: [DRAGON] },
        ],
        trickOwner: 0,
      };
    case 'dog':
      // You just led the Dog — it leaves no card on the table and hands the lead
      // to your partner. The transient announce drives the one-shot visual.
      return {
        ...base,
        turn: 2, // lead passed to partner (seat 2)
        seats: seats([13, 14, 14, 14]),
        announce: { kind: 'dog', from: 0, to: 2 },
      };
    case 'bomb':
      // Seat 3 just dropped a four-of-a-kind bomb on a single — the announce
      // drives the shake + flash + toast, and the bomb cards pulse in the trick.
      return {
        ...base,
        turn: 0,
        seats: seats([14, 13, 12, 9]),
        trick: [
          { seat: 2, type: 'single', cards: [suit('star', 14)] },
          {
            seat: 3,
            type: 'bomb',
            cards: [suit('jade', 7), suit('sword', 7), suit('pagoda', 7), suit('star', 7)],
          },
        ],
        trickOwner: 3,
        announce: { kind: 'bomb', from: 3, level: 1 },
      };
    case 'tichu':
      // Seat 1 (민준) just called Large Tichu — the announce drives the gold
      // celebratory flash + toast. The seat already carries the grandTichu badge.
      return {
        ...base,
        turn: 0,
        seats: seats([14, 14, 14, 14]),
        announce: { kind: 'tichu', from: 1, grand: true },
      };
    case 'playing':
      return {
        ...base,
        seats: seats([14, 13, 12, 13], CAPTURED_MID),
        wish: 8,
        trick: [
          { seat: 2, type: 'single', cards: [suit('star', 8)] },
          { seat: 3, type: 'single', cards: [suit('sword', 11)] },
        ],
        trickOwner: 3,
      };
    case 'scoring': {
      // seat3 is the last player out → their leftover hand is revealed to everyone.
      const leftover: Card[][] = [[], [], [], [suit('sword', 14), suit('jade', 10), DRAGON]];
      return {
        ...base,
        seats: seats([0, 0, 0, 3], CAPTURED, leftover),
        finished: [1, 0, 2], // out-order → seat3 is last (1등 민준 · 2등 세호 · 3등 지우 · 4등 하린)
        result: { teamScores: { A: 125, B: -25 }, doubleVictory: false, firstOut: 1 },
      };
    }
    case 'finished':
      return {
        ...base,
        match: {
          ...match,
          scores: { A: 1010, B: 640 },
          winner: 'A',
          endedAt: match.startedAt + 1000 * 60 * 42, // 42-minute demo game
        },
      };
    default:
      return base;
  }
}

const PHASES: { key: Scenario; label: string }[] = [
  { key: 'home', label: '방 만들기' },
  { key: 'lobby-manual', label: '대기실 · 직접선택' },
  { key: 'lobby-random', label: '대기실 · 랜덤' },
  { key: 'grand-tichu', label: '라지 티츄' },
  { key: 'exchange', label: '카드 교환' },
  { key: 'mahjong', label: '참새 리드(소원)' },
  { key: 'playing', label: '플레이' },
  { key: 'dragon', label: '용 트릭 처리' },
  { key: 'dog', label: '개 리드 넘김' },
  { key: 'bomb', label: '폭탄' },
  { key: 'tichu', label: '티츄 콜' },
  { key: 'scoring', label: '점수' },
  { key: 'finished', label: '게임 종료' },
];

const noop = () => {};

function renderScenario(scenario: Scenario, gameView: PlayerView | null) {
  switch (scenario) {
    case 'home':
      return <Home onJoined={noop} onError={noop} onTutorial={noop} />;
    case 'lobby-manual':
      return <RoomView room={lobbyManual} selfId="p0" onLeave={noop} />;
    case 'lobby-random':
      return <RoomView room={lobbyRandom} selfId="p0" onLeave={noop} />;
    default:
      return gameView && <GameView view={gameView} room={room} onLeave={noop} onError={noop} />;
  }
}

const isGameScenario = (s: Scenario): s is GameScenario =>
  s !== 'home' && s !== 'lobby-manual' && s !== 'lobby-random';

export function Demo() {
  const [phase, setPhase] = useState<Scenario>('home');
  // Build the game view once per scenario. Rebuilding it on every render (e.g. an
  // unrelated App re-render from the head-pat button) would hand GameView a fresh
  // `announce` object and wrongly re-fire its one-shot Dog/bomb effects.
  const gameView = useMemo(() => (isGameScenario(phase) ? buildView(phase) : null), [phase]);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '0.4rem',
          flexWrap: 'wrap',
          marginBottom: '1rem',
          alignItems: 'center',
        }}
      >
        <span style={{ color: '#9aa3b2', fontSize: '0.85rem' }}>데모 단계:</span>
        {PHASES.map((p) => (
          <button
            key={p.key}
            className={`btn${phase === p.key ? ' btn--primary' : ''}`}
            style={{ padding: '0.3rem 0.7rem', minHeight: 0 }}
            onClick={() => setPhase(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {phase === 'mahjong' && (
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          👉 손패에서 <strong>참새(1) 카드</strong>를 누르면 아래에 소원 선택 버튼이 나타납니다.
          원하는 숫자를 눌러 소원을 정할 수 있어요.
        </p>
      )}
      {renderScenario(phase, gameView)}
    </div>
  );
}
