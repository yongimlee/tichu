import { useEffect, useState } from 'react';
import type { MatchInfo, PlayerView, Room } from '@tichu/shared';
import { socket } from './socket';
import { Home } from './pages/Home';
import { RoomView } from './pages/RoomView';
import { GameView } from './pages/GameView';
import { Demo } from './pages/Demo';

// Persisted reconnect session — lets us rejoin our seat after a drop/refresh.
const SESSION_KEY = 'tichu.session';
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
    setRoom(null);
    setView(null);
    setSelfId('');
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

      <main className="app__main">
        {hash === '#demo' ? (
          <Demo />
        ) : room && view ? (
          <GameView view={view} room={room} onLeave={handleLeave} />
        ) : room ? (
          <RoomView room={room} selfId={selfId} onLeave={handleLeave} />
        ) : (
          <Home onJoined={handleJoined} onError={setError} />
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
