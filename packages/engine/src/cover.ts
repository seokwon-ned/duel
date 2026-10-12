import { CellType, Position } from './types.js';
import { CARDINAL, inBounds, isCover, playerOpenType } from './utils.js';

export function countCells(grid: CellType[][], type: CellType): number {
  let n = 0;
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === type) n++;
    }
  }
  return n;
}

export function countCover(grid: CellType[][]): number {
  return countCells(grid, CellType.COVER);
}

/**
 * Convert the closed trail to the player's color, then claim every COVER
 * region that does not contain the boss. Integer BFS, 4-connected.
 */
export function claimClosedTrail(
  grid: CellType[][],
  trail: Position[],
  player: 1 | 2,
  boss: Position,
): { claimed: number; remainingCover: number } {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const paint = playerOpenType(player);

  for (const p of trail) {
    if (inBounds(p.x, p.y, w, h)) {
      grid[p.y][p.x] = paint;
    }
  }

  const visited = Array.from({ length: h }, () => Array(w).fill(false));
  const queue: Position[] = [];

  if (inBounds(boss.x, boss.y, w, h) && isCover(grid[boss.y][boss.x])) {
    visited[boss.y][boss.x] = true;
    queue.push({ x: boss.x, y: boss.y });
  }

  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const d of CARDINAL) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      if (!inBounds(nx, ny, w, h) || visited[ny][nx]) continue;
      if (!isCover(grid[ny][nx])) continue;
      visited[ny][nx] = true;
      queue.push({ x: nx, y: ny });
    }
  }

  let claimed = 0;
  let remainingCover = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isCover(grid[y][x])) continue;
      if (visited[y][x]) {
        remainingCover++;
      } else {
        grid[y][x] = paint;
        claimed++;
      }
    }
  }

  return { claimed, remainingCover };
}
