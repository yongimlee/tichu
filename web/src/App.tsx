import { useEffect, useState } from 'react';
import type { PlayerView, Room } from '@tichu/shared';
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

export function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [selfId, setSelfId] = useState('');
  const [error, setError] = useState('');

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
    socket.on('room:update', onUpdate);
    socket.on('room:error', onError);
    socket.on('game:state', onGameState);
    socket.on('room:closed', onClosed);
    return () => {
      socket.off('room:update', onUpdate);
      socket.off('room:error', onError);
      socket.off('game:state', onGameState);
      socket.off('room:closed', onClosed);
    };
  }, []);

  // Auto-dismiss transient error toasts.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(t);
  }, [error]);

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
          clearSession();
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
        <h1 className="app__title">Tichu</h1>
      </header>

      {error && <div className="toast toast--error">{error}</div>}

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
