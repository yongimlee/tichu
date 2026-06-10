import { parentPort } from 'node:worker_threads';
import { pimcChooseMove, type PimcRequest, type PimcResponse } from './pimc';

// Worker-thread entry for the expert (PIMC) bot. It does the heavy, CPU-bound
// determinized Monte-Carlo search here so the main event loop stays responsive
// to socket traffic while a bot "thinks". One request → one chosen move.

const port = parentPort;
if (!port) throw new Error('pimcWorker must be run as a worker thread.');

port.on('message', (req: PimcRequest) => {
  let res: PimcResponse;
  try {
    const move = pimcChooseMove(req.state, req.seat, req.opts);
    res = { id: req.id, ok: true, move };
  } catch (err) {
    res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(res);
});
