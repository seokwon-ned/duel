import {
  Direction,
  MatchState,
  PlayerInput,
  PlayerState,
  wrapAngle,
} from '@turf-duel/engine';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export class Bot {
  private difficulty: BotDifficulty;
  private player: 1 | 2;
  private rng: () => number;
  private phase = 0;
  private turnAt = 20;

  constructor(difficulty: BotDifficulty, player: 1 | 2, seed?: number) {
    this.difficulty = difficulty;
    this.player = player;
    this.rng = seed !== undefined ? seededRandom(seed) : Math.random;
    this.turnAt = 12 + Math.floor(this.rng() * 16);
  }

  getNextMove(state: MatchState): PlayerInput {
    const me = this.player === 1 ? state.player1 : state.player2;
    if (!me.isAlive) {
      return { player: this.player, thrusting: false, heading: me.heading };
    }

    if (this.difficulty === 'easy') {
      return this.easy(me);
    }
    if (this.difficulty === 'hard') {
      return this.hard(me);
    }
    return this.normal(me);
  }

  private easy(me: PlayerState): PlayerInput {
    if (!me.drawing) {
      return { player: this.player, heading: me.heading, thrusting: true };
    }
    if (this.phase++ > this.turnAt) {
      this.phase = 0;
      return { player: this.player, heading: wrapAngle(me.heading + 64), thrusting: true };
    }
    return { player: this.player, heading: me.heading, thrusting: true };
  }

  private normal(me: PlayerState): PlayerInput {
    if (!me.drawing) {
      return { player: this.player, heading: me.heading, thrusting: true };
    }
    if (this.phase++ === this.turnAt) {
      return { player: this.player, heading: wrapAngle(me.heading + 64), thrusting: true };
    }
    if (this.phase > this.turnAt * 2) {
      this.phase = 0;
      return { player: this.player, heading: wrapAngle(me.heading + 64), thrusting: true };
    }
    return { player: this.player, heading: me.heading, thrusting: true };
  }

  private hard(me: PlayerState): PlayerInput {
    if (!me.drawing) {
      const inward = this.player === 1 ? 192 : 64;
      return { player: this.player, heading: inward, thrusting: true };
    }
    if (this.phase++ === 10) {
      return { player: this.player, heading: wrapAngle(me.heading + 64), thrusting: true };
    }
    if (this.phase === 20) {
      return { player: this.player, heading: wrapAngle(me.heading + 64), thrusting: true };
    }
    if (this.phase > 30) {
      this.phase = 0;
      return { player: this.player, heading: wrapAngle(me.heading + 64), thrusting: true };
    }
    return { player: this.player, heading: me.heading, thrusting: true };
  }
}

function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state * 1664525 + 1013904223) | 0;
    return ((state >>> 0) % 1000) / 1000;
  };
}

export { Direction };
