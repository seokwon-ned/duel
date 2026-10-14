import { Room, Client, matchMaker } from '@colyseus/core';
import { TurfDuelState, CellUpdate, MatchResultSchema } from '../schema/TurfDuelState.js';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  PlayerState,
  PlayerInput,
  CellType,
  TICKS_PER_SECOND,
  ResultReason,
  cellOf,
  wrapAngle,
  flattenGrid,
} from '@turf-duel/engine';
import { accumulateCellUpdates, shouldSnapshotCellUpdates } from '../cellUpdates.js';

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
  protected pendingCellUpdates = new Map<string, { x: number; y: number; type: CellType }>();
  protected matchStarted = false;
  protected rematchVotes = new Set<1 | 2>();
  protected rematchRoomId: string | null = null;
  protected rematchCreating = false;
  protected rematchLobby = false;
  protected rematchNoShowTimer: NodeJS.Timeout | null = null;
  protected readonly maxDisconnects = 2;
  protected readonly maxDisconnectMs = Number(process.env.TURF_DUEL_MAX_DISCONNECT_MS) || 30000;

  maxClients = 2;

  onCreate(options: any) {
    const state = new TurfDuelState();
    this.setState(state);
    const matchTicks = this.allowClientMatchTicks()
      && typeof options?.matchTicks === 'number'
      && options.matchTicks > 0
      ? options.matchTicks
      : undefined;
    this.matchState = createInitialState(matchTicks !== undefined ? { matchTicks } : undefined);
    state.gridWidth = this.matchState.gridWidth;
    state.gridHeight = this.matchState.gridHeight;
    
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
    this.onMessage('rematch', (client) => {
      void this.handleRematch(client);
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
    this.sendGridSnapshot(client);

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

    this.rematchVotes.delete(playerNum);

    // Waiting room: just free the seat. No disconnect count, no walkover.
    if (!this.matchStarted) {
      this.freeWaitingSeat(client.sessionId);
      return;
    }

    // Every close code is a leave (immediate loss) or a disconnect (pause + reconnect).
    if (this.isImmediateLeave(resolved)) {
      this.handleImmediateLeave(playerNum, resolved, client.sessionId);
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
  private handleImmediateLeave(playerNum: 1 | 2, code: number, sessionId: string): void {
    if (this.matchState.result) {
      console.log(`Player ${playerNum} leave ${code} after match end`);
      return;
    }
    // Late rematch consume that immediately leave()s must not walkover the other seat.
    if (this.rematchLobby && this.matchState.tick <= 1) {
      console.log(`Player ${playerNum} leave ${code} at rematch start — no forfeit`);
      this.freeWaitingSeat(sessionId);
      if (this.gameLoop) {
        clearInterval(this.gameLoop);
        this.gameLoop = null;
      }
      this.matchStarted = false;
      void this.openRematchToMatchmaking();
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
    this.sendGridSnapshot(client);

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
    if (this.rematchNoShowTimer) {
      clearTimeout(this.rematchNoShowTimer);
      this.rematchNoShowTimer = null;
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
    this.lockFinishedRoom();
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

  /** Explicit lock so a later leave does not unlock the finished room for joinOrCreate. */
  private lockFinishedRoom(): void {
    this.lock().catch((err) => console.error('Failed to lock finished room:', err));
  }

  /** Client rematch wait and server pairing window stay aligned. */
  static readonly REMATCH_PAIR_MS = 15000;

  /** Production ignores client matchTicks so a stranger cannot shorten a live match. */
  protected allowClientMatchTicks(): boolean {
    return false;
  }

  /**
   * Server-internal only (remoteRoomCall from handleRematch).
   * Client create/join options must not trigger this — ignore options.rematch.
   */
  async configureRematchLobby(): Promise<void> {
    this.rematchLobby = true;
    const seatS = Number(process.env.TURF_DUEL_REMATCH_SEAT_S);
    if (Number.isFinite(seatS) && seatS > 0) {
      this.seatReservationTimeout = seatS;
    }
    await this.setPrivate(true);
    this.armRematchNoShow();
  }

  private armRematchNoShow(): void {
    if (this.rematchNoShowTimer) {
      clearTimeout(this.rematchNoShowTimer);
    }
    this.rematchNoShowTimer = setTimeout(() => {
      this.rematchNoShowTimer = null;
      if (this.matchStarted) return;
      void this.openRematchToMatchmaking();
    }, this.seatReservationTimeout * 1000 + 80);
  }

  private async openRematchToMatchmaking(): Promise<void> {
    if (this.matchStarted) return;
    try {
      this.cancelUnusedSeatReservations();
      await this.setPrivate(false);
      if (this.locked) {
        await this.unlock();
      }
      console.log(`Rematch lobby ${this.roomId} opened to matchmaking after seat expiry`);
    } catch (err) {
      console.error('Failed to open rematch lobby:', err);
    }
  }

  /** Fire Colyseus unused-seat timers now so a late consumeSeatReservation fails instead of joining. */
  private cancelUnusedSeatReservations(): void {
    const room = this as unknown as {
      _reservedSeats?: Record<string, [unknown, unknown, boolean?, boolean?]>;
      _reservedSeatTimeouts?: Record<string, NodeJS.Timeout>;
    };
    const seats = room._reservedSeats;
    const timeouts = room._reservedSeatTimeouts;
    if (!seats || !timeouts) return;
    for (const [sessionId, timer] of Object.entries(timeouts)) {
      const reserved = seats[sessionId];
      if (!reserved || reserved[2]) continue;
      clearTimeout(timer);
      const fire = (timer as NodeJS.Timeout & { _onTimeout?: () => void })._onTimeout;
      if (typeof fire === 'function') {
        fire.call(timer);
      }
    }
  }

  private async handleRematch(client: Client): Promise<void> {
    const from = this.playerMapping.get(client.sessionId);
    if (!from || !this.matchState.result) return;
    this.broadcast('rematch', { from }, { except: client });
    this.rematchVotes.add(from);
    // Pairing needs more than the 3s nobody-rematch dispose window.
    this.scheduleRoomDispose(TurfDuelRoom.REMATCH_PAIR_MS);
    if (this.rematchVotes.size < 2 || this.rematchRoomId || this.rematchCreating) return;
    this.rematchCreating = true;
    try {
      const created = await matchMaker.createRoom('turf_duel', {});
      await matchMaker.remoteRoomCall(created.roomId, 'configureRematchLobby');
      this.rematchRoomId = created.roomId;
      const seats = new Map<1 | 2, ReturnType<typeof matchMaker.buildSeatReservation>>();
      for (const num of this.rematchVotes) {
        seats.set(num, await matchMaker.reserveSeatFor(created, {}));
      }
      for (const seated of this.clients) {
        const num = this.playerMapping.get(seated.sessionId);
        if (!num) continue;
        const seat = seats.get(num);
        if (seat) seated.send('rematch_room', { roomId: created.roomId, seat });
      }
      this.scheduleRoomDispose(3000);
    } catch (err) {
      console.error('Failed to create rematch room:', err);
      this.rematchCreating = false;
    }
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
    if (this.rematchNoShowTimer) {
      clearTimeout(this.rematchNoShowTimer);
      this.rematchNoShowTimer = null;
    }

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
            this.lockFinishedRoom();
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

    if (!message || typeof message !== 'object') {
      console.warn(`Invalid input from ${client.sessionId}: malformed message`);
      return;
    }

    const input: PlayerInput = { player: playerNum };
    const validDirections = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

    if (typeof message.direction === 'string') {
      if (!validDirections.includes(message.direction)) {
        console.warn(`Invalid input from ${client.sessionId}: unknown direction '${message.direction}'`);
        return;
      }
      input.direction = message.direction as Direction;
    }

    if (typeof message.heading === 'number' && Number.isFinite(message.heading)) {
      input.heading = wrapAngle(message.heading | 0);
    }

    if (typeof message.thrusting === 'boolean') {
      input.thrusting = message.thrusting;
    }

    if (input.direction === undefined && input.heading === undefined) {
      console.warn(`Invalid input from ${client.sessionId}: missing heading/direction`);
      return;
    }

    this.inputQueue.push(input);
  }

  protected syncState() {
    const state = this.state;
    
    this.syncPlayer(state.player1, this.matchState.player1);
    this.syncPlayer(state.player2, this.matchState.player2);
    state.boss.x = cellOf(this.matchState.boss.xFp);
    state.boss.y = cellOf(this.matchState.boss.yFp);
    state.sparx1.x = cellOf(this.matchState.sparx1.xFp);
    state.sparx1.y = cellOf(this.matchState.sparx1.yFp);
    state.sparx2.x = cellOf(this.matchState.sparx2.xFp);
    state.sparx2.y = cellOf(this.matchState.sparx2.yFp);

    state.tick = this.matchState.tick;
    state.paused = this.matchState.paused;

    if (this.matchState.result && !state.result) {
      state.result = new MatchResultSchema();
      state.result.winner = this.matchState.result.winner;
      state.result.reason = this.matchState.result.reason;
      state.result.tick = this.matchState.result.tick;
    }

    const changedCells = this.getChangedCells();
    accumulateCellUpdates(this.pendingCellUpdates, changedCells);
    if (shouldSnapshotCellUpdates(this.pendingCellUpdates.size)) {
      this.broadcastGridSnapshot();
      this.pendingCellUpdates.clear();
      state.cellUpdates.length = 0;
    }
  }

  /**
   * Copy pending cell writes into the outgoing schema only when Colyseus is
   * about to encode a patch. Clearing in syncState (per tick) drops the first
   * tick when one patch covers two 50ms ticks.
   */
  onBeforePatch() {
    const pending = [...this.pendingCellUpdates.values()];
    if (shouldSnapshotCellUpdates(pending.length)) {
      this.broadcastGridSnapshot();
      this.pendingCellUpdates.clear();
      this.state.cellUpdates.length = 0;
      return;
    }
    this.state.cellUpdates.length = 0;
    for (const cell of pending) {
      const update = new CellUpdate();
      update.x = cell.x;
      update.y = cell.y;
      update.type = cell.type;
      this.state.cellUpdates.push(update);
    }
    this.pendingCellUpdates.clear();
  }

  private sendGridSnapshot(client: Client) {
    client.send('grid', flattenGrid(this.matchState.grid));
  }

  private broadcastGridSnapshot() {
    this.pendingCellUpdates.clear();
    this.broadcast('grid', flattenGrid(this.matchState.grid));
  }

  private syncPlayer(schema: TurfDuelState['player1'], player: PlayerState) {
    schema.position.x = cellOf(player.xFp);
    schema.position.y = cellOf(player.yFp);
    schema.direction = player.direction;
    schema.heading = player.heading;
    schema.isAlive = player.isAlive;
    schema.territoryCells = player.territoryCells;
    schema.hearts = player.hearts;
    schema.drawing = player.drawing;
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
