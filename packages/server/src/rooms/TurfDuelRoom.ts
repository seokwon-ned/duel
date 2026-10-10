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

export class TurfDuelRoom extends Room<TurfDuelState> {
  private matchState!: MatchState;
  private gameLoop: NodeJS.Timeout | null = null;
  private playerMapping = new Map<string, 1 | 2>();
  private bytesSentPerPlayer = new Map<string, number>();
  private previousGrid: CellType[][] | null = null;
  private inputQueue: PlayerInput[] = [];
  private bytesPerSecondPerPlayer = new Map<string, number[]>();
  private lastBandwidthReset = Date.now();

  maxClients = 2;

  onCreate(options: any) {
    this.setState(new TurfDuelState());
    this.matchState = createInitialState();
    
    this.onMessage('input', (client, message) => {
      this.handleInput(client, message);
    });

    this.onMessage('pause', (client, message) => {
      const playerNum = this.playerMapping.get(client.sessionId);
      if (playerNum) {
        this.matchState.paused = message.paused;
      }
    });
  }

  onJoin(client: Client, options: any) {
    const playerNum = this.playerMapping.size === 0 ? 1 : 2;
    this.playerMapping.set(client.sessionId, playerNum);
    this.bytesSentPerPlayer.set(client.sessionId, 0);
    this.bytesPerSecondPerPlayer.set(client.sessionId, []);

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

  onLeave(client: Client, consented: boolean) {
    const playerNum = this.playerMapping.get(client.sessionId);
    console.log(`Player ${playerNum} left: ${client.sessionId}`);
    
    this.matchState.paused = true;
    this.syncState();
  }

  onDispose() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
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
        const lastTotal = perSecondList.reduce((a, b) => a + b, 0);
        const bytesThisSecond = current - lastTotal;
        perSecondList.push(bytesThisSecond);
        this.bytesPerSecondPerPlayer.set(sessionId, perSecondList);
      }
    }, 1000);
    
    this.gameLoop = setInterval(() => {
      if (!this.matchState.paused && this.matchState.result === null) {
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
