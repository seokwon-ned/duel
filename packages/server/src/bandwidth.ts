import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from 'colyseus.js';
import * as WebSocket from 'ws';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction } from '@turf-duel/engine';

(global as any).WebSocket = WebSocket;

interface BandwidthStats {
  totalBytes: number;
  bytesPerSecond: number[];
  peakBytesPerSecond: number;
  averageBytesPerSecond: number;
}

async function measureBandwidth(): Promise<void> {
  console.log('🎮 땅따 Bandwidth Measurement\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12567);
  console.log('✓ Test server started on port 12567\n');

  const client1 = new Client('ws://localhost:12567');
  const client2 = new Client('ws://localhost:12567');

  const stats1: BandwidthStats = { totalBytes: 0, bytesPerSecond: [], peakBytesPerSecond: 0, averageBytesPerSecond: 0 };
  const stats2: BandwidthStats = { totalBytes: 0, bytesPerSecond: [], peakBytesPerSecond: 0, averageBytesPerSecond: 0 };

  try {
    console.log('Connecting clients...');
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');

    console.log('✓ Both clients connected\n');
    console.log('Running 150s match with scripted safe looping inputs...\n');

    const startTime = Date.now();
    let lastSecondTime = startTime;
    let bytesThisSecond1 = 0;
    let bytesThisSecond2 = 0;

    // Scripted safe looping patterns - both players stay in their starting areas
    // Player 1: 2x2 square in top-left (within 3x3 starting area)
    // Player 2: 2x2 square in bottom-right (within 3x3 starting area)
    const loopPattern1 = [Direction.RIGHT, Direction.DOWN, Direction.LEFT, Direction.UP];
    const loopPattern2 = [Direction.LEFT, Direction.UP, Direction.RIGHT, Direction.DOWN];
    const cellsPerSide = 2; // Very small loop to stay safe
    const ticksPerMove = 2.5; // 20 ticks/sec, 8 cells/sec = 2.5 ticks per cell
    const ticksPerSide = cellsPerSide * ticksPerMove; // 5 ticks per side
    let tickCount = 0;

    // Hook into WebSocket to measure actual bytes
    const getWebSocket = (room: any) => {
      try {
        return room.connection?.transport?.ws || (room as any).ws;
      } catch {
        return null;
      }
    };

    const ws1 = getWebSocket(room1);
    const ws2 = getWebSocket(room2);

    if (ws1 && typeof ws1.addEventListener === 'function') {
      ws1.addEventListener('message', (event: any) => {
        const byteLength = event.data?.length || event.data?.byteLength || 0;
        if (byteLength > 0) {
          stats1.totalBytes += byteLength;
          bytesThisSecond1 += byteLength;
          
          const now = Date.now();
          if (now - lastSecondTime >= 1000) {
            stats1.bytesPerSecond.push(bytesThisSecond1);
            stats1.peakBytesPerSecond = Math.max(stats1.peakBytesPerSecond, bytesThisSecond1);
            bytesThisSecond1 = 0;
            lastSecondTime = now;
          }
        }
      });
    }

    if (ws2 && typeof ws2.addEventListener === 'function') {
      ws2.addEventListener('message', (event: any) => {
        const byteLength = event.data?.length || event.data?.byteLength || 0;
        if (byteLength > 0) {
          stats2.totalBytes += byteLength;
          bytesThisSecond2 += byteLength;
        }
      });
    }

    // Send inputs at 20Hz to match server tick rate
    const interval = setInterval(() => {
      const sideIndex = Math.floor(tickCount / ticksPerSide) % 4;
      const direction1 = loopPattern1[sideIndex];
      const direction2 = loopPattern2[sideIndex];
      
      room1.send('input', { direction: direction1 });
      room2.send('input', { direction: direction2 });
      
      tickCount++;
    }, 50); // 20Hz = 50ms per tick

    await new Promise<void>((resolve) => {
      room1.onStateChange((state: any) => {
        if (state.result) {
          clearInterval(interval);
          
          // Flush last second
          if (bytesThisSecond1 > 0) {
            stats1.bytesPerSecond.push(bytesThisSecond1);
            stats1.peakBytesPerSecond = Math.max(stats1.peakBytesPerSecond, bytesThisSecond1);
          }
          if (bytesThisSecond2 > 0) {
            stats2.bytesPerSecond.push(bytesThisSecond2);
            stats2.peakBytesPerSecond = Math.max(stats2.peakBytesPerSecond, bytesThisSecond2);
          }
          
          setTimeout(resolve, 1000);
        }
      });
    });

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    stats1.averageBytesPerSecond = stats1.totalBytes / duration;
    stats2.averageBytesPerSecond = stats2.totalBytes / duration;

    console.log('✓ Match completed\n');
    console.log('=== Bandwidth Report ===\n');
    console.log(`Match duration: ${duration.toFixed(1)}s\n`);
    
    console.log('Player 1:');
    console.log(`  Total: ${stats1.totalBytes} bytes`);
    console.log(`  Average: ${Math.round(stats1.averageBytesPerSecond)} bytes/sec`);
    console.log(`  Peak: ${stats1.peakBytesPerSecond} bytes/sec\n`);

    console.log('Player 2:');
    console.log(`  Total: ${stats2.totalBytes} bytes`);
    console.log(`  Average: ${Math.round(stats2.averageBytesPerSecond)} bytes/sec`);
    console.log(`  Peak: ${stats2.peakBytesPerSecond} bytes/sec\n`);

    await room1.leave();
    await room2.leave();
  } catch (error) {
    console.error('Error during bandwidth measurement:', error);
  } finally {
    await server.gracefullyShutdown();
    process.exit(0);
  }
}

measureBandwidth().catch(console.error);
