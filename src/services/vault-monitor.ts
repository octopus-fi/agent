//  octopus-ai-agent/src/services/vault-monitor.ts
/**
 * Octopus Finance - Vault Monitor Service
 * Continuously monitors vault health and triggers AI actions
 */

import {
  AgentConfig,
  VaultHealthMetrics,
  AnalysisResult,
  ExecutionResult,
  MonitoringEvent,
} from "../types";
import { SuiService } from "../services/sui-service";
import { AnalyzerAgent } from "../agents/analyzer";
import { ExecutorAgent } from "../agents/executor";
import { logger } from "../utils/logger";
import { SCALE_FACTOR } from "../config";

export class VaultMonitor {
  private config: AgentConfig;
  private suiService: SuiService;
  private analyzer: AnalyzerAgent;
  private executor: ExecutorAgent;
  private isRunning: boolean = false;
  private monitorInterval: NodeJS.Timeout | null = null;

  // Cached data
  private authorizedVaults: string[] = [];
  private autoRebalancePositions: Map<string, string> = new Map();
  private lastRefresh: number = 0;
  private refreshIntervalMs: number = 300000; // 5 minutes

  constructor(config: AgentConfig) {
    this.config = config;
    this.suiService = new SuiService(config);
    this.analyzer = new AnalyzerAgent(config);
    this.executor = new ExecutorAgent(config, this.suiService);
  }

  /**
   * Start the monitoring loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Monitor already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting vault monitor...");
    logger.info(`Monitoring interval: ${this.config.monitorIntervalSeconds}s`);
    logger.info(`AI Agent address: ${this.suiService.getAgentAddress()}`);

    // Initial run
    await this.runMonitoringCycle();

    // Set up interval
    this.monitorInterval = setInterval(
      () => this.runMonitoringCycle(),
      this.config.monitorIntervalSeconds * 1000,
    );
  }

  /**
   * Stop the monitoring loop
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isRunning = false;
    logger.info("Vault monitor stopped");
  }

  /**
   * Single monitoring cycle
   */

  private demoCycleIndex: number = 0;

  private getDemoMetrics(): {
    metricsMap: Map<string, VaultHealthMetrics>;
    metricsArray: VaultHealthMetrics[];
  } {
    // Falls back to config sample/demo values
    const realVaultId = this.authorizedVaults[0] || this.config.sampleVaultId || "";
    const realPositionId =
      this.autoRebalancePositions.get(realVaultId) || this.config.sampleStakePositionId || "";
    const demoOwner = this.config.demoUserAddress || "";

    // Each scenario: [label, ltvBps, healthStatus, pendingRewards, rewardReserve]
    const scenarios: Array<{
      id: string;
      positionId: string;
      label: string;
      ltvBps: number;
      healthStatus: string;
      pendingRewards: bigint;
      rewardReserve: bigint;
    }> = [
        // 0 – HEALTHY vault with pending rewards → should claim to compound
        {
          id: realVaultId,
          positionId: realPositionId,
          label: "HEALTHY + pending rewards",
          ltvBps: 4500,
          healthStatus: "HEALTHY",
          pendingRewards: 5_000_000_000n, // 5 octSUI
          rewardReserve: 0n,
        },
        // 1 – WARNING vault with reserve → claim rewards
        {
          id: realVaultId,
          positionId: realPositionId,
          label: "WARNING + reserve",
          ltvBps: 6200,
          healthStatus: "WARNING",
          pendingRewards: 2_000_000_000n,
          rewardReserve: 3_000_000_000n,
        },
        // 2 – AT_RISK vault → rebalance
        {
          id: realVaultId,
          positionId: realPositionId,
          label: "AT_RISK – rebalance needed",
          ltvBps: 6800,
          healthStatus: "AT_RISK",
          pendingRewards: 0n,
          rewardReserve: 8_000_000_000n,
        },
        // 3 – CRITICAL vault → urgent rebalance
        {
          id: realVaultId,
          positionId: realPositionId,
          label: "CRITICAL – urgent rebalance",
          ltvBps: 7500,
          healthStatus: "CRITICAL",
          pendingRewards: 10_000_000_000n,
          rewardReserve: 5_000_000_000n,
        },
        // 4 – LIQUIDATABLE vault → emergency
        {
          id: realVaultId,
          positionId: realPositionId,
          label: "LIQUIDATABLE – emergency action",
          ltvBps: 8500,
          healthStatus: "LIQUIDATABLE",
          pendingRewards: 15_000_000_000n,
          rewardReserve: 10_000_000_000n,
        },
        // 5 – No funds at all → skip_action path
        {
          id: realVaultId,
          positionId: realPositionId,
          label: "AT_RISK but NO funds available",
          ltvBps: 6800,
          healthStatus: "AT_RISK",
          pendingRewards: 0n,
          rewardReserve: 0n,
        },
      ];

    const scenario = scenarios[this.demoCycleIndex % scenarios.length];
    this.demoCycleIndex++;

    const collateralValue = 100_000_000_000n; // 100 octSUI
    const debtValue = (BigInt(scenario.ltvBps) * collateralValue) / 10000n;

    const metrics: VaultHealthMetrics = {
      vaultId: scenario.id,
      owner: demoOwner, // Triggers 'Degen' strategy
      collateralValue,
      debtValue,
      ltvBps: scenario.ltvBps,
      healthStatus: scenario.healthStatus as any,
      rewardReserve: scenario.rewardReserve,
      pendingRewards: scenario.pendingRewards,
      recommendedAction: "NONE" as any,
    };

    const metricsMap = new Map<string, VaultHealthMetrics>();
    metricsMap.set(scenario.id, metrics);

    logger.info(`\n🎭 DEMO SCENARIO ${this.demoCycleIndex}: ${scenario.label}`);
    logger.info(
      `   LTV: ${(scenario.ltvBps / 100).toFixed(2)}% | Rewards: ${Number(scenario.pendingRewards) / 1e9} | Reserve: ${Number(scenario.rewardReserve) / 1e9}`,
    );

    // Temporarily override the positions map so executor finds the position
    this.autoRebalancePositions.set(scenario.id, scenario.positionId);

    return { metricsMap, metricsArray: [metrics] };
  }

  async runMonitoringCycle(): Promise<void> {
    const cycleStart = Date.now();
    logger.info("Starting monitoring cycle...");

    try {
      await this.refreshCachedData();

      // ── DEMO MODE: use synthetic scenarios ──────────────────────────────
      const { metricsMap, metricsArray } = this.getDemoMetrics();
      // ────────────────────────────────────────────────────────────────────

      for (const m of metricsArray) {
        this.logVaultStatus(m);
      }

      // Run AI analysis (hits Gemini for every vault)
      const analyses = await this.analyzer.analyzeVaults(metricsArray);

      // Filter to actionable
      const actionable = analyses.filter((a) => a.shouldAct);

      if (actionable.length === 0) {
        logger.info("AI decided: no action needed for this scenario");
        return;
      }

      logger.info(
        `🤖 AI Analysis: ${actionable.length} vault(s) need attention`,
      );
      for (const a of actionable) {
        logger.info(
          `   → Action: ${a.action} | Reasoning: ${a.reasoning} | Confidence: ${a.confidence}`,
        );
      }

      // Execute actions (hits Gemini tool-calling, then SuiService)
      const results = await this.executor.executeActions(
        actionable,
        metricsMap,
        this.autoRebalancePositions,
      );

      this.logResultsSummary(results);
    } catch (error) {
      logger.error("Monitoring cycle error:", error);
      this.emitEvent({
        type: "error",
        details: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        timestamp: Date.now(),
      });
    }

    const cycleTime = Date.now() - cycleStart;
    logger.info(`Monitoring cycle completed in ${cycleTime}ms\n`);
  }

  /**
   * Refresh cached vault and position data
   */
  private async refreshCachedData(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < this.refreshIntervalMs) {
      return;
    }

    logger.info("Refreshing cached data...");

    const onChainVaults = await this.suiService.getAuthorizedVaults();
    const onChainPositions = await this.suiService.getAutoRebalancePositions();

    // Merge: keep manually-added vaults that aren't on-chain yet
    for (const v of onChainVaults) {
      if (!this.authorizedVaults.includes(v)) {
        this.authorizedVaults.push(v);
      }
    }

    // Merge positions (don't overwrite manual ones)
    onChainPositions.forEach((posId, vaultId) => {
      if (!this.autoRebalancePositions.has(vaultId)) {
        this.autoRebalancePositions.set(vaultId, posId);
      }
    });

    this.lastRefresh = now;

    logger.info(`Found ${this.authorizedVaults.length} authorized vault(s)`);
    logger.info(
      `Found ${this.autoRebalancePositions.size} auto-rebalance position(s)`,
    );

    // Cleanup executor cooldowns
    this.executor.cleanupCooldowns();
  }

  /**
   * Manually add a vault to monitor (for testing)
   */
  addVault(vaultId: string, stakePositionId?: string): void {
    if (!this.authorizedVaults.includes(vaultId)) {
      this.authorizedVaults.push(vaultId);
    }
    if (stakePositionId) {
      this.autoRebalancePositions.set(vaultId, stakePositionId);
    }
    logger.info(`Added vault ${vaultId} to monitoring`);
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
    vaultCount: number;
    agentAddress: string;
  } {
    return {
      isRunning: this.isRunning,
      vaultCount: this.authorizedVaults.length,
      agentAddress: this.suiService.getAgentAddress(),
    };
  }

  private logVaultStatus(metrics: VaultHealthMetrics): void {
    const ltvPercent = (metrics.ltvBps / 100).toFixed(2);
    const statusEmoji = this.getStatusEmoji(metrics.healthStatus);

    logger.debug(
      `${statusEmoji} Vault ${metrics.vaultId.slice(0, 8)}... | ` +
      `LTV: ${ltvPercent}% | Status: ${metrics.healthStatus}`,
    );
  }

  private getStatusEmoji(status: string): string {
    const emojis: Record<string, string> = {
      HEALTHY: "✅",
      WARNING: "⚠️",
      AT_RISK: "🟠",
      CRITICAL: "🔴",
      LIQUIDATABLE: "💀",
    };
    return emojis[status] || "❓";
  }

  private logResultsSummary(results: ExecutionResult[]): void {
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    logger.info(
      `Execution summary: ${successful.length} successful, ${failed.length} failed`,
    );

    for (const result of successful) {
      if (result.txDigest) {
        logger.info(
          `  ✅ ${result.action} on ${result.vaultId.slice(0, 8)}... | TX: ${result.txDigest}`,
        );
      }
    }

    for (const result of failed) {
      logger.warn(
        `  ❌ ${result.action} on ${result.vaultId.slice(0, 8)}... | Error: ${result.error}`,
      );
    }
  }

  private emitEvent(event: MonitoringEvent): void {
    // Could be extended to emit to external monitoring systems
    logger.debug("Event:", event);
  }
}
