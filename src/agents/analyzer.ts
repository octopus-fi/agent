/**
 * Octopus Finance - Analyzer Agent
 * Uses Gemini 3 Flash via @google/genai for READ-ONLY vault analysis.
 *
 * Key changes from legacy @google/generative-ai:
 *   - GoogleGenAI replaces GoogleGenerativeAI
 *   - No model binding; model passed per-request inside config
 *   - response.text is a property, not a method
 *   - thinkingConfig replaces temperature for Gemini 3 models
 *   - Healthy-vault fast-path removed so every vault hits Gemini (demo needs)
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  AgentConfig,
  VaultHealthMetrics,
  AnalysisResult,
  RecommendedAction,
  Strategy,
  LtvThresholds,
} from '../types';
import { RateLimiter } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { BPS_SCALE, getUserStrategyPreferences } from '../config';
import { StrategyLoader } from '../services/strategy-loader';

// ---------------------------------------------------------------------------
// System prompt – instructs the model to always recommend action when funds
// are available, even on healthy vaults (important for hackathon demo).
// ---------------------------------------------------------------------------
const ANALYZER_SYSTEM_PROMPT = `You are an AI analyst for Octopus Finance, a liquid staking CDP protocol on Sui blockchain.

Your job is to analyze vault health metrics and decide whether action is needed.

LTV THRESHOLDS:
- < 60%: HEALTHY – but still claim rewards if available to compound yield.
- 60-65%: WARNING – claim rewards as a precaution.
- 65-70%: AT_RISK – rebalance recommended.
- 70-80%: CRITICAL – urgent rebalance needed.
- > 80%: LIQUIDATABLE – emergency action required.

DECISION FACTORS:
1. Current LTV vs thresholds.
2. Available pending rewards (can be claimed to add collateral).
3. Existing reward reserve in the vault.
4. Yield compounding: even healthy vaults benefit from claiming rewards.

IMPORTANT RULE:
If pending_rewards > 0 OR reward_reserve > 0, you MUST set shouldAct to true
and recommend at least CLAIM_REWARDS.  Only set shouldAct to false when both
pending rewards AND reserve are exactly 0.

RESPOND IN JSON FORMAT ONLY (no markdown, no extra text):
{
  "shouldAct": boolean,
  "action": "NONE" | "MONITOR" | "CLAIM_REWARDS" | "REBALANCE" | "URGENT_REBALANCE",
  "reasoning": "brief explanation",
  "confidence": 0.0-1.0,
  "priority": 1-5
}`;

// ---------------------------------------------------------------------------
// AnalyzerAgent
// ---------------------------------------------------------------------------
export class AnalyzerAgent {
  private genAI: GoogleGenAI;
  private rateLimiter: RateLimiter;
  private config: AgentConfig;
  private strategyLoader: StrategyLoader;

  constructor(config: AgentConfig) {
    this.config = config;
    this.genAI = new GoogleGenAI({ apiKey: config.analyzerApiKey });
    this.rateLimiter = new RateLimiter('Analyzer', config.rateLimits.analyzerMaxRpm);
    this.strategyLoader = new StrategyLoader(config);
  }

  // -----------------------------------------------------------------------
  // Single-vault analysis
  // -----------------------------------------------------------------------
  async analyzeVault(metrics: VaultHealthMetrics): Promise<AnalysisResult> {
    await this.rateLimiter.waitForSlot();

    try {
      // Determine strategy name based on owner (or default)
      const prefs = getUserStrategyPreferences(metrics.owner);
      const strategyName = prefs[metrics.owner] || prefs['default'] || 'Conservative';

      // Load strategy (Walrus -> Cache -> Local Fallback)
      let strategy: Strategy | null = null;
      try {
        strategy = await this.strategyLoader.getStrategy(strategyName);
      } catch (e) {
        logger.error(`[Analyzer] Error loading strategy ${strategyName}:`, e);
      }

      // Use strategy thresholds if available, else config defaults
      const thresholds = strategy?.thresholds || this.config.ltvThresholds;

      const prompt = this.buildAnalysisPrompt(metrics, thresholds, strategyName);

      logger.info(`[Analyzer] Calling Gemini 3 Flash for vault ${metrics.vaultId.slice(0, 8)} [Strategy: ${strategyName}]...`);

      const response = await this.genAI.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: ANALYZER_SYSTEM_PROMPT,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });

      const text = response.text ?? '';
      logger.debug(`[Analyzer] Raw Gemini response: ${text}`);

      // Pass thresholds to parsing logic if needed? 
      // Current parseAnalysisResponse mostly handles JSON.
      // But fallbackAnalysis needs thresholds.

      return this.parseAnalysisResponse(metrics.vaultId, text, metrics, thresholds);
    } catch (error) {
      logger.error('[Analyzer] Gemini call failed, using rule-based fallback:', error);
      // We should ideally pass thresholds here too, but fallbackAnalysis reads from this.config currently.
      // Refactoring fallbackAnalysis to accept thresholds is better.
      return this.fallbackAnalysis(metrics, this.config.ltvThresholds);
    }
  }

  // -----------------------------------------------------------------------
  // Batch analysis – every vault goes through Gemini (no fast-path skip)
  // -----------------------------------------------------------------------
  async analyzeVaults(metricsArray: VaultHealthMetrics[]): Promise<AnalysisResult[]> {
    const results: AnalysisResult[] = [];

    // Sort by LTV descending so highest-risk vaults are analysed first
    const sorted = [...metricsArray].sort((a, b) => b.ltvBps - a.ltvBps);

    for (const metrics of sorted) {
      const analysis = await this.analyzeVault(metrics);
      results.push(analysis);
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Prompt builder
  // -----------------------------------------------------------------------
  private buildAnalysisPrompt(metrics: VaultHealthMetrics, thresholds: LtvThresholds, strategyName: string): string {
    return `Analyze this vault using ${strategyName} Strategy:

Strategy Rules:
- Warning > ${(thresholds.warning / 100).toFixed(2)}%
- Rebalance > ${(thresholds.rebalance / 100).toFixed(2)}%
- Max Borrow > ${(thresholds.maxBorrow / 100).toFixed(2)}%
- Liquidation > ${(thresholds.liquidation / 100).toFixed(2)}%

Vault ID: ${metrics.vaultId}
Owner: ${metrics.owner}
Current LTV: ${(metrics.ltvBps / 100).toFixed(2)}%
Health Status: ${metrics.healthStatus}
Collateral Value: $${this.formatTokenAmount(metrics.collateralValue)}
Debt Value: $${this.formatTokenAmount(metrics.debtValue)}
Pending Staking Rewards: ${this.formatTokenAmount(metrics.pendingRewards)} octSUI
Existing Reward Reserve: ${this.formatTokenAmount(metrics.rewardReserve)} octSUI

Should we take action? Remember: if pending rewards or reserve exist, always
recommend claiming or rebalancing to compound yield – even if the vault looks healthy.`;
  }

  // -----------------------------------------------------------------------
  // Response parsing
  // -----------------------------------------------------------------------
  private parseAnalysisResponse(
    vaultId: string,
    response: string,
    metrics: VaultHealthMetrics,
    thresholds: LtvThresholds // Used for fallback if parsing fails
  ): AnalysisResult {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in Gemini response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        vaultId,
        shouldAct: parsed.shouldAct ?? false,
        action: this.parseAction(parsed.action),
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        confidence: parsed.confidence ?? 0.5,
        estimatedRewardsNeeded: this.estimateRewardsNeeded(metrics),
        availableRewards: metrics.pendingRewards + metrics.rewardReserve,
      };
    } catch (error) {
      logger.warn('[Analyzer] Failed to parse Gemini JSON, using fallback:', error);
      return this.fallbackAnalysis(metrics, thresholds);
    }
  }

  private parseAction(action: string): RecommendedAction {
    const map: Record<string, RecommendedAction> = {
      NONE: RecommendedAction.NONE,
      MONITOR: RecommendedAction.MONITOR,
      CLAIM_REWARDS: RecommendedAction.CLAIM_REWARDS,
      REBALANCE: RecommendedAction.REBALANCE,
      URGENT_REBALANCE: RecommendedAction.URGENT_REBALANCE,
    };
    return map[action] ?? RecommendedAction.NONE;
  }

  // -----------------------------------------------------------------------
  // Rule-based fallback (used when Gemini is unreachable)
  // -----------------------------------------------------------------------
  private fallbackAnalysis(metrics: VaultHealthMetrics, thresholds: LtvThresholds): AnalysisResult {
    let shouldAct = false;
    let action = RecommendedAction.NONE;
    let reasoning = 'Vault is healthy and no funds available';

    if (metrics.ltvBps >= thresholds.liquidation) {
      shouldAct = true;
      action = RecommendedAction.URGENT_REBALANCE;
      reasoning = 'CRITICAL: Vault at liquidation risk';
    } else if (metrics.ltvBps >= thresholds.maxBorrow) {
      shouldAct = true;
      action = RecommendedAction.URGENT_REBALANCE;
      reasoning = 'Vault LTV exceeds max borrow threshold';
    } else if (metrics.ltvBps >= thresholds.rebalance) {
      shouldAct = metrics.pendingRewards > 0n || metrics.rewardReserve > 0n;
      action = RecommendedAction.REBALANCE;
      reasoning = 'Vault LTV in rebalance zone';
    } else if (metrics.ltvBps >= thresholds.warning) {
      shouldAct = metrics.pendingRewards > 0n || metrics.rewardReserve > 0n;
      action = RecommendedAction.CLAIM_REWARDS;
      reasoning = 'Vault LTV in warning zone – claiming rewards as precaution';
    } else {
      // Healthy vault – still act if funds exist (demo / compounding)
      if (metrics.pendingRewards > 0n || metrics.rewardReserve > 0n) {
        shouldAct = true;
        action = RecommendedAction.CLAIM_REWARDS;
        reasoning = 'Vault healthy but rewards available – compounding yield';
      }
    }

    return {
      vaultId: metrics.vaultId,
      shouldAct,
      action,
      reasoning,
      confidence: 0.9,
      estimatedRewardsNeeded: this.estimateRewardsNeeded(metrics),
      availableRewards: metrics.pendingRewards + metrics.rewardReserve,
    };
  }

  // -----------------------------------------------------------------------
  // Utility – estimate additional collateral required to reach target LTV
  // -----------------------------------------------------------------------
  private estimateRewardsNeeded(metrics: VaultHealthMetrics): bigint {
    const targetLtv = 5500; // 55 %
    const requiredCollateral =
      (metrics.debtValue * BigInt(BPS_SCALE)) / BigInt(targetLtv);
    const additional = requiredCollateral - metrics.collateralValue;
    return additional > 0n ? additional : 0n;
  }

  private formatTokenAmount(amount: bigint): string {
    return (Number(amount) / 1e9).toFixed(4);
  }
}