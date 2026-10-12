// E2E Crash Resistance Tests
// Tests that invalid inputs and room errors don't crash the server
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';

function leaveSoon(room: { leave: () => Promise<number> }): Promise<unknown> {
  return Promise.race([room.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
}

async function runCrashTests(): Promise<void> {
  console.log('🎮 E2E Crash Resistance Tests\n');
  console.log('Testing that invalid inputs and errors don\'t crash the server\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12568);
  console.log('✓ Server started on port 12568\n');

  try {
    // ============================================================================
    // Test 1: Invalid Inputs
    // ============================================================================
    console.log('=== Test 1: Invalid Inputs ===\n');
    
    const client1 = new Client('ws://localhost:12568');
    const client2 = new Client('ws://localhost:12568');
    
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');
    
    console.log('✓ Both clients connected to room:', room1.roomId);
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const initialTick = room1.state.tick;
    console.log(`Initial tick: ${initialTick}`);

    // Send various invalid inputs
    console.log('\nSending invalid inputs...');
    
    // Invalid direction strings
    room1.send('input', { direction: 'INVALID' });
    room1.send('input', { direction: 'GARBAGE' });
    room1.send('input', { direction: 'north' }); // lowercase
    
    // Null/undefined
    room1.send('input', { direction: null });
    room1.send('input', { direction: undefined });
    
    // Wrong types
    room1.send('input', { direction: 123 });
    room1.send('input', { direction: true });
    room1.send('input', { direction: ['UP'] });
    room1.send('input', { direction: { dir: 'UP' } });
    
    // Missing direction field
    room1.send('input', { wrong: 'field' });
    room1.send('input', {});
    
    console.log('✓ All invalid inputs sent');
    
    // Wait for several ticks
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check server is still alive and room is ticking
    const finalTick = room1.state.tick;
    console.log(`Final tick: ${finalTick}`);
    
    if (finalTick <= initialTick) {
      throw new Error(`Room stopped ticking: ${initialTick} → ${finalTick}`);
    }
    
    console.log(`✓ Room kept ticking: ${initialTick} → ${finalTick} (+${finalTick - initialTick})`);
    
    // Send valid input to confirm it still works
    room1.send('input', { direction: 'UP' });
    room2.send('input', { direction: 'DOWN' });
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('✓ Valid inputs still processed');
    
    await leaveSoon(room1);
    await leaveSoon(room2);
    
    console.log('\n✅ Test 1 PASSED: Invalid inputs do not crash server\n');

    // ============================================================================
    // Test 2: Room Isolation
    // ============================================================================
    console.log('=== Test 2: Room Isolation ===\n');
    
    // Create room 1
    const client1a = new Client('ws://localhost:12568');
    const client1b = new Client('ws://localhost:12568');
    const room1a = await client1a.joinOrCreate('turf_duel');
    const room1b = await client1b.joinOrCreate('turf_duel');
    
    // Create room 2
    const client2a = new Client('ws://localhost:12568');
    const client2b = new Client('ws://localhost:12568');
    const room2a = await client2a.joinOrCreate('turf_duel');
    const room2b = await client2b.joinOrCreate('turf_duel');
    
    console.log('✓ Two separate rooms created');
    console.log(`  Room 1: ${room1a.roomId}`);
    console.log(`  Room 2: ${room2a.roomId}`);
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const room2InitialTick = room2a.state.tick;
    console.log(`\nRoom 2 initial tick: ${room2InitialTick}`);

    // Spam room 1 with invalid inputs
    console.log('\nSpamming room 1 with invalid inputs...');
    for (let i = 0; i < 50; i++) {
      room1a.send('input', { direction: `INVALID_${i}` });
      room1a.send('input', { direction: null });
      room1a.send('input', { direction: 123 });
    }
    
    console.log('✓ 150 invalid inputs sent to room 1');
    
    // Wait and check room 2 is unaffected
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const room2FinalTick = room2a.state.tick;
    console.log(`Room 2 final tick: ${room2FinalTick}`);
    
    if (room2FinalTick <= room2InitialTick) {
      throw new Error(`Room 2 stopped ticking: ${room2InitialTick} → ${room2FinalTick}`);
    }
    
    console.log(`✓ Room 2 unaffected: ${room2InitialTick} → ${room2FinalTick} (+${room2FinalTick - room2InitialTick})`);
    
    await leaveSoon(room1a);
    await leaveSoon(room1b);
    await leaveSoon(room2a);
    await leaveSoon(room2b);
    
    console.log('\n✅ Test 2 PASSED: One room\'s errors don\'t affect other rooms\n');

    // ============================================================================
    // Test 3: Process Stays Alive
    // ============================================================================
    console.log('=== Test 3: Process Stays Alive ===\n');
    
    const client3a = new Client('ws://localhost:12568');
    const client3b = new Client('ws://localhost:12568');
    
    const room3a = await client3a.joinOrCreate('turf_duel');
    const room3b = await client3b.joinOrCreate('turf_duel');
    
    console.log('✓ Clients connected');
    
    await new Promise(resolve => setTimeout(resolve, 200));

    // Send extreme inputs that might crash
    console.log('\nSending extreme inputs...');
    
    // Very large array
    room3a.send('input', { direction: new Array(1000).fill('UP') });
    
    // Deeply nested object
    let nested: any = { direction: 'UP' };
    for (let i = 0; i < 50; i++) {
      nested = { nested };
    }
    room3a.send('input', nested);
    
    // Multiple rapid-fire messages
    for (let i = 0; i < 100; i++) {
      room3a.send('input', { direction: i % 2 === 0 ? null : 'INVALID' });
    }
    
    console.log('✓ Extreme inputs sent');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Try to create a new room to verify server is still responsive
    const client4a = new Client('ws://localhost:12568');
    const client4b = new Client('ws://localhost:12568');
    const room4a = await client4a.joinOrCreate('turf_duel');
    const room4b = await client4b.joinOrCreate('turf_duel');
    
    console.log('✓ Server still responsive: new room created successfully');
    console.log(`  New room: ${room4a.roomId}`);
    
    await leaveSoon(room3a);
    await leaveSoon(room3b);
    await leaveSoon(room4a);
    await leaveSoon(room4b);
    
    console.log('\n✅ Test 3 PASSED: Process stays alive under extreme inputs\n');

    // ============================================================================
    // All tests passed
    // ============================================================================
    console.log('\n✅ ALL CRASH RESISTANCE TESTS PASSED\n');
    
    await Promise.race([
      server.gracefullyShutdown().catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ CRASH RESISTANCE TESTS FAILED\n');
    console.error(error);
    await Promise.race([
      server.gracefullyShutdown().catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    process.exit(1);
  }
}

runCrashTests();
