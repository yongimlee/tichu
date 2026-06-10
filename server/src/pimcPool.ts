import { Worker } from 'node:worker_threads';
import type { GameState, Seat } from '@tichu/shared';
import type { BotMove } from './bot';
import { DEFAULT_PIMC_OPTIONS, type PimcOptions, type PimcRequest, type PimcResponse } from './pimc';

// A small pool of worker threads that run the expert (PIMC) search off the main
// event loop. The bot driver hands it a snapshot of the game state and awaits a
// chosen move. Jobs queue if every worker is busy (several rooms thinking at
// once); a crashed worker is replaced so the pool keeps its size.

interface Pending {
  resolve: (m: BotMove) => void;
  reject: (e: Error) => void;
}
interface Job {
  req: PimcRequest;
  pending: Pending;
}

export class PimcPool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, { id: number; pending: Pending }>();
  private queue: Job[] = [];
  private nextId = 1;
  private readonly opts: PimcOptions;

  constructor(
    private readonly size = 1,
    opts: Partial<PimcOptions> = {},
  ) {
    this.opts = { ...DEFAULT_PIMC_OPTIONS, ...opts };
    for (let i = 0; i < Math.max(1, size); i++) this.spawn();
  }

  /** Choose a move for `seat` from a state snapshot. Resolves with the bot's move. */
  choose(state: GameState, seat: Seat): Promise<BotMove> {
    return new Promise<BotMove>((resolve, reject) => {
      const job: Job = { req: { id: this.nextId++, state, seat, opts: this.opts }, pending: { resolve, reject } };
      const w = this.idle.pop();
      if (w) this.dispatch(w, job);
      else this.queue.push(job);
    });
  }

  private dispatch(w: Worker, job: Job): void {
    this.busy.set(w, { id: job.req.id, pending: job.pending });
    w.postMessage(job.req);
  }

  private drain(w: Worker): void {
    const next = this.queue.shift();
    if (next) this.dispatch(w, next);
    else this.idle.push(w);
  }

  private spawn(): void {
    const w = new Worker(new URL('./pimcWorker.ts', import.meta.url));
    w.on('message', (res: PimcResponse) => {
      const cur = this.busy.get(w);
      this.busy.delete(w);
      if (cur && cur.id === res.id) {
        if (res.ok) cur.pending.resolve(res.move);
        else cur.pending.reject(new Error(res.error));
      }
      this.drain(w);
    });
    w.on('error', (err) => {
      const cur = this.busy.get(w);
      this.busy.delete(w);
      this.idle = this.idle.filter((x) => x !== w);
      if (cur) cur.pending.reject(err);
      this.spawn(); // replace the dead worker
      const next = this.queue.shift();
      const free = this.idle.pop();
      if (next && free) this.dispatch(free, next);
    });
    w.unref(); // a thinking bot shouldn't keep the process alive on its own
    this.idle.push(w);
  }
}
