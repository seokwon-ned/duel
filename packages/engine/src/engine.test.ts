import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createInitialState, fingerprint, replayInputLog, step } from './engine.js';
import { CellType, Direction, HURT_IFRAME_TICKS, PlayerInput, ResultReason } from './types.js';
import { claimClosedTrail, countCells } from './cover.js';
import { cellOf, toFp } from './lut.js';

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

  test('straight sub-cell movement continues through the last trail cell', () => {
    let state = createInitialState({ width: 16, height: 16, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(15);
    state.sparx2.yFp = toFp(0);
    const startY = state.player1.position.y;
    const startFp = state.player1.yFp;
    state = run(state, [{ player: 1, heading: 192, thrusting: true }], 8);
    expect(state.player1.drawing).toBe(true);
    expect(startFp - state.player1.yFp).toBe(192 * 8);
    expect(startY - state.player1.position.y).toBeGreaterThanOrEqual(5);
    expect(state.player1.trail.length).toBeGreaterThanOrEqual(5);
  });

  test('a straight line of N cells keeps moving and finishes still drawing', () => {
    const N = 20;
    let state = createInitialState({ width: 48, height: 48, matchTicks: 2000 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(47);
    state.sparx2.yFp = toFp(0);
    const startY = state.player1.position.y;
    const ticks = Math.ceil((N * 256) / 192) + 2;
    state = run(state, [{ player: 1, heading: 192, thrusting: true }], ticks);
    expect(state.player1.hearts).toBe(99);
    expect(state.player1.drawing).toBe(true);
    expect(state.player1.trail.length).toBeGreaterThanOrEqual(N);
    expect(startY - state.player1.position.y).toBeGreaterThanOrEqual(N);
    expect(state.player1.trail.length).toBe(new Set(state.player1.trail.map((p) => `${p.x},${p.y}`)).size);
  });

  test('a long curve keeps moving and finishes still drawing', () => {
    let state = createInitialState({ width: 64, height: 64, matchTicks: 4000 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(2);
    state.boss.yFp = toFp(2);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(63);
    state.sparx2.yFp = toFp(0);
    // Wave up through the interior: up, up-right, up, up-left, up.
    const script: Array<{ heading: number; ticks: number }> = [
      { heading: 192, ticks: 16 },
      { heading: 224, ticks: 14 },
      { heading: 192, ticks: 16 },
      { heading: 160, ticks: 14 },
      { heading: 192, ticks: 16 },
    ];
    for (const seg of script) {
      state = run(state, [{ player: 1, heading: seg.heading, thrusting: true }], seg.ticks);
    }
    expect(state.player1.hearts).toBe(99);
    expect(state.player1.drawing).toBe(true);
    expect(state.player1.trail.length).toBeGreaterThanOrEqual(24);
    const xs = new Set(state.player1.trail.map((p) => p.x));
    const ys = new Set(state.player1.trail.map((p) => p.y));
    expect(xs.size).toBeGreaterThan(3);
    expect(ys.size).toBeGreaterThan(3);
  });

  test('returning to the edge claims the side without the boss', () => {
    let state = createInitialState({ width: 16, height: 16, matchTicks: 500 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(15);
    state.sparx2.yFp = toFp(0);
    const startY = state.gridHeight - 1;
    const x = state.gridWidth >> 1;

    state = run(state, [{ player: 1, heading: 192, thrusting: true }], 8);
    expect(state.player1.drawing).toBe(true);

    state = run(state, [{ player: 1, heading: 128, thrusting: true }], 6);
    state = run(state, [{ player: 1, heading: 64, thrusting: true }], 12);

    expect(state.player1.drawing).toBe(false);
    expect(state.player1.territoryCells).toBeGreaterThan(0);
    expect(state.grid[cellOf(state.boss.yFp)][cellOf(state.boss.xFp)]).toBe(CellType.COVER);
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
    expect(state.player2.trail.some((p) => p.x === target.x && p.y === target.y)).toBe(true);
  });

  test('stepping on an invincible opponent line passes over without overwriting', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.boss.xFp = (1 << 8) + 128;
    state.boss.yFp = (1 << 8) + 128;
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(19);
    state = run(state, [{ player: 1, heading: 192, thrusting: true }], 6);
    expect(state.player1.drawing).toBe(true);
    expect(state.player1.trail.length).toBeGreaterThan(0);

    const target = state.player1.trail[Math.floor(state.player1.trail.length / 2)];
    state.player1.lastHurtTick = state.tick;
    state.player1.thrusting = false;
    const beforeHearts = state.player1.hearts;
    const beforeTrailLen = state.player1.trail.length;

    state.player2.xFp = ((target.x - 1) << 8) + 128;
    state.player2.yFp = (target.y << 8) + 128;
    state.player2.drawing = false;
    state.player2.trail = [];
    state.player2.heading = 0;
    state.player2.thrusting = true;

    state = step(state, [{ player: 2, heading: 0, thrusting: true }]).state;
    expect(state.player1.hearts).toBe(beforeHearts);
    expect(state.player1.drawing).toBe(true);
    expect(state.player1.trail.length).toBe(beforeTrailLen);
    expect(state.grid[target.y][target.x]).toBe(CellType.PLAYER1_TRAIL);
    expect(state.player2.trail.some((p) => p.x === target.x && p.y === target.y)).toBe(false);
    expect(cellOf(state.player2.xFp)).toBe(target.x);
    expect(cellOf(state.player2.yFp)).toBe(target.y);
  });

  test('erasing an invincible foe line after pass-over does not hole a closing trail', () => {
    const driveBox = (withFoeLine: boolean) => {
      let state = createInitialState({ width: 20, height: 20, matchTicks: 2000 });
      state.player1.hearts = 99;
      state.player2.hearts = 99;
      state.boss.xFp = toFp(1);
      state.boss.yFp = toFp(1);
      state.sparx1.xFp = toFp(0);
      state.sparx1.yFp = toFp(0);
      state.sparx2.xFp = toFp(19);
      state.sparx2.yFp = toFp(0);
      state.player1.xFp = toFp(5);
      state.player1.yFp = toFp(19);
      state.player1.position = { x: 5, y: 19 };

      const walkUntil = (heading: number, done: () => boolean, max = 80) => {
        for (let i = 0; i < max && !done() && !state.result; i++) {
          state = step(state, [{ player: 1, heading, thrusting: true }]).state;
        }
      };
      walkUntil(192, () => cellOf(state.player1.yFp) <= 10);
      const topY = cellOf(state.player1.yFp);
      if (withFoeLine) {
        const crossX = 9;
        state.grid[topY][crossX] = CellType.PLAYER2_TRAIL;
        state.player2.trail = [{ x: crossX, y: topY }];
        state.player2.drawing = true;
        state.player2.lastHurtTick = state.tick;
        state.player2.xFp = toFp(crossX);
        state.player2.yFp = toFp(topY);
      }
      walkUntil(0, () => cellOf(state.player1.xFp) >= 13);
      if (withFoeLine) {
        for (const p of state.player2.trail) {
          if (state.grid[p.y][p.x] === CellType.PLAYER2_TRAIL) {
            state.grid[p.y][p.x] = CellType.COVER;
          }
        }
        state.player2.trail = [];
        state.player2.drawing = false;
      }
      walkUntil(64, () => !state.player1.drawing || cellOf(state.player1.yFp) >= 19);
      return state.player1.territoryCells;
    };

    const clean = driveBox(false);
    const crossed = driveBox(true);
    expect(clean).toBeGreaterThanOrEqual(56);
    expect(crossed).toBe(clean);
  });

  test('stepping onto an invincible foe line from territory does not trap the cutter', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(0);

    const from = state.player1.position;
    const onto = { x: from.x, y: from.y - 1 };
    state.grid[onto.y][onto.x] = CellType.PLAYER2_TRAIL;
    state.player2.trail = [onto];
    state.player2.drawing = true;
    state.player2.lastHurtTick = 0;
    state.player2.xFp = toFp(onto.x);
    state.player2.yFp = toFp(onto.y);

    state = run(state, [{ player: 1, heading: 192, thrusting: true }], 11);
    expect(cellOf(state.player1.yFp)).toBeLessThan(onto.y);
    expect(state.player1.drawing).toBe(true);
    expect(state.player1.trail.some((p) => p.x === onto.x && p.y === onto.y)).toBe(true);
  });

  test('closing across an invincible foe line severs it without taking a heart', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 2000 });
    state.player1.hearts = 99;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(0);
    state.player1.xFp = toFp(5);
    state.player1.yFp = toFp(19);
    state.player1.position = { x: 5, y: 19 };

    const walkUntil = (heading: number, done: () => boolean, max = 80) => {
      for (let i = 0; i < max && !done() && !state.result; i++) {
        state = step(state, [{ player: 1, heading, thrusting: true }]).state;
      }
    };
    walkUntil(192, () => cellOf(state.player1.yFp) <= 10);
    const topY = cellOf(state.player1.yFp);
    const crossX = 9;
    state.grid[topY][crossX] = CellType.PLAYER2_TRAIL;
    state.player2.trail = [{ x: crossX, y: topY }, { x: crossX, y: topY + 1 }];
    state.grid[topY + 1][crossX] = CellType.PLAYER2_TRAIL;
    state.player2.drawing = true;
    state.player2.lastHurtTick = state.tick;
    state.player2.xFp = toFp(crossX);
    state.player2.yFp = toFp(topY + 1);

    walkUntil(0, () => cellOf(state.player1.xFp) >= 13);
    walkUntil(64, () => !state.player1.drawing || cellOf(state.player1.yFp) >= 19);

    expect(state.player1.drawing).toBe(false);
    expect(state.player1.territoryCells).toBeGreaterThan(0);
    expect(state.player2.hearts).toBe(3);
    expect(state.player2.drawing).toBe(false);
    expect(state.player2.trail.length).toBe(0);
    expect(state.grid[topY][crossX]).not.toBe(CellType.PLAYER2_TRAIL);
    expect(cellOf(state.player2.xFp)).toBe(state.player2.spawnX);
    expect(cellOf(state.player2.yFp)).toBe(state.player2.spawnY);
  });

  test('invincible foe returned to spawn after sever can still move (qa/sever)', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 2000 });
    state.player1.hearts = 99;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(0);
    state.player1.xFp = toFp(5);
    state.player1.yFp = toFp(19);
    state.player1.position = { x: 5, y: 19 };

    const walkUntil = (heading: number, done: () => boolean, max = 80) => {
      for (let i = 0; i < max && !done() && !state.result; i++) {
        state = step(state, [{ player: 1, heading, thrusting: true }]).state;
      }
    };
    walkUntil(192, () => cellOf(state.player1.yFp) <= 10);
    const topY = cellOf(state.player1.yFp);
    const crossX = 9;
    state.grid[topY][crossX] = CellType.PLAYER2_TRAIL;
    state.player2.trail = [{ x: crossX, y: topY }, { x: crossX, y: topY + 1 }];
    state.grid[topY + 1][crossX] = CellType.PLAYER2_TRAIL;
    state.player2.drawing = true;
    state.player2.lastHurtTick = state.tick;
    state.player2.xFp = toFp(crossX);
    state.player2.yFp = toFp(topY + 1);
    state.player2.spawnX = 10;
    state.player2.spawnY = 1;

    walkUntil(0, () => cellOf(state.player1.xFp) >= 13);
    walkUntil(64, () => !state.player1.drawing || cellOf(state.player1.yFp) >= 19);

    expect(state.player2.hearts).toBe(3);
    expect(state.player2.drawing).toBe(false);
    expect(cellOf(state.player2.xFp)).toBe(10);
    expect(cellOf(state.player2.yFp)).toBe(1);
    const x0 = state.player2.xFp;
    const y0 = state.player2.yFp;
    state = run(state, [{ player: 2, heading: 0, thrusting: true }], 8);
    expect(state.player2.xFp !== x0 || state.player2.yFp !== y0).toBe(true);
    expect(state.player2.hearts).toBe(3);
    expect(state.player2.isAlive).toBe(true);
    expect(cellOf(state.player2.yFp)).toBe(1);
  });

  test('invincible sever does not refresh lastHurtTick (keeps original iframe)', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 2000 });
    state.player1.hearts = 99;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(0);
    state.player1.xFp = toFp(5);
    state.player1.yFp = toFp(19);
    state.player1.position = { x: 5, y: 19 };

    const walkUntil = (heading: number, done: () => boolean, max = 80) => {
      for (let i = 0; i < max && !done() && !state.result; i++) {
        state = step(state, [{ player: 1, heading, thrusting: true }]).state;
      }
    };
    walkUntil(192, () => cellOf(state.player1.yFp) <= 10);
    const hurtAt = state.tick;
    const topY = cellOf(state.player1.yFp);
    const crossX = 9;
    state.grid[topY][crossX] = CellType.PLAYER2_TRAIL;
    state.player2.trail = [{ x: crossX, y: topY }, { x: crossX, y: topY + 1 }];
    state.grid[topY + 1][crossX] = CellType.PLAYER2_TRAIL;
    state.player2.drawing = true;
    state.player2.lastHurtTick = hurtAt;
    state.player2.xFp = toFp(crossX);
    state.player2.yFp = toFp(topY + 1);
    state.player2.spawnX = 10;
    state.player2.spawnY = 1;

    walkUntil(0, () => cellOf(state.player1.xFp) >= 13);
    walkUntil(64, () => !state.player1.drawing || cellOf(state.player1.yFp) >= 19);

    expect(state.player1.drawing).toBe(false);
    expect(state.player2.hearts).toBe(3);
    expect(state.player2.lastHurtTick).toBe(hurtAt);
    expect(state.tick).toBeGreaterThan(hurtAt);
    const remain = HURT_IFRAME_TICKS - (state.tick - hurtAt);
    expect(remain).toBeLessThan(HURT_IFRAME_TICKS);
    state.player2.xFp = toFp(10);
    state.player2.yFp = toFp(0);
    state.player2.position = { x: 10, y: 0 };
    state.sparx1.xFp = toFp(9);
    state.sparx1.yFp = toFp(0);
    state.sparx1.edgeDir = 0;
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(19);
    if (remain > 0) {
      state = run(state, [], remain);
      expect(state.player2.hearts).toBe(3);
    }
    state.player2.xFp = toFp(10);
    state.player2.yFp = toFp(0);
    state.player2.position = { x: 10, y: 0 };
    state.sparx1.xFp = toFp(9);
    state.sparx1.yFp = toFp(0);
    state.sparx1.edgeDir = 0;
    state = step(state, []).state;
    expect(state.player2.hearts).toBe(2);
  });

  test('same-tick sever does not start a new foe line mid-cover (qa/sever2)', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.player1.hearts = 3;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(0);

    state.player1.drawing = true;
    state.player1.heading = 192;
    state.player1.thrusting = true;
    state.player1.xFp = toFp(5);
    state.player1.yFp = toFp(1);
    state.player1.position = { x: 5, y: 1 };
    state.player1.trail = [
      { x: 5, y: 18 },
      { x: 5, y: 10 },
      { x: 10, y: 10 },
    ];
    for (const p of state.player1.trail) {
      state.grid[p.y][p.x] = CellType.PLAYER1_TRAIL;
    }

    state.player2.drawing = true;
    state.player2.heading = 192;
    state.player2.thrusting = true;
    state.player2.xFp = toFp(10);
    state.player2.yFp = toFp(10);
    state.player2.position = { x: 10, y: 10 };
    state.player2.spawnX = 10;
    state.player2.spawnY = 1;
    state.player2.trail = [
      { x: 10, y: 16 },
      { x: 10, y: 13 },
      { x: 10, y: 10 },
    ];
    for (const p of state.player2.trail) {
      state.grid[p.y][p.x] = CellType.PLAYER2_TRAIL;
    }
    // Closer’s polyline still records the crossed foe cell.
    state.player1.trail.push({ x: 10, y: 10 });

    const destY = cellOf(state.player2.yFp - 192);
    state = step(state, [
      { player: 1, heading: 192, thrusting: true },
      { player: 2, heading: 192, thrusting: true },
    ]).state;

    expect(state.player1.drawing).toBe(false);
    expect(state.player1.territoryCells).toBeGreaterThan(0);
    expect(state.player1.hearts).toBe(3);
    expect(state.player2.hearts).toBe(2);
    expect(state.player2.lastHurtTick).toBe(state.tick - 1);
    expect(state.player2.drawing).toBe(false);
    expect(state.player2.trail.length).toBe(0);
    expect(cellOf(state.player2.xFp)).toBe(10);
    expect(cellOf(state.player2.yFp)).toBe(1);
    expect(state.grid[destY][10]).not.toBe(CellType.PLAYER2_TRAIL);
    expect(state.grid[destY][10]).not.toBe(CellType.PLAYER1_TRAIL);
  });

  test('solo close severs an invincible thrusting foe (apply-all then flush)', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.player1.hearts = 3;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(0);

    state.player1.drawing = true;
    state.player1.xFp = toFp(5);
    state.player1.yFp = toFp(1);
    state.player1.position = { x: 5, y: 1 };
    state.player1.trail = [
      { x: 5, y: 18 },
      { x: 5, y: 10 },
      { x: 10, y: 10 },
    ];
    for (const p of state.player1.trail) state.grid[p.y][p.x] = CellType.PLAYER1_TRAIL;

    const hurtAt = 4;
    state.player2.drawing = true;
    state.player2.lastHurtTick = hurtAt;
    state.player2.xFp = toFp(10);
    state.player2.yFp = toFp(10);
    state.player2.position = { x: 10, y: 10 };
    state.player2.spawnX = 10;
    state.player2.spawnY = 1;
    state.player2.trail = [
      { x: 10, y: 16 },
      { x: 10, y: 13 },
      { x: 10, y: 10 },
    ];
    for (const p of state.player2.trail) state.grid[p.y][p.x] = CellType.PLAYER2_TRAIL;
    state.player1.trail.push({ x: 10, y: 10 });

    const destY = cellOf(state.player2.yFp - 192);
    state = step(state, [
      { player: 1, heading: 192, thrusting: true },
      { player: 2, heading: 192, thrusting: true },
    ]).state;

    expect(state.player1.drawing).toBe(false);
    expect(state.player1.territoryCells).toBeGreaterThan(0);
    expect(state.player2.hearts).toBe(3);
    expect(state.player2.lastHurtTick).toBe(hurtAt);
    expect(state.player2.drawing).toBe(false);
    expect(cellOf(state.player2.xFp)).toBe(10);
    expect(cellOf(state.player2.yFp)).toBe(1);
    expect(state.grid[destY][10]).not.toBe(CellType.PLAYER2_TRAIL);
  });

  test('same-tick double close both claim without P1-only sever bias (qa/sever2)', () => {
    const runPair = (swap: boolean) => {
      let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
      state.player1.hearts = 99;
      state.player2.hearts = 99;
      state.boss.xFp = toFp(1);
      state.boss.yFp = toFp(1);
      state.sparx1.xFp = toFp(0);
      state.sparx1.yFp = toFp(0);
      state.sparx2.xFp = toFp(19);
      state.sparx2.yFp = toFp(0);

      const a = swap ? 2 : 1;
      const b = swap ? 1 : 2;
      const pa = a === 1 ? state.player1 : state.player2;
      const pb = b === 1 ? state.player1 : state.player2;
      const trailA = a === 1 ? CellType.PLAYER1_TRAIL : CellType.PLAYER2_TRAIL;
      const trailB = b === 1 ? CellType.PLAYER1_TRAIL : CellType.PLAYER2_TRAIL;

      pa.drawing = true;
      pa.heading = 192;
      pa.thrusting = true;
      pa.xFp = toFp(5);
      pa.yFp = toFp(1);
      pa.position = { x: 5, y: 1 };
      pa.trail = [
        { x: 5, y: 18 },
        { x: 5, y: 8 },
        { x: 8, y: 8 },
      ];
      for (const p of pa.trail) state.grid[p.y][p.x] = trailA;

      pb.drawing = true;
      pb.heading = 64;
      pb.thrusting = true;
      pb.xFp = toFp(14);
      pb.yFp = toFp(18);
      pb.position = { x: 14, y: 18 };
      pb.trail = [
        { x: 14, y: 1 },
        { x: 14, y: 8 },
        { x: 8, y: 8 },
      ];
      for (const p of pb.trail) state.grid[p.y][p.x] = trailB;
      pa.trail.push({ x: 8, y: 8 });

      return step(state, [
        { player: 1, heading: swap ? 64 : 192, thrusting: true },
        { player: 2, heading: swap ? 192 : 64, thrusting: true },
      ]).state;
    };

    const normal = runPair(false);
    const swapped = runPair(true);
    expect(normal.player1.drawing).toBe(false);
    expect(normal.player2.drawing).toBe(false);
    expect(normal.player1.territoryCells).toBeGreaterThan(0);
    expect(normal.player2.territoryCells).toBeGreaterThan(0);
    expect(normal.player1.hearts).toBe(99);
    expect(normal.player2.hearts).toBe(99);
    expect(swapped.player1.territoryCells).toBeGreaterThan(0);
    expect(swapped.player2.territoryCells).toBeGreaterThan(0);
    expect(swapped.player1.hearts).toBe(99);
    expect(swapped.player2.hearts).toBe(99);
    expect(normal.player1.territoryCells).toBe(swapped.player2.territoryCells);
    expect(normal.player2.territoryCells).toBe(swapped.player1.territoryCells);
  });

  test('simultaneous line steps hurt both and steal the crossed cells', () => {
    const make = () => {
      const state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
      state.player1.hearts = 3;
      state.player2.hearts = 3;
      state.boss.xFp = toFp(1);
      state.boss.yFp = toFp(1);
      state.sparx1.xFp = toFp(0);
      state.sparx1.yFp = toFp(0);
      state.sparx2.xFp = toFp(19);
      state.sparx2.yFp = toFp(0);
      state.player1.drawing = true;
      state.player2.drawing = true;
      state.grid[5][8] = CellType.PLAYER1_TRAIL;
      state.player1.trail = [{ x: 8, y: 5 }];
      state.grid[9][8] = CellType.PLAYER2_TRAIL;
      state.player2.trail = [{ x: 8, y: 9 }];
      state.player2.xFp = (7 << 8) + 128;
      state.player2.yFp = (5 << 8) + 128;
      state.player2.heading = 0;
      state.player2.thrusting = true;
      state.player1.xFp = (7 << 8) + 128;
      state.player1.yFp = (9 << 8) + 128;
      state.player1.heading = 0;
      state.player1.thrusting = true;
      return state;
    };
    const done = step(make(), [
      { player: 1, heading: 0, thrusting: true },
      { player: 2, heading: 0, thrusting: true },
    ]).state;
    expect(done.player1.hearts).toBe(2);
    expect(done.player2.hearts).toBe(2);
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

  test('closing while the boss is on the line hurts and does not take the board', () => {
    let state = createInitialState({ width: 16, height: 16, matchTicks: 400 });
    state.player1.hearts = 3;
    state.player2.hearts = 99;
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(15);
    state.sparx2.yFp = toFp(0);
    state.boss.xFp = toFp(8);
    state.boss.yFp = toFp(8);
    state.player1.drawing = true;
    state.player1.thrusting = true;
    state.player1.heading = 0;
    state.player1.xFp = toFp(8);
    state.player1.yFp = toFp(15);
    state.player1.trail = [];
    for (let y = 14; y >= 8; y--) {
      state.grid[y][8] = CellType.PLAYER1_TRAIL;
      state.player1.trail.push({ x: 8, y });
    }
    const coverBefore = state.grid.flat().filter((c) => c === CellType.COVER).length;
    state = step(state, [{ player: 1, heading: 0, thrusting: true }]).state;
    expect(state.player1.hearts).toBe(2);
    expect(state.player1.drawing).toBe(false);
    const coverAfter = state.grid.flat().filter((c) => c === CellType.COVER).length;
    expect(coverAfter).toBeGreaterThan(coverBefore - 20);
    expect(state.player1.bonusCells).toBe(0);
  });

  test('boss moving onto a trail costs the drawer a heart', () => {
    const state = createInitialState({ width: 16, height: 16, matchTicks: 400 });
    state.player1.hearts = 3;
    state.player2.hearts = 99;
    state.player1.drawing = true;
    state.grid[8][8] = CellType.PLAYER1_TRAIL;
    state.player1.trail = [{ x: 8, y: 8 }];
    state.boss.xFp = (8 << 8) - 40;
    state.boss.yFp = toFp(8);
    state.boss.heading = 0;
    const next = step(state, []).state;
    expect(next.player1.hearts).toBeLessThan(3);
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

  test('closing a cut that traps the boss emits trap_bonus with +N%', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 2000 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(12);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(23);
    state.sparx2.yFp = toFp(0);
    state.player1.xFp = toFp(2);
    state.player1.yFp = toFp(23);
    state.player1.position = { x: 2, y: 23 };
    let bonus: { type: string; data?: { percent?: number; cells?: number } } | undefined;
    for (let i = 0; i < 50; i++) {
      const result = step(state, [{ player: 1, heading: 192, thrusting: true }]);
      state = result.state;
      bonus = result.events.find((e) => e.type === 'trap_bonus') ?? bonus;
      if (!state.player1.drawing && i > 3) break;
    }
    expect(bonus).toBeDefined();
    expect(bonus?.data?.percent).toBe(5);
    expect(bonus?.data?.cells).toBe(Math.floor((24 * 24 * 5) / 100));
    expect(state.player1.bonusCells).toBeGreaterThan(0);
  });

  test('trap bonus cannot push territory past 100%', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 500 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    const total = 24 * 24;
    for (let y = 1; y < 23; y++) {
      for (let x = 1; x < 23; x++) {
        if ((x === 10 && y === 22) || (x === 1 && y === 1)) continue;
        state.grid[y][x] = CellType.PLAYER1_OPEN;
      }
    }
    state.grid[22][10] = CellType.PLAYER1_TRAIL;
    state.player1.drawing = true;
    state.player1.trail = [{ x: 10, y: 22 }];
    state.player1.xFp = toFp(10);
    state.player1.yFp = (22 << 8) + 200;
    state.player1.position = { x: 10, y: 22 };
    state.sparx2.xFp = toFp(10);
    state.sparx2.yFp = toFp(23);
    state.player1.bonusCells = total - 8;
    const result = step(state, [{ player: 1, heading: 64, thrusting: true }]);
    const painted = countCells(result.state.grid, CellType.PLAYER1_OPEN);
    expect(result.events.some((e) => e.type === 'claim')).toBe(true);
    expect(result.state.player1.territoryCells).toBeLessThanOrEqual(total);
    expect(result.state.player1.bonusCells).toBeLessThanOrEqual(total);
    expect(painted + result.state.player1.bonusCells).toBeLessThanOrEqual(total);
    expect(result.state.player1.territoryCells).toBe(painted + result.state.player1.bonusCells);
    expect(result.state.player1.territoryCells).toBe(total);
  });

  test('boxing a Sparx against the wall emits trap_bonus', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 500 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(1);
    state.boss.yFp = toFp(1);
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.grid[22][10] = CellType.PLAYER1_TRAIL;
    state.player1.drawing = true;
    state.player1.trail = [{ x: 10, y: 22 }];
    state.player1.xFp = toFp(10);
    state.player1.yFp = (22 << 8) + 200;
    state.player1.position = { x: 10, y: 22 };
    state.sparx2.xFp = toFp(10);
    state.sparx2.yFp = toFp(23);
    const result = step(state, [{ player: 1, heading: 64, thrusting: true }]);
    const bonus = result.events.find((e) => e.type === 'trap_bonus');
    expect(result.events.some((e) => e.type === 'claim')).toBe(true);
    expect(bonus).toBeDefined();
    expect(bonus?.data?.percent).toBe(5);
    expect(result.state.player1.bonusCells).toBeGreaterThan(0);
  });

  test('claim seeds from boss neighbors so a line cell does not swallow the board', () => {
    const state = createInitialState({ width: 12, height: 12, matchTicks: 200 });
    const trail: { x: number; y: number }[] = [];
    for (let y = 2; y <= 9; y++) {
      state.grid[y][3] = CellType.PLAYER1_TRAIL;
      trail.push({ x: 3, y });
    }
    state.grid[5][5] = CellType.COVER;
    const { claimed, remainingCover } = claimClosedTrail(state.grid, trail, 1, { x: 3, y: 5 });
    expect(remainingCover).toBeGreaterThan(0);
    expect(claimed).toBeLessThan(10 * 10);
  });

  test('sparx stay on the outer board edge, not opened territory boundaries', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    for (let y = 4; y <= 8; y++) {
      for (let x = 4; x <= 8; x++) {
        state.grid[y][x] = CellType.PLAYER1_OPEN;
      }
    }
    for (let i = 0; i < 60; i++) {
      state = step(state, []).state;
      for (const s of [state.sparx1, state.sparx2]) {
        const x = cellOf(s.xFp);
        const y = cellOf(s.yFp);
        expect(x === 0 || y === 0 || x === 19 || y === 19).toBe(true);
        expect(x >= 4 && x <= 8 && y >= 4 && y <= 8).toBe(false);
      }
    }
  });

  test('idle spawn is off the outer rim and Sparx do not drain hearts while standing still', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 400 });
    expect(state.player1.position.y).toBe(22);
    expect(state.player2.position.y).toBe(1);
    expect(state.player1.position.y - state.player2.position.y).toBe(21);
    const start1 = state.player1.hearts;
    const start2 = state.player2.hearts;
    state = run(state, [], 40);
    expect(state.player1.hearts).toBe(start1);
    expect(state.player2.hearts).toBe(start2);
  });

  test('idling at the start position for 30s keeps all hearts', () => {
    // 20Hz × 30s = 600 ticks. Full 200×300 board, both Sparx looping the rim.
    let state = createInitialState({ matchTicks: 800 });
    expect(state.player1.position.y).toBe(state.gridHeight - 2);
    expect(state.player1.position.y === 0 || state.player1.position.y === state.gridHeight - 1).toBe(false);
    expect(state.player1.position.x === 0 || state.player1.position.x === state.gridWidth - 1).toBe(false);
    const start1 = state.player1.hearts;
    const start2 = state.player2.hearts;
    state = run(state, [], 600);
    expect(state.tick).toBe(600);
    expect(state.player1.hearts).toBe(start1);
    expect(state.player2.hearts).toBe(start2);
    expect(state.player1.isAlive).toBe(true);
    expect(state.player2.isAlive).toBe(true);
    expect(state.result).toBeNull();
    for (const s of [state.sparx1, state.sparx2]) {
      const x = cellOf(s.xFp);
      const y = cellOf(s.yFp);
      expect(x === 0 || y === 0 || x === state.gridWidth - 1 || y === state.gridHeight - 1).toBe(true);
    }
  });

  test('after a hit the player is invincible for 1.5 seconds then can be hit again', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(12);
    state.boss.yFp = toFp(12);
    state.sparx2.xFp = toFp(23);
    state.sparx2.yFp = toFp(23);
    const x = 10;
    const parkSparxHit = () => {
      state.player2.xFp = toFp(x);
      state.player2.yFp = toFp(0);
      state.player2.position = { x, y: 0 };
      state.sparx1.xFp = toFp(x - 1);
      state.sparx1.yFp = toFp(0);
      state.sparx1.edgeDir = 0;
      state.sparx2.xFp = toFp(23);
      state.sparx2.yFp = toFp(23);
      state.boss.xFp = toFp(12);
      state.boss.yFp = toFp(12);
    };
    parkSparxHit();
    state = step(state, []).state;
    expect(state.player2.hearts).toBe(2);
    const hurtAt = state.player2.lastHurtTick;

    parkSparxHit();
    state = step(state, []).state;
    expect(state.player2.hearts).toBe(2);

    state.player2.xFp = toFp(12);
    state.player2.yFp = toFp(1);
    state.player2.position = { x: 12, y: 1 };
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx1.edgeDir = 0;
    const remaining = HURT_IFRAME_TICKS - (state.tick - hurtAt);
    state = run(state, [], Math.max(0, remaining));
    expect(state.tick - state.player2.lastHurtTick).toBeGreaterThanOrEqual(HURT_IFRAME_TICKS);
    expect(state.player2.hearts).toBe(2);

    parkSparxHit();
    state = step(state, []).state;
    expect(state.player2.hearts).toBe(1);
  });

  test('sparx walking the edge hits an idle player even mid-burst', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.boss.xFp = toFp(12);
    state.boss.yFp = toFp(12);
    state.sparx2.xFp = toFp(23);
    state.sparx2.yFp = toFp(23);
    const p2x = 12;
    state.player2.xFp = toFp(p2x);
    state.player2.yFp = toFp(0);
    state.sparx1.xFp = toFp(p2x - 1);
    state.sparx1.yFp = toFp(0);
    state.sparx1.edgeDir = 0;
    const before = state.player2.hearts;
    state = run(state, [], 4);
    expect(state.player2.hearts).toBe(before - 1);
  });

  test('both players at 0 hearts is 양쪽 하트 소진', () => {
    const state = createInitialState({ width: 10, height: 10, matchTicks: 40 });
    state.player1.hearts = 0;
    state.player1.isAlive = false;
    state.player2.hearts = 0;
    state.player2.isAlive = false;
    const next = step(state, []).state;
    expect(next.result?.winner).toBe(0);
    expect(next.result?.reason).toBe(ResultReason.BOTH_HEARTS_OUT);
  });

  test('when both are over 50% the larger area wins', () => {
    const state = createInitialState({ width: 10, height: 10, matchTicks: 40 });
    state.player1.territoryCells = 60;
    state.player2.territoryCells = 70;
    const next = step(state, []).state;
    expect(next.result?.winner).toBe(2);
    expect(next.result?.reason).toBe(ResultReason.FIFTY_PERCENT);
  });

  test('null inputs do not throw', () => {
    const state = createInitialState({ width: 12, height: 12 });
    const before = state.tick;
    const result = step(state, null as unknown as PlayerInput[]);
    expect(result.state.tick).toBe(before + 1);
    const result2 = step(state, [undefined as unknown as PlayerInput]);
    expect(result2.state.tick).toBe(before + 2);
  });

  test('entering the boss cell while drawing costs a heart', () => {
    let state = createInitialState({ width: 20, height: 20, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 99;
    state.sparx1.xFp = toFp(0);
    state.sparx1.yFp = toFp(0);
    state.sparx2.xFp = toFp(19);
    state.sparx2.yFp = toFp(19);
    const bx = 10;
    const by = 10;
    state.boss.xFp = toFp(bx);
    state.boss.yFp = toFp(by);
    state.player1.drawing = true;
    state.player1.trail = [
      { x: bx, y: by + 2 },
      { x: bx, y: by + 1 },
    ];
    state.grid[by + 2][bx] = CellType.PLAYER1_TRAIL;
    state.grid[by + 1][bx] = CellType.PLAYER1_TRAIL;
    state.player1.xFp = (bx << 8) + 128;
    state.player1.yFp = ((by + 1) << 8) + 128;
    state.player1.position = { x: bx, y: by + 1 };
    const before = state.player1.hearts;
    const result = step(state, [{ player: 1, heading: 192, thrusting: true }]);
    expect(result.state.player1.hearts).toBe(before - 1);
    expect(result.state.grid[by][bx]).not.toBe(CellType.PLAYER1_TRAIL);
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

