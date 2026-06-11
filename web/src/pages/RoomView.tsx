import {
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_EMOJI,
  BOT_DIFFICULTY_LABELS,
  BOT_DIFFICULTY_NAMES,
  DEFAULT_BOT_DIFFICULTY,
  type Room,
  type Seat,
} from '@tichu/shared';
import { socket } from '../socket';
import { RulesGuide } from '../components/RulesGuide';

interface Props {
  room: Room;
  selfId: string;
  onLeave: () => void;
}

// Team A occupies seats 0 & 2, team B seats 1 & 3 (partners sit opposite).
const TEAMS: { id: 'A' | 'B'; label: string; seats: Seat[] }[] = [
  { id: 'A', label: '팀 A', seats: [0, 2] },
  { id: 'B', label: '팀 B', seats: [1, 3] },
];

export function RoomView({ room, selfId, onLeave }: Props) {
  const self = room.players.find((p) => p.id === selfId);
  const isHost = self?.isHost ?? false;
  const isManual = room.teamSelectionMode === 'manual';

  const occupant = (seat: Seat) => room.players.find((p) => p.seat === seat);
  const unseated = room.players.filter((p) => p.seat === null);
  const seatedCount = room.players.filter((p) => p.seat !== null).length;

  const sit = (seat: Seat) => socket.emit('room:setSeat', { seat });
  const stand = () => socket.emit('room:setSeat', { seat: null });
  const randomize = () => socket.emit('room:randomizeTeams');
  const start = () => socket.emit('game:start');

  const copyCode = () => {
    void navigator.clipboard?.writeText(room.code);
  };

  return (
    <div className="room">
      <section className="card invite">
        <div>
          <div className="invite__label">초대 코드</div>
          <div className="invite__code">{room.code}</div>
          <div className="invite__meta">목표 {room.targetScore}점</div>
        </div>
        <button className="btn btn--ghost" onClick={copyCode}>
          코드 복사
        </button>
      </section>

      <section className="teams">
        {TEAMS.map((team) => (
          <div key={team.id} className={`team team--${team.id.toLowerCase()}`}>
            <h2 className="team__label">{team.label}</h2>
            {team.seats.map((seat) => {
              const player = occupant(seat);
              const isSelf = player?.id === selfId;
              return (
                <div
                  key={seat}
                  className={`seat${player ? ' seat--filled' : ''}${isSelf ? ' seat--self' : ''}`}
                >
                  {player ? (
                    <>
                      <span className="seat__name">
                        {player.nickname}
                        {player.isBot && (
                          <span className="badge">
                            {BOT_DIFFICULTY_LABELS[player.difficulty ?? DEFAULT_BOT_DIFFICULTY]}
                          </span>
                        )}
                        {player.isHost && <span className="badge">방장</span>}
                        {isSelf && <span className="badge badge--self">나</span>}
                      </span>
                      {isManual && isSelf && (
                        <button className="btn btn--small" onClick={stand}>
                          일어서기
                        </button>
                      )}
                      {player.isBot && isHost && (
                        <button
                          className="btn btn--small"
                          onClick={() => socket.emit('room:removeBot', { playerId: player.id })}
                        >
                          내보내기
                        </button>
                      )}
                    </>
                  ) : isManual ? (
                    <button className="btn btn--small" onClick={() => sit(seat)}>
                      이 자리에 앉기
                    </button>
                  ) : (
                    <span className="seat__empty">빈 자리</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </section>

      {unseated.length > 0 && (
        <section className="card waiting">
          <h3>대기 중 ({unseated.length})</h3>
          <ul className="waiting__list">
            {unseated.map((p) => (
              <li key={p.id}>
                {p.nickname}
                {p.id === selfId && <span className="badge badge--self">나</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="actions">
        {isHost && seatedCount < 4 && (
          <div className="addbot">
            <span className="addbot__title">빈 자리에 봇을 추가할 수 있어요</span>
            <div className="addbot__grid">
              {BOT_DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  className="btn btn--secondary addbot__btn"
                  onClick={() => socket.emit('room:addBot', { difficulty: d })}
                >
                  <span className="addbot__emoji">{BOT_DIFFICULTY_EMOJI[d]}</span>
                  <span className="addbot__name">{BOT_DIFFICULTY_NAMES[d]}</span>
                  <span className="addbot__tier">{BOT_DIFFICULTY_LABELS[d]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!isManual && isHost && (
          <button className="btn btn--secondary" onClick={randomize}>
            팀 랜덤 배정
          </button>
        )}
        {isHost && (
          <button className="btn btn--primary" onClick={start} disabled={seatedCount !== 4}>
            게임 시작 ({seatedCount}/4)
          </button>
        )}
        {!isHost && <p className="hint">방장이 게임을 시작하기를 기다리는 중…</p>}
        <button className="btn btn--ghost" onClick={onLeave}>
          나가기
        </button>
      </section>

      <RulesGuide />
    </div>
  );
}
