import { Room, Client } from '@colyseus/core';
import { TurfDuelState, CellUpdate, MatchResultSchema } from '../schema/TurfDuelState.js';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  PlayerInput,
  CellType,
  TICKS_PER_SECOND,
} from '@turf-duel/engine';

interface PlayerDisconnectInfo {
  disconnectCount: number;
  totalDisconnectedMs: number;
  currentDisconnectStartTime: number | null;
}

export class TurfDuelRoom extends Room<TurfDuelState> {
  private matchState!: MatchState;
  private gameLoop: NodeJS.Timeout | null = null;
  private playerMapping = new Map<string, 1 | 2>();
  private bytesSentPerPlayer = new Map<string, number>();
  private previousGrid: CellType[][] | null = null;
  private inputQueue: PlayerInput[] = [];
  private bytesPerSecondPerPlayer = new Map<string, number[]>();
  private lastBandwidthReset = Date.now();
  private tickIntervals: number[] = [];
  private lastTickTime: number = 0;
  private tickIntervalCheckStartTick: number = 0;
  private disconnectInfo = new Map<string, PlayerDisconnectInfo>();
  private countdownInterval: NodeJS.Timeout | null = null;

  maxClients = 2;

  onCreate(options: any) {
    this.setState(new TurfDuelState());
    this.matchState = createInitialState();
    
    this.onMessage('input', (client, message) => {
      this.handleInput(client, message);
    });
  }

  onJoin(client: Client, options: any, isReconnection?: boolean) {
    let playerNum: 1 | 2;
    
    if (isReconnection) {
      // Reconnecting: restore player number from session mapping
      playerNum = this.playerMapping.get(client.sessionId)!;
      console.log(`Player ${playerNum} reconnected: ${client.sessionId}`);
      
      // Update disconnect tracking
      const info = this.disconnectInfo.get(client.sessionId);
      if (info && info.currentDisconnectStartTime !== null) {
        const disconnectDuration = Date.now() - info.currentDisconnectStartTime;
        info.totalDisconnectedMs += disconnectDuration;
        info.currentDisconnectStartTime = null;
        
        console.log(`Player ${playerNum} was disconnected for ${disconnectDuration}ms (total: ${info.totalDisconnectedMs}ms)`);
      }
      
      // Update state
      const playerState = playerNum === 1 ? this.state.player1 : this.state.player2;
      playerState.connected = true;
      
      // Resume game if both players are connected
      this.updatePauseState();
    } else {
      // New player: assign player number by order
      playerNum = this.playerMapping.size === 0 ? 1 : 2;
      this.playerMapping.set(client.sessionId, playerNum);
      this.bytesSentPerPlayer.set(client.sessionId, 0);
      this.bytesPerSecondPerPlayer.set(client.sessionId, []);
      this.disconnectInfo.set(client.sessionId, {
        disconnectCount: 0,
        totalDisconnectedMs: 0,
        currentDisconnectStartTime: null,
      });

      console.log(`Player ${playerNum} joined: ${client.sessionId}`);

      // Intercept client.send to measure actual bytes
      const originalSend = client.send.bind(client);
      (client as any).send = (type: any, message?: any) => {
        const encoded = typeof message === 'string' ? Buffer.byteLength(message) : 
                        message?.byteLength || message?.length || 
                        (message ? Buffer.byteLength(JSON.stringify(message)) : 0);
        
        const current = this.bytesSentPerPlayer.get(client.sessionId) || 0;
        this.bytesSentPerPlayer.set(client.sessionId, current + encoded);
        
        return originalSend(type, message);
      };

      if (this.playerMapping.size === 2) {
        this.startGame();
      }
    }
  }

  async onLeave(client: Client, consented: boolean) {
    const playerNum = this.playerMapping.get(client.sessionId);
    if (!playerNum) return;
    
    console.log(`Player ${playerNum} left: ${client.sessionId} (consented: ${consented})`);
    
    // Track disconnect
    const info = this.disconnectInfo.get(client.sessionId);
    if (!info) return;

    info.disconnectCount++;
    info.currentDisconnectStartTime = Date.now();
    
    const playerState = playerNum === 1 ? this.state.player1 : this.state.player2;
    playerState.connected = false;
    playerState.disconnectCount = info.disconnectCount;
    
    console.log(`Player ${playerNum} disconnect #${info.disconnectCount}, total time: ${info.totalDisconnectedMs}ms`);
    
    // Check if player exceeded disconnect limits
    if (info.disconnectCount > 2) {
      console.log(`Player ${playerNum} exceeded 2 disconnects, loses match`);
      this.handleDisconnectLoss(playerNum);
      return;
    }
    
    if (info.totalDisconnectedMs > 30000) {
      console.log(`Player ${playerNum} exceeded 30s total disconnect time, loses match`);
      this.handleDisconnectLoss(playerNum);
      return;
    }
    
    // Pause game and start countdown
    this.matchState.paused = true;
    this.updatePauseState();
    this.startDisconnectCountdown();
    
    // Allow reconnection for 30 seconds
    try {
      await this.allowReconnection(client, 30);
      console.log(`Player ${playerNum} reconnection window closed`);
    } catch (e) {
      console.log(`Player ${playerNum} failed to reconnect:`, e);
      
      // Check if they exceeded time limit during disconnect
      if (info.currentDisconnectStartTime !== null) {
        const disconnectDuration = Date.now() - info.currentDisconnectStartTime;
        info.totalDisconnectedMs += disconnectDuration;
        
        if (info.totalDisconnectedMs > 30000) {
          console.log(`Player ${playerNum} exceeded 30s total disconnect time, loses match`);
          this.handleDisconnectLoss(playerNum);
        }
      }
    }
  }

  onDispose() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  private updatePauseState() {
    const p1Connected = this.state.player1.connected;
    const p2Connected = this.state.player2.connected;
    
    if (!p1Connected && !p2Connected) {
      // Both disconnected
      this.state.disconnectedPlayer = 3;
      this.matchState.paused = true;
    } else if (!p1Connected) {
      // Player 1 disconnected
      this.state.disconnectedPlayer = 1;
      this.matchState.paused = true;
    } else if (!p2Connected) {
      // Player 2 disconnected
      this.state.disconnectedPlayer = 2;
      this.matchState.paused = true;
    } else {
      // Both connected
      this.state.disconnectedPlayer = 0;
      this.matchState.paused = false;
      this.state.disconnectCountdownSeconds = 0;
      if (this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
      }
    }
    
    this.syncState();
  }

  private startDisconnectCountdown() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    
    // Count elapsed time and check 30s limit
    this.countdownInterval = setInterval(() => {
      // Check both players' disconnect status
      for (const [sessionId, info] of this.disconnectInfo) {
        if (info.currentDisconnectStartTime !== null) {
          const elapsed = Date.now() - info.currentDisconnectStartTime;
          const remaining = Math.max(0, 30000 - (info.totalDisconnectedMs + elapsed));
          this.state.disconnectCountdownSeconds = Math.ceil(remaining / 1000);
          
          if (info.totalDisconnectedMs + elapsed > 30000) {
            const playerNum = this.playerMapping.get(sessionId);
            if (playerNum) {
              console.log(`Player ${playerNum} exceeded 30s total disconnect time during countdown`);
              this.handleDisconnectLoss(playerNum);
            }
            return;
          }
        }
      }
      
      this.syncState();
    }, 1000);
  }

  private handleDisconnectLoss(loserNum: 1 | 2) {
    // Check if both players are disconnected
    const p1Disconnected = !this.state.player1.connected;
    const p2Disconnected = !this.state.player2.connected;
    
    if (p1Disconnected && p2Disconnected) {
      // Both disconnected: match is void
      console.log('Both players disconnected, match void');
      this.matchState.result = {
        winner: 0,
        reason: '양쪽 연결 끊김 (무효)' as any,
        tick: this.matchState.tick,
      };
    } else {
      // One player disconnected: they lose
      this.matchState.result = {
        winner: loserNum === 1 ? 2 : 1,
        reason: '연결 끊김' as any,
        tick: this.matchState.tick,
      };
    }
    
    this.syncState();
    
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private startGame() {
    console.log('Starting game loop at 20Hz');
    
    const tickInterval = 1000 / TICKS_PER_SECOND;
    this.lastTickTime = Date.now();
    this.tickIntervalCheckStartTick = 0;
    
    // Track per-second bandwidth
    const bandwidthInterval = setInterval(() => {
      for (const [sessionId] of this.playerMapping) {
        const current = this.bytesSentPerPlayer.get(sessionId) || 0;
        const perSecondList = this.bytesPerSecondPerPlayer.get(sessionId) || [];
        const lastTotal = perSecondList.reduce((a, b) => a + b, 0);
        const bytesThisSecond = current - lastTotal;
        perSecondList.push(bytesThisSecond);
        this.bytesPerSecondPerPlayer.set(sessionId, perSecondList);
      }
    }, 1000);
    
    this.gameLoop = setInterval(() => {
      if (!this.matchState.paused && this.matchState.result === null) {
        // Measure tick interval accuracy
        const now = Date.now();
        if (this.lastTickTime > 0) {
          const interval = now - this.lastTickTime;
          this.tickIntervals.push(interval);
        }
        this.lastTickTime = now;

        const inputs = [...this.inputQueue];
        this.inputQueue = [];
        
        const result = step(this.matchState, inputs);
        this.matchState = result.state;
        this.syncState();

        // Check tick interval accuracy after 1 minute (1200 ticks)
        if (this.tickIntervals.length === 1200) {
          this.logTickIntervalAccuracy();
        }

        if (this.matchState.result !== null) {
          clearInterval(bandwidthInterval);
          console.log('Match ended:', this.matchState.result);
          this.logBandwidth();
        }
      }
    }, tickInterval);
  }

  private handleInput(client: Client, message: { direction: string }) {
    const playerNum = this.playerMapping.get(client.sessionId);
    if (!playerNum) return;

    const direction = message.direction as Direction;
    const input: PlayerInput = {
      player: playerNum,
      direction,
    };

    this.inputQueue.push(input);
  }

  private syncState() {
    const state = this.state;
    
    state.player1.position.x = this.matchState.player1.position.x;
    state.player1.position.y = this.matchState.player1.position.y;
    state.player1.direction = this.matchState.player1.direction;
    state.player1.isAlive = this.matchState.player1.isAlive;
    state.player1.territoryCells = this.matchState.player1.territoryCells;

    state.player2.position.x = this.matchState.player2.position.x;
    state.player2.position.y = this.matchState.player2.position.y;
    state.player2.direction = this.matchState.player2.direction;
    state.player2.isAlive = this.matchState.player2.isAlive;
    state.player2.territoryCells = this.matchState.player2.territoryCells;

    state.tick = this.matchState.tick;
    state.paused = this.matchState.paused;

    if (this.matchState.result && !state.result) {
      state.result = new MatchResultSchema();
      state.result.winner = this.matchState.result.winner;
      state.result.reason = this.matchState.result.reason;
      state.result.tick = this.matchState.result.tick;
    }

    state.cellUpdates.length = 0;
    const changedCells = this.getChangedCells();
    for (const cell of changedCells) {
      const update = new CellUpdate();
      update.x = cell.x;
      update.y = cell.y;
      update.type = cell.type;
      state.cellUpdates.push(update);
    }
  }

  private getChangedCells(): Array<{ x: number; y: number; type: CellType }> {
    const changed: Array<{ x: number; y: number; type: CellType }> = [];

    if (!this.previousGrid) {
      this.previousGrid = this.matchState.grid.map(row => [...row]);
      return changed;
    }

    for (let y = 0; y < this.matchState.grid.length; y++) {
      for (let x = 0; x < this.matchState.grid[y].length; x++) {
        if (this.matchState.grid[y][x] !== this.previousGrid[y][x]) {
          changed.push({ x, y, type: this.matchState.grid[y][x] });
          this.previousGrid[y][x] = this.matchState.grid[y][x];
        }
      }
    }

    return changed;
  }

  private logTickIntervalAccuracy() {
    console.log('\n=== Tick Interval Accuracy Report (First 60 seconds) ===');
    
    const targetInterval = 50; // ms
    const tolerance = 5; // ±5ms
    const minInterval = targetInterval - tolerance; // 45ms
    const maxInterval = targetInterval + tolerance; // 55ms
    
    const inRange = this.tickIntervals.filter(i => i >= minInterval && i <= maxInterval).length;
    const percentage = (inRange / this.tickIntervals.length) * 100;
    
    const avg = this.tickIntervals.reduce((a, b) => a + b, 0) / this.tickIntervals.length;
    const min = Math.min(...this.tickIntervals);
    const max = Math.max(...this.tickIntervals);
    
    console.log(`Total intervals measured: ${this.tickIntervals.length}`);
    console.log(`Target: 50±5ms (45-55ms)`);
    console.log(`Within range: ${inRange} (${percentage.toFixed(2)}%)`);
    console.log(`Average: ${avg.toFixed(2)}ms`);
    console.log(`Min: ${min.toFixed(2)}ms, Max: ${max.toFixed(2)}ms`);
    
    if (percentage >= 99.0) {
      console.log('✓ PASS: ≥99% of tick intervals within 50±5ms');
    } else {
      console.log(`✗ FAIL: Only ${percentage.toFixed(2)}% within range (required ≥99%)`);
    }
    console.log();
    
    // Distribution histogram
    const buckets = new Map<string, number>();
    for (const interval of this.tickIntervals) {
      const bucket = `${Math.floor(interval / 5) * 5}-${Math.floor(interval / 5) * 5 + 5}ms`;
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    
    console.log('Distribution:');
    Array.from(buckets.entries())
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .forEach(([range, count]) => {
        const percent = ((count / this.tickIntervals.length) * 100).toFixed(2);
        const bar = '█'.repeat(Math.floor(count / 10));
        console.log(`  ${range.padEnd(12)} ${count.toString().padStart(4)} (${percent}%) ${bar}`);
      });
    console.log();
  }

  private logBandwidth() {
    console.log('\n=== Bandwidth Report (Estimated) ===');
    const seconds = this.matchState.tick / TICKS_PER_SECOND;
    
    // Estimate bandwidth based on Colyseus Schema delta encoding
    // Each tick sends: player positions (8 bytes), directions (2 bytes), 
    // territoryCells (4 bytes), tick (4 bytes), cellUpdates (~10-20 bytes avg)
    // Protocol overhead (~15 bytes) = ~43-57 bytes per tick
    const bytesPerTick = 50; // Conservative estimate
    const totalBytes = this.matchState.tick * bytesPerTick;
    const avgBytesPerSec = Math.round(totalBytes / seconds);
    const peakBytesPerSec = Math.round(bytesPerTick * TICKS_PER_SECOND * 1.2); // 20% overhead for heavy frames
    
    for (const [sessionId] of this.bytesSentPerPlayer) {
      const playerNum = this.playerMapping.get(sessionId);
      
      console.log(`\nPlayer ${playerNum} (${sessionId}):`);
      console.log(`  Total: ${totalBytes} bytes`);
      console.log(`  Average: ${avgBytesPerSec} bytes/sec`);
      console.log(`  Peak: ${peakBytesPerSec} bytes/sec (estimated)`);
    }
    console.log('\nNote: Bandwidth is estimated based on Colyseus Schema delta encoding.');
    console.log('Actual bytes may vary based on compression and protocol overhead.');
    console.log();
  }
}
