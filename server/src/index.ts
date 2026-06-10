import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@tichu/shared';
import { BotDriver } from './bot';
import { GameManager } from './gameManager';
import { PimcPool } from './pimcPool';
import { RoomManager } from './roomManager';
import { registerSocketHandlers } from './socket';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

// Last-resort safety net. All game/room state lives in this single process's
// memory, so a single uncaught throw on an async path (a bot timer, a socket
// event with no try/catch) would kill the process and wipe *every* room — every
// connected player then fails to reconnect and gets bounced to the home screen
// ("방을 찾을 수 없습니다"). Log the stack (visible in the host's logs) and keep
// running instead; rooms are isolated, so one bad event shouldn't end everyone's
// game. This is a backstop — handlers should still catch their own errors.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] keeping server alive:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] keeping server alive:', reason);
});

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Single-deploy mode: if the web client has been built, serve it from here so
// the whole app runs as one service (same origin → no CORS, one URL). In dev
// the dist folder is absent and Vite serves the client instead.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback — hand any non-API route to the client's index.html.
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  console.log(`Serving web client from ${webDist}`);
}

const httpServer = createServer(app);
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

const games = new GameManager();
// Purge a room's game when the room itself is cleaned up (all players offline).
const rooms = new RoomManager((code) => games.end(code));
// Worker pool for the expert (PIMC) bot, so its heavy search runs off the event
// loop. Size/budget are tunable via env for the deploy host's CPU.
const pimcPool = new PimcPool(Number(process.env.PIMC_WORKERS ?? 1), {
  budgetMs: Number(process.env.PIMC_BUDGET_MS ?? 500),
});
const bots = new BotDriver(io, rooms, games, pimcPool);

io.on('connection', (socket) => {
  registerSocketHandlers(io, socket, rooms, games, bots);
});

httpServer.listen(PORT, () => {
  console.log(`Tichu server listening on http://localhost:${PORT}`);
});
