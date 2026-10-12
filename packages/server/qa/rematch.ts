// P0 rematch: finished rooms must not be rejoinable, and both rematch votes
// must land in the same NEW room.
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, Room } from '@colyseus/sdk';
import { TurfDuelRoom } from '../src/rooms/TurfDuelRoom.js';

const SHORT_MATCH = { matchTicks: 40 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(20);
  }
}

async function shutdown(server: Server): Promise<void> {
  try {
    await Promise.race([server.gracefullyShutdown(false), sleep(1500)]);
  } catch {
    /* ignore */
  }
}

async function startPair(port: number) {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', TurfDuelRoom);
  await server.listen(port);
  const client1 = new Client(`ws://localhost:${port}`);
  const client2 = new Client(`ws://localhost:${port}`);
  const room1 = await client1.joinOrCreate('turf_duel', SHORT_MATCH);
  const room2 = await client2.joinOrCreate('turf_duel', SHORT_MATCH);
  if (room1.roomId !== room2.roomId) {
    await shutdown(server);
    throw new Error(`Pair split across rooms ${room1.roomId} vs ${room2.roomId}`);
  }
  return { server, client1, client2, room1, room2 };
}

async function waitForResult(room1: Room, room2: Room): Promise<void> {
  await waitUntil(
    () => Boolean(room1.state.result) && Boolean(room2.state.result),
    8000,
    'short match result',
  );
  // lock() is async; give the listing a beat to exclude the finished room.
  await sleep(200);
}

/** Whoever leaves first must not joinOrCreate back into the finished 1/2 room. */
async function testOneSidedRematchAvoidsFinishedRoom(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12621);
  try {
    const oldId = room1.roomId;
    await waitForResult(room1, room2);

    await room1.leave();
    const next1 = await client1.joinOrCreate('turf_duel');
    if (next1.roomId === oldId) {
      throw new Error(`One-sided rematch rejoined finished room ${oldId}`);
    }

    await room2.leave();
    const next2 = await client2.joinOrCreate('turf_duel');
    if (next2.roomId === oldId) {
      throw new Error(`Second rematch also rejoined finished room ${oldId}`);
    }

    await Promise.race([next1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([next2.leave().catch(() => undefined), sleep(400)]);
    console.log(`✓ one-sided rematch left ${oldId} and opened ${next1.roomId} / ${next2.roomId}`);
  } finally {
    await shutdown(server);
  }
}

/** Both rematch votes receive the same new room id and join it together. */
async function testBothRematchShareNewRoom(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12622);
  try {
    const oldId = room1.roomId;
    await waitForResult(room1, room2);

    let id1: string | null = null;
    let id2: string | null = null;
    room1.onMessage('rematch_room', (message: { roomId?: string }) => {
      id1 = typeof message?.roomId === 'string' ? message.roomId : null;
    });
    room2.onMessage('rematch_room', (message: { roomId?: string }) => {
      id2 = typeof message?.roomId === 'string' ? message.roomId : null;
    });
    room1.send('rematch', {});
    room2.send('rematch', {});

    await waitUntil(() => Boolean(id1) && Boolean(id2), 4000, 'rematch_room for both');
    if (id1 !== id2) {
      throw new Error(`Rematch ids diverged: ${id1} vs ${id2}`);
    }
    if (id1 === oldId) {
      throw new Error(`Rematch reused finished room ${oldId}`);
    }

    await room1.leave();
    await room2.leave();
    const next1 = await client1.joinById(id1!);
    const next2 = await client2.joinById(id2!);
    if (next1.roomId !== next2.roomId || next1.roomId === oldId) {
      throw new Error(`Paired rematch landed in ${next1.roomId} / ${next2.roomId} (old ${oldId})`);
    }

    await waitUntil(() => (next1.state.tick as number) > 0 && (next2.state.tick as number) > 0, 3000, 'new match tick');
    await Promise.race([next1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([next2.leave().catch(() => undefined), sleep(400)]);
    console.log(`✓ both rematch paired into new room ${next1.roomId} (left ${oldId})`);
  } finally {
    await shutdown(server);
  }
}

/** A third seat must not joinOrCreate into a finished room that still has both players. */
async function testFinishedRoomExcludedWhileOccupied(): Promise<void> {
  const { server, room1, room2 } = await startPair(12623);
  const client3 = new Client('ws://localhost:12623');
  try {
    const oldId = room1.roomId;
    await waitForResult(room1, room2);
    const extra = await client3.joinOrCreate('turf_duel');
    if (extra.roomId === oldId) {
      throw new Error(`joinOrCreate sat in finished room ${oldId} while both players were still there`);
    }
    await Promise.race([extra.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([room1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([room2.leave().catch(() => undefined), sleep(400)]);
    console.log(`✓ finished room ${oldId} excluded from matchmaking (third seat got ${extra.roomId})`);
  } finally {
    await shutdown(server);
  }
}

async function main(): Promise<void> {
  console.log('\n=== P0 rematch: lock finished rooms + pair into a new room ===\n');
  await testFinishedRoomExcludedWhileOccupied();
  await testOneSidedRematchAvoidsFinishedRoom();
  await testBothRematchShareNewRoom();
  console.log('\n✅ rematch PASSED\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ rematch FAILED:', error);
    process.exit(1);
  });
