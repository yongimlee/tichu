import { useEffect, useState } from 'react';
import type { PlayerView, Room } from '@tichu/shared';
import { socket } from './socket';
import { Home } from './pages/Home';
import { RoomView } from './pages/RoomView';
import { GameView } from './pages/GameView';
import { Demo } from './pages/Demo';

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
    socket.on('room:update', onUpdate);
    socket.on('room:error', onError);
    socket.on('game:state', onGameState);
    return () => {
      socket.off('room:update', onUpdate);
      socket.off('room:error', onError);
      socket.off('game:state', onGameState);
    };
  }, []);

  // Auto-dismiss transient error toasts.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(t);
  }, [error]);

  const handleJoined = (r: Room, id: string) => {
    setSelfId(id);
    setRoom(r);
  };

  const handleLeave = () => {
    // Reconnecting drops our server-side room membership cleanly.
    socket.disconnect();
    socket.connect();
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
          <GameView view={view} room={room} />
        ) : room ? (
          <RoomView room={room} selfId={selfId} onLeave={handleLeave} />
        ) : (
          <Home onJoined={handleJoined} onError={setError} />
        )}
      </main>
    </div>
  );
}
