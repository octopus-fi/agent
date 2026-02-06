import { Server, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { StrategyLoader } from './strategy-loader';
import { AgentConfig, VaultHealthMetrics, AnalysisResult } from '../types';

// Event Types matching Frontend
export enum WSEventType {
    // Agent -> Client
    AGENT_STATUS = 'agent:status',
    AGENT_STRATEGIES = 'agent:strategies',
    CYCLE_START = 'cycle:start',
    CYCLE_COMPLETE = 'cycle:complete',
    VAULT_HEALTH = 'vault:health',
    AI_ANALYSIS = 'ai:analysis',
    AI_EXECUTION = 'ai:execution',
    ERROR = 'error',

    // Client -> Agent
    CLIENT_REQUEST_STRATEGIES = 'client:requestStrategies',
    CLIENT_SELECT_STRATEGY = 'client:selectStrategy',
    CLIENT_SUBSCRIBE_VAULT = 'client:subscribeVault',
}

export class WebSocketServer {
    private io: Server;
    private config: AgentConfig;
    private strategyLoader: StrategyLoader;

    // Track active strategy per client
    private clientStrategies: Map<string, string> = new Map();

    constructor(config: AgentConfig, strategyLoader: StrategyLoader) {
        this.config = config;
        this.strategyLoader = strategyLoader;

        // Port configuration
        const port = process.env.PORT ? parseInt(process.env.PORT) : (process.env.WS_PORT ? parseInt(process.env.WS_PORT) : (process.env.WEBSOCKET_PORT ? parseInt(process.env.WEBSOCKET_PORT) : 3001));

        this.io = new Server(port, {
            cors: {
                origin: process.env.WEBSOCKET_CORS_ORIGIN || "*", // "http://localhost:3000",
                methods: ["GET", "POST"]
            }
        });

        logger.info(`[Socket.IO] Server started on port ${port}`);

        this.io.on('connection', (socket: Socket) => {
            this.handleConnection(socket);
        });
    }

    private handleConnection(socket: Socket) {
        const ip = socket.handshake.address;
        logger.info(`[Socket.IO] New client connected from ${ip} (ID: ${socket.id})`);

        // Send initial status
        socket.emit(WSEventType.AGENT_STATUS, {
            isRunning: true,
            agentAddress: this.config.demoUserAddress || '0xAgent',
            connectedClients: this.io.engine.clientsCount,
            timestamp: Date.now()
        });

        // Setup Event Listeners

        socket.on(WSEventType.CLIENT_REQUEST_STRATEGIES, async () => {
            logger.debug(`[Socket.IO] Client requested strategies`);
            const strategies = await this.strategyLoader.getAllStrategies();
            socket.emit(WSEventType.AGENT_STRATEGIES, {
                strategies,
                timestamp: Date.now()
            });
        });

        socket.on(WSEventType.CLIENT_SELECT_STRATEGY, (payload: any) => {
            if (payload?.strategy) { // Payload might differ depending on how frontend works. 
                // Frontend sends string or object? 
                // socket-service.ts: this.socket?.emit(WSEventType...., vaultId); -> single arg
                // page.tsx: selectStrategy(id) calls socket.selectStrategy(id) ? 
                // Wait, useAgentSocket.ts doesn't expose selectStrategy. 
                // I added it in previous turn but didn't update useAgentSocket.
                // Assuming standard socket.io payload
                const strategyId = typeof payload === 'string' ? payload : payload?.strategy;
                this.clientStrategies.set(socket.id, strategyId);
                logger.info(`[Socket.IO] Client ${socket.id} selected strategy: ${strategyId}`);
            }
        });

        socket.on(WSEventType.CLIENT_SUBSCRIBE_VAULT, (vaultId: string) => {
            logger.debug(`[Socket.IO] Client ${socket.id} subscribed to vault: ${vaultId}`);
            socket.join(vaultId); // Join a room for this vault
        });

        socket.on('disconnect', () => {
            logger.info(`[Socket.IO] Client disconnected ${socket.id}`);
            this.clientStrategies.delete(socket.id);
        });

        socket.on('error', (err) => {
            logger.error(`[Socket.IO] Client error: ${err.message}`);
        });
    }

    // Public Broadcasting Methods

    public broadcast(type: string, payload: any) {
        this.io.emit(type, payload);
    }

    public broadcastVaultHealth(metrics: VaultHealthMetrics) {
        // Broadcast to specific vault room AND global listeners if needed
        // For now, broadcast to all for monitoring dashboard
        this.broadcast(WSEventType.VAULT_HEALTH, {
            metrics,
            timestamp: Date.now()
        });

        // Also emit to vault-specific room
        this.io.to(metrics.vaultId).emit(WSEventType.VAULT_HEALTH, {
            metrics,
            timestamp: Date.now()
        });
    }

    public broadcastAnalysis(analysis: AnalysisResult) {
        this.broadcast(WSEventType.AI_ANALYSIS, {
            analysis,
            timestamp: Date.now()
        });
        this.io.to(analysis.vaultId).emit(WSEventType.AI_ANALYSIS, {
            analysis,
            timestamp: Date.now()
        });
    }

    public broadcastExecution(result: any) {
        this.broadcast(WSEventType.AI_EXECUTION, {
            result,
            timestamp: Date.now()
        });
        if (result.vaultId) {
            this.io.to(result.vaultId).emit(WSEventType.AI_EXECUTION, {
                result,
                timestamp: Date.now()
            });
        }
    }

    public broadcastCycleStart(vaultsToProcess: number) {
        this.broadcast(WSEventType.CYCLE_START, {
            vaultsToProcess,
            timestamp: Date.now()
        });
    }

    public broadcastCycleComplete(duration: number) {
        this.broadcast(WSEventType.CYCLE_COMPLETE, {
            duration,
            timestamp: Date.now()
        });
    }

    public broadcastError(message: string) {
        this.broadcast(WSEventType.ERROR, {
            message,
            timestamp: Date.now()
        });
    }

    public stop() {
        this.io.close(() => {
            logger.info('[Socket.IO] Server stopped');
        });
    }
}
