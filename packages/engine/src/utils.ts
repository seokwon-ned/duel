import {
  Direction,
  Position,
  CellType,
  GRID_SIZE,
} from './types.js';

export function isOppositeDirection(current: Direction, input: Direction): boolean {
  return (
    (current === Direction.UP && input === Direction.DOWN) ||
    (current === Direction.DOWN && input === Direction.UP) ||
    (current === Direction.LEFT && input === Direction.RIGHT) ||
    (current === Direction.RIGHT && input === Direction.LEFT)
  );
}

export function getNextPosition(pos: Position, dir: Direction): Position {
  switch (dir) {
    case Direction.UP:
      return { x: pos.x, y: pos.y - 1 };
    case Direction.DOWN:
      return { x: pos.x, y: pos.y + 1 };
    case Direction.LEFT:
      return { x: pos.x - 1, y: pos.y };
    case Direction.RIGHT:
      return { x: pos.x + 1, y: pos.y };
  }
}

export function isOutOfBounds(pos: Position): boolean {
  return pos.x < 0 || pos.x >= GRID_SIZE || pos.y < 0 || pos.y >= GRID_SIZE;
}

export function positionsEqual(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

export function isPlayerTerritory(cell: CellType, player: 1 | 2): boolean {
  return player === 1 ? cell === CellType.PLAYER1_TERRITORY : cell === CellType.PLAYER2_TERRITORY;
}

export function isPlayerTrail(cell: CellType, player: 1 | 2): boolean {
  return player === 1 ? cell === CellType.PLAYER1_TRAIL : cell === CellType.PLAYER2_TRAIL;
}

export function getPlayerTrailType(player: 1 | 2): CellType {
  return player === 1 ? CellType.PLAYER1_TRAIL : CellType.PLAYER2_TRAIL;
}

export function getPlayerTerritoryType(player: 1 | 2): CellType {
  return player === 1 ? CellType.PLAYER1_TERRITORY : CellType.PLAYER2_TERRITORY;
}

export function getOpponentTerritoryType(player: 1 | 2): CellType {
  return player === 1 ? CellType.PLAYER2_TERRITORY : CellType.PLAYER1_TERRITORY;
}

export function getOpponentTrailType(player: 1 | 2): CellType {
  return player === 1 ? CellType.PLAYER2_TRAIL : CellType.PLAYER1_TRAIL;
}

export function cloneGrid(grid: CellType[][]): CellType[][] {
  return grid.map(row => [...row]);
}
