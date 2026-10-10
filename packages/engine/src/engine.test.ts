import { describe, test, expect } from 'vitest';
import {
  createInitialState,
  step,
  replayInputLog,
} from './engine.js';
import {
  Direction,
  PlayerInput,
  ResultReason,
  MATCH_DURATION_TICKS,
  CellType,
} from './types.js';

describe('Game Engine - 판정 Tests', () => {
  test('선이 끊김 - Player 2 cuts Player 1 trail', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 10, y: 10 };
    state.player2.position = { x: 20, y: 20 };
    
    for (let y = 8; y <= 12; y++) {
      for (let x = 8; x <= 12; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    state.player1.direction = Direction.RIGHT;
    state.player2.direction = Direction.LEFT;
    
    for (let i = 0; i < 25; i++) {
      const result = step(state, [{ player: 1, direction: Direction.RIGHT }]);
      state = result.state;
    }
    
    state.grid[11][14] = CellType.PLAYER1_TRAIL;
    state.grid[11][15] = CellType.PLAYER1_TRAIL;
    
    state.player2.position = { x: 14, y: 12 };
    state.player2.movementAccumulator = 20;
    state.player2.direction = Direction.UP;
    
    const result = step(state, [{ player: 2, direction: Direction.UP }]);
    state = result.state;
    
    expect(state.result).not.toBeNull();
    expect(state.result?.winner).toBe(2);
    expect(state.result?.reason).toBe(ResultReason.TRAIL_CUT);
  });

  test('내 선을 밟음 - Player steps on own trail outside territory', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 10, y: 10 };
    state.player1.movementAccumulator = 20;
    
    for (let y = 8; y <= 12; y++) {
      for (let x = 8; x <= 12; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    state.grid[10][13] = CellType.PLAYER1_TRAIL;
    state.grid[10][14] = CellType.PLAYER1_TRAIL;
    state.grid[10][15] = CellType.PLAYER1_TRAIL;
    
    state.player1.position = { x: 16, y: 10 };
    state.player1.direction = Direction.LEFT;
    
    const result = step(state, []);
    
    expect(result.state.result).not.toBeNull();
    expect(result.state.result?.reason).toBe(ResultReason.STEPPED_OWN_TRAIL);
    expect(result.state.result?.winner).toBe(2);
  });

  test('벽에 부딪힘 - Player hits wall', () => {
    let state = createInitialState();
    
    for (let i = 0; i < 50; i++) {
      const result = step(state, [{ player: 1, direction: Direction.UP }]);
      state = result.state;
      
      if (state.result) break;
    }
    
    expect(state.result).not.toBeNull();
    expect(state.result?.reason).toBe(ResultReason.HIT_WALL);
    expect(state.result?.winner).toBe(2);
  });

  test('동시 충돌 - Head-on collision', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 10, y: 10 };
    state.player2.position = { x: 15, y: 10 };
    state.player1.direction = Direction.RIGHT;
    state.player2.direction = Direction.LEFT;
    state.grid[10][10] = CellType.PLAYER1_TERRITORY;
    state.grid[10][15] = CellType.PLAYER2_TERRITORY;
    
    for (let i = 0; i < 10; i++) {
      const result = step(state, [
        { player: 1, direction: Direction.RIGHT },
        { player: 2, direction: Direction.LEFT },
      ]);
      state = result.state;
      
      if (state.result) break;
    }
    
    expect(state.result).not.toBeNull();
    expect(state.result?.winner).toBe(0);
    expect(state.result?.reason).toBe(ResultReason.SIMULTANEOUS_COLLISION);
  });

  test('동시 충돌 - Both hit walls same tick', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 0, y: 5 };
    state.player2.position = { x: 39, y: 5 };
    state.player1.direction = Direction.LEFT;
    state.player2.direction = Direction.RIGHT;
    state.player1.movementAccumulator = 20;
    state.player2.movementAccumulator = 20;
    
    const result = step(state, []);
    
    expect(result.state.result).not.toBeNull();
    expect(result.state.result?.winner).toBe(0);
    expect(result.state.result?.reason).toBe(ResultReason.SIMULTANEOUS_COLLISION);
  });

  test('동시 컷 - Simultaneous trail cut', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 10, y: 10 };
    state.player2.position = { x: 15, y: 15 };
    state.player1.movementAccumulator = 20;
    state.player2.movementAccumulator = 20;
    
    state.grid[10][11] = CellType.PLAYER2_TRAIL;
    state.grid[15][14] = CellType.PLAYER1_TRAIL;
    
    state.player1.direction = Direction.RIGHT;
    state.player2.direction = Direction.LEFT;
    
    const result = step(state, []);
    
    expect(result.state.result).not.toBeNull();
    expect(result.state.result?.winner).toBe(0);
    expect(result.state.result?.reason).toBe(ResultReason.SIMULTANEOUS_COLLISION);
  });

  test('같은 틱에 돌아오기 vs 끊기 - Returner loses', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 5, y: 5 };
    state.player2.position = { x: 6, y: 6 };
    state.player1.movementAccumulator = 20;
    state.player2.movementAccumulator = 20;
    
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    state.grid[5][6] = CellType.PLAYER1_TRAIL;
    state.grid[5][7] = CellType.PLAYER1_TRAIL;
    
    state.player1.position = { x: 5, y: 5 };
    state.player1.direction = Direction.RIGHT;
    
    state.player2.position = { x: 6, y: 6 };
    state.player2.direction = Direction.LEFT;
    
    state.grid[6][6] = CellType.EMPTY;
    
    const result = step(state, []);
    
    expect(result.state.result).not.toBeNull();
    expect(result.state.result?.winner).toBe(2);
  });

  test('내 땅 안에서는 자기 선을 밟아도 패배 아님', () => {
    let state = createInitialState();
    
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    state.player1.position = { x: 2, y: 2 };
    state.player1.direction = Direction.RIGHT;
    
    for (let i = 0; i < 3; i++) {
      const result = step(state, [{ player: 1, direction: Direction.RIGHT }]);
      state = result.state;
    }
    
    const result1 = step(state, [{ player: 1, direction: Direction.DOWN }]);
    state = result1.state;
    
    for (let i = 0; i < 2; i++) {
      const result = step(state, [{ player: 1, direction: Direction.DOWN }]);
      state = result.state;
    }
    
    const result2 = step(state, [{ player: 1, direction: Direction.LEFT }]);
    state = result2.state;
    
    for (let i = 0; i < 3; i++) {
      const result = step(state, [{ player: 1, direction: Direction.LEFT }]);
      state = result.state;
    }
    
    const result3 = step(state, [{ player: 1, direction: Direction.UP }]);
    state = result3.state;
    
    for (let i = 0; i < 2; i++) {
      const result = step(state, [{ player: 1, direction: Direction.UP }]);
      state = result.state;
    }
    
    expect(state.player1.isAlive).toBe(true);
    expect(state.result).toBeNull();
  });

  test('땅 동률 - Territory tie at time up', () => {
    let state = createInitialState();
    state.tick = MATCH_DURATION_TICKS - 1;
    
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    for (let y = 20; y < 40; y++) {
      for (let x = 20; x < 40; x++) {
        state.grid[y][x] = CellType.PLAYER2_TERRITORY;
      }
    }
    
    const result = step(state, []);
    
    expect(result.state.result).not.toBeNull();
    expect(result.state.result?.winner).toBe(0);
    expect(result.state.result?.reason).toBe(ResultReason.TERRITORY_TIE);
  });

  test('시간 종료 승리 - Time up win', () => {
    let state = createInitialState();
    state.tick = MATCH_DURATION_TICKS - 1;
    
    for (let y = 0; y < 25; y++) {
      for (let x = 0; x < 40; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    for (let y = 25; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        state.grid[y][x] = CellType.PLAYER2_TERRITORY;
      }
    }
    
    const result = step(state, []);
    
    expect(result.state.result).not.toBeNull();
    expect(result.state.result?.winner).toBe(1);
    expect(result.state.result?.reason).toBe(ResultReason.TIME_UP_WIN);
  });

  test('정반대 입력 무시 - Opposite direction input ignored', () => {
    const state = createInitialState();
    
    state.player1.direction = Direction.RIGHT;
    
    const result = step(state, [{ player: 1, direction: Direction.LEFT }]);
    
    expect(result.state.player1.direction).toBe(Direction.RIGHT);
    expect(result.state.player1.inputBuffer).toBeNull();
  });

  test('입력 버퍼 1개 - Fast input sequence does not suicide', () => {
    let state = createInitialState();
    
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    state.player1.position = { x: 5, y: 5 };
    state.player1.direction = Direction.RIGHT;
    state.player1.movementAccumulator = 12;
    
    let result = step(state, [{ player: 1, direction: Direction.UP }]);
    state = result.state;
    
    for (let i = 0; i < 5; i++) {
      result = step(state, [{ player: 1, direction: Direction.RIGHT }]);
      state = result.state;
    }
    
    for (let i = 0; i < 5; i++) {
      result = step(state, [{ player: 1, direction: Direction.DOWN }]);
      state = result.state;
    }
    
    expect(state.player1.isAlive).toBe(true);
  });

  test('결정론 - Determinism: same log twice yields identical result', () => {
    const inputs: PlayerInput[][] = [];
    
    for (let i = 0; i < 100; i++) {
      const tickInputs: PlayerInput[] = [];
      if (i % 3 === 0) tickInputs.push({ player: 1, direction: Direction.RIGHT });
      if (i % 5 === 0) tickInputs.push({ player: 2, direction: Direction.LEFT });
      if (i % 7 === 0) tickInputs.push({ player: 1, direction: Direction.DOWN });
      inputs.push(tickInputs);
    }
    
    const result1 = replayInputLog(inputs);
    const result2 = replayInputLog(inputs);
    
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    expect(result1.player1.position).toEqual(result2.player1.position);
    expect(result1.player2.position).toEqual(result2.player2.position);
    expect(result1.tick).toBe(result2.tick);
  });

  test('이동 속도 - 8 cells/s: 20 ticks = 8 cells moved', () => {
    let state = createInitialState();
    const startX = state.player1.position.x;
    
    for (let i = 0; i < 20; i++) {
      const result = step(state, [{ player: 1, direction: Direction.RIGHT }]);
      state = result.state;
    }
    
    const distance = state.player1.position.x - startX;
    expect(distance).toBe(8);
  });

  test('이동 타이밍 - Both players move identically', () => {
    let state = createInitialState();
    
    state.player1.position = { x: 10, y: 10 };
    state.player2.position = { x: 30, y: 30 };
    state.player1.direction = Direction.RIGHT;
    state.player2.direction = Direction.LEFT;
    state.player1.movementAccumulator = 0;
    state.player2.movementAccumulator = 0;
    
    for (let y = 8; y <= 12; y++) {
      for (let x = 8; x <= 12; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    for (let y = 28; y <= 32; y++) {
      for (let x = 28; x <= 32; x++) {
        state.grid[y][x] = CellType.PLAYER2_TERRITORY;
      }
    }
    
    for (let i = 0; i < 20; i++) {
      const result = step(state, [
        { player: 1, direction: Direction.RIGHT },
        { player: 2, direction: Direction.LEFT },
      ]);
      state = result.state;
    }
    
    expect(state.player1.movementAccumulator).toBe(state.player2.movementAccumulator);
  });

  test('감싼 영역 안 상대 선 - Opponent trail inside enclosure survives', () => {
    let state = createInitialState();
    
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state.grid[y][x] = CellType.PLAYER1_TERRITORY;
      }
    }
    
    state.player1.position = { x: 10, y: 0 };
    state.player1.direction = Direction.LEFT;
    state.player1.movementAccumulator = 20;
    
    state.grid[5][5] = CellType.PLAYER1_TRAIL;
    state.grid[5][6] = CellType.PLAYER1_TRAIL;
    state.grid[5][7] = CellType.PLAYER1_TRAIL;
    state.grid[5][8] = CellType.PLAYER1_TRAIL;
    state.grid[5][9] = CellType.PLAYER1_TRAIL;
    state.grid[6][9] = CellType.PLAYER1_TRAIL;
    state.grid[7][9] = CellType.PLAYER1_TRAIL;
    state.grid[8][9] = CellType.PLAYER1_TRAIL;
    state.grid[9][9] = CellType.PLAYER1_TRAIL;
    state.grid[9][8] = CellType.PLAYER1_TRAIL;
    state.grid[9][7] = CellType.PLAYER1_TRAIL;
    state.grid[9][6] = CellType.PLAYER1_TRAIL;
    state.grid[9][5] = CellType.PLAYER1_TRAIL;
    state.grid[8][5] = CellType.PLAYER1_TRAIL;
    state.grid[7][5] = CellType.PLAYER1_TRAIL;
    state.grid[6][5] = CellType.PLAYER1_TRAIL;
    state.grid[5][4] = CellType.PLAYER1_TRAIL;
    state.grid[4][4] = CellType.PLAYER1_TRAIL;
    
    state.grid[7][7] = CellType.PLAYER2_TRAIL;
    state.player2.position = { x: 7, y: 6 };
    
    state.player1.position = { x: 4, y: 3 };
    state.player1.direction = Direction.DOWN;
    
    const result = step(state, []);
    
    expect(result.state.grid[7][7]).toBe(CellType.PLAYER2_TRAIL);
    expect(result.state.player2.isAlive).toBe(true);
  });
});
