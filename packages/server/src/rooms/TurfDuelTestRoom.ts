import { TurfDuelRoom } from './TurfDuelRoom.js';
import { step, TICKS_PER_SECOND } from '@turf-duel/engine';

/**
 * Test-only subclass for fault injection
 * Used only in e2e-fault-isolation.ts
 */
export class TurfDuelTestRoom extends TurfDuelRoom {
  protected override startGame(): void {
    console.log('Starting game loop at 20Hz (TEST MODE with fault injection)');
    
    const tickInterval = 1000 / TICKS_PER_SECOND;
    
    // Track per-second bandwidth
    const bandwidthInterval = setInterval(() => {
      for (const [sessionId] of this.playerMapping) {
        const current = this.bytesSentPerPlayer.get(sessionId) || 0;
        const perSecondList = this.bytesPerSecondPerPlayer.get(sessionId) || [];
        
        // Calculate bytes sent in this second
        const lastTotal = perSecondList.length > 0 ? 
          perSecondList.reduce((sum, b) => sum + b, 0) : 0;
        const bytesThisSecond = current - lastTotal;
        
        perSecondList.push(bytesThisSecond);
        this.bytesPerSecondPerPlayer.set(sessionId, perSecondList);
      }
    }, 1000);
    
    this.gameLoop = setInterval(() => {
      const now = Date.now();
      if (this.lastTickTime > 0) {
        const interval = now - this.lastTickTime;
        this.tickIntervals.push(interval);
        
        // Log tick interval distribution every 60 seconds
        if (this.tickIntervals.length === 1200) { // 60s * 20 ticks/s
          const within50ms = this.tickIntervals.filter(i => Math.abs(i - 50) <= 5).length;
          const percentage = (within50ms / this.tickIntervals.length) * 100;
          
          const sorted = [...this.tickIntervals].sort((a, b) => a - b);
          const p50 = sorted[Math.floor(sorted.length * 0.5)];
          const p95 = sorted[Math.floor(sorted.length * 0.95)];
          const p99 = sorted[Math.floor(sorted.length * 0.99)];
          const min = sorted[0];
          const max = sorted[sorted.length - 1];
          
          console.log(`\n=== Tick Interval Accuracy (1 min) ===`);
          console.log(`Within 50±5ms: ${within50ms}/${this.tickIntervals.length} (${percentage.toFixed(2)}%)`);
          console.log(`Distribution: min=${min.toFixed(1)}ms, p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, p99=${p99.toFixed(1)}ms, max=${max.toFixed(1)}ms`);
          console.log(`Target: ≥99%\n`);
          
          this.tickIntervals = [];
        }
      }
      this.lastTickTime = now;
      
      if (!this.matchState.paused && this.matchState.result === null) {
        try {
          // TEST-ONLY FAULT INJECTION
          if (process.env.TURF_DUEL_TEST_INJECT_FAULT === 'true' && 
              (global as any).FAULT_ROOM_ID === this.roomId &&
              this.matchState.tick > 10 &&
              this.matchState.tick < 15) {
            console.log(`[TEST] Injecting fault in room ${this.roomId} at tick ${this.matchState.tick}`);
            throw new Error('TEST_INJECTED_FAULT');
          }

          const inputs = [...this.inputQueue];
          this.inputQueue = [];
          
          const result = step(this.matchState, inputs);
          this.matchState = result.state;
          this.syncState();

          if (this.matchState.result !== null) {
            clearInterval(bandwidthInterval);
            console.log('Match ended:', this.matchState.result);
            this.logBandwidth();
          }
        } catch (error) {
          console.error(`Room ${this.roomId} tick error:`, error);
          clearInterval(bandwidthInterval);
          if (this.gameLoop) {
            clearInterval(this.gameLoop);
          }
          this.disconnect().catch(err => console.error('Failed to dispose room:', err));
        }
      }
    }, tickInterval);
  }
}
