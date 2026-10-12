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
  toFp,
} from '@turf-duel/engine';
import { Bot } from '@turf-duel/bot';
import {
  A,
  AH,
  paintCoverSheet,
  paintHiddenIllustration,
  paintKkumuli,
  paintOrb,
  paintSpark,
  paintParticleDot,
} from './visualA.js';
import { QaPilot, p1CaptureWaypoints, p1HitWaypoints, p2SkyWaypoints } from './qaScript.js';

const BOARD_W = GRID_WIDTH;
const BOARD_H = GRID_HEIGHT;
const AFTERIMAGES = 10;
const KK_TEX = 256;
/** Full sprite ~31% of board so the octopus body reads as ~1/4 width. */
const KK_CELLS = 62;
const ORB_CELLS = 40;
const ORB_TEX = 128;
const QA_STEPS_PER_PULSE = 6;
const QA_STEPS_AFTER_CUT = 16;

interface TurfDebug {
  tick: number;
  ownedCells: { p1: number; p2: number };
  renderedFrames: number;
  direction: Direction;
  result: string | null;
  cutFx: boolean;
  hitFx: boolean;
  winFx: boolean;
  drawing: { p1: boolean; p2: boolean };
  trails: { p1: number; p2: number };
  youHearts: number;
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
    hitFx: false,
    winFx: false,
    drawing: { p1: false, p2: false },
    trails: { p1: 0, p2: 0 },
    youHearts: 3,
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
      const gone = !on && !br && filled === 0;
      return `<span class="heart${on ? ' on' : ''}${br ? ' break' : ''}${gone ? ' gone' : ''}"></span>`;
    })
    .join('');
}

function hideResultOverlay() {
  const overlay = document.getElementById('resultOverlay');
  overlay?.classList.remove('show', 'lose');
}

function showResultOverlay(kind: 'win' | 'lose' | 'tie', reason: string) {
  const overlay = document.getElementById('resultOverlay');
  const title = document.getElementById('resultTitle');
  const sub = document.getElementById('resultSub');
  if (title) title.textContent = kind === 'win' ? '승리!' : kind === 'lose' ? '패배' : '무승부';
  if (sub) sub.textContent = reason;
  overlay?.classList.toggle('lose', kind === 'lose');
  overlay?.classList.add('show');
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
    hud.classList.remove('result');
    hud.textContent = '';
  }
  void opts.result;
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
  private trailGlow: Phaser.GameObjects.Graphics | null = null;
  private afterimages2: Phaser.GameObjects.Image[] = [];
  private qaP1: QaPilot | null = null;
  private qaP2: QaPilot | null = null;
  private lastP2: { x: number; y: number }[] = [];
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
  private qaHit = false;
  private qaLose = false;
  private qaClaimed = false;
  private qaWinAtMs = 0;
  private melt = 0;
  private melting = false;
  private meltSkip = 0;
  private lastYouHearts = 3;
  private lastFoeHearts = 3;
  private lastP1: { x: number; y: number }[] = [];
  private p1TrailCopy: { x: number; y: number }[] = [];
  private angry = false;
  private cutTimer: ReturnType<typeof setTimeout> | null = null;
  private artPix: Uint8ClampedArray | null = null;
  private covPix: Uint8ClampedArray | null = null;
  private outImg: ImageData | null = null;
  private lastKk = 0;
  private resultShown = false;
  private lockedScale = 0;
  private lerpReady = false;
  private shown = {
    p1: { x: 0, y: 0 },
    p2: { x: 0, y: 0 },
    boss: { x: 0, y: 0 },
    s1: { x: 0, y: 0 },
    s2: { x: 0, y: 0 },
  };
  private goal = {
    p1: { x: 0, y: 0 },
    p2: { x: 0, y: 0 },
    boss: { x: 0, y: 0 },
    s1: { x: 0, y: 0 },
    s2: { x: 0, y: 0 },
  };

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

    this.trailGlow = this.add.graphics();
    this.trailGlow.setBlendMode(Phaser.BlendModes.ADD);
    this.trailGlow.setDepth(1);
    this.trailGfx = this.add.graphics();
    this.trailGfx.setDepth(2);
    this.addPaintedTexture('orb-me', ORB_TEX, (g, s) => paintOrb(g, s, A.me));
    this.addPaintedTexture('orb-foe', ORB_TEX, (g, s) => paintOrb(g, s, A.foe, true));
    this.addPaintedTexture('sparx', 48, paintSpark);
    this.addPaintedTexture('dot-me', 8, (g, s) => paintParticleDot(g, s, A.me));
    this.addPaintedTexture('dot-accent', 8, (g, s) => paintParticleDot(g, s, A.accent));
    this.addPaintedTexture('dot-white', 8, (g, s) => paintParticleDot(g, s, A.text));
    this.addPaintedTexture('dot-spark', 8, (g, s) => paintParticleDot(g, s, A.spark));
    this.addPaintedTexture('dot-heart', 8, (g, s) => paintParticleDot(g, s, A.heart));

    this.kkCanvas = document.createElement('canvas');
    this.kkCanvas.width = KK_TEX;
    this.kkCanvas.height = KK_TEX;
    paintKkumuli(this.kkCanvas.getContext('2d')!, KK_TEX, 0, false);
    this.kkTexture = this.textures.addCanvas('kkumuli', this.kkCanvas);

    this.p1Sprite = this.add.image(0, 0, 'orb-me').setDepth(6);
    this.p2Sprite = this.add.image(0, 0, 'orb-foe').setDepth(6);
    this.kkumuli = this.add.image(0, 0, 'kkumuli').setDepth(5);
    this.sparkSprites = [
      this.add.image(0, 0, 'sparx').setDepth(7),
      this.add.image(0, 0, 'sparx').setDepth(7),
    ];
    // Canvas-baked circular glow only — Phaser addGlow halos the whole quad as a square.

    for (let i = 0; i < AFTERIMAGES; i++) {
      const ghost = this.add.image(0, 0, 'orb-me').setAlpha(0).setDepth(4);
      ghost.setBlendMode(Phaser.BlendModes.ADD);
      this.afterimages.push(ghost);
      const ghost2 = this.add.image(0, 0, 'orb-foe').setAlpha(0).setDepth(4);
      ghost2.setBlendMode(Phaser.BlendModes.ADD);
      this.afterimages2.push(ghost2);
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

  update(time: number, delta: number) {
    this.tickActorLerp(delta);
    if (this.kkumuli?.visible && this.kkTexture && time - this.lastKk > 80) {
      this.lastKk = time;
      paintKkumuli(this.kkCanvas.getContext('2d')!, KK_TEX, time / 1000, this.angry);
      this.kkTexture.refresh();
    }
    for (const spark of this.sparkSprites) {
      if (spark.visible) spark.rotation += 0.04;
    }
    if (this.melting && this.localGrid) {
      this.meltSkip++;
      if (this.meltSkip % 3 === 0) {
        this.melt = Math.min(1, this.melt + 0.08);
        this.paintGrid(this.localGrid);
        if (this.melt >= 1) this.melting = false;
      }
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
    const overlayOn = document.getElementById('resultOverlay')?.classList.contains('show');
    const next = Math.min(w / BOARD_W, h / BOARD_H);
    const scale = overlayOn && this.lockedScale > 0 ? this.lockedScale : next;
    if (!overlayOn) this.lockedScale = next;
    if (this.boardImage) {
      this.boardImage.setScale(scale).setPosition((w - BOARD_W * scale) / 2, (h - BOARD_H * scale) / 2);
    }
    this.redrawOverlay(this.matchState?.player1.trail ?? this.p1TrailCopy, this.matchState?.player2.trail ?? []);
    this.placeShownActors();
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
      if ((this.qaMode || this.qaHit) && !this.qaClaimed) return;
      last = { x: e.clientX, y: e.clientY };
      this.thrusting = true;
      pad.setPointerCapture(e.pointerId);
      this.sendInput();
    });
    pad.addEventListener('pointermove', (e) => {
      if ((this.qaMode || this.qaHit) && !this.qaClaimed) return;
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
    for (const g of this.afterimages2) g.setVisible(visible);
  }

  isOnline(): boolean {
    return Boolean(this.room);
  }

  leaveRoom() {
    this.room?.leave();
    this.room = null;
  }

  startOnlineMode(room: Room) {
    this.room = room;
    this.qaMode = false;
    this.qaLose = false;
    this.resultShown = false;
    this.lerpReady = false;
    this.lastYouHearts = 3;
    this.lastFoeHearts = 3;
    this.melt = 0;
    this.melting = false;
    hideResultOverlay();
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
    if (this.botInterval) {
      clearInterval(this.botInterval);
      this.botInterval = null;
    }
    this.room = null;
    const qa = new URLSearchParams(window.location.search).get('qa');
    this.qaHit = qa === 'hit';
    this.qaLose = qa === 'lose';
    this.qaMode = qa === '1' || qa === 'cut' || this.qaHit || this.qaLose;
    this.qaClaimed = false;
    this.qaWinAtMs = 0;
    this.melt = 0;
    this.melting = false;
    this.meltSkip = 0;
    this.resultShown = false;
    this.lerpReady = false;
    this.lastYouHearts = 3;
    this.lastFoeHearts = 3;
    hideResultOverlay();
    this.matchState = createInitialState();
    this.qaP1 = this.qaMode
      ? new QaPilot(this.qaHit ? p1HitWaypoints() : p1CaptureWaypoints())
      : null;
    this.qaP2 = this.qaMode ? new QaPilot(p2SkyWaypoints(), 850) : null;
    this.bot = new Bot('normal', 2, 11);
    this.setActorsVisible(true);
    setPlaying(true);
    this.renderState(this.matchState, []);
    this.botInterval = setInterval(() => this.pulseBot(), 50);
  }

  private pulseBot() {
    if (!this.matchState || this.matchState.result) {
      if (this.botInterval) clearInterval(this.botInterval);
      if (this.matchState?.result) this.presentResult(this.matchState.result.winner, this.matchState.result.reason);
      return;
    }
    const pulses = this.qaMode
      ? this.qaClaimed
        ? QA_STEPS_AFTER_CUT
        : QA_STEPS_PER_PULSE
      : 1;
    const allEvents: GameEvent[] = [];
    let prevTrail = this.matchState.player1.trail.slice();
    for (let n = 0; n < pulses; n++) {
      if (!this.matchState || this.matchState.result) break;
      const once = this.stepBotOnce();
      allEvents.push(...once.events);
      if (once.prevTrail.length) prevTrail = once.prevTrail;
    }
    if (this.matchState) {
      this.handleEvents(allEvents, prevTrail);
      this.renderState(this.matchState, allEvents);
    }
  }

  private stepBotOnce(): { events: GameEvent[]; prevTrail: { x: number; y: number }[] } {
    if (!this.matchState) return { events: [], prevTrail: [] };
    const claimed = this.matchState.player1.territoryCells ?? 0;
    if (this.qaMode && !this.matchState.result) {
      // Hold 꾸물이 in remaining cover so mid-match / cut shots show the
      // full ~1/4-width body instead of clipping the right edge.
      this.matchState.boss.xFp = toFp(124);
      this.matchState.boss.yFp = toFp(118);
    }
    if (this.qaMode && claimed < 18000) {
      this.matchState.sparx1.xFp = toFp(0);
      this.matchState.sparx1.yFp = toFp(0);
      this.matchState.sparx1.edgeDir = 0;
      this.matchState.sparx2.xFp = toFp(199);
      this.matchState.sparx2.yFp = toFp(0);
      this.matchState.sparx2.edgeDir = 2;
    }
    if (this.qaLose && claimed >= 12000 && !this.matchState.result) {
      this.matchState.player1.hearts = 0;
      this.matchState.player1.isAlive = false;
    }
    if (this.qaMode && !this.qaHit && !this.qaLose && this.qaWinAtMs > 0 && Date.now() >= this.qaWinAtMs && !this.matchState.result) {
      this.matchState.player1.territoryCells = Math.max(
        claimed,
        Math.ceil(TOTAL_CELLS / 2),
      );
    }
    if (this.qaHit && claimed >= 15000 && this.matchState.player1.drawing) {
      const rim = this.matchState.player1.trail.find(
        (p) => p.x === 0 || p.y === 0 || p.x === BOARD_W - 1 || p.y === BOARD_H - 1,
      ) ?? this.matchState.player1.position;
      this.matchState.sparx2.xFp = toFp(rim.x);
      this.matchState.sparx2.yFp = toFp(rim.y);
      this.matchState.sparx2.edgeDir = 0;
    }
    let heading = this.heading;
    let thrusting = this.thrusting;
    let botMove = this.bot!.getNextMove(this.matchState);
    const tick = this.matchState.tick;
    if (this.qaP1) {
      const a = this.qaP1.next(this.matchState.player1.position, tick);
      heading = a.heading;
      thrusting = a.thrusting;
    }
    if (this.qaP2) {
      const b = this.qaP2.next(this.matchState.player2.position, tick);
      botMove = { player: 2, heading: b.heading, thrusting: b.thrusting };
    }
    const prevTrail = this.matchState.player1.trail.slice();
    const result = step(this.matchState, [
      { player: 1, heading, thrusting },
      botMove,
    ]);
    this.matchState = result.state;
    this.p1TrailCopy = this.matchState.player1.trail.length ? this.matchState.player1.trail : prevTrail;
    return { events: result.events, prevTrail };
  }

  private handleEvents(events: GameEvent[], prevTrail: { x: number; y: number }[]) {
    const bonus = events.find((e) => e.type === 'trap_bonus');
    const notableCut = !this.qaMode || (this.matchState?.player1.territoryCells ?? 0) >= 18000;
    for (const ev of events) {
      if (ev.type === 'trap_bonus') {
        if (ev.player === 1 && notableCut) {
          this.qaClaimed = true;
          if (!this.qaWinAtMs) this.qaWinAtMs = Date.now() + 1600;
        }
        if (notableCut) this.playCutFx(undefined, ev.data?.percent ?? 5, prevTrail);
      }
      if (ev.type === 'claim' && !bonus) {
        if (ev.player === 1 && notableCut) {
          this.qaClaimed = true;
          if (!this.qaWinAtMs) this.qaWinAtMs = Date.now() + 1600;
        }
        if (notableCut) this.playCutFx(ev.data?.cells ?? 0, undefined, prevTrail);
      }
      if (ev.type === 'heart') this.playHitFx(ev.player === 1 ? prevTrail : []);
    }
  }

  private playCutFx(cells?: number, percent?: number, trail: { x: number; y: number }[] = []) {
    const pct = percent ?? Math.max(1, Math.round(((cells ?? 0) / TOTAL_CELLS) * 100) || 6);
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
    }, 2500);
    this.cameras.main.shake(180, 0.012);
    const src = trail.length ? trail : [this.matchState?.player1.position ?? { x: BOARD_W / 2, y: BOARD_H - 8 }];
    const cx = src.reduce((s, p) => s + p.x, 0) / src.length;
    const cy = src.reduce((s, p) => s + p.y, 0) / src.length;
    const pos = this.worldOf({ x: cx, y: cy });
    this.burst(this.cutEmitter, pos.x, pos.y, 20, ['dot-me', 'dot-accent', 'dot-white'], 1.2);
  }

  private playHitFx(trail: { x: number; y: number }[]) {
    const flash = document.getElementById('hitFlash');
    flash?.classList.add('on');
    if (window.__turfDebug) window.__turfDebug.hitFx = true;
    setTimeout(() => {
      flash?.classList.remove('on');
      if (window.__turfDebug) window.__turfDebug.hitFx = false;
    }, 480);
    const pts = trail.length ? trail : this.p1TrailCopy;
    const stride = Math.max(1, Math.ceil(pts.length / 8));
    let n = 0;
    for (let i = 0; i < pts.length && n < 8; i += stride, n++) {
      const w = this.worldOf(pts[i]);
      this.shatterAt(w.x, w.y);
    }
    if (n === 0) {
      const mid = this.worldOf(this.matchState?.player1.position ?? { x: BOARD_W / 2, y: BOARD_H - 8 });
      this.burst(this.hitEmitter, mid.x, mid.y, 10, ['dot-heart', 'dot-white'], 1.1);
    }
  }

  private playWinFx() {
    if (window.__turfDebug) window.__turfDebug.winFx = true;
    this.melting = true;
    const w = this.scale.width;
    const h = this.scale.height * 0.55;
    for (let i = 0; i < 16; i++) {
      const x = Math.random() * w;
      this.burst(this.winEmitter, x, 6 + Math.random() * 16, 2, ['dot-accent', 'dot-spark', 'dot-me'], 1.2, h);
    }
  }

  private presentResult(winner: number, reason: string) {
    if (this.resultShown) return;
    this.resultShown = true;
    const kind: 'win' | 'lose' | 'tie' = winner === 0 ? 'tie' : winner === this.playerNum ? 'win' : 'lose';
    showResultOverlay(kind, reason);
    if (kind !== 'lose') this.playWinFx();
    else if (window.__turfDebug) window.__turfDebug.winFx = false;
  }

  private burst(
    emitter: BurstEmitter | null,
    x: number,
    y: number,
    n: number,
    keys: string[],
    scale = 1,
    fall = 0,
  ) {
    try {
      emitter?.explode(n, x, y);
    } catch {
      /* canvas / API mismatch — tween sprites below still play */
    }
    for (let i = 0; i < n; i++) {
      const img = this.add.image(x, y, keys[i % keys.length]);
      img.setDepth(20);
      img.setScale(scale);
      const ang = Math.random() * Math.PI * 2;
      const dist = 28 + Math.random() * 90;
      this.tweens.add({
        targets: img,
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist + fall,
        alpha: 0,
        scale: 0.15 * scale,
        duration: 640 + Math.random() * 420,
        onComplete: () => img.destroy(),
      });
    }
  }

  private shatterAt(x: number, y: number) {
    for (let i = 0; i < 2; i++) {
      const img = this.add.image(x, y, i % 2 === 0 ? 'dot-me' : 'dot-white');
      img.setDepth(21);
      img.setScale(1.6);
      const ang = Math.random() * Math.PI * 2;
      const dist = 12 + Math.random() * 36;
      this.tweens.add({
        targets: img,
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist,
        angle: 140 + Math.random() * 160,
        alpha: 0,
        scale: 0.2,
        duration: 280 + Math.random() * 160,
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
      const mid = (p: { x: number; y: number }) => ({ x: p.x + 0.5, y: p.y + 0.5 });
      this.paintActors(
        mid(state.player1.position),
        mid(state.player2.position),
        mid(state.boss),
        mid(state.sparx1),
        mid(state.sparx2),
      );
    }
    const you = this.playerNum === 1 ? state.player1 : state.player2;
    const foe = this.playerNum === 1 ? state.player2 : state.player1;
    const result = state.result
      ? this.perspectiveLabel(state.result.winner, state.result.reason)
      : null;
    const brokeYou = (you.hearts ?? 3) < this.lastYouHearts;
    const brokeFoe = (foe.hearts ?? 3) < this.lastFoeHearts;
    if (brokeYou) this.playHitFx(this.p1TrailCopy);
    this.lastYouHearts = you.hearts ?? 3;
    this.lastFoeHearts = foe.hearts ?? 3;
    if (state.result) this.presentResult(state.result.winner, state.result.reason);
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
    this.bumpDebug(state.tick, state.player1.territoryCells, state.player2.territoryCells, result, you.hearts ?? 3);
  }

  private renderState(state: MatchState, events: GameEvent[]) {
    this.localGrid = state.grid;
    this.paintGrid(state.grid);
    this.paintActors(
      { x: state.player1.xFp / 256, y: state.player1.yFp / 256 },
      { x: state.player2.xFp / 256, y: state.player2.yFp / 256 },
      { x: state.boss.xFp / 256, y: state.boss.yFp / 256 },
      { x: state.sparx1.xFp / 256, y: state.sparx1.yFp / 256 },
      { x: state.sparx2.xFp / 256, y: state.sparx2.yFp / 256 },
    );
    const open = (state.player1.territoryCells + state.player2.territoryCells) / TOTAL_CELLS;
    const bx = state.boss.xFp >> 8;
    const by = state.boss.yFp >> 8;
    const nearBoss = (p: { x: number; y: number }) => Math.abs(p.x - bx) + Math.abs(p.y - by) < 70;
    this.angry =
      open > 0.2 ||
      (state.player1.drawing && nearBoss(state.player1.position)) ||
      (state.player2.drawing && nearBoss(state.player2.position));
    this.redrawOverlay(state.player1.trail, state.player2.trail);
    const result = state.result
      ? this.perspectiveLabel(state.result.winner, state.result.reason)
      : null;
    if (state.result) this.presentResult(state.result.winner, state.result.reason);
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
    this.bumpDebug(state.tick, state.player1.territoryCells, state.player2.territoryCells, result, state.player1.hearts);
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
    this.trailGlow?.clear();
    this.trailGfx.lineStyle(4, AH.purple, 0.85);
    this.trailGfx.strokeRoundedRect(ox + 1, oy + 1, bw - 2, bh - 2, Math.min(18, scale * 8));
    const mine = trail1;
    const foe = trail2 ?? [];
    this.strokeGlowLine(mine, AH.me, AH.core, ox, oy, scale, false);
    this.strokeGlowLine(foe, AH.foe, 0xffffff, ox, oy, scale, true);
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
    const glowGfx = this.trailGlow ?? this.trailGfx;
    const dots: { x: number; y: number }[] = [];
    if (dashed) {
      const on = Math.max(16, scale * 8);
      const off = Math.max(10, scale * 5);
      let acc = 0;
      let drawing = true;
      dots.push(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        let x0 = pts[i - 1].x;
        let y0 = pts[i - 1].y;
        const x1 = pts[i].x;
        const y1 = pts[i].y;
        let dist = Math.hypot(x1 - x0, y1 - y0);
        if (dist < 0.001) continue;
        const ux = (x1 - x0) / dist;
        const uy = (y1 - y0) / dist;
        while (dist > 0) {
          const slice = Math.min(dist, drawing ? on - acc : off - acc);
          x0 += ux * slice;
          y0 += uy * slice;
          dist -= slice;
          acc += slice;
          if (drawing) dots.push({ x: x0, y: y0 });
          const limit = drawing ? on : off;
          if (acc >= limit - 0.01) {
            acc = 0;
            drawing = !drawing;
          }
        }
      }
    } else {
      dots.push(...pts);
    }
    const stamp = (gfx: Phaser.GameObjects.Graphics, radius: number, color: number, alpha: number) => {
      gfx.fillStyle(color, alpha);
      for (const p of dots) gfx.fillCircle(p.x, p.y, radius);
    };
    stamp(glowGfx, Math.max(16, scale * 10), glow, 0.22);
    stamp(glowGfx, Math.max(12, scale * 7.2), glow, 0.42);
    stamp(this.trailGfx, Math.max(8, scale * 5.2), glow, 1);
    stamp(this.trailGfx, Math.max(3.6, scale * 2.4), core, 1);
  }

  private paintActors(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    boss: { x: number; y: number },
    s1: { x: number; y: number },
    s2: { x: number; y: number },
  ) {
    if (!this.boardImage) return;
    this.goal.p1 = p1;
    this.goal.p2 = p2;
    this.goal.boss = boss;
    this.goal.s1 = s1;
    this.goal.s2 = s2;
    if (!this.lerpReady) {
      this.shown.p1 = { ...p1 };
      this.shown.p2 = { ...p2 };
      this.shown.boss = { ...boss };
      this.shown.s1 = { ...s1 };
      this.shown.s2 = { ...s2 };
      this.lerpReady = true;
    }
    this.lastP1.push(p1);
    if (this.lastP1.length > AFTERIMAGES) this.lastP1.shift();
    this.lastP2.push(p2);
    if (this.lastP2.length > AFTERIMAGES) this.lastP2.shift();
    const guide1 = this.matchState?.player1.trail ?? this.p1TrailCopy;
    const guide2 = this.matchState?.player2.trail ?? [];
    this.stampAfterimages(this.afterimages, p1, guide1, this.lastP1, ORB_CELLS, 0.95, { x: 0, y: -1 });
    this.stampAfterimages(this.afterimages2, p2, guide2, this.lastP2, ORB_CELLS * 0.92, 0.82, { x: -1, y: 0 });
    this.placeShownActors();
  }

  private tickActorLerp(delta: number) {
    if (!this.lerpReady) return;
    const t = 1 - Math.exp(-(delta || 16) / 70);
    const keys = ['p1', 'p2', 'boss', 's1', 's2'] as const;
    for (const k of keys) {
      this.shown[k].x += (this.goal[k].x - this.shown[k].x) * t;
      this.shown[k].y += (this.goal[k].y - this.shown[k].y) * t;
    }
    this.placeShownActors();
  }

  private placeShownActors() {
    if (!this.boardImage || !this.lerpReady) return;
    const scale = this.boardImage.scaleX;
    const place = (sprite: Phaser.GameObjects.Image | null, p: { x: number; y: number }, size: number) => {
      if (!sprite) return;
      sprite.setPosition(this.actorWorld(p).x, this.actorWorld(p).y);
      sprite.setDisplaySize(Math.max(10, size * scale), Math.max(10, size * scale));
    };
    place(this.p1Sprite, this.shown.p1, ORB_CELLS);
    place(this.p2Sprite, this.shown.p2, ORB_CELLS);
    place(this.kkumuli, this.shown.boss, KK_CELLS);
    place(this.sparkSprites[0], this.shown.s1, 18);
    place(this.sparkSprites[1], this.shown.s2, 18);
  }

  private actorWorld(p: { x: number; y: number }): { x: number; y: number } {
    const scale = this.boardImage?.scaleX ?? 1;
    const ox = this.boardImage?.x ?? 0;
    const oy = this.boardImage?.y ?? 0;
    return { x: ox + p.x * scale, y: oy + p.y * scale };
  }

  private perspectiveLabel(winner: number, reason: string): string {
    const title = winner === 0 ? '무승부' : winner === this.playerNum ? '승리!' : '패배';
    return `${title} · ${reason}`;
  }

  private stampAfterimages(
    imgs: Phaser.GameObjects.Image[],
    pos: { x: number; y: number },
    guide: { x: number; y: number }[],
    history: { x: number; y: number }[],
    size: number,
    alpha0: number,
    fallback: { x: number; y: number },
  ) {
    const pts: { x: number; y: number }[] = [];
    if (guide.length >= 2) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < guide.length; i++) {
        const d = (guide[i].x - pos.x) ** 2 + (guide[i].y - pos.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      for (let k = 1; k <= AFTERIMAGES; k++) {
        const idx = Math.max(0, best - k * 3);
        pts.push(guide[idx]);
      }
    } else {
      let dx = fallback.x;
      let dy = fallback.y;
      if (history.length >= 2) {
        const a = history[history.length - 1];
        const b = history[history.length - 2];
        dx = a.x - b.x;
        dy = a.y - b.y;
      }
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      for (let k = 1; k <= AFTERIMAGES; k++) {
        pts.push({ x: pos.x - dx * k * 6, y: pos.y - dy * k * 6 });
      }
    }
    const scale = this.boardImage?.scaleX ?? 1;
    imgs.forEach((img, i) => {
      const src = pts[i];
      if (!src) {
        img.setAlpha(0);
        return;
      }
      const w = this.worldOf(src);
      img.setPosition(w.x, w.y);
      const sz = Math.max(10, size * (1 - i * 0.07) * scale);
      img.setDisplaySize(sz, sz);
      img.setAlpha(alpha0 * (1 - i / AFTERIMAGES));
    });
  }

  private paintGrid(grid: CellType[][]) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const h = grid.length;
    const w = grid[0]?.length ?? 0;
    if (!this.artPix || !this.covPix || !this.outImg || this.outImg.width !== w) {
      const art = this.art.getContext('2d')!;
      const cover = this.coverSheet.getContext('2d')!;
      this.artPix = art.getImageData(0, 0, w, h).data;
      this.covPix = cover.getImageData(0, 0, w, h).data;
      this.outImg = ctx.createImageData(w, h);
    }
    const img = this.artPix;
    const cov = this.covPix;
    const out = this.outImg.data;
    const melt = this.melt;
    for (let y = 0; y < h; y++) {
      const row = grid[y];
      const rowUp = y > 0 ? grid[y - 1] : null;
      const rowDn = y + 1 < h ? grid[y + 1] : null;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cell = row[x];
        const left = x > 0 ? row[x - 1] : -1;
        const right = x + 1 < w ? row[x + 1] : -1;
        const up = rowUp ? rowUp[x] : -1;
        const down = rowDn ? rowDn[x] : -1;
        if (cell === CellType.COVER) {
          if (melt > 0) {
            const a = melt;
            out[i] = cov[i] + ((img[i] - cov[i]) * a + 0.5) | 0;
            out[i + 1] = cov[i + 1] + ((img[i + 1] - cov[i + 1]) * a + 0.5) | 0;
            out[i + 2] = cov[i + 2] + ((img[i + 2] - cov[i + 2]) * a + 0.5) | 0;
            out[i + 3] = 255;
          } else {
            let r = cov[i];
            let g = cov[i + 1];
            let b = cov[i + 2];
            if (left > 0 || right > 0 || up > 0 || down > 0) {
              r = r + (((255 - r) * 0.72) + 0.5) | 0;
              g = g + (((214 - g) * 0.72) + 0.5) | 0;
              b = b + (((80 - b) * 0.72) + 0.5) | 0;
            }
            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
            out[i + 3] = 255;
          }
        } else {
          let r = img[i];
          let g = img[i + 1];
          let b = img[i + 2];
          if (cell === CellType.PLAYER1_OPEN || cell === CellType.PLAYER1_TRAIL) {
            const a = cell === CellType.PLAYER1_TRAIL ? 0.35 : 0.08;
            r = r + (((255 - r) * a) + 0.5) | 0;
            g = g + (((122 - g) * a) + 0.5) | 0;
            b = b + (((26 - b) * a) + 0.5) | 0;
          } else if (cell === CellType.PLAYER2_OPEN || cell === CellType.PLAYER2_TRAIL) {
            const a = cell === CellType.PLAYER2_TRAIL ? 0.35 : 0.08;
            r = r + (((47 - r) * a) + 0.5) | 0;
            g = g + (((107 - g) * a) + 0.5) | 0;
            b = b + (((255 - b) * a) + 0.5) | 0;
          } else if (cell === CellType.SAFE_EDGE) {
            r = r + (((250 - r) * 0.1) + 0.5) | 0;
            g = g + (((204 - g) * 0.1) + 0.5) | 0;
            b = b + (((21 - b) * 0.1) + 0.5) | 0;
          }
          if (cell > 0 && (left === 0 || right === 0 || up === 0 || down === 0)) {
            r = r + (((255 - r) * 0.88) + 0.5) | 0;
            g = g + (((230 - g) * 0.88) + 0.5) | 0;
            b = b + (((120 - b) * 0.88) + 0.5) | 0;
          }
          out[i] = r;
          out[i + 1] = g;
          out[i + 2] = b;
          out[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(this.outImg, 0, 0);
    this.texture?.refresh();
  }

  private bumpDebug(tick: number, p1: number, p2: number, result: string | null, youHearts = 3) {
    if (!window.__turfDebug) return;
    window.__turfDebug.tick = tick;
    window.__turfDebug.ownedCells = { p1, p2 };
    window.__turfDebug.renderedFrames++;
    window.__turfDebug.result = result;
    window.__turfDebug.youHearts = youHearts;
    window.__turfDebug.drawing = {
      p1: Boolean(this.matchState?.player1.drawing),
      p2: Boolean(this.matchState?.player2.drawing),
    };
    window.__turfDebug.trails = {
      p1: this.matchState?.player1.trail.length ?? this.p1TrailCopy.length,
      p2: this.matchState?.player2.trail.length ?? 0,
    };
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

function startBotMatch() {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Playing vs Bot (offline)';
  const scene = game.scene.scenes[0] as GameScene;
  scene.startBotMode();
}

document.getElementById('botBtn')?.addEventListener('click', () => startBotMatch());

document.getElementById('rematchBtn')?.addEventListener('click', async () => {
  hideResultOverlay();
  const scene = game.scene.scenes[0] as GameScene;
  const statusEl = document.getElementById('status');
  if (scene.isOnline()) {
    try {
      const serverUrl = (document.getElementById('serverUrl') as HTMLInputElement).value;
      scene.leaveRoom();
      const client = new Client(serverUrl);
      const room = await client.joinOrCreate('turf_duel');
      if (statusEl) statusEl.textContent = `Connected! Room: ${room.roomId}`;
      scene.startOnlineMode(room);
    } catch (error) {
      if (statusEl) statusEl.textContent = `오류: ${error}`;
      startBotMatch();
    }
    return;
  }
  startBotMatch();
});
