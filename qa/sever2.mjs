/**
 * Lee P1 repro: foe hit during sever must not walk to a precomputed mid-cover
 * cell; same-tick double close must both claim (no P1-only order bias).
 */
import { createInitialState, step, CellType } from '../packages/engine/dist/index.js';

const toFp = (n) => (n << 8) + 128;
const cellOf = (fp) => fp >> 8;

function midCoverCase() {
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

  state.player2.drawing = true;
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
  return (
    state.player2.hearts === 2 &&
    state.player2.drawing === false &&
    cellOf(state.player2.xFp) === 10 &&
    cellOf(state.player2.yFp) === 1 &&
    state.grid[destY][10] !== CellType.PLAYER2_TRAIL &&
    state.player1.territoryCells > 0
  );
}

function doubleClose(swap) {
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
}

const mid = midCoverCase();
const normal = doubleClose(false);
const swapped = doubleClose(true);
const both =
  normal.player1.territoryCells > 0 &&
  normal.player2.territoryCells > 0 &&
  swapped.player1.territoryCells > 0 &&
  swapped.player2.territoryCells > 0 &&
  normal.player1.hearts === 99 &&
  normal.player2.hearts === 99 &&
  normal.player1.territoryCells === swapped.player2.territoryCells &&
  normal.player2.territoryCells === swapped.player1.territoryCells;

const ok = mid && both;
console.log(ok ? 'qa/sever2 PASS' : 'qa/sever2 FAIL', {
  midCoverOk: mid,
  doubleCloseOk: both,
  p1: normal.player1.territoryCells,
  p2: normal.player2.territoryCells,
});
process.exit(ok ? 0 : 1);
