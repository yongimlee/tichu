import type { ExchangeSelection, PlayerView } from './game';
import type { Room, Seat, TeamSelectionMode } from './room';

// Typed Socket.IO event contracts shared by server and clients.
// Keeping these in one place means a change to a payload is a compile error on
// both ends rather than a silent runtime mismatch.

/** Standard acknowledgement envelope for request/response style events. */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: string };

export interface JoinResult {
  room: Room;
  /** The caller's own player id, so the client can identify itself in `room.players`. */
  selfId: string;
}

export interface ServerToClientEvents {
  'room:update': (room: Room) => void;
  'room:error': (payload: { message: string }) => void;
  /** Per-seat redacted game state. Sent individually to each player. */
  'game:state': (view: PlayerView) => void;
}

export interface ClientToServerEvents {
  'room:create': (
    payload: { nickname: string; teamSelectionMode: TeamSelectionMode },
    ack: (res: Ack<JoinResult>) => void,
  ) => void;
  'room:join': (
    payload: { code: string; nickname: string },
    ack: (res: Ack<JoinResult>) => void,
  ) => void;
  'room:setSeat': (payload: { seat: Seat | null }) => void;
  'room:randomizeTeams': () => void;
  'game:start': () => void;
  'game:grandTichu': (payload: { declare: boolean }) => void;
  'game:exchange': (payload: ExchangeSelection) => void;
  'game:tichu': () => void;
  'game:play': (payload: {
    cardIds: string[];
    wish?: number;
    desiredTop?: number;
    phoenixAsLowerTriple?: boolean;
  }) => void;
  'game:pass': () => void;
  'game:giveDragon': (payload: { toSeat: Seat }) => void;
  'game:nextHand': () => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface InterServerEvents {}

export interface SocketData {
  roomCode?: string;
}
