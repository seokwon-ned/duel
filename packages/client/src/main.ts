import Phaser from 'phaser';
import { Client, Room } from '@colyseus/sdk';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  CellType,
  GRID_WIDTH,
  GRID_HEIGHT,
  TOTAL_CELLS,
  MATCH_DURATION_TICKS,
  TICKS_PER_SECOND,
  wrapAngle,
  inflateGrid,
} from '@turf-duel/engine';
import { Bot } from '@turf-duel/bot';

const BOARD_W = GRID_WIDTH;
const BOARD_H = GRID_HEIGHT;

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
    direction: Direction.UP,
    result: null,
  };
}

function setPlaying(playing: boolean) {
  document.getElementById('app')?.classList.toggle('playing', playing);
  requestAnimationFrame(() => game.scale.refresh());
}

function heartsText(n: number): string {
  return '♥'.repeat(Math.max(0, n)) + '♡'.repeat(Math.max(0, 3 - n));
}

function setHud(opts: {
  youHearts: number;
  foeHearts: number;
  tick: number;
  youCells: number;
  foeCells: number;
  result?: string | null;
}) {
  const youH = document.getElementById('heartsYou');
  const foeH = document.getElementById('heartsFoe');
  const timer = document.getElementById('timer');
  const barP1 = document.getElementById('barP1');
  const barP2 = document.getElementById('barP2');
  const hud = document.getElementById('matchHud');
  if (youH) youH.textContent = heartsText(opts.youHearts);
  if (foeH) foeH.textContent = heartsText(opts.foeHearts);
  const remain = Math.max(0, MATCH_DURATION_TICKS - opts.tick);
  const sec = Math.floor(remain / TICKS_PER_SECOND);
  if (timer) timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const youPct = (opts.youCells * 100) / TOTAL_CELLS;
  const foePct = (opts.foeCells * 100) / TOTAL_CELLS;
  if (barP1) barP1.style.width = `${youPct}%`;
  if (barP2) barP2.style.width = `${foePct}%`;
  if (hud) {
    hud.classList.toggle('result', Boolean(opts.result));
    hud.textContent = opts.result
      ? opts.result
      : `${youPct.toFixed(0)}%   ${foePct.toFixed(0)}%`;
  }
}

class GameScene extends Phaser.Scene {
  private canvas!: HTMLCanvasElement;
  private art!: HTMLCanvasElement;
  private texture: Phaser.Textures.CanvasTexture | null = null;
  private boardImage: Phaser.GameObjects.Image | null = null;
  private trailGfx: Phaser.GameObjects.Graphics | null = null;
  private actors: Phaser.GameObjects.Arc[] = [];
  private room: Room | null = null;
  private matchState: MatchState | null = null;
  private playerNum: 1 | 2 = 1;
  private heading = 192;
  private thrusting = false;
  private bot: Bot | null = null;
  private botInterval: ReturnType<typeof setInterval> | null = null;
  private localGrid: CellType[][] = createInitialState().grid;

  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this.art = this.makePlaceholderArt();
    this.canvas = document.createElement('canvas');
    this.canvas.width = BOARD_W;
    this.canvas.height = BOARD_H;
    this.texture = this.textures.addCanvas('cover-board', this.canvas);
    this.boardImage = this.add.image(0, 0, 'cover-board').setOrigin(0);
    this.trailGfx = this.add.graphics();
    this.actors = [
      this.add.circle(0, 0, 3, 0xFF7A1A),
      this.add.circle(0, 0, 3, 0x2F6BFF),
      this.add.circle(0, 0, 4, 0x22c55e),
      this.add.circle(0, 0, 2, 0xfacc15),
      this.add.circle(0, 0, 2, 0xfacc15),
    ];
    this.paintGrid(createInitialState().grid);
    this.layoutBoard();
    this.scale.on('resize', () => this.layoutBoard());
    this.attachKeyboard();
    this.attachDragPad();
  }

  private makePlaceholderArt(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = BOARD_W;
    c.height = BOARD_H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1b3a4b';
    g.fillRect(0, 0, BOARD_W, BOARD_H);
    g.fillStyle = '#f4d35e';
    g.beginPath();
    g.arc(40, 40, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3d5a3d';
    g.beginPath();
    g.moveTo(0, BOARD_H);
    g.lineTo(70, 160);
    g.lineTo(140, BOARD_H);
    g.fill();
    g.fillStyle = '#2f4858';
    g.beginPath();
    g.moveTo(80, BOARD_H);
    g.lineTo(160, 120);
    g.lineTo(BOARD_W, BOARD_H);
    g.fill();
    g.fillStyle = '#e07a5f';
    g.fillRect(150, 210, 18, 40);
    g.fillStyle = '#81b29a';
    g.beginPath();
    g.arc(159, 200, 16, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  private layoutBoard() {
    const w = this.scale.width;
    const h = this.scale.height;
    const scale = Math.min(w / BOARD_W, h / BOARD_H);
    if (this.boardImage) {
      this.boardImage.setScale(scale).setPosition((w - BOARD_W * scale) / 2, 0);
    }
  }

  private attachKeyboard() {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      const map: Record<string, number> = {
        ArrowUp: 192, w: 192, W: 192,
        ArrowDown: 64, s: 64, S: 64,
        ArrowLeft: 128, a: 128, A: 128,
        ArrowRight: 0, d: 0, D: 0,
      };
      if (event.key in map) {
        this.heading = map[event.key];
        this.thrusting = true;
        this.sendInput();
      }
    });
    this.input.keyboard?.on('keyup', () => {
      this.thrusting = false;
      this.sendInput();
    });
  }

  private attachDragPad() {
    const pad = document.getElementById('dragPad');
    if (!pad) return;
    let last: { x: number; y: number } | null = null;
    const headingFrom = (dx: number, dy: number) => {
      const ang = Math.atan2(dy, dx);
      return wrapAngle(Math.round((ang / (Math.PI * 2)) * 256) & 255);
    };
    pad.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
      pad.setPointerCapture(e.pointerId);
    });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (dx * dx + dy * dy < 16) {
        this.thrusting = false;
        this.sendInput();
        return;
      }
      this.heading = headingFrom(dx, dy);
      this.thrusting = true;
      this.sendInput();
    });
    const end = () => {
      last = null;
      this.thrusting = false;
      this.sendInput();
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }

  private sendInput() {
    if (window.__turfDebug) window.__turfDebug.direction = (['RIGHT', 'DOWN', 'LEFT', 'UP'] as Direction[])[(wrapAngle(this.heading + 32) >> 6) & 3];
    if (this.room) {
      this.room.send('input', { heading: this.heading, thrusting: this.thrusting });
    }
  }

  startOnlineMode(room: Room) {
    this.room = room;
    setPlaying(true);
    room.onMessage('player', (message: { num: 1 | 2 }) => {
      this.playerNum = message.num;
    });
    room.onMessage('grid', (payload: ArrayLike<number> | ArrayBuffer) => {
      const buf = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
      const w = (room.state as { gridWidth?: number }).gridWidth || BOARD_W;
      const h = (room.state as { gridHeight?: number }).gridHeight || BOARD_H;
      this.localGrid = inflateGrid(buf, w, h);
      this.paintGrid(this.localGrid);
    });
    room.onStateChange(() => this.renderFromRoom());
  }

  startBotMode() {
    this.room = null;
    this.matchState = createInitialState();
    this.bot = new Bot('normal', 2, 11);
    setPlaying(true);
    this.renderState(this.matchState);
    this.botInterval = setInterval(() => {
      if (!this.matchState || this.matchState.result) {
        if (this.botInterval) clearInterval(this.botInterval);
        return;
      }
      const botMove = this.bot!.getNextMove(this.matchState);
      const result = step(this.matchState, [
        { player: 1, heading: this.heading, thrusting: this.thrusting },
        botMove,
      ]);
      this.matchState = result.state;
      this.renderState(this.matchState);
    }, 50);
  }

  private renderFromRoom() {
    if (!this.room) return;
    const state = this.room.state as any;
    const w = state.gridWidth || BOARD_W;
    if (state.cellUpdates?.length) {
      for (const u of state.cellUpdates) {
        if (this.localGrid[u.y]) this.localGrid[u.y][u.x] = u.type;
      }
    } else if (state.grid?.length) {
      this.localGrid = inflateGrid(state.grid, w, state.gridHeight || BOARD_H);
    }
    this.paintGrid(this.localGrid);
    if (state.player1?.position) {
      this.paintActors(state.player1.position, state.player2.position, state.boss, state.sparx1, state.sparx2);
    }
    const you = this.playerNum === 1 ? state.player1 : state.player2;
    const foe = this.playerNum === 1 ? state.player2 : state.player1;
    const result = state.result ? `${state.result.winner === 0 ? 'Draw' : `Player ${state.result.winner} wins`} - ${state.result.reason}` : null;
    setHud({
      youHearts: you.hearts ?? 3,
      foeHearts: foe.hearts ?? 3,
      tick: state.tick,
      youCells: you.territoryCells,
      foeCells: foe.territoryCells,
      result,
    });
    this.bumpDebug(state.tick, state.player1.territoryCells, state.player2.territoryCells, result);
  }

  private renderState(state: MatchState) {
    this.paintGrid(state.grid);
    this.paintActors(state.player1.position, state.player2.position, {
      x: state.boss.xFp >> 8,
      y: state.boss.yFp >> 8,
    }, {
      x: state.sparx1.xFp >> 8,
      y: state.sparx1.yFp >> 8,
    }, {
      x: state.sparx2.xFp >> 8,
      y: state.sparx2.yFp >> 8,
    });
    this.drawTrailCurve(state.player1.trail, 0xFF9A4A);
    const result = state.result
      ? `${state.result.winner === 0 ? 'Draw' : `Player ${state.result.winner} wins`} - ${state.result.reason}`
      : null;
    setHud({
      youHearts: state.player1.hearts,
      foeHearts: state.player2.hearts,
      tick: state.tick,
      youCells: state.player1.territoryCells,
      foeCells: state.player2.territoryCells,
      result,
    });
    this.bumpDebug(state.tick, state.player1.territoryCells, state.player2.territoryCells, result);
  }

  private drawTrailCurve(trail: { x: number; y: number }[], color: number) {
    if (!this.trailGfx || !this.boardImage) return;
    this.trailGfx.clear();
    if (trail.length < 2) return;
    const scale = this.boardImage.scaleX;
    const ox = this.boardImage.x;
    const oy = this.boardImage.y;
    this.trailGfx.lineStyle(2, color, 1);
    this.trailGfx.beginPath();
    this.trailGfx.moveTo(ox + (trail[0].x + 0.5) * scale, oy + (trail[0].y + 0.5) * scale);
    for (let i = 1; i < trail.length; i++) {
      this.trailGfx.lineTo(ox + (trail[i].x + 0.5) * scale, oy + (trail[i].y + 0.5) * scale);
    }
    this.trailGfx.strokePath();
  }

  private paintActors(p1: { x: number; y: number }, p2: { x: number; y: number }, boss: { x: number; y: number }, s1: { x: number; y: number }, s2: { x: number; y: number }) {
    if (!this.boardImage) return;
    const scale = this.boardImage.scaleX;
    const ox = this.boardImage.x;
    const oy = this.boardImage.y;
    const place = (arc: Phaser.GameObjects.Arc, p: { x: number; y: number }) => {
      arc.setPosition(ox + (p.x + 0.5) * scale, oy + (p.y + 0.5) * scale);
      arc.setRadius(Math.max(2, scale));
    };
    place(this.actors[0], p1);
    place(this.actors[1], p2);
    place(this.actors[2], boss);
    place(this.actors[3], s1);
    place(this.actors[4], s2);
  }

  private paintGrid(grid: CellType[][]) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const art = this.art.getContext('2d')!;
    const h = grid.length;
    const w = grid[0]?.length ?? 0;
    const img = art.getImageData(0, 0, w, h).data;
    const out = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cell = grid[y][x];
        if (cell === CellType.COVER) {
          out.data[i] = 15; out.data[i + 1] = 23; out.data[i + 2] = 42; out.data[i + 3] = 255;
        } else if (cell === CellType.SAFE_EDGE) {
          out.data[i] = 30; out.data[i + 1] = 41; out.data[i + 2] = 59; out.data[i + 3] = 255;
        } else {
          let r = img[i], g = img[i + 1], b = img[i + 2];
          if (cell === CellType.PLAYER1_OPEN || cell === CellType.PLAYER1_TRAIL) {
            r = Math.min(255, r + 80); g = Math.min(255, g + 20);
          } else if (cell === CellType.PLAYER2_OPEN || cell === CellType.PLAYER2_TRAIL) {
            b = Math.min(255, b + 90);
          }
          out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(out, 0, 0);
    this.texture?.refresh();
  }

  private bumpDebug(tick: number, p1: number, p2: number, result: string | null) {
    if (!window.__turfDebug) return;
    window.__turfDebug.tick = tick;
    window.__turfDebug.ownedCells = { p1, p2 };
    window.__turfDebug.renderedFrames++;
    window.__turfDebug.result = result;
  }
}

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: 'game-container',
  backgroundColor: '#0F172A',
  width: BOARD_W,
  height: BOARD_H,
  banner: false,
  scene: [GameScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_HORIZONTALLY,
    expandParent: false,
    width: BOARD_W,
    height: BOARD_H,
  },
});

window.addEventListener('resize', () => game.scale.refresh());

document.getElementById('debugToggle')?.addEventListener('click', () => {
  document.getElementById('app')?.classList.toggle('debug');
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
    scene.startOnlineMode(room);
  } catch (error) {
    if (statusEl) statusEl.textContent = `Error: ${error}`;
  }
});

document.getElementById('botBtn')?.addEventListener('click', () => {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Playing vs Bot (offline)';
  const scene = game.scene.scenes[0] as GameScene;
  scene.startBotMode();
});
