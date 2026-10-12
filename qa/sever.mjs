/**
 * Lee P0 repro: invincible foe whose line is severed must return to spawn
 * and still be able to move (not sit non-drawing on cover).
 */
import { createInitialState, step } from '../packages/engine/dist/index.js';
import { CellType } from '../packages/engine/dist/index.js';

const FP = 256;
const toFp = (n) => (n << 8) + 128;
const cellOf = (fp) => fp >> 8;

function run(state, inputs, ticks = 1) {
  let s = state;
  for (let i = 0; i < ticks; i++) {
    s = step(s, inputs).state;
    if (s.result) break;
  }
  return s;
}

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

const walkUntil = (heading, done, max = 80) => {
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

const atSpawn = cellOf(state.player2.xFp) === 10 && cellOf(state.player2.yFp) === 1;
const x0 = state.player2.xFp;
const y0 = state.player2.yFp;
state = run(state, [{ player: 2, heading: 0, thrusting: true }], 8);
const moved = state.player2.xFp !== x0 || state.player2.yFp !== y0;

const ok =
  state.player2.hearts === 3 &&
  state.player2.drawing === false &&
  atSpawn &&
  moved &&
  state.player2.isAlive;
console.log(ok ? 'qa/sever PASS' : 'qa/sever FAIL', {
  hearts: state.player2.hearts,
  drawing: state.player2.drawing,
  atSpawn,
  moved,
  pos: { x: cellOf(state.player2.xFp), y: cellOf(state.player2.yFp) },
});
process.exit(ok ? 0 : 1);
void FP;
