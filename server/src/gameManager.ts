import {
  DEFAULT_TARGET,
  startHand,
  type GameState,
  type HandScore,
  type MatchInfo,
  type TeamId,
} from '@tichu/shared';
import { cryptoRandom } from './rng';

// Holds the authoritative match for each in-progress room: the cumulative team
// scores plus the GameState for the hand currently being played. Kept separate
// from RoomManager (lobby) so hands — which contain every player's cards —
// never ride along on the lobby broadcast.

interface MatchRecord {
  state: GameState;
  scores: { A: number; B: number };
  target: number; // points needed to win this match (chosen at room creation)
  handNumber: number;
  winner: TeamId | null;
  settledHand: number; // handNumber whose result has already been added to scores
  history: HandScore[]; // per-hand deltas + running totals, oldest first
  startedAt: number; // epoch ms when the match began (first hand dealt)
  endedAt: number | null; // epoch ms when the match finished (winner decided)
}

// Tutorial rooms seat the human at 0; rig the FIRST deal so they hold all four
// specials AND a (randomly chosen) bomb, and give an opponent bot (seat 1) its
// own random bomb too — so both bomb lessons reliably appear on the first hand
// (the bot is nudged to play its bomb; see bot.ts). Each bomb is a fresh
// four-of-a-kind or, occasionally, a straight flush. Later hands deal normally.
const TUTORIAL_DEAL = { stackSpecialsForSeat: 0, stackBombForSeats: [0, 1] } as const;

export class GameManager {
  private matches = new Map<string, MatchRecord>();

  start(code: string, target: number = DEFAULT_TARGET, tutorial = false): GameState {
    const record: MatchRecord = {
      state: startHand(cryptoRandom, tutorial ? TUTORIAL_DEAL : undefined),
      scores: { A: 0, B: 0 },
      target,
      handNumber: 1,
      winner: null,
      settledHand: 0,
      history: [],
      startedAt: Date.now(),
      endedAt: null,
    };
    this.matches.set(code, record);
    return record.state;
  }

  getState(code: string): GameState | undefined {
    return this.matches.get(code)?.state;
  }

  getMatchInfo(code: string): MatchInfo | undefined {
    const r = this.matches.get(code);
    if (!r) return undefined;
    return {
      scores: r.scores,
      target: r.target,
      handNumber: r.handNumber,
      winner: r.winner,
      history: r.history,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    };
  }

  /** Apply the finished hand's result to the match scores exactly once. */
  settle(code: string): void {
    const r = this.matches.get(code);
    if (!r || !r.state.result) return;
    if (r.state.phase !== 'scoring') return;
    if (r.settledHand === r.handNumber) return;

    const delta = r.state.result.teamScores;
    r.scores.A += delta.A;
    r.scores.B += delta.B;
    r.settledHand = r.handNumber;
    r.history.push({
      hand: r.handNumber,
      delta: { A: delta.A, B: delta.B },
      total: { A: r.scores.A, B: r.scores.B },
    });

    const { A, B } = r.scores;
    if ((A >= r.target || B >= r.target) && A !== B) {
      r.winner = A > B ? 'A' : 'B';
      r.endedAt = Date.now();
      r.state.phase = 'finished';
    }
  }

  /** Deal the next hand (host action) once the current one has been scored. */
  nextHand(code: string): GameState {
    const r = this.matches.get(code);
    if (!r) throw new Error('진행 중인 매치가 없습니다.');
    if (r.winner) throw new Error('이미 종료된 매치입니다.');
    if (r.state.phase !== 'scoring') throw new Error('아직 현재 판이 끝나지 않았습니다.');
    r.handNumber += 1;
    // Only the first tutorial hand is rigged — later hands deal normally so the
    // player practises with realistic hands once they've met every special card.
    r.state = startHand(cryptoRandom);
    return r.state;
  }

  end(code: string): void {
    this.matches.delete(code);
  }
}
