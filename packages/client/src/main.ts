import Phaser from 'phaser';
import { Client, Room } from '@colyseus/sdk';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  CellType,
  GameEvent,
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
  A,
  AH,
  mixRgb,
  paintCoverSheet,
  paintHiddenIllustration,
  paintKkumuli,
  paintOrb,
  paintSpark,
  paintParticleDot,
} from './visualA.js';

const BOARD_W = GRID_WIDTH;
const BOARD_H = GRID_HEIGHT;
const AFTERIMAGES = 6;

interface TurfDebug {
  tick: number;
  ownedCells: { p1: number; p2: number };
  renderedFrames: number;
  direction: Direction;
  result: string | null;
  cutFx: boolean;
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
    cutFx: false,
  };
}

function setPlaying(playing: boolean) {
  document.getElementById('app')?.classList.toggle('playing', playing);
  requestAnimationFrame(() => game.scale.refresh());
}

function renderHearts(el: HTMLElement | null, n: number, broke: boolean) {
  if (!el) return;
  const filled = Math.max(0, Math.min(3, n));
  el.innerHTML = [0, 1, 2]
    .map((i) => {
      const on = i < filled;
      const br = broke && i === filled;
      return `<span class="heart${on ? ' on' : ''}${br ? ' break' : ''}"></span>`;
    })
    .join('');
}

function setHud(opts: {
  youHearts: number;
  foeHearts: number;
  tick: number;
  youCells: number;
  foeCells: number;
  result?: string | null;
  brokeYou?: boolean;
  brokeFoe?: boolean;
  foeIsBot?: boolean;
  matchTicks?: number;
}) {
  renderHearts(document.getElementById('heartsYou'), opts.youHearts, Boolean(opts.brokeYou));
  renderHearts(document.getElementById('heartsFoe'), opts.foeHearts, Boolean(opts.brokeFoe));
  const foeName = document.getElementById('nameFoe');
  if (foeName) foeName.textContent = opts.foeIsBot ? '상대 🤖' : '상대';
  const timer = document.getElementById('timer');
  const remain = Math.max(0, (opts.matchTicks ?? MATCH_DURATION_TICKS) - opts.tick);
  const sec = Math.floor(remain / TICKS_PER_SECOND);
  if (timer) timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const youPct = (opts.youCells * 100) / TOTAL_CELLS;
  const foePct = (opts.foeCells * 100) / TOTAL_CELLS;
  const barP1 = document.getElementById('barP1');
  const barP2 = document.getElementById('barP2');
  const youL = document.getElementById('barPctYou');
  const foeL = document.getElementById('barPctFoe');
  if (barP1) barP1.style.width = `${youPct}%`;
  if (barP2) barP2.style.width = `${foePct}%`;
  if (youL) youL.textContent = `${youPct.toFixed(0)}%`;
  if (foeL) foeL.textContent = `${foePct.toFixed(0)}%`;
  const hud = document.getElementById('matchHud');
  if (hud) {
    hud.classList.toggle('result', Boolean(opts.result));
    hud.textContent = opts.result ?? '';
  }
}

type BurstEmitter = { explode: (quantity: number, x: number, y: number) => void };

function addGlow(obj: Phaser.GameObjects.GameObject | null, color: number, outer = 4): void {
  if (!obj) return;
  try {
    obj.enableFilters();
    obj.filters?.internal.addGlow(color, outer, 0, 1, false, 8, 10);
  } catch {
    /* canvas renderer has no glow filters */
  }
}

class GameScene extends Phaser.Scene {
  private canvas!: HTMLCanvasElement;
  private art!: HTMLCanvasElement;
  private coverSheet!: HTMLCanvasElement;
  private kkCanvas!: HTMLCanvasElement;
  private texture: Phaser.Textures.CanvasTexture | null = null;
  private kkTexture: Phaser.Textures.CanvasTexture | null = null;
  private boardImage: Phaser.GameObjects.Image | null = null;
  private trailGfx: Phaser.GameObjects.Graphics | null = null;
  private p1Sprite: Phaser.GameObjects.Image | null = null;
  private p2Sprite: Phaser.GameObjects.Image | null = null;
  private kkumuli: Phaser.GameObjects.Image | null = null;
  private sparkSprites: Phaser.GameObjects.Image[] = [];
  private afterimages: Phaser.GameObjects.Image[] = [];
  private cutEmitter: BurstEmitter | null = null;
  private hitEmitter: BurstEmitter | null = null;
  private winEmitter: BurstEmitter | null = null;
  private room: Room | null = null;
  private matchState: MatchState | null = null;
  private playerNum: 1 | 2 = 1;
  private heading = 192;
  private thrusting = false;
  private bot: Bot | null = null;
  private botInterval: ReturnType<typeof setInterval> | null = null;
  private localGrid: CellType[][] = createInitialState().grid;
  private qaMode = false;
  private qaTick = 0;
  private qaClaimed = false;
  private melt = 0;
  private melting = false;
  private lastYouHearts = 3;
  private lastFoeHearts = 3;
  private lastP1: { x: number; y: number }[] = [];
  private p1TrailCopy: { x: number; y: number }[] = [];
  private angry = false;
  private cutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this.art = document.createElement('canvas');
    this.art.width = BOARD_W;
    this.art.height = BOARD_H;
    paintHiddenIllustration(this.art.getContext('2d')!, BOARD_W, BOARD_H);

    this.coverSheet = document.createElement('canvas');
    this.coverSheet.width = BOARD_W;
    this.coverSheet.height = BOARD_H;
    paintCoverSheet(this.coverSheet.getContext('2d')!, BOARD_W, BOARD_H);

    this.canvas = document.createElement('canvas');
    this.canvas.width = BOARD_W;
    this.canvas.height = BOARD_H;
    this.texture = this.textures.addCanvas('cover-board', this.canvas);
    this.boardImage = this.add.image(0, 0, 'cover-board').setOrigin(0);
    addGlow(this.boardImage, AH.purple, 3);

    this.trailGfx = this.add.graphics();
    this.addPaintedTexture('orb-me', 28, (g, s) => paintOrb(g, s, A.me));
    this.addPaintedTexture('orb-foe', 28, (g, s) => paintOrb(g, s, A.foe, true));
    this.addPaintedTexture('sparx', 22, paintSpark);
    this.addPaintedTexture('dot-me', 8, (g, s) => paintParticleDot(g, s, A.me));
    this.addPaintedTexture('dot-accent', 8, (g, s) => paintParticleDot(g, s, A.accent));
    this.addPaintedTexture('dot-white', 8, (g, s) => paintParticleDot(g, s, A.text));
    this.addPaintedTexture('dot-spark', 8, (g, s) => paintParticleDot(g, s, A.spark));
    this.addPaintedTexture('dot-heart', 8, (g, s) => paintParticleDot(g, s, A.heart));

    this.kkCanvas = document.createElement('canvas');
    this.kkCanvas.width = 72;
    this.kkCanvas.height = 72;
    paintKkumuli(this.kkCanvas.getContext('2d')!, 72, 0, false);
    this.kkTexture = this.textures.addCanvas('kkumuli', this.kkCanvas);

    this.p1Sprite = this.add.image(0, 0, 'orb-me');
    this.p2Sprite = this.add.image(0, 0, 'orb-foe');
    this.kkumuli = this.add.image(0, 0, 'kkumuli');
    this.sparkSprites = [this.add.image(0, 0, 'sparx'), this.add.image(0, 0, 'sparx')];
    addGlow(this.p1Sprite, AH.me, 5);
    addGlow(this.p2Sprite, AH.foe, 5);
    addGlow(this.kkumuli, 0xdb2777, 6);
    for (const s of this.sparkSprites) addGlow(s, AH.spark, 4);

    for (let i = 0; i < AFTERIMAGES; i++) {
      const ghost = this.add.image(0, 0, 'orb-me').setAlpha(0);
      this.afterimages.push(ghost);
    }

    this.cutEmitter = this.makeBurst('dot-accent');
    this.hitEmitter = this.makeBurst('dot-heart');
    this.winEmitter = this.makeBurst('dot-spark');

    this.setActorsVisible(false);
    this.paintGrid(createInitialState().grid);
    this.layoutBoard();
    this.scale.on('resize', () => this.layoutBoard());
    this.attachKeyboard();
    this.attachDragPad();
  }

  update(time: number) {
    if (this.kkumuli?.visible && this.kkTexture) {
      paintKkumuli(this.kkCanvas.getContext('2d')!, 72, time / 1000, this.angry);
      this.kkTexture.refresh();
    }
    for (const spark of this.sparkSprites) {
      if (spark.visible) spark.rotation += 0.04;
    }
    if (this.melting && this.localGrid) {
      this.melt = Math.min(1, this.melt + 0.05);
      this.paintGrid(this.localGrid);
      if (this.melt >= 1) this.melting = false;
    }
  }

  private makeBurst(key: string): BurstEmitter | null {
    try {
      const emitter = this.add.particles(0, 0, key, {
        lifespan: 700,
        speed: { min: 40, max: 180 },
        scale: { start: 1.1, end: 0 },
        emitting: false,
        blendMode: 'ADD',
        quantity: 1,
      });
      return emitter as unknown as BurstEmitter;
    } catch {
      return null;
    }
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
      this.boardImage.setScale(scale).setPosition((w - BOARD_W * scale) / 2, (h - BOARD_H * scale) / 2);
    }
    this.redrawOverlay(this.matchState?.player1.trail ?? this.p1TrailCopy, this.matchState?.player2.trail ?? []);
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
      if (this.qaMode && !this.qaClaimed) return;
      last = { x: e.clientX, y: e.clientY };
      this.thrusting = true;
      pad.setPointerCapture(e.pointerId);
      this.sendInput();
    });
    pad.addEventListener('pointermove', (e) => {
      if (this.qaMode && !this.qaClaimed) return;
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (dx * dx + dy * dy >= 4) {
        this.heading = headingFrom(dx, dy);
        last = { x: e.clientX, y: e.clientY };
      }
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
    if (window.__turfDebug) {
      window.__turfDebug.direction = (['RIGHT', 'DOWN', 'LEFT', 'UP'] as Direction[])[(wrapAngle(this.heading + 32) >> 6) & 3];
    }
    if (this.room) {
      this.room.send('input', { heading: this.heading, thrusting: this.thrusting });
    }
  }

  private setActorsVisible(visible: boolean) {
    this.p1Sprite?.setVisible(visible);
    this.p2Sprite?.setVisible(visible);
    this.kkumuli?.setVisible(visible);
    for (const spark of this.sparkSprites) spark.setVisible(visible);
    for (const g of this.afterimages) g.setVisible(visible);
  }

  startOnlineMode(room: Room) {
    this.room = room;
    this.qaMode = false;
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
    this.qaMode = new URLSearchParams(window.location.search).has('qa');
    this.qaTick = 0;
    this.qaClaimed = false;
    this.melt = 0;
    this.melting = false;
    this.matchState = createInitialState(this.qaMode ? { matchTicks: 80 } : undefined);
    this.bot = new Bot('normal', 2, 11);
    this.setActorsVisible(true);
    setPlaying(true);
    this.renderState(this.matchState, []);
    this.botInterval = setInterval(() => {
      if (!this.matchState || this.matchState.result) {
        if (this.botInterval) clearInterval(this.botInterval);
        if (this.matchState?.result) this.playWinFx();
        return;
      }
      const heading = this.qaHeading();
      const botMove = this.bot!.getNextMove(this.matchState);
      const prevTrail = this.matchState.player1.trail.slice();
      const result = step(this.matchState, [
        { player: 1, heading, thrusting: this.qaMode && !this.qaClaimed ? true : this.thrusting },
        botMove,
      ]);
      this.matchState = result.state;
      this.p1TrailCopy = this.matchState.player1.trail.length ? this.matchState.player1.trail : prevTrail;
      this.handleEvents(result.events, prevTrail);
      this.renderState(this.matchState, result.events);
    }, 50);
  }

  private qaHeading(): number {
    if (!this.qaMode || this.qaClaimed) return this.heading;
    this.qaTick++;
    if (this.qaTick <= 16) return 192;
    if (this.qaTick <= 30) return 0;
    return 64;
  }

  private handleEvents(events: GameEvent[], prevTrail: { x: number; y: number }[]) {
    for (const ev of events) {
      if (ev.type === 'claim') {
        if (ev.player === 1) this.qaClaimed = true;
        this.playCutFx(ev.data?.cells ?? 0);
      }
      if (ev.type === 'heart') this.playHitFx(ev.player === 1 ? prevTrail : []);
      if (ev.type === 'win') this.playWinFx();
    }
  }

  private playCutFx(cells: number) {
    const pct = Math.max(6, Math.round((cells / TOTAL_CELLS) * 100) || 6);
    const popup = document.getElementById('cutPopup');
    const stack = document.getElementById('cutStack');
    if (popup) popup.textContent = `+${pct}%`;
    stack?.classList.remove('show', 'pop');
    void stack?.offsetWidth;
    stack?.classList.add('show', 'pop');
    if (window.__turfDebug) window.__turfDebug.cutFx = true;
    if (this.cutTimer) clearTimeout(this.cutTimer);
    this.cutTimer = setTimeout(() => {
      stack?.classList.remove('show', 'pop');
      if (window.__turfDebug) window.__turfDebug.cutFx = false;
    }, 1400);
    this.cameras.main.shake(180, 0.012);
    const pos = this.worldOf(this.matchState?.player1.position ?? { x: BOARD_W / 2, y: BOARD_H - 8 });
    this.burst(this.cutEmitter, pos.x, pos.y, 70, ['dot-me', 'dot-accent', 'dot-white']);
  }

  private playHitFx(trail: { x: number; y: number }[]) {
    const flash = document.getElementById('hitFlash');
    flash?.classList.add('on');
    setTimeout(() => flash?.classList.remove('on'), 180);
    for (const p of trail.slice(0, 40)) {
      const w = this.worldOf(p);
      this.burst(this.hitEmitter, w.x, w.y, 3, ['dot-me', 'dot-white']);
    }
  }

  private playWinFx() {
    this.melting = true;
    const w = this.scale.width;
    for (let i = 0; i < 48; i++) {
      const x = Math.random() * w;
      this.burst(this.winEmitter, x, 8, 2, ['dot-accent', 'dot-spark', 'dot-me', 'dot-white']);
    }
  }

  private burst(
    emitter: BurstEmitter | null,
    x: number,
    y: number,
    n: number,
    keys: string[],
  ) {
    try {
      emitter?.explode(n, x, y);
    } catch {
      /* canvas / API mismatch — tween sprites below still play */
    }
    for (let i = 0; i < n; i++) {
      const img = this.add.image(x, y, keys[i % keys.length]);
      img.setDepth(20);
      const ang = Math.random() * Math.PI * 2;
      const dist = 20 + Math.random() * 70;
      this.tweens.add({
        targets: img,
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist,
        alpha: 0,
        scale: 0.2,
        duration: 500 + Math.random() * 280,
        onComplete: () => img.destroy(),
      });
    }
  }

  private worldOf(p: { x: number; y: number }): { x: number; y: number } {
    const scale = this.boardImage?.scaleX ?? 1;
    const ox = this.boardImage?.x ?? 0;
    const oy = this.boardImage?.y ?? 0;
    return { x: ox + (p.x + 0.5) * scale, y: oy + (p.y + 0.5) * scale };
  }

  private renderFromRoom() {
    if (!this.room) return;
    const state = this.room.state as {
      gridWidth?: number;
      gridHeight?: number;
      cellUpdates?: { x: number; y: number; type: CellType }[];
      grid?: ArrayLike<number>;
      player1: { position: { x: number; y: number }; hearts?: number; territoryCells: number; trail?: { x: number; y: number }[] };
      player2: { position: { x: number; y: number }; hearts?: number; territoryCells: number; trail?: { x: number; y: number }[] };
      boss: { x: number; y: number };
      sparx1: { x: number; y: number };
      sparx2: { x: number; y: number };
      tick: number;
      result?: { winner: number; reason: string };
    };
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
    const result = state.result
      ? `${state.result.winner === 0 ? '무승부' : `플레이어 ${state.result.winner} 승`} · ${state.result.reason}`
      : null;
    const brokeYou = (you.hearts ?? 3) < this.lastYouHearts;
    const brokeFoe = (foe.hearts ?? 3) < this.lastFoeHearts;
    if (brokeYou) this.playHitFx(this.p1TrailCopy);
    this.lastYouHearts = you.hearts ?? 3;
    this.lastFoeHearts = foe.hearts ?? 3;
    if (result && !this.melting && this.melt === 0) this.playWinFx();
    this.redrawOverlay(state.player1.trail ?? [], state.player2.trail ?? []);
    setHud({
      youHearts: you.hearts ?? 3,
      foeHearts: foe.hearts ?? 3,
      tick: state.tick,
      youCells: you.territoryCells,
      foeCells: foe.territoryCells,
      result,
      brokeYou,
      brokeFoe,
      matchTicks: (state as { matchTicks?: number }).matchTicks,
    });
    this.bumpDebug(state.tick, state.player1.territoryCells, state.player2.territoryCells, result);
  }

  private renderState(state: MatchState, events: GameEvent[]) {
    this.localGrid = state.grid;
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
    const drawing = state.player1.drawing || state.player2.drawing;
    const open = (state.player1.territoryCells + state.player2.territoryCells) / TOTAL_CELLS;
    this.angry = drawing || open > 0.12;
    this.redrawOverlay(state.player1.trail, state.player2.trail);
    const result = state.result
      ? `${state.result.winner === 0 ? '무승부' : `플레이어 ${state.result.winner} 승`} · ${state.result.reason}`
      : null;
    const brokeYou = state.player1.hearts < this.lastYouHearts;
    const brokeFoe = state.player2.hearts < this.lastFoeHearts;
    this.lastYouHearts = state.player1.hearts;
    this.lastFoeHearts = state.player2.hearts;
    setHud({
      youHearts: state.player1.hearts,
      foeHearts: state.player2.hearts,
      tick: state.tick,
      youCells: state.player1.territoryCells,
      foeCells: state.player2.territoryCells,
      result,
      brokeYou,
      brokeFoe,
      foeIsBot: true,
      matchTicks: state.matchTicks,
    });
    this.bumpDebug(state.tick, state.player1.territoryCells, state.player2.territoryCells, result);
    void events;
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
    this.trailGfx.lineStyle(4, AH.purple, 0.85);
    this.trailGfx.strokeRoundedRect(ox + 1, oy + 1, bw - 2, bh - 2, Math.min(18, scale * 8));
    this.strokeGlowLine(trail1, AH.me, AH.core, ox, oy, scale, false);
    if (trail2) this.strokeGlowLine(trail2, AH.foe, 0xffffff, ox, oy, scale, true);
  }

  private strokeGlowLine(
    trail: { x: number; y: number }[],
    glow: number,
    core: number,
    ox: number,
    oy: number,
    scale: number,
    dashed: boolean,
  ) {
    if (!this.trailGfx || trail.length < 2) return;
    const pts = trail.map((p) => ({ x: ox + (p.x + 0.5) * scale, y: oy + (p.y + 0.5) * scale }));
    const draw = (width: number, color: number, alpha: number) => {
      this.trailGfx!.lineStyle(width, color, alpha);
      if (dashed) {
        this.drawDashed(pts, Math.max(6, scale * 3), Math.max(4, scale * 2));
        return;
      }
      this.drawCurve(pts);
    };
    draw(Math.max(7, scale * 2.4), glow, 0.28);
    draw(Math.max(4, scale * 1.4), glow, 0.85);
    draw(Math.max(1.5, scale * 0.55), core, 1);
  }

  private drawCurve(pts: { x: number; y: number }[]) {
    const g = this.trailGfx!;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const mx = (prev.x + cur.x) / 2;
      const my = (prev.y + cur.y) / 2;
      g.lineTo(mx, my);
    }
    g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    g.strokePath();
  }

  private drawDashed(pts: { x: number; y: number }[], on: number, off: number) {
    const g = this.trailGfx!;
    let acc = 0;
    let drawing = true;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      let x0 = pts[i - 1].x;
      let y0 = pts[i - 1].y;
      const x1 = pts[i].x;
      const y1 = pts[i].y;
      let dx = x1 - x0;
      let dy = y1 - y0;
      let dist = Math.hypot(dx, dy);
      if (dist < 0.001) continue;
      const ux = dx / dist;
      const uy = dy / dist;
      while (dist > 0) {
        const slice = Math.min(dist, drawing ? on - acc : off - acc);
        x0 += ux * slice;
        y0 += uy * slice;
        dist -= slice;
        acc += slice;
        if (drawing) g.lineTo(x0, y0);
        else g.moveTo(x0, y0);
        const limit = drawing ? on : off;
        if (acc >= limit - 0.01) {
          acc = 0;
          drawing = !drawing;
        }
      }
    }
    g.strokePath();
  }

  private paintActors(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    boss: { x: number; y: number },
    s1: { x: number; y: number },
    s2: { x: number; y: number },
  ) {
    if (!this.boardImage) return;
    const scale = this.boardImage.scaleX;
    const place = (sprite: Phaser.GameObjects.Image | null, p: { x: number; y: number }, size: number) => {
      if (!sprite) return;
      const w = this.worldOf(p);
      sprite.setPosition(w.x, w.y);
      sprite.setDisplaySize(Math.max(10, size * scale), Math.max(10, size * scale));
    };
    this.lastP1.push(p1);
    if (this.lastP1.length > AFTERIMAGES) this.lastP1.shift();
    this.afterimages.forEach((img, i) => {
      const src = this.lastP1[this.lastP1.length - 1 - i];
      if (!src) {
        img.setAlpha(0);
        return;
      }
      place(img, src, 5);
      img.setAlpha(0.35 * (1 - i / AFTERIMAGES));
    });
    place(this.p1Sprite, p1, 7);
    place(this.p2Sprite, p2, 7);
    place(this.kkumuli, boss, 16);
    place(this.sparkSprites[0], s1, 6);
    place(this.sparkSprites[1], s2, 6);
  }

  private paintGrid(grid: CellType[][]) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const art = this.art.getContext('2d')!;
    const cover = this.coverSheet.getContext('2d')!;
    const h = grid.length;
    const w = grid[0]?.length ?? 0;
    const img = art.getImageData(0, 0, w, h).data;
    const cov = cover.getImageData(0, 0, w, h).data;
    const out = ctx.createImageData(w, h);
    const openish = (c: CellType) =>
      c === CellType.PLAYER1_OPEN || c === CellType.PLAYER2_OPEN ||
      c === CellType.PLAYER1_TRAIL || c === CellType.PLAYER2_TRAIL ||
      c === CellType.SAFE_EDGE;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cell = grid[y][x];
        if (cell === CellType.COVER) {
          if (this.melt > 0) {
            const mixed = mixRgb([cov[i], cov[i + 1], cov[i + 2]], [img[i], img[i + 1], img[i + 2]], this.melt);
            out.data[i] = mixed[0];
            out.data[i + 1] = mixed[1];
            out.data[i + 2] = mixed[2];
            out.data[i + 3] = 255;
          } else {
            out.data[i] = cov[i];
            out.data[i + 1] = cov[i + 1];
            out.data[i + 2] = cov[i + 2];
            out.data[i + 3] = 255;
          }
        } else {
          const src: [number, number, number] = [img[i], img[i + 1], img[i + 2]];
          let tinted: [number, number, number] = src;
          if (cell === CellType.PLAYER1_OPEN || cell === CellType.PLAYER1_TRAIL) {
            tinted = mixRgb(src, [255, 122, 26], cell === CellType.PLAYER1_TRAIL ? 0.45 : 0.18);
          } else if (cell === CellType.PLAYER2_OPEN || cell === CellType.PLAYER2_TRAIL) {
            tinted = mixRgb(src, [47, 107, 255], cell === CellType.PLAYER2_TRAIL ? 0.45 : 0.18);
          } else if (cell === CellType.SAFE_EDGE) {
            tinted = mixRgb(src, [250, 204, 21], 0.12);
          }
          let edge = false;
          if (openish(cell)) {
            if (x > 0 && grid[y][x - 1] === CellType.COVER) edge = true;
            else if (x + 1 < w && grid[y][x + 1] === CellType.COVER) edge = true;
            else if (y > 0 && grid[y - 1][x] === CellType.COVER) edge = true;
            else if (y + 1 < h && grid[y + 1][x] === CellType.COVER) edge = true;
          }
          if (edge) tinted = mixRgb(tinted, [250, 204, 21], 0.55);
          out.data[i] = tinted[0];
          out.data[i + 1] = tinted[1];
          out.data[i + 2] = tinted[2];
          out.data[i + 3] = 255;
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
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: A.bg,
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
  render: { antialias: true, transparent: false },
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
    if (statusEl) statusEl.textContent = `오류: ${error}`;
  }
});

document.getElementById('botBtn')?.addEventListener('click', () => {
  const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Playing vs Bot (offline)';
  const scene = game.scene.scenes[0] as GameScene;
  scene.startBotMode();
});
