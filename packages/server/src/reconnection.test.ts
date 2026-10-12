import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { createInitialState, step } from '@turf-duel/engine';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { clockRooms, TurfDuelClockRoom } from './rooms/TurfDuelClockRoom.js';
import { TurfDuelState } from './schema/TurfDuelState.js';

// Same limit math as production; shrink the window so CI stays fast.
process.env.TURF_DUEL_MAX_DISCONNECT_MS ??= '3000';
const LIMIT_MS = Number(process.env.TURF_DUEL_MAX_DISCONNECT_MS);
const START_WAIT_MS = 400; // game loop is running; SDK auto-reconnect is disabled below
const AFTER_RECONNECT_MS = 600;
const SHORT_MS = Math.max(250, Math.round(LIMIT_MS * 5 / 30));
const BRIEF_MS = Math.max(200, Math.round(LIMIT_MS * 2 / 30));

/** Production room. Tests disable SDK auto-reconnect so leave(false) stays down. */

interface ReconnectionTestResult {
  passed: boolean;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same inputs (none) as the live room, with no pause. */
function simulateUnpaused(ticks: number) {
  let state = createInitialState();
  while (state.tick < ticks && !state.result) {
    state = step(state, []).state;
  }
  return state;
}

async function waitUntil(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(20);
  }
}

function disableAutoReconnect(room: { reconnection?: { enabled: boolean } }): void {
  if (room.reconnection) {
    room.reconnection.enabled = false;
  }
}

async function manualReconnect<T>(client: Client, token: string) {
  const room = await client.reconnect<T>(token);
  disableAutoReconnect(room);
  return room;
}

async function shutdown(server: Server): Promise<void> {
  try {
    await Promise.race([
      server.gracefullyShutdown(false),
      sleep(1500),
    ]);
  } catch {
    /* ignore */
  }
}

function rawSocket(room: { connection?: unknown }): { close(code?: number, reason?: string): void } | null {
  const connection = room.connection as { transport?: { ws?: { close: (code?: number, reason?: string) => void } }; ws?: { close: (code?: number, reason?: string) => void } } | undefined;
  return connection?.transport?.ws ?? connection?.ws ?? null;
}

async function startServer(port: number) {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', TurfDuelRoom);
  await server.listen(port);
  return server;
}

function clockOf(roomId: string): TurfDuelClockRoom {
  const room = clockRooms.get(roomId);
  if (!room) {
    throw new Error(`No clock room for ${roomId}`);
  }
  return room;
}

async function startClockPair(port: number) {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', TurfDuelClockRoom);
  await server.listen(port);
  const client1 = new Client(`ws://localhost:${port}`);
  const client2 = new Client(`ws://localhost:${port}`);
  const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
  const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');
  disableAutoReconnect(room1);
  disableAutoReconnect(room2);
  await sleep(START_WAIT_MS);
  if (room1.state.result) {
    await shutdown(server);
    throw new Error(`Warmup ended the match: ${JSON.stringify(room1.state.result)}`);
  }
  return { server, client1, client2, room1, room2, clock: clockOf(room1.roomId) };
}

async function startPair(port: number) {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', TurfDuelRoom);
  await server.listen(port);
  const client1 = new Client(`ws://localhost:${port}`);
  const client2 = new Client(`ws://localhost:${port}`);
  const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
  const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');
  disableAutoReconnect(room1);
  disableAutoReconnect(room2);
  await sleep(START_WAIT_MS);
  if (room1.state.result) {
    await shutdown(server);
    throw new Error(`Warmup ended the match: ${JSON.stringify(room1.state.result)}`);
  }
  return { server, client1, client2, room1, room2 };
}

async function testReconnectWithinTimeResumesMatch(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12568);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause after disconnect');

    const tickWhilePaused = room1.state.tick;
    const p1PosWhilePaused = {
      x: room1.state.player1.position.x,
      y: room1.state.player1.position.y,
    };
    await sleep(BRIEF_MS);

    if (room1.state.tick !== tickWhilePaused) {
      await shutdown(server);
      return {
        passed: false,
        message: `Tick should not advance while paused. Frozen: ${tickWhilePaused}, After: ${room1.state.tick}`,
      };
    }

    const room2Reconnect = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    const resumedAt = Date.now();
    while (room1.state.paused && Date.now() - resumedAt < AFTER_RECONNECT_MS) {
      await sleep(50);
    }

    if (room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Game should resume after reconnection' };
    }

    await waitUntil(() => room1.state.tick >= tickWhilePaused + 6, 2000, 'ticks after resume');

    const expected = simulateUnpaused(room1.state.tick);
    const p1 = room1.state.player1.position;
    const p2 = room1.state.player2.position;
    if (
      p1.x !== expected.player1.position.x ||
      p1.y !== expected.player1.position.y ||
      p2.x !== expected.player2.position.x ||
      p2.y !== expected.player2.position.y
    ) {
      await shutdown(server);
      return {
        passed: false,
        message: `Resume position must match an unpaused engine run. live P1=(${p1.x},${p1.y}) P2=(${p2.x},${p2.y}) expected P1=(${expected.player1.position.x},${expected.player1.position.y}) P2=(${expected.player2.position.x},${expected.player2.position.y}) tick=${room1.state.tick} pausedAt=${tickWhilePaused} pausedPos=(${p1PosWhilePaused.x},${p1PosWhilePaused.y})`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Reconnection within time resumes with identical state' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testTwoShortDisconnectsOK(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12569);
  try {
    await room2.leave(false);
    await sleep(SHORT_MS);
    const room2Reconnect1 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);

    const disconnectCount1 = room1.state.player2.disconnectCount as number;
    if (disconnectCount1 !== 1) {
      await shutdown(server);
      return { passed: false, message: `Expected disconnect count 1, got ${disconnectCount1}` };
    }

    await sleep(150);
    const token2 = room2Reconnect1.reconnectionToken!;
    await room2Reconnect1.leave(false);
    await sleep(SHORT_MS);
    const room2Reconnect2 = await manualReconnect<TurfDuelState>(client2, token2);

    const disconnectCount2 = room1.state.player2.disconnectCount as number;
    if (disconnectCount2 !== 2) {
      await shutdown(server);
      return { passed: false, message: `Expected disconnect count 2, got ${disconnectCount2}` };
    }

    if (room1.state.result) {
      await shutdown(server);
      return { passed: false, message: 'Game should not end after 2 disconnects' };
    }

    await shutdown(server);
    return { passed: true, message: 'Two short disconnects are OK' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testThirdDisconnectLoses(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12570);
  try {
    await room2.leave(false);
    await sleep(BRIEF_MS);
    const r1 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(150);

    const token2 = r1.reconnectionToken!;
    await r1.leave(false);
    await sleep(BRIEF_MS);
    const r2 = await manualReconnect<TurfDuelState>(client2, token2);
    await sleep(150);

    await r2.leave(false);
    await sleep(AFTER_RECONNECT_MS);

    if (!room1.state.result || room1.state.result.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `Player 2 should lose on 3rd disconnect. Result: ${JSON.stringify(room1.state.result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: '3rd disconnect causes loss' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testExceeding30SecondsTotalLoses(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12571);
  try {
    await room2.leave(false);
    await waitUntil(() => Boolean(room1.state.result), LIMIT_MS + 1000, 'forfeit after time limit');

    if (!room1.state.result || room1.state.result.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `Player 2 should lose after >limit disconnect. Result: ${JSON.stringify(room1.state.result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Exceeding 30s total disconnect time causes loss' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function test29SecondsBoundary(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12572);
  try {
    await room2.leave(false);
    await sleep(Math.max(200, LIMIT_MS - 200));

    const room2Reconnect = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.result) {
      await shutdown(server);
      return {
        passed: false,
        message: `Game should not end after 29s-equivalent disconnect. Result: ${JSON.stringify(room1.state.result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: '29s disconnect is OK' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testBothDisconnectThenBothReturnResumes(): Promise<ReconnectionTestResult> {
  const { server, client1, client2, room1, room2 } = await startPair(12573);
  try {
    const token1 = room1.reconnectionToken;
    const token2 = room2.reconnectionToken;
    await room1.leave(false);
    await room2.leave(false);
    await sleep(BRIEF_MS);

    const r1 = await manualReconnect<TurfDuelState>(client1, token1!);
    const r2 = await manualReconnect<TurfDuelState>(client2, token2!);
    await sleep(AFTER_RECONNECT_MS);

    if (r1.state.result) {
      await shutdown(server);
      return {
        passed: false,
        message: `Overlapping disconnect must not void the match. Result: ${JSON.stringify(r1.state.result)}`,
      };
    }
    if (r1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Match should resume after both players return' };
    }

    await shutdown(server);
    return { passed: true, message: 'Both disconnect then both return resumes (not void)' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testReconnectingPlayerKeepsSameNumber(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12574);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause after P2 leave');
    const p2WhilePaused = {
      x: room1.state.player2.position.x,
      y: room1.state.player2.position.y,
    };

    const room2Reconnect = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    const resumedAt = Date.now();
    while (room1.state.paused && Date.now() - resumedAt < AFTER_RECONNECT_MS) {
      await sleep(50);
    }

    const p2FinalPos = {
      x: room1.state.player2.position.x,
      y: room1.state.player2.position.y,
    };

    // Same seat: still the far-corner player, not swapped onto P1's spawn.
    const stillPlayer2 = p2FinalPos.x >= 20 && p2FinalPos.y >= 20;
    const stayedNearPause = Math.abs(p2FinalPos.x - p2WhilePaused.x) + Math.abs(p2FinalPos.y - p2WhilePaused.y) <= 1;
    if (!stillPlayer2 || !stayedNearPause) {
      await shutdown(server);
      return {
        passed: false,
        message: `Reconnecting player should keep player 2. Paused: (${p2WhilePaused.x}, ${p2WhilePaused.y}), Final: (${p2FinalPos.x}, ${p2FinalPos.y})`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Reconnecting player keeps same player number' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOpponentReceivesCountdown(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12575);
  try {
    await room2.leave(false);
    await sleep(BRIEF_MS);

    if (room1.state.disconnectCountdownSeconds <= 0) {
      await shutdown(server);
      return {
        passed: false,
        message: `Opponent should see countdown. Countdown: ${room1.state.disconnectCountdownSeconds}`,
      };
    }

    const room2Reconnect = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.disconnectCountdownSeconds !== 0) {
      await shutdown(server);
      return {
        passed: false,
        message: `Countdown should be cleared after reconnection. Countdown: ${room1.state.disconnectCountdownSeconds}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Opponent receives countdown during disconnect' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testAccumulatedFragmentsExceedLimit(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12576);
  try {
    // 15.5s + 14.8s = 30.3s of a 30s budget
    const first = Math.round(LIMIT_MS * 155 / 300);
    const second = Math.round(LIMIT_MS * 148 / 300);

    await room2.leave(false);
    await sleep(first);
    const mid = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(150);

    if (room1.state.result) {
      await shutdown(server);
      return { passed: false, message: 'Should still be alive after the first fragment' };
    }

    await mid.leave(false);
    await waitUntil(() => Boolean(room1.state.result), second + 800, 'forfeit after 15.5+14.8').catch(() => undefined);

    const fragmentResult = room1.state.result as { winner: number } | undefined;
    if (!fragmentResult || fragmentResult.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `15.5+14.8s must lose. Result: ${JSON.stringify(fragmentResult)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Accumulated 15.5+14.8s exceeds 30s and loses' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOverlappingFirstExceedsLoses(): Promise<ReconnectionTestResult> {
  const { server, client1, client2, room1, room2 } = await startPair(12577);
  try {
    const first = Math.round(LIMIT_MS * 155 / 300);
    const second = Math.round(LIMIT_MS * 148 / 300);

    await room2.leave(false);
    await sleep(first);
    const p2 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(150);

    const token1 = room1.reconnectionToken;
    await room1.leave(false);
    await p2.leave(false);
    await sleep(second + 150);

    // P2 already had ~15.5s; this fragment pushes P2 over. P1 only has ~14.8s.
    const spectator = await manualReconnect<TurfDuelState>(client1, token1!).catch(() => null);
    if (spectator) {
      await waitUntil(() => Boolean(spectator.state.result), 1500, 'first-exceed result').catch(() => undefined);
    }
    const result = (spectator?.state.result ?? room1.state.result) as
      | { winner: number }
      | undefined;

    if (!result || result.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `First to exceed (P2) should lose. Result: ${JSON.stringify(result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Overlapping disconnect: first to exceed loses' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOverlappingSameTickBothExceedVoid(): Promise<ReconnectionTestResult> {
  const { server, client1, room1, room2 } = await startPair(12578);
  try {
    const token1 = room1.reconnectionToken;
    await room1.leave(false);
    await room2.leave(false);
    await sleep(LIMIT_MS + 250);

    const spectator = await manualReconnect<TurfDuelState>(client1, token1!).catch(() => null);
    if (spectator) {
      await waitUntil(() => Boolean(spectator.state.result), 1000, 'void result after reconnect').catch(() => undefined);
    }
    const result = (spectator?.state.result ?? room1.state.result) as
      | { winner: number }
      | undefined;

    if (!result || result.winner !== 0) {
      await shutdown(server);
      return {
        passed: false,
        message: `Same-tick both-exceed should be void. Result: ${JSON.stringify(result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Same-tick both-exceed is void' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testVoluntaryLeave4000ImmediateLoss(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12579);
  try {
    const started = Date.now();
    await room2.leave(true);
    const elapsed = Date.now() - started;

    if (elapsed > 250) {
      await shutdown(server);
      return { passed: false, message: `leave(true)/4000 must return immediately, took ${elapsed}ms` };
    }

    await waitUntil(() => Boolean(room1.state.result), 1000, 'immediate loss after 4000');
    const result = room1.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `4000 must be an immediate loss. elapsed=${elapsed}ms result=${JSON.stringify(result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: `Voluntary leave 4000 is an immediate loss (leave returned in ${elapsed}ms)` };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testInputDroppedWhilePaused(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12580);
  try {
    await room2.leave(false);
    await sleep(200);

    if (!room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Expected pause after opponent disconnect' };
    }

    const tickWhilePaused = room1.state.tick;
    room1.send('input', { direction: 'DOWN' });
    await sleep(250);

    if (!room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Input must not unpause a disconnected match' };
    }
    if (room1.state.tick !== tickWhilePaused) {
      await shutdown(server);
      return {
        passed: false,
        message: `Input must not advance ticks while paused. Before: ${tickWhilePaused}, After: ${room1.state.tick}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Input while paused is dropped' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testInputDroppedAfterResult(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12581);
  try {
    await room2.leave(false);
    await sleep(LIMIT_MS + 250);

    const result = room1.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `Expected forfeit before input. Result: ${JSON.stringify(result)}` };
    }

    const p2Alive = room1.state.player2.isAlive;
    const winner = result.winner;
    room1.send('input', { direction: 'UP' });
    await sleep(250);

    const after = room1.state.result as { winner: number } | undefined;
    if (!after || after.winner !== winner) {
      await shutdown(server);
      return { passed: false, message: `Input must not overwrite result. After: ${JSON.stringify(after)}` };
    }
    if (room1.state.player2.isAlive !== p2Alive) {
      await shutdown(server);
      return { passed: false, message: 'Input must not revive a player after the match ended' };
    }

    await shutdown(server);
    return { passed: true, message: 'Input after result is dropped' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testCloseCodeIsImmediateLoss(
  port: number,
  code: 1000 | 4001,
): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(port);
  try {
    const ws = rawSocket(room2);
    if (!ws) {
      await shutdown(server);
      return { passed: false, message: `Could not reach raw socket to close with ${code}` };
    }

    ws.close(code);
    await waitUntil(() => Boolean(room1.state.result), 1000, `immediate loss after ${code}`);

    const result = room1.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `Close ${code} must be an immediate loss. Result: ${JSON.stringify(result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: `Close code ${code} is an immediate loss` };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testWaitingRoomLeaveFreesSeat(): Promise<ReconnectionTestResult> {
  const server = await startServer(12584);
  try {
    const waiterClient = new Client('ws://localhost:12584');
    const waiting = await waiterClient.joinOrCreate<TurfDuelState>('turf_duel');
    disableAutoReconnect(waiting);

    if (waiting.state.result || waiting.state.tick > 0) {
      await shutdown(server);
      return { passed: false, message: 'Waiting room should not have started the match' };
    }

    await waiting.leave(true);
    await sleep(200);

    const client1 = new Client('ws://localhost:12584');
    const client2 = new Client('ws://localhost:12584');
    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');
    disableAutoReconnect(room1);
    disableAutoReconnect(room2);
    await sleep(START_WAIT_MS);

    if (room1.state.result) {
      await shutdown(server);
      return {
        passed: false,
        message: `Waiting-room leave must not walkover. Result: ${JSON.stringify(room1.state.result)}`,
      };
    }

    const d1 = room1.state.player1.disconnectCount as number;
    const d2 = room1.state.player2.disconnectCount as number;
    if (d1 !== 0 || d2 !== 0) {
      await shutdown(server);
      return { passed: false, message: `Waiting-room leave must not count as disconnect. P1=${d1} P2=${d2}` };
    }
    if (room1.state.tick < 1) {
      await shutdown(server);
      return { passed: false, message: 'Replacement pair should start a normal match' };
    }

    await shutdown(server);
    return { passed: true, message: 'Waiting-room leave frees the seat with no disconnect or walkover' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testRoomDisposesAfterNormalEnd(): Promise<ReconnectionTestResult> {
  const { server, room1 } = await startPair(12585);
  try {
    let left = false;
    let leaveCode: number | undefined;
    room1.onLeave((code) => {
      left = true;
      leaveCode = code;
    });

    room1.send('input', { direction: 'UP' });
    await waitUntil(() => Boolean(room1.state.result), 3000, 'normal wall-hit end');

    const result = room1.state.result as { winner: number; reason: string } | undefined;
    if (!result || result.reason === '연결 끊김' || result.reason === '양쪽 연결 끊김 (무효)') {
      await shutdown(server);
      return { passed: false, message: `Expected a normal engine end, got ${JSON.stringify(result)}` };
    }

    const endedAt = Date.now();
    await waitUntil(() => left, 4000, 'room dispose after normal end');
    const elapsed = Date.now() - endedAt;

    if (elapsed > 3500) {
      await shutdown(server);
      return { passed: false, message: `Room should dispose within ~3s after normal end, took ${elapsed}ms` };
    }

    await shutdown(server);
    return { passed: true, message: `Room disposed ${elapsed}ms after normal end (code ${leaveCode})` };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testResumeAt29900Ms(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12590);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause');
    clock.advance(29900);
    const reconnected = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.result) {
      await shutdown(server);
      return {
        passed: false,
        message: `29.9s must resume. Result: ${JSON.stringify(room1.state.result)}`,
      };
    }
    if (room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: '29.9s reconnect should unpause' };
    }
    const spent = reconnected.state.player2.totalDisconnectedMs as number;
    if (spent < 29900 || spent > 29900 + 200) {
      await shutdown(server);
      return { passed: false, message: `Expected ~29900ms accrued, got ${spent}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Resume at 29.9s' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testForfeitAt30100Ms(): Promise<ReconnectionTestResult> {
  const { server, room1, room2, clock } = await startClockPair(12591);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause');
    clock.advance(30100);
    await waitUntil(() => Boolean(room1.state.result), 500, 'forfeit at 30.1s');

    const result = room1.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `30.1s must forfeit. Result: ${JSON.stringify(result)}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Forfeit at 30.1s' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testForfeitAt15500Plus14800Ms(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12592);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause before 15.5s');
    clock.advance(15500);
    const mid = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(150);
    if (room1.state.result) {
      await shutdown(server);
      return { passed: false, message: '15.5s fragment must still be alive' };
    }

    await mid.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause before 14.8s');
    clock.advance(14800);
    const again = await manualReconnect<TurfDuelState>(client2, mid.reconnectionToken!).catch(() => null);
    if (again) {
      await waitUntil(() => Boolean(again.state.result), 500, '15.5+14.8 forfeit').catch(() => undefined);
    }
    await waitUntil(() => Boolean(room1.state.result), 500, '15.5+14.8 forfeit on remaining').catch(() => undefined);

    const result = (again?.state.result ?? room1.state.result) as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `15.5+14.8s must forfeit. Result: ${JSON.stringify(result)}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Forfeit at 15.5s+14.8s' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testResumeAt15000Plus14000Ms(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12593);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause before 15s');
    clock.advance(15000);
    const mid = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(150);
    if (room1.state.result) {
      await shutdown(server);
      return { passed: false, message: '15s fragment must still be alive' };
    }

    await mid.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause before 14s');
    clock.advance(14000);
    const again = await manualReconnect<TurfDuelState>(client2, mid.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (again.state.result || room1.state.result) {
      await shutdown(server);
      return {
        passed: false,
        message: `15+14s must resume. Result: ${JSON.stringify(again.state.result ?? room1.state.result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Resume at 15s+14s' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testThirdDisconnectWhileOpponentDisconnected(): Promise<ReconnectionTestResult> {
  const { server, client1, client2, room1, room2 } = await startPair(12594);
  try {
    await room2.leave(false);
    await sleep(BRIEF_MS);
    const r1 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(150);

    const token2 = r1.reconnectionToken!;
    await r1.leave(false);
    await sleep(BRIEF_MS);
    const r2 = await manualReconnect<TurfDuelState>(client2, token2);
    await sleep(150);

    const token1 = room1.reconnectionToken!;
    await room1.leave(false);
    await sleep(100);
    await r2.leave(false);

    const spectator = await manualReconnect<TurfDuelState>(client1, token1);
    await waitUntil(() => Boolean(spectator.state.result), 1000, '3rd disconnect while opponent gone');

    const result = spectator.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `3rd disconnect while opponent is gone must lose. Result: ${JSON.stringify(result)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: '3rd disconnect loses while opponent is also disconnected' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testSameTickInputsBothApplied(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12595);
  try {
    room1.send('input', { direction: 'DOWN' });
    room2.send('input', { direction: 'UP' });

    await waitUntil(
      () => room1.state.player1.direction === 'DOWN' && room1.state.player2.direction === 'UP',
      1500,
      'both same-tick directions applied',
    );

    if (room1.state.player1.direction !== 'DOWN' || room1.state.player2.direction !== 'UP') {
      await shutdown(server);
      return {
        passed: false,
        message: `Both inputs must apply. P1=${room1.state.player1.direction} P2=${room1.state.player2.direction}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Same-tick inputs from both players are both applied' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testThirdClientCannotTakeSeat(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12596);
  try {
    const client3 = new Client('ws://localhost:12596');
    let stole = false;
    try {
      await client3.joinById<TurfDuelState>(room1.roomId);
      stole = true;
    } catch {
      /* expected */
    }
    if (stole) {
      await shutdown(server);
      return { passed: false, message: 'Third client joined the full room by id' };
    }

    const other = await client3.joinOrCreate<TurfDuelState>('turf_duel');
    disableAutoReconnect(other);
    if (other.roomId === room1.roomId || other.roomId === room2.roomId) {
      await shutdown(server);
      return { passed: false, message: 'Third client took a seat in the full match' };
    }

    await shutdown(server);
    return { passed: true, message: 'Third client cannot take a seat' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testForgedExpiredReusedTokensRejected(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12597);
  try {
    const stranger = new Client('ws://localhost:12597');
    try {
      await stranger.reconnect('forged-not-a-token');
      await shutdown(server);
      return { passed: false, message: 'Forged token must be rejected' };
    } catch {
      /* expected */
    }

    const firstToken = room2.reconnectionToken!;
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause for token tests');

    const ok = await manualReconnect<TurfDuelState>(client2, firstToken);
    try {
      await stranger.reconnect(firstToken);
      await shutdown(server);
      return { passed: false, message: 'Reused token must be rejected' };
    } catch {
      /* expected */
    }

    const expireToken = ok.reconnectionToken!;
    await ok.leave(false);
    await sleep(1500);
    try {
      await stranger.reconnect(expireToken);
      await shutdown(server);
      return { passed: false, message: 'Expired token must be rejected' };
    } catch {
      /* expected */
    }

    void clock;
    await shutdown(server);
    return { passed: true, message: 'Forged, reused, and expired tokens are rejected' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testFailedReconnectDoesNotConsumeLimits(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12598);
  try {
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause');
    const countAfterLeave = room1.state.player2.disconnectCount as number;
    if (countAfterLeave !== 1) {
      await shutdown(server);
      return { passed: false, message: `Expected count 1 after leave, got ${countAfterLeave}` };
    }

    clock.advance(5000);
    try {
      await client2.reconnect('bad-token');
      await shutdown(server);
      return { passed: false, message: 'Bad token should fail' };
    } catch {
      /* expected */
    }

    if ((room1.state.player2.disconnectCount as number) !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `Failed reconnect consumed count: ${room1.state.player2.disconnectCount}`,
      };
    }

    const ok = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    const count = ok.state.player2.disconnectCount as number;
    const spent = ok.state.player2.totalDisconnectedMs as number;
    if (count !== 1) {
      await shutdown(server);
      return { passed: false, message: `Failed reconnect used a disconnect count: ${count}` };
    }
    if (spent < 5000 || spent > 5200) {
      await shutdown(server);
      return { passed: false, message: `Failed reconnect used extra time: ${spent}ms` };
    }
    if (ok.state.result) {
      await shutdown(server);
      return { passed: false, message: 'Failed reconnect must not forfeit' };
    }

    await shutdown(server);
    return { passed: true, message: 'Failed reconnect does not consume count or time' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testForfeitResultOnBothThenDispose(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12599);
  try {
    let left1 = false;
    let left2 = false;
    room1.onLeave(() => {
      left1 = true;
    });

    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause before forfeit clock');
    clock.advance(30100);
    await waitUntil(() => Boolean(room1.state.result), 500, 'forfeit result on P1');
    const r1 = room1.state.result as { winner: number } | undefined;
    if (!r1 || r1.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `P1 missing forfeit. ${JSON.stringify(r1)}` };
    }

    const p2 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    p2.onLeave(() => {
      left2 = true;
    });
    await waitUntil(() => Boolean(p2.state.result), 500, 'forfeit result on P2');
    const r2 = p2.state.result as { winner: number } | undefined;
    if (!r2 || r2.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `P2 missing forfeit. ${JSON.stringify(r2)}` };
    }

    const endedAt = Date.now();
    await waitUntil(() => left1 && left2, 4000, 'dispose after forfeit');
    const elapsed = Date.now() - endedAt;
    if (elapsed > 3500) {
      await shutdown(server);
      return { passed: false, message: `Forfeit room dispose took ${elapsed}ms` };
    }

    await shutdown(server);
    return { passed: true, message: `Forfeit result on both clients; disposed in ${elapsed}ms` };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testTimeoutForfeitReconnectBeforeDispose(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12601);
  try {
    const token = room2.reconnectionToken!;
    await room2.leave(false);
    await waitUntil(() => Boolean(room1.state.result), LIMIT_MS + 1000, 'timeout forfeit');
    const remaining = room1.state.result as { winner: number; reason: string } | undefined;
    if (!remaining || remaining.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `Remaining client missing forfeit. ${JSON.stringify(remaining)}` };
    }

    await sleep(2500);
    const leaver = await manualReconnect<TurfDuelState>(client2, token);
    await waitUntil(() => Boolean(leaver.state.result), 500, 'leaver result 2.5s after forfeit');
    const got = leaver.state.result as { winner: number; reason: string } | undefined;
    if (!got || got.winner !== remaining.winner || got.reason !== remaining.reason) {
      await shutdown(server);
      return {
        passed: false,
        message: `Leaver must still read the forfeit 2.5s later. remaining=${JSON.stringify(remaining)} leaver=${JSON.stringify(got)}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Timeout forfeit still readable 2.5s later, before dispose' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testVoidResultOnBothThenDispose(): Promise<ReconnectionTestResult> {
  const { server, client1, client2, room1, room2, clock } = await startClockPair(12600);
  try {
    const token1 = room1.reconnectionToken!;
    const token2 = room2.reconnectionToken!;
    await room1.leave(false);
    await room2.leave(false);
    await waitUntil(() => (clockRooms.get(room1.roomId)?.state.disconnectedPlayer ?? 0) === 3, 1000, 'both disconnected');
    clock.advance(30100);
    await sleep(80);

    const s1 = await manualReconnect<TurfDuelState>(client1, token1);
    const s2 = await manualReconnect<TurfDuelState>(client2, token2);
    await waitUntil(() => Boolean(s1.state.result) && Boolean(s2.state.result), 1000, 'void on both');

    const a = s1.state.result as { winner: number } | undefined;
    const b = s2.state.result as { winner: number } | undefined;
    if (!a || a.winner !== 0 || !b || b.winner !== 0) {
      await shutdown(server);
      return { passed: false, message: `Void must reach both. P1=${JSON.stringify(a)} P2=${JSON.stringify(b)}` };
    }

    let left1 = false;
    let left2 = false;
    s1.onLeave(() => {
      left1 = true;
    });
    s2.onLeave(() => {
      left2 = true;
    });
    const endedAt = Date.now();
    await waitUntil(() => left1 && left2, 4000, 'dispose after void');
    const elapsed = Date.now() - endedAt;
    if (elapsed > 3500) {
      await shutdown(server);
      return { passed: false, message: `Void room dispose took ${elapsed}ms` };
    }

    await shutdown(server);
    return { passed: true, message: `Void result on both clients; disposed in ${elapsed}ms` };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function thirdDisconnectToken(
  client2: Client,
  room2: { reconnectionToken?: string; leave: (consented?: boolean) => Promise<number> },
): Promise<string> {
  await room2.leave(false);
  await sleep(BRIEF_MS);
  const r1 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
  await sleep(150);
  const token2 = r1.reconnectionToken!;
  await r1.leave(false);
  await sleep(BRIEF_MS);
  const r2 = await manualReconnect<TurfDuelState>(client2, token2);
  await sleep(150);
  const lastToken = r2.reconnectionToken!;
  await r2.leave(false);
  return lastToken;
}

/** Fails if TurfDuelRoom.ts post-forfeit allowReconnection window (lines 221-226) is removed. */
async function testPostForfeitWindowAllowsResultRead(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12610);
  try {
    const lastToken = await thirdDisconnectToken(client2, room2);
    await waitUntil(() => Boolean(room1.state.result), 1000, '3rd-disconnect forfeit');

    let leaver;
    try {
      leaver = await manualReconnect<TurfDuelState>(client2, lastToken);
    } catch (error) {
      await shutdown(server);
      return {
        passed: false,
        message: `Post-forfeit result window missing (TurfDuelRoom 221-226). Reconnect failed: ${error}`,
      };
    }

    await waitUntil(() => Boolean(leaver.state.result), 500, 'leaver sees forfeit');
    const got = leaver.state.result as { winner: number } | undefined;
    if (!got || got.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `Leaver must see the forfeit. ${JSON.stringify(got)}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Post-forfeit window lets the leaver read the result' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testPostForfeitReconnectIsResultOnly(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12611);
  try {
    const lastToken = await thirdDisconnectToken(client2, room2);
    await waitUntil(() => Boolean(room1.state.result), 1000, 'forfeit');
    const tickAtResult = room1.state.tick;
    const p2Alive = room1.state.player2.isAlive;

    const leaver = await manualReconnect<TurfDuelState>(client2, lastToken);
    await waitUntil(() => Boolean(leaver.state.result), 500, 'leaver result');
    await sleep(200);

    if (!leaver.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Forfeit reconnect must not resume the match' };
    }
    if (leaver.state.tick !== tickAtResult) {
      await shutdown(server);
      return { passed: false, message: `Tick advanced after forfeit reconnect: ${tickAtResult} → ${leaver.state.tick}` };
    }
    if (leaver.state.player2.isAlive !== p2Alive) {
      await shutdown(server);
      return { passed: false, message: 'Forfeit reconnect must not revive a player' };
    }

    const winner = (leaver.state.result as { winner: number }).winner;
    leaver.send('input', { direction: 'UP' });
    room1.send('input', { direction: 'DOWN' });
    await sleep(250);
    if (!leaver.state.paused || leaver.state.tick !== tickAtResult) {
      await shutdown(server);
      return { passed: false, message: 'Input after forfeit reconnect must be ignored' };
    }
    const after = leaver.state.result as { winner: number } | undefined;
    if (!after || after.winner !== winner) {
      await shutdown(server);
      return { passed: false, message: `Input overwrote result: ${JSON.stringify(after)}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Forfeit reconnect is result-only: no resume, revive, or input' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testCleanupElapsedFromResultDecision(): Promise<ReconnectionTestResult> {
  const { server, room1, room2, clock } = await startClockPair(12612);
  try {
    let leaveCode: number | undefined;
    room1.onLeave((code) => {
      leaveCode = code;
    });

    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause');
    clock.advance(30100);
    await waitUntil(() => Boolean(room1.state.result), 500, 'result decided');
    const decidedAt = Date.now();

    await waitUntil(() => leaveCode !== undefined, 4000, 'dispose after result');
    const elapsed = Date.now() - decidedAt;
    if (elapsed < 2500 || elapsed > 3500) {
      await shutdown(server);
      return {
        passed: false,
        message: `Cleanup must be ~3s from result decision, got ${elapsed}ms code=${leaveCode}`,
      };
    }
    if (leaveCode !== 4000) {
      await shutdown(server);
      return { passed: false, message: `Remaining client should close with 4000, got ${leaveCode}` };
    }

    await shutdown(server);
    return { passed: true, message: `Cleanup ${elapsed}ms after result (code ${leaveCode})` };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testBothClose4000ThenDisposedReconnectFails(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2, clock } = await startClockPair(12613);
  try {
    let code1: number | undefined;
    room1.onLeave((code) => {
      code1 = code;
    });

    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause');
    clock.advance(30100);
    await waitUntil(() => Boolean(room1.state.result), 500, 'forfeit');

    const p2 = await manualReconnect<TurfDuelState>(client2, room2.reconnectionToken!);
    let code2: number | undefined;
    p2.onLeave((code) => {
      code2 = code;
    });
    const tokenAfter = p2.reconnectionToken!;

    await waitUntil(() => code1 !== undefined && code2 !== undefined, 4000, 'both closed');
    if (code1 !== 4000 || code2 !== 4000) {
      await shutdown(server);
      return { passed: false, message: `Both should close 4000, got P1=${code1} P2=${code2}` };
    }

    try {
      await client2.reconnect(tokenAfter);
      await shutdown(server);
      return { passed: false, message: 'Reconnect after dispose must fail' };
    } catch {
      /* expected disposed */
    }

    await shutdown(server);
    return { passed: true, message: 'Both closed 4000; later reconnect is disposed' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testStrongerForgedTokenRejected(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12614);
  try {
    const real = room2.reconnectionToken!;
    const stranger = new Client('ws://localhost:12614');
    const forgeries = [
      '',
      'x',
      `${real}ff`,
      real.slice(0, Math.max(1, real.length - 3)),
      real.replace(/[A-Za-z0-9]/, 'Z'),
      '0'.repeat(Math.max(8, real.length)),
    ];

    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'pause');

    for (const fake of forgeries) {
      try {
        await stranger.reconnect(fake);
        await shutdown(server);
        return { passed: false, message: `Forged token was accepted: ${JSON.stringify(fake)}` };
      } catch {
        /* expected */
      }
    }

    const ok = await manualReconnect<TurfDuelState>(client2, real);
    if (ok.state.paused === undefined) {
      await shutdown(server);
      return { passed: false, message: 'Real token should still reconnect' };
    }

    await shutdown(server);
    return { passed: true, message: 'Mutated/empty/garbage tokens rejected; real token still works' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOverlapExceedUnder50msIsVoid(): Promise<ReconnectionTestResult> {
  const { server, client1, client2, room1, room2, clock } = await startClockPair(12615);
  try {
    const token1 = room1.reconnectionToken!;
    const token2 = room2.reconnectionToken!;
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'p2 pause');
    clock.advance(40);
    await room1.leave(false);
    await waitUntil(() => (clockRooms.get(room1.roomId)?.state.disconnectedPlayer ?? 0) === 3, 1000, 'both gone');
    clock.advance(30100);
    await sleep(80);

    const s1 = await manualReconnect<TurfDuelState>(client1, token1);
    const s2 = await manualReconnect<TurfDuelState>(client2, token2);
    await waitUntil(() => Boolean(s1.state.result) && Boolean(s2.state.result), 1000, 'void');
    const a = s1.state.result as { winner: number } | undefined;
    const b = s2.state.result as { winner: number } | undefined;
    if (!a || a.winner !== 0 || !b || b.winner !== 0) {
      await shutdown(server);
      return { passed: false, message: `<50ms gap must be void. P1=${JSON.stringify(a)} P2=${JSON.stringify(b)}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Exceed gap <50ms is void' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOverlapExceedOver50msFirstLoses(): Promise<ReconnectionTestResult> {
  const { server, client1, room1, room2, clock } = await startClockPair(12616);
  try {
    const token1 = room1.reconnectionToken!;
    await room2.leave(false);
    await waitUntil(() => room1.state.paused, 1000, 'p2 pause');
    clock.advance(60);
    await room1.leave(false);
    await waitUntil(() => (clockRooms.get(room1.roomId)?.state.disconnectedPlayer ?? 0) === 3, 1000, 'both gone');
    // P2 started 60ms earlier: 60+29950=30010 over, P1=29950 under.
    clock.advance(29950);
    await sleep(80);

    const s1 = await manualReconnect<TurfDuelState>(client1, token1);
    await waitUntil(() => Boolean(s1.state.result), 1000, 'first-exceed');
    const result = s1.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `>=50ms gap: first to exceed (P2) loses. ${JSON.stringify(result)}` };
    }

    await shutdown(server);
    return { passed: true, message: 'Exceed gap >=50ms: first over loses' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testNode20EngineStrictJob(): Promise<ReconnectionTestResult> {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines?: { node?: string } };
    const npmrc = readFileSync(join(root, '.npmrc'), 'utf8');
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    if (pkg.engines?.node !== '>=22') {
      return { passed: false, message: `engines.node must be >=22, got ${pkg.engines?.node}` };
    }
    if (!npmrc.includes('engine-strict=true')) {
      return { passed: false, message: '.npmrc must set engine-strict=true' };
    }
    if (!ci.includes('node20-engine-strict') || !ci.includes('EBADENGINE') || !ci.includes("node-version: '20'")) {
      return { passed: false, message: 'CI node20-engine-strict job must fail npm ci with EBADENGINE' };
    }
    return { passed: true, message: 'Node 20 npm ci is gated by engine-strict CI job' };
  } catch (error) {
    return { passed: false, message: `Error: ${error}` };
  }
}

async function runAllTests() {
  console.log('🎮 땅따 Reconnection E2E Tests\n');

  const tests = [
    { name: 'Reconnect within time resumes with identical state', fn: testReconnectWithinTimeResumesMatch },
    { name: 'Two short disconnects are OK', fn: testTwoShortDisconnectsOK },
    { name: '3rd disconnect causes loss', fn: testThirdDisconnectLoses },
    { name: 'Exceeding 30s total time causes loss', fn: testExceeding30SecondsTotalLoses },
    { name: '29s disconnect is within boundary', fn: test29SecondsBoundary },
    { name: 'Both disconnect then both return resumes', fn: testBothDisconnectThenBothReturnResumes },
    { name: 'Reconnecting player keeps same player number', fn: testReconnectingPlayerKeepsSameNumber },
    { name: 'Opponent receives countdown', fn: testOpponentReceivesCountdown },
    { name: '15.5+14.8s accumulated time loses', fn: testAccumulatedFragmentsExceedLimit },
    { name: 'Overlapping: first to exceed loses', fn: testOverlappingFirstExceedsLoses },
    { name: 'Overlapping: same-tick both exceed is void', fn: testOverlappingSameTickBothExceedVoid },
    { name: 'Voluntary leave code 4000 is an immediate loss', fn: testVoluntaryLeave4000ImmediateLoss },
    { name: 'Close code 1000 is an immediate loss', fn: () => testCloseCodeIsImmediateLoss(12582, 1000) },
    { name: 'Close code 4001 is an immediate loss', fn: () => testCloseCodeIsImmediateLoss(12583, 4001) },
    { name: 'Waiting-room leave frees the seat', fn: testWaitingRoomLeaveFreesSeat },
    { name: 'Room disposes within ~3s after normal end', fn: testRoomDisposesAfterNormalEnd },
    { name: 'Input while paused is dropped', fn: testInputDroppedWhilePaused },
    { name: 'Input after result is dropped', fn: testInputDroppedAfterResult },
    { name: 'Resume at 29.9s', fn: testResumeAt29900Ms },
    { name: 'Forfeit at 30.1s', fn: testForfeitAt30100Ms },
    { name: 'Forfeit at 15.5s+14.8s', fn: testForfeitAt15500Plus14800Ms },
    { name: 'Resume at 15s+14s', fn: testResumeAt15000Plus14000Ms },
    { name: '3rd disconnect loses while opponent is also disconnected', fn: testThirdDisconnectWhileOpponentDisconnected },
    { name: 'Same-tick inputs from both players are both applied', fn: testSameTickInputsBothApplied },
    { name: 'Third client cannot take a seat', fn: testThirdClientCannotTakeSeat },
    { name: 'Forged, expired, and reused tokens are rejected', fn: testForgedExpiredReusedTokensRejected },
    { name: 'Failed reconnect does not consume count or time', fn: testFailedReconnectDoesNotConsumeLimits },
    { name: 'Forfeit result reaches both clients and room disposes', fn: testForfeitResultOnBothThenDispose },
    { name: 'Timeout forfeit still readable 2.5s later, before dispose', fn: testTimeoutForfeitReconnectBeforeDispose },
    { name: 'Void result reaches both clients and room disposes', fn: testVoidResultOnBothThenDispose },
    { name: 'Post-forfeit window lets the leaver read the result', fn: testPostForfeitWindowAllowsResultRead },
    { name: 'Forfeit reconnect is result-only', fn: testPostForfeitReconnectIsResultOnly },
    { name: 'Cleanup is ~3s from result decision', fn: testCleanupElapsedFromResultDecision },
    { name: 'Both close 4000 then disposed reconnect fails', fn: testBothClose4000ThenDisposedReconnectFails },
    { name: 'Stronger forged token rejection', fn: testStrongerForgedTokenRejected },
    { name: 'Overlap exceed gap <50ms is void', fn: testOverlapExceedUnder50msIsVoid },
    { name: 'Overlap exceed gap >=50ms first loses', fn: testOverlapExceedOver50msFirstLoses },
    { name: 'Node 20 engine-strict CI job is present', fn: testNode20EngineStrictJob },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`Testing: ${test.name}... `);
    const result = await Promise.race([
      test.fn(),
      sleep(25000).then(() => ({ passed: false, message: 'Timed out after 25s' })),
    ]);
    if (result.passed) {
      console.log('✓ PASS');
      passed++;
    } else {
      console.log(`✗ FAIL: ${result.message}`);
      failed++;
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Passed: ${passed}/${tests.length}`);
  console.log(`Failed: ${failed}/${tests.length}`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log('\n✓ All reconnection tests passed!');
  process.exit(0);
}

runAllTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
