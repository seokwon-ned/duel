import { CellType, Direction, Position } from './types.js';

export function isOpened(cell: CellType): boolean {
  return cell === CellType.PLAYER1_OPEN || cell === CellType.PLAYER2_OPEN || cell === CellType.SAFE_EDGE;
}

export function isCover(cell: CellType): boolean {
  return cell === CellType.COVER;
}

export function isTrail(cell: CellType, player?: 1 | 2): boolean {
  if (player === 1) return cell === CellType.PLAYER1_TRAIL;
  if (player === 2) return cell === CellType.PLAYER2_TRAIL;
  return cell === CellType.PLAYER1_TRAIL || cell === CellType.PLAYER2_TRAIL;
}

export function playerOpenType(player: 1 | 2): CellType {
  return player === 1 ? CellType.PLAYER1_OPEN : CellType.PLAYER2_OPEN;
}

export function playerTrailType(player: 1 | 2): CellType {
  return player === 1 ? CellType.PLAYER1_TRAIL : CellType.PLAYER2_TRAIL;
}

export function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

export function positionsEqual(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

export const CARDINAL: ReadonlyArray<{ x: number; y: number }> = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

export function isOppositeDirection(current: Direction, input: Direction): boolean {
  return (
    (current === Direction.UP && input === Direction.DOWN) ||
    (current === Direction.DOWN && input === Direction.UP) ||
    (current === Direction.LEFT && input === Direction.RIGHT) ||
    (current === Direction.RIGHT && input === Direction.LEFT)
  );
}

export function flattenGrid(grid: CellType[][]): Uint8Array {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const buf = new Uint8Array(w * h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const row = grid[y];
    for (let x = 0; x < w; x++) buf[i++] = row[x];
  }
  return buf;
}

export function inflateGrid(buf: ArrayLike<number>, w: number, h: number): CellType[][] {
  const grid: CellType[][] = Array.from({ length: h }, () => Array<CellType>(w).fill(CellType.COVER));
  const n = Math.min(buf.length, w * h);
  for (let i = 0; i < n; i++) {
    grid[(i / w) | 0][i % w] = buf[i] as CellType;
  }
  return grid;
}

export function hashStateCells(grid: CellType[][], extra: number[]): number {
  let h = 2166136261;
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      h ^= row[x];
      h = Math.imul(h, 16777619);
    }
  }
  for (const n of extra) {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
