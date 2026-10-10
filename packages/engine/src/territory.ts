import {
  CellType,
  Position,
  GRID_SIZE,
} from './types.js';
import {
  getPlayerTerritoryType,
  getPlayerTrailType,
  isPlayerTerritory,
  isPlayerTrail,
  getOpponentTrailType,
  cloneGrid,
} from './utils.js';

export function closeTerritoryForPlayer(
  grid: CellType[][],
  player: 1 | 2,
  playerPos: Position,
  opponentPos: Position,
  opponentTrailPositions: Position[]
): { grid: CellType[][]; cellsCaptured: number } {
  const newGrid = cloneGrid(grid);
  const territoryType = getPlayerTerritoryType(player);
  const trailType = getPlayerTrailType(player);
  const opponentTrail = getOpponentTrailType(player);

  const trailPositions: Position[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (newGrid[y][x] === trailType) {
        trailPositions.push({ x, y });
      }
    }
  }

  if (trailPositions.length === 0) {
    return { grid: newGrid, cellsCaptured: 0 };
  }

  const enclosed = findEnclosedArea(newGrid, trailPositions, territoryType);

  const opponentPosSet = new Set([`${opponentPos.x},${opponentPos.y}`]);
  for (const pos of opponentTrailPositions) {
    opponentPosSet.add(`${pos.x},${pos.y}`);
  }

  let cellsCaptured = 0;
  for (const pos of enclosed) {
    const key = `${pos.x},${pos.y}`;
    if (!opponentPosSet.has(key)) {
      newGrid[pos.y][pos.x] = territoryType;
      cellsCaptured++;
    }
  }

  for (const pos of trailPositions) {
    newGrid[pos.y][pos.x] = territoryType;
  }

  return { grid: newGrid, cellsCaptured };
}

function findEnclosedArea(
  grid: CellType[][],
  trailPositions: Position[],
  territoryType: CellType
): Position[] {
  const enclosed: Position[] = [];
  const visited = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(false)
  );

  for (const pos of trailPositions) {
    visited[pos.y][pos.x] = true;
  }

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x] === territoryType) {
        visited[y][x] = true;
      }
    }
  }

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (!visited[y][x]) {
        const region = floodFill(grid, { x, y }, visited, territoryType, trailPositions);
        if (region.isEnclosed) {
          enclosed.push(...region.cells);
        }
      }
    }
  }

  return enclosed;
}

function floodFill(
  grid: CellType[][],
  start: Position,
  visited: boolean[][],
  territoryType: CellType,
  trailPositions: Position[]
): { cells: Position[]; isEnclosed: boolean } {
  const cells: Position[] = [];
  const queue: Position[] = [start];
  visited[start.y][start.x] = true;
  let touchesBorder = false;

  while (queue.length > 0) {
    const pos = queue.shift()!;
    cells.push(pos);

    if (pos.x === 0 || pos.x === GRID_SIZE - 1 || pos.y === 0 || pos.y === GRID_SIZE - 1) {
      touchesBorder = true;
    }

    const neighbors = [
      { x: pos.x + 1, y: pos.y },
      { x: pos.x - 1, y: pos.y },
      { x: pos.x, y: pos.y + 1 },
      { x: pos.x, y: pos.y - 1 },
    ];

    for (const n of neighbors) {
      if (n.x >= 0 && n.x < GRID_SIZE && n.y >= 0 && n.y < GRID_SIZE && !visited[n.y][n.x]) {
        if (grid[n.y][n.x] !== territoryType) {
          const isTrail = trailPositions.some(t => t.x === n.x && t.y === n.y);
          if (!isTrail) {
            visited[n.y][n.x] = true;
            queue.push(n);
          }
        }
      }
    }
  }

  return { cells, isEnclosed: !touchesBorder };
}

export function countTerritoryCells(grid: CellType[][], player: 1 | 2): number {
  const territoryType = getPlayerTerritoryType(player);
  let count = 0;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x] === territoryType) {
        count++;
      }
    }
  }
  return count;
}
