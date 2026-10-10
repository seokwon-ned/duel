import Phaser from 'phaser';
import { Client } from '@colyseus/sdk';
import { createInitialState, step, Direction, CellType, GRID_SIZE, } from '@turf-duel/engine';
import { Bot } from '@turf-duel/bot';
const CELL_SIZE = 15;
const COLORS = {
    EMPTY: 0x0F172A,
    PLAYER1_TERRITORY: 0xFF7A1A,
    PLAYER2_TERRITORY: 0x2F6BFF,
    PLAYER1_TRAIL: 0xFF9A4A,
    PLAYER2_TRAIL: 0x4F8BFF,
};
if (typeof window !== 'undefined') {
    window.__turfDebug = {
        tick: 0,
        ownedCells: { p1: 0, p2: 0 },
        renderedFrames: 0,
    };
}
class GameScene extends Phaser.Scene {
    cells = [];
    room = null;
    matchState = null;
    playerNum = 1;
    currentDirection = Direction.RIGHT;
    isOnlineMode = false;
    bot = null;
    botInterval = null;
    infoText = null;
    // Client-side prediction
    predictedState = null;
    pendingInputs = [];
    lastServerTick = 0;
    constructor() {
        super({ key: 'GameScene' });
    }
    create() {
        for (let y = 0; y < GRID_SIZE; y++) {
            this.cells[y] = [];
            for (let x = 0; x < GRID_SIZE; x++) {
                const rect = this.add.rectangle(x * CELL_SIZE + CELL_SIZE / 2, y * CELL_SIZE + CELL_SIZE / 2, CELL_SIZE - 1, CELL_SIZE - 1, COLORS.EMPTY);
                this.cells[y][x] = rect;
            }
        }
        this.infoText = this.add.text(10, GRID_SIZE * CELL_SIZE + 10, '', {
            fontSize: '16px',
            color: '#ffffff',
        });
        this.input.keyboard?.on('keydown', (event) => {
            let newDirection = null;
            switch (event.key) {
                case 'ArrowUp':
                case 'w':
                case 'W':
                    newDirection = Direction.UP;
                    break;
                case 'ArrowDown':
                case 's':
                case 'S':
                    newDirection = Direction.DOWN;
                    break;
                case 'ArrowLeft':
                case 'a':
                case 'A':
                    newDirection = Direction.LEFT;
                    break;
                case 'ArrowRight':
                case 'd':
                case 'D':
                    newDirection = Direction.RIGHT;
                    break;
            }
            if (newDirection) {
                this.currentDirection = newDirection;
                if (this.room && this.matchState) {
                    // Client-side prediction: apply input immediately
                    const currentTick = this.matchState.tick;
                    this.pendingInputs.push({ direction: newDirection, tick: currentTick });
                    // Predict next state
                    if (!this.predictedState) {
                        this.predictedState = JSON.parse(JSON.stringify(this.matchState));
                    }
                    const result = step(this.predictedState, [{
                            player: this.playerNum,
                            direction: newDirection,
                        }]);
                    this.predictedState = result.state;
                    // Render predicted state
                    this.renderState(this.predictedState);
                    // Send to server with clientTick
                    this.room.send('input', {
                        direction: newDirection,
                        clientTick: currentTick,
                    });
                }
            }
        });
    }
    startOnlineMode(room) {
        this.isOnlineMode = true;
        this.room = room;
        room.onStateChange.once((state) => {
            // Initial state received, render full board
            this.renderFromSchema(state);
            // Initialize matchState for prediction
            this.matchState = this.convertSchemaToMatchState(state);
            this.lastServerTick = this.matchState.tick;
        });
        room.onStateChange((state) => {
            // Server reconciliation
            const serverState = this.convertSchemaToMatchState(state);
            const serverTick = serverState.tick;
            // Remove acknowledged inputs
            this.pendingInputs = this.pendingInputs.filter(input => input.tick > serverTick);
            // Reconcile: start from server state and re-apply pending inputs
            if (this.pendingInputs.length > 0) {
                this.predictedState = JSON.parse(JSON.stringify(serverState));
                for (const input of this.pendingInputs) {
                    const result = step(this.predictedState, [{
                            player: this.playerNum,
                            direction: input.direction,
                        }]);
                    this.predictedState = result.state;
                }
                // Render reconciled predicted state
                this.renderState(this.predictedState);
            }
            else {
                // No pending inputs, use server state directly
                this.predictedState = null;
                this.renderState(serverState);
            }
            this.matchState = serverState;
            this.lastServerTick = serverTick;
        });
        room.onMessage('*', (type, message) => {
            console.log('Message from server:', type, message);
        });
    }
    convertSchemaToMatchState(state) {
        // Convert Colyseus schema to engine MatchState
        const grid = [];
        for (let y = 0; y < GRID_SIZE; y++) {
            grid[y] = [];
            for (let x = 0; x < GRID_SIZE; x++) {
                grid[y][x] = state.grid[y * GRID_SIZE + x];
            }
        }
        return {
            grid,
            player1: {
                position: { x: state.player1.position.x, y: state.player1.position.y },
                direction: state.player1.direction,
                inputBuffer: null,
                isAlive: state.player1.isAlive,
                territoryCells: state.player1.territoryCells,
                movementAccumulator: 0,
            },
            player2: {
                position: { x: state.player2.position.x, y: state.player2.position.y },
                direction: state.player2.direction,
                inputBuffer: null,
                isAlive: state.player2.isAlive,
                territoryCells: state.player2.territoryCells,
                movementAccumulator: 0,
            },
            tick: state.tick,
            paused: state.paused,
            result: state.result ? {
                winner: state.result.winner,
                reason: state.result.reason,
                tick: state.result.tick,
            } : null,
        };
    }
    startBotMode() {
        this.isOnlineMode = false;
        this.matchState = createInitialState();
        this.bot = new Bot('normal', 2);
        this.renderState(this.matchState);
        this.botInterval = setInterval(() => {
            if (!this.matchState || this.matchState.result) {
                if (this.botInterval) {
                    clearInterval(this.botInterval);
                }
                return;
            }
            const botMove = this.bot.getNextMove(this.matchState);
            const result = step(this.matchState, [
                { player: 1, direction: this.currentDirection },
                { player: 2, direction: botMove },
            ]);
            this.matchState = result.state;
            this.renderState(this.matchState);
            if (this.matchState.result) {
                this.showResult(this.matchState.result);
            }
        }, 50);
    }
    updateFromServerState() {
        if (!this.room)
            return;
        const state = this.room.state;
        // Render from full grid if available (lossless sync)
        if (state.grid && state.grid.length > 0) {
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    const index = y * GRID_SIZE + x;
                    const cellType = state.grid[index];
                    const color = this.getCellColor(cellType);
                    this.cells[y][x].setFillStyle(color);
                }
            }
        }
        else if (state.cellUpdates) {
            // Fallback to incremental updates
            state.cellUpdates.forEach((update) => {
                const color = this.getCellColor(update.type);
                this.cells[update.y][update.x].setFillStyle(color);
            });
        }
        this.cells[state.player1.position.y][state.player1.position.x].setStrokeStyle(2, 0xFFFFFF);
        this.cells[state.player2.position.y][state.player2.position.x].setStrokeStyle(2, 0xFFFFFF);
        if (this.infoText) {
            const p1Percent = Math.round((state.player1.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
            const p2Percent = Math.round((state.player2.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
            const tick = state.tick;
            const seconds = Math.floor((3000 - tick) / 20);
            this.infoText.setText(`P1: ${p1Percent}% | Time: ${seconds}s | P2: ${p2Percent}%`);
        }
        if (state.result) {
            this.showResult(state.result);
        }
        // Update debug hook
        if (typeof window !== 'undefined' && window.__turfDebug) {
            window.__turfDebug.tick = state.tick;
            window.__turfDebug.ownedCells = {
                p1: state.player1.territoryCells,
                p2: state.player2.territoryCells,
            };
            window.__turfDebug.renderedFrames++;
        }
    }
    renderFromSchema(state) {
        // Initial full render from grid
        if (state.grid && state.grid.length > 0) {
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    const index = y * GRID_SIZE + x;
                    const cellType = state.grid[index];
                    const color = this.getCellColor(cellType);
                    this.cells[y][x].setFillStyle(color);
                }
            }
        }
    }
    renderState(state) {
        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const color = this.getCellColor(state.grid[y][x]);
                this.cells[y][x].setFillStyle(color);
            }
        }
        this.cells[state.player1.position.y][state.player1.position.x].setStrokeStyle(2, 0xFFFFFF);
        this.cells[state.player2.position.y][state.player2.position.x].setStrokeStyle(2, 0xFFFFFF);
        if (this.infoText) {
            const p1Percent = Math.round((state.player1.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
            const p2Percent = Math.round((state.player2.territoryCells / (GRID_SIZE * GRID_SIZE)) * 100);
            const seconds = Math.floor((3000 - state.tick) / 20);
            this.infoText.setText(`You: ${p1Percent}% | Time: ${seconds}s | Bot: ${p2Percent}%`);
        }
    }
    getCellColor(cellType) {
        switch (cellType) {
            case CellType.PLAYER1_TERRITORY:
                return COLORS.PLAYER1_TERRITORY;
            case CellType.PLAYER2_TERRITORY:
                return COLORS.PLAYER2_TERRITORY;
            case CellType.PLAYER1_TRAIL:
                return COLORS.PLAYER1_TRAIL;
            case CellType.PLAYER2_TRAIL:
                return COLORS.PLAYER2_TRAIL;
            default:
                return COLORS.EMPTY;
        }
    }
    showResult(result) {
        if (this.infoText) {
            const winner = result.winner === 0 ? 'Draw' : `Player ${result.winner} wins`;
            this.infoText.setText(`${winner} - ${result.reason}`);
        }
    }
}
const config = {
    type: Phaser.AUTO,
    width: GRID_SIZE * CELL_SIZE,
    height: GRID_SIZE * CELL_SIZE + 50,
    parent: 'game-container',
    backgroundColor: '#0F172A',
    scene: [GameScene],
};
// Initialize game on page load
const game = new Phaser.Game(config);
let gameSceneReady = false;
// Wait for game scene to be created
game.events.once('ready', () => {
    gameSceneReady = true;
    console.log('Phaser game ready');
});
document.getElementById('connectBtn')?.addEventListener('click', async () => {
    const serverUrl = document.getElementById('serverUrl').value;
    const statusEl = document.getElementById('status');
    try {
        if (statusEl)
            statusEl.textContent = 'Connecting...';
        const client = new Client(serverUrl);
        const room = await client.joinOrCreate('turf_duel');
        if (statusEl)
            statusEl.textContent = `Connected! Room: ${room.roomId}`;
        // Get the game scene
        const scene = game.scene.scenes[0];
        if (scene && typeof scene.startOnlineMode === 'function') {
            scene.startOnlineMode(room);
        }
        else {
            console.error('Game scene not ready');
            throw new Error('Game scene not initialized');
        }
    }
    catch (error) {
        console.error('Connection error:', error);
        if (statusEl)
            statusEl.textContent = `Error: ${error}`;
    }
});
document.getElementById('botBtn')?.addEventListener('click', () => {
    const statusEl = document.getElementById('status');
    if (statusEl)
        statusEl.textContent = 'Playing vs Bot (offline)';
    const scene = game.scene.scenes[0];
    if (scene && typeof scene.startBotMode === 'function') {
        scene.startBotMode();
    }
    else {
        console.error('Game scene not ready');
        if (statusEl)
            statusEl.textContent = 'Error: Game not initialized';
    }
});
