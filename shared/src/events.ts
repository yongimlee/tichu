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
  /** Persistent reconnect token — store it client-side to rejoin after a drop. */
  token: string;
}

export interface ServerToClientEvents {
  'room:update': (room: Room) => void;
  'room:error': (payload: { message: string }) => void;
  /** Per-seat redacted game state. Sent individually to each player. */
  'game:state': (view: PlayerView) => void;
  /** An emote reaction from a seated player, broadcast to the whole room. */
  'game:emote': (payload: { seat: Seat; emoji: string }) => void;
  /** The room was closed (e.g. host dissolved it) — clients should return home. */
  'room:closed': () => void;
  /**
   * The finished match was torn down but the room lives on (host chose to
   * re-seat). Clients drop their game view and fall back to the lobby.
   */
  'game:closed': () => void;
}

export interface ClientToServerEvents {
  'room:create': (
    payload: { nickname: string; teamSelectionMode: TeamSelectionMode; targetScore: number },
    ack: (res: Ack<JoinResult>) => void,
  ) => void;
  'room:join': (
    payload: { code: string; nickname: string },
    ack: (res: Ack<JoinResult>) => void,
  ) => void;
  /** Rejoin an existing room/seat after a disconnect using a saved token. */
  'room:reconnect': (
    payload: { code: string; token: string },
    ack: (res: Ack<JoinResult>) => void,
  ) => void;
  'room:setSeat': (payload: { seat: Seat | null }) => void;
  'room:randomizeTeams': () => void;
  /** Host: add a fill bot to an empty seat. */
  'room:addBot': () => void;
  /** Host: remove a bot by its player id. */
  'room:removeBot': (payload: { playerId: string }) => void;
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
  'game:emote': (payload: { emoji: string }) => void;
  /** Host: reset scores and redeal, keeping the same players (post-game restart). */
  'game:restart': () => void;
  /**
   * Host: end the finished match and reopen the lobby with the same players so
   * they can rearrange seats/teams before starting again.
   */
  'game:reseat': () => void;
  /** Host: dissolve the whole room (everyone returns home). */
  'room:close': () => void;
  /** Leave the current room (room is purged once everyone has left). */
  'room:leave': () => void;
  /** Fun: someone patted the developer's head. Server logs who (or "anonymous"). */
  'dev:pat': () => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface InterServerEvents {}

export interface SocketData {
  roomCode?: string;
  /** Timestamp of the last emote, for light anti-spam rate limiting. */
  lastEmoteAt?: number;
  /** Timestamp of the last head-pat, for light anti-spam rate limiting. */
  lastPatAt?: number;
}
