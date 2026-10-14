// P1 rematch: clear stale votes on leave, and keep the rematch room off public matchmaking.
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, Room } from '@colyseus/sdk';
import { TurfDuelQaRoom } from '../src/rooms/TurfDuelQaRoom.js';
import { TurfDuelRoom } from '../src/rooms/TurfDuelRoom.js';

const SHORT_MATCH = { matchTicks: 40 };

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

async function startPair(port: number, RoomClass: typeof TurfDuelRoom = TurfDuelQaRoom, options: Record<string, unknown> = SHORT_MATCH) {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', RoomClass);
  await server.listen(port);
  const client1 = new Client(`ws://localhost:${port}`);
  const client2 = new Client(`ws://localhost:${port}`);
  const room1 = await client1.joinOrCreate('turf_duel', options);
  const room2 = await client2.joinOrCreate('turf_duel', options);
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

/** A leaver's rematch vote must not pair the late opponent into an empty new room. */
async function testLateRematchDoesNotUseStaleVote(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12631);
  try {
    await waitForResult(room1, room2);
    let lateOffer: RematchOffer | null = null;
    room2.onMessage('rematch_room', (message: RematchOffer) => {
      lateOffer = message;
    });
    room1.send('rematch', {});
    await sleep(80);
    await room1.leave();
    await sleep(80);
    room2.send('rematch', {});
    await sleep(600);
    if (lateOffer) {
      throw new Error(`Stale leaver vote created rematch_room ${(lateOffer as RematchOffer).roomId}`);
    }

    await room2.leave();
    const next2 = await client2.joinOrCreate('turf_duel');
    const next1 = await client1.joinOrCreate('turf_duel');
    if (next1.roomId === room1.roomId || next2.roomId === room1.roomId) {
      throw new Error('Late rematch rejoined the finished room');
    }
    await Promise.race([next1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([next2.leave().catch(() => undefined), sleep(400)]);
    console.log('✓ late rematch after a leave does not reuse a stale vote');
  } finally {
    await shutdown(server);
  }
}

/** Reserved + private rematch room: a stranger must not take a seat. */
async function testRematchRoomIsReserved(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12632);
  const client3 = new Client('ws://localhost:12632');
  try {
    const oldId = room1.roomId;
    await waitForResult(room1, room2);

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
    await waitUntil(() => Boolean(offer1?.seat && offer2?.seat), 4000, 'reserved rematch seats');

    const stranger = await client3.joinOrCreate('turf_duel');
    if (stranger.roomId === offer1!.roomId || stranger.roomId === oldId) {
      throw new Error(`Stranger sat in rematch/finished room ${stranger.roomId}`);
    }

    let stoleById = false;
    try {
      const sneak = await client3.joinById(offer1!.roomId!);
      stoleById = sneak.roomId === offer1!.roomId;
      await sneak.leave().catch(() => undefined);
    } catch {
      stoleById = false;
    }
    if (stoleById) {
      throw new Error(`Stranger joinById took rematch room ${offer1!.roomId}`);
    }

    await room1.leave();
    await room2.leave();
    const next1 = await client1.consumeSeatReservation(offer1!.seat!);
    const next2 = await client2.consumeSeatReservation(offer2!.seat!);
    if (next1.roomId !== next2.roomId || next1.roomId !== offer1!.roomId) {
      throw new Error(`Reserved seats split: ${next1.roomId} / ${next2.roomId}`);
    }
    await waitUntil(() => (next1.state.tick as number) > 0, 3000, 'reserved rematch tick');
    await Promise.race([stranger.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([next1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([next2.leave().catch(() => undefined), sleep(400)]);
    console.log(`✓ rematch room ${offer1!.roomId} reserved; stranger opened ${stranger.roomId}`);
  } finally {
    await shutdown(server);
  }
}

/** Client { rematch: true } must not privatize a room the way handleRematch does. */
async function testClientRematchFlagIsIgnored(): Promise<void> {
  const { server, room1, room2 } = await startPair(12634, TurfDuelRoom, { rematch: true });
  try {
    if (room1.roomId !== room2.roomId) {
      throw new Error('Client rematch:true made a private lobby; second join created another room');
    }
    await Promise.race([room1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([room2.leave().catch(() => undefined), sleep(400)]);
    console.log('✓ client rematch:true is ignored (pair still shares one public room)');
  } finally {
    await shutdown(server);
  }
}

/** Production rooms ignore client matchTicks. */
async function testProductionIgnoresMatchTicks(): Promise<void> {
  const { server, room1, room2 } = await startPair(12633, TurfDuelRoom, { matchTicks: 8 });
  try {
    await sleep(700);
    if (room1.state.result || room2.state.result) {
      throw new Error('Production room honored client matchTicks');
    }
    if ((room1.state.tick as number) < 8) {
      throw new Error(`Expected live ticks past 8, got ${room1.state.tick}`);
    }
    await Promise.race([room1.leave().catch(() => undefined), sleep(400)]);
    await Promise.race([room2.leave().catch(() => undefined), sleep(400)]);
    console.log('✓ production TurfDuelRoom ignores client matchTicks');
  } finally {
    await shutdown(server);
  }
}

/** A consume that joins then immediately leave()s must not walkover the other rematch seat. */
async function testLateSeatLeaveDoesNotForfeit(): Promise<void> {
  const { server, client1, client2, room1, room2 } = await startPair(12635);
  try {
    await waitForResult(room1, room2);
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
    await waitUntil(() => Boolean(offer1?.seat && offer2?.seat), 4000, 'reserved rematch seats');
    await room1.leave();
    await room2.leave();
    const kept = await client1.consumeSeatReservation(offer1!.seat!);
    const late = await client2.consumeSeatReservation(offer2!.seat!);
    await late.leave();
    await sleep(120);
    if (kept.state.result) {
      throw new Error(`Late seat leave forfeited at tick ${kept.state.tick}: ${JSON.stringify(kept.state.result)}`);
    }
    await Promise.race([kept.leave().catch(() => undefined), sleep(400)]);
    console.log('✓ late rematch seat leave does not forfeit the remaining player');
  } finally {
    await shutdown(server);
  }
}

async function main(): Promise<void> {
  console.log('\n=== rematch-reserve: clear votes + reserved seats ===\n');
  await testLateRematchDoesNotUseStaleVote();
  await testRematchRoomIsReserved();
  await testClientRematchFlagIsIgnored();
  await testLateSeatLeaveDoesNotForfeit();
  await testProductionIgnoresMatchTicks();
  console.log('\n✅ rematch-reserve PASSED\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ rematch-reserve FAILED:', error);
    process.exit(1);
  });
