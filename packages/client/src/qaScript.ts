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


export function p2SkyWaypoints(): Waypoint[] {
  return [
    { x: 100, y: 12 },
    { x: 158, y: 18 },
    { x: 176, y: 42 },
    { x: 150, y: 52 },
    { x: 172, y: 78 },
    { x: 176, y: 110 },
    { x: 154, y: 128 },
    { x: 170, y: 150 },
  ];
}

export class QaPilot {
  private i = 0;
  constructor(
    private readonly pts: Waypoint[],
    private readonly startTick = 0,
  ) {}

  next(pos: Waypoint, tick = 0): { heading: number; thrusting: boolean } {
    if (tick < this.startTick) {
      return { heading: 0, thrusting: false };
    }
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
