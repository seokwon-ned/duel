// Rematch no-show: after reserved seats expire, the lobby becomes public
// so the late player can joinOrCreate into the same room.
process.env.TURF_DUEL_REMATCH_SEAT_S ??= '2';

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, Room } from '@colyseus/sdk';
import { TurfDuelQaRoom } from '../src/rooms/TurfDuelQaRoom.js';

const SHORT_MATCH = { matchTicks: 40 };
const SEAT_S = Number(process.env.TURF_DUEL_REMATCH_SEAT_S) || 2;

type RematchOffer = {
  roomId?: string;
  seat?: { roomId: string; sessionId: string; name: string; processId?: string };
};

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
  server.define('turf_duel', TurfDuelQaRoom);
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
  await sleep(200);
}

async function bothRematch(room1: Room, room2: Room): Promise<{ offer1: RematchOffer; offer2: RematchOffer }> {
  let offer1: RematchOffer | null = null;
  let offer2: RematchOffer | null = null;
  room1.onMessage('rematch_room', (message: RematchOffer) => {
    offer1 = message;
  });
  room2.onMessage('rematch_room', (message: RematchOffer) => {
    offer2 = message;
  });
  room1.send('rematch', {});
  room2.send('rematch', {});
  await waitUntil(() => Boolean(offer1?.seat && offer2?.seat), 4000, 'rematch_room seats');
  return { offer1: offer1!, offer2: offer2! };
}

/** One player takes the reserved seat; after expiry the other joinOrCreates in. */
async function testNoShowFallsBackToMatchmaking(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12641);
  try {
    await waitForResult(room1, room2);
    const { offer1, offer2 } = await bothRematch(room1, room2);
    const rematchId = offer1.roomId!;
    if (rematchId !== offer2.roomId) {
      throw new Error(`Rematch ids diverged ${offer1.roomId} vs ${offer2.roomId}`);
    }

    await room1.leave();
    await room2.leave();
    const kept = await client1.consumeSeatReservation(offer1.seat!);
    if (kept.roomId !== rematchId) {
      throw new Error(`Consumer landed in ${kept.roomId}, expected ${rematchId}`);
    }

    await sleep(SEAT_S * 1000 + 400);
    const late = await client2.joinOrCreate('turf_duel');
    if (late.roomId !== rematchId) {
      throw new Error(`No-show joinOrCreate opened ${late.roomId}, not rematch ${rematchId}`);
    }

    await waitUntil(() => (kept.state.tick as number) > 0 && (late.state.tick as number) > 0, 3000, 'filled rematch tick');
    await Promise.race([kept.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([late.leave().catch(() => undefined), sleep(400)]);
    console.log(`✓ no-show joinOrCreate filled rematch ${rematchId} after seat expiry`);
  } finally {
    await shutdown(server);
  }
}

/** Before expiry the rematch room stays off public matchmaking. */
async function testReservedUntilExpiry(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12642);
  const client3 = new Client('ws://localhost:12642');
  try {
    await waitForResult(room1, room2);
    const { offer1 } = await bothRematch(room1, room2);
    const stranger = await client3.joinOrCreate('turf_duel');
    if (stranger.roomId === offer1.roomId) {
      throw new Error(`Stranger joined rematch ${offer1.roomId} before seat expiry`);
    }
    await Promise.race([stranger.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([room1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([room2.leave().catch(() => undefined), sleep(400)]);
    console.log(`✓ rematch ${offer1.roomId} stayed private until expiry (stranger got ${stranger.roomId})`);
  } finally {
    await shutdown(server);
  }
}

async function main(): Promise<void> {
  console.log('\n=== rematch no-show: seat expiry opens matchmaking ===\n');
  await testReservedUntilExpiry();
  await testNoShowFallsBackToMatchmaking();
  console.log('\n✅ own-expiry PASSED\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ own-expiry FAILED:', error);
    process.exit(1);
  });
