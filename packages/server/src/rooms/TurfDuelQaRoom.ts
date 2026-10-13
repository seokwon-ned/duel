import { TurfDuelRoom } from './TurfDuelRoom.js';

/**
 * QA/e2e rematch rooms: honor short matchTicks, keep production leave/vote paths.
 * Never registered by the production server.
 */
export class TurfDuelQaRoom extends TurfDuelRoom {
  protected override allowClientMatchTicks(): boolean {
    return true;
  }
}
