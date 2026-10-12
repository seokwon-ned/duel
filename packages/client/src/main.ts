import Phaser from 'phaser';
import { Client, Room } from '@colyseus/sdk';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  CellType,
  GRID_SIZE,
} from '@turf-duel/engine';
import { Bot } from '@turf-duel/bot';
import { attachSwipeControls } from './swipe';

const CELL_SIZE = 15;
const BOARD_SIZE = GRID_SIZE * CELL_SIZE;
const COLORS = {
  EMPTY: 0x0F172A,
  PLAYER1_TERRITORY: 0xFF7A1A,
  PLAYER2_TERRITORY: 0x2F6BFF,
  PLAYER1_TRAIL: 0xFF9A4A,
  PLAYER2_TRAIL: 0x4F8BFF,
};

interface TurfDebug {
  tick: number;
  ownedCells: { p1: number; p2: number };
  renderedFrames: number;
  direction: Direction;
  result: string | null;
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
    direction: Direction.RIGHT,
    result: null,
  };
}

function setHud(text: string, isResult = false) {
  const hud = document.getElementById('matchHud');
  if (hud) {
    hud.textContent = text;
    hud.classList.toggle('result', isResult);
  }

  if (isResult) {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = text;
    }
  }
}

function setPlaying(playing: boolean) {
  document.getElementById('app')?.classList.toggle('playing', playing);
  requestAnimationFrame(() => {
    game.scale.refresh();
  });
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
  private detachSwipe: (() => void) | null = null;

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
        this.applyDirection(newDirection);
      }
    });

    this.detachSwipe = attachSwipeControls((direction) => {
      this.applyDirection(direction);
    });
  }

  shutdown() {
    this.detachSwipe?.();
    this.detachSwipe = null;
  }

  startOnlineMode(room: Room) {
    this.isOnlineMode = true;
    this.room = room;
    setPlaying(true);

    room.onMessage('player', (message: { num: 1 | 2 }) => {
      this.playerNum = message.num;
    });

    room.onStateChange.once((state) => {
      this.renderFromSchema(state);
      this.updateFromServerState();
    });

    room.onStateChange(() => {
      this.updateFromServerState();
    });

    room.onMessage('*', (type, message) => {
      console.log('Message from server:', type, message);
    });
  }

  startBotMode() {
    this.isOnlineMode = false;
    this.matchState = createInitialState();
    this.bot = new Bot('normal', 2);
    setPlaying(true);

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

  private applyDirection(newDirection: Direction) {
    if (newDirection === this.currentDirection) {
      return;
    }

    this.currentDirection = newDirection;
    if (typeof window !== 'undefined' && window.__turfDebug) {
      window.__turfDebug.direction = newDirection;
    }

    if (this.room) {
      this.room.send('input', { direction: newDirection });
    }

    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(15);
    }
  }

  private updateFromServerState() {
    if (!this.room) return;

    const state = this.room.state;

    if (state.grid && state.grid.length > 0) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const index = y * GRID_SIZE + x;
          const color = this.getCellColor(state.grid[index]);
          this.cells[y][x].setFillStyle(color);
        }
      }
    } else if (state.cellUpdates) {
      state.cellUpdates.forEach((update: any) => {
        const color = this.getCellColor(update.type);
        this.cells[update.y][update.x].setFillStyle(color);
      });
    }

    this.cells[state.player1.position.y][state.player1.position.x].setStrokeStyle(2, 0xFFFFFF);
    this.cells[state.player2.position.y][state.player2.position.x].setStrokeStyle(2, 0xFFFFFF);

    const you = this.playerNum === 1 ? state.player1 : state.player2;
    const foe = this.playerNum === 1 ? state.player2 : state.player1;
    const youPercent = Math.round((you.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
    const foePercent = Math.round((foe.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
    const seconds = Math.floor((3000 - state.tick) / 20);
    const foeLabel = this.isOnlineMode ? `P${this.playerNum === 1 ? 2 : 1}` : 'Bot';
    setHud(`You: ${youPercent}% | Time: ${seconds}s | ${foeLabel}: ${foePercent}%`);

    if (state.result) {
      this.showResult(state.result);
    }

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
    if (state.grid && state.grid.length > 0) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const index = y * GRID_SIZE + x;
          const color = this.getCellColor(state.grid[index]);
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

    if (typeof window !== 'undefined' && window.__turfDebug) {
      window.__turfDebug.tick = state.tick;
      window.__turfDebug.ownedCells = {
        p1: state.player1.territoryCells,
        p2: state.player2.territoryCells,
      };
      window.__turfDebug.renderedFrames++;
    }

    const youPercent = Math.round((state.player1.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
    const foePercent = Math.round((state.player2.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
    const seconds = Math.floor((3000 - state.tick) / 20);
    setHud(`You: ${youPercent}% | Time: ${seconds}s | Bot: ${foePercent}%`);
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
    const winner = result.winner === 0 ? 'Draw' : `Player ${result.winner} wins`;
    const text = `${winner} - ${result.reason}`;
    setHud(text, true);
    if (typeof window !== 'undefined' && window.__turfDebug) {
      window.__turfDebug.result = text;
    }
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: BOARD_SIZE,
  height: BOARD_SIZE,
  parent: 'game-container',
  backgroundColor: '#0F172A',
  scene: [GameScene],
  banner: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    expandParent: false,
    width: BOARD_SIZE,
    height: BOARD_SIZE,
  },
};

const game = new Phaser.Game(config);

window.addEventListener('resize', () => {
  game.scale.refresh();
});

document.getElementById('connectBtn')?.addEventListener('click', async () => {
  const serverUrl = (document.getElementById('serverUrl') as HTMLInputElement).value;
  const statusEl = document.getElementById('status');

  try {
    if (statusEl) statusEl.textContent = 'Connecting...';

    const client = new Client(serverUrl);
    const room = await client.joinOrCreate('turf_duel');

    if (statusEl) statusEl.textContent = `Connected! Room: ${room.roomId}`;

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
