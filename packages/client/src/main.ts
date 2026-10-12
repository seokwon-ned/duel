import Phaser from 'phaser';
import { Client, Room } from '@colyseus/sdk';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  CellType,
  GRID_SIZE,
  ClientPredictor,
  schemaToMatchState,
} from '@turf-duel/engine';
import { Bot } from '@turf-duel/bot';

const CELL_SIZE = 15;
const COLORS = {
  EMPTY: 0x0F172A,
  PLAYER1_TERRITORY: 0xFF7A1A,
  PLAYER2_TERRITORY: 0x2F6BFF,
  PLAYER1_TRAIL: 0xFF9A4A,
  PLAYER2_TRAIL: 0x4F8BFF,
};

// Debug hook for E2E tests
interface TurfDebug {
  tick: number;
  ownedCells: { p1: number; p2: number };
  renderedFrames: number;
}

declare global {
  interface Window {
    __turfDebug?: TurfDebug;
  }
}

if (typeof window !== 'undefined') {
  window.__turfDebug = {
    tick: 0,
    ownedCells: { p1: 0, p2: 0 },
    renderedFrames: 0,
  };
}

class GameScene extends Phaser.Scene {
  private cells: Phaser.GameObjects.Rectangle[][] = [];
  private room: Room | null = null;
  private matchState: MatchState | null = null;
  private playerNum: 1 | 2 = 1;
  private currentDirection: Direction = Direction.RIGHT;
  private isOnlineMode = false;
  private bot: Bot | null = null;
  private botInterval: NodeJS.Timeout | null = null;
  private infoText: Phaser.GameObjects.Text | null = null;
  
  // Client-side prediction (shared deterministic module)
  private predictor: ClientPredictor | null = null;
  private lastServerTick = 0;

  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    for (let y = 0; y < GRID_SIZE; y++) {
      this.cells[y] = [];
      for (let x = 0; x < GRID_SIZE; x++) {
        const rect = this.add.rectangle(
          x * CELL_SIZE + CELL_SIZE / 2,
          y * CELL_SIZE + CELL_SIZE / 2,
          CELL_SIZE - 1,
          CELL_SIZE - 1,
          COLORS.EMPTY
        );
        this.cells[y][x] = rect;
      }
    }

    this.infoText = this.add.text(10, GRID_SIZE * CELL_SIZE + 10, '', {
      fontSize: '16px',
      color: '#ffffff',
    });

    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      let newDirection: Direction | null = null;

      switch (event.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          newDirection = Direction.UP;
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          newDirection = Direction.DOWN;
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          newDirection = Direction.LEFT;
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          newDirection = Direction.RIGHT;
          break;
      }

      if (newDirection) {
        this.currentDirection = newDirection;
        if (this.room && this.predictor?.predicted) {
          const { clientTick } = this.predictor.applyInput(newDirection);
          this.renderState(this.predictor.predicted);
          this.room.send('input', {
            direction: newDirection,
            clientTick,
          });
        }
      }
    });
  }

  startOnlineMode(room: Room) {
    this.isOnlineMode = true;
    this.room = room;
    this.predictor = new ClientPredictor(this.playerNum);

    room.onMessage('player', (message: { num: 1 | 2 }) => {
      this.playerNum = message.num;
      this.predictor = new ClientPredictor(this.playerNum);
      if (room.state) {
        this.predictor.reconcile(schemaToMatchState(room.state));
      }
    });

    room.onStateChange.once((state) => {
      this.renderFromSchema(state);
      const serverState = schemaToMatchState(state);
      this.matchState = serverState;
      this.lastServerTick = serverState.tick;
      this.predictor?.reconcile(serverState);
      this.updateDebug(serverState);
    });

    room.onStateChange((state) => {
      const serverState = schemaToMatchState(state);
      this.predictor?.reconcile(serverState);
      const toRender = this.predictor?.predicted ?? serverState;
      this.renderState(toRender);
      this.matchState = serverState;
      this.lastServerTick = serverState.tick;
      this.updateDebug(toRender);
    });

    room.onMessage('*', (type, message) => {
      console.log('Message from server:', type, message);
    });
  }

  private updateDebug(state: MatchState) {
    if (typeof window !== 'undefined' && window.__turfDebug) {
      window.__turfDebug.tick = state.tick;
      window.__turfDebug.ownedCells = {
        p1: state.player1.territoryCells,
        p2: state.player2.territoryCells,
      };
      window.__turfDebug.renderedFrames++;
    }
  }

  startBotMode() {
    this.isOnlineMode = false;
    this.matchState = createInitialState();
    this.bot = new Bot('normal', 2);
    
    this.renderState(this.matchState);

    this.botInterval = setInterval(() => {
      if (!this.matchState || this.matchState.result) {
        if (this.botInterval) {
          clearInterval(this.botInterval);
        }
        return;
      }

      const botMove = this.bot!.getNextMove(this.matchState);
      
      const result = step(this.matchState, [
        { player: 1, direction: this.currentDirection },
        { player: 2, direction: botMove },
      ]);

      this.matchState = result.state;
      this.renderState(this.matchState);

      if (this.matchState.result) {
        this.showResult(this.matchState.result);
      }
    }, 50);
  }

  private updateFromServerState() {
    if (!this.room) return;

    const state = this.room.state;

    // Render from full grid if available (lossless sync)
    if (state.grid && state.grid.length > 0) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const index = y * GRID_SIZE + x;
          const cellType = state.grid[index];
          const color = this.getCellColor(cellType);
          this.cells[y][x].setFillStyle(color);
        }
      }
    } else if (state.cellUpdates) {
      // Fallback to incremental updates
      state.cellUpdates.forEach((update: any) => {
        const color = this.getCellColor(update.type);
        this.cells[update.y][update.x].setFillStyle(color);
      });
    }

    this.cells[state.player1.position.y][state.player1.position.x].setStrokeStyle(2, 0xFFFFFF);
    this.cells[state.player2.position.y][state.player2.position.x].setStrokeStyle(2, 0xFFFFFF);

    if (this.infoText) {
      const p1Percent = Math.round((state.player1.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
      const p2Percent = Math.round((state.player2.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
      const tick = state.tick;
      const seconds = Math.floor((3000 - tick) / 20);
      
      this.infoText.setText(
        `P1: ${p1Percent}% | Time: ${seconds}s | P2: ${p2Percent}%`
      );
    }

    if (state.result) {
      this.showResult(state.result);
    }

    // Update debug hook
    if (typeof window !== 'undefined' && window.__turfDebug) {
      window.__turfDebug.tick = state.tick;
      window.__turfDebug.ownedCells = {
        p1: state.player1.territoryCells,
        p2: state.player2.territoryCells,
      };
      window.__turfDebug.renderedFrames++;
    }
  }

  private renderFromSchema(state: any) {
    // Initial full render from grid
    if (state.grid && state.grid.length > 0) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const index = y * GRID_SIZE + x;
          const cellType = state.grid[index];
          const color = this.getCellColor(cellType);
          this.cells[y][x].setFillStyle(color);
        }
      }
    }
  }

  private renderState(state: MatchState) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const color = this.getCellColor(state.grid[y][x]);
        this.cells[y][x].setFillStyle(color);
      }
    }

    this.cells[state.player1.position.y][state.player1.position.x].setStrokeStyle(2, 0xFFFFFF);
    this.cells[state.player2.position.y][state.player2.position.x].setStrokeStyle(2, 0xFFFFFF);
    this.updateDebug(state);

    if (this.infoText) {
      const p1Percent = Math.round((state.player1.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
      const p2Percent = Math.round((state.player2.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
      const seconds = Math.floor((3000 - state.tick) / 20);
      
      this.infoText.setText(
        `You: ${p1Percent}% | Time: ${seconds}s | Bot: ${p2Percent}%`
      );
    }
  }

  private getCellColor(cellType: CellType): number {
    switch (cellType) {
      case CellType.PLAYER1_TERRITORY:
        return COLORS.PLAYER1_TERRITORY;
      case CellType.PLAYER2_TERRITORY:
        return COLORS.PLAYER2_TERRITORY;
      case CellType.PLAYER1_TRAIL:
        return COLORS.PLAYER1_TRAIL;
      case CellType.PLAYER2_TRAIL:
        return COLORS.PLAYER2_TRAIL;
      default:
        return COLORS.EMPTY;
    }
  }

  private showResult(result: any) {
    if (this.infoText) {
      const winner = result.winner === 0 ? 'Draw' : `Player ${result.winner} wins`;
      this.infoText.setText(`${winner} - ${result.reason}`);
    }
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GRID_SIZE * CELL_SIZE,
  height: GRID_SIZE * CELL_SIZE + 50,
  parent: 'game-container',
  backgroundColor: '#0F172A',
  scene: [GameScene],
};

// Initialize game on page load
const game = new Phaser.Game(config);
let gameSceneReady = false;

// Wait for game scene to be created
game.events.once('ready', () => {
  gameSceneReady = true;
  console.log('Phaser game ready');
});

document.getElementById('connectBtn')?.addEventListener('click', async () => {
  const serverUrl = (document.getElementById('serverUrl') as HTMLInputElement).value;
  const statusEl = document.getElementById('status');

  try {
    if (statusEl) statusEl.textContent = 'Connecting...';
    
    const client = new Client(serverUrl);
    const room = await client.joinOrCreate('turf_duel');
    
    if (statusEl) statusEl.textContent = `Connected! Room: ${room.roomId}`;

    // Get the game scene
    const scene = game.scene.scenes[0] as GameScene;
    
    if (scene && typeof scene.startOnlineMode === 'function') {
      scene.startOnlineMode(room);
    } else {
      console.error('Game scene not ready');
      throw new Error('Game scene not initialized');
    }
  } catch (error) {
    console.error('Connection error:', error);
    if (statusEl) statusEl.textContent = `Error: ${error}`;
  }
});

document.getElementById('botBtn')?.addEventListener('click', () => {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Playing vs Bot (offline)';

  const scene = game.scene.scenes[0] as GameScene;
  
  if (scene && typeof scene.startBotMode === 'function') {
    scene.startBotMode();
  } else {
    console.error('Game scene not ready');
    if (statusEl) statusEl.textContent = 'Error: Game not initialized';
  }
});
