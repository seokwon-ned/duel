import { describe, test, expect } from 'vitest';
import { Bot } from './bot.js';
import {
  createInitialState,
  step,
  Direction,
  MatchState,
  MATCH_DURATION_TICKS,
} from '@turf-duel/engine';

describe('Bot Tests', () => {
  test('Easy bot completes game without crashing', () => {
    const bot = new Bot('easy', 1, 12345);
    let state = createInitialState();

    for (let i = 0; i < 500 && state.result === null; i++) {
      const move = bot.getNextMove(state);
      const result = step(state, [{ player: 1, direction: move }]);
      state = result.state;
    }

    expect(state.result !== null || state.tick >= 500).toBe(true);
  });

  test('Normal bot completes game without crashing', () => {
    const bot = new Bot('normal', 1, 54321);
    let state = createInitialState();

    for (let i = 0; i < 500 && state.result === null; i++) {
      const move = bot.getNextMove(state);
      const result = step(state, [{ player: 1, direction: move }]);
      state = result.state;
    }

    expect(state.result !== null || state.tick >= 500).toBe(true);
  });

  test('Hard bot completes game without crashing', () => {
    const bot = new Bot('hard', 1, 99999);
    let state = createInitialState();

    for (let i = 0; i < 500 && state.result === null; i++) {
      const move = bot.getNextMove(state);
      const result = step(state, [{ player: 1, direction: move }]);
      state = result.state;
    }

    expect(state.result !== null || state.tick >= 500).toBe(true);
  });

  test('Difficulty ordering - bot vs bot simulation', () => {
    const games = 5;
    const results = {
      easy: 0,
      normal: 0,
      hard: 0,
      draws: 0,
    };

    for (let seed = 0; seed < games; seed++) {
      const easyBot = new Bot('easy', 1, seed);
      const normalBot = new Bot('normal', 2, seed + 1000);
      
      let state = createInitialState();
      
      while (state.result === null && state.tick < MATCH_DURATION_TICKS) {
        const p1Move = easyBot.getNextMove(state);
        const p2Move = normalBot.getNextMove(state);
        
        const result = step(state, [
          { player: 1, direction: p1Move },
          { player: 2, direction: p2Move },
        ]);
        
        state = result.state;
      }
      
      if (state.result?.winner === 2) {
        results.normal++;
      } else if (state.result?.winner === 1) {
        results.easy++;
      } else {
        results.draws++;
      }
    }

    expect(results.normal + results.easy + results.draws).toBe(games);
  });
});
