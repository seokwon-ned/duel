import { TurfDuelRoom } from './TurfDuelRoom.js';
import { MatchState } from '@turf-duel/engine';

/** In-process registry so E2E tests can read authority state. */
export const testRooms = new Map<string, TurfDuelTestRoom>();

/**
 * Test-only subclass: fault injection.
 * Never registered by the production server.
 */
export class TurfDuelTestRoom extends TurfDuelRoom {
  protected override allowClientMatchTicks(): boolean {
    return true;
  }

  protected override allowClientSeed(): boolean {
    return true;
  }

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

  // Fault/cleanup must not open a reconnection window or forfeit.
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

  /** Freeze ticks and emit one last patch so clients are not one tick behind. */
  stopSimulationAndFlush(): void {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    this.matchState.paused = true;
    this.broadcastPatch();
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
}
