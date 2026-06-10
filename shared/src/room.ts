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

/**
 * Bot strength tier, chosen by the host when adding a fill bot. Each tier is
 * themed after one of the four special cards, ascending in power:
 * - `easy`   (짹짹봇) — plays legal but careless moves (random, wastes high cards).
 * - `normal` (댕댕봇) — efficient but simple: cheapest play, no finesse/conservation.
 * - `hard`   (주작봇) — the full heuristic bot (conservation + Tichu fight + Dog handoff).
 * - `expert` (용용봇) — determinized Monte-Carlo (PIMC) search; runs in a worker thread.
 */
export type BotDifficulty = 'easy' | 'normal' | 'hard' | 'expert';
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard', 'expert'];
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'normal';
/** Short tier label (쉬움/일반/어려움/전문가). */
export const BOT_DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
  easy: '쉬움',
  normal: '일반',
  hard: '어려움',
  expert: '전문가',
};
/** Themed display name shown in the lobby and in-game (짹짹봇 etc.). */
export const BOT_DIFFICULTY_NAMES: Record<BotDifficulty, string> = {
  easy: '짹짹봇',
  normal: '댕댕봇',
  hard: '주작봇',
  expert: '용용봇',
};
/** A creature glyph for each tier's special-card theme (참새/댕댕/봉황/용). */
export const BOT_DIFFICULTY_EMOJI: Record<BotDifficulty, string> = {
  easy: '🐦',
  normal: '🐶',
  hard: '🐦‍🔥',
  expert: '🐉',
};

export interface Player {
  id: string;
  nickname: string;
  seat: Seat | null; // null = joined but not yet seated
  isHost: boolean;
  connected: boolean;
  isBot?: boolean; // a server-controlled fill player
  difficulty?: BotDifficulty; // only meaningful for bots; absent → DEFAULT_BOT_DIFFICULTY
}

export type RoomStatus = 'lobby' | 'in-game' | 'finished';

// Selectable match goals (points needed to win), chosen by the host at creation.
export const MIN_TARGET = 100;
export const MAX_TARGET = 1000;
export const DEFAULT_TARGET = 1000;
export const TARGET_OPTIONS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

/** Clamp/normalise a requested target score to a valid value. */
export function normalizeTarget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TARGET;
  const rounded = Math.round(value);
  return Math.min(MAX_TARGET, Math.max(MIN_TARGET, rounded));
}

export interface Room {
  code: string; // invite code shared with guests
  hostId: string;
  status: RoomStatus;
  teamSelectionMode: TeamSelectionMode;
  targetScore: number; // points needed to win the match (100–1000)
  players: Player[];
  createdAt: number;
}
