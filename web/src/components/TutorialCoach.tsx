import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nextSeat, partnerSeat, type Card, type PlayerView, type Seat } from '@tichu/shared';
import { socket } from '../socket';

/** Where the Mahjong (참새) is currently staged in the exchange, relative to me. */
type MahjongExchange = 'none' | 'partner' | 'opponent';

/** Seat's relation to me, for naming who ended up with the Mahjong. */
function relationOf(view: PlayerView, seat: Seat | null): string {
  if (seat === null) return '상대';
  if (seat === view.selfSeat) return '나';
  if (seat === partnerSeat(view.selfSeat)) return '파트너';
  if (seat === nextSeat(view.selfSeat)) return '왼쪽 상대';
  return '오른쪽 상대';
}

// A non-blocking coach that walks a first-time player through Tichu as the game
// unfolds. It watches the live PlayerView and surfaces the first not-yet-seen
// lesson whose `when` predicate is satisfied, so the guidance follows the actual
// flow: 라지 티츄 → 교환 → 플레이(리드/받아치기/특수카드/폭탄) → 점수 → 종료.
//
// Entirely client-side — it reads state but never drives the game, so bots keep
// playing underneath while the bubble waits to be dismissed at the player's pace.

const SEEN_KEY = 'tichu.tutorial.seen';
const COACH_KEY = 'tichu.tutorial.coach'; // 'off' hides the coach for the session

/** Context the coach passes to each lesson's `when` predicate. */
interface LessonCtx {
  /** Special-card names that have hit the table this hand (played by anyone). */
  played: Set<string>;
  /** Special-card names currently selected in my hand (playing phase). */
  selected: Set<string>;
  /** Where the Mahjong is staged in the current exchange (for the give-away warning). */
  mahjongExchange: MahjongExchange;
  /** True once I held the Mahjong during this hand's exchange (to detect giving it away). */
  hadMahjong: boolean;
  /** True once an opponent has dropped a bomb this hand (to explain it in action). */
  bombByOpponent: boolean;
}

interface Lesson {
  id: string;
  /** When this lesson becomes relevant, given the live view and special-card context. */
  when: (v: PlayerView, ctx: LessonCtx) => boolean;
  title: string;
  /** Static text, or a function of the view for lessons that name a seat etc. */
  body: ReactNode | ((v: PlayerView) => ReactNode);
}

const hasSpecial = (hand: Card[], name: string) =>
  hand.some((c) => c.kind === 'special' && c.name === name);

/** Does the hand hold a bomb — four of a kind, or a same-suit run of 5+? */
function handHasBomb(hand: Card[]): boolean {
  const byRank = new Map<number, number>();
  const bySuit = new Map<string, Set<number>>();
  for (const c of hand) {
    if (c.kind !== 'suit') continue;
    byRank.set(c.rank, (byRank.get(c.rank) ?? 0) + 1);
    if (!bySuit.has(c.suit)) bySuit.set(c.suit, new Set());
    bySuit.get(c.suit)!.add(c.rank);
  }
  for (const n of byRank.values()) if (n >= 4) return true;
  for (const ranks of bySuit.values()) {
    let run = 0;
    for (let r = 2; r <= 14; r++) {
      run = ranks.has(r) ? run + 1 : 0;
      if (run >= 5) return true;
    }
  }
  return false;
}

const isPlaying = (v: PlayerView) => v.phase === 'playing';
const myTurn = (v: PlayerView) =>
  v.phase === 'playing' && v.turn === v.selfSeat && v.pendingDragon === null;
// Scoring rules apply at the per-hand result screen and at game end. A low tutorial
// target can finish the deciding hand straight to 'finished' (skipping its scoring
// screen), so the rule explanations are shown at both so they're never missed.
const atScoreScreen = (v: PlayerView) => v.phase === 'scoring' || v.phase === 'finished';

// Ordered front-to-back: the coach shows the first unseen lesson that applies.
const LESSONS: Lesson[] = [
  {
    id: 'welcome',
    when: () => true,
    title: '튜토리얼에 오신 걸 환영해요! 🎓',
    body: (
      <>
        티츄는 <strong>4인 2팀</strong> 카드 게임이에요. 마주 보는 사람이 파트너입니다 — 화면에서
        나는 <strong>오른쪽 아래</strong>, 파트너는 <strong>대각선 위</strong>, 양옆이 상대 팀이에요.
        지금은 <strong>짹짹봇 3명</strong>과 연습합니다. 게임 흐름에 따라 제가 규칙을 짚어 드릴게요!
      </>
    ),
  },
  {
    id: 'grand-tichu',
    when: (v) => v.phase === 'grand-tichu',
    title: '1단계 · 라지 티츄',
    body: (
      <>
        먼저 <strong>8장</strong>만 받았어요. 카드를 더 받기 전에 <strong>라지 티츄(±200점)</strong>를
        선언할 수 있습니다. 선언하면 <strong>이번 판에서 가장 먼저</strong> 카드를 다 내야 성공해요.
        자신 없으면 <strong>패스</strong>하세요 — 연습이니 부담 없이 골라 보세요.
      </>
    ),
  },
  {
    id: 'cards-special',
    when: (v) => v.phase === 'exchange' && v.hand.some((c) => c.kind === 'special'),
    title: '2단계 · 손패 살펴보기 · 특수 카드',
    body: (
      <>
        이제 <strong>14장</strong>을 모두 받았어요. 건네기 전에 내 카드를 살펴볼까요? 지금은 특별히{' '}
        <strong>특수 카드 4장</strong>을 모두 갖고 있어요 — 🐦 <strong>참새</strong>(가장 낮은 1) · 🐶{' '}
        <strong>개</strong>(리드권 넘김) · 🐦‍🔥 <strong>봉황</strong>(와일드, −25점) · 🐉{' '}
        <strong>용</strong>(가장 높은 싱글, +25점). 각각 특별한 능력이 있고,{' '}
        <strong>실제로 낼 때</strong> 하나씩 자세히 알려드릴게요.
      </>
    ),
  },
  {
    id: 'cards-normal',
    when: (v) => v.phase === 'exchange',
    title: '손패 살펴보기 · 일반 카드',
    body: (
      <>
        나머지는 일반 카드예요. 무늬 4종(✿ ⚔ ⛩ ★)과 숫자 <strong>2~10·J·Q·K·A</strong>로 이뤄지고,
        무늬는 강약에 영향이 없어요(같은 숫자면 동급, A가 가장 큼). 그중 <strong>점수 카드</strong>는{' '}
        <strong>5=5점</strong>, <strong>10·K=10점</strong> — 한 판에 총 <strong>100점</strong>이 걸려
        있어요. 다 살펴봤으면 화면 안내대로 세 명에게 한 장씩 건네 보세요.
      </>
    ),
  },
  {
    id: 'exchange',
    when: (v) => v.phase === 'exchange',
    title: '카드 교환 요령',
    body: (
      <>
        카드는 왼쪽 · 파트너 · 오른쪽 세 명에게 <strong>한 장씩</strong> 건네요. 손패에서 카드를 누른
        뒤 건넬 상대 칸을 누르면 됩니다(건넨 카드를 다시 누르면 회수). 요령은{' '}
        <strong>파트너에게는 좋은 카드</strong>를, <strong>상대에게는 약한 카드</strong>를 주는 거예요.
      </>
    ),
  },
  {
    // Warn (don't block) when the player stages the Mahjong to an opponent — it hands
    // them the first lead and the wish, which is almost always a mistake.
    id: 'mahjong-give-warning',
    when: (v, ctx) => v.phase === 'exchange' && ctx.mahjongExchange === 'opponent',
    title: '⚠️ 참새를 상대에게?',
    body: (
      <>
        지금 <strong>참새</strong>를 상대 팀에게 건네려 하고 있어요. 참새를 가진 사람이 이번 판의{' '}
        <strong>첫 리드권과 소원</strong>을 갖기 때문에, 상대에게 주면 그 주도권을 그대로 넘겨주는
        셈이에요. 보통은 <strong>갖고 있는 게 유리</strong>하고, 굳이 넘긴다면 <strong>파트너</strong>
        에게 주세요. (건넨 카드를 다시 누르면 회수돼요.)
      </>
    ),
  },
  {
    id: 'small-tichu',
    when: (v) => v.phase === 'exchange' && !v.seats[v.selfSeat].grandTichu,
    title: '스몰 티츄 (±100점)',
    body: (
      <>
        14장을 다 본 지금부터 <strong>첫 카드를 내기 전까지</strong>는 언제든{' '}
        <strong>스몰 티츄(±100점)</strong>를 선언할 수 있어요. 라지 티츄처럼{' '}
        <strong>가장 먼저 아웃</strong>하면 성공입니다. 강한 손패면 노려 볼 만해요.
      </>
    ),
  },
  {
    id: 'playing-intro',
    when: isPlaying,
    title: '3단계 · 플레이 시작',
    body: (
      <>
        🐦 <strong>참새(1)</strong>를 가진 사람이 첫 <strong>리드</strong>를 합니다. 리드는{' '}
        싱글 · 페어 · 트리플 · 스트레이트 · 풀하우스 등 원하는 조합으로 시작해요. 한 바퀴 도는 동안
        쌓이는 카드 더미를 <strong>트릭</strong>이라고 부릅니다.
      </>
    ),
  },
  {
    // Adaptive fallback: the player gave the Mahjong away in the exchange, so they no
    // longer lead. Explains who leads instead (by relation) so the lesson isn't lost.
    id: 'mahjong-gave-away',
    when: (v, ctx) =>
      isPlaying(v) &&
      ctx.hadMahjong &&
      !hasSpecial(v.hand, 'mahjong') &&
      !v.seats[v.selfSeat].hasPlayed,
    title: '🐦 참새를 넘겼네요',
    body: (v) => (
      <>
        교환에서 <strong>참새</strong>를 <strong>{relationOf(v, v.leader)}</strong>에게 넘겼어요. 그래서
        이번 판 <strong>첫 리드와 소원</strong>은 참새를 받은 {relationOf(v, v.leader)}가 하게 됐어요.
        참새 보유자가 첫 리드를 하고 소원을 걸 수 있다는 점, 기억해 두세요 — 다음엔 직접 갖고 리드해
        보세요!
      </>
    ),
  },
  {
    id: 'mahjong-lead',
    when: (v) => isPlaying(v) && hasSpecial(v.hand, 'mahjong'),
    title: '🐦 참새(1) · 첫 리드는 나!',
    body: (
      <>
        지금 내 손에 가장 낮은 카드인 <strong>참새(1)</strong>가 있어요. 참새 보유자가 이번 판의{' '}
        <strong>첫 리드</strong>를 합니다 — 그래서 지금 내 차례예요. 다만 첫 카드로{' '}
        <strong>꼭 참새를 낼 필요는 없어요.</strong> 원하는 어떤 조합으로든 리드할 수 있습니다. 단,
        참새는 1이라 가장 약해서 나중엔 받아치기 어려우니 <strong>일찍 내는 편</strong>이 보통 유리해요.
      </>
    ),
  },
  {
    id: 'mahjong-wish',
    when: (v) => isPlaying(v) && hasSpecial(v.hand, 'mahjong'),
    title: '🐦 참새의 소원',
    body: (
      <>
        참새는 <strong>싱글</strong>로 내거나 <strong>스트레이트의 맨 아래 1</strong>(예: 1·2·3·4·5)로
        쓸 수 있어요(페어·트리플엔 못 들어가요). 낼 때 <strong>소원</strong>으로 2~A 중 한 숫자를
        지정하면, 그 숫자를 낼 수 있는 사람은 자기 차례에 <strong>반드시</strong> 그 숫자를 내야 해요 —
        상대를 묶는 강력한 견제예요. 참새를 고르면 손패 아래에 소원 숫자 버튼이 나타납니다.
      </>
    ),
  },
  {
    // Leading a fresh trick that isn't the opening 참새 lead (I've already played
    // once, and the table is empty on my turn) — the moment to teach "I set the shape".
    id: 'lead-combo',
    when: (v) =>
      myTurn(v) && v.trick.length === 0 && v.seats[v.selfSeat].hasPlayed,
    title: '🎯 리드 — 모양은 내가 정해요',
    body: (
      <>
        트릭을 새로 시작하는 <strong>리드</strong> 차례예요. 리드할 땐 <strong>원하는 조합</strong>으로
        시작할 수 있고, 그러면 다른 사람들은 <strong>같은 종류 · 같은 장수</strong>로 더 높게만 받아칠
        수 있어요. 싱글 · 페어 · 트리플 · 풀하우스 · 스트레이트 · 계단 — 손패 아래{' '}
        <strong>추천 조합</strong> 칩이나 아래 <strong>📖 규칙 설명서</strong>에서 모양을 확인해 보세요.
      </>
    ),
  },
  {
    id: 'follow-pass',
    when: (v) => isPlaying(v) && v.trick.length > 0,
    title: '받아치기 · 패스',
    body: (
      <>
        앞 사람이 낸 것과 <strong>같은 종류 · 같은 장수</strong>로 <strong>더 높게</strong>만 받아칠 수
        있어요(폭탄은 예외). 낼 게 없거나 아끼고 싶으면 <strong>패스</strong>하세요. 모두 패스하면{' '}
        마지막에 낸 사람이 트릭을 가져가고 다음 리드를 합니다.
      </>
    ),
  },
  {
    id: 'suggest',
    when: myTurn,
    title: '💡 추천 조합',
    body: (
      <>
        내 차례예요! 손패 아래 <strong>추천 조합</strong> 칩을 누르면 낼 수 있는 조합이 자동으로
        선택됩니다. 익숙해지면 오른쪽 위 <strong>💡 추천</strong> 버튼으로 끌 수 있어요. 카드를 직접
        골라 <strong>내기</strong>를 눌러도 됩니다.
      </>
    ),
  },
  // Detailed special-card explanations — shown the moment the player PICKS the card
  // up in hand, or when an opponent bot puts it on the table (`played`). Each fires
  // once. The Dog clears the trick instantly, so opponent plays are caught via the
  // one-shot Dog announce in the accumulator below.
  {
    id: 'sp-dog',
    when: (_v, { played, selected }) => played.has('dog') || selected.has('dog'),
    title: '특수 카드 · 🐶 개',
    body: (
      <>
        🐶 <strong>개</strong>는 점수가 없는 리드 전용 카드예요. 내면 트릭을 비우고{' '}
        <strong>리드권을 파트너에게</strong> 넘깁니다 — 파트너에게 주도권을 주고 싶을 때 써요.
      </>
    ),
  },
  {
    id: 'sp-phoenix',
    when: (_v, { played, selected }) => played.has('phoenix') || selected.has('phoenix'),
    title: '특수 카드 · 🐦‍🔥 봉황',
    body: (
      <>
        🐦‍🔥 <strong>봉황</strong>은 <strong>−25점</strong> 와일드카드예요. 폭탄을 뺀 어떤 조합의 카드든
        대신할 수 있고, 싱글로 내면 직전 카드보다 <strong>0.5만큼 높습니다</strong>(용은 못 이겨요).
      </>
    ),
  },
  {
    id: 'sp-dragon',
    when: (_v, { played, selected }) => played.has('dragon') || selected.has('dragon'),
    title: '특수 카드 · 🐉 용',
    body: (
      <>
        🐉 <strong>용</strong>은 가장 높은 싱글이고 <strong>+25점</strong>이에요. 단, 용으로 트릭을
        이기면 그 트릭을 <strong>상대 팀에게 넘겨야</strong> 합니다.
      </>
    ),
  },
  {
    id: 'bomb',
    when: (v) => isPlaying(v) && handHasBomb(v.hand),
    title: '💣 폭탄을 가지고 있어요!',
    body: (
      <>
        같은 숫자 4장(포카드) 또는 같은 무늬 연속 5장↑(스트레이트 플러시)이 폭탄이에요. 종류가 달라도
        어떤 조합이든 이기고, <strong>내 차례가 아니어도</strong> 진행 중인 트릭에 끼어들어 터뜨릴 수
        있습니다. 결정적인 순간을 위해 아껴 두세요.
      </>
    ),
  },
  {
    id: 'bomb-played',
    when: (_v, ctx) => ctx.bombByOpponent,
    title: '💣 상대가 폭탄을 터뜨렸어요!',
    body: (
      <>
        방금 상대가 <strong>폭탄</strong>을 냈어요. 폭탄은 종류·장수가 달라도 <strong>어떤 조합이든
        이기고</strong>, 자기 차례가 아니어도 진행 중인 트릭에 끼어들 수 있어요. 막으려면{' '}
        <strong>더 센 폭탄</strong>이 필요해요 — 스트레이트 플러시 &gt; 포카드, 같은 종류면 더 높은 숫자가
        이깁니다.
      </>
    ),
  },
  {
    id: 'dragon-give',
    when: (v) => v.pendingDragon === v.selfSeat,
    title: '🐉 용 트릭 넘기기',
    body: (
      <>
        용으로 트릭을 이겼어요. 규칙에 따라 이 트릭(점수 포함)을 <strong>상대 팀 한 명</strong>에게
        넘겨야 합니다. 버튼에서 받을 상대를 고르세요.
      </>
    ),
  },
  {
    id: 'scoring',
    when: (v) => v.phase === 'scoring',
    title: '4단계 · 이번 판 결과',
    body: (
      <>
        세 명이 카드를 다 내면 한 판이 끝나요. 각자 트릭에서 딴 카드 중 <strong>✨ 빛나는 게 점수
        카드</strong>예요(5=5점, 10·K=10점, 🐉 용 +25, 🐦‍🔥 봉황 −25) — 한 판에 총{' '}
        <strong>100점</strong>이 걸려 있어요. 이 점수가 어떻게 양 팀으로 나뉘는지 차례로 볼게요.
      </>
    ),
  },
  {
    id: 'scoring-last',
    when: atScoreScreen,
    title: '🏁 마지막 한 명(4등) 정산',
    body: (
      <>
        세 명이 아웃되면 카드가 남은 <strong>마지막 한 명(4등)</strong>은 특별하게 정산돼요. 그가{' '}
        <strong>딴 트릭 점수는 1등</strong>(가장 먼저 아웃한 사람)에게 통째로 가고, 손에{' '}
        <strong>남은 카드는 상대 팀</strong>에게 넘어갑니다. 그래서 빨리 아웃할수록 유리해요.
      </>
    ),
  },
  {
    id: 'scoring-double',
    when: atScoreScreen,
    title: '🎉 원투 피니시 (+200)',
    body: (
      <>
        한 팀의 <strong>두 파트너가 1·2등으로 먼저</strong> 아웃하면 <strong>원투 피니시</strong>예요.
        이땐 카드 점수를 따지지 않고 그 팀이 <strong>+200점 고정</strong>, 상대는 0점. 파트너와 호흡을
        맞춰 함께 빨리 빠져나가면 노릴 수 있어요.
      </>
    ),
  },
  {
    id: 'scoring-tichu',
    when: atScoreScreen,
    title: '🎯 티츄 선언 정산',
    body: (
      <>
        티츄를 선언했다면, <strong>그 사람이 이번 판에서 가장 먼저(1등) 아웃</strong>해야 성공이에요 —
        성공하면 <strong>스몰 +100 / 라지 +200</strong>, 실패하면 같은 점수만큼 <strong>차감</strong>
        됩니다. 2등으로 나가도 실패라는 점에 주의! (카드 점수와 <strong>별도</strong>로 가산·차감돼요.)
      </>
    ),
  },
  {
    id: 'finished',
    when: (v) => v.phase === 'finished',
    title: '게임 종료 🏆',
    body: (
      <>
        목표 점수에 먼저 도달한 팀이 이겨요. 이제 기본은 다 익혔어요! 친구들과{' '}
        <strong>초대 코드</strong>로 함께 즐겨 보세요. 규칙이 헷갈리면 언제든 아래{' '}
        <strong>📖 규칙 설명서</strong>를 펼쳐 볼 수 있어요.
      </>
    ),
  },
];

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Wipe lesson progress so a fresh tutorial starts from the first bubble. */
export function resetTutorialProgress(): void {
  localStorage.removeItem(SEEN_KEY);
  localStorage.removeItem(COACH_KEY);
}

export function TutorialCoach({
  view,
  selectedSpecials = [],
  mahjongExchange = 'none',
}: {
  view: PlayerView;
  /** Special-card names currently selected in the play-phase hand (from GameView). */
  selectedSpecials?: string[];
  /** Where the Mahjong is staged in the exchange panel right now (from GameView). */
  mahjongExchange?: MahjongExchange;
}) {
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const [coachOn, setCoachOn] = useState(() => localStorage.getItem(COACH_KEY) !== 'off');
  // Special cards that have hit the table this hand (played by ANYONE — me or a bot),
  // accumulated across snapshots so the lesson stays available after the card leaves
  // the trick. The Dog clears the table at once, so it's caught via its one-shot announce.
  const [played, setPlayed] = useState<Set<string>>(new Set());
  // Whether I held the Mahjong during this hand's exchange — lets the playing-phase
  // fallback tell "gave it away" apart from "never had it". Reset each new hand.
  const [hadMahjong, setHadMahjong] = useState(false);
  // Latched once an opponent drops a bomb, so the lesson stays up after the trick clears.
  const [bombByOpponent, setBombByOpponent] = useState(false);

  useEffect(() => {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  }, [seen]);
  useEffect(() => {
    localStorage.setItem(COACH_KEY, coachOn ? 'on' : 'off');
  }, [coachOn]);

  useEffect(() => {
    if (view.phase === 'grand-tichu') setHadMahjong(false); // new hand → reset
    else if (view.phase === 'exchange' && hasSpecial(view.hand, 'mahjong')) setHadMahjong(true);
  }, [view.phase, view.hand]);

  useEffect(() => {
    const found: string[] = [];
    let oppBomb = false;
    for (const p of view.trick) {
      for (const c of p.cards) if (c.kind === 'special') found.push(c.name);
      // A bomb sits in the trick as type 'bomb'/'straightbomb'; flag an opponent's.
      if (p.seat !== view.selfSeat && (p.type === 'bomb' || p.type === 'straightbomb')) {
        oppBomb = true;
      }
    }
    if (view.announce?.kind === 'dog') found.push('dog'); // anyone's Dog (clears the trick)
    if (view.pendingDragon !== null) found.push('dragon'); // someone won a trick with the 용
    if (view.announce?.kind === 'bomb' && view.announce.from !== view.selfSeat) oppBomb = true;
    if (oppBomb) setBombByOpponent(true);
    if (found.length === 0) return;
    setPlayed((prev) => {
      const next = new Set(prev);
      for (const n of found) next.add(n);
      return next.size === prev.size ? prev : next;
    });
  }, [view]);

  const selected = useMemo(() => new Set(selectedSpecials), [selectedSpecials]);
  const current = useMemo(
    () =>
      LESSONS.find(
        (l) =>
          !seen.has(l.id) &&
          l.when(view, { played, selected, mahjongExchange, hadMahjong, bombByOpponent }),
      ),
    [seen, view, played, selected, mahjongExchange, hadMahjong, bombByOpponent],
  );

  const step = useMemo(
    () => (current ? LESSONS.findIndex((l) => l.id === current.id) + 1 : 0),
    [current],
  );

  // Freeze the fill bots while a coach bubble is on screen so the game doesn't
  // advance before the player has read it; release them the moment it's dismissed
  // (or help is turned off). The server honours this only in tutorial rooms.
  const botsPaused = coachOn && current != null;
  useEffect(() => {
    socket.emit('tutorial:botPause', { paused: botsPaused });
  }, [botsPaused]);
  // On unmount (leaving the game) make sure we never leave the bots frozen.
  useEffect(() => () => {
    socket.emit('tutorial:botPause', { paused: false });
  }, []);

  const dismiss = () => {
    if (current) setSeen((prev) => new Set(prev).add(current.id));
  };
  const skipAll = () => setSeen(new Set(LESSONS.map((l) => l.id)));

  if (!coachOn) {
    return (
      <button
        type="button"
        className="coach-reopen"
        onClick={() => setCoachOn(true)}
        title="튜토리얼 도움말 다시 켜기"
      >
        🎓 도움말
      </button>
    );
  }

  if (!current) return null;

  return (
    <div className="coach" role="dialog" aria-live="polite">
      <div className="coach__avatar" aria-hidden="true">
        🐣
      </div>
      <div className="coach__body">
        <div className="coach__head">
          <strong className="coach__title">{current.title}</strong>
          <span className="coach__step">
            {step}/{LESSONS.length}
          </span>
        </div>
        <p className="coach__text">
          {typeof current.body === 'function' ? current.body(view) : current.body}
        </p>
        <div className="coach__actions">
          <button type="button" className="btn btn--primary btn--small" onClick={dismiss}>
            알겠어요 ▸
          </button>
          <button type="button" className="coach__link" onClick={skipAll}>
            모두 건너뛰기
          </button>
          <button type="button" className="coach__link" onClick={() => setCoachOn(false)}>
            도움말 끄기
          </button>
        </div>
      </div>
    </div>
  );
}
