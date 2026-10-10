import {
  Direction,
  MatchState,
  PlayerState,
  Position,
  CellType,
  GRID_SIZE,
} from '@turf-duel/engine';
import {
  isOppositeDirection,
  getNextPosition,
  isOutOfBounds,
  isPlayerTerritory,
  isPlayerTrail,
} from '@turf-duel/engine';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export class Bot {
  private difficulty: BotDifficulty;
  private player: 1 | 2;
  private rng: () => number;

  constructor(difficulty: BotDifficulty, player: 1 | 2, seed?: number) {
    this.difficulty = difficulty;
    this.player = player;
    
    if (seed !== undefined) {
      this.rng = seededRandom(seed);
    } else {
      this.rng = Math.random;
    }
  }

  getNextMove(state: MatchState): Direction {
    const playerState = this.player === 1 ? state.player1 : state.player2;
    const opponentState = this.player === 1 ? state.player2 : state.player1;

    switch (this.difficulty) {
      case 'easy':
        return this.getEasyMove(state, playerState, opponentState);
      case 'normal':
        return this.getNormalMove(state, playerState, opponentState);
      case 'hard':
        return this.getHardMove(state, playerState, opponentState);
    }
  }

  private getEasyMove(state: MatchState, player: PlayerState, opponent: PlayerState): Direction {
    const validDirections = this.getValidDirections(state, player);
    
    if (validDirections.length === 0) {
      return player.direction;
    }
    
    const preferredDirection = this.getDirectionTowardEmptySpace(state, player, validDirections);
    if (preferredDirection) {
      return preferredDirection;
    }
    
    return validDirections[Math.floor(this.rng() * validDirections.length)];
  }

  private getNormalMove(state: MatchState, player: PlayerState, opponent: PlayerState): Direction {
    const validDirections = this.getValidDirections(state, player);
    
    if (validDirections.length === 0) {
      return player.direction;
    }

    const inOwnTerritory = isPlayerTerritory(
      state.grid[player.position.y][player.position.x],
      this.player
    );

    if (!inOwnTerritory) {
      const returnDirection = this.getDirectionTowardTerritory(state, player, validDirections);
      if (returnDirection && this.rng() < 0.7) {
        return returnDirection;
      }
    }

    const expandDirection = this.getDirectionTowardEmptySpace(state, player, validDirections);
    if (expandDirection) {
      return expandDirection;
    }

    return validDirections[Math.floor(this.rng() * validDirections.length)];
  }

  private getHardMove(state: MatchState, player: PlayerState, opponent: PlayerState): Direction {
    const validDirections = this.getValidDirections(state, player);
    
    if (validDirections.length === 0) {
      return player.direction;
    }

    const inOwnTerritory = isPlayerTerritory(
      state.grid[player.position.y][player.position.x],
      this.player
    );

    const cutDirection = this.getDirectionToCutOpponent(state, player, opponent, validDirections);
    if (cutDirection && this.rng() < 0.8) {
      return cutDirection;
    }

    if (!inOwnTerritory) {
      const returnDirection = this.getDirectionTowardTerritory(state, player, validDirections);
      if (returnDirection && this.rng() < 0.6) {
        return returnDirection;
      }
    }

    const expandDirection = this.getDirectionTowardLargestSpace(state, player, validDirections);
    if (expandDirection) {
      return expandDirection;
    }

    return validDirections[Math.floor(this.rng() * validDirections.length)];
  }

  private getValidDirections(state: MatchState, player: PlayerState): Direction[] {
    const allDirections = [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT];
    const valid: Direction[] = [];

    for (const dir of allDirections) {
      if (isOppositeDirection(player.direction, dir)) {
        continue;
      }

      const nextPos = getNextPosition(player.position, dir);
      
      if (isOutOfBounds(nextPos)) {
        continue;
      }

      const cell = state.grid[nextPos.y][nextPos.x];
      const inOwnTerritory = isPlayerTerritory(cell, this.player);
      
      if (!inOwnTerritory && isPlayerTrail(cell, this.player)) {
        continue;
      }

      valid.push(dir);
    }

    return valid;
  }

  private getDirectionTowardEmptySpace(
    state: MatchState,
    player: PlayerState,
    validDirections: Direction[]
  ): Direction | null {
    const scores = validDirections.map(dir => {
      const nextPos = getNextPosition(player.position, dir);
      const cell = state.grid[nextPos.y][nextPos.x];
      return cell === CellType.EMPTY ? 1 : 0;
    });

    const maxScore = Math.max(...scores);
    if (maxScore === 0) return null;

    const bestDirs = validDirections.filter((_, i) => scores[i] === maxScore);
    return bestDirs[Math.floor(this.rng() * bestDirs.length)];
  }

  private getDirectionTowardTerritory(
    state: MatchState,
    player: PlayerState,
    validDirections: Direction[]
  ): Direction | null {
    let closestDist = Infinity;
    let bestDir: Direction | null = null;

    for (const dir of validDirections) {
      const nextPos = getNextPosition(player.position, dir);
      const dist = this.getDistanceToNearestTerritory(state, nextPos);
      
      if (dist < closestDist) {
        closestDist = dist;
        bestDir = dir;
      }
    }

    return bestDir;
  }

  private getDistanceToNearestTerritory(state: MatchState, from: Position): number {
    let minDist = Infinity;

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (isPlayerTerritory(state.grid[y][x], this.player)) {
          const dist = Math.abs(from.x - x) + Math.abs(from.y - y);
          minDist = Math.min(minDist, dist);
        }
      }
    }

    return minDist;
  }

  private getDirectionToCutOpponent(
    state: MatchState,
    player: PlayerState,
    opponent: PlayerState,
    validDirections: Direction[]
  ): Direction | null {
    for (const dir of validDirections) {
      const nextPos = getNextPosition(player.position, dir);
      const cell = state.grid[nextPos.y][nextPos.x];
      const opponentPlayer = this.player === 1 ? 2 : 1;
      
      if (isPlayerTrail(cell, opponentPlayer as 1 | 2)) {
        return dir;
      }
    }

    return null;
  }

  private getDirectionTowardLargestSpace(
    state: MatchState,
    player: PlayerState,
    validDirections: Direction[]
  ): Direction | null {
    const scores = validDirections.map(dir => {
      const nextPos = getNextPosition(player.position, dir);
      return this.countReachableEmptyCells(state, nextPos, 5);
    });

    const maxScore = Math.max(...scores);
    const bestDirs = validDirections.filter((_, i) => scores[i] === maxScore);
    return bestDirs[Math.floor(this.rng() * bestDirs.length)];
  }

  private countReachableEmptyCells(state: MatchState, start: Position, maxDepth: number): number {
    const visited = new Set<string>();
    const queue: { pos: Position; depth: number }[] = [{ pos: start, depth: 0 }];
    let count = 0;

    while (queue.length > 0) {
      const { pos, depth } = queue.shift()!;
      const key = `${pos.x},${pos.y}`;

      if (visited.has(key) || depth > maxDepth) continue;
      visited.add(key);

      const cell = state.grid[pos.y][pos.x];
      if (cell === CellType.EMPTY) count++;

      if (depth < maxDepth) {
        const neighbors = [
          { x: pos.x + 1, y: pos.y },
          { x: pos.x - 1, y: pos.y },
          { x: pos.x, y: pos.y + 1 },
          { x: pos.x, y: pos.y - 1 },
        ];

        for (const n of neighbors) {
          if (!isOutOfBounds(n) && !visited.has(`${n.x},${n.y}`)) {
            queue.push({ pos: n, depth: depth + 1 });
          }
        }
      }
    }

    return count;
  }
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
