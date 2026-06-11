import { randomUUID } from 'node:crypto';
import {
  ALL_SEATS,
  BOT_DIFFICULTY_NAMES,
  DEFAULT_BOT_DIFFICULTY,
  MAX_PLAYERS,
  normalizeTarget,
  shuffle,
  type BotDifficulty,
  type Player,
  type Room,
  type Seat,
  type TeamSelectionMode,
} from '@tichu/shared';

// In-memory room store. Authoritative source of truth for lobby state.
//
// Everything lives in process memory for now — fine for a single-instance
// skeleton. Swapping this for Redis later only touches this class.

// Invite-code alphabet without easily confused characters (no 0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// Grace period before an all-offline room is purged. This must be generous: a
// disconnect is often just a transient drop (mobile backgrounding, network blip,
// host idling on the scoring screen), and an explicit "leave room" already
// dissolves a solo+bots room immediately — so there's no need to purge a merely
// disconnected player quickly.
const CLEANUP_GRACE_MS = 60_000;

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** socketId -> roomCode, so disconnects can be cleaned up quickly. */
  private playerRooms = new Map<string, string>();
  /** reconnect token -> the player it belongs to (kept server-side, never broadcast). */
  private tokens = new Map<string, { code: string; player: Player }>();
  /** Pending purge timers for rooms whose players are all offline. */
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param onCleanup called when an all-offline room is purged (e.g. to drop its game).
   * @param graceMs delay before purging an all-offline room (overridable for tests).
   */
  constructor(
    private readonly onCleanup?: (code: string) => void,
    private readonly graceMs: number = CLEANUP_GRACE_MS,
  ) {}

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  getRoomBySocket(socketId: string): Room | undefined {
    const code = this.playerRooms.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }

  createRoom(
    socketId: string,
    nickname: string,
    teamSelectionMode: TeamSelectionMode,
    targetScore: number,
    tutorial = false,
  ): { room: Room; token: string } {
    const host: Player = {
      id: socketId,
      nickname,
      seat: null,
      isHost: true,
      connected: true,
    };
    const room: Room = {
      code: this.generateCode(),
      hostId: socketId,
      status: 'lobby',
      teamSelectionMode,
      targetScore: normalizeTarget(targetScore),
      players: [host],
      createdAt: Date.now(),
      tutorial,
    };
    this.rooms.set(room.code, room);
    this.playerRooms.set(socketId, room.code);
    const token = this.issueToken(room.code, host);
    return { room, token };
  }

  joinRoom(socketId: string, code: string, nickname: string): { room: Room; token: string } {
    const room = this.rooms.get(code);
    if (!room) throw new Error('존재하지 않는 방 코드입니다.');
    if (room.status !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    if (room.players.length >= MAX_PLAYERS) throw new Error('방이 가득 찼습니다.');

    const player: Player = {
      id: socketId,
      nickname,
      seat: null,
      isHost: false,
      connected: true,
    };
    room.players.push(player);
    this.playerRooms.set(socketId, code);
    const token = this.issueToken(code, player);
    return { room, token };
  }

  /**
   * Rebind an existing player (found by reconnect token) to a new socket after a
   * drop. Keeps their seat and host status; just marks them online again.
   */
  reconnect(token: string, socketId: string): { room: Room; player: Player } {
    const entry = this.tokens.get(token);
    if (!entry) throw new Error('재접속 세션을 찾을 수 없습니다.');
    const room = this.rooms.get(entry.code);
    if (!room || !room.players.includes(entry.player)) {
      this.tokens.delete(token);
      throw new Error('방이 더 이상 존재하지 않습니다.');
    }
    entry.player.id = socketId;
    entry.player.connected = true;
    // The host's socket id changes on reconnect; keep hostId pointing at them, or
    // host-only actions (next hand, restart, team setup) would reject the real host.
    if (entry.player.isHost) room.hostId = socketId;
    this.playerRooms.set(socketId, room.code);
    this.cancelCleanup(room.code); // someone is back — call off any pending purge
    return { room, player: entry.player };
  }

  setSeat(socketId: string, seat: Seat | null): Room {
    const room = this.requireRoom(socketId);
    if (room.teamSelectionMode !== 'manual') {
      throw new Error('이 방은 자동 팀 배정 방식입니다.');
    }
    const player = this.requirePlayer(room, socketId);
    if (seat !== null) {
      const taken = room.players.some((p) => p.id !== socketId && p.seat === seat);
      if (taken) throw new Error('이미 선택된 자리입니다.');
    }
    player.seat = seat;
    return room;
  }

  /** Host adds a fill bot, seating it in the lowest free seat (lobby only). */
  addBot(socketId: string, difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY): Room {
    const room = this.requireRoom(socketId);
    if (room.status !== 'lobby') throw new Error('게임 시작 전에만 봇을 추가할 수 있습니다.');
    if (room.players.length >= MAX_PLAYERS) throw new Error('방이 가득 찼습니다.');
    const seat = ALL_SEATS.find((s) => !room.players.some((p) => p.seat === s));
    if (seat === undefined) throw new Error('빈 자리가 없습니다.');
    // Name the bot after its tier's mascot (짹짹봇 등); suffix a number if there is
    // already one of the same kind so two never share a name.
    const baseName = BOT_DIFFICULTY_NAMES[difficulty];
    const sameKind = room.players.filter((p) => p.isBot && p.difficulty === difficulty).length;
    room.players.push({
      id: `bot-${randomUUID()}`,
      nickname: sameKind === 0 ? baseName : `${baseName} ${sameKind + 1}`,
      seat,
      isHost: false,
      connected: true,
      isBot: true,
      difficulty,
    });
    return room;
  }

  removeBot(socketId: string, playerId: string): Room {
    const room = this.requireRoom(socketId);
    if (room.status !== 'lobby') throw new Error('게임 시작 전에만 봇을 제거할 수 있습니다.');
    room.players = room.players.filter((p) => !(p.id === playerId && p.isBot));
    return room;
  }

  randomizeTeams(socketId: string): Room {
    const room = this.requireRoom(socketId);
    if (room.hostId !== socketId) throw new Error('방장만 팀을 배정할 수 있습니다.');
    const seats = shuffle([...ALL_SEATS]);
    room.players.forEach((p, i) => {
      p.seat = i < seats.length ? seats[i] : null;
    });
    return room;
  }

  /**
   * Reopen the lobby after a finished match, keeping the same players. Human
   * seats are cleared so everyone re-picks (manual) or gets reshuffled (random);
   * bots keep their seats so the host doesn't have to re-add them.
   */
  reopenLobby(socketId: string): Room {
    const room = this.requireRoom(socketId);
    if (room.hostId !== socketId) throw new Error('방장만 자리를 다시 배치할 수 있습니다.');
    room.status = 'lobby';
    for (const p of room.players) if (!p.isBot) p.seat = null;
    return room;
  }

  startGame(socketId: string): Room {
    const room = this.requireRoom(socketId);
    if (room.hostId !== socketId) throw new Error('방장만 게임을 시작할 수 있습니다.');
    const seated = room.players.filter((p) => p.seat !== null);
    if (seated.length !== MAX_PLAYERS) {
      throw new Error('4명 모두 자리에 앉아야 시작할 수 있습니다.');
    }
    room.status = 'in-game';
    // TODO: create a GameState, deal 8 cards, open the Grand Tichu phase, etc.
    return room;
  }

  /**
   * Handle a socket dropping. In the lobby the player is removed outright; mid-game
   * they are kept (seat preserved) and just flagged offline so they can reconnect.
   */
  disconnect(socketId: string): Room | undefined {
    const code = this.playerRooms.get(socketId);
    if (!code) return undefined;
    const room = this.rooms.get(code);
    if (!room) {
      this.playerRooms.delete(socketId);
      return undefined;
    }
    if (room.status === 'lobby') return this.removePlayer(socketId);

    // In-game: keep the player and their seat; just mark them offline.
    this.playerRooms.delete(socketId);
    const player = room.players.find((p) => p.id === socketId);
    if (player) player.connected = false;
    this.ensureHumanHost(room); // if the host dropped, hand it to an online human
    // If no human is online any more, schedule a delayed purge (bots don't count).
    // Reconnecting (or returning to the tab) within the grace cancels it.
    const humans = room.players.filter((p) => !p.isBot);
    if (humans.every((p) => !p.connected)) {
      this.scheduleCleanup(room.code);
    }
    return room;
  }

  removePlayer(socketId: string): Room | undefined {
    const code = this.playerRooms.get(socketId);
    this.playerRooms.delete(socketId);
    if (!code) return undefined;
    const room = this.rooms.get(code);
    if (!room) return undefined;

    const leaving = room.players.find((p) => p.id === socketId);
    if (!leaving) return room;
    this.deleteTokenFor(leaving); // leaving for good → no reconnect

    const humansLeft = room.players.filter((p) => !p.isBot && p.id !== socketId);
    if (humansLeft.length === 0) {
      // No humans left (empty, or bots only) → dissolve the room and its game.
      this.closeRoom(code);
      this.onCleanup?.(code);
      return undefined;
    }

    if (room.status !== 'lobby' && leaving.seat !== null) {
      // Mid-game: hand the vacated seat to a bot so the others can keep playing.
      this.convertToBot(leaving);
    } else {
      // Lobby (or an unseated spectator): just drop them.
      room.players = room.players.filter((p) => p.id !== socketId);
    }

    this.ensureHumanHost(room); // host must always be a connected human
    return room;
  }

  /** Dissolve a room entirely: drop its players, tokens, mappings, and timer. */
  closeRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) for (const player of room.players) this.deleteTokenFor(player);
    for (const [socketId, c] of this.playerRooms) {
      if (c === code) this.playerRooms.delete(socketId);
    }
    this.cancelCleanup(code);
    this.rooms.delete(code);
  }

  private scheduleCleanup(code: string): void {
    if (this.cleanupTimers.has(code)) return;
    const timer = setTimeout(() => this.purgeIfAllOffline(code), this.graceMs);
    timer.unref?.(); // don't keep the process alive just for this timer
    this.cleanupTimers.set(code, timer);
  }

  private cancelCleanup(code: string): void {
    const timer = this.cleanupTimers.get(code);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(code);
    }
  }

  private purgeIfAllOffline(code: string): void {
    this.cleanupTimers.delete(code);
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.players.some((p) => !p.isBot && p.connected)) return; // a human reconnected in time
    for (const player of room.players) this.deleteTokenFor(player);
    this.rooms.delete(code);
    this.onCleanup?.(code); // let the server drop the associated game
  }

  private issueToken(code: string, player: Player): string {
    const token = randomUUID();
    this.tokens.set(token, { code, player });
    return token;
  }

  /** Turn a departed human's seat into a bot so the hand can continue. */
  private convertToBot(player: Player): void {
    player.isBot = true;
    player.isHost = false;
    player.connected = true;
    player.id = `bot-${randomUUID()}`; // the old socket id is gone
    if (!player.nickname.endsWith('(봇)')) player.nickname = `${player.nickname} (봇)`;
  }

  /** Ensure the host is a connected human; hand it off if the current one isn't. */
  private ensureHumanHost(room: Room): void {
    const current = room.players.find((p) => p.id === room.hostId);
    if (current && !current.isBot && current.connected) return;
    const next = room.players.find((p) => !p.isBot && p.connected);
    if (!next) return; // nobody online to receive it (cleanup will handle the room)
    room.hostId = next.id;
    for (const p of room.players) p.isHost = p.id === next.id;
  }

  private deleteTokenFor(player: Player): void {
    for (const [token, entry] of this.tokens) {
      if (entry.player === player) {
        this.tokens.delete(token);
        return;
      }
    }
  }

  private generateCode(): string {
    let code: string;
    do {
      code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  private requireRoom(socketId: string): Room {
    const room = this.getRoomBySocket(socketId);
    if (!room) throw new Error('참여 중인 방이 없습니다.');
    return room;
  }

  private requirePlayer(room: Room, socketId: string): Player {
    const player = room.players.find((p) => p.id === socketId);
    if (!player) throw new Error('방에서 플레이어를 찾을 수 없습니다.');
    return player;
  }
}
