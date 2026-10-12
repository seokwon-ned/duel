import { describe, expect, test } from 'vitest';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { Direction, GRID_HEIGHT, GRID_WIDTH, createInitialState, flattenGrid } from '@turf-duel/engine';
import { TurfDuelTestRoom, testRooms } from './rooms/TurfDuelTestRoom.js';

class Patch100Room extends TurfDuelTestRoom {
  onCreate(options: any) {
    super.onCreate(options);
    this.patchRate = 100;
  }
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

function gridDiff(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

describe('100ms patch interval keeps a lossless grid', () => {
  test('client grid matches authority after two ticks per patch', async () => {
    const port = 12574;
    const server = new Server({ transport: new WebSocketTransport({}) });
    server.define('turf_duel', Patch100Room);
    await server.listen(port);

    const client1 = new Client(`ws://localhost:${port}`);
    const client2 = new Client(`ws://localhost:${port}`);
    try {
      const room1 = await client1.joinOrCreate('turf_duel');
      const room2 = await client2.joinOrCreate('turf_duel');
      const grid1 = trackClientGrid(room1);
      const grid2 = trackClientGrid(room2);

      await new Promise((r) => setTimeout(r, 150));

      const dirs = [Direction.RIGHT, Direction.UP, Direction.LEFT, Direction.DOWN];
      let i = 0;
      const inputs = setInterval(() => {
        room1.send('input', { direction: dirs[i % 4] });
        room2.send('input', { direction: dirs[(i + 1) % 4] });
        i++;
      }, 50);

      await new Promise((r) => setTimeout(r, 2500));
      clearInterval(inputs);
      await new Promise((r) => setTimeout(r, 250));

      const authority = testRooms.get(room1.roomId)?.getAuthorityState();
      expect(authority).toBeTruthy();
      const authFlat = flattenGrid(authority!.grid);
      expect(authFlat.length).toBe(GRID_WIDTH * GRID_HEIGHT);
      expect(gridDiff(grid1, authFlat)).toBe(0);
      expect(gridDiff(grid2, authFlat)).toBe(0);
      expect(gridDiff(grid1, grid2)).toBe(0);

      await Promise.race([room1.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
      await Promise.race([room2.leave().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    } finally {
      await Promise.race([
        server.gracefullyShutdown(false).catch(() => undefined),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
  }, 20000);
});
