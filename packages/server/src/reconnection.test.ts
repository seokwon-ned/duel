import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { createInitialState, step } from '@turf-duel/engine';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
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
