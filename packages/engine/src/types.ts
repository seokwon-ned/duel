export enum Direction {
  UP = 'UP',
  DOWN = 'DOWN',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
}

export enum CellType {
  COVER = 0,
  PLAYER1_OPEN = 1,
  PLAYER2_OPEN = 2,
  PLAYER1_TRAIL = 3,
  PLAYER2_TRAIL = 4,
  SAFE_EDGE = 5,
}

export interface Position {
  x: number;
  y: number;
}

export interface PlayerState {
  position: Position;
  xFp: number;
  yFp: number;
  heading: number;
  direction: Direction;
  thrusting: boolean;
  drawing: boolean;
  hearts: number;
  trail: Position[];
  idleTicks: number;
  fuseIndex: number;
  spawnX: number;
  spawnY: number;
  isAlive: boolean;
  territoryCells: number;
  bonusCells: number;
  lastHurtTick: number;
}

export interface MonsterState {
  xFp: number;
  yFp: number;
  heading: number;
  edgeDir: number;
}

export enum ResultReason {
  FIFTY_PERCENT = '50% 선점',
  HEARTS_OUT = '하트 소진',
  BOTH_HEARTS_OUT = '양쪽 하트 소진',
  TIME_UP_WIN = '시간 종료 승리',
  TERRITORY_TIE = '땅 동률',
  DISCONNECTED = '연결 끊김',
  BOTH_DISCONNECTED = '양쪽 연결 끊김 (무효)',
}

export interface MatchResult {
  winner: 1 | 2 | 0;
  reason: ResultReason;
  tick: number;
}

export interface MatchState {
  grid: CellType[][];
  gridWidth: number;
  gridHeight: number;
  player1: PlayerState;
  player2: PlayerState;
  boss: MonsterState;
  sparx1: MonsterState;
  sparx2: MonsterState;
  tick: number;
  paused: boolean;
  result: MatchResult | null;
  matchTicks: number;
}

export interface PlayerInput {
  player: 1 | 2;
  heading?: number;
  thrusting?: boolean;
  direction?: Direction;
  clientTick?: number;
}

export interface GameEvent {
  type: 'heart' | 'claim' | 'trap_bonus' | 'burn' | 'win';
  player?: 1 | 2;
  data?: { cells?: number; bonus?: boolean };
}

export interface StepResult {
  state: MatchState;
  events: GameEvent[];
}

export const GRID_WIDTH = 200;
export const GRID_HEIGHT = 300;
/** @deprecated Use GRID_WIDTH. Kept so older room code that loops a square still typechecks until updated. */
export const GRID_SIZE = GRID_WIDTH;
export const TOTAL_CELLS = GRID_WIDTH * GRID_HEIGHT;
export const MATCH_DURATION_TICKS = 3000;
export const TICKS_PER_SECOND = 20;
export const STARTING_HEARTS = 3;
export const IDLE_BURN_TICKS = 40;
export const PLAYER_SPEED_FP = 192;
export const WIN_OPEN_NUM = 1;
export const WIN_OPEN_DEN = 2;
export const TRAP_BONUS_NUM = 5;
export const TRAP_BONUS_DEN = 100;
export const FUSE_CELLS_PER_TICK = 2;
export const SMALL_TRAP_NUM = 5;
export const SMALL_TRAP_DEN = 100;
/** Edge cells walked per tick, per spark. Collision is checked after every cell. */
export const SPARX_STEPS = 1;
/** 1.5s at 20Hz. After a hit the player cannot lose another heart yet. */
export const HURT_IFRAME_TICKS = 30;

export const PLAYER1_TERRITORY = CellType.PLAYER1_OPEN;
export const PLAYER2_TERRITORY = CellType.PLAYER2_OPEN;
export const PLAYER1_TRAIL = CellType.PLAYER1_TRAIL;
export const PLAYER2_TRAIL = CellType.PLAYER2_TRAIL;
