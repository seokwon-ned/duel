/** Scripted engine run for QA screenshots. Real step()/claimClosedTrail, no painted territory. */

export interface Waypoint {
  x: number;
  y: number;
}

export function headingCardinal(from: Waypoint, to: Waypoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 128;
  return dy >= 0 ? 64 : 192;
}

export function p1CaptureWaypoints(): Waypoint[] {
  return [
    { x: 100, y: 270 },
    { x: 40, y: 270 },
    { x: 40, y: 298 },
    { x: 100, y: 298 },
    { x: 100, y: 200 },
    { x: 16, y: 200 },
    { x: 16, y: 298 },
    { x: 40, y: 298 },
    { x: 100, y: 55 },
    { x: 14, y: 55 },
    { x: 14, y: 200 },
    { x: 16, y: 200 },
    { x: 100, y: 200 },
    { x: 142, y: 200 },
    { x: 148, y: 248 },
    { x: 140, y: 255 },
    { x: 100, y: 255 },
  ];
}

export function p1HitWaypoints(): Waypoint[] {
  return [
    { x: 100, y: 270 },
    { x: 40, y: 270 },
    { x: 40, y: 298 },
    { x: 100, y: 298 },
    { x: 100, y: 200 },
    { x: 16, y: 200 },
    { x: 16, y: 298 },
    { x: 40, y: 298 },
    { x: 100, y: 55 },
    { x: 14, y: 55 },
    { x: 14, y: 200 },
    { x: 16, y: 200 },
    { x: 100, y: 298 },
    { x: 100, y: 299 },
  ];
}

export function p2ZigzagWaypoints(): Waypoint[] {
  const pts: Waypoint[] = [{ x: 100, y: 10 }];
  for (let i = 0; i < 16; i++) {
    const y = 10 + i * 6;
    if (i % 2 === 0) {
      pts.push({ x: 178, y }, { x: 178, y: y + 6 });
    } else {
      pts.push({ x: 118, y }, { x: 118, y: y + 6 });
    }
  }
  return pts;
}

export class QaPilot {
  private i = 0;
  constructor(private readonly pts: Waypoint[]) {}

  next(pos: Waypoint): { heading: number; thrusting: boolean } {
    while (
      this.i < this.pts.length &&
      pos.x === this.pts[this.i].x &&
      pos.y === this.pts[this.i].y
    ) {
      this.i++;
    }
    if (this.i >= this.pts.length) {
      return { heading: 0, thrusting: false };
    }
    return { heading: headingCardinal(pos, this.pts[this.i]), thrusting: true };
  }
}
