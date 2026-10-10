import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Direction, MATCH_DURATION_TICKS } from '@turf-duel/engine';
import { TurfDuelState } from './schema/TurfDuelState.js';

interface ReconnectionTestResult {
  passed: boolean;
  message: string;
}

async function testReconnectWithinTimeResumesMatch(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12568);

  try {
    const client1 = new Client('ws://localhost:12568');
    const client2 = new Client('ws://localhost:12568');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    // Wait for game to start
    await new Promise(resolve => setTimeout(resolve, 100));

    const tickBeforeDisconnect = room1.state.tick;
    const p1PosBeforeDisconnect = { 
      x: room1.state.player1.position.x, 
      y: room1.state.player1.position.y 
    };

    // Disconnect player 2
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that game is paused
    if (!room1.state.paused) {
      await server.gracefullyShutdown();
      return { passed: false, message: 'Game should be paused when player disconnects' };
    }

    const tickDuringDisconnect = room1.state.tick;

    // Wait 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Reconnect player 2
    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Check that game resumed
    if (room1.state.paused) {
      await server.gracefullyShutdown();
      return { passed: false, message: 'Game should resume after reconnection' };
    }

    // Check that tick and positions remained the same during disconnect
    const p1PosAfterReconnect = { 
      x: room1.state.player1.position.x, 
      y: room1.state.player1.position.y 
    };

    if (tickDuringDisconnect !== tickBeforeDisconnect) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Tick should not advance during disconnect. Before: ${tickBeforeDisconnect}, During: ${tickDuringDisconnect}` 
      };
    }

    if (p1PosBeforeDisconnect.x !== p1PosAfterReconnect.x || 
        p1PosBeforeDisconnect.y !== p1PosAfterReconnect.y) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Positions should not change during disconnect. Before: (${p1PosBeforeDisconnect.x}, ${p1PosBeforeDisconnect.y}), After: (${p1PosAfterReconnect.x}, ${p1PosAfterReconnect.y})` 
      };
    }

    await room1.leave();
    await room2Reconnect.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: 'Reconnection within time resumes with identical state' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testTwoShortDisconnectsOK(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12569);

  try {
    const client1 = new Client('ws://localhost:12569');
    const client2 = new Client('ws://localhost:12569');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // First disconnect (5 seconds)
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 5000));
    const room2Reconnect1 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);

    const disconnectCount1 = room1.state.player2.disconnectCount as number;
    if (disconnectCount1 !== 1) {
      await server.gracefullyShutdown();
      return { passed: false, message: `Expected disconnect count 1, got ${disconnectCount1}` };
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    // Second disconnect (5 seconds)
    await room2Reconnect1.leave(false);
    await new Promise(resolve => setTimeout(resolve, 5000));
    const room2Reconnect2 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);

    const disconnectCount2 = room1.state.player2.disconnectCount as number;
    if (disconnectCount2 !== 2) {
      await server.gracefullyShutdown();
      return { passed: false, message: `Expected disconnect count 2, got ${disconnectCount2}` };
    }

    // Game should still be running
    if (room1.state.result) {
      await server.gracefullyShutdown();
      return { passed: false, message: 'Game should not end after 2 disconnects' };
    }

    await room1.leave();
    await room2Reconnect2.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: 'Two short disconnects are OK' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testThirdDisconnectLoses(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12570);

  try {
    const client1 = new Client('ws://localhost:12570');
    const client2 = new Client('ws://localhost:12570');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // First disconnect
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const room2Reconnect1 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Second disconnect
    await room2Reconnect1.leave(false);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const room2Reconnect2 = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Third disconnect - should cause loss
    await room2Reconnect2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check that player 2 lost
    if (!room1.state.result || room1.state.result.winner !== 1) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Player 2 should lose on 3rd disconnect. Result: ${JSON.stringify(room1.state.result)}` 
      };
    }

    await room1.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: '3rd disconnect causes loss' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testExceeding30SecondsTotalLoses(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12571);

  try {
    const client1 = new Client('ws://localhost:12571');
    const client2 = new Client('ws://localhost:12571');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // Disconnect for 31 seconds (exceeds 30s limit)
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 31000));

    // Check that player 2 lost
    if (!room1.state.result || room1.state.result.winner !== 1) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Player 2 should lose after 31s disconnect. Result: ${JSON.stringify(room1.state.result)}` 
      };
    }

    await room1.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: 'Exceeding 30s total disconnect time causes loss' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function test29SecondsBoundary(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12572);

  try {
    const client1 = new Client('ws://localhost:12572');
    const client2 = new Client('ws://localhost:12572');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // Disconnect for 29 seconds (within 30s limit)
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 29000));

    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Game should still be running
    if (room1.state.result) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Game should not end after 29s disconnect. Result: ${JSON.stringify(room1.state.result)}` 
      };
    }

    await room1.leave();
    await room2Reconnect.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: '29s disconnect is OK' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testBothDisconnectedVoid(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12573);

  try {
    const client1 = new Client('ws://localhost:12573');
    const client2 = new Client('ws://localhost:12573');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // Both players disconnect
    const room1Token = room1.reconnectionToken;
    const room2Token = room2.reconnectionToken;

    await room1.leave(false);
    await room2.leave(false);

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Reconnect player 1 to check result
    const room1Reconnect = await client1.reconnect<TurfDuelState>(room1Token!);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Match should be void (draw with both disconnected reason)
    if (!room1Reconnect.state.result || room1Reconnect.state.result.winner !== 0) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Match should be void when both disconnect. Result: ${JSON.stringify(room1Reconnect.state.result)}` 
      };
    }

    await room1Reconnect.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: 'Both disconnected results in void match' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testReconnectingPlayerKeepsSameNumber(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12574);

  try {
    const client1 = new Client('ws://localhost:12574');
    const client2 = new Client('ws://localhost:12574');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // Record player 2's initial position
    const p2InitialPos = {
      x: room1.state.player2.position.x,
      y: room1.state.player2.position.y,
    };

    // Disconnect player 2
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Reconnect player 2
    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check that player 2 still has the same position (indicating same player number)
    const p2FinalPos = {
      x: room1.state.player2.position.x,
      y: room1.state.player2.position.y,
    };

    if (p2InitialPos.x !== p2FinalPos.x || p2InitialPos.y !== p2FinalPos.y) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Reconnecting player should keep same player number and position. Initial: (${p2InitialPos.x}, ${p2InitialPos.y}), Final: (${p2FinalPos.x}, ${p2FinalPos.y})` 
      };
    }

    await room1.leave();
    await room2Reconnect.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: 'Reconnecting player keeps same player number' };
  } catch (error) {
    await server.gracefullyShutdown();
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOpponentReceivesCountdown(): Promise<ReconnectionTestResult> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12575);

  try {
    const client1 = new Client('ws://localhost:12575');
    const client2 = new Client('ws://localhost:12575');

    const room1 = await client1.joinOrCreate<TurfDuelState>('turf_duel');
    const room2 = await client2.joinOrCreate<TurfDuelState>('turf_duel');

    await new Promise(resolve => setTimeout(resolve, 100));

    // Disconnect player 2
    await room2.leave(false);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check that player 1 sees countdown
    if (room1.state.disconnectCountdownSeconds <= 0) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Opponent should see countdown. Countdown: ${room1.state.disconnectCountdownSeconds}` 
      };
    }

    // Reconnect player 2
    const room2Reconnect = await client2.reconnect<TurfDuelState>(room2.reconnectionToken!);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Countdown should be cleared
    if (room1.state.disconnectCountdownSeconds !== 0) {
      await server.gracefullyShutdown();
      return { 
        passed: false, 
        message: `Countdown should be cleared after reconnection. Countdown: ${room1.state.disconnectCountdownSeconds}` 
      };
    }

    await room1.leave();
    await room2Reconnect.leave();
    await server.gracefullyShutdown();

    return { passed: true, message: 'Opponent receives countdown during disconnect' };
  } catch (error) {
    await server.gracefullyShutdown();
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
    { name: 'Both disconnected results in void', fn: testBothDisconnectedVoid },
    { name: 'Reconnecting player keeps same player number', fn: testReconnectingPlayerKeepsSameNumber },
    { name: 'Opponent receives countdown', fn: testOpponentReceivesCountdown },
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
  } else {
    console.log('\n✓ All reconnection tests passed!');
    process.exit(0);
  }
}

runAllTests().catch(console.error);
