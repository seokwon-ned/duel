import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from 'colyseus.js';
import * as WebSocket from 'ws';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';
import { Bot } from '@turf-duel/bot';

(global as any).WebSocket = WebSocket;

async function measureBandwidth(): Promise<void> {
  console.log('🎮 땅따 Bandwidth Measurement\n');

  const server = new Server({
    transport: new WebSocketTransport({}),
  });

  server.define('turf_duel', TurfDuelRoom);
  await server.listen(12567);
  console.log('✓ Test server started on port 12567\n');

  const client1 = new Client('ws://localhost:12567');
  const client2 = new Client('ws://localhost:12567');

  try {
    console.log('Connecting clients...');
    const room1 = await client1.joinOrCreate('turf_duel');
    const room2 = await client2.joinOrCreate('turf_duel');

    console.log('✓ Both clients connected\n');
    console.log('Running 150s match with easy bot AI...\n');
    console.log('(TurfDuelRoom will log bandwidth when match ends)\n');

    const bot1 = new Bot('easy', 1, 42);
    const bot2 = new Bot('easy', 2, 43);

    const interval = setInterval(() => {
      try {
        if (room1.state && room2.state) {
          const state1 = room1.state as any;
          const state2 = room2.state as any;
          
          if (state1.player1 && state1.player2 && state1.player1.position && state2.player1 && state2.player2 && state2.player1.position) {
            const nextMove1 = bot1.getNextMove(state1);
            room1.send('input', { direction: nextMove1 });

            const nextMove2 = bot2.getNextMove(state2);
            room2.send('input', { direction: nextMove2 });
          }
        }
      } catch (error) {
        // Ignore errors during state updates
      }
    }, 50);

    await new Promise<void>((resolve) => {
      room1.onStateChange((state: any) => {
        if (state.result) {
          clearInterval(interval);
          setTimeout(resolve, 2000);
        }
      });
    });

    await room1.leave();
    await room2.leave();
  } catch (error) {
    console.error('Error during bandwidth measurement:', error);
  } finally {
    await server.gracefullyShutdown();
    process.exit(0);
  }
}

measureBandwidth().catch(console.error);
