import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction } from '@turf-duel/engine';

interface BandwidthStats {
  totalBytes: number;
  bytesPerSecond: number[];
  peakBytesPerSecond: number;
  averageBytesPerSecond: number;
  p95BytesPerSecond: number;
}

function byteLengthOf(data: unknown): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  return 0;
}

function hookBytes(ws: { addEventListener?: Function; on?: Function }, onBytes: (n: number) => void): void {
  const handler = (event: any) => {
    const n = byteLengthOf(event?.data ?? event);
    if (n > 0) onBytes(n);
  };
  if (ws.addEventListener) {
    ws.addEventListener('message', handler);
  } else if (ws.on) {
    ws.on('message', handler);
  }
}

function rawSocket(room: { connection?: unknown }): { addEventListener?: Function; on?: Function } | null {
  const connection = room.connection as { transport?: { ws?: any }; ws?: any } | undefined;
  return connection?.transport?.ws ?? connection?.ws ?? null;
}

async function measureBandwidth(): Promise<void> {
  console.log('🎮 땅따 Real WebSocket Bandwidth Measurement\n');

  const durationSec = Number(process.env.TURF_DUEL_BANDWIDTH_SECONDS) || 150;

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12567);
  console.log('✓ Test server started on port 12567\n');

  const stats1: BandwidthStats = { totalBytes: 0, bytesPerSecond: [], peakBytesPerSecond: 0, averageBytesPerSecond: 0, p95BytesPerSecond: 0 };
  const stats2: BandwidthStats = { totalBytes: 0, bytesPerSecond: [], peakBytesPerSecond: 0, averageBytesPerSecond: 0, p95BytesPerSecond: 0 };

  try {
    console.log('Connecting SDK clients...\n');
    const client1 = new Client('ws://localhost:12567');
    const client2 = new Client('ws://localhost:12567');
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');
    console.log('✓ Both clients joined', room1.roomId);

    const ws1 = rawSocket(room1);
    const ws2 = rawSocket(room2);
    if (!ws1 || !ws2) {
      throw new Error('Failed to access WebSocket connections');
    }

    const startTime = Date.now();
    let lastSecondMark = startTime;
    let bytesThisSecond1 = 0;
    let bytesThisSecond2 = 0;

    hookBytes(ws1, (n) => {
      stats1.totalBytes += n;
      bytesThisSecond1 += n;
    });
    hookBytes(ws2, (n) => {
      stats2.totalBytes += n;
      bytesThisSecond2 += n;
    });

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

    const directions = [Direction.RIGHT, Direction.DOWN, Direction.LEFT, Direction.UP];
    let currentDirection = 0;
    const inputInterval = setInterval(() => {
      room1.send('input', { direction: directions[currentDirection] });
      room2.send('input', { direction: directions[(currentDirection + 2) % 4] });
      currentDirection = (currentDirection + 1) % 4;
    }, 50);

    console.log(`Running match for up to ${durationSec} seconds...\n`);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), durationSec * 1000);
      const check = () => {
        if ((room1.state as { result?: unknown }).result) {
          clearTimeout(timeout);
          resolve();
        }
      };
      room1.onStateChange(check);
    });

    clearInterval(inputInterval);
    clearInterval(bandwidthInterval);

    if (bytesThisSecond1 > 0) {
      stats1.bytesPerSecond.push(bytesThisSecond1);
      stats1.peakBytesPerSecond = Math.max(stats1.peakBytesPerSecond, bytesThisSecond1);
    }
    if (bytesThisSecond2 > 0) {
      stats2.bytesPerSecond.push(bytesThisSecond2);
      stats2.peakBytesPerSecond = Math.max(stats2.peakBytesPerSecond, bytesThisSecond2);
    }

    const duration = (Date.now() - startTime) / 1000;
    stats1.averageBytesPerSecond = Math.round(stats1.totalBytes / duration);
    stats2.averageBytesPerSecond = Math.round(stats2.totalBytes / duration);

    const p95 = (values: number[]): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    };
    stats1.p95BytesPerSecond = p95(stats1.bytesPerSecond);
    stats2.p95BytesPerSecond = p95(stats2.bytesPerSecond);

    if (stats1.totalBytes === 0 || stats2.totalBytes === 0) {
      throw new Error(`Bandwidth printed 0: P1=${stats1.totalBytes} P2=${stats2.totalBytes}`);
    }

    console.log('✓ Match completed\n');
    console.log('=== Real WebSocket Bandwidth Report ===\n');
    console.log(`Match duration: ${duration.toFixed(1)}s\n`);

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
    console.log('Per-Player Summary:');
    console.log(`  Average: ${avgPerPlayer.toLocaleString()} bytes/sec (~${(avgPerPlayer / 1024).toFixed(2)} KB/s)\n`);
    console.log('Note: Real bytes measured from WebSocket message events via the Colyseus SDK.');
    console.log();

    await Promise.race([room1.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    await Promise.race([room2.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
  } catch (error) {
    console.error('Error during bandwidth measurement:', error);
    await Promise.race([
      server.gracefullyShutdown().catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    process.exit(1);
  }
  await Promise.race([
    server.gracefullyShutdown().catch(() => undefined),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  process.exit(0);
}

measureBandwidth().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
