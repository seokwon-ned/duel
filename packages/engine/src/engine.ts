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
  COS,
  SIN,
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
  seed?: number;
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

  const spawn = spawnBoss(w, h, options?.seed ?? 0);
  return {
    grid,
    gridWidth: w,
    gridHeight: h,
    player1: makePlayer(p1x, p1y, 192),
    player2: makePlayer(p2x, p2y, 64),
    boss: {
      xFp: toFp(spawn.x),
      yFp: toFp(spawn.y),
      heading: spawn.heading,
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

/** Match-seeded COVER spawn. Seed 0 stays center / heading 32 for tests. */
function spawnBoss(w: number, h: number, seed: number): { x: number; y: number; heading: number } {
  const s = seed >>> 0;
  const cx = w >> 1;
  const cy = h >> 1;
  const x = Math.min(w - 3, Math.max(2, cx + (s === 0 ? 0 : (s % 17) - 8)));
  const y = Math.min(h - 3, Math.max(2, cy + (s === 0 ? 0 : ((s >>> 5) % 21) - 10)));
  let heading = s === 0 ? 32 : 24 + ((s >>> 3) % 25);
  if (heading === 40) heading = 36;
  return { x, y, heading };
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
      const foePlayer = foe === 1 ? state.player1 : state.player2;
      if (!isInvincible(foePlayer, state.tick)) {
        willHurt.add(foe);
        intent.crossedFoe = true;
      }
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

  const applyIntent = (
    intent: (typeof intents)[number],
    pendingClose: Array<1 | 2>,
  ): void => {
    if (!intent.player.isAlive || willHurt.has(intent.num)) return;
    if (intent.player.lastHurtTick === state.tick || !intent.player.thrusting) return;
    if (intent.crossedFoe) {
      paintCrossedTrail(state, intent.num, intent.player, intent.xFp, intent.yFp, intent.cx, intent.cy);
    } else if (tryMovePlayer(state, intent.num, intent.player, intent.xFp, intent.yFp, events)) {
      pendingClose.push(intent.num);
    }
  };

  const closers = intents
    .filter((intent) => {
      if (!intent.player.isAlive || willHurt.has(intent.num)) return false;
      if (intent.player.lastHurtTick === state.tick || intent.crossedFoe) return false;
      return intentWouldClose(state, intent);
    })
    .map((intent) => intent.num);
  const skipSever = closers.length > 1;
  const pendingClose: Array<1 | 2> = [];
  // Apply every intent, then flush. A foe trail cell painted this tick is a
  // wall: the closer keeps COVER the boss cannot reach through that line.
  for (const intent of intents) applyIntent(intent, pendingClose);
  flushCloses(state, pendingClose, events, skipSever);
}

function intentWouldClose(
  state: MatchState,
  intent: { player: PlayerState; num: 1 | 2; cx: number; cy: number },
): boolean {
  if (!intent.player.drawing) return false;
  if (!inBounds(intent.cx, intent.cy, state.gridWidth, state.gridHeight)) return false;
  const cell = state.grid[intent.cy][intent.cx];
  const foe: 1 | 2 = intent.num === 1 ? 2 : 1;
  if (isTrail(cell, foe) || isTrail(cell, intent.num)) return false;
  return isOpened(cell);
}

function flushCloses(
  state: MatchState,
  pendingClose: Array<1 | 2>,
  events: GameEvent[],
  skipSever: boolean,
): void {
  for (const num of pendingClose) {
    const player = num === 1 ? state.player1 : state.player2;
    if (!player.isAlive || player.lastHurtTick === state.tick) continue;
    closeTrail(state, num, events, skipSever);
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
): boolean {
  const w = state.gridWidth;
  const h = state.gridHeight;
  let cx = cellOf(xFp);
  let cy = cellOf(yFp);
  if (!inBounds(cx, cy, w, h)) {
    return false;
  }

  const fromX = cellOf(player.xFp);
  const fromY = cellOf(player.yFp);
  const cell = state.grid[cy][cx];
  const foe = num === 1 ? 2 : 1;

  if (isTrail(cell, foe)) {
    const foePlayer = foe === 1 ? state.player1 : state.player2;
    if (isInvincible(foePlayer, state.tick)) {
      // Pass over: do not overwrite their live cell, but keep our polyline
      // intact so a later erase of their line cannot punch a hole in ours.
      passOverInvincibleTrail(state, player, xFp, yFp, cx, cy, fromX, fromY);
      return false;
    }
    hurt(state, foe, events);
    player.xFp = xFp;
    player.yFp = yFp;
    snapCell(player);
    return false;
  }

  if (isTrail(cell, num)) {
    const last = player.trail[player.trail.length - 1];
    if (last && last.x === cx && last.y === cy) {
      player.xFp = xFp;
      player.yFp = yFp;
      snapCell(player);
      return false;
    }
    hurt(state, num, events);
    return false;
  }

  if (player.drawing) {
    if (isOpened(cell)) {
      player.xFp = xFp;
      player.yFp = yFp;
      snapCell(player);
      return true;
    }
    if (isCover(cell)) {
      if (cellOf(state.boss.xFp) === cx && cellOf(state.boss.yFp) === cy) {
        hurt(state, num, events);
        return false;
      }
      player.xFp = xFp;
      player.yFp = yFp;
      snapCell(player);
      if (fromX !== cx || fromY !== cy) {
        state.grid[cy][cx] = playerTrailType(num);
        player.trail.push({ x: cx, y: cy });
      }
    }
    return false;
  }

  if (isOpened(cell)) {
    player.xFp = xFp;
    player.yFp = yFp;
    snapCell(player);
    player.spawnX = cx;
    player.spawnY = cy;
    return false;
  }

  if (isCover(cell) && isOpened(state.grid[fromY][fromX])) {
    if (cellOf(state.boss.xFp) === cx && cellOf(state.boss.yFp) === cy) {
      hurt(state, num, events);
      return false;
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
  return false;
}

function closeTrail(state: MatchState, num: 1 | 2, events: GameEvent[], skipSever = false): void {
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
  // Closing across a live foe line severs it. Invincible: line only, no heart.
  // Same-tick double close skips sever so order cannot cancel the other claim.
  if (!skipSever) {
    severOverlappingFoeLine(state, num, player.trail, events);
  }
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

  const painted = countCells(state.grid, paint);
  let bonus = 0;
  if (trapped) {
    const raw = Math.floor((total * TRAP_BONUS_NUM) / TRAP_BONUS_DEN);
    const room = Math.max(0, total - painted - player.bonusCells);
    bonus = raw < room ? raw : room;
    if (bonus > 0) {
      player.bonusCells += bonus;
      const percent = Math.round((bonus * 100) / total);
      events.push({
        type: 'trap_bonus',
        player: num,
        data: { bonus: true, cells: bonus, percent },
      });
    }
  }

  if (player.bonusCells > total - painted) {
    player.bonusCells = Math.max(0, total - painted);
  }
  player.territoryCells = painted + player.bonusCells;
  player.drawing = false;
  player.trail = [];
  player.fuseIndex = -1;
  player.idleTicks = 0;
  player.spawnX = cellOf(player.xFp);
  player.spawnY = cellOf(player.yFp);
  events.push({ type: 'claim', player: num, data: { cells: claimed } });
}

function isInvincible(player: PlayerState, tick: number): boolean {
  return player.lastHurtTick >= 0 && tick - player.lastHurtTick < HURT_IFRAME_TICKS;
}

/** Walk across an invincible foe line without painting over it. */
function passOverInvincibleTrail(
  state: MatchState,
  player: PlayerState,
  xFp: number,
  yFp: number,
  cx: number,
  cy: number,
  fromX: number,
  fromY: number,
): void {
  player.xFp = xFp;
  player.yFp = yFp;
  snapCell(player);
  const fromOpened = isOpened(state.grid[fromY][fromX]);
  if (!player.drawing && fromOpened) {
    player.drawing = true;
    player.trail = [];
    player.fuseIndex = -1;
    player.idleTicks = 0;
  }
  if (player.drawing && (fromX !== cx || fromY !== cy)) {
    const last = player.trail[player.trail.length - 1];
    if (!last || last.x !== cx || last.y !== cy) {
      player.trail.push({ x: cx, y: cy });
    }
  }
}

function severOverlappingFoeLine(
  state: MatchState,
  num: 1 | 2,
  trail: Position[],
  events: GameEvent[],
): void {
  const foe: 1 | 2 = num === 1 ? 2 : 1;
  const foePlayer = foe === 1 ? state.player1 : state.player2;
  if (!foePlayer.drawing || foePlayer.trail.length === 0) return;
  let crossed = false;
  for (const p of trail) {
    if (inBounds(p.x, p.y, state.gridWidth, state.gridHeight) && isTrail(state.grid[p.y][p.x], foe)) {
      crossed = true;
      break;
    }
  }
  if (!crossed) return;
  if (isInvincible(foePlayer, state.tick)) {
    clearTrail(state, foe);
    returnToSpawn(foePlayer);
    // Keep the original iframe expiry. returnToSpawn clears thrusting so
    // this tick's precomputed intent cannot start a new mid-cover line.
    return;
  }
  hurt(state, foe, events);
}

function returnToSpawn(player: PlayerState): void {
  player.drawing = false;
  player.trail = [];
  player.fuseIndex = -1;
  player.idleTicks = 0;
  player.thrusting = false;
  player.xFp = toFp(player.spawnX);
  player.yFp = toFp(player.spawnY);
  snapCell(player);
}

function hurt(state: MatchState, num: 1 | 2, events: GameEvent[]): void {
  const player = num === 1 ? state.player1 : state.player2;
  if (!player.isAlive) return;
  if (isInvincible(player, state.tick)) return;
  player.lastHurtTick = state.tick;

  clearTrail(state, num);
  player.hearts -= 1;
  returnToSpawn(player);
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
  // 288 on the 200-wide board (~1.5× player). Cap 1.8× player so late-game
  // cannot skip 1-cell walls even before substeps.
  const base = Math.max(64, Math.floor((288 * state.gridWidth) / GRID_WIDTH));
  const raw = base + Math.floor((opened * 192) / total);
  const cap = Math.floor((PLAYER_SPEED_FP * 9) / 5);
  return raw > cap ? cap : raw;
}

function bossCanStand(state: MatchState, x: number, y: number): boolean {
  if (!inBounds(x, y, state.gridWidth, state.gridHeight)) return false;
  const cell = state.grid[y][x];
  return isCover(cell) || isTrail(cell);
}

/** Sample the segment every 0.25 cell so a 1-cell wall cannot be skipped. */
function segmentClear(state: MatchState, x0Fp: number, y0Fp: number, x1Fp: number, y1Fp: number): boolean {
  const dx = x1Fp - x0Fp;
  const dy = y1Fp - y0Fp;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  const span = adx > ady ? adx : ady;
  const n = span > 64 ? span >> 6 : 1;
  let px = cellOf(x0Fp);
  let py = cellOf(y0Fp);
  for (let i = 1; i <= n; i++) {
    const x = x0Fp + ((dx * i) / n | 0);
    const y = y0Fp + ((dy * i) / n | 0);
    const cx = cellOf(x);
    const cy = cellOf(y);
    if (cx === px && cy === py) continue;
    if (!bossCanStand(state, cx, cy)) return false;
    px = cx;
    py = cy;
  }
  return true;
}

const BOSS_DIAG = [
  20, 28, 36, 44,
  84, 92, 100, 108,
  148, 156, 164, 172,
  212, 220, 228, 236,
] as const;

/** Qix bounce: reflect, then pick another same-sign diagonal (breaks ping-pong). */
function bounceHeading(heading: number, blockX: boolean, blockY: boolean, pick: number): number {
  let h = heading;
  if (blockX) h = wrapAngle(128 - h);
  if (blockY) h = wrapAngle(-h);
  if (wrapAngle(h - heading) === 128) h = wrapAngle(h + 32);
  const sx = COS[h] >= 0;
  const sy = SIN[h] >= 0;
  let chosen = keepDiagonal(h);
  let k = pick >>> 0;
  for (let i = 0; i < BOSS_DIAG.length; i++) {
    const d = BOSS_DIAG[(k + i) % BOSS_DIAG.length];
    if ((COS[d] >= 0) === sx && (SIN[d] >= 0) === sy) {
      chosen = d;
      break;
    }
  }
  return chosen;
}

function keepDiagonal(heading: number): number {
  const h = wrapAngle(heading);
  const ac = COS[h] < 0 ? -COS[h] : COS[h];
  const as = SIN[h] < 0 ? -SIN[h] : SIN[h];
  if (ac >= 64 && as >= 64) return h;
  const sx = COS[h] >= 0;
  const sy = SIN[h] >= 0;
  if (sx && sy) return 32;
  if (!sx && sy) return 96;
  if (!sx && !sy) return 160;
  return 224;
}

function detJitter(state: MatchState): number {
  const n = (Math.imul(state.tick + 3, 1103515245) + (state.boss.xFp ^ state.boss.yFp) + 12345) >>> 0;
  return ((n >>> 16) % 17) - 8;
}

/** 0.5 cell. Cardinal step of this size cannot skip a wall cell. */
const BOSS_SUBSTEP_FP = 128;

function moveBoss(state: MatchState, events: GameEvent[]): void {
  if (state.tick !== 0 && (state.tick & 31) === 0) {
    state.boss.heading = keepDiagonal(wrapAngle(state.boss.heading + detJitter(state)));
  }
  let remaining = bossSpeed(state);
  while (remaining > 0) {
    const sub = remaining > BOSS_SUBSTEP_FP ? BOSS_SUBSTEP_FP : remaining;
    remaining -= sub;
    if (!moveBossSub(state, events, sub)) return;
  }
}

function moveBossSub(state: MatchState, events: GameEvent[], speed: number): boolean {
  const bx = cellOf(state.boss.xFp);
  const by = cellOf(state.boss.yFp);
  let heading = state.boss.heading;
  const tryMove = (h: number): boolean => {
    const next = stepFixed(state.boss.xFp, state.boss.yFp, h, speed);
    const cx = cellOf(next.xFp);
    const cy = cellOf(next.yFp);
    if (!segmentClear(state, state.boss.xFp, state.boss.yFp, next.xFp, next.yFp)) return false;
    state.boss.xFp = next.xFp;
    state.boss.yFp = next.yFp;
    state.boss.heading = h;
    if (cx !== bx || cy !== by) hitTrailAndDrawer(state, cx, cy, events);
    return true;
  };
  if (tryMove(heading)) return true;
  const probe = stepFixed(state.boss.xFp, state.boss.yFp, heading, speed);
  const nx = cellOf(probe.xFp);
  const ny = cellOf(probe.yFp);
  const blockX = nx !== bx && !bossCanStand(state, nx, by);
  const blockY = ny !== by && !bossCanStand(state, bx, ny);
  const corner = !blockX && !blockY;
  heading = bounceHeading(heading, blockX || corner, blockY || corner, detJitter(state) + 8);
  if (tryMove(heading)) return true;
  for (const delta of [32, 224, 96, 160, 64, 192, 128]) {
    if (tryMove(wrapAngle(state.boss.heading + delta))) return true;
  }
  return false;
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
