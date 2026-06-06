import type { Server, Socket } from 'socket.io';
import {
  declareGrandTichu,
  declareTichu,
  EMOTES,
  giveDragon,
  pass,
  playCards,
  submitExchange,
  toPlayerView,
  type ClientToServerEvents,
  type Emote,
  type GameState,
  type InterServerEvents,
  type Room,
  type Seat,
  type ServerToClientEvents,
  type SocketData,
} from '@tichu/shared';
import type { RoomManager } from './roomManager';
import type { GameManager } from './gameManager';

export type TichuServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type TichuSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** Wire one connected socket up to the room and game managers. */
export function registerSocketHandlers(
  io: TichuServer,
  socket: TichuSocket,
  rooms: RoomManager,
  games: GameManager,
): void {
  const emitRoom = (code: string) => {
    const room = rooms.getRoom(code);
    if (room) io.to(code).emit('room:update', room);
  };

  // Send each seated player their own redacted view of the game state.
  const emitGameState = (room: Room) => {
    const state = games.getState(room.code);
    const match = games.getMatchInfo(room.code);
    if (!state || !match) return;
    for (const player of room.players) {
      if (player.seat !== null) {
        io.to(player.id).emit('game:state', toPlayerView(state, player.seat, match));
      }
    }
  };

  // Resolve the calling socket's room + game + seat, throwing a friendly error
  // if any piece is missing.
  const requireGame = (): { room: Room; state: GameState; seat: Seat } => {
    const room = rooms.getRoomBySocket(socket.id);
    if (!room) throw new Error('참여 중인 방이 없습니다.');
    const state = games.getState(room.code);
    if (!state) throw new Error('진행 중인 게임이 없습니다.');
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.seat === null) throw new Error('게임에 참여한 자리가 없습니다.');
    return { room, state, seat: player.seat };
  };

  // Run a game mutation, settle the hand if it finished, and broadcast views.
  const withGame = (fn: (ctx: { room: Room; state: GameState; seat: Seat }) => void) => {
    try {
      const ctx = requireGame();
      fn(ctx);
      games.settle(ctx.room.code);
      emitGameState(ctx.room);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  };

  socket.on('room:create', ({ nickname, teamSelectionMode }, ack) => {
    try {
      const name = sanitizeNickname(nickname);
      const { room, token } = rooms.createRoom(socket.id, name, teamSelectionMode);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      ack({ ok: true, data: { room, selfId: socket.id, token } });
    } catch (err) {
      ack({ ok: false, error: errMessage(err) });
    }
  });

  socket.on('room:join', ({ code, nickname }, ack) => {
    try {
      const name = sanitizeNickname(nickname);
      const { room, token } = rooms.joinRoom(socket.id, normalizeCode(code), name);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      ack({ ok: true, data: { room, selfId: socket.id, token } });
      emitRoom(room.code);
    } catch (err) {
      ack({ ok: false, error: errMessage(err) });
    }
  });

  socket.on('room:reconnect', ({ code, token }, ack) => {
    try {
      const { room } = rooms.reconnect(token, socket.id);
      if (room.code !== normalizeCode(code)) throw new Error('세션 정보가 일치하지 않습니다.');
      socket.join(room.code);
      socket.data.roomCode = room.code;
      ack({ ok: true, data: { room, selfId: socket.id, token } });
      emitRoom(room.code);
      // Restore the player's redacted game view if a game is in progress.
      if (games.getState(room.code)) emitGameState(room);
    } catch (err) {
      ack({ ok: false, error: errMessage(err) });
    }
  });

  socket.on('room:setSeat', ({ seat }) => {
    try {
      const room = rooms.setSeat(socket.id, seat);
      emitRoom(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('room:randomizeTeams', () => {
    try {
      const room = rooms.randomizeTeams(socket.id);
      emitRoom(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('game:start', () => {
    try {
      const room = rooms.startGame(socket.id);
      emitRoom(room.code);
      games.start(room.code);
      emitGameState(room);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('game:grandTichu', ({ declare }) => {
    withGame(({ state, seat }) => declareGrandTichu(state, seat, declare));
  });

  socket.on('game:exchange', (selection) => {
    withGame(({ state, seat }) => submitExchange(state, seat, selection));
  });

  socket.on('game:tichu', () => {
    withGame(({ state, seat }) => declareTichu(state, seat));
  });

  socket.on('game:play', ({ cardIds, wish, desiredTop, phoenixAsLowerTriple }) => {
    withGame(({ state, seat }) => playCards(state, seat, cardIds, { wish, desiredTop, phoenixAsLowerTriple }));
  });

  socket.on('game:pass', () => {
    withGame(({ state, seat }) => pass(state, seat));
  });

  socket.on('game:giveDragon', ({ toSeat }) => {
    withGame(({ state, seat }) => giveDragon(state, seat, toSeat));
  });

  socket.on('game:nextHand', () => {
    try {
      const room = rooms.getRoomBySocket(socket.id);
      if (!room) throw new Error('참여 중인 방이 없습니다.');
      if (room.hostId !== socket.id) throw new Error('방장만 다음 판을 시작할 수 있습니다.');
      games.nextHand(room.code);
      emitGameState(room);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('game:emote', ({ emoji }) => {
    // Validate against the shared set; silently ignore junk, unseated players,
    // and bursts faster than the cooldown (no error toast for emotes).
    if (!EMOTES.includes(emoji as Emote)) return;
    const now = Date.now();
    if (now - (socket.data.lastEmoteAt ?? 0) < 700) return;
    const room = rooms.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.seat === null) return;
    socket.data.lastEmoteAt = now;
    io.to(room.code).emit('game:emote', { seat: player.seat, emoji });
  });

  socket.on('disconnect', () => {
    const room = rooms.disconnect(socket.id);
    if (room) emitRoom(room.code);
  });
}

function sanitizeNickname(raw: string): string {
  const name = (raw ?? '').trim().slice(0, 16);
  if (!name) throw new Error('닉네임을 입력해주세요.');
  return name;
}

function normalizeCode(raw: string): string {
  return (raw ?? '').trim().toUpperCase();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
}
