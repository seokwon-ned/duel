export enum Direction {
  UP = 'UP',
  DOWN = 'DOWN',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
}

export enum CellType {
  EMPTY = 0,
  PLAYER1_TERRITORY = 1,
  PLAYER2_TERRITORY = 2,
  PLAYER1_TRAIL = 3,
  PLAYER2_TRAIL = 4,
}

export interface Position {
  x: number;
  y: number;
}

export interface PlayerState {
  position: Position;
  direction: Direction;
  inputBuffer: Direction | null;
  isAlive: boolean;
  territoryCells: number;
}

export enum ResultReason {
  TRAIL_CUT = '선이 끊김',
  STEPPED_OWN_TRAIL = '내 선을 밟음',
  HIT_WALL = '벽에 부딪힘',
  SIMULTANEOUS_COLLISION = '동시 충돌',
  TERRITORY_TIE = '땅 동률',
  TIME_UP_WIN = '시간 종료 승리',
}

export interface MatchResult {
  winner: 1 | 2 | 0; // 0 = draw
  reason: ResultReason;
  tick: number;
}

export interface MatchState {
  grid: CellType[][];
  player1: PlayerState;
  player2: PlayerState;
  tick: number;
  paused: boolean;
  result: MatchResult | null;
}

export interface PlayerInput {
  player: 1 | 2;
  direction: Direction;
}

export interface GameEvent {
  type: 'death' | 'territory_captured' | 'collision' | 'trail_cut';
  player?: 1 | 2;
  data?: any;
}

export interface StepResult {
  state: MatchState;
  events: GameEvent[];
}

export const GRID_SIZE = 40;
export const MATCH_DURATION_TICKS = 3000; // 150s * 20 ticks/s
export const TICKS_PER_SECOND = 20;
export const START_AREA_SIZE = 3;
