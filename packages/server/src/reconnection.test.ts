import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { TurfDuelState } from './schema/TurfDuelState.js';

// Same limit math as production; shrink the window so CI stays fast.
process.env.TURF_DUEL_MAX_DISCONNECT_MS ??= '3000';
const LIMIT_MS = Number(process.env.TURF_DUEL_MAX_DISCONNECT_MS);
const START_WAIT_MS = 5200; // Colyseus 0.18 rejects reconnect before 5s room uptime
const AFTER_RECONNECT_MS = 600;
const SHORT_MS = Math.max(250, Math.round(LIMIT_MS * 5 / 30));
const BRIEF_MS = Math.max(200, Math.round(LIMIT_MS * 2 / 30));

interface ReconnectionTestResult {
  passed: boolean;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(server: Server): Promise<void> {
  try {
    await server.gracefullyShutdown(false);
  } catch {
    /* ignore */
  }
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
  await sleep(START_WAIT_MS);
  return { server, client1, client2, room1, room2 };
}

async function testReconnectWithinTimeResumesMatch(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12568);
  try {
    const tickBeforeDisconnect = room1.state.tick;
    const p1PosBeforeDisconnect = {
      x: room1.state.player1.position.x,
      y: room1.state.player1.position.y,
    };

    await room2.leave(false);
    await sleep(150);

    if (!room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Game should be paused when player disconnects' };
    }

    const tickDuringDisconnect = room1.state.tick;
    await sleep(BRIEF_MS);

    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Game should resume after reconnection' };
    }

    const p1PosAfterReconnect = {
      x: room1.state.player1.position.x,
      y: room1.state.player1.position.y,
    };

    if (tickDuringDisconnect !== tickBeforeDisconnect) {
      await shutdown(server);
      return {
        passed: false,
        message: `Tick should not advance during disconnect. Before: ${tickBeforeDisconnect}, During: ${tickDuringDisconnect}`,
      };
    }

    if (
      p1PosBeforeDisconnect.x !== p1PosAfterReconnect.x ||
      p1PosBeforeDisconnect.y !== p1PosAfterReconnect.y
    ) {
      await shutdown(server);
      return {
        passed: false,
        message: `Positions should not change during disconnect. Before: (${p1PosBeforeDisconnect.x}, ${p1PosBeforeDisconnect.y}), After: (${p1PosAfterReconnect.x}, ${p1PosAfterReconnect.y})`,
      };
    }

    await room1.leave(true);
    await room2Reconnect.leave(true);
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
    const room2Reconnect1 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);

    const disconnectCount1 = room1.state.player2.disconnectCount as number;
    if (disconnectCount1 !== 1) {
      await shutdown(server);
      return { passed: false, message: `Expected disconnect count 1, got ${disconnectCount1}` };
    }

    await sleep(150);
    await room2Reconnect1.leave(false);
    await sleep(SHORT_MS);
    const room2Reconnect2 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);

    const disconnectCount2 = room1.state.player2.disconnectCount as number;
    if (disconnectCount2 !== 2) {
      await shutdown(server);
      return { passed: false, message: `Expected disconnect count 2, got ${disconnectCount2}` };
    }

    if (room1.state.result) {
      await shutdown(server);
      return { passed: false, message: 'Game should not end after 2 disconnects' };
    }

    await room1.leave(true);
    await room2Reconnect2.leave(true);
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
    const r1 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(150);

    await r1.leave(false);
    await sleep(BRIEF_MS);
    const r2 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
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
    await sleep(LIMIT_MS + 250);

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

    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.result) {
      await shutdown(server);
      return {
        passed: false,
        message: `Game should not end after 29s-equivalent disconnect. Result: ${JSON.stringify(room1.state.result)}`,
      };
    }

    await room1.leave(true);
    await room2Reconnect.leave(true);
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

    const r1 = await client1.reconnect<TurfDuelState>(token1!);
    const r2 = await client2.reconnect<TurfDuelState>(token2!);
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

    await r1.leave(true);
    await r2.leave(true);
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
    const p2InitialPos = {
      x: room1.state.player2.position.x,
      y: room1.state.player2.position.y,
    };

    await room2.leave(false);
    await sleep(BRIEF_MS);
    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    const p2FinalPos = {
      x: room1.state.player2.position.x,
      y: room1.state.player2.position.y,
    };

    if (p2InitialPos.x !== p2FinalPos.x || p2InitialPos.y !== p2FinalPos.y) {
      await shutdown(server);
      return {
        passed: false,
        message: `Reconnecting player should keep same player number and position. Initial: (${p2InitialPos.x}, ${p2InitialPos.y}), Final: (${p2FinalPos.x}, ${p2FinalPos.y})`,
      };
    }

    await room1.leave(true);
    await room2Reconnect.leave(true);
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

    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.disconnectCountdownSeconds !== 0) {
      await shutdown(server);
      return {
        passed: false,
        message: `Countdown should be cleared after reconnection. Countdown: ${room1.state.disconnectCountdownSeconds}`,
      };
    }

    await room1.leave(true);
    await room2Reconnect.leave(true);
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
    const mid = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(150);

    if (room1.state.result) {
      await shutdown(server);
      return { passed: false, message: 'Should still be alive after the first fragment' };
    }

    await mid.leave(false);
    await sleep(second + 150);

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
    const p2 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await sleep(150);

    const token1 = room1.reconnectionToken;
    await room1.leave(false);
    await p2.leave(false);
    await sleep(second + 150);

    // P2 already had ~15.5s; this fragment pushes P2 over. P1 only has ~14.8s.
    const spectator = await client1.reconnect<TurfDuelState>(token1!).catch(() => null);
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

    const spectator = await client1.reconnect<TurfDuelState>(token1!).catch(() => null);
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

async function testVoluntaryLeave4000Counts(): Promise<ReconnectionTestResult> {
  const { server, client2, room1, room2 } = await startPair(12579);
  try {
    const token = room2.reconnectionToken;
    // Colyseus 0.18 consented leave is close code 4000
    await room2.leave(true);
    await sleep(250);

    if (!room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Voluntary leave (4000) must pause the match' };
    }
    if (room1.state.player2.disconnectCount !== 1) {
      await shutdown(server);
      return {
        passed: false,
        message: `4000 must count as a disconnect. Count: ${room1.state.player2.disconnectCount}`,
      };
    }

    const reconnected = await client2.reconnect<TurfDuelState>(token!);
    await sleep(AFTER_RECONNECT_MS);

    if (room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Match should resume after 4000 + reconnect' };
    }

    await room1.leave(true);
    await reconnected.leave(true);
    await shutdown(server);
    return { passed: true, message: 'Voluntary leave code 4000 counts as a disconnect' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testRollbackDoesNotUnpause(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12580);
  try {
    await room2.leave(false);
    await sleep(200);

    if (!room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Expected pause after opponent disconnect' };
    }

    const tickWhilePaused = room1.state.tick;
    room1.send('input', { direction: 'DOWN', clientTick: Math.max(0, tickWhilePaused - 2) });
    await sleep(250);

    if (!room1.state.paused) {
      await shutdown(server);
      return { passed: false, message: 'Rollback input must not unpause a disconnected match' };
    }
    if (room1.state.tick !== tickWhilePaused) {
      await shutdown(server);
      return {
        passed: false,
        message: `Rollback must not advance ticks while paused. Before: ${tickWhilePaused}, After: ${room1.state.tick}`,
      };
    }

    await shutdown(server);
    return { passed: true, message: 'Rollback input does not unpause' };
  } catch (error) {
    await shutdown(server);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testRollbackDoesNotReviveAfterResult(): Promise<ReconnectionTestResult> {
  const { server, room1, room2 } = await startPair(12581);
  try {
    await room2.leave(false);
    await sleep(LIMIT_MS + 250);

    const result = room1.state.result as { winner: number } | undefined;
    if (!result || result.winner !== 1) {
      await shutdown(server);
      return { passed: false, message: `Expected forfeit before rollback. Result: ${JSON.stringify(result)}` };
    }

    const p2Alive = room1.state.player2.isAlive;
    const winner = result.winner;
    room1.send('input', { direction: 'UP', clientTick: Math.max(0, room1.state.tick - 2) });
    await sleep(250);

    const after = room1.state.result as { winner: number } | undefined;
    if (!after || after.winner !== winner) {
      await shutdown(server);
      return { passed: false, message: `Rollback must not overwrite result. After: ${JSON.stringify(after)}` };
    }
    if (room1.state.player2.isAlive !== p2Alive) {
      await shutdown(server);
      return { passed: false, message: 'Rollback must not revive a player after the match ended' };
    }

    await shutdown(server);
    return { passed: true, message: 'Rollback after result does not revive' };
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
    { name: 'Voluntary leave code 4000 counts', fn: testVoluntaryLeave4000Counts },
    { name: 'Rollback input does not unpause', fn: testRollbackDoesNotUnpause },
    { name: 'Rollback after result does not revive', fn: testRollbackDoesNotReviveAfterResult },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`Testing: ${test.name}... `);
    const result = await test.fn();
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
