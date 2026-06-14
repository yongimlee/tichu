import { useEffect, useState } from 'react';
import type { MatchInfo, PlayerView, Room } from '@tichu/shared';
import { socket } from './socket';
import { Home } from './pages/Home';
import { RoomView } from './pages/RoomView';
import { GameView } from './pages/GameView';
import { Demo } from './pages/Demo';

// Persisted reconnect session — lets us rejoin our seat after a drop/refresh.
const SESSION_KEY = 'tichu.session';
// Marks the current room as a solo tutorial so the coach overlay survives a refresh.
const TUTORIAL_KEY = 'tichu.tutorial';
type Session = { code: string; token: string };
function loadSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
  } catch {
    return null;
  }
}
function saveSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

// Stand-in match for the #demo header so the playtime timer is visible without
// a running game (the Demo page builds its own PlayerView separately).
const DEMO_MATCH: MatchInfo = {
  scores: { A: 120, B: 85 },
  target: 500,
  handNumber: 3,
  winner: null,
  history: [],
  startedAt: Date.now() - 1000 * 60 * 23, // 23 minutes in
  endedAt: null,
};

export function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [selfId, setSelfId] = useState('');
  const [error, setError] = useState('');
  const [praiseAt, setPraiseAt] = useState(0); // head-pat-the-dev easter egg
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Feedback (VOC) — bug reports / suggestions, posted to a separate Discord channel.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSentAt, setFeedbackSentAt] = useState(0);
  const [tutorial, setTutorial] = useState(() => localStorage.getItem(TUTORIAL_KEY) === '1');

  // Dev-only UI showcase: open with #demo to view the in-game screen solo.
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onUpdate = (r: Room) => setRoom(r);
    const onError = (p: { message: string }) => setError(p.message);
    const onGameState = (v: PlayerView) => setView(v);
    const onClosed = () => {
      // Room was dissolved (host closed it) — drop everything and go home.
      clearSession();
      localStorage.removeItem(TUTORIAL_KEY);
      setTutorial(false);
      setRoom(null);
      setView(null);
      setSelfId('');
    };
    // The match ended but the room lives on (host re-seating) — drop just the
    // game view so the lobby (RoomView) shows again. room:update keeps the room.
    const onGameClosed = () => setView(null);
    socket.on('room:update', onUpdate);
    socket.on('room:error', onError);
    socket.on('game:state', onGameState);
    socket.on('room:closed', onClosed);
    socket.on('game:closed', onGameClosed);
    return () => {
      socket.off('room:update', onUpdate);
      socket.off('room:error', onError);
      socket.off('game:state', onGameState);
      socket.off('room:closed', onClosed);
      socket.off('game:closed', onGameClosed);
    };
  }, []);

  // Auto-dismiss transient error toasts.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // Auto-dismiss the "의견 감사합니다" confirmation after a feedback send.
  useEffect(() => {
    if (!feedbackSentAt) return;
    const t = setTimeout(() => setFeedbackSentAt(0), 2500);
    return () => clearTimeout(t);
  }, [feedbackSentAt]);

  // Auto-dismiss the "개발자가 좋아합니다" message (re-armed on each pat).
  useEffect(() => {
    if (!praiseAt) return;
    const t = setTimeout(() => setPraiseAt(0), 2500);
    return () => clearTimeout(t);
  }, [praiseAt]);

  // On every (re)connect, if we hold a saved session, rejoin our seat. This
  // covers a page refresh and an auto-reconnect after the network dropped.
  useEffect(() => {
    const tryReconnect = () => {
      const s = loadSession();
      if (!s) return;
      socket.emit('room:reconnect', { code: s.code, token: s.token }, (res) => {
        if (res.ok) {
          setSelfId(res.data.selfId);
          setRoom(res.data.room);
        } else {
          // The room is gone (e.g. it was purged while we were disconnected).
          // Drop the dead session and return to the home screen instead of
          // leaving a stale game view whose buttons would all error.
          clearSession();
          localStorage.removeItem(TUTORIAL_KEY);
          setTutorial(false);
          setRoom(null);
          setView(null);
          setSelfId('');
          setError('방을 찾을 수 없어 처음 화면으로 돌아갑니다.');
        }
      });
    };
    socket.on('connect', tryReconnect);
    if (socket.connected) tryReconnect();
    return () => {
      socket.off('connect', tryReconnect);
    };
  }, []);

  const handleJoined = (r: Room, id: string, token: string) => {
    setSelfId(id);
    setRoom(r);
    saveSession({ code: r.code, token });
  };

  const handleLeave = () => {
    socket.emit('room:leave'); // server removes us (and purges the room if empty)
    clearSession();
    localStorage.removeItem(TUTORIAL_KEY);
    setTutorial(false);
    setRoom(null);
    setView(null);
    setSelfId('');
  };

  // Enter solo tutorial mode: flag it (so the coach shows and survives a refresh)
  // and reset lesson progress so the walkthrough starts from the first bubble.
  const handleTutorial = () => {
    localStorage.setItem(TUTORIAL_KEY, '1');
    setTutorial(true);
  };

  const sendFeedback = () => {
    const message = feedbackText.trim();
    if (!message || feedbackSending) return;
    setFeedbackSending(true);
    socket.timeout(8000).emit('dev:feedback', { message }, (err, res) => {
      setFeedbackSending(false);
      if (err) {
        setError('전송에 실패했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setFeedbackOpen(false);
      setFeedbackText('');
      setFeedbackSentAt(Date.now());
    });
  };

  const inGame = hash === '#demo' || Boolean(room && view);

  return (
    <div className={`app${inGame ? ' app--wide' : ''}`}>
      <header className="app__header">
        <h1 className="app__title">TICHU</h1>
        <div className="app__controls">
          {(room && view) || hash === '#demo' ? (
            <button type="button" className="leave-btn" onClick={() => setConfirmLeave(true)}>
              🚪 방 나가기
            </button>
          ) : (
            <span />
          )}
          <div className="dev-actions">
            <div className="voc">
              {feedbackSentAt > 0 && <div className="pat-toast">편지 전달 중 💌</div>}
              <button
                type="button"
                className="voc-btn"
                onClick={() => setFeedbackOpen(true)}
                title="편지쓰기"
              >
                💌 편지쓰기
              </button>
            </div>
            <div className="pat">
              {praiseAt > 0 && <div className="pat-toast">개발자가 좋아합니다🥰</div>}
              <button
                type="button"
                className="pat-btn"
                onClick={() => {
                  setPraiseAt(Date.now());
                  socket.emit('dev:pat'); // server logs who patted (anon on home)
                }}
                title="개발자 쓰담쓰담"
              >
                🫳 개발자 쓰담쓰담
              </button>
            </div>
          </div>
        </div>
        {room && view ? (
          <PlayTime match={view.match} />
        ) : hash === '#demo' ? (
          <PlayTime match={DEMO_MATCH} />
        ) : null}
      </header>

      {error && <div className="toast toast--error">{error}</div>}

      {confirmLeave && (
        <div className="modal-overlay" onClick={() => setConfirmLeave(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">방을 나가시겠어요?</h3>
            <p className="modal__body">진행 중인 게임에서 빠지게 됩니다.</p>
            <div className="modal__actions">
              <button
                type="button"
                className="btn modal__btn modal__btn--danger"
                onClick={() => {
                  setConfirmLeave(false);
                  if (hash !== '#demo') handleLeave(); // demo: visual only
                }}
              >
                나가기
              </button>
              <button
                type="button"
                className="btn btn--ghost modal__btn"
                onClick={() => setConfirmLeave(false)}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {feedbackOpen && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!feedbackSending) setFeedbackOpen(false);
          }}
        >
          <div className="modal modal--feedback" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">💌 편지쓰기</h3>
            <p className="modal__body">적어주신 내용은 개발자에게 전달됩니다.</p>
            <textarea
              className="feedback__input"
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value.slice(0, 1000))}
              placeholder="무엇이든 자유롭게 적어주세요 (최대 1000자) — 버그, 건의사항, 하고싶은 말 등"
              rows={5}
              maxLength={1000}
              autoFocus
              disabled={feedbackSending}
            />
            <div className="feedback__count">{feedbackText.length}/1000</div>
            <div className="modal__actions">
              <button
                type="button"
                className="btn modal__btn"
                onClick={sendFeedback}
                disabled={feedbackSending || !feedbackText.trim()}
              >
                {feedbackSending ? '보내는 중…' : '보내기'}
              </button>
              <button
                type="button"
                className="btn btn--ghost modal__btn"
                onClick={() => setFeedbackOpen(false)}
                disabled={feedbackSending}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="app__main">
        {hash === '#demo' ? (
          <Demo />
        ) : room && view ? (
          <GameView
            view={view}
            room={room}
            onLeave={handleLeave}
            onError={setError}
            tutorial={tutorial}
          />
        ) : room ? (
          <RoomView room={room} selfId={selfId} onLeave={handleLeave} />
        ) : (
          <Home onJoined={handleJoined} onError={setError} onTutorial={handleTutorial} />
        )}
      </main>
    </div>
  );
}

/**
 * Total game duration, shown centered in the controls row. Counts up from the
 * match start and freezes once the game ends (target score reached). Displayed
 * as HH:MM (시:분) — both server timestamps come from the authoritative match.
 */
function PlayTime({ match }: { match: MatchInfo }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (match.endedAt) return; // game over — leave the final time frozen
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [match.endedAt]);

  const end = match.endedAt ?? now;
  const totalMin = Math.max(0, Math.floor((end - match.startedAt) / 60000));
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const mm = String(totalMin % 60).padStart(2, '0');
  return (
    <span className="playtime">
      플레이타임 {hh}:{mm}
    </span>
  );
}
