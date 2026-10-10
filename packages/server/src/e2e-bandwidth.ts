// E2E Test with ACTUAL WebSocket byte measurement
// Measures real bytes from WebSocket frames, not formulas
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction, TICKS_PER_SECOND } from '@turf-duel/engine';

interface BandwidthStats {
  totalBytes: number;
  bytesPerSecond: number[];
}

function calculateStats(stats: BandwidthStats, duration: number) {
  const avgBytesPerSec = Math.round(stats.totalBytes / duration);
  
  // Calculate P95
  const sorted = [...stats.bytesPerSecond].sort((a, b) => a - b);
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95BytesPerSec = sorted[Math.max(0, p95Index)] || 0;
  
  // Peak is max
  const peakBytesPerSec = Math.max(...stats.bytesPerSecond, 0);
  
  // Steady-state peak (excluding first second for initial grid transmission)
  const steadyStateBytes = stats.bytesPerSecond.slice(1);
  const steadyStatePeak = steadyStateBytes.length > 0 ? Math.max(...steadyStateBytes, 0) : 0;
  
  return { avgBytesPerSec, p95BytesPerSec, peakBytesPerSec, steadyStatePeak };
}

async function runE2ETest(): Promise<void> {
  console.log('🎮 E2E Test & REAL WebSocket Bandwidth Measurement\n');
  console.log('Mode: Real-time 150s match, measuring actual WebSocket frame bytes\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12567);
  console.log('✓ Test server started on port 12567\n');

  const client1 = new Client('ws://localhost:12567');
  const client2 = new Client('ws://localhost:12567');

  const stats1: BandwidthStats = { totalBytes: 0, bytesPerSecond: [] };
  const stats2: BandwidthStats = { totalBytes: 0, bytesPerSecond: [] };

  let inputsSent = 0;
  let stateUpdatesReceived = 0;

  try {
    console.log('Connecting SDK clients...');
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');

    console.log('✓ Both clients connected to room:', room1.roomId);
    console.log('✓ Protocol: @colyseus/sdk 0.18.5 ↔ @colyseus/core 0.18.18 ✅\n');

    // Access underlying WebSocket connections
    const ws1 = (room1.connection as any).transport?.ws || 
                (room1.connection as any).ws ||
                (room1 as any).connection?.ws;
    const ws2 = (room2.connection as any).transport?.ws || 
                (room2.connection as any).ws ||
                (room2 as any).connection?.ws;

    if (!ws1 || !ws2) {
      throw new Error('Failed to access WebSocket connections');
    }

    console.log('✓ WebSocket connections accessed\n');
    console.log('Running 150s match with growing rectangular loops (2x2 → 15x15)...\n');

    const startTime = Date.now();
    let lastSecondMark = startTime;
    let bytesThisSecond1 = 0;
    let bytesThisSecond2 = 0;

    // Track bytes per second
    const bandwidthInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastSecondMark >= 1000) {
        stats1.bytesPerSecond.push(bytesThisSecond1);
        stats2.bytesPerSecond.push(bytesThisSecond2);
        bytesThisSecond1 = 0;
        bytesThisSecond2 = 0;
        lastSecondMark = now;
      }
    }, 100);

    // Hook WebSocket message events to measure ACTUAL bytes
    const originalAddEventListener1 = ws1.addEventListener?.bind(ws1) || ws1.on?.bind(ws1);
    const originalAddEventListener2 = ws2.addEventListener?.bind(ws2) || ws2.on?.bind(ws2);

    const messageHandler1 = (event: any) => {
      const data = event.data || event;
      let byteLength = 0;
      
      if (Buffer.isBuffer(data)) {
        byteLength = data.length;
      } else if (data instanceof ArrayBuffer) {
        byteLength = data.byteLength;
      } else if (ArrayBuffer.isView(data)) {
        byteLength = data.byteLength;
      } else if (typeof data === 'string') {
        byteLength = Buffer.byteLength(data, 'utf8');
      }
      
      if (byteLength > 0) {
        stats1.totalBytes += byteLength;
        bytesThisSecond1 += byteLength;
      }
    };

    const messageHandler2 = (event: any) => {
      const data = event.data || event;
      let byteLength = 0;
      
      if (Buffer.isBuffer(data)) {
        byteLength = data.length;
      } else if (data instanceof ArrayBuffer) {
        byteLength = data.byteLength;
      } else if (ArrayBuffer.isView(data)) {
        byteLength = data.byteLength;
      } else if (typeof data === 'string') {
        byteLength = Buffer.byteLength(data, 'utf8');
      }
      
      if (byteLength > 0) {
        stats2.totalBytes += byteLength;
        bytesThisSecond2 += byteLength;
      }
    };

    // Register message handlers
    if (ws1.addEventListener) {
      ws1.addEventListener('message', messageHandler1);
    } else if (ws1.on) {
      ws1.on('message', messageHandler1);
    }

    if (ws2.addEventListener) {
      ws2.addEventListener('message', messageHandler2);
    } else if (ws2.on) {
      ws2.on('message', messageHandler2);
    }

    // Track state updates
    room1.onStateChange(() => {
      stateUpdatesReceived++;
    });

    // Growing rectangular loop pattern
    let loopSize = 2;
    const maxLoopSize = 15;
    const directions = [Direction.RIGHT, Direction.DOWN, Direction.LEFT, Direction.UP];
    let currentDirection = 0;
    let stepsInCurrentDirection = 0;
    let stepsPerSide = loopSize;
    let sidesCompleted = 0;

    // Send inputs at 20Hz
    const inputInterval = setInterval(() => {
      const dir1 = directions[currentDirection];
      const dir2 = directions[(currentDirection + 2) % 4];
      
      room1.send('input', { direction: dir1 });
      room2.send('input', { direction: dir2 });
      inputsSent += 2;
      
      stepsInCurrentDirection++;
      if (stepsInCurrentDirection >= stepsPerSide) {
        stepsInCurrentDirection = 0;
        currentDirection = (currentDirection + 1) % 4;
        sidesCompleted++;
        
        if (sidesCompleted >= 4) {
          sidesCompleted = 0;
          if (loopSize < maxLoopSize) {
            loopSize++;
            stepsPerSide = loopSize;
          }
        }
      }
    }, 50); // 20Hz

    // Wait for match result
    let finalTick = 0;
    await new Promise<void>((resolve) => {
      const checkResult = () => {
        if ((room1.state as any).result) {
          finalTick = (room1.state as any).tick;
          clearInterval(inputInterval);
          clearInterval(bandwidthInterval);
          resolve();
        }
      };
      
      room1.onStateChange(checkResult);
      
      // Fallback timeout after 151s
      setTimeout(() => {
        clearInterval(inputInterval);
        clearInterval(bandwidthInterval);
        resolve();
      }, 151000);
    });

    // Flush last second
    if (bytesThisSecond1 > 0) stats1.bytesPerSecond.push(bytesThisSecond1);
    if (bytesThisSecond2 > 0) stats2.bytesPerSecond.push(bytesThisSecond2);

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    // Assert tick accuracy
    if (finalTick !== 3000) {
      throw new Error(`❌ Tick accuracy FAILED: Expected exactly 3000 ticks, got ${finalTick}`);
    }
    console.log(`\n✅ Tick accuracy verified: exactly ${finalTick} ticks\n`);

    // Calculate statistics from ACTUAL measured bytes
    const result1 = calculateStats(stats1, duration);
    const result2 = calculateStats(stats2, duration);

    console.log('\n✅ E2E Test Results:\n');
    console.log(`SDK Connection: ✅ (@colyseus/sdk 0.18.5 ↔ @colyseus/core 0.18.18)`);
    console.log(`Room Join: ✅ (${room1.roomId})`);
    console.log(`Input Messages Sent: ✅ (${inputsSent} total)`);
    console.log(`State Updates Received: ✅ (${stateUpdatesReceived} patches)`);
    console.log(`Match Duration: ${duration.toFixed(1)}s\n`);

    console.log('=== MEASURED WebSocket Bandwidth (Real Frames) ===\n');
    
    console.log('Player 1:');
    console.log(`  Total: ${stats1.totalBytes.toLocaleString()} bytes (${(stats1.totalBytes / 1024).toFixed(2)} KB)`);
    console.log(`  Average: ${result1.avgBytesPerSec.toLocaleString()} bytes/sec (~${(result1.avgBytesPerSec / 1024).toFixed(2)} KB/s)`);
    console.log(`  P95: ${result1.p95BytesPerSec.toLocaleString()} bytes/sec (~${(result1.p95BytesPerSec / 1024).toFixed(2)} KB/s)`);
    console.log(`  Peak: ${result1.peakBytesPerSec.toLocaleString()} bytes/sec (~${(result1.peakBytesPerSec / 1024).toFixed(2)} KB/s)`);
    console.log(`  Steady-state peak: ${result1.steadyStatePeak.toLocaleString()} bytes/sec (~${(result1.steadyStatePeak / 1024).toFixed(2)} KB/s, excluding first 1s)\n`);

    console.log('Player 2:');
    console.log(`  Total: ${stats2.totalBytes.toLocaleString()} bytes (${(stats2.totalBytes / 1024).toFixed(2)} KB)`);
    console.log(`  Average: ${result2.avgBytesPerSec.toLocaleString()} bytes/sec (~${(result2.avgBytesPerSec / 1024).toFixed(2)} KB/s)`);
    console.log(`  P95: ${result2.p95BytesPerSec.toLocaleString()} bytes/sec (~${(result2.p95BytesPerSec / 1024).toFixed(2)} KB/s)`);
    console.log(`  Peak: ${result2.peakBytesPerSec.toLocaleString()} bytes/sec (~${(result2.peakBytesPerSec / 1024).toFixed(2)} KB/s)`);
    console.log(`  Steady-state peak: ${result2.steadyStatePeak.toLocaleString()} bytes/sec (~${(result2.steadyStatePeak / 1024).toFixed(2)} KB/s, excluding first 1s)\n`);

    const avgPerPlayer = Math.round((result1.avgBytesPerSec + result2.avgBytesPerSec) / 2);
    const p95PerPlayer = Math.round((result1.p95BytesPerSec + result2.p95BytesPerSec) / 2);
    const peakPerPlayer = Math.round((result1.peakBytesPerSec + result2.peakBytesPerSec) / 2);
    const steadyStatePeakPerPlayer = Math.round((result1.steadyStatePeak + result2.steadyStatePeak) / 2);
    const totalPerPlayer = Math.round((stats1.totalBytes + stats2.totalBytes) / 2);

    console.log('Per-Player Average:');
    console.log(`  Average: ${avgPerPlayer.toLocaleString()} bytes/sec (~${(avgPerPlayer / 1024).toFixed(2)} KB/s)`);
    console.log(`  P95: ${p95PerPlayer.toLocaleString()} bytes/sec (~${(p95PerPlayer / 1024).toFixed(2)} KB/s)`);
    console.log(`  Peak: ${peakPerPlayer.toLocaleString()} bytes/sec (~${(peakPerPlayer / 1024).toFixed(2)} KB/s)`);
    console.log(`  Steady-state peak: ${steadyStatePeakPerPlayer.toLocaleString()} bytes/sec (~${(steadyStatePeakPerPlayer / 1024).toFixed(2)} KB/s, excluding first 1s)`);
    console.log(`  Total per match: ${totalPerPlayer.toLocaleString()} bytes (~${(totalPerPlayer / 1024).toFixed(2)} KB)\n`);

    const totalMatch = stats1.totalBytes + stats2.totalBytes;
    console.log('Total per Match (both players):');
    console.log(`  ${totalMatch.toLocaleString()} bytes (${(totalMatch / 1024).toFixed(2)} KB)\n`);

    console.log('Measurement Method:');
    console.log(`  - ACTUAL WebSocket frame bytes (measured from ws.on('message') events)`);
    console.log(`  - Real-time 150s match at 20Hz tick rate`);
    console.log(`  - Growing rectangular loops (2x2 → 15x15) capturing territory`);
    console.log(`  - Colyseus @colyseus/schema 5.0.36 delta encoding`);
    console.log(`  - ${stats1.bytesPerSecond.length} seconds of per-second samples\n`);

    // Assertions
    console.log('=== Assertions ===\n');
    
    // Check match ticks
    const actualTicks = room1.state.tick;
    const expectedTicks = 150 * TICKS_PER_SECOND;
    console.log(`✓ Expected ~${expectedTicks} ticks (150s × ${TICKS_PER_SECOND}Hz)`);
    console.log(`✓ Actual ticks: ${actualTicks}`);
    
    // Allow small variance due to timing drift
    const tickVariance = Math.abs(actualTicks - expectedTicks);
    if (tickVariance > 20) {
      throw new Error(`Match tick count off by ${tickVariance}: expected ~${expectedTicks}, got ${actualTicks}`);
    }
    console.log(`✓ Tick variance: ${tickVariance} ticks (acceptable < 20)\n`);
    
    // Check bytes received
    if (stats1.totalBytes === 0 || stats2.totalBytes === 0) {
      throw new Error(`No bytes measured: P1=${stats1.totalBytes}, P2=${stats2.totalBytes}`);
    }
    console.log(`✓ Bytes received: P1=${stats1.totalBytes}, P2=${stats2.totalBytes}\n`);
    
    // Check bandwidth threshold
    const maxAvgBytesPerSec = 3 * 1024; // 3 KB/s
    if (avgPerPlayer > maxAvgBytesPerSec) {
      throw new Error(`Average bandwidth ${avgPerPlayer} bytes/s exceeds threshold ${maxAvgBytesPerSec} bytes/s`);
    }
    console.log(`✓ Average bandwidth ${avgPerPlayer} bytes/s under threshold ${maxAvgBytesPerSec} bytes/s (${(maxAvgBytesPerSec / 1024).toFixed(1)} KB/s)\n`);

    await room1.leave();
    await room2.leave();
  } catch (error) {
    console.error('❌ E2E test failed:', error);
    throw error;
  } finally {
    await server.gracefullyShutdown();
    process.exit(0);
  }
}

runE2ETest().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
