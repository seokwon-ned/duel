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
  GRID_SIZE,
  ResultReason,
} from '@turf-duel/engine';

interface PlayerDisconnectInfo {
  disconnectCount: number;
  totalDisconnectedMs: number;
  currentDisconnectStartTime: number | null;
}

export class TurfDuelRoom extends Room<{ state: TurfDuelState }> {
  protected inputQueue: PlayerInput[] = [];
  protected bytesPerSecondPerPlayer = new Map<string, number[]>();
  protected lastBandwidthReset = Date.now();
  protected disconnectInfo = new Map<string, PlayerDisconnectInfo>();
  protected countdownInterval: NodeJS.Timeout | null = null;
  protected forfeitCleanupTimer: NodeJS.Timeout | null = null;
  protected tickIntervals: number[] = [];
  protected lastTickTime: number = 0;
  protected matchState!: MatchState;
  protected gameLoop: NodeJS.Timeout | null = null;
  protected bytesSentPerPlayer = new Map<string, number>();
  protected playerMapping = new Map<string, 1 | 2>();
  protected previousGrid: CellType[][] | null = null;
  protected matchStarted = false;
  protected readonly maxDisconnects = 2;
  protected readonly maxDisconnectMs = Number(process.env.TURF_DUEL_MAX_DISCONNECT_MS) || 30000;

  maxClients = 2;

  onCreate(options: any) {
    const state = new TurfDuelState();
    this.setState(state);
    this.matchState = createInitialState();
    
    // Initialize grid in schema
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        state.grid.push(this.matchState.grid[y][x]);
      }
    }
    
    // Hook broadcast to measure actual bytes sent
    const originalBroadcast = this.broadcast.bind(this);
    (this as any).broadcast = (type: any, message?: any, options?: any) => {
      // Measure message size
      let byteLength = 0;
      if (message) {
        if (Buffer.isBuffer(message)) {
          byteLength = message.length;
        } else if (ArrayBuffer.isView(message)) {
          byteLength = message.byteLength;
        } else if (typeof message === 'string') {
          byteLength = Buffer.byteLength(message, 'utf8');
        } else {
          // For objects, estimate JSON size
          byteLength = Buffer.byteLength(JSON.stringify(message), 'utf8');
        }
      }
      
      // Add to each player's byte count
      if (byteLength > 0) {
        for (const [sessionId] of this.playerMapping) {
          const current = this.bytesSentPerPlayer.get(sessionId) || 0;
          this.bytesSentPerPlayer.set(sessionId, current + byteLength);
        }
      }
      
      return originalBroadcast(type, message, options);
    };
    
    this.onMessage('input', (client, message) => {
      this.handleInput(client, message);
    });
  }

  onJoin(client: Client, options: any) {
    const playerNum = this.playerMapping.size === 0 ? 1 : 2;
    this.playerMapping.set(client.sessionId, playerNum);
    this.bytesSentPerPlayer.set(client.sessionId, 0);
    this.bytesPerSecondPerPlayer.set(client.sessionId, []);
    
    // Initialize disconnect tracking
    if (!this.disconnectInfo.has(client.sessionId)) {
      this.disconnectInfo.set(client.sessionId, {
        disconnectCount: 0,
        totalDisconnectedMs: 0,
        currentDisconnectStartTime: null,
      });
    }

    console.log(`Player ${playerNum} joined: ${client.sessionId}`);

    client.send('player', { num: playerNum });

    // Hook into WebSocket to measure actual bytes sent
    // Colyseus 0.18 exposes the socket as client.ref
    const ws = (client as any).ref || (client as any)._connection || (client as any).connection;
    
    if (ws && ws.send) {
      const originalWsSend = ws.send.bind(ws);
      ws.send = (data: any, ...args: any[]) => {
        const byteLength = Buffer.isBuffer(data) ? data.length :
                          ArrayBuffer.isView(data) ? data.byteLength :
                          typeof data === 'string' ? Buffer.byteLength(data, 'utf8') :
                          data?.byteLength || data?.length || 0;
        
        if (byteLength > 0) {
          const current = this.bytesSentPerPlayer.get(client.sessionId) || 0;
          this.bytesSentPerPlayer.set(client.sessionId, current + byteLength);
        }
        
        return originalWsSend(data, ...args);
      };
    } else {
      // Fallback: Try to find ws in the transport
      const transport = (this as any).presence?.transport || (this as any).transport;
      if (transport && transport.clients) {
        const wsClient = transport.clients.get(client.sessionId);
        if (wsClient && wsClient.send) {
          const originalTransportSend = wsClient.send.bind(wsClient);
          wsClient.send = (data: any, ...args: any[]) => {
            const byteLength = Buffer.isBuffer(data) ? data.length :
                              ArrayBuffer.isView(data) ? data.byteLength :
                              typeof data === 'string' ? Buffer.byteLength(data, 'utf8') :
                              data?.byteLength || data?.length || 0;
            
            if (byteLength > 0) {
              const current = this.bytesSentPerPlayer.get(client.sessionId) || 0;
              this.bytesSentPerPlayer.set(client.sessionId, current + byteLength);
            }
            
            return originalTransportSend(data, ...args);
          };
        }
      }
    }

    if (this.playerMapping.size === 2) {
      this.startGame();
    }
  }

  async onLeave(client: Client, code?: number) {
    const resolved = code ?? 1006;
    const playerNum = this.playerMapping.get(client.sessionId);
    console.log(`Player ${playerNum ?? '?'} left: ${client.sessionId} (code: ${resolved})`);

    if (!playerNum) {
      console.log(`Leave with no seat mapping (code ${resolved})`);
      return;
    }

    // Waiting room: just free the seat. No disconnect count, no walkover.
    if (!this.matchStarted) {
      this.freeWaitingSeat(client.sessionId);
      return;
    }

    // Every close code is a leave (immediate loss) or a disconnect (pause + reconnect).
    if (this.isImmediateLeave(resolved)) {
      this.handleImmediateLeave(playerNum, resolved);
      return;
    }

    await this.handleUnexpectedDisconnect(client, playerNum, resolved);
  }

  /** 4000 / 1000 = client leave. 4001 = server dispose / kick. */
  private isImmediateLeave(code: number): boolean {
    return code === 4000 || code === 1000 || code === 4001;
  }

  private freeWaitingSeat(sessionId: string): void {
    this.playerMapping.delete(sessionId);
    this.disconnectInfo.delete(sessionId);
    this.bytesSentPerPlayer.delete(sessionId);
    this.bytesPerSecondPerPlayer.delete(sessionId);
    console.log(`Waiting-room seat freed: ${sessionId}`);
  }

  /** Voluntary/normal leave: opponent wins now. Do not hold allowReconnection. */
  private handleImmediateLeave(playerNum: 1 | 2, code: number): void {
    if (this.matchState.result) {
      console.log(`Player ${playerNum} leave ${code} after match end`);
      return;
    }
    const winner = playerNum === 1 ? 2 : 1;
    console.log(`Player ${playerNum} leave ${code}: immediate loss`);
    this.finalizeForfeit(winner, ResultReason.DISCONNECTED);
  }

  private async handleUnexpectedDisconnect(client: Client, playerNum: 1 | 2, code: number): Promise<void> {
    const info = this.disconnectInfo.get(client.sessionId);
    if (!info) return;

    info.disconnectCount++;
    info.currentDisconnectStartTime = this.now();

    const playerState = playerNum === 1 ? this.state.player1 : this.state.player2;
    playerState.connected = false;
    playerState.disconnectCount = info.disconnectCount;

    console.log(`Player ${playerNum} disconnect #${info.disconnectCount} (code ${code}), total time: ${info.totalDisconnectedMs}ms`);

    this.matchState.paused = true;
    this.updatePauseState();
    this.evaluateDisconnectLimits();
    if (this.matchState.result) {
      // Keep a short window so the disconnected client can still read the result.
      try {
        await this.allowReconnection(client, Math.max(5, this.reconnectionWindowSeconds(info.totalDisconnectedMs)));
      } catch (e) {
        console.log(`Player ${playerNum} post-forfeit reconnection window closed:`, e);
      }
      return;
    }

    this.startDisconnectCountdown();

    try {
      await this.allowReconnection(client, this.reconnectionWindowSeconds(info.totalDisconnectedMs));
      console.log(`Player ${playerNum} reconnection window closed`);
    } catch (e) {
      console.log(`Player ${playerNum} reconnection failed:`, e);
    }
    if (info.currentDisconnectStartTime !== null) {
      this.evaluateDisconnectLimits();
    }
  }
  
  async onReconnect(client: Client) {
    const playerNum = this.playerMapping.get(client.sessionId);
    if (!playerNum) return;
    
    console.log(`Player ${playerNum} reconnected: ${client.sessionId}`);
    
    const info = this.disconnectInfo.get(client.sessionId);
    this.accrueDisconnectTime(client.sessionId);

    const playerState = playerNum === 1 ? this.state.player1 : this.state.player2;
    playerState.connected = true;
    playerState.totalDisconnectedMs = info?.totalDisconnectedMs || 0;

    // 15.5s + 14.8s = 30.3s must lose on reconnect, not after the next 1s tick
    this.evaluateDisconnectLimits();
    if (this.matchState.result) {
      return;
    }

    this.updatePauseState();
  }

  private accrueDisconnectTime(sessionId: string): void {
    const info = this.disconnectInfo.get(sessionId);
    if (!info || info.currentDisconnectStartTime === null) return;
    info.totalDisconnectedMs += this.now() - info.currentDisconnectStartTime;
    info.currentDisconnectStartTime = null;
  }

  private playerDisconnectTotalMs(sessionId: string): number {
    const info = this.disconnectInfo.get(sessionId);
    if (!info) return 0;
    const running = info.currentDisconnectStartTime !== null
      ? this.now() - info.currentDisconnectStartTime
      : 0;
    return info.totalDisconnectedMs + running;
  }

  onDispose() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.forfeitCleanupTimer) {
      clearTimeout(this.forfeitCleanupTimer);
    }

    // Log bandwidth when room is disposed (match ended or players left)
    if (this.matchState && this.matchState.tick > 0) {
      this.logBandwidth();
    }
  }
  
  private updatePauseState() {
    const p1Connected = this.state.player1.connected;
    const p2Connected = this.state.player2.connected;

    // Overlapping disconnect is a pause, not a void.
    if (!p1Connected && !p2Connected) {
      this.state.disconnectedPlayer = 3;
      this.matchState.paused = true;
    } else if (!p1Connected) {
      this.state.disconnectedPlayer = 1;
      this.matchState.paused = true;
    } else if (!p2Connected) {
      this.state.disconnectedPlayer = 2;
      this.matchState.paused = true;
    } else {
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

    // Tick-rate checks so 15.5+14.8=30.3s is not rounded away
    this.countdownInterval = setInterval(() => {
      let worstRemaining = Number.POSITIVE_INFINITY;
      for (const [sessionId, info] of this.disconnectInfo) {
        if (info.currentDisconnectStartTime === null) continue;
        const remaining = Math.max(0, this.maxDisconnectMs - this.playerDisconnectTotalMs(sessionId));
        worstRemaining = Math.min(worstRemaining, remaining);
      }
      if (Number.isFinite(worstRemaining)) {
        this.state.disconnectCountdownSeconds = Math.ceil(worstRemaining / 1000);
      }

      this.evaluateDisconnectLimits();
      if (!this.matchState.result) {
        this.syncState();
      }
    }, 50);
  }

  /** First player over the limit loses. Both over on the same check => void. */
  private evaluateDisconnectLimits(): void {
    if (this.matchState.result) return;

    const exceeded: Array<1 | 2> = [];
    for (const [sessionId, info] of this.disconnectInfo) {
      const playerNum = this.playerMapping.get(sessionId);
      if (!playerNum) continue;
      const totalMs = this.playerDisconnectTotalMs(sessionId);
      if (info.disconnectCount > this.maxDisconnects || totalMs > this.maxDisconnectMs) {
        exceeded.push(playerNum);
      }
    }

    const unique = [...new Set(exceeded)];
    if (unique.length === 2) {
      this.finalizeForfeit(0, ResultReason.BOTH_DISCONNECTED);
    } else if (unique.length === 1) {
      this.finalizeForfeit(unique[0] === 1 ? 2 : 1, ResultReason.DISCONNECTED);
    }
  }

  private finalizeForfeit(winner: 0 | 1 | 2, reason: ResultReason): void {
    if (this.matchState.result) {
      return;
    }
    this.matchState.result = {
      winner,
      reason,
      tick: this.matchState.tick,
    };
    this.matchState.paused = true;
    this.syncState();
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    this.scheduleRoomDispose(3000);
  }

  private scheduleRoomDispose(delayMs: number): void {
    if (this.forfeitCleanupTimer) {
      clearTimeout(this.forfeitCleanupTimer);
    }
    this.forfeitCleanupTimer = setTimeout(() => {
      this.disconnect().catch((err) => console.error('Failed to dispose room:', err));
    }, delayMs);
  }

  /** Wall clock for disconnect accounting. Tests may override. */
  protected now(): number {
    return Date.now();
  }

  protected reconnectionWindowSeconds(totalDisconnectedMs: number): number {
    const remainingMs = Math.max(0, this.maxDisconnectMs - totalDisconnectedMs);
    // Keep the token alive through remaining budget + 3s dispose so a timeout
    // forfeit still lets the leaver reconnect and read the result.
    return Math.max(5, Math.ceil(remainingMs / 1000) + 5);
  }

  /** Test-room hook. Production is a no-op. */
  protected onBeforeTick(): void {}

  protected startGame() {
    console.log('Starting game loop at 20Hz');
    this.matchStarted = true;

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
          this.onBeforeTick();

          const inputs = [...this.inputQueue];
          this.inputQueue = [];

          const result = step(this.matchState, inputs);
          this.matchState = result.state;
          this.syncState();

          if (this.matchState.result !== null) {
            clearInterval(bandwidthInterval);
            console.log('Match ended:', this.matchState.result);
            this.logBandwidth();
            this.scheduleRoomDispose(3000);
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

  private handleInput(client: Client, message: any) {
    const playerNum = this.playerMapping.get(client.sessionId);
    if (!playerNum) return;

    if (this.matchState.result !== null || this.matchState.paused) {
      return;
    }

    // Validate message structure
    if (!message || typeof message !== 'object' || typeof message.direction !== 'string') {
      console.warn(`Invalid input from ${client.sessionId}: malformed message`);
      return;
    }

    // Validate direction against whitelist
    const validDirections = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    if (!validDirections.includes(message.direction)) {
      console.warn(`Invalid input from ${client.sessionId}: unknown direction '${message.direction}'`);
      return;
    }

    this.inputQueue.push({
      player: playerNum,
      direction: message.direction as Direction,
    });
  }

  protected syncState() {
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

    // Sync full grid for lossless state
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const index = y * GRID_SIZE + x;
        state.grid[index] = this.matchState.grid[y][x];
      }
    }

    // Keep cellUpdates for backward compatibility and debugging
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

  protected logBandwidth() {
    console.log('\n=== Bandwidth Report (Measured) ===');
    const seconds = this.matchState.tick / TICKS_PER_SECOND;
    
    for (const [sessionId] of this.bytesSentPerPlayer) {
      const playerNum = this.playerMapping.get(sessionId);
      const totalBytes = this.bytesSentPerPlayer.get(sessionId) || 0;
      const bytesPerSecondList = this.bytesPerSecondPerPlayer.get(sessionId) || [];
      
      const avgBytesPerSec = Math.round(totalBytes / seconds);
      const peakBytesPerSec = Math.max(...bytesPerSecondList, 0);
      
      // Calculate P95
      const sorted = [...bytesPerSecondList].sort((a, b) => a - b);
      const p95Index = Math.ceil(sorted.length * 0.95) - 1;
      const p95BytesPerSec = sorted[Math.max(0, p95Index)] || 0;
      
      console.log(`\nPlayer ${playerNum} (${sessionId}):`);
      console.log(`  Total: ${totalBytes.toLocaleString()} bytes (${(totalBytes / 1024).toFixed(2)} KB)`);
      console.log(`  Average: ${avgBytesPerSec.toLocaleString()} bytes/sec (~${(avgBytesPerSec / 1024).toFixed(2)} KB/s)`);
      console.log(`  P95: ${p95BytesPerSec.toLocaleString()} bytes/sec (~${(p95BytesPerSec / 1024).toFixed(2)} KB/s)`);
      console.log(`  Peak: ${peakBytesPerSec.toLocaleString()} bytes/sec (~${(peakBytesPerSec / 1024).toFixed(2)} KB/s)`);
    }
    
    // Calculate total
    const players = Array.from(this.bytesSentPerPlayer.keys());
    const totalBytes = players.reduce((sum, id) => sum + (this.bytesSentPerPlayer.get(id) || 0), 0);
    const avgPerPlayer = Math.round(totalBytes / players.length / seconds);
    
    console.log(`\nPer-Player Average: ${avgPerPlayer.toLocaleString()} bytes/sec (~${(avgPerPlayer / 1024).toFixed(2)} KB/s)`);
    console.log(`Total Match Data: ${totalBytes.toLocaleString()} bytes (${(totalBytes / 1024).toFixed(2)} KB)`);
    console.log('\nNote: Measured by intercepting client.send() calls on the server.');
    console.log('      Includes Colyseus Schema delta encoding + protocol overhead.');
    console.log();
  }
}
