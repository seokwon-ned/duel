import { TurfDuelRoom } from './TurfDuelRoom.js';

/** In-process registry so E2E tests can advance disconnect time. */
export const clockRooms = new Map<string, TurfDuelClockRoom>();

/**
 * Test-only subclass: fake wall clock for disconnect limits.
 * Production 30s budget, 1s reconnect window. Never registered by the production server.
 */
export class TurfDuelClockRoom extends TurfDuelRoom {
  fakeNow = Date.now();
  protected readonly maxDisconnectMs = 30000;

  onCreate(options: any) {
    super.onCreate(options);
    if (this.roomId) {
      clockRooms.set(this.roomId, this);
    }
  }

  onJoin(client: any, options: any) {
    super.onJoin(client, options);
    clockRooms.set(this.roomId, this);
  }

  onDispose() {
    clockRooms.delete(this.roomId);
    super.onDispose();
  }

  advance(ms: number): void {
    this.fakeNow += ms;
  }

  protected now(): number {
    return this.fakeNow;
  }

  protected reconnectionWindowSeconds(): number {
    return 1;
  }
}
