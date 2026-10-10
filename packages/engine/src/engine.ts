import {
  Direction,
  Position,
  CellType,
  MatchState,
  PlayerState,
  PlayerInput,
  StepResult,
  GameEvent,
  ResultReason,
  MatchResult,
  GRID_SIZE,
  START_AREA_SIZE,
  MATCH_DURATION_TICKS,
} from './types.js';
import {
  isOppositeDirection,
  getNextPosition,
  isOutOfBounds,
  positionsEqual,
  isPlayerTerritory,
  isPlayerTrail,
  getPlayerTrailType,
  getPlayerTerritoryType,
  cloneGrid,
} from './utils.js';
import { closeTerritoryForPlayer, countTerritoryCells } from './territory.js';

export function createInitialState(): MatchState {
  const grid: CellType[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(CellType.EMPTY)
  );

  for (let dy = 0; dy < START_AREA_SIZE; dy++) {
    for (let dx = 0; dx < START_AREA_SIZE; dx++) {
      grid[dy][dx] = CellType.PLAYER1_TERRITORY;
    }
  }

  for (let dy = 0; dy < START_AREA_SIZE; dy++) {
    for (let dx = 0; dx < START_AREA_SIZE; dx++) {
      grid[GRID_SIZE - 1 - dy][GRID_SIZE - 1 - dx] = CellType.PLAYER2_TERRITORY;
    }
  }

  const player1: PlayerState = {
    position: { x: 1, y: 1 },
    direction: Direction.RIGHT,
    inputBuffer: null,
    isAlive: true,
    territoryCells: START_AREA_SIZE * START_AREA_SIZE,
  };

  const player2: PlayerState = {
    position: { x: GRID_SIZE - 2, y: GRID_SIZE - 2 },
    direction: Direction.LEFT,
    inputBuffer: null,
    isAlive: true,
    territoryCells: START_AREA_SIZE * START_AREA_SIZE,
  };

  return {
    grid,
    player1,
    player2,
    tick: 0,
    paused: false,
    result: null,
  };
}

export function step(state: MatchState, inputs: PlayerInput[]): StepResult {
  if (state.result !== null || state.paused) {
    return { state, events: [] };
  }

  const newState: MatchState = JSON.parse(JSON.stringify(state));
  const events: GameEvent[] = [];

  for (const input of inputs) {
    const player = input.player === 1 ? newState.player1 : newState.player2;
    if (!player.isAlive) continue;

    if (!isOppositeDirection(player.direction, input.direction)) {
      player.inputBuffer = input.direction;
    }
  }

  newState.tick++;

  if (newState.tick >= MATCH_DURATION_TICKS) {
    return handleTimeUp(newState, events);
  }

  movePhase(newState);

  const collisionResult = collisionPhase(newState, events);
  if (collisionResult) {
    return collisionResult;
  }

  closePhase(newState, events);

  return { state: newState, events };
}

function movePhase(state: MatchState): void {
  for (const player of [state.player1, state.player2]) {
    if (!player.isAlive) continue;

    if (player.inputBuffer !== null) {
      player.direction = player.inputBuffer;
      player.inputBuffer = null;
    }

    const nextPos = getNextPosition(player.position, player.direction);
    player.position = nextPos;
  }
}

function collisionPhase(state: MatchState, events: GameEvent[]): StepResult | null {
  const p1 = state.player1;
  const p2 = state.player2;

  const p1OutOfBounds = isOutOfBounds(p1.position);
  const p2OutOfBounds = isOutOfBounds(p2.position);

  if (p1OutOfBounds && p2OutOfBounds) {
    state.result = {
      winner: 0,
      reason: ResultReason.SIMULTANEOUS_COLLISION,
      tick: state.tick,
    };
    p1.isAlive = false;
    p2.isAlive = false;
    return { state, events };
  }

  if (p1OutOfBounds) {
    state.result = {
      winner: 2,
      reason: ResultReason.HIT_WALL,
      tick: state.tick,
    };
    p1.isAlive = false;
    return { state, events };
  }

  if (p2OutOfBounds) {
    state.result = {
      winner: 1,
      reason: ResultReason.HIT_WALL,
      tick: state.tick,
    };
    p2.isAlive = false;
    return { state, events };
  }

  const p1Cell = state.grid[p1.position.y][p1.position.x];
  const p2Cell = state.grid[p2.position.y][p2.position.x];

  const p1InOwnTerritory = isPlayerTerritory(p1Cell, 1);
  const p2InOwnTerritory = isPlayerTerritory(p2Cell, 2);

  const p1SteppedOwnTrail = !p1InOwnTerritory && isPlayerTrail(p1Cell, 1);
  const p2SteppedOwnTrail = !p2InOwnTerritory && isPlayerTrail(p2Cell, 2);

  const p1CutP2Trail = isPlayerTrail(p1Cell, 2);
  const p2CutP1Trail = isPlayerTrail(p2Cell, 1);

  const headOnCollision = positionsEqual(p1.position, p2.position);

  if (headOnCollision || (p1SteppedOwnTrail && p2SteppedOwnTrail) || 
      (p1CutP2Trail && p2CutP1Trail) ||
      (p1SteppedOwnTrail && p2CutP1Trail) ||
      (p2SteppedOwnTrail && p1CutP2Trail)) {
    state.result = {
      winner: 0,
      reason: ResultReason.SIMULTANEOUS_COLLISION,
      tick: state.tick,
    };
    p1.isAlive = false;
    p2.isAlive = false;
    return { state, events };
  }

  if (p2CutP1Trail) {
    state.result = {
      winner: 2,
      reason: ResultReason.TRAIL_CUT,
      tick: state.tick,
    };
    p1.isAlive = false;
    return { state, events };
  }

  if (p1CutP2Trail) {
    state.result = {
      winner: 1,
      reason: ResultReason.TRAIL_CUT,
      tick: state.tick,
    };
    p2.isAlive = false;
    return { state, events };
  }

  if (p1SteppedOwnTrail) {
    state.result = {
      winner: 2,
      reason: ResultReason.STEPPED_OWN_TRAIL,
      tick: state.tick,
    };
    p1.isAlive = false;
    return { state, events };
  }

  if (p2SteppedOwnTrail) {
    state.result = {
      winner: 1,
      reason: ResultReason.STEPPED_OWN_TRAIL,
      tick: state.tick,
    };
    p2.isAlive = false;
    return { state, events };
  }

  return null;
}

function closePhase(state: MatchState, events: GameEvent[]): void {
  const p1 = state.player1;
  const p2 = state.player2;

  if (!p1.isAlive && !p2.isAlive) return;

  const p1Cell = state.grid[p1.position.y][p1.position.x];
  const p2Cell = state.grid[p2.position.y][p2.position.x];

  const p1InOwnTerritory = isPlayerTerritory(p1Cell, 1);
  const p2InOwnTerritory = isPlayerTerritory(p2Cell, 2);

  const p1WasOutside = !p1InOwnTerritory;
  const p2WasOutside = !p2InOwnTerritory;

  if (p1WasOutside) {
    state.grid[p1.position.y][p1.position.x] = getPlayerTrailType(1);
  }

  if (p2WasOutside) {
    state.grid[p2.position.y][p2.position.x] = getPlayerTrailType(2);
  }

  if (p1.isAlive && p1InOwnTerritory && p1WasOutside === false) {
    const p2TrailPositions = getTrailPositions(state.grid, 2);
    const result = closeTerritoryForPlayer(state.grid, 1, p1.position, p2.position, p2TrailPositions);
    state.grid = result.grid;
  }

  if (p2.isAlive && p2InOwnTerritory && p2WasOutside === false) {
    const p1TrailPositions = getTrailPositions(state.grid, 1);
    const result = closeTerritoryForPlayer(state.grid, 2, p2.position, p1.position, p1TrailPositions);
    state.grid = result.grid;
  }

  p1.territoryCells = countTerritoryCells(state.grid, 1);
  p2.territoryCells = countTerritoryCells(state.grid, 2);
}

function getTrailPositions(grid: CellType[][], player: 1 | 2): Position[] {
  const trailType = getPlayerTrailType(player);
  const positions: Position[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x] === trailType) {
        positions.push({ x, y });
      }
    }
  }
  return positions;
}

function handleTimeUp(state: MatchState, events: GameEvent[]): StepResult {
  const p1Cells = countTerritoryCells(state.grid, 1);
  const p2Cells = countTerritoryCells(state.grid, 2);

  if (p1Cells > p2Cells) {
    state.result = {
      winner: 1,
      reason: ResultReason.TIME_UP_WIN,
      tick: state.tick,
    };
  } else if (p2Cells > p1Cells) {
    state.result = {
      winner: 2,
      reason: ResultReason.TIME_UP_WIN,
      tick: state.tick,
    };
  } else {
    state.result = {
      winner: 0,
      reason: ResultReason.TERRITORY_TIE,
      tick: state.tick,
    };
  }

  return { state, events };
}

export function replayInputLog(inputs: PlayerInput[][]): MatchState {
  let state = createInitialState();
  
  for (const tickInputs of inputs) {
    const result = step(state, tickInputs);
    state = result.state;
    
    if (state.result !== null) {
      break;
    }
  }
  
  return state;
}
