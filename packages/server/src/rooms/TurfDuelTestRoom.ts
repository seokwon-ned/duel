import { TurfDuelRoom } from './TurfDuelRoom.js';
import { Direction, MatchState } from '@turf-duel/engine';

export interface TurnLog {
  tick: number;
  player: 1 | 2;
  position: { x: number; y: number };
  oldDirection: Direction;
  newDirection: Direction;
}

/** In-process registry so E2E tests can read turn logs / authority state. */
export const testRooms = new Map<string, TurfDuelTestRoom>();

/**
 * Test-only subclass: fault injection + turn-cell logging.
 * Never registered by the production server.
 */
export class TurfDuelTestRoom extends TurfDuelRoom {
  public turnLogs: TurnLog[] = [];

  onCreate(options: any) {
    super.onCreate(options);
    if (this.roomId) {
      testRooms.set(this.roomId, this);
    }
  }

  onJoin(client: any, options: any) {
    super.onJoin(client, options);
    testRooms.set(this.roomId, this);
  }

  // Prediction/fault tests must not open a 30s reconnection window on cleanup.
  async onLeave(client: any, code?: number): Promise<void> {
    const playerNum = this.playerMapping.get(client.sessionId);
    console.log(`Test room: player ${playerNum} left ${client.sessionId} (code: ${code}), skip reconnection`);
  }

  onDispose() {
    testRooms.delete(this.roomId);
    super.onDispose();
  }

  getAuthorityState(): MatchState {
    return this.matchState;
  }

  protected override onBeforeTick(): void {
    if (
      process.env.TURF_DUEL_TEST_INJECT_FAULT === 'true' &&
      (global as any).FAULT_ROOM_ID === this.roomId &&
      this.matchState.tick > 10 &&
      this.matchState.tick < 15
    ) {
      console.log(`[TEST] Injecting fault in room ${this.roomId} at tick ${this.matchState.tick}`);
      throw new Error('TEST_INJECTED_FAULT');
    }
  }

  protected override onInputApplied(
    player: 1 | 2,
    tick: number,
    position: { x: number; y: number },
    oldDirection: Direction,
    newDirection: Direction,
  ): void {
    this.turnLogs.push({ tick, player, position, oldDirection, newDirection });
  }
}
