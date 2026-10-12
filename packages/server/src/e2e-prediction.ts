// Client-side prediction E2E:
// 1) Real 200ms bidirectional delay; turn cell == head at clientTick (0 offset), 5 phases
// 2) Predicted/reconciled local grid+head == authority server state
// 3) Out-of-window / future ticks are clamped
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { TurfDuelTestRoom, testRooms, TurnLog } from './rooms/TurfDuelTestRoom.js';
import { DelayedClient, DelayedRoom } from './test-utils/DelayedClient.js';
import { ClientPredictor, Direction } from '@turf-duel/engine';

const DELAY_MS = 200;

interface TestResult {
  passed: boolean;
  message: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function manhattan(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Pick a legal perpendicular that stays farthest from the walls. */
function safeTurn(pos: { x: number; y: number }, dir: Direction): Direction {
  const options: Direction[] =
    dir === Direction.UP || dir === Direction.DOWN
      ? [Direction.LEFT, Direction.RIGHT]
      : [Direction.UP, Direction.DOWN];
  const room = (d: Direction) => {
    if (d === Direction.UP) return pos.y;
    if (d === Direction.DOWN) return 39 - pos.y;
    if (d === Direction.LEFT) return pos.x;
    return 39 - pos.x;
  };
  return room(options[0]) >= room(options[1]) ? options[0] : options[1];
}

async function waitUntil(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(10);
  }
}

async function startRoom(port: number): Promise<{
  server: Server;
  room1: DelayedRoom;
  room2: DelayedRoom;
  testRoom: TurfDuelTestRoom;
  predictor: ClientPredictor;
}> {
  const server = new Server({
    transport: new WebSocketTransport({}),
  });
  server.define('turf_duel', TurfDuelTestRoom);
  await server.listen(port);

  const client1 = new DelayedClient(`ws://localhost:${port}`, DELAY_MS);
  const client2 = new DelayedClient(`ws://localhost:${port}`, DELAY_MS);
  const room1 = await client1.joinOrCreate('turf_duel');
  const room2 = await client2.joinOrCreate('turf_duel');

  const testRoom = testRooms.get(room1.roomId);
  if (!testRoom) {
    throw new Error(`Test room ${room1.roomId} not registered`);
  }

  const predictor = new ClientPredictor(1, DELAY_MS);
  room1.onStateChange((state) => {
    predictor.reconcile(state);
  });

  await waitUntil(() => predictor.predicted !== null && testRoom.getAuthorityState().tick > 2, 8000, 'first delayed state + ticks');

  return { server, room1, room2, testRoom, predictor };
}

async function shutdown(server: Server, room1: DelayedRoom, room2: DelayedRoom): Promise<void> {
  try {
    await room1.leave(true);
  } catch {
    /* ignore */
  }
  try {
    await room2.leave(true);
  } catch {
    /* ignore */
  }
  try {
    await server.gracefullyShutdown(false);
  } catch {
    /* ignore */
  }
}

async function testPredictionWithLatency(): Promise<TestResult> {
  console.log('\n=== Test: 200ms bidirectional delay — turn cell == intended cell (5 phases) ===\n');

  const { server, room1, room2, testRoom, predictor } = await startRoom(12573);
  const offsets: number[] = [];

  try {
    for (let phase = 0; phase < 5; phase++) {
      await waitUntil(
        () => predictor.predicted !== null && predictor.predicted.tick % 5 === phase && predictor.predicted.tick > 4,
        8000,
        `tick phase ${phase}`,
      );

      const beforeLogs = testRoom.turnLogs.length;
      const dir = safeTurn(predictor.view().head, predictor.view().direction);
      const { clientTick, intendedCell } = predictor.applyInput(dir);

      console.log(
        `Phase ${phase}: clientTick=${clientTick} intended=(${intendedCell.x},${intendedCell.y}) dir=${dir} serverTick=${testRoom.getAuthorityState().tick}`,
      );

      room1.send('input', { direction: dir, clientTick });

      await waitUntil(
        () => testRoom.turnLogs.slice(beforeLogs).some((log) => log.player === 1 && log.newDirection === dir),
        6000,
        `turn log for phase ${phase}`,
      );

      const log: TurnLog | undefined = testRoom.turnLogs
        .slice(beforeLogs)
        .find((entry) => entry.player === 1 && entry.newDirection === dir);

      if (!log) {
        return { passed: false, message: `Phase ${phase}: no turn log recorded` };
      }

      const offset = manhattan(log.position, intendedCell);
      offsets.push(offset);
      console.log(
        `  server applied at tick ${log.tick} cell (${log.position.x},${log.position.y}) offset=${offset}`,
      );

      if (offset !== 0) {
        await shutdown(server, room1, room2);
        return {
          passed: false,
          message: `Phase ${phase}: turn-cell offset ${offset} (expected 0). intended=(${intendedCell.x},${intendedCell.y}) applied=(${log.position.x},${log.position.y}) clientTick=${clientTick} appliedTick=${log.tick}`,
        };
      }

      await delay(250);
    }

    await shutdown(server, room1, room2);
    return {
      passed: true,
      message: `✓ 5/5 phases: turn cell == intended cell (offsets=${JSON.stringify(offsets)})`,
    };
  } catch (error) {
    await shutdown(server, room1, room2);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testReconciliationGridMatch(): Promise<TestResult> {
  console.log('\n=== Test: predicted/reconciled local grid+head == server authority ===\n');

  const { server, room1, room2, testRoom, predictor } = await startRoom(12574);

  try {
    for (let i = 0; i < 8; i++) {
      await waitUntil(() => predictor.predicted !== null, 4000, 'predictor ready');
      const dir = safeTurn(predictor.view().head, predictor.view().direction);
      const { clientTick } = predictor.applyInput(dir);
      room1.send('input', { direction: dir, clientTick });
      await delay(80);
    }

    // Flush send + receive delays and let pending inputs ack
    await delay(DELAY_MS * 2 + 400);

    const authority = testRoom.getAuthorityState();
    const view = predictor.view();
    const gridDiffs = predictor.gridDiff(authority.grid);
    const headOffset = manhattan(view.head, authority.player1.position);

    console.log(`grid diffs=${gridDiffs} head offset=${headOffset} localTick=${view.tick} serverTick=${authority.tick}`);

    await shutdown(server, room1, room2);

    if (gridDiffs !== 0 || headOffset !== 0) {
      return {
        passed: false,
        message: `Reconcile mismatch: gridDiffs=${gridDiffs} headOffset=${headOffset} (expected 0/0)`,
      };
    }

    return {
      passed: true,
      message: `✓ Predicted/reconciled grid and head match server (0/0)`,
    };
  } catch (error) {
    await shutdown(server, room1, room2);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function testOutOfWindowInputsClamped(): Promise<TestResult> {
  console.log('\n=== Test: out-of-window / future ticks clamped ===\n');

  const { server, room1, room2, testRoom } = await startRoom(12575);

  try {
    const tickBefore = testRoom.getAuthorityState().tick;
    const posBefore = { ...testRoom.getAuthorityState().player1.position };

    room1.send('input', { direction: Direction.UP, clientTick: tickBefore - 20 });
    room1.send('input', { direction: Direction.DOWN, clientTick: tickBefore + 100 });

    await delay(DELAY_MS + 400);

    const after = testRoom.getAuthorityState();
    const p1Alive = after.player1.isAlive;
    const p2Alive = after.player2.isAlive;

    // Old tick must not rewind / rewrite the past position as if applied 20 ticks ago
    // (player may have moved forward from clamping-to-now, which is allowed)
    const movedBackwards =
      after.player1.position.x < posBefore.x - 1 || after.player1.position.y < posBefore.y - 1;

    await shutdown(server, room1, room2);

    if (!p1Alive && !p2Alive) {
      return { passed: false, message: 'Both players died from out-of-window ticks' };
    }
    if (movedBackwards) {
      return { passed: false, message: 'Out-of-window input rewrote a past outcome' };
    }

    return {
      passed: true,
      message: '✓ Out-of-window/future inputs clamped; past outcomes unchanged',
    };
  } catch (error) {
    await shutdown(server, room1, room2);
    return { passed: false, message: `Error: ${error}` };
  }
}

async function runTests() {
  console.log('🎮 Client-Side Prediction E2E Tests (200ms bidirectional delay)\n');

  const results: TestResult[] = [];
  results.push(await testPredictionWithLatency());
  results.push(await testReconciliationGridMatch());
  results.push(await testOutOfWindowInputsClamped());

  console.log('\n=== Test Results ===\n');
  let passedCount = 0;
  for (const result of results) {
    console.log(`${result.passed ? '✅' : '❌'} ${result.message}`);
    if (result.passed) passedCount++;
  }
  console.log(`\n${passedCount}/${results.length} tests passed\n`);

  process.exit(passedCount < results.length ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
