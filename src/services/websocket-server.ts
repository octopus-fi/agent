/**
 * Octopus Finance - WebSocket Server Service
 * Provides real-time communication with the frontend
 */

import { Server, Socket } from 'socket.io';
import { createServer, Server as HttpServer } from 'http';
import {
    VaultHealthMetrics,
    AnalysisResult,
    ExecutionResult,
    MonitoringEvent,
} from '../types';
import { logger } from '../utils/logger';

// WebSocket Event Types
export enum WSEventType {
    // Agent lifecycle events
    AGENT_STATUS = 'agent:status',
    CYCLE_START = 'cycle:start',
    CYCLE_COMPLETE = 'cycle:complete',

    // Vault events
    VAULT_HEALTH = 'vault:health',
    VAULT_STATUS_UPDATE = 'vault:statusUpdate',

    // AI events
    AI_ANALYSIS = 'ai:analysis',
    AI_EXECUTION = 'ai:execution',

    // Error events
    ERROR = 'error',

    // Client events (frontend -> agent)
    CLIENT_SUBSCRIBE_VAULT = 'client:subscribeVault',
    CLIENT_UNSUBSCRIBE_VAULT = 'client:unsubscribeVault',
    CLIENT_REQUEST_STATUS = 'client:requestStatus',
}

export interface AgentStatusPayload {
    isRunning: boolean;
    vaultCount: number;
    agentAddress: string;
    connectedClients: number;
    timestamp: number;
}

export interface CycleEventPayload {
    cycleNumber: number;
    vaultsToProcess: number;
    timestamp: number;
    duration?: number;
}

export interface VaultHealthPayload {
    metrics: VaultHealthMetrics;
    timestamp: number;
}

export interface AIAnalysisPayload {
    analysis: AnalysisResult;
    timestamp: number;
}

export interface AIExecutionPayload {
    result: ExecutionResult;
    timestamp: number;
}

export interface ErrorPayload {
    message: string;
    vaultId?: string;
    code?: string;
    timestamp: number;
}

/**
 * WebSocket Server - Singleton
 */
export class WebSocketService {
    private static instance: WebSocketService | null = null;

    private io: Server | null = null;
    private httpServer: HttpServer | null = null;
    private port: number;
    private corsOrigin: string;
    private cycleCount: number = 0;

    private constructor(port: number = 3001, corsOrigin: string = 'http://localhost:3000') {
        this.port = port;
        this.corsOrigin = corsOrigin;
    }

    /**
     * Get singleton instance
     */
    static getInstance(port?: number, corsOrigin?: string): WebSocketService {
        if (!WebSocketService.instance) {
            WebSocketService.instance = new WebSocketService(port, corsOrigin);
        }
        return WebSocketService.instance;
    }

    /**
     * Start the WebSocket server
     */
    start(): void {
        if (this.io) {
            logger.warn('WebSocket server already running');
            return;
        }

        this.httpServer = createServer();
        this.io = new Server(this.httpServer, {
            cors: {
                origin: this.corsOrigin,
                methods: ['GET', 'POST'],
                credentials: true,
            },
        });

        this.setupEventHandlers();

        this.httpServer.listen(this.port, () => {
            logger.info(`🔌 WebSocket server started on port ${this.port}`);
            logger.info(`   CORS origin: ${this.corsOrigin}`);
        });
    }

    /**
     * Stop the WebSocket server
     */
    stop(): void {
        if (this.io) {
            this.io.close();
            this.io = null;
        }
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
        logger.info('WebSocket server stopped');
    }

    /**
     * Setup socket event handlers
     */
    private setupEventHandlers(): void {
        if (!this.io) return;

        this.io.on('connection', (socket: Socket) => {
            logger.info(`Client connected: ${socket.id}`);

            // Send current status on connect
            socket.on(WSEventType.CLIENT_REQUEST_STATUS, () => {
                this.emitAgentStatus(socket);
            });

            // Handle vault subscriptions
            socket.on(WSEventType.CLIENT_SUBSCRIBE_VAULT, (vaultId: string) => {
                socket.join(`vault:${vaultId}`);
                logger.debug(`Client ${socket.id} subscribed to vault ${vaultId}`);
            });

            socket.on(WSEventType.CLIENT_UNSUBSCRIBE_VAULT, (vaultId: string) => {
                socket.leave(`vault:${vaultId}`);
                logger.debug(`Client ${socket.id} unsubscribed from vault ${vaultId}`);
            });

            socket.on('disconnect', (reason) => {
                logger.info(`Client disconnected: ${socket.id} (${reason})`);
            });
        });
    }

    /**
     * Get connected client count
     */
    getConnectedClients(): number {
        return this.io?.engine?.clientsCount ?? 0;
    }

    // =========================================================================
    // Event Emitters
    // =========================================================================

    /**
     * Emit agent status
     */
    emitAgentStatus(target?: Socket, status?: Partial<AgentStatusPayload>): void {
        const payload: AgentStatusPayload = {
            isRunning: true,
            vaultCount: status?.vaultCount ?? 0,
            agentAddress: status?.agentAddress ?? '',
            connectedClients: this.getConnectedClients(),
            timestamp: Date.now(),
            ...status,
        };

        if (target) {
            target.emit(WSEventType.AGENT_STATUS, payload);
        } else {
            this.io?.emit(WSEventType.AGENT_STATUS, payload);
        }
    }

    /**
     * Emit cycle start event
     */
    emitCycleStart(vaultsToProcess: number): void {
        this.cycleCount++;
        const payload: CycleEventPayload = {
            cycleNumber: this.cycleCount,
            vaultsToProcess,
            timestamp: Date.now(),
        };
        this.io?.emit(WSEventType.CYCLE_START, payload);
        logger.debug(`[WS] Emitted cycle:start #${this.cycleCount}`);
    }

    /**
     * Emit cycle complete event
     */
    emitCycleComplete(duration: number): void {
        const payload: CycleEventPayload = {
            cycleNumber: this.cycleCount,
            vaultsToProcess: 0,
            timestamp: Date.now(),
            duration,
        };
        this.io?.emit(WSEventType.CYCLE_COMPLETE, payload);
        logger.debug(`[WS] Emitted cycle:complete #${this.cycleCount} (${duration}ms)`);
    }

    /**
     * Emit vault health metrics
     */
    emitVaultHealth(metrics: VaultHealthMetrics): void {
        const payload: VaultHealthPayload = {
            metrics: this.serializeMetrics(metrics),
            timestamp: Date.now(),
        };

        // Emit to all clients
        this.io?.emit(WSEventType.VAULT_HEALTH, payload);
    }

    /**
     * Emit AI analysis result
     */
    emitAIAnalysis(analysis: AnalysisResult): void {
        const payload: AIAnalysisPayload = {
            analysis: this.serializeAnalysis(analysis),
            timestamp: Date.now(),
        };
        this.io?.emit(WSEventType.AI_ANALYSIS, payload);
    }

    /**
     * Emit execution result
     */
    emitAIExecution(result: ExecutionResult): void {
        const payload: AIExecutionPayload = {
            result: this.serializeExecutionResult(result),
            timestamp: Date.now(),
        };
        this.io?.emit(WSEventType.AI_EXECUTION, payload);
    }

    /**
     * Emit error event
     */
    emitError(message: string, vaultId?: string, code?: string): void {
        const payload: ErrorPayload = {
            message,
            vaultId,
            code,
            timestamp: Date.now(),
        };
        this.io?.emit(WSEventType.ERROR, payload);
    }

    // =========================================================================
    // Serialization helpers (convert bigint to string for JSON)
    // =========================================================================

    private serializeMetrics(metrics: VaultHealthMetrics): VaultHealthMetrics {
        return {
            ...metrics,
            collateralValue: metrics.collateralValue.toString() as unknown as bigint,
            debtValue: metrics.debtValue.toString() as unknown as bigint,
            rewardReserve: metrics.rewardReserve.toString() as unknown as bigint,
            pendingRewards: metrics.pendingRewards.toString() as unknown as bigint,
        };
    }

    private serializeAnalysis(analysis: AnalysisResult): AnalysisResult {
        return {
            ...analysis,
            estimatedRewardsNeeded: analysis.estimatedRewardsNeeded.toString() as unknown as bigint,
            availableRewards: analysis.availableRewards.toString() as unknown as bigint,
        };
    }

    private serializeExecutionResult(result: ExecutionResult): ExecutionResult {
        return {
            ...result,
            rewardsClaimed: result.rewardsClaimed?.toString() as unknown as bigint | undefined,
            collateralAdded: result.collateralAdded?.toString() as unknown as bigint | undefined,
        };
    }
}

// Export singleton getter
export const getWebSocketService = WebSocketService.getInstance;
