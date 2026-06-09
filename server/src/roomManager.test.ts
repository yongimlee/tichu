import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from './roomManager';

test('reconnect keeps host privileges by re-pointing hostId at the new socket', () => {
  const rooms = new RoomManager();
  const { room, token } = rooms.createRoom('sock-1', '방장', 'random', 1000);
  assert.equal(room.hostId, 'sock-1');

  // Host drops and reconnects with a fresh socket id (page refresh / network blip).
  const { room: same } = rooms.reconnect(token, 'sock-2');

  // hostId must follow the host, or host-only actions (next hand, restart) would
  // reject the real host since handlers compare room.hostId to socket.id.
  assert.equal(same.hostId, 'sock-2');
  const host = same.players.find((p) => p.isHost);
  assert.equal(host?.id, 'sock-2');
});
