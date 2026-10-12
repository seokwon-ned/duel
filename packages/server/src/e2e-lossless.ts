// P1-3 Lossless Sync Under Latency Test
// Tests that delayed/burst patch delivery still results in correct final grid
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { testRooms, TurfDuelTestRoom } from './rooms/TurfDuelTestRoom.js';
import { Direction, GRID_WIDTH, GRID_HEIGHT, createInitialState, flattenGrid } from '@turf-duel/engine';

async function testLosslessSync(): Promise<void> {
  console.log('\n=== P1-3: Lossless Sync Under Artificial Latency ===\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelTestRoom);
  await server.listen(12571);
  console.log('✓ Server started on port 12571');

  const client1 = new Client('ws://localhost:12571');
  const client2 = new Client('ws://localhost:12571');

  try {
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');
    const grid1 = trackClientGrid(room1);
    const grid2 = trackClientGrid(room2);

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

    // WebSocket/TCP is ordered. Hold 30% of messages 300-500ms, but never
    // deliver a later patch before an earlier one.
    const originalOnMessage = ws2.onmessage;
    let lastDeliverAt = 0;
    const pending = new Set<Promise<void>>();

    ws2.onmessage = (event: any) => {
      const hold = Math.random() < 0.3 ? 300 + Math.random() * 200 : 0;
      const at = Math.max(Date.now() + hold, lastDeliverAt + 1);
      lastDeliverAt = at;
      const wait = Math.max(0, at - Date.now());
      const p = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (originalOnMessage) {
            originalOnMessage.call(ws2, { data: event.data } as any);
          }
          resolve();
        }, wait);
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
    };

    console.log('✓ Latency simulation active (30% FIFO holds 300-500ms, no reorder)');

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

    // Freeze authority so live client1 cannot pull ahead of delayed client2
    // while we drain 300-500ms holds.
    const auth = testRooms.get(room1.roomId);
    if (!auth) {
      throw new Error(`Missing test room ${room1.roomId}`);
    }
    auth.stopSimulationAndFlush();

    console.log('\nDraining in-flight delayed messages...');
    await drainHeldMessages(pending);

    // Compare final grids
    console.log('\nComparing final grids...');

    console.log(`Grid 1 length: ${grid1.length}`);
    console.log(`Grid 2 length: ${grid2.length}`);
    console.log(`Room 1 tick: ${room1.state.tick}`);
    console.log(`Room 2 tick: ${room2.state.tick}`);

    let differences = 0;
    const expectedCells = GRID_WIDTH * GRID_HEIGHT;

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

    await Promise.race([room1.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    await Promise.race([room2.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);

    console.log('\n✅ P1-3 PASSED: Lossless sync under latency\n');
  } catch (error) {
    console.error('\n❌ P1-3 FAILED:', error);
    throw error;
  } finally {
    await Promise.race([
      server.gracefullyShutdown(false).catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }
}

/** Wait until every held WS message is applied and no new hold can still be in flight. */
async function drainHeldMessages(pending: Set<Promise<void>>): Promise<void> {
  const maxHoldMs = 500;
  const quietMs = maxHoldMs + 80;
  const deadline = Date.now() + 8000;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (pending.size > 0) {
      await Promise.all([...pending]);
      quietSince = Date.now();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (pending.size > 0) {
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
  throw new Error('Timed out draining in-flight delayed messages');
}

function trackClientGrid(room: { onMessage: Function; onStateChange: Function }): Uint8Array {
  const cells = flattenGrid(createInitialState().grid);
  room.onMessage('grid', (payload: ArrayLike<number> | ArrayBuffer) => {
    const buf = payload instanceof ArrayBuffer ? new Uint8Array(payload) : Uint8Array.from(payload as ArrayLike<number>);
    cells.set(buf.subarray(0, cells.length));
  });
  room.onStateChange((state: { cellUpdates?: Array<{ x: number; y: number; type: number }> }) => {
    for (const u of state.cellUpdates ?? []) {
      const i = u.y * GRID_WIDTH + u.x;
      if (i >= 0 && i < cells.length) cells[i] = u.type;
    }
  });
  return cells;
}

testLosslessSync()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
