import { describe, expect, test } from 'vitest';
import { Bot } from './bot.js';
import { createInitialState, fingerprint, step, PlayerInput } from '@turf-duel/engine';

describe('Cover bot', () => {
  test('easy/normal/hard bots run without throwing', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const bot = new Bot(difficulty, 1, 12345);
      let state = createInitialState({ width: 24, height: 24, matchTicks: 200 });
      for (let i = 0; i < 80 && !state.result; i++) {
        const move = bot.getNextMove(state);
        state = step(state, [move]).state;
      }
      expect(state.tick).toBeGreaterThan(0);
    }
  });

  test('server and bot see identical results for the same input log', () => {
    const bot1 = new Bot('normal', 1, 7);
    const bot2 = new Bot('normal', 2, 9);
    let server = createInitialState({ width: 24, height: 24, matchTicks: 400 });
    let local = createInitialState({ width: 24, height: 24, matchTicks: 400 });

    for (let i = 0; i < 120; i++) {
      const inputs: PlayerInput[] = [bot1.getNextMove(server), bot2.getNextMove(server)];
      server = step(server, inputs).state;
      local = step(local, inputs).state;
      if (server.result || local.result) break;
    }

    expect(fingerprint(local)).toBe(fingerprint(server));
    expect(local.player1.territoryCells).toBe(server.player1.territoryCells);
    expect(local.player1.hearts).toBe(server.player1.hearts);
  });
});
