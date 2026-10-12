import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Bot } from '@turf-duel/bot';
import { createInitialState, step } from '@turf-duel/engine';

const PORT = 12567;
const SECONDS = Number(process.env.TURF_DUEL_BANDWIDTH_SECONDS) || 8;

function hookBytes(room: { connection?: { transport?: { ws?: { addEventListener?: Function; on?: Function } } } }, onBytes: (n: number) => void) {
  const ws = (room.connection as any)?.transport?.ws || (room as any).connection?.ws;
  if (!ws) return false;
  const handler = (data: any) => {
    const buf = data?.data ?? data;
    const n = Buffer.isBuffer(buf) ? buf.length : buf?.byteLength || buf?.length || 0;
    if (n > 0) onBytes(n);
  };
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('message', handler);
  } else if (typeof ws.on === 'function') {
    ws.on('message', handler);
  }
  return true;
}

async function measureBandwidth(): Promise<void> {
  console.log('🎮 Cover-engine bandwidth (Colyseus SDK frames)\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', TurfDuelRoom);
  await server.listen(PORT);

  const c1 = new Client(`ws://localhost:${PORT}`);
  const c2 = new Client(`ws://localhost:${PORT}`);
  const room1 = await c1.joinOrCreate('turf_duel');
  const room2 = await c2.joinOrCreate('turf_duel');

  let total1 = 0;
  let total2 = 0;
  const perSec1: number[] = [];
  const perSec2: number[] = [];
  let bucket1 = 0;
  let bucket2 = 0;

  const hooked =
    hookBytes(room1 as any, (n) => {
      total1 += n;
      bucket1 += n;
    }) &&
    hookBytes(room2 as any, (n) => {
      total2 += n;
      bucket2 += n;
    });

  if (!hooked) {
    throw new Error('Could not hook WebSocket frames');
  }

  const bot1 = new Bot('normal', 1, 3);
  const bot2 = new Bot('normal', 2, 5);
  let ghost = createInitialState();

  const tick = setInterval(() => {
    const i1 = bot1.getNextMove(ghost);
    const i2 = bot2.getNextMove(ghost);
    ghost = step(ghost, [i1, i2]).state;
    room1.send('input', { heading: i1.heading, thrusting: i1.thrusting });
    room2.send('input', { heading: i2.heading, thrusting: i2.thrusting });
  }, 50);

  const sec = setInterval(() => {
    perSec1.push(bucket1);
    perSec2.push(bucket2);
    bucket1 = 0;
    bucket2 = 0;
  }, 1000);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(tick);
  clearInterval(sec);

  if (total1 === 0 && total2 === 0) {
    throw new Error('Bandwidth totals were 0 — SDK frames were not counted');
  }

  const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const peak = (arr: number[]) => (arr.length ? Math.max(...arr) : 0);

  console.log(`Duration: ${SECONDS}s`);
  console.log(`P1 total ${total1} bytes  avg ${avg(perSec1)} B/s  peak ${peak(perSec1)} B/s`);
  console.log(`P2 total ${total2} bytes  avg ${avg(perSec2)} B/s  peak ${peak(perSec2)} B/s`);
  console.log(`Per-player avg ${Math.round((avg(perSec1) + avg(perSec2)) / 2)} B/s`);

  await room1.leave();
  await room2.leave();
  await server.gracefullyShutdown();
}

measureBandwidth().catch((err) => {
  console.error(err);
  process.exit(1);
});
