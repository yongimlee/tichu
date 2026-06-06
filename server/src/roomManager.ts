import {
  ALL_SEATS,
  MAX_PLAYERS,
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

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** socketId -> roomCode, so disconnects can be cleaned up quickly. */
  private playerRooms = new Map<string, string>();

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
  ): Room {
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
      players: [host],
      createdAt: Date.now(),
    };
    this.rooms.set(room.code, room);
    this.playerRooms.set(socketId, room.code);
    return room;
  }

  joinRoom(socketId: string, code: string, nickname: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new Error('존재하지 않는 방 코드입니다.');
    if (room.status !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    if (room.players.some((p) => p.id === socketId)) return room;
    if (room.players.length >= MAX_PLAYERS) throw new Error('방이 가득 찼습니다.');

    room.players.push({
      id: socketId,
      nickname,
      seat: null,
      isHost: false,
      connected: true,
    });
    this.playerRooms.set(socketId, code);
    return room;
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

  removePlayer(socketId: string): Room | undefined {
    const code = this.playerRooms.get(socketId);
    this.playerRooms.delete(socketId);
    if (!code) return undefined;
    const room = this.rooms.get(code);
    if (!room) return undefined;

    room.players = room.players.filter((p) => p.id !== socketId);
    if (room.players.length === 0) {
      this.rooms.delete(code);
      return undefined;
    }
    // Promote a new host if the host left.
    if (room.hostId === socketId) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }
    return room;
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
