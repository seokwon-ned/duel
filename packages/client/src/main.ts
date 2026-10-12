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
import {
  NEON,
  NEON_HEX,
  mixRgb,
  paintCutter,
  paintHiddenIllustration,
  paintKkumuli,
  paintSpark,
} from './neonArcade.js';

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
  private p1Sprite: Phaser.GameObjects.Image | null = null;
  private p2Sprite: Phaser.GameObjects.Image | null = null;
  private kkumuli: Phaser.GameObjects.Image | null = null;
  private sparkSprites: Phaser.GameObjects.Image[] = [];
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
    this.art = document.createElement('canvas');
    this.art.width = BOARD_W;
    this.art.height = BOARD_H;
    paintHiddenIllustration(this.art.getContext('2d')!, BOARD_W, BOARD_H);
    this.canvas = document.createElement('canvas');
    this.canvas.width = BOARD_W;
    this.canvas.height = BOARD_H;
    this.texture = this.textures.addCanvas('cover-board', this.canvas);
    this.boardImage = this.add.image(0, 0, 'cover-board').setOrigin(0);
    this.trailGfx = this.add.graphics();
    this.addPaintedTexture('cutter-me', 24, (g, s) => paintCutter(g, s, NEON.me));
    this.addPaintedTexture('cutter-foe', 24, (g, s) => paintCutter(g, s, NEON.foe));
    this.addPaintedTexture('kkumuli', 64, paintKkumuli);
    this.addPaintedTexture('sparx', 20, paintSpark);
    this.p1Sprite = this.add.image(0, 0, 'cutter-me');
    this.p2Sprite = this.add.image(0, 0, 'cutter-foe');
    this.kkumuli = this.add.image(0, 0, 'kkumuli');
    this.sparkSprites = [this.add.image(0, 0, 'sparx'), this.add.image(0, 0, 'sparx')];
    this.setActorsVisible(false);
    this.paintGrid(createInitialState().grid);
    this.layoutBoard();
    this.scale.on('resize', () => this.layoutBoard());
    this.attachKeyboard();
    this.attachDragPad();
  }

  private addPaintedTexture(key: string, size: number, paint: (g: CanvasRenderingContext2D, s: number) => void) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    paint(c.getContext('2d')!, size);
    this.textures.addCanvas(key, c);
  }

  private layoutBoard() {
    const w = this.scale.width;
    const h = this.scale.height;
    const scale = Math.min(w / BOARD_W, h / BOARD_H);
    if (this.boardImage) {
      this.boardImage.setScale(scale).setPosition((w - BOARD_W * scale) / 2, 0);
    }
    this.redrawOverlay(this.matchState?.player1.trail ?? [], this.matchState?.player2.trail ?? []);
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

  private setActorsVisible(visible: boolean) {
    this.p1Sprite?.setVisible(visible);
    this.p2Sprite?.setVisible(visible);
    this.kkumuli?.setVisible(visible);
    for (const spark of this.sparkSprites) spark.setVisible(visible);
  }

  startOnlineMode(room: Room) {
    this.room = room;
    this.setActorsVisible(true);
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
    this.setActorsVisible(true);
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
    this.redrawOverlay([], []);
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
    this.redrawOverlay(state.player1.trail, state.player2.trail);
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

  private redrawOverlay(
    trail1: { x: number; y: number }[],
    trail2?: { x: number; y: number }[],
  ) {
    if (!this.trailGfx || !this.boardImage) return;
    this.trailGfx.clear();
    const scale = this.boardImage.scaleX;
    const ox = this.boardImage.x;
    const oy = this.boardImage.y;
    const bw = BOARD_W * scale;
    const bh = BOARD_H * scale;
    this.trailGfx.lineStyle(3, NEON_HEX.cyan, 0.55);
    this.trailGfx.strokeRect(ox + 0.5, oy + 0.5, bw - 1, bh - 1);
    this.strokeTrail(trail1, NEON_HEX.me, ox, oy, scale);
    if (trail2) this.strokeTrail(trail2, NEON_HEX.foe, ox, oy, scale);
  }

  private strokeTrail(
    trail: { x: number; y: number }[],
    color: number,
    ox: number,
    oy: number,
    scale: number,
  ) {
    if (!this.trailGfx || trail.length < 2) return;
    this.trailGfx.lineStyle(5, color, 0.28);
    this.trailGfx.beginPath();
    this.trailGfx.moveTo(ox + (trail[0].x + 0.5) * scale, oy + (trail[0].y + 0.5) * scale);
    for (let i = 1; i < trail.length; i++) {
      this.trailGfx.lineTo(ox + (trail[i].x + 0.5) * scale, oy + (trail[i].y + 0.5) * scale);
    }
    this.trailGfx.strokePath();
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
    const place = (sprite: Phaser.GameObjects.Image | null, p: { x: number; y: number }, size: number) => {
      if (!sprite) return;
      sprite.setPosition(ox + (p.x + 0.5) * scale, oy + (p.y + 0.5) * scale);
      sprite.setDisplaySize(Math.max(8, size * scale), Math.max(8, size * scale));
    };
    place(this.p1Sprite, p1, 6);
    place(this.p2Sprite, p2, 6);
    place(this.kkumuli, boss, 14);
    place(this.sparkSprites[0], s1, 5);
    place(this.sparkSprites[1], s2, 5);
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
          out.data[i] = 14; out.data[i + 1] = 116; out.data[i + 2] = 144; out.data[i + 3] = 255;
        } else {
          const src: [number, number, number] = [img[i], img[i + 1], img[i + 2]];
          const tinted =
            cell === CellType.PLAYER1_OPEN || cell === CellType.PLAYER1_TRAIL
              ? mixRgb(src, [255, 122, 26], cell === CellType.PLAYER1_TRAIL ? 0.85 : 0.55)
              : mixRgb(src, [47, 107, 255], cell === CellType.PLAYER2_TRAIL ? 0.85 : 0.55);
          out.data[i] = tinted[0]; out.data[i + 1] = tinted[1]; out.data[i + 2] = tinted[2]; out.data[i + 3] = 255;
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
