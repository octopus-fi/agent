/**
 * Octopus Finance - Executor Agent
 * Uses Gemini 3 Flash via @google/genai with TOOLS for on-chain execution.
 *
 * Key changes from legacy @google/generative-ai:
 *   - GoogleGenAI replaces GoogleGenerativeAI
 *   - No model binding at construction; model is passed per-request
 *   - Tools + toolConfig live inside config: {}
 *   - response.functionCalls is a property, not a method
 *   - FunctionCallingConfigMode.ANY forces the model to always pick a tool
 *   - thinkingConfig replaces temperature for Gemini 3 models
 */

import { GoogleGenAI, FunctionCallingConfigMode, Type, ThinkingLevel } from '@google/genai';
import {
  AgentConfig,
  AnalysisResult,
  ExecutionResult,
  VaultHealthMetrics,
  RecommendedAction,
} from '../types';
import { SuiService } from '../services/sui-service';
import { ToolExecutor } from '../tools/executor';
import { RateLimiter, VaultCooldown } from '../utils/rate-limiter';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Tool declarations – plain objects matching the new SDK's FunctionDeclaration
// shape.  We define them here (instead of importing from definitions.ts) so
// that we can use the new SDK's Type enum directly.
// ---------------------------------------------------------------------------
const claimAndRebalanceTool = {
  name: 'claim_and_rebalance',
  description:
    'Claims pending staking rewards from a user\'s stake position and uses them to add collateral to their vault, reducing the LTV ratio. ' +
    'Use this when a vault has pending rewards available, regardless of current LTV, to compound yield and strengthen vault health.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      vault_id: {
        type: Type.STRING,
        description: 'The object ID of the vault to rebalance.',
      },
      stake_position_id: {
        type: Type.STRING,
        description: 'The object ID of the stake position linked to this vault.',
      },
      reasoning: {
        type: Type.STRING,
        description: 'Brief explanation of why this rebalance is needed.',
      },
    },
    required: ['vault_id', 'stake_position_id', 'reasoning'],
  },
};

const rebalanceFromReserveTool = {
  name: 'rebalance_from_reserve',
  description:
    'Moves collateral from the vault\'s reward reserve to active collateral, reducing LTV. ' +
    'Use this when a vault already has funds in its reward_reserve and needs LTV reduction or yield compounding.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      vault_id: {
        type: Type.STRING,
        description: 'The object ID of the vault to rebalance.',
      },
      reasoning: {
        type: Type.STRING,
        description: 'Brief explanation of why this rebalance is needed.',
      },
    },
    required: ['vault_id', 'reasoning'],
  },
};

const skipActionTool = {
  name: 'skip_action',
  description:
    'Explicitly skip taking any action on a vault. ' +
    'Use this ONLY when there are truly no rewards AND no reserve available.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      vault_id: {
        type: Type.STRING,
        description: 'The object ID of the vault being evaluated.',
      },
      reason: {
        type: Type.STRING,
        description: 'Explanation of why no action is being taken.',
      },
    },
    required: ['vault_id', 'reason'],
  },
};

const executorToolDeclarations = [
  claimAndRebalanceTool,
  rebalanceFromReserveTool,
  skipActionTool,
];

// ---------------------------------------------------------------------------
// System prompt – tuned so the model always picks an action for demo clarity
// ---------------------------------------------------------------------------
const EXECUTOR_SYSTEM_PROMPT = `You are an AI executor for Octopus Finance, authorized to protect and optimise vaults on the Sui blockchain.

Your role is to EXECUTE actions to maintain and improve vault health. You MUST call exactly one tool every time.

AVAILABLE ACTIONS:
1. claim_and_rebalance  – Claim staking rewards and add them as collateral.
2. rebalance_from_reserve – Use existing reserve funds as collateral.
3. skip_action           – Decline to act (only when truly no funds exist).

DECISION RULES (in priority order):
1. If pending_rewards > 0  → ALWAYS use claim_and_rebalance (compounds yield).
2. Else if reserve > 0     → use rebalance_from_reserve.
3. Else                    → use skip_action and explain why.

You MUST call one of the tools above. Never respond with plain text alone.`;

// ---------------------------------------------------------------------------
// ExecutorAgent
// ---------------------------------------------------------------------------
export class ExecutorAgent {
  private genAI: GoogleGenAI;
  private rateLimiter: RateLimiter;
  private vaultCooldown: VaultCooldown;
  private toolExecutor: ToolExecutor;
  private config: AgentConfig;

  constructor(config: AgentConfig, suiService: SuiService) {
    this.config = config;
    this.genAI = new GoogleGenAI({ apiKey: config.executorApiKey });
    this.rateLimiter = new RateLimiter('Executor', config.rateLimits.executorMaxRpm);
    this.vaultCooldown = new VaultCooldown(config.rateLimits.minRebalanceIntervalSeconds);
    this.toolExecutor = new ToolExecutor(suiService);
  }

  // -----------------------------------------------------------------------
  // Single vault execution
  // -----------------------------------------------------------------------
  async executeAction(
    analysis: AnalysisResult,
    metrics: VaultHealthMetrics,
    stakePositionId: string | null,
  ): Promise<ExecutionResult> {
    // Cooldown gate
    if (!this.vaultCooldown.canAct(analysis.vaultId)) {
      const waitTime = this.vaultCooldown.getTimeUntilReady(analysis.vaultId);
      logger.info(`Vault ${analysis.vaultId} on cooldown, ${waitTime}s remaining`);
      return {
        success: false,
        action: 'cooldown',
        vaultId: analysis.vaultId,
        error: `Vault on cooldown for ${waitTime}s`,
      };
    }

    await this.rateLimiter.waitForSlot();

    try {
      const prompt = this.buildExecutionPrompt(analysis, metrics, stakePositionId);

      logger.info(`[Executor] Calling Gemini 3 Flash for vault ${analysis.vaultId.slice(0, 8)}...`);

      const response = await this.genAI.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: EXECUTOR_SYSTEM_PROMPT,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          // Force the model to always pick a tool – critical for demo
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
            },
          },
          tools: [{ functionDeclarations: executorToolDeclarations }],
        },
      });

      const functionCalls = response.functionCalls;

      if (!functionCalls || functionCalls.length === 0) {
        logger.warn('[Executor] No function call returned by Gemini');
        return {
          success: false,
          action: 'no_action',
          vaultId: analysis.vaultId,
          error: 'AI did not return a function call',
        };
      }

      const toolCall = functionCalls[0]!;
      if (!toolCall.name) {
        return {
          success: false,
          action: 'no_action',
          vaultId: analysis.vaultId,
          error: 'Tool call missing name',
        };
      }
      logger.info(`[Executor] Gemini chose tool: ${toolCall.name}`, { args: toolCall.args });

      const executionResult = await this.toolExecutor.execute(
        toolCall.name,
        toolCall.args as unknown as import('../tools/definitions').ToolArgs,
      );

      // Record cooldown only on real on-chain actions
      if (executionResult.success && toolCall.name !== 'skip_action') {
        this.vaultCooldown.recordAction(analysis.vaultId);
      }

      return executionResult;
    } catch (error) {
      logger.error('[Executor] Gemini call failed, using fallback:', error);
      return this.fallbackExecution(analysis, metrics, stakePositionId);
    }
  }

  // -----------------------------------------------------------------------
  // Batch execution – sorted by severity
  // -----------------------------------------------------------------------
  async executeActions(
    analyses: AnalysisResult[],
    metricsMap: Map<string, VaultHealthMetrics>,
    positionsMap: Map<string, string>,
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    const priority: Record<RecommendedAction, number> = {
      [RecommendedAction.URGENT_REBALANCE]: 3,
      [RecommendedAction.REBALANCE]: 2,
      [RecommendedAction.CLAIM_REWARDS]: 1,
      [RecommendedAction.MONITOR]: 0,
      [RecommendedAction.NONE]: 0,
    };

    const actionable = analyses
      .filter((a) => a.shouldAct && a.action !== RecommendedAction.NONE)
      .sort((a, b) => priority[b.action] - priority[a.action]);

    for (const analysis of actionable) {
      const metrics = metricsMap.get(analysis.vaultId);
      if (!metrics) continue;

      const stakePositionId = positionsMap.get(analysis.vaultId) || null;
      const result = await this.executeAction(analysis, metrics, stakePositionId);
      results.push(result);

      if (result.success) {
        logger.info(`[Executor] ✅ ${result.action} on vault ${result.vaultId.slice(0, 8)}...`, {
          txDigest: result.txDigest,
          rewardsClaimed: result.rewardsClaimed?.toString(),
          collateralAdded: result.collateralAdded?.toString(),
        });
      } else {
        logger.warn(`[Executor] ❌ vault ${result.vaultId.slice(0, 8)}...: ${result.error}`);
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  private buildExecutionPrompt(
    analysis: AnalysisResult,
    metrics: VaultHealthMetrics,
    stakePositionId: string | null,
  ): string {
    return `Execute vault protection action:

Vault ID: ${analysis.vaultId}
Stake Position ID: ${stakePositionId || 'NOT LINKED'}
Current LTV: ${(metrics.ltvBps / 100).toFixed(2)}%
Health Status: ${metrics.healthStatus}
Pending Rewards: ${this.formatTokenAmount(metrics.pendingRewards)} octSUI
Reward Reserve: ${this.formatTokenAmount(metrics.rewardReserve)} octSUI
Recommended Action: ${analysis.action}
Analysis Reasoning: ${analysis.reasoning}

Based on this data, call the appropriate tool now.`;
  }

  /**
   * Rule-based fallback when the Gemini API is unreachable.
   */
  private async fallbackExecution(
    analysis: AnalysisResult,
    metrics: VaultHealthMetrics,
    stakePositionId: string | null,
  ): Promise<ExecutionResult> {
    logger.info('[Executor] Using rule-based fallback');

    if (stakePositionId && metrics.pendingRewards > 0n) {
      return this.toolExecutor.execute('claim_and_rebalance', {
        vault_id: analysis.vaultId,
        stake_position_id: stakePositionId,
        reasoning: 'Fallback: claiming available rewards to strengthen collateral',
      });
    }

    if (metrics.rewardReserve > 0n) {
      return this.toolExecutor.execute('rebalance_from_reserve', {
        vault_id: analysis.vaultId,
        reasoning: 'Fallback: using reserve to strengthen collateral',
      });
    }

    return this.toolExecutor.execute('skip_action', {
      vault_id: analysis.vaultId,
      reason: 'No rewards or reserve available for rebalancing',
    });
  }

  private formatTokenAmount(amount: bigint): string {
    return (Number(amount) / 1e9).toFixed(4);
  }

  cleanupCooldowns(): void {
    this.vaultCooldown.cleanup();
  }
}