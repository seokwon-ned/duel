// P1-3 Lossless Sync Under Latency Test
// Tests that delayed/burst patch delivery still results in correct final grid
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction, GRID_SIZE } from '@turf-duel/engine';

async function testLosslessSync(): Promise<void> {
  console.log('\n=== P1-3: Lossless Sync Under Artificial Latency ===\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12571);
  console.log('✓ Server started on port 12571');

  const client1 = new Client('ws://localhost:12571');
  const client2 = new Client('ws://localhost:12571');

  try {
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');

    console.log('✓ Both clients connected');

    await new Promise(resolve => setTimeout(resolve, 200));

    // Hook room2's WebSocket to delay message processing
    const ws2 = (room2.connection as any).transport?.ws || 
                (room2.connection as any).ws ||
                (room2 as any).connection?.ws;

    if (!ws2) {
      throw new Error('Failed to access WebSocket for client 2');
    }

    console.log('✓ WebSocket hooked for delayed processing');

    // Message queue for delayed processing
    interface QueuedMessage {
      data: any;
      timestamp: number;
    }
    const messageQueue: QueuedMessage[] = [];
    
    // Save original onmessage
    const originalOnMessage = ws2.onmessage;

    // Replace with our interceptor
    ws2.onmessage = (event: any) => {
      // Randomly delay (300-500ms hold, then deliver)
      if (Math.random() < 0.3) { // 30% chance to delay
        messageQueue.push({ data: event.data, timestamp: Date.now() });
        
        // Process after delay
        setTimeout(() => {
          const toProcess = messageQueue.shift();
          if (toProcess && originalOnMessage) {
            originalOnMessage.call(ws2, { data: toProcess.data } as any);
          }
        }, 300 + Math.random() * 200); // 300-500ms
      } else {
        // Deliver immediately
        if (originalOnMessage) {
          originalOnMessage.call(ws2, event);
        }
      }
    };

    console.log('✓ Latency simulation active (30% messages delayed 300-500ms)');

    // Send inputs for a short match
    console.log('\nRunning 5-second match with latency...');
    
    const directions = [Direction.RIGHT, Direction.DOWN, Direction.LEFT, Direction.UP];
    let directionIndex = 0;

    const inputInterval = setInterval(() => {
      const dir = directions[directionIndex % directions.length];
      room1.send('input', { direction: dir });
      room2.send('input', { direction: directions[(directionIndex + 2) % 4] });
      directionIndex++;
    }, 50); // 20Hz

    // Run for 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
    clearInterval(inputInterval);

    console.log('\nProcessing remaining queued messages...');
    
    // Wait for all delayed messages to arrive
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Compare final grids
    console.log('\nComparing final grids...');
    
    const grid1 = room1.state.grid;
    const grid2 = room2.state.grid;
    
    if (!grid1 || !grid2 || grid1.length === 0 || grid2.length === 0) {
      throw new Error('Grid not available in state');
    }

    console.log(`Grid 1 length: ${grid1.length}`);
    console.log(`Grid 2 length: ${grid2.length}`);
    console.log(`Room 1 tick: ${room1.state.tick}`);
    console.log(`Room 2 tick: ${room2.state.tick}`);

    // Compare grids cell by cell
    let differences = 0;
    const expectedCells = GRID_SIZE * GRID_SIZE;
    
    if (grid1.length !== expectedCells || grid2.length !== expectedCells) {
      throw new Error(`Grid size mismatch: expected ${expectedCells}, got ${grid1.length}, ${grid2.length}`);
    }

    for (let i = 0; i < expectedCells; i++) {
      if (grid1[i] !== grid2[i]) {
        differences++;
      }
    }

    console.log(`\nGrid comparison: ${differences} differences out of ${expectedCells} cells`);

    if (differences > 0) {
      console.log(`❌ Grids differ: ${differences} cells mismatch`);
      throw new Error(`Lossless sync failed: ${differences} cell differences`);
    }

    console.log('✓ Grids are identical (lossless sync confirmed)');

    // Also verify tick sync
    const tickDiff = Math.abs(room1.state.tick - room2.state.tick);
    console.log(`Tick difference: ${tickDiff}`);
    
    if (tickDiff > 5) {
      console.warn(`⚠️  Large tick difference: ${tickDiff}`);
    } else {
      console.log('✓ Tick sync acceptable');
    }

    await room1.leave();
    await room2.leave();

    console.log('\n✅ P1-3 PASSED: Lossless sync under latency\n');
  } catch (error) {
    console.error('\n❌ P1-3 FAILED:', error);
    throw error;
  } finally {
    await server.gracefullyShutdown();
  }
}

testLosslessSync();
