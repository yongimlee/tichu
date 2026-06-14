import type { Server, Socket } from 'socket.io';
import {
  BOT_DIFFICULTIES,
  declareGrandTichu,
  declareTichu,
  DEFAULT_BOT_DIFFICULTY,
  EMOTES,
  giveDragon,
  pass,
  playCards,
  submitExchange,
  toPlayerView,
  type ActionResult,
  type BotDifficulty,
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
import type { BotDriver } from './bot';

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
  bots: BotDriver,
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
  const withGame = (
    fn: (ctx: { room: Room; state: GameState; seat: Seat }) => void,
    ack?: (res: ActionResult) => void,
  ) => {
    try {
      const ctx = requireGame();
      fn(ctx);
      games.settle(ctx.room.code);
      emitGameState(ctx.room);
      bots.kick(ctx.room.code);
      ack?.({ ok: true });
    } catch (err) {
      const message = errMessage(err);
      // Keep the user-facing toast (all callers). The ack is an additional, reliable
      // signal for callers that pass one, so they can resync after a rejection.
      socket.emit('room:error', { message });
      ack?.({ ok: false, error: message });
    }
  };

  socket.on('room:create', ({ nickname, teamSelectionMode, targetScore, tutorial }, ack) => {
    try {
      const name = sanitizeNickname(nickname);
      const { room, token } = rooms.createRoom(
        socket.id,
        name,
        teamSelectionMode,
        targetScore,
        tutorial === true,
      );
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
      if (games.getState(room.code)) {
        emitGameState(room);
        bots.kick(room.code);
      }
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

  socket.on('room:addBot', (payload) => {
    try {
      const room = rooms.getRoomBySocket(socket.id);
      if (!room) throw new Error('참여 중인 방이 없습니다.');
      if (room.hostId !== socket.id) throw new Error('방장만 봇을 추가할 수 있습니다.');
      const difficulty = BOT_DIFFICULTIES.includes(payload?.difficulty as BotDifficulty)
        ? (payload!.difficulty as BotDifficulty)
        : DEFAULT_BOT_DIFFICULTY;
      rooms.addBot(socket.id, difficulty);
      emitRoom(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('room:removeBot', ({ playerId }) => {
    try {
      const room = rooms.getRoomBySocket(socket.id);
      if (!room) throw new Error('참여 중인 방이 없습니다.');
      if (room.hostId !== socket.id) throw new Error('방장만 봇을 제거할 수 있습니다.');
      rooms.removeBot(socket.id, playerId);
      emitRoom(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('game:start', () => {
    try {
      const room = rooms.startGame(socket.id);
      emitRoom(room.code);
      games.start(room.code, room.targetScore, room.tutorial === true);
      emitGameState(room);
      bots.kick(room.code);
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

  socket.on('game:play', ({ cardIds, wish, desiredTop, phoenixAsLowerTriple }, ack) => {
    withGame(
      ({ state, seat }) => playCards(state, seat, cardIds, { wish, desiredTop, phoenixAsLowerTriple }),
      ack,
    );
  });

  socket.on('game:pass', (ack) => {
    withGame(({ state, seat }) => pass(state, seat), ack);
  });

  socket.on('game:giveDragon', ({ toSeat }) => {
    withGame(({ state, seat }) => giveDragon(state, seat, toSeat));
  });

  // Resync: re-send just this socket's redacted view so a desynced client (e.g. a
  // turn a bot took over during a blip) recovers without disturbing the others.
  socket.on('game:resync', () => {
    try {
      const { room, state, seat } = requireGame();
      const match = games.getMatchInfo(room.code);
      if (match) io.to(socket.id).emit('game:state', toPlayerView(state, seat, match));
    } catch {
      // No room/game/seat to resync to — nothing to send.
    }
  });

  socket.on('game:nextHand', () => {
    try {
      const room = rooms.getRoomBySocket(socket.id);
      if (!room) throw new Error('참여 중인 방이 없습니다.');
      if (room.hostId !== socket.id) throw new Error('방장만 다음 판을 시작할 수 있습니다.');
      games.nextHand(room.code);
      emitGameState(room);
      bots.kick(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('game:restart', () => {
    try {
      const room = rooms.getRoomBySocket(socket.id);
      if (!room) throw new Error('참여 중인 방이 없습니다.');
      if (room.hostId !== socket.id) throw new Error('방장만 다시 시작할 수 있습니다.');
      games.start(room.code, room.targetScore); // fresh match, scores reset to 0
      emitRoom(room.code);
      emitGameState(room);
      bots.kick(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('game:reseat', () => {
    try {
      const room = rooms.reopenLobby(socket.id); // status → lobby, human seats cleared
      games.end(room.code); // drop the finished match
      io.to(room.code).emit('game:closed'); // clients tear down the game view → lobby
      emitRoom(room.code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('room:close', () => {
    try {
      const room = rooms.getRoomBySocket(socket.id);
      if (!room) throw new Error('참여 중인 방이 없습니다.');
      if (room.hostId !== socket.id) throw new Error('방장만 방을 닫을 수 있습니다.');
      const code = room.code;
      io.to(code).emit('room:closed'); // notify everyone before tearing it down
      io.in(code).socketsLeave(code);
      games.end(code);
      rooms.closeRoom(code);
    } catch (err) {
      socket.emit('room:error', { message: errMessage(err) });
    }
  });

  socket.on('room:leave', () => {
    const code = rooms.getRoomBySocket(socket.id)?.code;
    const room = rooms.removePlayer(socket.id);
    if (code) socket.leave(code);
    if (room) {
      emitRoom(room.code); // others see the updated roster (+ any new host)
      bots.kick(room.code); // a seat may now be a bot whose turn it is
    } else if (code) {
      games.end(code); // the room emptied out — drop its game too
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

  socket.on('tutorial:botPause', ({ paused }) => {
    // Tutorial rooms only — never let a regular client freeze a real match's bots.
    const room = rooms.getRoomBySocket(socket.id);
    if (!room || room.tutorial !== true) return;
    bots.setPaused(room.code, paused === true);
  });

  socket.on('dev:pat', () => {
    const now = Date.now();
    if (now - (socket.data.lastPatAt ?? 0) < 1500) return; // light anti-spam
    socket.data.lastPatAt = now;
    const room = rooms.getRoomBySocket(socket.id);
    const player = room?.players.find((p) => p.id === socket.id);
    const who = player ? `플레이어 ${player.nickname}(이)가` : '익명의 플레이어가';
    logPat(`${who} 머리를 쓰다듬었습니다.`);
  });

  socket.on('dev:feedback', (payload, ack) => {
    const now = Date.now();
    if (now - (socket.data.lastFeedbackAt ?? 0) < 5000) {
      ack?.({ ok: false, error: '잠시 후 다시 보내주세요.' });
      return;
    }
    const message = (payload?.message ?? '').trim();
    if (!message) {
      ack?.({ ok: false, error: '내용을 입력해주세요.' });
      return;
    }
    if (message.length > 1000) {
      ack?.({ ok: false, error: '내용이 너무 깁니다. (최대 1000자)' });
      return;
    }
    socket.data.lastFeedbackAt = now;
    const room = rooms.getRoomBySocket(socket.id);
    const player = room?.players.find((p) => p.id === socket.id);
    logFeedback(player?.nickname ?? '익명', message);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms.disconnect(socket.id);
    if (room) {
      emitRoom(room.code);
      bots.kick(room.code); // if it's now an offline player's turn, a bot covers it
    }
  });
}

/**
 * Record a head-pat. Always logs to the server console (visible in the hosting
 * dashboard's logs, e.g. Render). If DISCORD_WEBHOOK_URL is set, it also posts
 * the message there so you can get a live feed on your phone — no secret in code.
 */
function logPat(message: string): void {
  console.log(`[pat] ${new Date().toISOString()} ${message}`);
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: message }),
  }).catch(() => {
    /* best-effort — never let a logging failure affect gameplay */
  });
}

/**
 * Record a user feedback (bug/suggestion). Always logs to the server console. If
 * DISCORD_FEEDBACK_WEBHOOK_URL is set, posts there — a SEPARATE channel from the
 * head-pat feed (DISCORD_WEBHOOK_URL) so VOC isn't buried among pats. No fallback to
 * the pat webhook: the two feeds are kept deliberately separate.
 */
function logFeedback(who: string, message: string): void {
  console.log(`[feedback] ${new Date().toISOString()} ${who}: ${message}`);
  const url = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: `💌 **편지** — ${who}\n${message}` }),
  }).catch(() => {
    /* best-effort — never let a logging failure affect anything */
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
