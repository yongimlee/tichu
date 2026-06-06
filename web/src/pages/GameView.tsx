import { useMemo, useState } from 'react';
import {
  canBeat,
  cardPoints,
  detectCombination,
  nextSeat,
  partnerSeat,
  prevSeat,
  seatTeam,
  type Card,
  type Combination,
  type CombinationType,
  type PlayerView,
  type Room,
  type Seat,
} from '@tichu/shared';
import { socket } from '../socket';
import { CardChip, cardText } from '../components/CardChip';

interface Props {
  view: PlayerView;
  room: Room;
}

// Selectable ranks for a Mahjong wish (2..14); face cards show J/Q/K/A.
const WISH_RANKS = Array.from({ length: 13 }, (_, i) => i + 2);
const RANK_FACE: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankLabel = (r: number) => RANK_FACE[r] ?? String(r);

export function GameView({ view, room }: Props) {
  const nameOf = useMemo(() => {
    const map = new Map<Seat, string>();
    for (const p of room.players) if (p.seat !== null) map.set(p.seat, p.nickname);
    return (seat: Seat) => map.get(seat) ?? `자리 ${seat}`;
  }, [room.players]);

  const connectedOf = useMemo(() => {
    const map = new Map<Seat, boolean>();
    for (const p of room.players) if (p.seat !== null) map.set(p.seat, p.connected);
    return (seat: Seat) => map.get(seat) ?? true;
  }, [room.players]);

  const self = view.seats[view.selfSeat];
  const isHost = room.players.find((p) => p.seat === view.selfSeat)?.isHost ?? false;

  return (
    <div className="game">
      <MatchBar view={view} />
      <SeatStrip view={view} nameOf={nameOf} connectedOf={connectedOf} />

      {view.phase === 'grand-tichu' && <GrandTichu view={view} decided={self.decidedGrandTichu} />}
      {view.phase === 'exchange' && <Exchange view={view} nameOf={nameOf} />}
      {view.phase === 'playing' && <Playing view={view} nameOf={nameOf} />}
      {view.phase === 'scoring' && <Scoring view={view} isHost={isHost} nameOf={nameOf} />}
      {view.phase === 'finished' && <Finished view={view} />}
    </div>
  );
}

function MatchBar({ view }: { view: PlayerView }) {
  const { scores, target, handNumber } = view.match;
  return (
    <div className="matchbar">
      <div className="matchbar__team">
        <span className="matchbar__label">팀 A</span>
        <span className="matchbar__score">{scores.A}</span>
      </div>
      <div className="matchbar__mid">
        <div>{handNumber}판째</div>
        <div className="matchbar__target">목표 {target}</div>
      </div>
      <div className="matchbar__team">
        <span className="matchbar__label">팀 B</span>
        <span className="matchbar__score">{scores.B}</span>
      </div>
    </div>
  );
}

function Scoring({
  view,
  isHost,
  nameOf,
}: {
  view: PlayerView;
  isHost: boolean;
  nameOf: (s: Seat) => string;
}) {
  const r = view.result;
  return (
    <section className="card phase">
      <h2>이번 판 결과</h2>
      <p className="hint">각자 트릭에서 딴 카드입니다 — ✨ 빛나는 카드가 점수 카드예요.</p>

      <div className="scoreboard">
        {view.seats.map((s, i) => {
          const team = seatTeam(s.seat);
          const rank = rankOf(view, s.seat);
          return (
            <div
              key={s.seat}
              className={`scoreboard__player scoreboard__player--team-${team.toLowerCase()}`}
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <div className="scoreboard__head">
                <span
                  className={`scoreboard__rank${rank > 3 ? ' scoreboard__rank--num' : ''}`}
                  title={`${rank}등`}
                >
                  {rankLabelText(rank)}
                </span>
                <span className="seatstrip__team">팀 {team}</span> {nameOf(s.seat)}
                <strong className="scoreboard__pts">{capturedPoints(s.captured)}점</strong>
              </div>
              {s.captured.length > 0 ? (
                <CapturePile cards={s.captured} highlight />
              ) : (
                <p className="hint">딴 카드 없음</p>
              )}
            </div>
          );
        })}
      </div>

      {r && (
        <>
          {r.doubleVictory && <p className="hint">🎉 원투 피니시 (양 파트너 먼저 아웃) — 200점!</p>}
          <p className="hint">
            최종 점수는 딴 카드 점수에 티츄/라지티츄 보너스와 마지막 아웃 재분배 규칙을 더해
            계산됩니다.
          </p>
          <div className="scoreline">
            <span>팀 A</span>
            <strong>{r.teamScores.A >= 0 ? `+${r.teamScores.A}` : r.teamScores.A}</strong>
          </div>
          <div className="scoreline">
            <span>팀 B</span>
            <strong>{r.teamScores.B >= 0 ? `+${r.teamScores.B}` : r.teamScores.B}</strong>
          </div>
        </>
      )}
      {isHost ? (
        <button className="btn btn--primary" onClick={() => socket.emit('game:nextHand')}>
          다음 판 시작
        </button>
      ) : (
        <p className="hint">방장이 다음 판을 시작하기를 기다리는 중…</p>
      )}
    </section>
  );
}

function Finished({ view }: { view: PlayerView }) {
  const { scores, winner } = view.match;
  return (
    <section className="card phase phase--finished">
      <h2>게임 종료</h2>
      <p className="winner">🏆 팀 {winner} 승리!</p>
      <div className="scoreline">
        <span>팀 A</span>
        <strong>{scores.A}</strong>
      </div>
      <div className="scoreline">
        <span>팀 B</span>
        <strong>{scores.B}</strong>
      </div>
    </section>
  );
}

function SeatStrip({
  view,
  nameOf,
  connectedOf,
}: {
  view: PlayerView;
  nameOf: (s: Seat) => string;
  connectedOf: (s: Seat) => boolean;
}) {
  const relation = (seat: Seat): string => {
    if (seat === view.selfSeat) return '나';
    if (seat === partnerSeat(view.selfSeat)) return '파트너';
    if (seat === nextSeat(view.selfSeat)) return '왼쪽';
    return '오른쪽';
  };
  return (
    <div className="seatstrip">
      {view.seats.map((s) => {
        const isTurn = view.phase === 'playing' && s.seat === view.turn;
        const isDragon = view.phase === 'playing' && s.seat === view.pendingDragon;
        const offline = !connectedOf(s.seat);
        const team = seatTeam(s.seat); // 'A' (seats 0·2) or 'B' (seats 1·3)
        return (
          <div
            key={s.seat}
            className={`seatstrip__item seatstrip__item--team-${team.toLowerCase()}${
              s.seat === view.selfSeat ? ' is-self' : ''
            }${isTurn || isDragon ? ' is-turn' : ''}${offline ? ' is-offline' : ''}`}
          >
            <div className="seatstrip__rel">
              <span className="seatstrip__team">팀 {team}</span> · {relation(s.seat)}
            </div>
            <div className="seatstrip__name">
              {nameOf(s.seat)}
              {offline && <span className="badge badge--offline">오프라인</span>}
            </div>
            <div className="seatstrip__meta">
              🂠 {s.handCount}
              {s.grandTichu && <span className="badge badge--gt">LT</span>}
              {s.tichu && <span className="badge">T</span>}
              {view.phase === 'exchange' && s.hasExchanged && <span className="badge">✓</span>}
            </div>
            {isTurn && <div className="seatstrip__turn">▶ 차례</div>}
            {isDragon && <div className="seatstrip__turn">🐉 용 넘기는 중</div>}
            {s.captured.length > 0 && (
              <div className="seatstrip__captured">
                <div className="seatstrip__points">
                  획득 {capturedPoints(s.captured)}점 · {s.captured.length}장
                </div>
                <CardBackStack count={s.captured.length} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Hand({
  cards,
  selectedIds = new Set(),
  onToggle,
}: {
  cards: Card[];
  selectedIds?: Set<string>;
  onToggle?: (card: Card) => void;
}) {
  return (
    <div className="hand">
      {cards.map((card) => (
        <CardChip
          key={card.id}
          card={card}
          selected={selectedIds.has(card.id)}
          onClick={onToggle ? () => onToggle(card) : undefined}
        />
      ))}
    </div>
  );
}

function GrandTichu({ view, decided }: { view: PlayerView; decided: boolean }) {
  const decide = (declare: boolean) => socket.emit('game:grandTichu', { declare });
  return (
    <section className="card phase">
      <h2>라지 티츄</h2>
      <p className="hint">처음 받은 8장입니다. 라지 티츄(200점)를 선언하시겠어요?</p>
      <Hand cards={view.hand} />
      {decided ? (
        <p className="hint">결정 완료 — 다른 플레이어를 기다리는 중…</p>
      ) : (
        <div className="actions actions--row">
          <button className="btn btn--secondary" onClick={() => decide(true)}>
            라지 티츄 선언
          </button>
          <button className="btn" onClick={() => decide(false)}>
            패스
          </button>
        </div>
      )}
    </section>
  );
}

type SlotKey = 'toLeft' | 'toPartner' | 'toRight';

function Exchange({ view, nameOf }: { view: PlayerView; nameOf: (s: Seat) => string }) {
  const [picks, setPicks] = useState<Record<SlotKey, string>>({
    toLeft: '',
    toPartner: '',
    toRight: '',
  });

  const done = view.seats[view.selfSeat].hasExchanged;

  const slots: { key: SlotKey; label: string; seat: Seat }[] = [
    { key: 'toLeft', label: '왼쪽 상대', seat: nextSeat(view.selfSeat) },
    { key: 'toPartner', label: '파트너', seat: partnerSeat(view.selfSeat) },
    { key: 'toRight', label: '오른쪽 상대', seat: prevSeat(view.selfSeat) },
  ];

  const used = Object.values(picks).filter(Boolean);
  const ready = used.length === 3 && new Set(used).size === 3;

  const submit = () => socket.emit('game:exchange', picks);

  if (done) {
    return (
      <section className="card phase">
        <h2>카드 교환</h2>
        <p className="hint">카드를 건넸습니다 — 다른 플레이어를 기다리는 중…</p>
        <TichuDeclare view={view} />
      </section>
    );
  }

  return (
    <section className="card phase">
      <h2>카드 교환</h2>
      <p className="hint">세 명에게 한 장씩 건넵니다.</p>
      <div className="exchange">
        {slots.map((slot) => (
          <label key={slot.key} className="exchange__slot">
            <span>
              {slot.label} · <strong>{nameOf(slot.seat)}</strong>
            </span>
            <select
              value={picks[slot.key]}
              onChange={(e) => setPicks((p) => ({ ...p, [slot.key]: e.target.value }))}
            >
              <option value="">카드 선택</option>
              {view.hand
                .filter((c) => c.id === picks[slot.key] || !used.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {cardText(c)}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <Hand cards={view.hand} selectedIds={new Set(used)} />
      <p className="hint">전체 14장을 확인했으니 지금 티츄(100점)를 선언할 수 있습니다.</p>
      <div className="actions actions--row">
        <button className="btn btn--primary" disabled={!ready} onClick={submit}>
          카드 건네기
        </button>
        <TichuDeclare view={view} />
      </div>
    </section>
  );
}

function Playing({ view, nameOf }: { view: PlayerView; nameOf: (s: Seat) => string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wish, setWish] = useState('');

  const self = view.seats[view.selfSeat];
  const myTurn = view.turn === view.selfSeat && view.pendingDragon === null;
  const isLeading = view.trick.length === 0;

  // Reconstruct the current top combo (the winning play) so we can suggest legal moves.
  const topCombo = useMemo(() => {
    if (isLeading) return null;
    const p = [...view.trick].reverse().find((x) => x.seat === view.trickOwner);
    return p ? detectCombination(p.cards) : null;
  }, [view.trick, view.trickOwner, isLeading]);

  const suggestions = useMemo(
    () => (myTurn ? legalMoves(view.hand, topCombo) : []),
    [myTurn, view.hand, topCombo],
  );

  const toggle = (card: Card) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(card.id)) next.delete(card.id);
      else next.add(card.id);
      return next;
    });
  };

  const selectedCards = view.hand.filter((c) => selected.has(c.id));
  const hasMahjong = selectedCards.some((c) => c.kind === 'special' && c.name === 'mahjong');
  // Local validity hint (server is authoritative); Phoenix singles read as valid here.
  const localCombo = detectCombination(selectedCards);
  const isBomb = localCombo !== null && localCombo.bombLevel > 0;
  // The Dog is not a combination — it is a lead-only special that hands off the lead.
  const isDogLead = isLeading && isDogSingle(selectedCards);
  const canPlayInTurn =
    myTurn &&
    selectedCards.length > 0 &&
    (localCombo !== null || isPhoenixSingle(selectedCards) || isDogLead);
  // A bomb can interrupt a trick in progress even when it is not your turn.
  const canBombOutOfTurn =
    !myTurn && isBomb && view.trick.length > 0 && view.pendingDragon === null && !self.finished;
  const canPlay = canPlayInTurn || canBombOutOfTurn;

  const play = () => {
    const payload: { cardIds: string[]; wish?: number } = { cardIds: [...selected] };
    if (hasMahjong && wish) payload.wish = Number(wish);
    socket.emit('game:play', payload);
    setSelected(new Set());
    setWish('');
  };
  const doPass = () => socket.emit('game:pass');
  const declareTichu = () => socket.emit('game:tichu');

  return (
    <section className="card phase">
      <div className="phase__head">
        <h2>플레이</h2>
        <span className={`turntag${myTurn ? ' turntag--mine' : ''}`}>
          {view.pendingDragon !== null
            ? `🐉 ${nameOf(view.pendingDragon)}가 용 카드를 넘기는 중`
            : myTurn
              ? '내 차례'
              : `${nameOf(view.turn ?? view.selfSeat)} 차례`}
        </span>
      </div>

      <TrickArea view={view} nameOf={nameOf} />

      {view.wish !== null && (
        <p className="hint">
          🀙 소원: <strong>{rankLabel(view.wish)}</strong> 랭크 — 낼 수 있으면 반드시 이행해야 합니다.
        </p>
      )}

      {view.pendingDragon === view.selfSeat && <DragonGift view={view} nameOf={nameOf} />}

      <Hand cards={view.hand} selectedIds={selected} onToggle={toggle} />

      {hasMahjong && (
        <div className="field">
          <label>소원 (선택)</label>
          <div className="wishgrid">
            {WISH_RANKS.map((r) => (
              <button
                key={r}
                type="button"
                className={`btn btn--small wish-btn${wish === String(r) ? ' wish-btn--on' : ''}`}
                onClick={() => setWish((w) => (w === String(r) ? '' : String(r)))}
              >
                {rankLabel(r)}
              </button>
            ))}
          </div>
          <span className="hint">숫자를 누르면 소원 선택, 다시 누르면 해제(소원 없음).</span>
        </div>
      )}

      {myTurn &&
        (suggestions.length > 0 ? (
          <div className="suggest">
            <span className="suggest__label">추천 조합 — 누르면 자동 선택됩니다</span>
            <div className="suggest__chips">
              {suggestions.slice(0, 8).map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className="btn btn--small suggest__chip"
                  onClick={() => setSelected(new Set(c.cards.map((card) => card.id)))}
                >
                  {comboLabel(c)}
                </button>
              ))}
              {suggestions.length > 8 && (
                <span className="suggest__more">외 {suggestions.length - 8}개</span>
              )}
            </div>
          </div>
        ) : (
          !isLeading && <p className="hint">🚫 낼 수 있는 조합이 없습니다 — 패스하세요.</p>
        ))}

      <div className="actions actions--row">
        <button className="btn btn--primary" disabled={!canPlay} onClick={play}>
          {isBomb ? '💣 폭탄 투하' : '내기'}
        </button>
        <button className="btn" disabled={!myTurn || isLeading} onClick={doPass}>
          패스
        </button>
        {!self.hasPlayed && !self.grandTichu && !self.tichu && (
          <button className="btn btn--secondary" onClick={declareTichu}>
            티츄 선언
          </button>
        )}
      </div>
    </section>
  );
}

function TrickArea({ view, nameOf }: { view: PlayerView; nameOf: (s: Seat) => string }) {
  if (view.trick.length === 0) {
    return <p className="hint">새 트릭 — 리드할 카드를 내세요.</p>;
  }
  return (
    <div className="trick">
      {view.trick.map((play, i) => (
        <div key={i} className={`trick__play${play.seat === view.trickOwner ? ' is-top' : ''}`}>
          <span className="trick__who">{nameOf(play.seat)}</span>
          <div className="trick__cards">
            {play.cards.map((card) => (
              <CardChip key={card.id} card={card} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DragonGift({ view, nameOf }: { view: PlayerView; nameOf: (s: Seat) => string }) {
  const opponents = view.seats.filter((s) => seatTeam(s.seat) !== seatTeam(view.selfSeat));
  return (
    <div className="card phase__inset">
      <p className="hint">🐉 용으로 트릭을 획득했습니다. 어느 상대에게 넘기시겠어요?</p>
      <div className="actions--row">
        {opponents.map((o) => (
          <button
            key={o.seat}
            className="btn btn--secondary"
            onClick={() => socket.emit('game:giveDragon', { toSeat: o.seat })}
          >
            {nameOf(o.seat)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Small-Tichu declaration — available from the exchange phase until your first card. */
function TichuDeclare({ view }: { view: PlayerView }) {
  const self = view.seats[view.selfSeat];
  if (self.grandTichu || self.hasPlayed) return null;
  if (self.tichu) return <p className="hint">🔴 티츄 선언 완료 (100점)</p>;
  return (
    <button className="btn btn--secondary" onClick={() => socket.emit('game:tichu')}>
      티츄 선언 (100점)
    </button>
  );
}

function isPhoenixSingle(cards: Card[]): boolean {
  return cards.length === 1 && cards[0].kind === 'special' && cards[0].name === 'phoenix';
}

function isDogSingle(cards: Card[]): boolean {
  return cards.length === 1 && cards[0].kind === 'special' && cards[0].name === 'dog';
}

const TYPE_LABEL: Record<CombinationType, string> = {
  single: '싱글',
  pair: '페어',
  triple: '트리플',
  fullhouse: '풀하우스',
  straight: '스트레이트',
  stairs: '계단',
  bomb: '폭탄',
  straightbomb: '스트레이트 폭탄',
};

function comboLabel(c: Combination): string {
  const base = TYPE_LABEL[c.type];
  const r = rankLabel(c.rank);
  if (c.type === 'straight' || c.type === 'stairs' || c.type === 'straightbomb') {
    return `${base} ~${r} (${c.length}장)`;
  }
  return `${base} ${r}`;
}

/**
 * Legal plays from `hand` against the current `top` (null = leading). Brute-forces
 * card subsets (hand ≤14) through the shared detector, dedupes by logical combo,
 * and sorts cheapest-first (non-bombs, then lower rank, then fewer cards). A hint
 * only — the server remains authoritative on the actual play.
 */
function legalMoves(hand: Card[], top: Combination | null): Combination[] {
  const n = hand.length;
  if (n === 0) return [];
  const out: Combination[] = [];
  const seen = new Set<string>();
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: Card[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(hand[i]);
    const combo = detectCombination(subset);
    if (!combo || !canBeat(combo, top)) continue;
    const key = `${combo.type}:${combo.rank}:${combo.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(combo);
  }
  out.sort((a, b) => a.bombLevel - b.bombLevel || a.rank - b.rank || a.length - b.length);
  return out;
}

function capturedPoints(cards: Card[]): number {
  return cards.reduce((total, card) => total + cardPoints(card), 0);
}

/** A face-down, overlapping stack hinting at how many cards a player has won. */
function CardBackStack({ count }: { count: number }) {
  const shown = Math.min(count, 12);
  return (
    <div className="cardbackstack" title={`${count}장`}>
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className="cardback" />
      ))}
    </div>
  );
}

const RANK_MEDAL = ['🥇', '🥈', '🥉'];

/** Finishing place (1-based) from the out-order; unfinished players share last. */
function rankOf(view: PlayerView, seat: Seat): number {
  const idx = view.finished.indexOf(seat);
  return idx >= 0 ? idx + 1 : view.finished.length + 1;
}

function rankLabelText(rank: number): string {
  return RANK_MEDAL[rank - 1] ?? `${rank}등`;
}

/**
 * The cards a player has won in tricks, shown as a mini pile. With `highlight`
 * (used in scoring) the point cards glow and pop in while the rest dim.
 */
function CapturePile({ cards, highlight = false }: { cards: Card[]; highlight?: boolean }) {
  if (cards.length === 0) return null;
  return (
    <div className="capturepile">
      {cards.map((card, i) => {
        const isPoint = cardPoints(card) !== 0;
        const cls = highlight ? (isPoint ? ' is-point' : ' is-dim') : '';
        return (
          <span
            key={card.id}
            className={`capturepile__card${cls}`}
            style={highlight && isPoint ? { animationDelay: `${i * 50}ms` } : undefined}
          >
            <CardChip card={card} />
          </span>
        );
      })}
    </div>
  );
}
