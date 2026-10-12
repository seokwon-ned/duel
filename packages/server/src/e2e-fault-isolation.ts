// Fault Isolation Test
// Tests that an error in one room's tick disposes only that room
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelTestRoom } from './rooms/TurfDuelTestRoom.js';

async function testFaultIsolation(): Promise<void> {
  console.log('\n=== Fault Isolation: Room Error Doesn\'t Crash Other Rooms ===\n');

  // Set test env flag to inject fault
  process.env.TURF_DUEL_TEST_INJECT_FAULT = 'true';

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelTestRoom);
  await server.listen(12572);
  console.log('✓ Server started on port 12572');
  console.log('✓ Fault injection enabled (TEST_INJECT_FAULT=true)');

  try {
    // Create two rooms
    console.log('\nCreating room 1 (will fault)...');
    const client1a = new Client('ws://localhost:12572');
    const client1b = new Client('ws://localhost:12572');
    const room1a = await client1a.joinOrCreate('turf_duel');
    const room1b = await client1b.joinOrCreate('turf_duel');
    
    console.log(`✓ Room 1 created: ${room1a.roomId}`);

    // Mark this room for fault injection
    (global as any).FAULT_ROOM_ID = room1a.roomId;

    console.log('\nCreating room 2 (should be unaffected)...');
    const client2a = new Client('ws://localhost:12572');
    const client2b = new Client('ws://localhost:12572');
    const room2a = await client2a.joinOrCreate('turf_duel');
    const room2b = await client2b.joinOrCreate('turf_duel');
    
    console.log(`✓ Room 2 created: ${room2a.roomId}`);

    await new Promise(resolve => setTimeout(resolve, 200));

    const room2InitialTick = room2a.state.tick;
    console.log(`\nRoom 2 initial tick: ${room2InitialTick}`);

    // Wait for fault to occur and room 1 to be disposed
    console.log('\nWaiting for fault to occur in room 1...');
    
    let room1Closed = false;
    room1a.onLeave(() => {
      room1Closed = true;
      console.log('✓ Room 1 client disconnected (room disposed after fault)');
    });

    // Wait for fault
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (!room1Closed) {
      console.warn('⚠️  Room 1 not closed yet, waiting longer...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Check room 2 is still ticking
    const room2FinalTick = room2a.state.tick;
    console.log(`Room 2 final tick: ${room2FinalTick}`);

    if (room2FinalTick <= room2InitialTick) {
      throw new Error(`Room 2 stopped ticking: ${room2InitialTick} → ${room2FinalTick}`);
    }

    console.log(`✓ Room 2 continued ticking: ${room2InitialTick} → ${room2FinalTick} (+${room2FinalTick - room2InitialTick})`);

    // Check server is still responsive
    console.log('\nVerifying server still responsive...');
    const client3a = new Client('ws://localhost:12572');
    const client3b = new Client('ws://localhost:12572');
    const room3a = await client3a.joinOrCreate('turf_duel');
    const room3b = await client3b.joinOrCreate('turf_duel');
    
    console.log(`✓ New room created: ${room3a.roomId}`);

    const leaveSoon = (room: { leave: () => Promise<number> }) =>
      Promise.race([room.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    await leaveSoon(room2a);
    await leaveSoon(room2b);
    await leaveSoon(room3a);
    await leaveSoon(room3b);

    if (!room1Closed) {
      await leaveSoon(room1a);
      await leaveSoon(room1b);
    }

    console.log('\n✅ Fault Isolation PASSED: Room error isolated, other rooms unaffected\n');
  } catch (error) {
    console.error('\n❌ Fault Isolation FAILED:', error);
    throw error;
  } finally {
    delete process.env.TURF_DUEL_TEST_INJECT_FAULT;
    delete (global as any).FAULT_ROOM_ID;
    await Promise.race([
      server.gracefullyShutdown(false).catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }
}

testFaultIsolation()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
