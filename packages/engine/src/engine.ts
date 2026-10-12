import {
  CellType,
  Direction,
  GameEvent,
  MatchState,
  MonsterState,
  PlayerInput,
  PlayerState,
  Position,
  ResultReason,
  StepResult,
  GRID_WIDTH,
  GRID_HEIGHT,
  MATCH_DURATION_TICKS,
  STARTING_HEARTS,
  IDLE_BURN_TICKS,
  PLAYER_SPEED_FP,
  WIN_OPEN_NUM,
  WIN_OPEN_DEN,
  TRAP_BONUS_NUM,
  TRAP_BONUS_DEN,
  FUSE_CELLS_PER_TICK,
  SMALL_TRAP_NUM,
  SMALL_TRAP_DEN,
  SPARX_STEPS,
  HURT_IFRAME_TICKS,
} from './types.js';
import {
  cellOf,
  directionFromHeading,
  headingFromDirection,
  stepFixed,
  toFp,
  wrapAngle,
} from './lut.js';
import { claimClosedTrail, countCells } from './cover.js';
import {
  CARDINAL,
  hashStateCells,
  inBounds,
  isCover,
  isOpened,
  isTrail,
  playerOpenType,
  playerTrailType,
} from './utils.js';

export function createInitialState(options?: {
  width?: number;
  height?: number;
  matchTicks?: number;
}): MatchState {
  const w = options?.width ?? GRID_WIDTH;
  const h = options?.height ?? GRID_HEIGHT;
  const grid: CellType[][] = Array.from({ length: h }, () => Array(w).fill(CellType.COVER));

  for (let x = 0; x < w; x++) {
    grid[0][x] = CellType.SAFE_EDGE;
    grid[h - 1][x] = CellType.SAFE_EDGE;
  }
  for (let y = 0; y < h; y++) {
    grid[y][0] = CellType.SAFE_EDGE;
    grid[y][w - 1] = CellType.SAFE_EDGE;
  }

  const p1x = w >> 1;
  const p1y = h - 2;
  const p2x = w >> 1;
  const p2y = 1;
  grid[p1y][p1x] = CellType.SAFE_EDGE;
  grid[p2y][p2x] = CellType.SAFE_EDGE;

  return {
    grid,
    gridWidth: w,
    gridHeight: h,
    player1: makePlayer(p1x, p1y, 192),
    player2: makePlayer(p2x, p2y, 64),
    boss: {
      xFp: toFp(w >> 1),
      yFp: toFp(h >> 1),
      heading: 20,
      edgeDir: 0,
    },
    sparx1: {
      xFp: toFp(0),
      yFp: toFp(0),
      heading: 0,
      edgeDir: 0,
    },
    sparx2: {
      xFp: toFp(w - 1),
      yFp: toFp(h - 1),
      heading: 128,
      edgeDir: 2,
    },
    tick: 0,
    paused: false,
    result: null,
    matchTicks: options?.matchTicks ?? MATCH_DURATION_TICKS,
  };
}

function snapCell(player: PlayerState): void {
  player.position.x = cellOf(player.xFp);
  player.position.y = cellOf(player.yFp);
}

function makePlayer(x: number, y: number, heading: number): PlayerState {
  return {
    position: { x, y },
    xFp: toFp(x),
    yFp: toFp(y),
    heading,
    direction: directionFromHeading(heading),
    thrusting: false,
    drawing: false,
    hearts: STARTING_HEARTS,
    trail: [],
    idleTicks: 0,
    fuseIndex: -1,
    spawnX: x,
    spawnY: y,
    isAlive: true,
    territoryCells: 0,
    bonusCells: 0,
    lastHurtTick: -1,
  };
}

export function step(state: MatchState, inputs: PlayerInput[] | null | undefined): StepResult {
  if (state.result !== null || state.paused) {
    return { state, events: [] };
  }

  const events: GameEvent[] = [];
  applyInputs(state, inputs ?? []);
  movePlayers(state, events);
  moveBoss(state, events);
  moveSparx(state, events);
  tickFuse(state, events);
  state.tick++;
  checkWins(state, events);
  return { state, events };
}

function applyInputs(state: MatchState, inputs: PlayerInput[]): void {
  for (const input of inputs) {
    if (!input || typeof input !== 'object') continue;
    const player = input.player === 1 ? state.player1 : state.player2;
    if (!player?.isAlive) continue;

    if (input.direction) {
      player.heading = headingFromDirection(input.direction);
      player.thrusting = true;
    }
    if (typeof input.heading === 'number') {
      player.heading = wrapAngle(input.heading);
    }
    if (typeof input.thrusting === 'boolean') {
      player.thrusting = input.thrusting;
    }
    player.direction = directionFromHeading(player.heading);
  }
}

function movePlayers(state: MatchState, events: GameEvent[]): void {
  const intents: Array<{
    num: 1 | 2;
    player: PlayerState;
    xFp: number;
    yFp: number;
    cx: number;
    cy: number;
    crossedFoe: boolean;
  }> = [];

  for (const num of [1, 2] as const) {
    const player = num === 1 ? state.player1 : state.player2;
    if (!player.isAlive) continue;

    if (!player.thrusting) {
      if (player.drawing) {
        player.idleTicks++;
        if (player.idleTicks >= IDLE_BURN_TICKS && player.fuseIndex < 0) {
          player.fuseIndex = 0;
          events.push({ type: 'burn', player: num });
        }
      }
      continue;
    }

    player.idleTicks = 0;
    const next = stepFixed(player.xFp, player.yFp, player.heading, PLAYER_SPEED_FP);
    const cx = cellOf(next.xFp);
    const cy = cellOf(next.yFp);
    if (!inBounds(cx, cy, state.gridWidth, state.gridHeight)) continue;
    intents.push({ num, player, xFp: next.xFp, yFp: next.yFp, cx, cy, crossedFoe: false });
  }

  const willHurt = new Set<1 | 2>();
  for (const intent of intents) {
    const cell = state.grid[intent.cy][intent.cx];
    const foe: 1 | 2 = intent.num === 1 ? 2 : 1;
    if (isTrail(cell, foe)) {
      willHurt.add(foe);
      intent.crossedFoe = true;
    } else if (isTrail(cell, intent.num)) {
      const last = intent.player.trail[intent.player.trail.length - 1];
      if (!last || last.x !== intent.cx || last.y !== intent.cy) {
        willHurt.add(intent.num);
      }
    }
  }

  for (const num of willHurt) {
    hurt(state, num, events);
  }

  for (const intent of intents) {
    if (!intent.player.isAlive || willHurt.has(intent.num)) continue;
    if (intent.crossedFoe) {
      paintCrossedTrail(state, intent.num, intent.player, intent.xFp, intent.yFp, intent.cx, intent.cy);
    } else {
      tryMovePlayer(state, intent.num, intent.player, intent.xFp, intent.yFp, events);
    }
  }
}

function paintCrossedTrail(
  state: MatchState,
  num: 1 | 2,
  player: PlayerState,
  xFp: number,
  yFp: number,
  cx: number,
  cy: number,
): void {
  player.xFp = xFp;
  player.yFp = yFp;
  snapCell(player);
  if (!player.drawing) {
    player.drawing = true;
    player.trail = [];
    player.fuseIndex = -1;
    player.idleTicks = 0;
  }
  const last = player.trail[player.trail.length - 1];
  if (!last || last.x !== cx || last.y !== cy) {
    state.grid[cy][cx] = playerTrailType(num);
    player.trail.push({ x: cx, y: cy });
  }
}

function tryMovePlayer(
  state: MatchState,
  num: 1 | 2,
  player: PlayerState,
  xFp: number,
  yFp: number,
  events: GameEvent[],
): void {
  const w = state.gridWidth;
  const h = state.gridHeight;
  let cx = cellOf(xFp);
  let cy = cellOf(yFp);
  if (!inBounds(cx, cy, w, h)) {
    return;
  }

  const fromX = cellOf(player.xFp);
  const fromY = cellOf(player.yFp);
  const cell = state.grid[cy][cx];
  const foe = num === 1 ? 2 : 1;

    if (isTrail(cell, foe)) {
    hurt(state, foe, events);
    player.xFp = xFp;
    player.yFp = yFp;
    snapCell(player);
    return;
  }

  if (isTrail(cell, num)) {
    const last = player.trail[player.trail.length - 1];
    if (last && last.x === cx && last.y === cy) {
      player.xFp = xFp;
      player.yFp = yFp;
      snapCell(player);
      return;
    }
    hurt(state, num, events);
    return;
  }

  if (player.drawing) {
    if (isOpened(cell)) {
      player.xFp = xFp;
      player.yFp = yFp;
      snapCell(player);
      closeTrail(state, num, events);
      return;
    }
    if (isCover(cell)) {
      if (cellOf(state.boss.xFp) === cx && cellOf(state.boss.yFp) === cy) {
        hurt(state, num, events);
        return;
      }
      player.xFp = xFp;
      player.yFp = yFp;
      snapCell(player);
      if (fromX !== cx || fromY !== cy) {
        state.grid[cy][cx] = playerTrailType(num);
        player.trail.push({ x: cx, y: cy });
      }
    }
    return;
  }

  if (isOpened(cell)) {
    player.xFp = xFp;
    player.yFp = yFp;
    snapCell(player);
    player.spawnX = cx;
    player.spawnY = cy;
    return;
  }

  if (isCover(cell) && isOpened(state.grid[fromY][fromX])) {
    if (cellOf(state.boss.xFp) === cx && cellOf(state.boss.yFp) === cy) {
      hurt(state, num, events);
      return;
    }
    player.drawing = true;
    player.trail = [];
    player.fuseIndex = -1;
    player.idleTicks = 0;
    player.xFp = xFp;
    player.yFp = yFp;
    snapCell(player);
    state.grid[cy][cx] = playerTrailType(num);
    player.trail.push({ x: cx, y: cy });
  }
}

function closeTrail(state: MatchState, num: 1 | 2, events: GameEvent[]): void {
  const player = num === 1 ? state.player1 : state.player2;
  if (player.trail.length === 0) {
    player.drawing = false;
    return;
  }

  const bossCell = { x: cellOf(state.boss.xFp), y: cellOf(state.boss.yFp) };
  if (
    (cellOf(player.xFp) === bossCell.x && cellOf(player.yFp) === bossCell.y) ||
    player.trail.some((p) => p.x === bossCell.x && p.y === bossCell.y)
  ) {
    hurt(state, num, events);
    return;
  }

  const sparks = [
    { x: cellOf(state.sparx1.xFp), y: cellOf(state.sparx1.yFp) },
    { x: cellOf(state.sparx2.xFp), y: cellOf(state.sparx2.yFp) },
  ];
  const total = state.gridWidth * state.gridHeight;
  const { claimed, remainingCover } = claimClosedTrail(state.grid, player.trail, num, bossCell);

  const paint = playerOpenType(num);
  let trapped = false;
  for (const s of sparks) {
    if (sparkCaptured(state, s, paint)) trapped = true;
  }
  // Remaining cover 0 means the boss region vanished (do not award +5%).
  if (remainingCover > 0 && remainingCover * SMALL_TRAP_DEN < total * SMALL_TRAP_NUM) {
    trapped = true;
  }

  let bonus = 0;
  if (trapped) {
    bonus = Math.floor((total * TRAP_BONUS_NUM) / TRAP_BONUS_DEN);
    player.bonusCells += bonus;
    const percent = Math.round((bonus * 100) / total);
    events.push({
      type: 'trap_bonus',
      player: num,
      data: { bonus: true, cells: bonus, percent },
    });
  }

  player.territoryCells = countCells(state.grid, paint) + player.bonusCells;
  player.drawing = false;
  player.trail = [];
  player.fuseIndex = -1;
  player.idleTicks = 0;
  player.spawnX = cellOf(player.xFp);
  player.spawnY = cellOf(player.yFp);
  events.push({ type: 'claim', player: num, data: { cells: claimed } });
}

function hurt(state: MatchState, num: 1 | 2, events: GameEvent[]): void {
  const player = num === 1 ? state.player1 : state.player2;
  if (!player.isAlive) return;
  if (player.lastHurtTick >= 0 && state.tick - player.lastHurtTick < HURT_IFRAME_TICKS) return;
  player.lastHurtTick = state.tick;

  clearTrail(state, num);
  player.hearts -= 1;
  player.drawing = false;
  player.idleTicks = 0;
  player.fuseIndex = -1;
  player.trail = [];
  player.thrusting = false;
  player.xFp = toFp(player.spawnX);
  player.yFp = toFp(player.spawnY);
  snapCell(player);
  events.push({ type: 'heart', player: num });

  if (player.hearts <= 0) {
    player.isAlive = false;
    player.hearts = 0;
  }
}

function clearTrail(state: MatchState, num: 1 | 2): void {
  const player = num === 1 ? state.player1 : state.player2;
  const trailType = playerTrailType(num);
  for (const p of player.trail) {
    if (inBounds(p.x, p.y, state.gridWidth, state.gridHeight) && state.grid[p.y][p.x] === trailType) {
      state.grid[p.y][p.x] = CellType.COVER;
    }
  }
}

function tickFuse(state: MatchState, events: GameEvent[]): void {
  for (const num of [1, 2] as const) {
    const player = num === 1 ? state.player1 : state.player2;
    if (!player.drawing || player.fuseIndex < 0) continue;
    player.fuseIndex += FUSE_CELLS_PER_TICK;
    if (player.fuseIndex >= player.trail.length) {
      hurt(state, num, events);
    } else {
      const burned = player.trail.slice(0, player.fuseIndex);
      for (const p of burned) {
        if (inBounds(p.x, p.y, state.gridWidth, state.gridHeight) && isTrail(state.grid[p.y][p.x], num)) {
          state.grid[p.y][p.x] = CellType.COVER;
        }
      }
    }
  }
}

function bossSpeed(state: MatchState): number {
  const total = state.gridWidth * state.gridHeight;
  const opened = total - countCells(state.grid, CellType.COVER) - countCells(state.grid, CellType.SAFE_EDGE);
  const base = 64;
  return base + Math.floor((opened * 192) / total);
}

function moveBoss(state: MatchState, events: GameEvent[]): void {
  const speed = bossSpeed(state);
  let heading = state.boss.heading;
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = stepFixed(state.boss.xFp, state.boss.yFp, heading, speed);
    const cx = cellOf(next.xFp);
    const cy = cellOf(next.yFp);
    if (!inBounds(cx, cy, state.gridWidth, state.gridHeight)) continue;
    const cell = state.grid[cy][cx];
    if (isTrail(cell) || isCover(cell)) {
      state.boss.xFp = next.xFp;
      state.boss.yFp = next.yFp;
      state.boss.heading = heading;
      hitTrailAndDrawer(state, cx, cy, events);
      return;
    }
    heading = wrapAngle(heading + 64);
  }
}

function moveSparx(state: MatchState, events: GameEvent[]): void {
  for (let i = 0; i < SPARX_STEPS; i++) {
    walkSparx(state, state.sparx1, 1);
    hitAnyPlayer(state, cellOf(state.sparx1.xFp), cellOf(state.sparx1.yFp), events);
    walkSparx(state, state.sparx2, -1);
    hitAnyPlayer(state, cellOf(state.sparx2.xFp), cellOf(state.sparx2.yFp), events);
  }
}

/** Sparx walk only the outer board rim, never opened-territory boundaries. */
function isOuterEdge(state: MatchState, x: number, y: number): boolean {
  if (!inBounds(x, y, state.gridWidth, state.gridHeight)) return false;
  return x === 0 || y === 0 || x === state.gridWidth - 1 || y === state.gridHeight - 1;
}

function walkSparx(state: MatchState, sparx: MonsterState, turnSign: number): void {
  const x = cellOf(sparx.xFp);
  const y = cellOf(sparx.yFp);
  let dir = sparx.edgeDir & 3;
  for (let i = 0; i < 4; i++) {
    const tryDir = (dir + turnSign * (i === 0 ? -1 : i === 1 ? 0 : i === 2 ? 1 : 2) + 4) & 3;
    const nx = x + CARDINAL[tryDir].x;
    const ny = y + CARDINAL[tryDir].y;
    if (isOuterEdge(state, nx, ny)) {
      sparx.xFp = toFp(nx);
      sparx.yFp = toFp(ny);
      sparx.edgeDir = tryDir;
      return;
    }
  }
}

function hitTrailAndDrawer(state: MatchState, x: number, y: number, events: GameEvent[]): void {
  for (const num of [1, 2] as const) {
    if (isTrail(state.grid[y][x], num)) {
      hurt(state, num, events);
      continue;
    }
    const p = num === 1 ? state.player1 : state.player2;
    if (p.drawing && cellOf(p.xFp) === x && cellOf(p.yFp) === y) {
      hurt(state, num, events);
    }
  }
}

function hitAnyPlayer(state: MatchState, x: number, y: number, events: GameEvent[]): void {
  for (const num of [1, 2] as const) {
    const p = num === 1 ? state.player1 : state.player2;
    if (!p.isAlive || cellOf(p.xFp) !== x || cellOf(p.yFp) !== y) continue;
    // Sparx only live on the outer rim. A player who is not on that rim
    // and not currently drawing a line cannot be hit.
    const onBorder = isOuterEdge(state, x, y);
    const onLine = p.drawing || isTrail(state.grid[y][x], num);
    if (onBorder || onLine) hurt(state, num, events);
  }
}

function sparkCaptured(state: MatchState, s: Position, paint: CellType): boolean {
  if (!inBounds(s.x, s.y, state.gridWidth, state.gridHeight)) return false;
  if (state.grid[s.y][s.x] === paint) return true;
  if (!isOuterEdge(state, s.x, s.y)) return false;
  // Boxed against the wall: every inward (non-rim) neighbor is claimed.
  let interior = 0;
  let painted = 0;
  for (const d of CARDINAL) {
    const nx = s.x + d.x;
    const ny = s.y + d.y;
    if (!inBounds(nx, ny, state.gridWidth, state.gridHeight)) continue;
    if (isOuterEdge(state, nx, ny)) continue;
    interior++;
    if (state.grid[ny][nx] === paint) painted++;
  }
  return interior > 0 && painted === interior;
}

function openedScore(player: PlayerState): number {
  return player.territoryCells;
}

function checkWins(state: MatchState, events: GameEvent[]): void {
  if (state.result) return;
  const total = state.gridWidth * state.gridHeight;
  const p1 = openedScore(state.player1);
  const p2 = openedScore(state.player2);

  if (!state.player1.isAlive && !state.player2.isAlive) {
    state.result = { winner: 0, reason: ResultReason.BOTH_HEARTS_OUT, tick: state.tick };
    return;
  }
  if (!state.player1.isAlive) {
    state.result = { winner: 2, reason: ResultReason.HEARTS_OUT, tick: state.tick };
    events.push({ type: 'win', player: 2 });
    return;
  }
  if (!state.player2.isAlive) {
    state.result = { winner: 1, reason: ResultReason.HEARTS_OUT, tick: state.tick };
    events.push({ type: 'win', player: 1 });
    return;
  }

  const p1Fifty = p1 * WIN_OPEN_DEN >= total * WIN_OPEN_NUM;
  const p2Fifty = p2 * WIN_OPEN_DEN >= total * WIN_OPEN_NUM;
  if (p1Fifty && p2Fifty) {
    if (p1 === p2) {
      state.result = { winner: 0, reason: ResultReason.TERRITORY_TIE, tick: state.tick };
    } else {
      const winner: 1 | 2 = p1 > p2 ? 1 : 2;
      state.result = { winner, reason: ResultReason.FIFTY_PERCENT, tick: state.tick };
      events.push({ type: 'win', player: winner });
    }
    return;
  }
  if (p1Fifty) {
    state.result = { winner: 1, reason: ResultReason.FIFTY_PERCENT, tick: state.tick };
    events.push({ type: 'win', player: 1 });
    return;
  }
  if (p2Fifty) {
    state.result = { winner: 2, reason: ResultReason.FIFTY_PERCENT, tick: state.tick };
    events.push({ type: 'win', player: 2 });
    return;
  }

  if (state.tick >= state.matchTicks) {
    if (p1 === p2) {
      state.result = { winner: 0, reason: ResultReason.TERRITORY_TIE, tick: state.tick };
    } else {
      state.result = {
        winner: p1 > p2 ? 1 : 2,
        reason: ResultReason.TIME_UP_WIN,
        tick: state.tick,
      };
    }
  }
}

export function replayInputLog(inputs: PlayerInput[][], options?: { width?: number; height?: number; matchTicks?: number }): MatchState {
  let state = createInitialState(options);
  for (const tickInputs of inputs) {
    const result = step(state, tickInputs);
    state = result.state;
    if (state.result !== null) break;
  }
  return state;
}

export function fingerprint(state: MatchState): number {
  return hashStateCells(state.grid, [
    state.tick,
    state.player1.xFp,
    state.player1.yFp,
    state.player1.heading,
    state.player1.hearts,
    state.player1.territoryCells,
    state.player2.xFp,
    state.player2.yFp,
    state.player2.heading,
    state.player2.hearts,
    state.player2.territoryCells,
    state.boss.xFp,
    state.boss.yFp,
    state.sparx1.xFp,
    state.sparx1.yFp,
    state.sparx2.xFp,
    state.sparx2.yFp,
    state.result ? state.result.winner : -1,
  ]);
}

export { Direction };
