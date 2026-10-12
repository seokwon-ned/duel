import { Direction, MatchState, Position, CellType, GRID_SIZE } from './types.js';
import { step } from './engine.js';

export interface PendingInput {
  direction: Direction;
  tick: number;
}

export interface PredictedView {
  grid: CellType[][];
  head: Position;
  tick: number;
  direction: Direction;
}

function cloneState(state: MatchState): MatchState {
  return JSON.parse(JSON.stringify(state)) as MatchState;
}

/** Convert a Colyseus TurfDuelState-like object into an engine MatchState. */
export function schemaToMatchState(state: any): MatchState {
  const grid: CellType[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const raw = state.grid?.[y * GRID_SIZE + x];
      grid[y][x] = (raw ?? 0) as CellType;
    }
  }

  const bufferOf = (value: unknown): Direction | null => {
    if (value === Direction.UP || value === Direction.DOWN || value === Direction.LEFT || value === Direction.RIGHT) {
      return value;
    }
    return null;
  };

  return {
    grid,
    player1: {
      position: { x: state.player1.position.x, y: state.player1.position.y },
      direction: state.player1.direction as Direction,
      inputBuffer: bufferOf(state.player1.inputBuffer),
      isAlive: state.player1.isAlive,
      territoryCells: state.player1.territoryCells,
      movementAccumulator: state.player1.movementAccumulator ?? 0,
    },
    player2: {
      position: { x: state.player2.position.x, y: state.player2.position.y },
      direction: state.player2.direction as Direction,
      inputBuffer: bufferOf(state.player2.inputBuffer),
      isAlive: state.player2.isAlive,
      territoryCells: state.player2.territoryCells,
      movementAccumulator: state.player2.movementAccumulator ?? 0,
    },
    tick: state.tick,
    paused: state.paused,
    result: state.result
      ? {
          winner: state.result.winner,
          reason: state.result.reason,
          tick: state.result.tick,
        }
      : null,
  };
}

/**
 * Local prediction + server reconciliation.
 * When `oneWayDelayMs` is set, each delayed snapshot is treated as that old
 * and the predictor fast-forwards empty ticks so the tagged clientTick is
 * close to the server's current tick.
 */
export class ClientPredictor {
  predicted: MatchState | null = null;
  pending: PendingInput[] = [];

  constructor(
    readonly player: 1 | 2,
    readonly oneWayDelayMs = 0,
  ) {}

  reconcile(server: MatchState): void {
    this.pending = this.pending.filter((input) => input.tick > server.tick);
    let next = cloneState(server);

    for (const input of this.pending) {
      next = step(next, [{ player: this.player, direction: input.direction }]).state;
    }

    const catchUp = Math.round(this.oneWayDelayMs / (1000 / 20));
    for (let i = 0; i < catchUp; i++) {
      if (next.result || next.paused) break;
      next = step(next, []).state;
    }

    this.predicted = next;
  }

  applyInput(direction: Direction): { clientTick: number; intendedCell: Position } {
    if (!this.predicted) {
      throw new Error('ClientPredictor.applyInput called before reconcile');
    }

    const playerState = this.player === 1 ? this.predicted.player1 : this.predicted.player2;
    const intendedCell = { x: playerState.position.x, y: playerState.position.y };
    const clientTick = this.predicted.tick;

    this.pending.push({ direction, tick: clientTick });
    this.predicted = step(this.predicted, [{ player: this.player, direction }]).state;

    return { clientTick, intendedCell };
  }

  view(): PredictedView {
    if (!this.predicted) {
      throw new Error('ClientPredictor.view called before reconcile');
    }
    const playerState = this.player === 1 ? this.predicted.player1 : this.predicted.player2;
    return {
      grid: this.predicted.grid,
      head: { x: playerState.position.x, y: playerState.position.y },
      tick: this.predicted.tick,
      direction: playerState.direction,
    };
  }

  gridDiff(serverGrid: CellType[][]): number {
    if (!this.predicted) return Infinity;
    let diffs = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (this.predicted.grid[y][x] !== serverGrid[y][x]) diffs++;
      }
    }
    return diffs;
  }
}
