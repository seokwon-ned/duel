import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createInitialState, fingerprint, replayInputLog, step } from './engine.js';
import { CellType, Direction, PlayerInput, ResultReason } from './types.js';
import { claimClosedTrail } from './cover.js';
import { toFp } from './lut.js';

const srcDir = dirname(fileURLToPath(import.meta.url));

function run(state: ReturnType<typeof createInitialState>, inputs: PlayerInput[], ticks = 1) {
  let s = state;
  for (let i = 0; i < ticks; i++) {
    s = step(s, inputs).state;
    if (s.result) break;
  }
  return s;
}

describe('cover engine (Amy ★)', () => {
  test('angle LUT and engine source do not call trig', () => {
    const files = ['engine.ts', 'lut.ts', 'cover.ts', 'utils.ts', 'types.ts'];
    for (const file of files) {
      const src = readFileSync(join(srcDir, file), 'utf8');
      expect(src).not.toMatch(/Math\.(sin|cos|tan|atan|atan2|random)/);
    }
  });

  test('identical input logs produce identical fingerprints', () => {
    const log: PlayerInput[][] = [];
    for (let i = 0; i < 80; i++) {
      log.push([
        { player: 1, heading: 192, thrusting: i < 40 },
        { player: 2, heading: 64, thrusting: i < 40 },
      ]);
    }
    const a = replayInputLog(log, { width: 24, height: 24, matchTicks: 200 });
    const b = replayInputLog(log, { width: 24, height: 24, matchTicks: 200 });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(a.tick).toBe(b.tick);
    expect(a.player1.hearts).toBe(b.player1.hearts);
  });

  test('returning to the edge claims the side without the boss', () => {
    let state = createInitialState({ width: 16, height: 16, matchTicks: 500 });
    const startY = state.gridHeight - 1;
    const x = state.gridWidth >> 1;

    state = run(state, [{ player: 1, heading: 192, thrusting: true }], 8);
    expect(state.player1.drawing).toBe(true);

    state = run(state, [{ player: 1, heading: 128, thrusting: true }], 6);
    state = run(state, [{ player: 1, heading: 64, thrusting: true }], 12);

    expect(state.player1.drawing).toBe(false);
    expect(state.player1.territoryCells).toBeGreaterThan(0);
    const bossCell = state.grid[state.gridHeight >> 1][state.gridWidth >> 1];
    expect(bossCell).toBe(CellType.COVER);
    expect(state.grid[startY][x] === CellType.SAFE_EDGE || state.grid[startY][x] === CellType.PLAYER1_OPEN).toBe(true);
  });

  test('stepping on the opponent line costs them a heart', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.boss.xFp = (1 << 8) + 128;
    state.boss.yFp = (1 << 8) + 128;
    state = run(state, [{ player: 1, heading: 192, thrusting: true }], 6);
    expect(state.player1.drawing).toBe(true);
    expect(state.player1.trail.length).toBeGreaterThan(0);

    const target = state.player1.trail[Math.floor(state.player1.trail.length / 2)];
    state.player2.xFp = ((target.x - 1) << 8) + 128;
    state.player2.yFp = (target.y << 8) + 128;
    state.player2.drawing = false;
    state.player2.heading = 0;
    state.player2.thrusting = true;

    const before = state.player1.hearts;
    state = step(state, [{ player: 2, heading: 0, thrusting: true }]).state;
    expect(state.player1.hearts).toBe(before - 1);
    expect(state.player1.drawing).toBe(false);
  });

  test('first to open 50% wins immediately', () => {
    const state = createInitialState({ width: 10, height: 10, matchTicks: 400 });
    for (let y = 1; y < 9; y++) {
      for (let x = 1; x < 9; x++) {
        state.grid[y][x] = CellType.PLAYER1_OPEN;
      }
    }
    state.player1.territoryCells = 64;
    const next = step(state, []).state;
    expect(next.result?.winner).toBe(1);
    expect(next.result?.reason).toBe(ResultReason.FIFTY_PERCENT);
  });

  test('opponent hearts reaching 0 wins', () => {
    const state = createInitialState({ width: 12, height: 12, matchTicks: 200 });
    state.player1.hearts = 1;
    state.player1.drawing = true;
    state.player1.trail = [{ x: 5, y: 5 }];
    state.grid[5][5] = CellType.PLAYER1_TRAIL;
    state.player2.xFp = (4 << 8) + 128;
    state.player2.yFp = (5 << 8) + 128;
    const done = step(state, [{ player: 2, heading: 0, thrusting: true }]).state;
    expect(done.player1.hearts).toBe(0);
    expect(done.result?.winner).toBe(2);
    expect(done.result?.reason).toBe(ResultReason.HEARTS_OUT);
  });

  test('at time limit the player who opened more wins', () => {
    const state = createInitialState({ width: 12, height: 12, matchTicks: 5 });
    state.player1.territoryCells = 20;
    state.player2.territoryCells = 11;
    const next = run(state, [], 5);
    expect(next.result?.winner).toBe(1);
    expect(next.result?.reason).toBe(ResultReason.TIME_UP_WIN);
  });

  test('stopping mid-line starts a burn after 2 seconds', () => {
    const state = createInitialState({ width: 16, height: 16, matchTicks: 400 });
    state.player1.drawing = true;
    state.player1.thrusting = false;
    state.player1.trail = [
      { x: 8, y: 10 },
      { x: 8, y: 9 },
      { x: 8, y: 8 },
      { x: 8, y: 7 },
    ];
    for (const p of state.player1.trail) {
      state.grid[p.y][p.x] = CellType.PLAYER1_TRAIL;
    }
    state.player1.xFp = (8 << 8) + 128;
    state.player1.yFp = (7 << 8) + 128;
    state.player1.idleTicks = 0;
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = (1 << 8) + 128;
    state.boss.yFp = (1 << 8) + 128;
    state.sparx1.xFp = (0 << 8) + 128;
    state.sparx1.yFp = (0 << 8) + 128;
    state.sparx2.xFp = (15 << 8) + 128;
    state.sparx2.yFp = (0 << 8) + 128;
    const idle = run(state, [{ player: 1, heading: 192, thrusting: false }], 40);
    expect(idle.player1.fuseIndex).toBeGreaterThanOrEqual(0);
    const before = idle.player1.hearts;
    const burned = run(idle, [{ player: 1, heading: 192, thrusting: false }], 8);
    expect(burned.player1.hearts).toBeLessThan(before);
  });

  test('trapping a monster in a small piece grants +5%', () => {
    const state = createInitialState({ width: 20, height: 20, matchTicks: 200 });
    const total = 20 * 20;
    const trail: { x: number; y: number }[] = [];
    for (let y = 1; y < 19; y++) {
      for (let x = 1; x < 19; x++) {
        if (x === 10 && y === 10) continue;
        state.grid[y][x] = CellType.PLAYER1_TRAIL;
        trail.push({ x, y });
      }
    }
    state.grid[10][10] = CellType.COVER;
    const { remainingCover } = claimClosedTrail(state.grid, trail, 1, { x: 10, y: 10 });
    expect(remainingCover).toBe(1);
    expect(remainingCover * 100 < total * 5).toBe(true);
  });

  test('sparx walking the edge hits an idle player even mid-burst', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(12);
    state.boss.yFp = toFp(12);
    state.sparx2.xFp = toFp(23);
    state.sparx2.yFp = toFp(23);
    const p2x = state.player2.position.x;
    state.sparx1.xFp = toFp(p2x - 3);
    state.sparx1.yFp = toFp(0);
    state.sparx1.edgeDir = 0;
    const before = state.player2.hearts;
    state = step(state, []).state;
    expect(state.player2.hearts).toBe(before - 1);
  });

  test('cardinal direction inputs still apply on the same tick', () => {
    let state = createInitialState({ width: 16, height: 16 });
    state = step(state, [
      { player: 1, direction: Direction.DOWN },
      { player: 2, direction: Direction.UP },
    ]).state;
    expect(state.player1.direction).toBe(Direction.DOWN);
    expect(state.player2.direction).toBe(Direction.UP);
  });
});

