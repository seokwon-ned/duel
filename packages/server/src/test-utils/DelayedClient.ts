import { Client, Room } from '@colyseus/sdk';
import { GRID_SIZE, schemaToMatchState } from '@turf-duel/engine';

/**
 * Bidirectional delay wrapper: send() is deferred, and incoming
 * onStateChange / onMessage callbacks are deferred by the same amount.
 * Reading room.state directly is the live (undelayed) snapshot — tests that
 * model a real client must only consume delayed callbacks.
 */
export class DelayedClient {
  private readonly client: Client;
  readonly delayMs: number;

  constructor(url: string, delayMs = 200) {
    this.client = new Client(url);
    this.delayMs = delayMs;
  }

  async joinOrCreate(roomName: string, options: any = {}): Promise<DelayedRoom> {
    const room = await this.client.joinOrCreate(roomName, options);
    return new DelayedRoom(room, this.delayMs);
  }
}

export class DelayedRoom {
  private readonly stateListeners: Array<(state: any) => void> = [];
  private readonly messageListeners = new Map<string, Array<(message: any) => void>>();

  constructor(
    readonly inner: Room<any>,
    readonly delayMs: number,
  ) {
    this.inner.onStateChange((state: any) => {
      // Freeze NOW — if we pass the live schema, the delayed callback
      // would read the current tick and the delay would be fake.
      const snapshot = schemaToMatchState(state);
      setTimeout(() => {
        for (const listener of this.stateListeners) listener(snapshot);
      }, this.delayMs);
    });

    if (this.inner.state?.grid?.length >= GRID_SIZE * GRID_SIZE) {
      const joinSnapshot = schemaToMatchState(this.inner.state);
      setTimeout(() => {
        for (const listener of this.stateListeners) listener(joinSnapshot);
      }, this.delayMs);
    }
  }

  get roomId(): string {
    return this.inner.roomId;
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  /** Live server view — do not use as the client's perceived state. */
  get liveState(): any {
    return this.inner.state;
  }

  send(type: string, message?: any): void {
    setTimeout(() => {
      this.inner.send(type, message);
    }, this.delayMs);
  }

  onStateChange(callback: (state: any) => void): void {
    this.stateListeners.push(callback);
  }

  onMessage(type: string, callback: (message: any) => void): void {
    const list = this.messageListeners.get(type) ?? [];
    list.push(callback);
    this.messageListeners.set(type, list);
    this.inner.onMessage(type, (message) => {
      setTimeout(() => callback(message), this.delayMs);
    });
  }

  async leave(consented?: boolean): Promise<void> {
    await this.inner.leave(consented);
  }
}
