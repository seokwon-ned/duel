export const CELL_UPDATE_SNAPSHOT_THRESHOLD = 256;

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Merge a batch into pending so two ticks in one schema write are not lost. The room clears pending after copying into the outgoing patch. */
export function accumulateCellUpdates<T extends { x: number; y: number }>(
  pending: Map<string, T>,
  batch: T[],
): T[] {
  for (const item of batch) {
    pending.set(cellKey(item.x, item.y), item);
  }
  return [...pending.values()];
}

export function shouldSnapshotCellUpdates(pendingCount: number, threshold = CELL_UPDATE_SNAPSHOT_THRESHOLD): boolean {
  return pendingCount > threshold;
}
