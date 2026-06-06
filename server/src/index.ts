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
import { GameManager } from './gameManager';
import { RoomManager } from './roomManager';
import { registerSocketHandlers } from './socket';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

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

io.on('connection', (socket) => {
  registerSocketHandlers(io, socket, rooms, games);
});

httpServer.listen(PORT, () => {
  console.log(`Tichu server listening on http://localhost:${PORT}`);
});
