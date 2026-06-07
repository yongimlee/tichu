import { randomUUID } from 'node:crypto';
import {
  ALL_SEATS,
  MAX_PLAYERS,
  normalizeTarget,
  shuffle,
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

// Grace period before an all-offline room is purged (lets brief drops recover).
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
  addBot(socketId: string): Room {
    const room = this.requireRoom(socketId);
    if (room.status !== 'lobby') throw new Error('게임 시작 전에만 봇을 추가할 수 있습니다.');
    if (room.players.length >= MAX_PLAYERS) throw new Error('방이 가득 찼습니다.');
    const seat = ALL_SEATS.find((s) => !room.players.some((p) => p.seat === s));
    if (seat === undefined) throw new Error('빈 자리가 없습니다.');
    const n = room.players.filter((p) => p.isBot).length + 1;
    room.players.push({
      id: `bot-${randomUUID()}`,
      nickname: `봇 ${n}`,
      seat,
      isHost: false,
      connected: true,
      isBot: true,
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
    // If no human is online any more, schedule a delayed purge (bots don't count).
    if (room.players.filter((p) => !p.isBot).every((p) => !p.connected)) {
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
    if (leaving) this.deleteTokenFor(leaving);
    room.players = room.players.filter((p) => p.id !== socketId);
    const humans = room.players.filter((p) => !p.isBot);
    if (humans.length === 0) {
      // No humans left (empty, or bots only) → dissolve the room and its game.
      this.closeRoom(code);
      this.onCleanup?.(code);
      return undefined;
    }
    // Promote a new (human) host if the host left.
    if (room.hostId === socketId) {
      room.hostId = humans[0].id;
      humans[0].isHost = true;
    }
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
