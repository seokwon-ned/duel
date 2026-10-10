import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { createServer } from 'http';
import { TurfDuelRoom } from './rooms/TurfDuelRoom.js';

const app = express();
const server = createServer(app);

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>땅따 | Turf Duel Server</title>
      <meta charset="utf-8">
    </head>
    <body style="font-family: sans-serif; padding: 40px; background: #0F172A; color: white;">
      <h1>🎮 땅따 | Turf Duel Server</h1>
      <p>Server is running on port 2567</p>
      <p>Version: 1.1.0</p>
      <hr>
      <h2>Local Testing</h2>
      <ul>
        <li>Open two browser tabs to test 1v1 locally</li>
        <li>Use ws://localhost:2567 for local connections</li>
        <li>On mobile, use ws://YOUR_PC_IP:2567</li>
      </ul>
      <a href="/test-client" style="color: #FF7A1A;">→ Open Test Client</a>
    </body>
    </html>
  `);
});

const gameServer = new Server({
  transport: new WebSocketTransport({
    server,
  }),
});

gameServer.define('turf_duel', TurfDuelRoom);

const PORT = process.env.PORT || 2567;

gameServer.listen(PORT as number, '0.0.0.0');

console.log(`🎮 땅따 | Turf Duel Server`);
console.log(`Listening on ws://0.0.0.0:${PORT}`);
console.log(`Room: turf_duel`);
console.log(`Max clients per room: 2`);
console.log(`Tick rate: 20Hz`);
