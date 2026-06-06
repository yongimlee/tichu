// Room / lobby domain model shared between server and clients.

export type TeamSelectionMode = 'manual' | 'random';
export type TeamId = 'A' | 'B';

/**
 * Seats around the table. In Tichu, partners sit opposite each other:
 * seats 0 & 2 form team A, seats 1 & 3 form team B.
 */
export type Seat = 0 | 1 | 2 | 3;

export const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3];
export const MAX_PLAYERS = 4;

/** Which team a seat belongs to (0 & 2 → A, 1 & 3 → B). */
export function seatTeam(seat: Seat): TeamId {
  return seat % 2 === 0 ? 'A' : 'B';
}

/** Partner sits directly opposite. */
export function partnerSeat(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}

/** Left-hand opponent (next seat clockwise). */
export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

/** Right-hand opponent (previous seat clockwise). */
export function prevSeat(seat: Seat): Seat {
  return ((seat + 3) % 4) as Seat;
}

export interface Player {
  id: string;
  nickname: string;
  seat: Seat | null; // null = joined but not yet seated
  isHost: boolean;
  connected: boolean;
}

export type RoomStatus = 'lobby' | 'in-game' | 'finished';

export interface Room {
  code: string; // invite code shared with guests
  hostId: string;
  status: RoomStatus;
  teamSelectionMode: TeamSelectionMode;
  players: Player[];
  createdAt: number;
}
