import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createInitialState, fingerprint, replayInputLog, step } from './engine.js';
import { CellType, Direction, HURT_IFRAME_TICKS, PlayerInput, ResultReason } from './types.js';
import { claimClosedTrail } from './cover.js';
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

  test('after a hit the player is invincible for 1.5 seconds', () => {
    let state = createInitialState({ width: 24, height: 24, matchTicks: 400 });
    state.player1.hearts = 99;
    state.player2.hearts = 3;
    state.boss.xFp = toFp(12);
    state.boss.yFp = toFp(12);
    state.sparx2.xFp = toFp(23);
    state.sparx2.yFp = toFp(23);
    const x = 10;
    state.player2.xFp = toFp(x);
    state.player2.yFp = toFp(0);
    state.sparx1.xFp = toFp(x - 1);
    state.sparx1.yFp = toFp(0);
    state.sparx1.edgeDir = 0;
    state = step(state, []).state;
    expect(state.player2.hearts).toBe(2);
    state = run(state, [], HURT_IFRAME_TICKS - 1);
    expect(state.player2.hearts).toBe(2);
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
    expect(() => step(state, null as unknown as PlayerInput[])).not.toThrow();
    expect(() => step(state, [undefined as unknown as PlayerInput]).state.tick).not.toBeUndefined();
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

