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

  const visited = Array.from({ length: h }, () => Array(w).fill(false));
  const queue: Position[] = [];

  const enqueueCover = (x: number, y: number) => {
    if (!inBounds(x, y, w, h) || visited[y][x] || !isCover(grid[y][x])) return;
    visited[y][x] = true;
    queue.push({ x, y });
  };

  // Seed from the live boss cell before the trail is painted so a boss standing
  // on the line still belongs to a cover region instead of vanishing.
  enqueueCover(boss.x, boss.y);
  if (queue.length === 0) {
    for (const d of CARDINAL) {
      enqueueCover(boss.x + d.x, boss.y + d.y);
    }
  }

  for (const p of trail) {
    if (inBounds(p.x, p.y, w, h)) {
      grid[p.y][p.x] = paint;
    }
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
