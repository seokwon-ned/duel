import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import WebSocket from 'ws';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction } from '@turf-duel/engine';
import { Bot } from '@turf-duel/bot';

interface BandwidthStats {
  totalBytes: number;
  bytesPerSecond: number[];
  peakBytesPerSecond: number;
  averageBytesPerSecond: number;
  p95BytesPerSecond: number;
}

async function measureBandwidth(): Promise<void> {
  console.log('🎮 땅따 Real WebSocket Bandwidth Measurement\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12567);
  console.log('✓ Test server started on port 12567\n');

  const stats1: BandwidthStats = { totalBytes: 0, bytesPerSecond: [], peakBytesPerSecond: 0, averageBytesPerSecond: 0, p95BytesPerSecond: 0 };
  const stats2: BandwidthStats = { totalBytes: 0, bytesPerSecond: [], peakBytesPerSecond: 0, averageBytesPerSecond: 0, p95BytesPerSecond: 0 };

  try {
    console.log('Connecting raw WebSocket clients for bandwidth measurement...\n');
    
    // Create two WebSocket clients
    const ws1 = new WebSocket('ws://localhost:12567');
    const ws2 = new WebSocket('ws://localhost:12567');

    await new Promise((resolve) => {
      let connected = 0;
      ws1.on('open', () => { connected++; if (connected === 2) resolve(null); });
      ws2.on('open', () => { connected++; if (connected === 2) resolve(null); });
    });

    // Join room
    ws1.send(JSON.stringify([9, 'turf_duel', {}])); // JOIN_ROOM protocol message
    ws2.send(JSON.stringify([9, 'turf_duel', {}]));

    console.log('✓ Clients connected, waiting for match to start...\n');

    const startTime = Date.now();
    let lastSecondMark = startTime;
    let bytesThisSecond1 = 0;
    let bytesThisSecond2 = 0;
    let matchStarted = false;
    let matchEnded = false;

    // Track bytes per second
    const bandwidthInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastSecondMark >= 1000) {
        stats1.bytesPerSecond.push(bytesThisSecond1);
        stats2.bytesPerSecond.push(bytesThisSecond2);
        
        stats1.peakBytesPerSecond = Math.max(stats1.peakBytesPerSecond, bytesThisSecond1);
        stats2.peakBytesPerSecond = Math.max(stats2.peakBytesPerSecond, bytesThisSecond2);
        
        bytesThisSecond1 = 0;
        bytesThisSecond2 = 0;
        lastSecondMark = now;
      }
    }, 100);

    ws1.on('message', (data: Buffer) => {
      const byteLength = data.length;
      
      stats1.totalBytes += byteLength;
      bytesThisSecond1 += byteLength;

      // Check for match result (very basic - just look for large state updates stopping)
      if (matchStarted && byteLength < 10) {
        matchEnded = true;
      } else if (byteLength > 100) {
        matchStarted = true;
      }
    });

    ws2.on('message', (data: Buffer) => {
      const byteLength = data.length;
      
      stats2.totalBytes += byteLength;
      bytesThisSecond2 += byteLength;
    });

    // Initialize bots
    const easyBot = new Bot('easy', 1, 42);
    const normalBot = new Bot('normal', 2, 43);

    // Send random inputs at 20Hz
    const directions = [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT];
    const inputInterval = setInterval(() => {
      const dir1 = directions[Math.floor(Math.random() * 4)];
      const dir2 = directions[Math.floor(Math.random() * 4)];
      
      // Protocol message: [2, 'input', { direction: ... }]
      ws1.send(JSON.stringify([2, 'input', { direction: dir1 }]));
      ws2.send(JSON.stringify([2, 'input', { direction: dir2 }]));
    }, 50); // 20Hz

    // Wait for 150 seconds or until match ends
    console.log('Running match for up to 150 seconds...\n');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        clearInterval(inputInterval);
        clearInterval(bandwidthInterval);
        resolve();
      }, 150000);

      // Check for match end every second
      const checkInterval = setInterval(() => {
        if (matchEnded || Date.now() - startTime > 150000) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          clearInterval(inputInterval);
          clearInterval(bandwidthInterval);
          resolve();
        }
      }, 1000);
    });

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    // Flush last second
    if (bytesThisSecond1 > 0) {
      stats1.bytesPerSecond.push(bytesThisSecond1);
      stats1.peakBytesPerSecond = Math.max(stats1.peakBytesPerSecond, bytesThisSecond1);
    }
    if (bytesThisSecond2 > 0) {
      stats2.bytesPerSecond.push(bytesThisSecond2);
      stats2.peakBytesPerSecond = Math.max(stats2.peakBytesPerSecond, bytesThisSecond2);
    }

    // Calculate statistics
    stats1.averageBytesPerSecond = Math.round(stats1.totalBytes / duration);
    stats2.averageBytesPerSecond = Math.round(stats2.totalBytes / duration);

    // Calculate p95
    const calculateP95 = (values: number[]): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const index = Math.ceil(sorted.length * 0.95) - 1;
      return sorted[Math.max(0, index)];
    };

    stats1.p95BytesPerSecond = calculateP95(stats1.bytesPerSecond);
    stats2.p95BytesPerSecond = calculateP95(stats2.bytesPerSecond);

    console.log('✓ Match completed\n');
    console.log('=== Real WebSocket Bandwidth Report ===\n');
    console.log(`Match duration: ${duration.toFixed(1)}s\n`);
    
    const totalBytesPerMatch = stats1.totalBytes + stats2.totalBytes;
    
    console.log('Player 1:');
    console.log(`  Total: ${stats1.totalBytes.toLocaleString()} bytes (${(stats1.totalBytes / 1024).toFixed(2)} KB)`);
    console.log(`  Average: ${stats1.averageBytesPerSecond.toLocaleString()} bytes/sec`);
    console.log(`  P95: ${stats1.p95BytesPerSecond.toLocaleString()} bytes/sec`);
    console.log(`  Peak: ${stats1.peakBytesPerSecond.toLocaleString()} bytes/sec\n`);

    console.log('Player 2:');
    console.log(`  Total: ${stats2.totalBytes.toLocaleString()} bytes (${(stats2.totalBytes / 1024).toFixed(2)} KB)`);
    console.log(`  Average: ${stats2.averageBytesPerSecond.toLocaleString()} bytes/sec`);
    console.log(`  P95: ${stats2.p95BytesPerSecond.toLocaleString()} bytes/sec`);
    console.log(`  Peak: ${stats2.peakBytesPerSecond.toLocaleString()} bytes/sec\n`);

    const avgPerPlayer = Math.round((stats1.averageBytesPerSecond + stats2.averageBytesPerSecond) / 2);
    const p95PerPlayer = Math.round((stats1.p95BytesPerSecond + stats2.p95BytesPerSecond) / 2);
    const peakPerPlayer = Math.round((stats1.peakBytesPerSecond + stats2.peakBytesPerSecond) / 2);

    console.log('Per-Player Summary:');
    console.log(`  Average: ${avgPerPlayer.toLocaleString()} bytes/sec (~${(avgPerPlayer / 1024).toFixed(2)} KB/s)`);
    console.log(`  P95: ${p95PerPlayer.toLocaleString()} bytes/sec (~${(p95PerPlayer / 1024).toFixed(2)} KB/s)`);
    console.log(`  Peak: ${peakPerPlayer.toLocaleString()} bytes/sec (~${(peakPerPlayer / 1024).toFixed(2)} KB/s)\n`);

    console.log('Total per Match:');
    console.log(`  ${totalBytesPerMatch.toLocaleString()} bytes (${(totalBytesPerMatch / 1024).toFixed(2)} KB)\n`);

    console.log('Note: Real bytes measured from WebSocket message events.');
    console.log('      Includes Colyseus protocol overhead and Schema delta encoding.');
    console.log();

    ws1.close();
    ws2.close();
  } catch (error) {
    console.error('Error during bandwidth measurement:', error);
    throw error;
  } finally {
    await server.gracefullyShutdown();
    process.exit(0);
  }
}

measureBandwidth().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
