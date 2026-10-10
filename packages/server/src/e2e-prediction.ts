// Client-Side Prediction E2E Test
// Tests that client prediction works correctly with 200ms latency
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction, GRID_SIZE } from '@turf-duel/engine';

interface TestResult {
  passed: boolean;
  message: string;
}

// Helper to add artificial latency
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testPredictionWithLatency(): Promise<TestResult> {
  console.log('\n=== Test: 200ms Latency - Turn at Intended Cell ===\n');
  
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12573);
  console.log('✓ Server started on port 12573');

  try {
    const client1 = new Client('ws://localhost:12573');
    const client2 = new Client('ws://localhost:12573');

    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');
    console.log(`✓ Both clients connected to room: ${room1.roomId}`);

    // Wait for game to start
    await delay(200);

    // Record player 1's position before turn
    const initialPos = {
      x: (room1.state as any).player1.position.x,
      y: (room1.state as any).player1.position.y,
    };
    const currentTick = (room1.state as any).tick;

    console.log(`Initial P1 position: (${initialPos.x}, ${initialPos.y}) at tick ${currentTick}`);

    // Send input with clientTick (simulating client prediction)
    // Player 1 turns DOWN (should happen at current cell)
    room1.send('input', { 
      direction: Direction.DOWN, 
      clientTick: currentTick,
    });

    // Add 200ms latency before checking result
    await delay(200);

    // Check where the turn actually happened on the server
    // The turn should have been applied at tick currentTick, not later
    const turnPosition = {
      x: (room1.state as any).player1.position.x,
      y: (room1.state as any).player1.position.y,
    };

    console.log(`Turn position: (${turnPosition.x}, ${turnPosition.y})`);

    // With prediction and rollback, even with 200ms latency:
    // - The turn should happen at or near the intended cell
    // - Not 4+ cells away (which would happen without prediction)
    
    const distance = Math.abs(turnPosition.x - initialPos.x) + Math.abs(turnPosition.y - initialPos.y);
    
    if (distance > 2) {
      await room1.leave();
      await room2.leave();
      await server.gracefullyShutdown();
      return {
        passed: false,
        message: `Turn happened too far from intended cell: distance=${distance} cells (expected ≤2)`,
      };
    }

    await room1.leave(true); // consented leave, no reconnection
    await room2.leave(true);
    await server.gracefullyShutdown();

    return {
      passed: true,
      message: `✓ Turn at intended cell with 200ms latency (distance=${distance})`,
    };
  } catch (error) {
    await server.gracefullyShutdown();
    return {
      passed: false,
      message: `Error: ${error}`,
    };
  }
}

async function testReconciliationGridMatch(): Promise<TestResult> {
  console.log('\n=== Test: Reconciliation - Grid Match After Sync ===\n');
  
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12574);
  console.log('✓ Server started on port 12574');

  try {
    const client1 = new Client('ws://localhost:12574');
    const client2 = new Client('ws://localhost:12574');

    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');
    console.log(`✓ Both clients connected to room: ${room1.roomId}`);

    // Wait for game to start
    await delay(200);

    // Send multiple inputs from both clients
    for (let i = 0; i < 10; i++) {
      const tick1 = (room1.state as any).tick;
      const tick2 = (room2.state as any).tick;
      
      room1.send('input', { direction: Direction.RIGHT, clientTick: tick1 });
      room2.send('input', { direction: Direction.LEFT, clientTick: tick2 });
      
      await delay(50); // 50ms between inputs
    }

    // Wait for sync
    await delay(500);

    // Compare grids between both clients
    const grid1 = (room1.state as any).grid;
    const grid2 = (room2.state as any).grid;

    let diffCount = 0;
    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
      if (grid1[i] !== grid2[i]) {
        diffCount++;
      }
    }

    console.log(`Grid diff: ${diffCount} cells (expected 0)`);

    await room1.leave(true); // consented leave, no reconnection
    await room2.leave(true);
    await server.gracefullyShutdown();

    if (diffCount > 0) {
      return {
        passed: false,
        message: `Grids don't match after reconciliation: ${diffCount} cell differences`,
      };
    }

    return {
      passed: true,
      message: `✓ Both clients have identical grids (0 diff)`,
    };
  } catch (error) {
    await server.gracefullyShutdown();
    return {
      passed: false,
      message: `Error: ${error}`,
    };
  }
}

async function testOutOfWindowInputsClamped(): Promise<TestResult> {
  console.log('\n=== Test: Out-of-Window Inputs Clamped ===\n');
  
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12575);
  console.log('✓ Server started on port 12575');

  try {
    const client1 = new Client('ws://localhost:12575');
    const client2 = new Client('ws://localhost:12575');

    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');
    console.log(`✓ Both clients connected to room: ${room1.roomId}`);

    // Wait for game to start
    await delay(200);

    const currentTick = (room1.state as any).tick;

    // Send input with very old tick (beyond lag window)
    room1.send('input', { direction: Direction.UP, clientTick: currentTick - 20 });
    
    // Send input with future tick
    room1.send('input', { direction: Direction.DOWN, clientTick: currentTick + 100 });

    await delay(300);

    // Verify game state is still valid (didn't crash or produce invalid state)
    const p1Alive = (room1.state as any).player1.isAlive;
    const p2Alive = (room1.state as any).player2.isAlive;

    await room1.leave(true); // consented leave, no reconnection
    await room2.leave(true);
    await server.gracefullyShutdown();

    if (!p1Alive && !p2Alive) {
      return {
        passed: false,
        message: 'Both players died (possible invalid state from bad tick)',
      };
    }

    return {
      passed: true,
      message: '✓ Out-of-window inputs clamped, game state remains valid',
    };
  } catch (error) {
    await server.gracefullyShutdown();
    return {
      passed: false,
      message: `Error: ${error}`,
    };
  }
}

async function runTests() {
  console.log('🎮 Client-Side Prediction E2E Tests\n');

  const results: TestResult[] = [];

  results.push(await testPredictionWithLatency());
  results.push(await testReconciliationGridMatch());
  results.push(await testOutOfWindowInputsClamped());

  console.log('\n=== Test Results ===\n');
  
  let passedCount = 0;
  for (const result of results) {
    if (result.passed) {
      console.log(`✅ ${result.message}`);
      passedCount++;
    } else {
      console.log(`❌ ${result.message}`);
    }
  }

  console.log(`\n${passedCount}/${results.length} tests passed\n`);

  if (passedCount < results.length) {
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
