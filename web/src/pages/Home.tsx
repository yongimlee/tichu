import { useState } from 'react';
import {
  DEFAULT_TARGET,
  TARGET_OPTIONS,
  type Ack,
  type JoinResult,
  type Room,
  type TeamSelectionMode,
} from '@tichu/shared';
import { socket } from '../socket';

interface Props {
  onJoined: (room: Room, selfId: string, token: string) => void;
  onError: (message: string) => void;
}

type Tab = 'create' | 'join';

export function Home({ onJoined, onError }: Props) {
  const [tab, setTab] = useState<Tab>('create');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [teamMode, setTeamMode] = useState<TeamSelectionMode>('manual');
  const [targetScore, setTargetScore] = useState<number>(DEFAULT_TARGET);

  const handleAck = (res: Ack<JoinResult>) => {
    if (res.ok) onJoined(res.data.room, res.data.selfId, res.data.token);
    else onError(res.error);
  };

  const createRoom = () => {
    if (!nickname.trim()) return onError('닉네임을 입력해주세요.');
    socket.emit('room:create', { nickname, teamSelectionMode: teamMode, targetScore }, handleAck);
  };

  const joinRoom = () => {
    if (!nickname.trim()) return onError('닉네임을 입력해주세요.');
    if (!code.trim()) return onError('초대 코드를 입력해주세요.');
    socket.emit('room:join', { code, nickname }, handleAck);
  };

  return (
    <div className="card home">
      <div className="field">
        <label htmlFor="nickname">닉네임</label>
        <input
          id="nickname"
          value={nickname}
          maxLength={16}
          placeholder="다른 플레이어에게 보일 이름"
          onChange={(e) => setNickname(e.target.value)}
        />
      </div>

      <div className="tabs">
        <button
          className={tab === 'create' ? 'tab tab--active' : 'tab'}
          onClick={() => setTab('create')}
        >
          방 만들기
        </button>
        <button
          className={tab === 'join' ? 'tab tab--active' : 'tab'}
          onClick={() => setTab('join')}
        >
          초대 코드로 입장
        </button>
      </div>

      {tab === 'create' ? (
        <div className="panel">
          <div className="field">
            <label>팀 선정 방식</label>
            <div className="choices">
              <label className="choice">
                <input
                  type="radio"
                  name="teamMode"
                  checked={teamMode === 'manual'}
                  onChange={() => setTeamMode('manual')}
                />
                <span>
                  <strong>직접 선택</strong>
                  <small>각자 원하는 자리에 앉아 팀을 구성</small>
                </span>
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="teamMode"
                  checked={teamMode === 'random'}
                  onChange={() => setTeamMode('random')}
                />
                <span>
                  <strong>랜덤 배정</strong>
                  <small>방장이 4명의 팀·자리를 무작위로 배정</small>
                </span>
              </label>
            </div>
          </div>
          <div className="field">
            <label htmlFor="target">목표 점수</label>
            <select
              id="target"
              value={targetScore}
              onChange={(e) => setTargetScore(Number(e.target.value))}
            >
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}점
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn--primary" onClick={createRoom}>
            방 만들기
          </button>
        </div>
      ) : (
        <div className="panel">
          <div className="field">
            <label htmlFor="code">초대 코드</label>
            <input
              id="code"
              value={code}
              placeholder="예: ABC123"
              autoCapitalize="characters"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </div>
          <button className="btn btn--primary" onClick={joinRoom}>
            입장하기
          </button>
        </div>
      )}
    </div>
  );
}
