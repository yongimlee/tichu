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
import { RulesGuide } from '../components/RulesGuide';
import { resetTutorialProgress } from '../components/TutorialCoach';

interface Props {
  onJoined: (room: Room, selfId: string, token: string) => void;
  onError: (message: string) => void;
  /** Flag the session as a solo tutorial before its room is created. */
  onTutorial: () => void;
}

// A short target so the guided walkthrough reaches the end-of-game screen quickly.
const TUTORIAL_TARGET = 200;

type Tab = 'create' | 'join';

export function Home({ onJoined, onError, onTutorial }: Props) {
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

  // One-tap solo tutorial: spin up a manual room, take seat 0, fill the other
  // three seats with easiest (짹짹) bots, and start. The emits after create are
  // fire-and-forget — Socket.IO preserves order per connection, so the server
  // applies seat → 3×bot → start in sequence before dealing.
  const startTutorial = () => {
    const name = nickname.trim() || '나';
    resetTutorialProgress(); // start the walkthrough from the first bubble
    onTutorial();
    socket.emit(
      'room:create',
      { nickname: name, teamSelectionMode: 'manual', targetScore: TUTORIAL_TARGET, tutorial: true },
      (res: Ack<JoinResult>) => {
        if (!res.ok) return onError(res.error);
        onJoined(res.data.room, res.data.selfId, res.data.token);
        socket.emit('room:setSeat', { seat: 0 });
        socket.emit('room:addBot', { difficulty: 'easy' });
        socket.emit('room:addBot', { difficulty: 'easy' });
        socket.emit('room:addBot', { difficulty: 'easy' });
        socket.emit('game:start');
      },
    );
  };

  return (
    <>
    <div className="card home">
      <div className="field">
        <label htmlFor="nickname">닉네임</label>
        <input
          id="nickname"
          value={nickname}
          maxLength={8}
          placeholder="다른 플레이어에게 보일 이름 (최대 8자)"
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

          <div className="tutorial-cta">
            <div className="tutorial-cta__divider">
              <span>처음이신가요?</span>
            </div>
            <button className="btn btn--tutorial" onClick={startTutorial}>
              🎓 튜토리얼 모드
            </button>
            <p className="tutorial-cta__note">
              짹짹봇 3명과 함께 게임 흐름에 따라 규칙을 익혀요. 혼자 연습할 수 있어요.
            </p>
          </div>
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
    <RulesGuide />
    </>
  );
}
