import { describe, expect, test } from 'vitest';
import { accumulateCellUpdates, shouldSnapshotCellUpdates } from './cellUpdates.js';

describe('cellUpdates accumulate (P1-3)', () => {
  test('two ticks in one patch keep both batches', () => {
    const pending = new Map<string, { x: number; y: number; type: number }>();
    accumulateCellUpdates(pending, [{ x: 1, y: 2, type: 3 }]);
    const merged = accumulateCellUpdates(pending, [{ x: 4, y: 5, type: 1 }]);
    expect(merged).toEqual([
      { x: 1, y: 2, type: 3 },
      { x: 4, y: 5, type: 1 },
    ]);
  });

  test('later write to the same cell wins', () => {
    const pending = new Map<string, { x: number; y: number; type: number }>();
    accumulateCellUpdates(pending, [{ x: 1, y: 1, type: 3 }]);
    const merged = accumulateCellUpdates(pending, [{ x: 1, y: 1, type: 1 }]);
    expect(merged).toEqual([{ x: 1, y: 1, type: 1 }]);
  });

  test('large pending requests a snapshot', () => {
    expect(shouldSnapshotCellUpdates(257)).toBe(true);
    expect(shouldSnapshotCellUpdates(10)).toBe(false);
  });

  test('clearing after a patch leaves only the next tick\'s cells', () => {
    const pending = new Map<string, { x: number; y: number; type: number }>();
    accumulateCellUpdates(pending, [{ x: 1, y: 1, type: 3 }]);
    pending.clear();
    const next = accumulateCellUpdates(pending, [{ x: 2, y: 2, type: 1 }]);
    expect(next).toEqual([{ x: 2, y: 2, type: 1 }]);
  });
});
