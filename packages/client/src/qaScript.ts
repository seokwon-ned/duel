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
    // First closed cut: left-center window so sun / hills / water / cottage show (~26%).
    { x: 100, y: 268 },
    { x: 18, y: 268 },
    { x: 18, y: 72 },
    { x: 88, y: 72 },
    { x: 88, y: 298 },
    { x: 100, y: 298 },
    // Second live line (match screenshot: claimed landscape + thick neon + orb).
    { x: 100, y: 250 },
    { x: 100, y: 188 },
    { x: 148, y: 188 },
    { x: 148, y: 250 },
    { x: 100, y: 250 },
    { x: 100, y: 298 },
  ];
}

export function p1HitWaypoints(): Waypoint[] {
  return [
    { x: 100, y: 268 },
    { x: 18, y: 268 },
    { x: 18, y: 72 },
    { x: 88, y: 72 },
    { x: 88, y: 298 },
    { x: 100, y: 298 },
    { x: 100, y: 250 },
    { x: 100, y: 298 },
    { x: 100, y: 299 },
  ];
}

export function p2SkyWaypoints(): Waypoint[] {
  return [
    { x: 100, y: 12 },
    { x: 168, y: 18 },
    { x: 184, y: 48 },
    { x: 160, y: 70 },
    { x: 182, y: 110 },
    { x: 168, y: 148 },
    { x: 186, y: 188 },
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
