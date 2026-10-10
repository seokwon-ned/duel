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
  private matchState!: MatchState;
  private gameLoop: NodeJS.Timeout | null = null;
  private playerMapping = new Map<string, 1 | 2>();
  private bytesSentPerPlayer = new Map<string, number>();
  private previousGrid: CellType[][] | null = null;
  private inputQueue: PlayerInput[] = [];
  private bytesPerSecondPerPlayer = new Map<string, number[]>();
  private lastBandwidthReset = Date.now();
  private disconnectInfo = new Map<string, PlayerDisconnectInfo>();
  private countdownInterval: NodeJS.Timeout | null = null;
  private tickIntervals: number[] = [];
  private lastTickTime: number = 0;

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

    console.log(`Player ${playerNum} joined: ${client.sessionId}`);

    // Hook into WebSocket to measure actual bytes sent
    // Try multiple paths to access the underlying WebSocket
    const ws = (client as any).raw || (client as any)._connection || (client as any).connection;
    
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

  onLeave(client: Client, code?: number) {
    const playerNum = this.playerMapping.get(client.sessionId);
    console.log(`Player ${playerNum} left: ${client.sessionId} (code: ${code})`);
    
    this.matchState.paused = true;
    this.syncState();
  }

  onDispose() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
    }
    
    // Log bandwidth when room is disposed (match ended or players left)
    if (this.matchState && this.matchState.tick > 0) {
      this.logBandwidth();
    }
  }

  private startGame() {
    console.log('Starting game loop at 20Hz');
    
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
      if (!this.matchState.paused && this.matchState.result === null) {
        try {
          // Test-only fault injection
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

  private handleInput(client: Client, message: any) {
    const playerNum = this.playerMapping.get(client.sessionId);
    if (!playerNum) return;

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

  private logBandwidth() {
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
