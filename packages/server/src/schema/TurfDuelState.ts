import { Schema, type, MapSchema, ArraySchema } from '@colyseus/schema';

export class Position extends Schema {
  @type('number') x: number = 0;
  @type('number') y: number = 0;
}

export class PlayerSchema extends Schema {
  @type(Position) position = new Position();
  @type('string') direction: string = 'RIGHT';
  @type('boolean') isAlive: boolean = true;
  @type('number') territoryCells: number = 9;
}

export class CellUpdate extends Schema {
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') type: number = 0;
}

export class MatchResultSchema extends Schema {
  @type('number') winner: number = 0;
  @type('string') reason: string = '';
  @type('number') tick: number = 0;
}

export class TurfDuelState extends Schema {
  @type(PlayerSchema) player1 = new PlayerSchema();
  @type(PlayerSchema) player2 = new PlayerSchema();
  @type('number') tick: number = 0;
  @type('boolean') paused: boolean = false;
  @type(MatchResultSchema) result?: MatchResultSchema;
  @type([CellUpdate]) cellUpdates = new Array<CellUpdate>();
  @type(['number']) grid = new ArraySchema<number>();
}
