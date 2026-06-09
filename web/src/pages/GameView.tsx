import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  canBeat,
  cardPoints,
  detectCombination,
  EMOTES,
  nextSeat,
  partnerSeat,
  prevSeat,
  seatTeam,
  type Card,
  type Combination,
  type CombinationType,
  type HandScore,
  type PlayerView,
  type Room,
  type Seat,
} from '@tichu/shared';
import { socket } from '../socket';
import { CardChip, cardText } from '../components/CardChip';
import { RulesGuide } from '../components/RulesGuide';

interface Props {
  view: PlayerView;
  room: Room;
  onLeave: () => void;
}

// Selectable ranks for a Mahjong wish (2..14); face cards show J/Q/K/A.
const WISH_RANKS = Array.from({ length: 13 }, (_, i) => i + 2);
const RANK_FACE: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankLabel = (r: number) => RANK_FACE[r] ?? String(r);

export function GameView({ view, room, onLeave }: Props) {
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

  const hostOf = useMemo(() => {
    const map = new Map<Seat, boolean>();
    for (const p of room.players) if (p.seat !== null) map.set(p.seat, p.isHost);
    return (seat: Seat) => map.get(seat) ?? false;
  }, [room.players]);

  // Transient emote bubbles per seat. `key` lets the same seat re-trigger the
  // pop animation (React remounts the bubble when the key changes).
  const [emotes, setEmotes] = useState<Partial<Record<Seat, { emoji: string; key: number }>>>({});
  const showEmote = useCallback((seat: Seat, emoji: string) => {
    const key = Date.now() + Math.random();
    setEmotes((prev) => ({ ...prev, [seat]: { emoji, key } }));
    setTimeout(() => {
      setEmotes((prev) => (prev[seat]?.key === key ? { ...prev, [seat]: undefined } : prev));
    }, 3000);
  }, []);
  useEffect(() => {
    const onEmote = ({ seat, emoji }: { seat: Seat; emoji: string }) => showEmote(seat, emoji);
    socket.on('game:emote', onEmote);
    return () => {
      socket.off('game:emote', onEmote);
    };
  }, [showEmote]);
  const emoteOf = (seat: Seat) => emotes[seat];
  const sendEmote = (emoji: string) => {
    socket.emit('game:emote', { emoji });
    showEmote(view.selfSeat, emoji); // optimistic — instant feedback (and works in the demo)
  };

  // One-shot announce visuals. The Dog leaves no card on the table and a bomb is a
  // dramatic interrupt; the server flags each via view.announce on a SINGLE
  // snapshot. We latch it into timed flash state here, and dismiss it in separate
  // effects below. Keeping the dismiss timer in this latch effect would be a bug:
  // the very next snapshot (announce=null) re-runs the effect, whose cleanup would
  // clearTimeout the pending dismiss — leaving the visual stuck on every trick.
  const [dogFlash, setDogFlash] = useState<{ from: Seat; to: Seat; key: number } | null>(null);
  const [bombFlash, setBombFlash] = useState<{ from: Seat; level: number; key: number } | null>(
    null,
  );
  useEffect(() => {
    const a = view.announce;
    if (a?.kind === 'dog') setDogFlash({ from: a.from, to: a.to, key: Date.now() });
    else if (a?.kind === 'bomb') setBombFlash({ from: a.from, level: a.level, key: Date.now() });
  }, [view.announce]);

  // Auto-dismiss — driven by the flash state itself, so an incoming announce=null
  // snapshot can't cancel the timer (the cause of the "stuck on every trick" bug).
  useEffect(() => {
    if (!dogFlash) return;
    const t = setTimeout(() => setDogFlash(null), 2600);
    return () => clearTimeout(t);
  }, [dogFlash]);
  useEffect(() => {
    if (!bombFlash) return;
    const t = setTimeout(() => setBombFlash(null), 2600);
    return () => clearTimeout(t);
  }, [bombFlash]);

  const self = view.seats[view.selfSeat];
  const isHost = room.players.find((p) => p.seat === view.selfSeat)?.isHost ?? false;

  return (
    <div className={`game${bombFlash ? ' game--bomb' : ''}`}>
      {bombFlash && (
        <div className="bomb-flash" key={bombFlash.key} aria-hidden="true">
          <span className="bomb-flash__text">💥 폭탄!</span>
        </div>
      )}
      {dogFlash && (
        <div className="dog-toast" key={dogFlash.key}>
          🐕 <strong>{nameOf(dogFlash.from)}</strong> 님이 개를 내고{' '}
          <strong>{nameOf(dogFlash.to)}</strong> 님에게 리드를 넘겼어요
        </div>
      )}
      {bombFlash && (
        <div className="bomb-toast" key={`toast-${bombFlash.key}`}>
          💥 <strong>{nameOf(bombFlash.from)}</strong> 님이{' '}
          {bombFlash.level === 2 ? '스트레이트 폭탄' : '폭탄'}을 터뜨렸어요!
        </div>
      )}
      <MatchBar view={view} />
      <SeatStrip
        view={view}
        nameOf={nameOf}
        connectedOf={connectedOf}
        hostOf={hostOf}
        emoteOf={emoteOf}
      />

      {view.phase === 'grand-tichu' && <GrandTichu view={view} decided={self.decidedGrandTichu} />}
      {view.phase === 'exchange' && <Exchange view={view} nameOf={nameOf} />}
      {view.phase === 'playing' && (
        <Playing view={view} nameOf={nameOf} dogFlash={dogFlash} bombFlash={bombFlash} />
      )}
      {view.phase === 'scoring' && <Scoring view={view} isHost={isHost} nameOf={nameOf} />}
      {view.phase === 'finished' && <Finished view={view} isHost={isHost} onLeave={onLeave} />}

      <EmoteBar onEmote={sendEmote} />
      <RulesGuide />
    </div>
  );
}

function EmoteBar({ onEmote }: { onEmote: (emoji: string) => void }) {
  return (
    <div className="emotebar">
      {EMOTES.map((emoji) => (
        <button key={emoji} type="button" className="emotebar__btn" onClick={() => onEmote(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  );
}

function MatchBar({ view }: { view: PlayerView }) {
  const { scores, target, handNumber, history } = view.match;
  const [showHistory, setShowHistory] = useState(false);
  const hasHistory = history.length > 0;
  return (
    <>
      <button
        type="button"
        className="matchbar"
        onClick={() => setShowHistory(true)}
        disabled={!hasHistory}
        title={hasHistory ? '점수 기록 보기' : '아직 끝난 판이 없습니다'}
      >
        <div className="matchbar__team">
          <span className="matchbar__label">팀 A</span>
          <span className="matchbar__score">{scores.A}</span>
        </div>
        <div className="matchbar__mid">
          <div>{handNumber}판째</div>
          <div className="matchbar__target">목표 {target}</div>
          {hasHistory && <div className="matchbar__hint">📊 기록</div>}
        </div>
        <div className="matchbar__team">
          <span className="matchbar__label">팀 B</span>
          <span className="matchbar__score">{scores.B}</span>
        </div>
      </button>
      {showHistory && (
        <ScoreHistory history={history} scores={scores} onClose={() => setShowHistory(false)} />
      )}
    </>
  );
}

/** Tap-the-scoreboard overlay: per-hand point swings and the running total. */
function ScoreHistory({
  history,
  scores,
  onClose,
}: {
  history: HandScore[];
  scores: { A: number; B: number };
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay__panel" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__head">
          <h3>점수 기록</h3>
          <button type="button" className="overlay__close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <table className="scorehistory">
          <thead>
            <tr>
              <th>판</th>
              <th>팀 A</th>
              <th>팀 B</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.hand}>
                <td className="scorehistory__hand">{h.hand}판</td>
                {(['A', 'B'] as const).map((team) => (
                  <td key={team}>
                    <span className={`scorehistory__delta${h.delta[team] < 0 ? ' is-neg' : ''}`}>
                      {fmt(h.delta[team])}
                    </span>
                    <span className="scorehistory__total">{h.total[team]}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>현재</td>
              <td className="scorehistory__now">{scores.A}</td>
              <td className="scorehistory__now">{scores.B}</td>
            </tr>
          </tfoot>
        </table>
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
      <p className="hint">
        각자 트릭에서 딴 카드입니다 — ✨ 빛나는 카드가 점수 카드예요. 마지막까지 남은 플레이어의
        손패도 공개됩니다.
      </p>

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
              {s.handReveal.length > 0 && (
                <div className="scoreboard__leftover">
                  <span className="scoreboard__leftover-label">
                    남은 손패 ({s.handReveal.length}장)
                  </span>
                  <CapturePile cards={s.handReveal} highlight />
                </div>
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

function Finished({
  view,
  isHost,
  onLeave,
}: {
  view: PlayerView;
  isHost: boolean;
  onLeave: () => void;
}) {
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

      {!isHost && <p className="hint">방장이 다시 시작하거나 새 방을 열 수 있어요.</p>}
      <div className="actions actions--row">
        {isHost && (
          <>
            <button className="btn btn--primary" onClick={() => socket.emit('game:restart')}>
              처음부터 다시 시작
            </button>
            <button className="btn btn--secondary" onClick={() => socket.emit('room:close')}>
              새 방 만들기
            </button>
          </>
        )}
        <button className="btn btn--ghost" onClick={onLeave}>
          방 나가기
        </button>
      </div>
    </section>
  );
}

function SeatStrip({
  view,
  nameOf,
  connectedOf,
  hostOf,
  emoteOf,
}: {
  view: PlayerView;
  nameOf: (s: Seat) => string;
  connectedOf: (s: Seat) => boolean;
  hostOf: (s: Seat) => boolean;
  emoteOf: (s: Seat) => { emoji: string; key: number } | undefined;
}) {
  const relation = (seat: Seat): string => {
    if (seat === view.selfSeat) return '나';
    if (seat === partnerSeat(view.selfSeat)) return '파트너';
    if (seat === nextSeat(view.selfSeat)) return '왼쪽';
    return '오른쪽';
  };
  // First-person 2×2 layout: "나" sits bottom-right and the seats run clockwise
  // (= turn order 나 → 왼쪽 → 파트너 → 오른쪽). Row-major DOM order below maps to
  //   [파트너] [오른쪽]
  //   [왼쪽]   [나]
  // so the partner is diagonally across and each opponent is on my left/right.
  const bySeat = new Map(view.seats.map((s) => [s.seat, s]));
  const order: Seat[] = [
    partnerSeat(view.selfSeat), // 파트너 → top-left (across)
    prevSeat(view.selfSeat), // 오른쪽 → top-right
    nextSeat(view.selfSeat), // 왼쪽 → bottom-left
    view.selfSeat, // 나 → bottom-right
  ];
  const orderedSeats = order.map((seat) => bySeat.get(seat)).filter((s) => s !== undefined);
  return (
    <div className="seatstrip">
      {orderedSeats.map((s) => {
        const isTurn = view.phase === 'playing' && s.seat === view.turn;
        const isDragon = view.phase === 'playing' && s.seat === view.pendingDragon;
        const offline = !connectedOf(s.seat);
        const emote = emoteOf(s.seat);
        const team = seatTeam(s.seat); // 'A' (seats 0·2) or 'B' (seats 1·3)
        // Finishing place, shown next to the name once a player goes out mid-hand.
        const place = view.phase === 'playing' && s.finished ? rankOf(view, s.seat) : 0;
        return (
          <div
            key={s.seat}
            className={`seatstrip__item seatstrip__item--team-${team.toLowerCase()}${
              s.seat === view.selfSeat ? ' is-self' : ''
            }${isTurn || isDragon ? ' is-turn' : ''}${offline ? ' is-offline' : ''}`}
          >
            {emote && (
              <span key={emote.key} className="seatstrip__emote">
                {emote.emoji}
              </span>
            )}
            <div className="seatstrip__rel">
              <span className="seatstrip__team">팀 {team}</span> · {relation(s.seat)}
            </div>
            <div className="seatstrip__name">
              {hostOf(s.seat) && (
                <span className="seatstrip__host" title="방장">
                  👑
                </span>
              )}
              {nameOf(s.seat)}
              {place > 0 && (
                <span
                  className={`scoreboard__rank${place > 3 ? ' scoreboard__rank--num' : ''}`}
                  title={`${place}등`}
                >
                  {rankLabelText(place)}
                </span>
              )}
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
        <TichuDeclare view={view} />
        <button className="btn btn--primary" disabled={!ready} onClick={submit}>
          카드 건네기
        </button>
      </div>
    </section>
  );
}

function Playing({
  view,
  nameOf,
  dogFlash,
  bombFlash,
}: {
  view: PlayerView;
  nameOf: (s: Seat) => string;
  dogFlash: { from: Seat; to: Seat; key: number } | null;
  bombFlash: { from: Seat; level: number; key: number } | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wish, setWish] = useState('');
  const [showAllSuggest, setShowAllSuggest] = useState(false); // expand the trimmed suggestion list

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

  // Collapse the expanded list again whenever the decision changes (new turn / hand).
  useEffect(() => setShowAllSuggest(false), [view.hand, topCombo]);

  // "Stuck": your turn, following a trick, with no legal play at all (suggestions
  // exclude the Phoenix-as-single, so check that separately). The pass is forced,
  // so we auto-pass after a short, visible countdown.
  const stuck =
    myTurn &&
    !isLeading &&
    view.pendingDragon === null &&
    suggestions.length === 0 &&
    !phoenixSingleCanBeat(view.hand, topCombo);

  const [autoPassLeft, setAutoPassLeft] = useState(0);
  useEffect(() => {
    if (!stuck) {
      setAutoPassLeft(0);
      return;
    }
    setAutoPassLeft(Math.ceil(AUTO_PASS_MS / 1000));
    const tick = setInterval(() => setAutoPassLeft((s) => (s > 1 ? s - 1 : s)), 1000);
    const pass = setTimeout(() => {
      // The #demo page has no live game; show the countdown but don't actually emit.
      if (window.location.hash !== '#demo') socket.emit('game:pass');
    }, AUTO_PASS_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(pass);
    };
  }, [stuck]);

  // While a single is on the table you can only beat it with a higher single or
  // a bomb. So restrict to one card at a time — unless the hand actually holds a
  // bomb (four of a kind / straight flush), in which case allow free multi-select
  // so the player can build it.
  const singleTrick = !isLeading && topCombo?.type === 'single';
  const allowMulti = !singleTrick || handHasBomb(view.hand);

  const toggle = (card: Card) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(card.id)) {
        next.delete(card.id);
        return next;
      }
      if (allowMulti) {
        next.add(card.id);
        return next;
      }
      return new Set([card.id]); // single-trick, no bomb available → one at a time
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
            ? `🐉 ${nameOf(view.pendingDragon)}(이)가 용 카드를 넘기는 중`
            : myTurn
              ? '내 차례'
              : `${nameOf(view.turn ?? view.selfSeat)} 차례`}
        </span>
      </div>

      <TrickArea view={view} nameOf={nameOf} dogFlash={dogFlash} bombFlash={bombFlash} />

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
              {(showAllSuggest ? suggestions : suggestions.slice(0, SUGGEST_LIMIT)).map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className="btn btn--small suggest__chip"
                  onClick={() => setSelected(new Set(c.cards.map((card) => card.id)))}
                >
                  {comboLabel(c)}
                </button>
              ))}
              {suggestions.length > SUGGEST_LIMIT && (
                <button
                  type="button"
                  className="suggest__toggle"
                  aria-expanded={showAllSuggest}
                  onClick={() => setShowAllSuggest((v) => !v)}
                >
                  {showAllSuggest ? (
                    <>접기 <span className="suggest__chevron">▴</span></>
                  ) : (
                    <>외 {suggestions.length - SUGGEST_LIMIT}개 더보기{' '}
                      <span className="suggest__chevron">▾</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        ) : (
          !isLeading &&
          (stuck ? (
            <p className="hint hint--autopass">
              🚫 낼 수 있는 카드가 없습니다 — {autoPassLeft || Math.ceil(AUTO_PASS_MS / 1000)}초 후
              자동으로 패스합니다.
            </p>
          ) : (
            <p className="hint">🚫 낼 수 있는 조합이 없습니다 — 패스하세요.</p>
          ))
        ))}

      <div className="actions actions--row">
        {!self.hasPlayed && !self.grandTichu && !self.tichu && (
          <button className="btn btn--secondary" onClick={declareTichu}>
            티츄 선언
          </button>
        )}
        <button className="btn" disabled={!myTurn || isLeading} onClick={doPass}>
          패스
        </button>
        <button className="btn btn--primary" disabled={!canPlay} onClick={play}>
          {isBomb ? '💣 폭탄 투하' : '내기'}
        </button>
      </div>
    </section>
  );
}

function TrickArea({
  view,
  nameOf,
  dogFlash,
  bombFlash,
}: {
  view: PlayerView;
  nameOf: (s: Seat) => string;
  dogFlash: { from: Seat; to: Seat; key: number } | null;
  bombFlash: { from: Seat; level: number; key: number } | null;
}) {
  // The Dog clears the table and passes the lead — show the handoff while we wait
  // for the partner to lead (i.e. until a real card lands on the empty table).
  if (dogFlash && view.trick.length === 0) {
    return (
      <div className="dog-handoff" key={dogFlash.key}>
        <span className="dog-handoff__who">{nameOf(dogFlash.from)}</span>
        <span className="dog-handoff__card">🐕</span>
        <span className="dog-handoff__arrow">리드 넘김 ▶</span>
        <span className="dog-handoff__to">{nameOf(dogFlash.to)}</span>
      </div>
    );
  }
  if (view.trick.length === 0) {
    return <p className="hint">새 트릭 — 리드할 카드를 내세요.</p>;
  }
  return (
    <div className="trick">
      {view.trick.map((play, i) => {
        const isBombPlay =
          bombFlash?.from === play.seat &&
          (play.type === 'bomb' || play.type === 'straightbomb');
        return (
          <div
            key={i}
            className={`trick__play${play.seat === view.trickOwner ? ' is-top' : ''}${
              isBombPlay ? ' trick__play--bomb' : ''
            }`}
          >
            <span className="trick__who">{nameOf(play.seat)}</span>
            <div className="trick__cards">
              {play.cards.map((card) => (
                <CardChip key={card.id} card={card} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DragonGift({ view, nameOf }: { view: PlayerView; nameOf: (s: Seat) => string }) {
  const opponents = view.seats.filter((s) => seatTeam(s.seat) !== seatTeam(view.selfSeat));
  return (
    <div className="card phase__inset">
      <p className="hint">🐉 용으로 트릭을 획득했습니다. 어느 상대에게 넘기시겠어요?</p>
      <div className="actions actions--row">
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

/**
 * The one legal play `legalMoves` deliberately omits: spending the Phoenix as a
 * plain single. It only beats a single top (and never the Dragon), so check that
 * case so auto-pass never fires while the player still has a real option.
 */
function phoenixSingleCanBeat(hand: Card[], top: Combination | null): boolean {
  if (!top || top.type !== 'single') return false;
  const topCard = top.cards[0];
  if (topCard.kind === 'special' && topCard.name === 'dragon') return false; // only a bomb beats 용
  return hand.some((c) => c.kind === 'special' && c.name === 'phoenix');
}

function isDogSingle(cards: Card[]): boolean {
  return cards.length === 1 && cards[0].kind === 'special' && cards[0].name === 'dog';
}

/** Does the hand contain a bomb — four of a kind, or a same-suit run of 5+? */
function handHasBomb(hand: Card[]): boolean {
  const byRank = new Map<number, number>();
  const bySuit = new Map<string, Set<number>>();
  for (const c of hand) {
    if (c.kind !== 'suit') continue; // bombs are made of plain suit cards only
    byRank.set(c.rank, (byRank.get(c.rank) ?? 0) + 1);
    if (!bySuit.has(c.suit)) bySuit.set(c.suit, new Set());
    bySuit.get(c.suit)!.add(c.rank);
  }
  for (const count of byRank.values()) if (count >= 4) return true; // four of a kind
  for (const ranks of bySuit.values()) {
    let run = 0;
    for (let r = 2; r <= 14; r++) {
      run = ranks.has(r) ? run + 1 : 0;
      if (run >= 5) return true; // straight flush
    }
  }
  return false;
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

// Display grouping for suggestions: fewer-card shapes first, so leading the trick
// shows options grouped by type (singles, then pairs, …). Bombs are ordered last
// here too, but bombLevel already pushes them behind every non-bomb in the sort.
const TYPE_ORDER: Record<CombinationType, number> = {
  single: 0,
  pair: 1,
  triple: 2,
  stairs: 3,
  fullhouse: 4,
  straight: 5,
  bomb: 6,
  straightbomb: 7,
};

// How many suggestion chips to show before collapsing the rest behind "더보기".
const SUGGEST_LIMIT = 8;

// When you're following a trick with no legal play at all, the pass is forced —
// auto-pass after this delay so a stuck turn doesn't make you click every time.
const AUTO_PASS_MS = 2500;

function comboLabel(c: Combination): string {
  const base = TYPE_LABEL[c.type];
  const r = rankLabel(c.rank);
  if (c.type === 'straight' || c.type === 'stairs' || c.type === 'straightbomb') {
    return `${base} ~${r} (${c.length}장)`;
  }
  // A single special card reads by name (e.g. 용/참새) rather than a numeric rank.
  const single = c.cards[0];
  if (c.type === 'single' && single?.kind === 'special') {
    const name = single.name === 'mahjong' ? '참새' : cardText(single);
    return `${base} ${name}`;
  }
  return `${base} ${r}`;
}

/**
 * Legal plays from `hand` against the current `top` (null = leading). Brute-forces
 * card subsets (hand ≤14) through the shared detector, dedupes by logical combo,
 * and sorts non-bombs first, grouped by combination type, then cheapest (lowest
 * rank, fewest cards) within a type. A hint only — the server remains authoritative.
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
    // Don't suggest spending the Phoenix as a plain single — it's a waste of the wildcard.
    if (combo.type === 'single' && isPhoenixSingle(combo.cards)) continue;
    const key = `${combo.type}:${combo.rank}:${combo.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(combo);
  }
  out.sort(
    (a, b) =>
      a.bombLevel - b.bombLevel || // 1) non-bombs first, bombs last
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || // 2) group by combination type
      a.rank - b.rank || // 3) cheapest (lowest rank) first within a type
      a.length - b.length, // 4) then fewer cards
  );
  return out;
}

function capturedPoints(cards: Card[]): number {
  return cards.reduce((total, card) => total + cardPoints(card), 0);
}

/**
 * A face-down, overlapping stack hinting at how many cards a player has won.
 * Capped at 10 backs and wrapped into rows of 5 so a big pile can't widen the
 * panel and reflow the seat grid on mobile.
 */
function CardBackStack({ count }: { count: number }) {
  const shown = Math.min(count, 10);
  const perRow = 10; // single row — the captured pile stays on one line
  const rows: number[] = [];
  for (let i = 0; i < shown; i += perRow) rows.push(Math.min(perRow, shown - i));
  return (
    <div className="cardbackstack" title={`${count}장`}>
      {rows.map((n, r) => (
        <div key={r} className="cardbackstack__row">
          {Array.from({ length: n }, (_, i) => (
            <span key={i} className="cardback" />
          ))}
        </div>
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
