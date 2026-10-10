import Phaser from 'phaser';
import { Client, Room } from 'colyseus.js';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  CellType,
  GRID_SIZE,
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
        if (this.room) {
          this.room.send('input', { direction: newDirection });
        }
      }
    });
  }

  startOnlineMode(room: Room) {
    this.isOnlineMode = true;
    this.room = room;

    room.state.onChange = () => {
      this.updateFromServerState();
    };

    room.onMessage('*', (type, message) => {
      console.log('Message from server:', type, message);
    });
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

    if (state.cellUpdates) {
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

let game: Phaser.Game | null = null;

document.getElementById('connectBtn')?.addEventListener('click', async () => {
  const serverUrl = (document.getElementById('serverUrl') as HTMLInputElement).value;
  const statusEl = document.getElementById('status');

  try {
    if (statusEl) statusEl.textContent = 'Connecting...';
    
    const client = new Client(serverUrl);
    const room = await client.joinOrCreate('turf_duel');
    
    if (statusEl) statusEl.textContent = `Connected! Room: ${room.id}`;

    if (!game) {
      game = new Phaser.Game(config);
    }

    game.scene.scenes[0].events.once('create', () => {
      (game!.scene.scenes[0] as GameScene).startOnlineMode(room);
    });
  } catch (error) {
    console.error('Connection error:', error);
    if (statusEl) statusEl.textContent = `Error: ${error}`;
  }
});

document.getElementById('botBtn')?.addEventListener('click', () => {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Playing vs Bot (offline)';

  if (!game) {
    game = new Phaser.Game(config);
  }

  game.scene.scenes[0].events.once('create', () => {
    (game!.scene.scenes[0] as GameScene).startBotMode();
  });
});
