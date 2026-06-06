import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@tichu/shared';

// In dev the server runs on :3001; in a production build with no override we
// connect to the same origin that served the page (single-deploy mode). An
// explicit VITE_SERVER_URL always wins (e.g. when web and server are split).
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

// Note the generic order: client emits ClientToServerEvents and listens for
// ServerToClientEvents (the reverse of the server's declaration).
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: true,
});
